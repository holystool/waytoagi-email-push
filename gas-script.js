/**
 * WayToAGI 每日更新日志邮件推送 (Google Apps Script 版本)
 * 
 * 配置说明：
 * 1. 部署到 Google Apps Script 项目中。
 * 2. 在 GAS 中配置定时触发器，指向 main 函数，设置为每天早上 8:00 - 9:00 运行。
 */

// 全局配置项
const RECIPIENT = 'holystool@gmail.com';
const WIKI_URL = 'https://waytoagi.feishu.cn/wiki/QPe5w5g7UisbEkkow8XcDmOpn8e';
const MAX_RETRIES = 3; // 失败时自动重试次数
const RETRY_DELAY_MS = 5000; // 重试间隔时间

/**
 * 手动追踪重定向并获取带有完整 Cookie 状态的 HTML
 */
function fetchWikiHtmlWithCookies(url) {
  let currentUrl = url;
  let hop = 0;
  const cookies = {};
  
  const defaultHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  };

  while (hop < 12) {
    hop++;
    
    // 构造 Cookie 头部
    const cookieHeader = Object.keys(cookies).map(key => `${key}=${cookies[key]}`).join('; ');
    const headers = { ...defaultHeaders };
    if (cookieHeader) {
      headers['Cookie'] = cookieHeader;
    }

    const options = {
      method: 'get',
      headers: headers,
      followRedirects: false, // 阻止自动重定向，手动获取 set-cookie
      muteHttpExceptions: true // 阻止在 3xx/4xx 时抛出异常
    };

    Logger.log(`[Hop ${hop}] Requesting URL: ${currentUrl}`);
    const response = UrlFetchApp.fetch(currentUrl, options);
    const statusCode = response.getResponseCode();
    Logger.log(`[Hop ${hop}] Response Code: ${statusCode}`);

    // 保存返回的 Cookies
    const allHeaders = response.getAllHeaders();
    let setCookies = allHeaders['Set-Cookie'] || allHeaders['set-cookie'];
    if (setCookies) {
      // GAS 在有多条 Set-Cookie 时可能返回数组，单条时可能返回字符串
      if (!Array.isArray(setCookies)) {
        setCookies = [setCookies];
      }
      setCookies.forEach(cookie => {
        const parts = cookie.split(';')[0].split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim();
          cookies[key] = val;
        }
      });
    }

    const location = allHeaders['Location'] || allHeaders['location'];
    if (statusCode >= 300 && statusCode < 400 && location) {
      // 解析跳转的 Location
      if (location.indexOf('http') === 0) {
        currentUrl = location;
      } else {
        // 相对路径拼接
        const urlParts = currentUrl.split('/');
        const domain = urlParts[0] + '//' + urlParts[2];
        if (location.indexOf('/') === 0) {
          currentUrl = domain + location;
        } else {
          currentUrl = currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1) + location;
        }
      }
    } else if (statusCode === 200) {
      return response.getContentText('UTF-8');
    } else {
      throw new Error(`请求飞书公开页面失败，Hop: ${hop}, HTTP 状态码: ${statusCode}`);
    }
  }
  
  throw new Error('重定向次数过多，未能成功获取页面数据');
}

/**
 * 提取页面 HTML 里的 block_map JSON 数据
 */
function parseFeishuWiki(html) {
  const match = html.match(/clientVars\s*:\s*Object\(([\s\S]*?)\)\s*\}\s*\)\s*;/);
  let jsonStr = null;
  if (match) {
    jsonStr = match[1];
  } else {
    const match2 = html.match(/clientVars\s*:\s*([\s\S]*?)\}\s*\)\s*;/);
    if (match2) {
      jsonStr = match2[1];
    }
  }

  if (!jsonStr) {
    throw new Error('未能在 HTML 中定位到文档核心数据 (clientVars)');
  }

  let clientVars;
  try {
    clientVars = JSON.parse(jsonStr);
  } catch (e) {
    // 飞书的初始脚本可能有一些对象包裹，如果直接 JSON.parse 报错则使用 eval 来解析
    clientVars = eval('(' + jsonStr + ')');
  }

  const blockMap = clientVars.data.block_map;
  if (!blockMap) {
    throw new Error('核心文档块数据 (block_map) 缺失');
  }

  return blockMap;
}

