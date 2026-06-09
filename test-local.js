const fetch = globalThis.fetch;

// Configs
const RECIPIENT = 'your-email@example.com';
const WIKI_URL = 'https://waytoagi.feishu.cn/wiki/QPe5w5g7UisbEkkow8XcDmOpn8e';

// Cookie-tracking fetch helper
async function fetchWikiHtml(url) {
  let currentUrl = url;
  let hop = 0;
  const cookies = {};
  const requestHeaders = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  };

  while (hop < 12) {
    hop++;
    const cookieStr = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookieStr) {
      requestHeaders['Cookie'] = cookieStr;
    } else {
      delete requestHeaders['Cookie'];
    }

    const res = await fetch(currentUrl, {
      method: 'GET',
      headers: requestHeaders,
      redirect: 'manual'
    });

    // Save cookies
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.raw && res.headers.raw()['set-cookie']);
    if (setCookies) {
      for (const cookie of setCookies) {
        const parts = cookie.split(';')[0].split('=');
        if (parts.length >= 2) {
          const key = parts[0].trim();
          const val = parts.slice(1).join('=').trim();
          cookies[key] = val;
        }
      }
    }

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      currentUrl = new URL(location, currentUrl).toString();
    } else if (res.status === 200) {
      return await res.text();
    } else {
      throw new Error(`Request failed at Hop ${hop} with status ${res.status}`);
    }
  }
  throw new Error('Too many redirect hops');
}

// Parse Feishu Docx block map
function parseFeishuWiki(html) {
  // Regex to match window.DATA.clientVars
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
    throw new Error('Failed to locate clientVars in HTML');
  }

  let clientVars;
  try {
    clientVars = JSON.parse(jsonStr);
  } catch (e) {
    const fn = new Function(`return ${jsonStr}`);
    clientVars = fn();
  }

  const blockMap = clientVars.data.block_map;
  if (!blockMap) {
    throw new Error('block_map is missing in clientVars');
  }

  return blockMap;
}

// Get clean text of a block
function getBlockText(block) {
  if (!block || !block.data) return '';
  const textObj = block.data.text || block.data.title;
  if (!textObj) return '';
  
  if (textObj.initialAttributedTexts?.text?.['0']) {
    return textObj.initialAttributedTexts.text['0'];
  }
  return '';
}

// Parse bullet block and extract title, link and description
function parseBulletBlock(block) {
  if (!block || !block.data || block.data.type !== 'bullet') return null;
  
  const textData = block.data.text;
  if (!textData) return null;
  
  const textStr = textData.initialAttributedTexts?.text?.['0'] || '';
  const apool = textData.apool;
  const numToAttrib = apool ? (apool.numToAttrib || {}) : {};
  
  let docTitle = '';
  let docUrl = '';
  
  for (const attr of Object.values(numToAttrib)) {
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
  }
  
  // Clean description
  let description = textStr.replace(/^《\s*》\s*/, '').trim();
  
  return {
    title: docTitle || textStr,
    link: docUrl,
    description: description
  };
}

// Extract update logs
function extractUpdateLogs(blockMap) {
  console.log('Total blocks to search:', Object.keys(blockMap).length);
  // 1. Locate the "近7日更新日志" block
  let logHeadingId = null;
  for (const [id, block] of Object.entries(blockMap)) {
    const text = getBlockText(block);
    const cleanText = text.replace(/\s+/g, '');
    if (cleanText.includes('近7日更新日志') || cleanText.includes('更新日志')) {
      logHeadingId = id;
      break;
    }
  }

  if (!logHeadingId) {
    throw new Error('Failed to find "近7日更新日志" heading block');
  }

  const logHeadingBlock = blockMap[logHeadingId];
  const parentId = logHeadingBlock.data.parent_id;
  const parentBlock = blockMap[parentId];
  if (!parentBlock || !parentBlock.data || !parentBlock.data.children) {
    throw new Error('Parent block of heading is invalid');
  }

  const siblings = parentBlock.data.children;
  const headingIdx = siblings.indexOf(logHeadingId);

  // 2. Find the first heading3 block after our heading2
  let latestDateBlockId = null;
  for (let i = headingIdx + 1; i < siblings.length; i++) {
    const sib = blockMap[siblings[i]];
    if (sib && sib.data.type === 'heading3') {
      latestDateBlockId = siblings[i];
      break;
    }
    // If we hit another heading1/heading2 or divider, we stop
    if (sib && (sib.data.type === 'heading1' || sib.data.type === 'heading2' || sib.data.type === 'divider')) {
      break;
    }
  }

  if (!latestDateBlockId) {
    throw new Error('Failed to find any date blocks under the update log section');
  }

  const dateBlock = blockMap[latestDateBlockId];
  const rawDateText = getBlockText(dateBlock);
  const cleanDateText = rawDateText.replace(/\s+/g, ''); // "6月8日"
  console.log(`Latest date found in wiki: "${rawDateText}" (clean: "${cleanDateText}")`);

  // 3. Determine if the update is today or yesterday
  const now = new Date();
  const todayStr = `${now.getMonth() + 1}月${now.getDate()}日`;
  
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = `${yesterday.getMonth() + 1}月${yesterday.getDate()}日`;

  console.log(`Today's Date Key: "${todayStr}", Yesterday's Date Key: "${yesterdayStr}"`);

  const hasUpdate = (cleanDateText === todayStr || cleanDateText === yesterdayStr);
  
  if (!hasUpdate) {
    return {
      hasUpdate: false,
      date: cleanDateText,
      items: []
    };
  }

  // 4. Extract children bullet blocks
  const items = [];
  if (dateBlock.data.children) {
    for (const childId of dateBlock.data.children) {
      const childBlock = blockMap[childId];
      if (childBlock && childBlock.data.type === 'bullet') {
        const parsed = parseBulletBlock(childBlock);
        if (parsed) {
          items.push(parsed);
        }
      }
    }
  }

  return {
    hasUpdate: true,
    date: cleanDateText,
    items: items
  };
}

