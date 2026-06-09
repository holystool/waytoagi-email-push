# 项目上下文 (Project Context)

## 1. 项目背景
waytoagi.feishu.cn 是一个公开的飞书 Wiki 知识库（WayToAGI 知识库）。该知识库下有一个“近7日更新日志”版块，用于发布每日最新的 AI 资讯、工具和教程更新。
为了能够及时获取每日最新的更新日志，需要实现一个自动化机制，每天早上 8 点抓取最新一天的更新，提取出标题、简介和链接，并通过邮件发送给用户。

## 2. 核心需求
- **数据抓取**：抓取 `https://waytoagi.feishu.cn/wiki/QPe5w5g7UisbEkkow8XcDmOpn8e`。
- **定位更新日志**：在页面中找到“近7日更新日志”版块，并获取最新一天（通常是最近的一天，如当天或前一天）的数据。
- **数据提取**：对最新一天的每一个更新条目，提取出它的标题、简介和链接。
- **邮件发送**：将提取出的数据格式化为 HTML 邮件，发送到用户的指定邮箱。
- **定时调度**：每天早上 8:00 自动触发。
- **免本地依赖部署**：建议部署到 Google Apps Script (GAS) 上，以利用 GAS 的定时触发器 (`Time-driven trigger`) 和 Gmail 邮件发送服务 (`MailApp` / `GmailApp`)，实现脱离本地运行。

## 3. 技术方案设计
- **飞书防爬绕过**：由于飞书公开文档限制了匿名 API 调用，并且在直接 HTTP 请求时会重定向到登录页面以进行人机或 Cookie 验证。方案采用**手动跟踪重定向并同步保存 Cookie** 的机制，通过模拟浏览器的多次 302 重定向握手，成功在最后一跳获取到包含文档原始 JSON 数据的 HTML 页面。
- **文档解析**：飞书前端是基于 React/SSR 渲染的，其文档内容以极其结构化的 block 树（`block_map`）形式保存在 HTML 中的 `window.DATA.clientVars` 里。我们将使用正则表达式提取该 JSON，并在内存中进行 block 的查找和关系定位（找到最新的 `heading3` 日期 Block，获取它的所有 `bullet` 子 Block 并解析其 `inline-component` 或 `link` 属性来获取标题、链接和简介）。
- **运行环境**：Google Apps Script。使用 `UrlFetchApp` 发起 HTTP 请求，通过 `{ followRedirects: false }` 实现手动 Cookie 跟踪；使用 `GmailApp.sendEmail` 进行邮件推送。