/**
 * 获取 Block 的纯文本内容
 */
function getBlockText(block) {
  if (!block || !block.data) return '';
  const textObj = block.data.text || block.data.title;
  if (!textObj) return '';
  
  if (textObj.initialAttributedTexts && textObj.initialAttributedTexts.text && textObj.initialAttributedTexts.text['0']) {
    return textObj.initialAttributedTexts.text['0'];
  }
  return '';
}

/**
 * 解析单个 bullet block 列表项，提取其标题、链接和简介
 */
function parseBulletBlock(block) {
  if (!block || !block.data || block.data.type !== 'bullet') return null;
  
  const textData = block.data.text;
  if (!textData) return null;
  
  const textStr = textData.initialAttributedTexts && textData.initialAttributedTexts.text ? textData.initialAttributedTexts.text['0'] || '' : '';
  const apool = textData.apool;
  const numToAttrib = apool ? (apool.numToAttrib || {}) : {};
  
  let docTitle = '';
  let docUrl = '';
  
  Object.keys(numToAttrib).forEach(key => {
    const attr = numToAttrib[key];
    if (Array.isArray(attr) && attr[0] === 'inline-component') {
      try {
        const comp = JSON.parse(attr[1]);
        if (comp.type === 'mention_doc') {
          docTitle = comp.data?.title || '';
          docUrl = comp.data?.raw_url || '';
        }
      } catch (e) {}
    } else if (Array.isArray(attr) && attr[0] === 'link') {
      docUrl = attr[1];
    }
  });
  
  // 去除《 》或《  》前缀作为简介
  const description = textStr.replace(/^《\s*》\s*/, '').trim();
  
  return {
    title: docTitle || textStr,
    link: docUrl,
    description: description
  };
}

/**
 * 定位“近7日更新日志”并提取最新一天的更新数据
 */
function extractUpdateLogs(blockMap) {
  // 1. 定位标题块
  let logHeadingId = null;
  const blockKeys = Object.keys(blockMap);
  for (let i = 0; i < blockKeys.length; i++) {
    const id = blockKeys[i];
    const block = blockMap[id];
    const text = getBlockText(block);
    const cleanText = text.replace(/\s+/g, '');
    if (cleanText.indexOf('近7日更新日志') !== -1 || cleanText.indexOf('更新日志') !== -1) {
      logHeadingId = id;
      break;
    }
  }

  if (!logHeadingId) {
    throw new Error('未能在文档中找到“近7日更新日志”版块的标题节点');
  }

  const logHeadingBlock = blockMap[logHeadingId];
  const parentId = logHeadingBlock.data.parent_id;
  const parentBlock = blockMap[parentId];
  if (!parentBlock || !parentBlock.data || !parentBlock.data.children) {
    throw new Error('更新日志标题的父节点无效');
  }

  const siblings = parentBlock.data.children;
  const headingIdx = siblings.indexOf(logHeadingId);

  // 2. 找到该标题后的第一个 heading3 块（即最新一天）
  let latestDateBlockId = null;
  for (let i = headingIdx + 1; i < siblings.length; i++) {
    const sib = blockMap[siblings[i]];
    if (sib && sib.data.type === 'heading3') {
      latestDateBlockId = siblings[i];
      break;
    }
    // 遇到其他的大标题或分割线，说明更新日志板块结束了
    if (sib && (sib.data.type === 'heading1' || sib.data.type === 'heading2' || sib.data.type === 'divider')) {
      break;
    }
  }

  if (!latestDateBlockId) {
    throw new Error('在“近7日更新日志”版块下未找到任何日期节点');
  }

  const dateBlock = blockMap[latestDateBlockId];
  const rawDateText = getBlockText(dateBlock);
  const cleanDateText = rawDateText.replace(/\s+/g, ''); // 例如 "6月8日"
  Logger.log(`找到最新更新日志日期: "${rawDateText}" (清理后: "${cleanDateText}")`);

  // 3. 判断最新更新日期是否为今天或昨天
  const now = new Date();
  const todayStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = `${yesterday.getMonth() + 1}月${yesterday.getDate()}日`;

  Logger.log(`今天判断标准: "${todayStr}", 昨天判断标准: "${yesterdayStr}"`);

  const hasUpdate = (cleanDateText === todayStr || cleanDateText === yesterdayStr);
  
  if (!hasUpdate) {
    return {
      hasUpdate: false,
      date: cleanDateText,
      items: []
    };
  }

  // 4. 提取该日期节点下的所有子列表项 (bullet)
  const items = [];
  if (dateBlock.data.children) {
    dateBlock.data.children.forEach(childId => {
      const childBlock = blockMap[childId];
      if (childBlock && childBlock.data.type === 'bullet') {
        const parsed = parseBulletBlock(childBlock);
        if (parsed) {
          items.push(parsed);
        }
      }
    });
  }

  return {
    hasUpdate: true,
    date: cleanDateText,
    items: items
  };
}