// Format HTML Email
function formatEmail(logData) {
  let html = `
  <!DOCTYPE html>
  <html>
  <head>
    <meta charset="utf-8">
    <style>
      body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333333; max-width: 600px; margin: 0 auto; padding: 20px; }
      .header { border-bottom: 2px solid #0070f3; padding-bottom: 10px; margin-bottom: 20px; }
      .title { font-size: 20px; color: #0070f3; margin: 0; font-weight: bold; }
      .subtitle { font-size: 14px; color: #666666; margin: 5px 0 0 0; }
      .update-item { background: #f9f9f9; border-left: 4px solid #0070f3; padding: 15px; margin-bottom: 15px; border-radius: 0 8px 8px 0; }
      .item-title { font-size: 16px; font-weight: bold; margin: 0 0 8px 0; }
      .item-title a { color: #0070f3; text-decoration: none; }
      .item-title a:hover { text-decoration: underline; }
      .item-desc { font-size: 14px; color: #444444; margin: 0; }
      .no-update { text-align: center; padding: 40px 20px; background: #fafafa; border-radius: 8px; border: 1px dashed #cccccc; }
      .no-update-title { font-size: 18px; color: #888888; margin-bottom: 15px; font-weight: bold; }
      .btn { display: inline-block; padding: 10px 20px; background: #0070f3; color: #ffffff !important; text-decoration: none; border-radius: 5px; font-size: 14px; }
      .footer { margin-top: 30px; border-top: 1px solid #eeeeee; padding-top: 10px; font-size: 12px; color: #999999; text-align: center; }
    </style>
  </head>
  <body>
    <div class="header">
      <div class="title">WayToAGI 每日更新日志推送</div>
      <div class="subtitle">抓取时间：${new Date().toLocaleString('zh-CN')}</div>
    </div>
  `;

  if (!logData.hasUpdate) {
    html += `
      <div class="no-update">
        <div class="no-update-title">今日无更新</div>
        <p style="color:#666666; font-size:14px; margin-bottom: 20px;">最新一天的更新日期为：${logData.date}。过去24小时内未发现新的日志发布。</p>
        <a href="${WIKI_URL}" class="btn" target="_blank">访问 WayToAGI 主页</a>
      </div>
    `;
  } else {
    html += `
      <p style="font-size:15px; font-weight:bold; color:#555555; margin-bottom:15px;">以下是最新一天的更新内容 (${logData.date})：</p>
    `;
    for (const item of logData.items) {
      const linkHtml = item.link ? `<a href="${item.link}" target="_blank">${item.title}</a>` : item.title;
      html += `
        <div class="update-item">
          <div class="item-title">${linkHtml}</div>
          <div class="item-desc">${item.description}</div>
        </div>
      `;
    }
  }

  html += `
    <div class="footer">
      本邮件由部署在 Google Apps Script 的自动化脚本自动发送。<br>
      源 Wiki：<a href="${WIKI_URL}" style="color:#999999;">WayToAGI 知识库</a>
    </div>
  </body>
  </html>
  `;
  return html;
}

// Execution flow
async function run() {
  try {
    console.log('Fetching HTML...');
    const html = await fetchWikiHtml(WIKI_URL);
    console.log('HTML fetched successfully! Parsing block map...');
    
    const blockMap = parseFeishuWiki(html);
    console.log('Block map parsed successfully! Extracting logs...');
    
    const logData = extractUpdateLogs(blockMap);
    console.log(`Extraction complete! HasUpdate=${logData.hasUpdate}, Date=${logData.date}, Items Count=${logData.items.length}`);
    
    const emailHtml = formatEmail(logData);
    console.log('Email formatted! Writing email preview to local file email-preview.html...');
    require('fs').writeFileSync('email-preview.html', emailHtml);
    console.log('Done! You can open email-preview.html to inspect the layout.');
  } catch (err) {
    console.error('Error running test:', err);
  }
}

run();