/**
 * 渲染排版优美的 HTML 邮件
 */
function renderEmailTemplate(logData) {
  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; }
      .header { border-bottom: 2px solid #0070f3; padding-bottom: 12px; margin-bottom: 25px; }
      .title { font-size: 22px; color: #0070f3; margin: 0; font-weight: bold; }
      .subtitle { font-size: 13px; color: #777777; margin: 6px 0 0 0; }
      .update-item { background: #f8fafc; border-left: 4px solid #0070f3; padding: 15px; margin-bottom: 18px; border-radius: 0 8px 8px 0; border-top: 1px solid #e2e8f0; border-right: 1px solid #e2e8f0; border-bottom: 1px solid #e2e8f0; }
      .item-title { font-size: 16px; font-weight: bold; margin: 0 0 8px 0; color: #0f172a; }
      .item-title a { color: #0070f3; text-decoration: none; }
      .item-title a:hover { text-decoration: underline; }
      .item-desc { font-size: 14px; color: #475569; margin: 0; text-align: justify; }
      .no-update { text-align: center; padding: 40px 20px; background: #fafafa; border-radius: 8px; border: 1px dashed #cbd5e1; }
      .no-update-title { font-size: 18px; color: #64748b; margin-bottom: 12px; font-weight: bold; }
      .btn { display: inline-block; padding: 10px 24px; background: #0070f3; color: #ffffff !important; text-decoration: none; border-radius: 6px; font-size: 14px; font-weight: bold; }
      .footer { margin-top: 35px; border-top: 1px solid #e2e8f0; padding-top: 15px; font-size: 12px; color: #94a3b8; text-align: center; line-height: 1.8; }
      .footer a { color: #64748b; text-decoration: underline; }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="title">WayToAGI 每日更新日志推送</div>
      <div class="subtitle">${Utilities.formatDate(new Date(), "GMT+8", "yyyy-MM-dd HH:mm")}</div>
    </div>
  `;

  if (!logData.hasUpdate) {
    html += `
      <div class="no-update">
        <div class="no-update-title">今日无更新</div>
        <p style="color:#64748b; font-size:14px; margin-bottom: 22px;">知识库最新更新日期为：${logData.date}。过去 24 小时内未发现有新的更新日志发布。</p>
        <a href="${WIKI_URL}" class="btn" target="_blank">访问 WayToAGI 主页</a>
      </div>
    `;
  } else {
    html += `
      <p style="font-size:15px; font-weight:bold; color:#334155; margin-bottom:18px;">以下是最新一天的更新内容 (${logData.date})：</p>
    `;
    logData.items.forEach(item => {
      const linkHtml = item.link ? `<a href="${item.link}" target="_blank">${item.title}</a>` : item.title;
      html += `
        <div class="update-item">
          <div class="item-title">${linkHtml}</div>
          <div class="item-desc">${item.description}</div>
        </div>
      `;
    });
  }

  html += `
    <div class="footer">
      本邮件由部署在 Google Apps Script 的自动化脚本自动发送。<br>
      如果您觉得本脚本有帮助，请保持其后台运行。数据源：<a href="${WIKI_URL}" target="_blank">WayToAGI 知识库</a>
    </div>
  </body>
  </html>
  `;
  return html;
}

/**
 * 定时任务主函数入口 (GAS)
 */
function main() {
  let attempts = 0;
  let success = false;
  let lastError = null;

  while (attempts < MAX_RETRIES && !success) {
    attempts++;
    try {
      Logger.log(`开始第 ${attempts} 次抓取尝试...`);
      const html = fetchWikiHtmlWithCookies(WIKI_URL);
      Logger.log('HTML 数据抓取成功，正在解析内容...');

      const blockMap = parseFeishuWiki(html);
      Logger.log('文档树结构反序列化成功，正在定位更新日志块...');

      const logData = extractUpdateLogs(blockMap);
      Logger.log(`内容提取完成。有无更新: ${logData.hasUpdate}, 最新更新日期: ${logData.date}, 更新项数量: ${logData.items.length}`);

      const emailHtml = renderEmailTemplate(logData);
      
      // 发送邮件
      const subject = logData.hasUpdate 
        ? `WayToAGI 更新推送 [${logData.date}]` 
        : `WayToAGI 今日无更新 [${logData.date}]`;
      
      Logger.log(`正在发送邮件到 ${RECIPIENT}...`);
      GmailApp.sendEmail(RECIPIENT, subject, "", {
        htmlBody: emailHtml
      });
      
      Logger.log('邮件发送成功！定时同步任务圆满完成。');
      success = true;
    } catch (error) {
      lastError = error;
      Logger.log(`第 ${attempts} 次尝试失败，原因: ${error.toString()}`);
      if (attempts < MAX_RETRIES) {
        Logger.log(`等待 ${RETRY_DELAY_MS / 1000} 秒后重新尝试...`);
        Utilities.sleep(RETRY_DELAY_MS);
      }
    }
  }

  // 如果达到最大尝试次数仍失败，给用户发送警报邮件
  if (!success) {
    Logger.log('所有重试均告失败！准备发送报警邮件...');
    const errorSubject = '【警报】WayToAGI 爬虫推送脚本运行出错';
    const errorBody = `
      <h3>WayToAGI 爬虫运行失败警报</h3>
      <p>您的 Google Apps Script 自动化推送脚本在尝试了 ${MAX_RETRIES} 次抓取后均宣告失败。</p>
      <p><b>最新一次错误原因：</b><pre style="color:red; background:#f5f5f5; padding:10px; border-radius:5px;">${lastError ? lastError.stack || lastError.toString() : '未知错误'}</pre></p>
      <p><b>建议排查方向：</b></p>
      <ol>
        <li>请打开网页确认 <a href="${WIKI_URL}">WayToAGI 飞书 Wiki 页面</a> 是否仍然能够正常免登录访问。</li>
        <li>如果该页面可以正常打开，可能是飞书安全机制（IP 黑名单或重定向规则）在 GAS 环境下有所调整，导致 Cookie 模拟失效。</li>
        <li>请检查 GAS 的运行日志 (Executions) 获取更多调试信息。</li>
      </ol>
      <hr>
      <p style="font-size:12px; color:#999999;">本报警邮件由 GAS 脚本自动触发。</p>
    `;
    
    try {
      GmailApp.sendEmail(RECIPIENT, errorSubject, "", {
        htmlBody: errorBody
      });
      Logger.log('报警邮件已送达。');
    } catch (e) {
      Logger.log(`无法发送报警邮件: ${e.toString()}`);
    }
  }
}
