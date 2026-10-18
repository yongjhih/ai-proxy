/**
 * "Ask AI" slide-over sidebar component powered by local /v1/chat/completions.
 * Supports interactive CTA buttons (add/remove MCP, allow/deny origin, connect),
 * chapter/section navigation jump links (#quickstart, #details-allow-prefix, etc.),
 * automatic dashboard element highlighting & expansion, and session history persistence.
 */

import { extractHandshake } from '../web/handshake.mjs';

const STORAGE_KEY_HISTORY = 'ai_proxy_ask_ai_history';
const STORAGE_KEY_OPEN = 'ai_proxy_ask_ai_open';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeForStorage(str) {
  return String(str || '')
    .replace(/#admin-key=[^&]+/g, '#admin-key=[redacted]')
    .replace(/#mcp-key=[^&]+/g, '#mcp-key=[redacted]')
    .replace(/Bearer\s+[a-zA-Z0-9_-]+/g, 'Bearer [redacted]');
}

export function formatAssistantMarkdown(markdown) {
  const lines = String(markdown || '').split('\n');
  const result = [];
  let inCodeBlock = false;
  let codeBlockLines = [];
  let inUl = false;
  let inOl = false;

  function closeLists() {
    if (inUl) {
      result.push('</ul>');
      inUl = false;
    }
    if (inOl) {
      result.push('</ol>');
      inOl = false;
    }
  }

  function formatInline(text) {
    let out = escapeHtml(text);

    // 1) Action CTA buttons: [Text](action:...)
    out = out.replace(
      /\[([^\]]+)\]\((action:[^)]+)\)/g,
      (_, label, actionUrl) =>
        `<button type="button" class="btn btn-sm btn-primary ask-ai-cta-btn" data-action="${actionUrl}">${label}</button>`
    );

    // 2) Jump buttons / links: [Text](#hash)
    out = out.replace(
      /\[([^\]]+)\]\((#[^)]+)\)/g,
      (_, label, hash) =>
        `<button type="button" class="btn btn-sm ask-ai-jump-btn" data-jump="${hash}">${label}</button>`
    );

    // 3) Normal HTTP / relative links: [Text](url)
    out = out.replace(
      /\[([^\]]+)\]\(([^)]+)\)/g,
      (_, label, url) =>
        `<a href="${url}" ${url.startsWith('http') ? 'target="_blank" rel="noopener"' : ''} class="ask-ai-link">${label}</a>`
    );

    // 4) Inline code `code`
    out = out.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 5) Bold: **text** or __text__
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');

    // 6) Italic: *text* or _text_
    out = out.replace(/(^|[^\*])\*([^*\n]+)\*([^\*]|$)/g, '$1<em>$2</em>$3');

    // 7) Strikethrough: ~~text~~
    out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');

    return out;
  }

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();

    // Handle code blocks
    if (trimmed.startsWith('```')) {
      if (inCodeBlock) {
        result.push(`<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`);
        codeBlockLines = [];
        inCodeBlock = false;
      } else {
        closeLists();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBlockLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      closeLists();
      continue;
    }

    // Horizontal rule: ---, ***, ___
    if (/^(\s*[-*_]\s*){3,}$/.test(trimmed)) {
      closeLists();
      result.push('<hr />');
      continue;
    }

    // Headers: # H1, ## H2, ### H3, #### H4
    const headerMatch = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (headerMatch) {
      closeLists();
      const level = headerMatch[1].length;
      result.push(`<h${level}>${formatInline(headerMatch[2])}</h${level}>`);
      continue;
    }

    // Unordered list item: - item or * item
    if (/^[-*+]\s+(.*)$/.test(trimmed)) {
      const match = /^[-*+]\s+(.*)$/.exec(trimmed);
      if (inOl) {
        result.push('</ol>');
        inOl = false;
      }
      if (!inUl) {
        result.push('<ul>');
        inUl = true;
      }
      result.push(`<li>${formatInline(match[1])}</li>`);
      continue;
    }

    // Ordered list item: 1. item
    if (/^\d+\.\s+(.*)$/.test(trimmed)) {
      const match = /^\d+\.\s+(.*)$/.exec(trimmed);
      if (inUl) {
        result.push('</ul>');
        inUl = false;
      }
      if (!inOl) {
        result.push('<ol>');
        inOl = true;
      }
      result.push(`<li>${formatInline(match[1])}</li>`);
      continue;
    }

    closeLists();

    // Blockquote
    if (trimmed.startsWith('> ')) {
      result.push(`<blockquote>${formatInline(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    // Paragraph
    result.push(`<p>${formatInline(rawLine)}</p>`);
  }

  closeLists();
  if (inCodeBlock && codeBlockLines.length > 0) {
    result.push(`<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`);
  }

  return result.join('');
}

export function generateClientAssistantReply(promptText, lang = 'zh-TW') {
  const text = String(promptText || '').trim();
  const isZh = lang === 'zh-TW';

  // 1. Add MCP / site intent
  const addMatch =
    /(?:add|新增|加)\s*(?:mcp|site|站點)?\s*(https?:\/\/[^\s]+)/i.exec(text) ||
    /(https?:\/\/[^\s]+).*(?:add|新增|加)/i.exec(text);
  if (addMatch) {
    const targetUrl = addMatch[1];
    return isZh
      ? [
          `我可以為您新增 MCP 站點 \`${targetUrl}\`。`,
          '',
          `請點擊下方按鈕以確認在 Dashboard 中新增：`,
          `[➕ 確認新增 MCP: ${targetUrl}](action:add-mcp?url=${encodeURIComponent(targetUrl)})`,
          '',
          `或手動操作 Dashboard：`,
          `[📋 前往 MCP sites 新增表單](#form-add-site)`
        ].join('\n')
      : [
          `I can register the MCP site \`${targetUrl}\` for you.`,
          '',
          `Click below to confirm adding it in Dashboard:`,
          `[➕ Confirm Add MCP: ${targetUrl}](action:add-mcp?url=${encodeURIComponent(targetUrl)})`,
          '',
          `[📋 Open Add Site Form](#form-add-site)`
        ].join('\n');
  }

  // 2. Remove MCP / site intent
  const removeMatch = /(?:remove|delete|移除|刪除)\s*(?:mcp|site|站點)?\s*(https?:\/\/[^\s]+|\S+)/i.exec(text);
  if (
    removeMatch &&
    (removeMatch[1].startsWith('http') || text.includes('mcp') || text.includes('site') || text.includes('站點'))
  ) {
    const targetUrl = removeMatch[1];
    return isZh
      ? [
          `我可以為您移除 MCP 站點 \`${targetUrl}\`。`,
          '',
          `請點擊下方按鈕以確認移除（將同步取消 URL Prefix 授權）：`,
          `[🗑️ 確認移除 MCP: ${targetUrl}](action:remove-mcp?url=${encodeURIComponent(targetUrl)})`,
          '',
          `[📋 查看 MCP sites 列表](#admin-dashboard-authenticated)`
        ].join('\n')
      : [
          `I can remove MCP site \`${targetUrl}\` for you.`,
          '',
          `Click below to confirm removal:`,
          `[🗑️ Confirm Remove MCP: ${targetUrl}](action:remove-mcp?url=${encodeURIComponent(targetUrl)})`,
          '',
          `[📋 View MCP sites](#admin-dashboard-authenticated)`
        ].join('\n');
  }

  // 3. Allow Origin intent
  const allowOriginMatch = /(?:allow|允許|授權)\s*(?:origin)?\s*(https?:\/\/[^\s]+|\*)/i.exec(text);
  if (allowOriginMatch) {
    const targetOrigin = allowOriginMatch[1];
    return isZh
      ? [
          `我可以為您授權 Origin \`${targetOrigin}\` 存取本機 \`/v1\`。`,
          '',
          `請點擊下方按鈕以確認授權：`,
          `[🌐 允許 Origin: ${targetOrigin}](action:allow-origin?origin=${encodeURIComponent(targetOrigin)})`,
          '',
          `[📂 展開 Allowed Origins 清單](#details-allowed-origins)`
        ].join('\n')
      : [
          `I can authorize Origin \`${targetOrigin}\` to access local \`/v1\`.`,
          '',
          `Click below to confirm authorization:`,
          `[🌐 Allow Origin: ${targetOrigin}](action:allow-origin?origin=${encodeURIComponent(targetOrigin)})`,
          '',
          `[📂 View Allowed Origins](#details-allowed-origins)`
        ].join('\n');
  }

  // 4. Deny Origin intent
  const denyOriginMatch = /(?:deny|revoke|撤銷|拒絕)\s*(?:origin)?\s*(https?:\/\/[^\s]+|\*)/i.exec(text);
  if (denyOriginMatch) {
    const targetOrigin = denyOriginMatch[1];
    return isZh
      ? [
          `我可以為您撤銷 Origin \`${targetOrigin}\` 的 \`/v1\` 存取權限。`,
          '',
          `請點擊下方按鈕以確認撤銷：`,
          `[🚫 撤銷 Origin: ${targetOrigin}](action:deny-origin?origin=${encodeURIComponent(targetOrigin)})`,
          '',
          `[📂 展開 Allowed Origins 清單](#details-allowed-origins)`
        ].join('\n')
      : [
          `I can revoke Origin \`${targetOrigin}\` access to local \`/v1\`.`,
          '',
          `Click below to confirm revocation:`,
          `[🚫 Revoke Origin: ${targetOrigin}](action:deny-origin?origin=${encodeURIComponent(targetOrigin)})`,
          '',
          `[📂 View Allowed Origins](#details-allowed-origins)`
        ].join('\n');
  }

  // 5. CLI & Skills intent
  if (/(?:skills?|技能|cli|claude\s*code|安裝指令|install\s*guide)/i.test(text)) {
    return isZh
      ? [
          `ai-proxy CLI 與 Agent Skills 安裝與配置指南：`,
          '',
          `**1. CLI 執行與安裝：**`,
          '```bash',
          'npx ai-proxy serve --port 8788',
          'npm install -g @ai-proxy/cli',
          '```',
          '',
          `**2. 連接 Claude Code：**`,
          '```bash',
          'claude mcp add --transport http ai-proxy http://127.0.0.1:8788/mcp?url=https://yongjhih.github.io/ai-proxy/mcp',
          '```',
          '',
          `**3. AI Agent Skills (skills/mcp-pages/SKILL.md)：**`,
          `支援 Antigravity、Cursor、Windsurf，指導 Agent 為靜態網站快速建立 WebMCP 頁面與 vendor 模組。`,
          '',
          `[🚀 前往快速上手章節 (Quickstart)](#quickstart)`,
          `[🛠️ 透過 WebMCP 查詢 cli_skills 工具](mcp.html?tool=cli_skills)`
        ].join('\n')
      : [
          `ai-proxy CLI & Agent Skills Installation Guide:`,
          '',
          `**1. CLI Run & Install:**`,
          '```bash',
          'npx ai-proxy serve --port 8788',
          'npm install -g @ai-proxy/cli',
          '```',
          '',
          `**2. Connect Claude Code:**`,
          '```bash',
          'claude mcp add --transport http ai-proxy http://127.0.0.1:8788/mcp?url=https://yongjhih.github.io/ai-proxy/mcp',
          '```',
          '',
          `**3. Agent Skills (skills/mcp-pages/SKILL.md):**`,
          `Teaches coding agents to vendor WebMCP client modules and publish static MCP endpoints.`,
          '',
          `[🚀 View Quickstart](#quickstart)`,
          `[🛠️ Inspect cli_skills tool](mcp.html?tool=cli_skills)`
        ].join('\n');
  }

  // 6. Quickstart
  if (/(?:quickstart|快速上手|開始|入門|install|安裝)/i.test(text)) {
    return isZh
      ? [
          `歡迎使用 MCP Pages！以下為快速上手指南：`,
          '',
          `[🚀 前往快速上手章節 (Quickstart)](#quickstart)`,
          '',
          `常用指令範例：`,
          '```bash',
          'npx ai-proxy add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy',
          '```',
          '',
          `[📋 查看已註冊站點](#admin-dashboard-authenticated)`
        ].join('\n')
      : [
          `Welcome to MCP Pages! Here is the quickstart guide:`,
          '',
          `[🚀 Jump to Quickstart](#quickstart)`,
          '',
          '```bash',
          'npx ai-proxy add https://yongjhih.github.io/ai-proxy/mcp --name ai-proxy',
          '```',
          '',
          `[📋 View registered sites](#admin-dashboard-authenticated)`
        ].join('\n');
  }

  // 7. Security & Allowlist
  if (/(?:security|安全|安全性|allowlist|白名單)/i.test(text)) {
    return isZh
      ? [
          `MCP Pages 嚴格落實七大安全性基準（URL Fragment 金鑰隔離、Origin 檢查、唯讀防護等）：`,
          '',
          `[🔒 查看安全性規範 (Security)](doc.html?d=security)`,
          `[📂 展開 URL Prefix Allowlist](#details-allow-prefix)`,
          `[📂 展開 Chat Completions Allowed Origins](#details-allowed-origins)`
        ].join('\n')
      : [
          `MCP Pages enforces 7 security baselines:`,
          '',
          `[🔒 Security Baseline Document](doc.html?d=security)`,
          `[📂 Expand URL Prefix Allowlist](#details-allow-prefix)`,
          `[📂 Expand Allowed Origins](#details-allowed-origins)`
        ].join('\n');
  }

  // 8. Spec & Protocol
  if (/(?:spec|規格|標準)/i.test(text)) {
    return isZh
      ? [
          `您可以查看 MCP Pages 完整規格與模型：`,
          '',
          `[📄 查看 MCP Pages 規格 (Spec)](doc.html?d=spec)`,
          `[🔄 查看傳輸協定 (Protocol)](doc.html?d=protocol)`
        ].join('\n')
      : [
          `Read the normative specifications for MCP Pages:`,
          '',
          `[📄 Normative Specification (Spec)](doc.html?d=spec)`,
          `[🔄 Transport Protocol](doc.html?d=protocol)`
        ].join('\n');
  }
  if (/(?:protocol|協定|通訊協定)/i.test(text)) {
    return isZh
      ? [
          `MCP Pages 協定涵蓋 Long Polling 雙向通道與多客戶端 ID 重寫：`,
          '',
          `[🔄 查看傳輸協定 (Protocol)](doc.html?d=protocol)`,
          `[📄 查看 MCP Pages 規格 (Spec)](doc.html?d=spec)`
        ].join('\n')
      : [
          `MCP Pages transport protocol covers dual long-polling channels and multi-client ID rewriting:`,
          '',
          `[🔄 View Protocol](doc.html?d=protocol)`,
          `[📄 View Spec](doc.html?d=spec)`
        ].join('\n');
  }

  // 9. Knowledge
  if (/(?:knowledge|知識|架構|architecture|faq|常見問題)/i.test(text)) {
    return isZh
      ? [
          `MCP Pages & ai-proxy 知識庫概覽：`,
          '',
          `ai-proxy 是零依賴的輕量級本機中繼器，為靜態網站提供 WebMCP 與 AI 雙向通道。`,
          '',
          `主要知識範疇：`,
          `- **系統架構 (Architecture)**：本機 Relay (8788)、Long Polling 分頁通道 (/tab/v1/poll)、Claude Code MCP 端點 (/mcp)。`,
          `- **七大安全基準 (7 Security Baselines)**：Fragment 金鑰隔離、URL Prefix 白名單、封鎖 /mcp Origin、/v1 僅限具名唯讀工具、獨立 Admin Key、防呆標註、純對話萬用字元。`,
          `- **規範與協定 (Spec & Protocol)**：WebMCP 標準 (window.navigator.modelContext) 與 JSON-RPC 2.0。`,
          '',
          `[📄 查看完整規範 (Spec)](doc.html?d=spec)`,
          `[🔒 查看安全性規範 (Security)](doc.html?d=security)`,
          `[🛠️ 透過 WebMCP 查詢 knowledge 工具](mcp.html?tool=knowledge)`
        ].join('\n')
      : [
          `MCP Pages & ai-proxy Knowledge Base:`,
          '',
          `ai-proxy is a zero-dependency local relay providing WebMCP bridges for static web applications.`,
          '',
          `[📄 Normative Specification](doc.html?d=spec)`,
          `[🔒 Security Baseline](doc.html?d=security)`,
          `[🛠️ Query knowledge tool](mcp.html?tool=knowledge)`
        ].join('\n');
  }

  // 10. Site Tour
  if (/(?:tour|導覽|地圖|sitemap|站點導覽|頁面導覽)/i.test(text)) {
    return isZh
      ? [
          `ai-proxy 網站導覽地圖：`,
          '',
          `- [英文首頁 (index.html)](index.html) · [快速上手](#quickstart) · [安全性](#security)`,
          `- [繁體中文首頁 (zh-TW.html)](zh-TW.html) · [快速上手](#quickstart)`,
          `- [📄 規格文件 (doc.html?d=spec)](doc.html?d=spec) · [🔒 安全模型 (doc.html?d=security)](doc.html?d=security)`,
          `- [📊 本機控制台 (dashboard.html)](dashboard.html) · [📋 MCP 站點列表](#admin-dashboard-authenticated)`,
          `- [🛠️ WebMCP 工具目錄 (mcp.html)](mcp.html)`,
          '',
          `[🛠️ 透過 WebMCP 查詢 site_tour 工具](mcp.html?tool=site_tour)`
        ].join('\n')
      : [
          `ai-proxy Site Tour & Navigation:`,
          '',
          `- [Home (index.html)](index.html) · [Quickstart](#quickstart)`,
          `- [Traditional Chinese (zh-TW.html)](zh-TW.html)`,
          `- [📄 Normative Spec (doc.html?d=spec)](doc.html?d=spec) · [🔒 Security (doc.html?d=security)](doc.html?d=security)`,
          `- [📊 Dashboard (dashboard.html)](dashboard.html)`,
          `- [🛠️ WebMCP Catalog (mcp.html)](mcp.html)`
        ].join('\n');
  }

  // 11. Tools
  if (/(?:tools|工具|webmcp)/i.test(text)) {
    return isZh
      ? [
          `MCP 頁面可向 AI 暴露多種 WebMCP 工具（如 \`about\`, \`spec\`, \`knowledge\`, \`cli_skills\`, \`site_tour\`, \`sites\`, \`site_tools\` 等）：`,
          '',
          `[🛠️ 查看 MCP 工具目錄 (mcp.html)](mcp.html)`,
          `[📋 查看已註冊站點列表](#admin-dashboard-authenticated)`
        ].join('\n')
      : [
          `MCP Pages expose WebMCP tools such as \`about\`, \`spec\`, \`knowledge\`, \`cli_skills\`, \`site_tour\`, \`sites\`, \`site_tools\`:`,
          '',
          `[🛠️ View WebMCP Catalog (mcp.html)](mcp.html)`,
          `[📋 View Registered Sites](#admin-dashboard-authenticated)`
        ].join('\n');
  }

  // 12. Dashboard
  if (/(?:dashboard|儀表板|控制台|打開|展開)/i.test(text)) {
    return isZh
      ? [
          `您可以在 Dashboard 中管理 MCP 站點、URL Allowlist 與 Origin 授權：`,
          '',
          `[📊 前往 Dashboard](dashboard.html)`,
          `[📋 前往 MCP sites 區塊](#admin-dashboard-authenticated)`,
          `[📂 展開 URL Prefix Allowlist](#details-allow-prefix)`,
          `[📂 展開 Allowed Origins](#details-allowed-origins)`
        ].join('\n')
      : [
          `Manage your MCP sites, allowlists, and origin permissions in Dashboard:`,
          '',
          `[📊 Open Dashboard](dashboard.html)`,
          `[📋 View MCP Sites](#admin-dashboard-authenticated)`,
          `[📂 Expand URL Prefix Allowlist](#details-allow-prefix)`,
          `[📂 Expand Allowed Origins](#details-allowed-origins)`
        ].join('\n');
  }

  // 13. What is MCP / ai-proxy / Overview intent
  if (
    /(?:什麼是|mcp 是什麼|什麼是 mcp|what is mcp|ai-proxy 是什麼|什麼是 ai-proxy|what is ai-proxy|概念|原理|介紹|說明|how it works|如何運作|what is|overview|簡介)/i.test(
      text
    ) ||
    /^(?:mcp|ai-proxy|webmcp)[?？!！.]*$/i.test(text)
  ) {
    return isZh
      ? [
          `**MCP Pages** 將任何靜態網站（例如 GitHub Pages）轉化為標準的 Model Context Protocol (MCP) 伺服器，讓 AI 代理（Claude Code、Antigravity、Cursor 等）能夠直接讀取並操作網頁資料與工具。`,
          '',
          `**ai-proxy** 則是零依賴的本機輕量級中繼器（Local Relay，預設監聽 8788 埠），串接本機 AI 與靜態網頁上的 WebMCP 端點，同時嚴格落實七大安全性基準。`,
          '',
          `**主要核心特色：**`,
          `1. **零後端部署**：靜態網頁透過瀏覽器分頁即時註冊為 MCP 伺服器，無需後端維護。`,
          `2. **WebMCP 標準**：遵循標準的 \`window.navigator.modelContext\` 與 JSON-RPC 2.0 規格。`,
          `3. **七大安全性防護**：URL Fragment 金鑰交接隔離、Origin 檢查、URL Prefix 白名單、具名唯讀工具授權。`,
          `4. **AI 雙向溝通**：提供本機 \`/v1/chat/completions\` 端點與 \`mcp.html\` 工具目錄。`,
          '',
          `[🚀 快速上手指南 (Quickstart)](#quickstart)`,
          `[🛠️ 查看 WebMCP 工具目錄 (mcp.html)](mcp.html)`,
          `[📄 規格文件 (doc.html?d=spec)](doc.html?d=spec)`,
          `[🔒 安全性規範 (doc.html?d=security)](doc.html?d=security)`,
          `[📊 打開本機控制台 (Dashboard)](dashboard.html)`
        ].join('\n')
      : [
          `**MCP Pages** turns any static website (like GitHub Pages) into a standard Model Context Protocol (MCP) server, allowing AI agents (Claude Code, Antigravity, Cursor) to directly inspect and interact with web pages and tools.`,
          '',
          `**ai-proxy** is a zero-dependency local relay (default port 8788) bridging local AI with static WebMCP endpoints while strictly enforcing 7 security baselines.`,
          '',
          `**Key Features:**`,
          `1. **Zero Backend Required**: Browser tabs register as MCP servers on-the-fly.`,
          `2. **Standard WebMCP**: Based on \`navigator.modelContext\` and JSON-RPC 2.0.`,
          `3. **7 Security Baselines**: URL fragment isolation, origin checks, prefix allowlists, read-only tools.`,
          `4. **Bidirectional AI**: Local \`/v1/chat/completions\` and interactive tool catalogs.`,
          '',
          `[🚀 Quickstart Guide](#quickstart)`,
          `[🛠️ WebMCP Tools Catalog (mcp.html)](mcp.html)`,
          `[📄 Normative Spec (doc.html?d=spec)](doc.html?d=spec)`,
          `[🔒 Security Baseline (doc.html?d=security)](doc.html?d=security)`,
          `[📊 Open Dashboard (dashboard.html)](dashboard.html)`
        ].join('\n');
  }

  // Fallback
  return isZh
    ? [
        `我是您的 **MCP Pages & ai-proxy 智慧助理**。我已收到您的訊息：「${text}」。`,
        '',
        `您可以直接透過下方捷徑導航或操作：`,
        `- [🚀 前往快速上手指南](#quickstart)`,
        `- [📋 查看 MCP sites 列表](#admin-dashboard-authenticated)`,
        `- [➕ 新增 MCP 站點表單](#form-add-site)`,
        `- [📂 展開 URL Prefix Allowlist](#details-allow-prefix)`,
        `- [🔒 查看安全性規範 (Security)](doc.html?d=security)`,
        `- [🛠️ 查看 MCP 工具目錄 (mcp.html)](mcp.html)`
      ].join('\n')
    : [
        `I am your **MCP Pages & ai-proxy Assistant**. Received: "${text}".`,
        '',
        `Quick navigation & actions:`,
        `- [🚀 Quickstart](#quickstart)`,
        `- [📋 Registered MCP sites](#admin-dashboard-authenticated)`,
        `- [➕ Add MCP site form](#form-add-site)`,
        `- [📂 URL Prefix Allowlist](#details-allow-prefix)`,
        `- [🔒 Security baselines (Security)](doc.html?d=security)`,
        `- [🛠️ WebMCP Tools Catalog (mcp.html)](mcp.html)`
      ].join('\n');
}

export function initAskAiDrawer({ lang = 'en', win = globalThis.window } = {}) {
  const doc = win && win.document;
  if (!doc) return null;

  const triggerBtn = doc.getElementById('ask-ai-trigger');
  const drawer = doc.getElementById('ask-ai-drawer');
  const closeBtn = doc.getElementById('ask-ai-close');
  const form = doc.getElementById('ask-ai-form');
  const input = doc.getElementById('ask-ai-input');
  const messagesEl = doc.getElementById('ask-ai-messages');

  if (!drawer || !form || !input || !messagesEl) return null;

  function loadStoredHistory() {
    if (!win) return [];
    try {
      const raw =
        (win.sessionStorage && win.sessionStorage.getItem(STORAGE_KEY_HISTORY)) ||
        (win.localStorage && win.localStorage.getItem(STORAGE_KEY_HISTORY));
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveStoredHistory(historyList) {
    if (!win) return;
    try {
      const trimmed = historyList.slice(-50);
      const json = JSON.stringify(trimmed);
      if (win.sessionStorage) win.sessionStorage.setItem(STORAGE_KEY_HISTORY, json);
      if (win.localStorage) win.localStorage.setItem(STORAGE_KEY_HISTORY, json);
    } catch {}
  }

  function clearStoredHistory() {
    if (!win) return;
    try {
      if (win.sessionStorage) {
        win.sessionStorage.removeItem(STORAGE_KEY_HISTORY);
        win.sessionStorage.removeItem('ai_proxy_ask_session_id');
      }
      if (win.localStorage) {
        win.localStorage.removeItem(STORAGE_KEY_HISTORY);
        win.localStorage.removeItem('ai_proxy_ask_session_id');
      }
    } catch {}
  }

  function renderDefaultGreeting() {
    const isZh = lang === 'zh-TW';
    const chipsHtml = isZh
      ? `<div class="ask-ai-chips">
          <button type="button" class="ask-ai-chip" data-ask="mcp 是什麼？">❓ 什麼是 MCP？</button>
          <button type="button" class="ask-ai-chip" data-ask="快速上手指南">🚀 快速上手</button>
          <button type="button" class="ask-ai-chip" data-ask="查看 WebMCP 工具目錄">🛠️ WebMCP 工具</button>
          <button type="button" class="ask-ai-chip" data-ask="七大安全基準">🔒 安全基準</button>
          <button type="button" class="ask-ai-chip" data-ask="查看規格文件">📄 規格與協定</button>
          <button type="button" class="ask-ai-chip" data-ask="如何安裝 CLI 與 agent skills">💻 CLI &amp; Skills</button>
        </div>`
      : `<div class="ask-ai-chips">
          <button type="button" class="ask-ai-chip" data-ask="What is MCP Pages?">❓ What is MCP?</button>
          <button type="button" class="ask-ai-chip" data-ask="Quickstart guide">🚀 Quickstart</button>
          <button type="button" class="ask-ai-chip" data-ask="WebMCP tools catalog">🛠️ WebMCP Tools</button>
          <button type="button" class="ask-ai-chip" data-ask="Security baselines">🔒 Security</button>
          <button type="button" class="ask-ai-chip" data-ask="Normative specification">📄 Spec &amp; Protocol</button>
          <button type="button" class="ask-ai-chip" data-ask="CLI and agent skills">💻 CLI &amp; Skills</button>
        </div>`;

    const greetingText = isZh
      ? `<p>您好！我是您的 <strong>MCP Pages &amp; ai-proxy 智慧助理</strong>。您可以詢問我關於 MCP Pages 架構、規格、安全基準、CLI 安裝或 Dashboard 管理的問題。</p>${chipsHtml}`
      : `<p>Hello! I am your <strong>MCP Pages &amp; ai-proxy Assistant</strong>. Ask me how to configure ai-proxy, deploy static MCP pages, inspect security baselines, or manage site origins.</p>${chipsHtml}`;

    messagesEl.innerHTML = '';
    const div = doc.createElement('div');
    div.className = 'ask-ai-msg ask-ai-msg-assistant';
    div.innerHTML = greetingText;
    messagesEl.appendChild(div);
  }

  function isScrollAtBottom(el, threshold = 60) {
    if (!el) return true;
    const ch = el.clientHeight || 0;
    const sh = el.scrollHeight || 0;
    const st = el.scrollTop || 0;
    return (sh - st - ch) <= threshold;
  }

  function ensureScrollBottom(el, wasAtBottom) {
    if (!el || wasAtBottom === false) return;
    el.scrollTop = el.scrollHeight;
    if (typeof win.requestAnimationFrame === 'function') {
      win.requestAnimationFrame(() => {
        if (isScrollAtBottom(el, 60)) {
          el.scrollTop = el.scrollHeight;
        }
      });
    }
  }

  function getAiProxyEndpoint() {
    let custom = '';
    try {
      if (win.localStorage) custom = win.localStorage.getItem('ai_proxy_endpoint') || '';
    } catch {}
    if (custom) return custom.replace(/\/+$/, '');

    const hs = extractHandshake(win);
    const urlPort = win && win.location && win.location.port ? Number.parseInt(win.location.port, 10) : 0;
    const port = hs.mcpPort !== 8788 ? hs.mcpPort : urlPort || 8788;
    return `http://127.0.0.1:${port}`;
  }

  function renderAssistantBubble(div, markdown) {
    const raw = String(markdown || '');
    const html = formatAssistantMarkdown(raw);
    div.innerHTML = [
      '<div class="ask-ai-msg-header">',
      '  <button type="button" class="ask-ai-raw-toggle" title="Toggle Raw / Preview">Raw</button>',
      '</div>',
      `<div class="ask-ai-rendered-content">${html}</div>`,
      `<pre class="ask-ai-raw-content" style="display:none;">${escapeHtml(raw)}</pre>`
    ].join('\n');
  }

  function appendThinkingMessage() {
    const div = doc.createElement('div');
    div.className = 'ask-ai-msg ask-ai-msg-assistant';
    div.innerHTML = [
      '<div class="ask-ai-thinking">',
      '  <span class="ask-ai-thinking-spinner"></span>',
      `  <span>${lang === 'zh-TW' ? '思考中' : 'Thinking'}<span class="ask-ai-thinking-dots"><span>.</span><span>.</span><span>.</span></span></span>`,
      '</div>'
    ].join('\n');
    messagesEl.appendChild(div);
    ensureScrollBottom(messagesEl, true);
    return div;
  }

  async function updateConnectionStatus() {
    const dot = doc.getElementById('ask-ai-status-dot');
    if (!dot) return;
    const endpoint = getAiProxyEndpoint();
    try {
      const controller = typeof win.AbortController === 'function' ? new win.AbortController() : null;
      const timer = setTimeout(() => {
        if (controller) controller.abort();
      }, 2000);
      await fetch(`${endpoint}/healthz`, {
        method: 'GET',
        mode: 'no-cors',
        cache: 'no-store',
        signal: controller ? controller.signal : undefined
      });
      clearTimeout(timer);
      dot.className = 'ask-ai-status-dot connected';
      dot.setAttribute('title', `ai-proxy: Connected (${endpoint})`);
      dot.setAttribute('aria-label', `ai-proxy: Connected (${endpoint})`);
    } catch {
      dot.className = 'ask-ai-status-dot disconnected';
      dot.setAttribute('title', `ai-proxy: Disconnected (${endpoint})`);
      dot.setAttribute('aria-label', `ai-proxy: Disconnected (${endpoint})`);
    }
  }

  const messageHistory = loadStoredHistory();

  // If there is existing conversation history, render it; otherwise render default greeting with chips
  if (messageHistory.length > 0) {
    messagesEl.innerHTML = '';
    for (const item of messageHistory) {
      const div = doc.createElement('div');
      div.className = `ask-ai-msg ${item.role === 'user' ? 'ask-ai-msg-user' : 'ask-ai-msg-assistant'}`;
      if (item.role === 'user') {
        div.textContent = item.content;
      } else {
        renderAssistantBubble(div, item.content);
      }
      messagesEl.appendChild(div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    renderDefaultGreeting();
  }

  function setOpen(open) {
    drawer.setAttribute('data-open', open ? 'true' : 'false');
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (win) {
      try {
        if (win.sessionStorage) win.sessionStorage.setItem(STORAGE_KEY_OPEN, open ? 'true' : 'false');
        if (win.localStorage) win.localStorage.setItem(STORAGE_KEY_OPEN, open ? 'true' : 'false');
      } catch {}
    }
    if (open) {
      input.focus();
      updateConnectionStatus();
    }
  }

  // Restore drawer open state if it was open prior to navigating
  if (win) {
    try {
      const savedOpen =
        (win.sessionStorage && win.sessionStorage.getItem(STORAGE_KEY_OPEN)) ||
        (win.localStorage && win.localStorage.getItem(STORAGE_KEY_OPEN));
      if (savedOpen === 'true') {
        setOpen(true);
      }
    } catch {}
  }

  if (triggerBtn) {
    triggerBtn.addEventListener('click', () => {
      const isOpen = drawer.getAttribute('data-open') === 'true';
      setOpen(!isOpen);
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', () => setOpen(false));
  }

  // Header controls & Settings injection
  const header = (typeof drawer.querySelector === 'function' ? drawer.querySelector('.ask-ai-header') : null) || (drawer.children && drawer.children[0]);
  if (header) {
    const titleEl = typeof header.querySelector === 'function' ? header.querySelector('strong') : null;
    if (titleEl) {
      titleEl.textContent = 'Ask AI';
    }
    let statusDot = doc.getElementById('ask-ai-status-dot');
    if (!statusDot && titleEl && titleEl.parentNode) {
      statusDot = doc.createElement('span');
      statusDot.className = 'ask-ai-status-dot';
      statusDot.id = 'ask-ai-status-dot';
      statusDot.setAttribute('title', 'ai-proxy: Checking...');
      titleEl.parentNode.insertBefore(statusDot, titleEl);
    }
  }

  // Inject Settings button next to Clear / Close button
  let settingsBtn = doc.getElementById('ask-ai-settings-btn');
  if (!settingsBtn && closeBtn && closeBtn.parentNode) {
    settingsBtn = doc.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'btn btn-sm';
    settingsBtn.id = 'ask-ai-settings-btn';
    settingsBtn.setAttribute('title', 'Settings');
    settingsBtn.setAttribute('aria-label', 'Settings');
    settingsBtn.style.marginRight = '0.375rem';
    settingsBtn.textContent = '⚙️';
    closeBtn.parentNode.insertBefore(settingsBtn, closeBtn);
  }

  // Inject Clear History button next to Close button if not present
  let clearBtn = doc.getElementById('ask-ai-clear');
  if (!clearBtn && closeBtn && closeBtn.parentNode) {
    clearBtn = doc.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-sm';
    clearBtn.id = 'ask-ai-clear';
    clearBtn.style.marginRight = '0.375rem';
    clearBtn.textContent = lang === 'zh-TW' ? '清除紀錄' : 'Clear';
    closeBtn.parentNode.insertBefore(clearBtn, closeBtn);
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      messageHistory.length = 0;
      clearStoredHistory();
      renderDefaultGreeting();
    });
  }

  // Inject Settings panel inside drawer if not present
  let settingsPanel = doc.getElementById('ask-ai-settings-panel');
  if (!settingsPanel && header && header.parentNode) {
    settingsPanel = doc.createElement('div');
    settingsPanel.className = 'ask-ai-settings';
    settingsPanel.id = 'ask-ai-settings-panel';
    settingsPanel.innerHTML = [
      '<form id="ask-ai-settings-form" style="display:flex;flex-direction:column;gap:0.5rem;">',
      '  <label style="font-weight:600;font-size:0.75rem;">',
      `    ${lang === 'zh-TW' ? 'ai-proxy 服務網址：' : 'ai-proxy URL:'}`,
      '    <input type="url" id="ask-ai-endpoint-input" placeholder="http://127.0.0.1:8788" class="form-control input-sm" style="width:100%;box-sizing:border-box;margin-top:0.25rem;" />',
      '  </label>',
      '  <div style="display:flex;gap:0.5rem;justify-content:flex-end;">',
      `    <button type="button" class="btn btn-sm" id="ask-ai-settings-reset">${lang === 'zh-TW' ? '重設' : 'Reset'}</button>`,
      `    <button type="submit" class="btn btn-sm btn-primary">${lang === 'zh-TW' ? '儲存' : 'Save'}</button>`,
      '  </div>',
      '</form>'
    ].join('\n');
    if (header.nextSibling) {
      header.parentNode.insertBefore(settingsPanel, header.nextSibling);
    } else {
      header.parentNode.appendChild(settingsPanel);
    }
  }

  if (settingsBtn && settingsPanel) {
    settingsBtn.addEventListener('click', () => {
      const isOpen = settingsPanel.classList.toggle('open');
      if (isOpen) {
        const inputEl = doc.getElementById('ask-ai-endpoint-input');
        if (inputEl) {
          let custom = '';
          try {
            if (win.localStorage) custom = win.localStorage.getItem('ai_proxy_endpoint') || '';
          } catch {}
          inputEl.value = custom || getAiProxyEndpoint();
          inputEl.focus();
        }
      }
    });
  }

  const settingsForm = doc.getElementById('ask-ai-settings-form');
  if (settingsForm) {
    settingsForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const inputEl = doc.getElementById('ask-ai-endpoint-input');
      const val = inputEl ? inputEl.value.trim() : '';
      try {
        if (win.localStorage) {
          if (val) {
            win.localStorage.setItem('ai_proxy_endpoint', val);
          } else {
            win.localStorage.removeItem('ai_proxy_endpoint');
          }
        }
      } catch {}
      if (settingsPanel) settingsPanel.classList.remove('open');
      updateConnectionStatus();
    });
  }

  const settingsResetBtn = doc.getElementById('ask-ai-settings-reset');
  if (settingsResetBtn) {
    settingsResetBtn.addEventListener('click', () => {
      try {
        if (win.localStorage) win.localStorage.removeItem('ai_proxy_endpoint');
      } catch {}
      const inputEl = doc.getElementById('ask-ai-endpoint-input');
      if (inputEl) inputEl.value = getAiProxyEndpoint();
      if (settingsPanel) settingsPanel.classList.remove('open');
      updateConnectionStatus();
    });
  }

  // Periodic and initial connection status check
  updateConnectionStatus();
  if (win && typeof win.setInterval === 'function') {
    win.setInterval(updateConnectionStatus, 15000);
  }

  function appendMessage(role, textOrHtml, isHtml = false, rawMarkdown = null, persist = true) {
    const div = doc.createElement('div');
    div.className = `ask-ai-msg ${role === 'user' ? 'ask-ai-msg-user' : 'ask-ai-msg-assistant'}`;
    if (role === 'assistant') {
      const markdown = rawMarkdown !== null ? rawMarkdown : textOrHtml;
      renderAssistantBubble(div, markdown);
    } else if (isHtml) {
      div.innerHTML = textOrHtml;
    } else {
      div.textContent = textOrHtml;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    if (persist) {
      const content = rawMarkdown || textOrHtml;
      messageHistory.push({ role, content: sanitizeForStorage(content) });
      saveStoredHistory(messageHistory);
    }

    return div;
  }

  function appendAssistantFormatted(markdown, persist = true) {
    return appendMessage('assistant', markdown, false, markdown, persist);
  }

  function focusAndHighlight(selector) {
    if (!selector) return false;
    try {
      const el = doc.querySelector(selector);
      if (!el) return false;

      // Automatically open parent details if collapsed
      const parentDetails = el.closest('details');
      if (parentDetails) {
        parentDetails.open = true;
      }
      if (el.tagName && el.tagName.toLowerCase() === 'details') {
        el.open = true;
      }

      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-pulse');
      setTimeout(() => el.classList.remove('highlight-pulse'), 2500);

      const inputEl =
        el.querySelector('input') || (el.tagName && el.tagName.toLowerCase() === 'input' ? el : null);
      if (inputEl) {
        setTimeout(() => inputEl.focus(), 300);
      }
      return true;
    } catch {
      return false;
    }
  }

  function handleJump(targetHash) {
    if (!targetHash || !targetHash.startsWith('#')) return;

    // Check if element exists on current page
    const found = focusAndHighlight(targetHash);
    if (!found) {
      // Element is on another page! Resolve cross-page destination
      let targetPage = '';
      if (
        targetHash === '#form-add-site' ||
        targetHash === '#admin-dashboard-authenticated' ||
        targetHash === '#details-allow-prefix' ||
        targetHash === '#details-allowed-origins' ||
        targetHash === '#details-key-mgmt' ||
        targetHash.startsWith('#site-row-')
      ) {
        targetPage = 'dashboard.html';
      } else if (
        targetHash === '#quickstart' ||
        targetHash === '#how-it-works' ||
        targetHash === '#architecture' ||
        targetHash === '#security' ||
        targetHash === '#faq' ||
        targetHash === '#examples'
      ) {
        targetPage = lang === 'zh-TW' ? 'zh-TW.html' : 'index.html';
      }

      if (targetPage) {
        // Keep drawer open on destination page
        if (win && win.sessionStorage) {
          try {
            win.sessionStorage.setItem(STORAGE_KEY_OPEN, 'true');
          } catch {}
        }
        win.location.href = `${targetPage}${targetHash}`;
      }
    }
  }

  // If page loaded with hash, highlight target section
  if (win && win.location && win.location.hash) {
    setTimeout(() => {
      focusAndHighlight(win.location.hash);
    }, 250);
  }

  function triggerDashboardRefresh() {
    if (win && typeof win.__aiProxyRefreshDashboard === 'function') {
      try {
        win.__aiProxyRefreshDashboard();
      } catch {}
    }
    if (win && typeof win.dispatchEvent === 'function') {
      try {
        win.dispatchEvent(new win.CustomEvent('ai-proxy-refresh-dashboard'));
      } catch {}
    }
  }

  async function handleActionClick(btn) {
    const actionStr = btn.getAttribute('data-action');
    if (!actionStr) return;
    const raw = actionStr.replace(/^action:/, '');
    const [actionName, queryString] = raw.split('?');
    const params = new URLSearchParams(queryString || '');

    const hs = extractHandshake(win);
    const endpoint = getAiProxyEndpoint();

    if (actionName === 'connect') {
      const redirectUrl = win.location.href;
      if (win && win.sessionStorage) {
        try {
          win.sessionStorage.setItem(STORAGE_KEY_OPEN, 'true');
        } catch {}
      }
      const addUrl = params.get('add-url') || params.get('add_url') || params.get('add');
      const addQuery = addUrl ? `&add-url=${encodeURIComponent(addUrl)}` : '';
      win.location.href = `${endpoint}/admin/v1/open-dashboard?redirect=${encodeURIComponent(
        redirectUrl
      )}${addQuery}`;
      return;
    }

    if (actionName === 'focus') {
      const targetSelector = params.get('target');
      if (targetSelector) {
        handleJump(targetSelector);
      }
      return;
    }

    if (!hs.adminKey) {
      const pendingUrl = (actionName === 'add-mcp' || actionName === 'add-site') ? params.get('url') : '';
      const connectAction = pendingUrl ? `action:connect?add-url=${encodeURIComponent(pendingUrl)}` : 'action:connect';
      appendAssistantFormatted(
        lang === 'zh-TW'
          ? `此操作需要本機管理金鑰（admin-key）。\n\n[🔌 接上本機 ai-proxy (Connect)](${connectAction})`
          : `This action requires an admin key.\n\n[🔌 Connect to local ai-proxy](${connectAction})`
      );
      return;
    }

    btn.disabled = true;
    const originalText = btn.textContent;
    btn.textContent = lang === 'zh-TW' ? '執行中…' : 'Executing…';

    try {
      if (actionName === 'add-mcp' || actionName === 'add-site') {
        const url = params.get('url');
        const name = params.get('name') || undefined;
        const writeParam = params.get('write');
        const write = writeParam === null ? true : writeParam !== 'false';
        const originParam = params.get('allowOrigin');
        const allowOrigin = originParam === null ? true : originParam !== 'false';
        const prefixParam = params.get('allowPrefix');
        const allowPrefix = prefixParam === null ? true : prefixParam !== 'false';
        const res = await fetch(`${endpoint}/admin/v1/sites`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hs.adminKey}`
          },
          body: JSON.stringify({ url, name, write, allowOrigin, allowPrefix })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        btn.textContent = `✅ ${lang === 'zh-TW' ? '已新增' : 'Added'}`;
        btn.classList.remove('btn-primary');
        triggerDashboardRefresh();

        const siteId = data.site?.url
          ? `#site-row-${encodeURIComponent(data.site.url).replace(/[^a-zA-Z0-9_-]/g, '_')}`
          : '#admin-dashboard-authenticated';

        appendAssistantFormatted(
          lang === 'zh-TW'
            ? `✅ 成功在 Dashboard 新增 MCP 站點 \`${data.site?.url || url}\`（${data.site?.write !== false ? '讀寫支援' : '唯讀模式'}）！已自動設定 URL Prefix Allowlist 與 Origin 授權。\n\n[📋 前往查看該站點](${siteId})`
            : `✅ Successfully added MCP site \`${data.site?.url || url}\` (${data.site?.write !== false ? 'Read/Write' : 'Read-Only'})! Auto-configured URL prefix allowlist & origin.\n\n[📋 View registered site](${siteId})`
        );
      } else if (actionName === 'set-permission') {
        const url = params.get('url');
        const write = params.get('write') === 'true';
        const res = await fetch(`${endpoint}/admin/v1/sites/permission`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hs.adminKey}`
          },
          body: JSON.stringify({ url, write })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        btn.textContent = `✅ ${lang === 'zh-TW' ? '已更新' : 'Updated'}`;
        btn.classList.remove('btn-primary');
        triggerDashboardRefresh();

        appendAssistantFormatted(
          lang === 'zh-TW'
            ? `✅ 成功更新站點 \`${data.site?.url || url}\` 存取模式為：${data.site?.write !== false ? '讀寫支援 (Read/Write)' : '唯讀模式 (Read-Only)'}。`
            : `✅ Successfully updated site \`${data.site?.url || url}\` mode to: ${data.site?.write !== false ? 'Read/Write' : 'Read-Only'}.`
        );
      } else if (actionName === 'remove-mcp' || actionName === 'remove-site') {
        const url = params.get('url');
        const res = await fetch(`${endpoint}/admin/v1/sites`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hs.adminKey}`
          },
          body: JSON.stringify({ url })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        btn.textContent = `✅ ${lang === 'zh-TW' ? '已移除' : 'Removed'}`;
        btn.classList.remove('btn-primary');
        triggerDashboardRefresh();

        appendAssistantFormatted(
          lang === 'zh-TW'
            ? `✅ 已自 local ai-proxy 移除站點 \`${url}\`。`
            : `✅ Successfully removed site \`${url}\` from local ai-proxy.`
        );
      } else if (actionName === 'allow-origin') {
        const origin = params.get('origin');
        const res = await fetch(`${endpoint}/admin/v1/origins`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hs.adminKey}`
          },
          body: JSON.stringify({ origin, action: 'allow' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        btn.textContent = `✅ ${lang === 'zh-TW' ? '已授權 Origin' : 'Allowed Origin'}`;
        btn.classList.remove('btn-primary');
        triggerDashboardRefresh();

        appendAssistantFormatted(
          lang === 'zh-TW'
            ? `✅ 已授權 Origin \`${origin}\`。\n\n[📂 查看 Allowed Origins](#details-allowed-origins)`
            : `✅ Authorized Origin \`${origin}\`.\n\n[📂 View Allowed Origins](#details-allowed-origins)`
        );
      } else if (actionName === 'deny-origin') {
        const origin = params.get('origin');
        const res = await fetch(`${endpoint}/admin/v1/origins`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hs.adminKey}`
          },
          body: JSON.stringify({ origin, action: 'deny' })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

        btn.textContent = `✅ ${lang === 'zh-TW' ? '已撤銷 Origin' : 'Revoked Origin'}`;
        btn.classList.remove('btn-primary');
        triggerDashboardRefresh();

        appendAssistantFormatted(
          lang === 'zh-TW'
            ? `✅ 已撤銷 Origin \`${origin}\`。\n\n[📂 查看 Allowed Origins](#details-allowed-origins)`
            : `✅ Revoked Origin \`${origin}\`.\n\n[📂 View Allowed Origins](#details-allowed-origins)`
        );
      }
    } catch (err) {
      btn.disabled = false;
      btn.textContent = originalText;
      appendAssistantFormatted(`❌ Error: ${escapeHtml(err.message)}`);
    }
  }

  // Delegate clicks on interactive buttons & links within messages
  messagesEl.addEventListener('click', (ev) => {
    const rawToggle = ev.target.closest('.ask-ai-raw-toggle');
    if (rawToggle) {
      ev.preventDefault();
      const parentMsg = rawToggle.closest('.ask-ai-msg-assistant');
      if (parentMsg) {
        const rendered = parentMsg.querySelector('.ask-ai-rendered-content');
        const raw = parentMsg.querySelector('.ask-ai-raw-content');
        if (rendered && raw) {
          const isRaw = raw.style.display !== 'none';
          if (isRaw) {
            raw.style.display = 'none';
            rendered.style.display = '';
            rawToggle.textContent = 'Raw';
          } else {
            raw.style.display = 'block';
            rendered.style.display = 'none';
            rawToggle.textContent = 'Preview';
          }
        }
      }
      return;
    }

    const chip = ev.target.closest('.ask-ai-chip');
    if (chip) {
      ev.preventDefault();
      const query = chip.getAttribute('data-ask') || chip.textContent.trim();
      if (query) {
        input.value = query;
        if (typeof form.requestSubmit === 'function') {
          form.requestSubmit();
        } else {
          form.dispatchEvent(new win.Event('submit', { cancelable: true, bubbles: true }));
        }
      }
      return;
    }

    const ctaBtn = ev.target.closest('.ask-ai-cta-btn');
    if (ctaBtn) {
      ev.preventDefault();
      handleActionClick(ctaBtn);
      return;
    }

    const jumpBtn = ev.target.closest('.ask-ai-jump-btn');
    if (jumpBtn) {
      ev.preventDefault();
      const targetHash = jumpBtn.getAttribute('data-jump');
      if (targetHash) {
        handleJump(targetHash);
      }
      return;
    }

    const anchor = ev.target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href) {
        if (href.startsWith('#')) {
          ev.preventDefault();
          handleJump(href);
        } else if (!href.startsWith('http') && !href.startsWith('mailto:')) {
          // Internal relative navigation: preserve open state across pages
          if (win) {
            try {
              if (win.sessionStorage) win.sessionStorage.setItem(STORAGE_KEY_OPEN, 'true');
              if (win.localStorage) win.localStorage.setItem(STORAGE_KEY_OPEN, 'true');
            } catch {}
          }
        }
      }
    }
  });

  let currentAbortController = null;
  const submitBtn = (form.querySelector && form.querySelector('button[type="submit"]')) || (form.querySelector && form.querySelector('button'));
  const originalSubmitText = submitBtn ? submitBtn.textContent : (lang === 'zh-TW' ? '送出' : 'Send');

  if (submitBtn) {
    submitBtn.addEventListener('click', (ev) => {
      if (currentAbortController) {
        ev.preventDefault();
        currentAbortController.abort();
      }
    });
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (currentAbortController) {
      currentAbortController.abort();
      return;
    }

    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';

    appendMessage('user', prompt);
    const pendingEl = appendThinkingMessage();

    // Auto-detect jump/navigation requests and trigger page navigation immediately
    if (/(?:跳轉|前往|打開|跳到|查看|jump to|go to|open)/i.test(prompt)) {
      if (/(?:quickstart|快速上手)/i.test(prompt)) {
        handleJump('#quickstart');
      } else if (/(?:allowlist|白名單|prefix)/i.test(prompt)) {
        handleJump('#details-allow-prefix');
      } else if (/(?:origin|來源)/i.test(prompt)) {
        handleJump('#details-allowed-origins');
      } else if (/(?:sites?|mcp|站點)/i.test(prompt)) {
        handleJump('#form-add-site');
      } else if (/(?:key|金鑰|rotate)/i.test(prompt)) {
        handleJump('#details-key-mgmt');
      }
    }

    currentAbortController = typeof win.AbortController === 'function' ? new win.AbortController() : null;
    if (submitBtn) {
      submitBtn.textContent = lang === 'zh-TW' ? '■ 停止' : '■ Stop';
      if (submitBtn.classList) {
        submitBtn.classList.add('btn-danger');
        submitBtn.classList.remove('btn-primary');
      }
    }

    try {
      const endpoint = getAiProxyEndpoint();

      let askSessionId = 'default';
      try {
        askSessionId = (win.sessionStorage && win.sessionStorage.getItem('ai_proxy_ask_session_id')) || '';
        if (!askSessionId) {
          askSessionId =
            win.crypto && typeof win.crypto.randomUUID === 'function'
              ? win.crypto.randomUUID()
              : `sess_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
          if (win.sessionStorage) win.sessionStorage.setItem('ai_proxy_ask_session_id', askSessionId);
        }
      } catch {}

      // Include recent conversation turns for multi-turn session context
      const recentMessages = messageHistory.slice(-8).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }));
      if (recentMessages.length === 0 || recentMessages[recentMessages.length - 1].content !== prompt) {
        recentMessages.push({ role: 'user', content: prompt });
      }

      const res = await fetch(`${endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Session-ID': askSessionId
        },
        body: JSON.stringify({
          model: 'local-default',
          user: askSessionId,
          messages: [
            {
              role: 'system',
              content:
                'You are the MCP Pages & ai-proxy documentation and dashboard assistant. Answer concisely and provide CTA action buttons or section links when relevant.'
            },
            ...recentMessages
          ],
          stream: false
        }),
        signal: currentAbortController ? currentAbortController.signal : undefined
      });

      const data = await res.json();
      if (!res.ok) {
        const errorText =
          (data && data.error && (data.error.message || data.error)) ||
          `HTTP ${res.status}: Origin not authorized on /v1. Run: \`npx ai-proxy allow-origin ${win.location ? win.location.origin : ''}\``;
        const clientAnswer = generateClientAssistantReply(prompt, lang);
        const combined = `${clientAnswer}\n\n> ⚠️ *${errorText}*\n\n[🔌 接上本機 ai-proxy (Connect)](action:connect)`;
        renderAssistantBubble(pendingEl, combined);
        messageHistory.push({ role: 'assistant', content: sanitizeForStorage(combined) });
        saveStoredHistory(messageHistory);
        ensureScrollBottom(messagesEl, true);
        return;
      }

      const content =
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;

      let replyContent = content || JSON.stringify(data);
      const isFallbackEcho =
        replyContent.includes('ai-proxy local assistant received:') ||
        replyContent.includes('Permitted read-only tools: [none]');
      if (isFallbackEcho) {
        replyContent = generateClientAssistantReply(prompt, lang);
      }

      renderAssistantBubble(pendingEl, replyContent);
      messageHistory.push({ role: 'assistant', content: sanitizeForStorage(replyContent) });
      saveStoredHistory(messageHistory);
      ensureScrollBottom(messagesEl, true);
    } catch {
      if (currentAbortController && currentAbortController.signal && currentAbortController.signal.aborted) {
        const stoppedText = lang === 'zh-TW' ? '⏹️ 已停止思考。' : '⏹️ Thinking stopped.';
        renderAssistantBubble(pendingEl, stoppedText);
        messageHistory.push({ role: 'assistant', content: sanitizeForStorage(stoppedText) });
        saveStoredHistory(messageHistory);
        ensureScrollBottom(messagesEl, true);
        return;
      }

      const clientAnswer = generateClientAssistantReply(prompt, lang);
      const offlineNote =
        lang === 'zh-TW'
          ? `${clientAnswer}\n\n> 💡 本機 ai-proxy 未連線或目前 Origin 尚未授權。\n\n[🔌 接上本機 ai-proxy (Connect)](action:connect)`
          : `${clientAnswer}\n\n> 💡 Local ai-proxy is not connected or Origin is unauthorized.\n\n[🔌 Connect to local ai-proxy](action:connect)`;
      renderAssistantBubble(pendingEl, offlineNote);
      messageHistory.push({ role: 'assistant', content: sanitizeForStorage(offlineNote) });
      saveStoredHistory(messageHistory);
      ensureScrollBottom(messagesEl, true);
    } finally {
      currentAbortController = null;
      if (submitBtn) {
        submitBtn.textContent = originalSubmitText;
        if (submitBtn.classList) {
          submitBtn.classList.remove('btn-danger');
          submitBtn.classList.add('btn-primary');
        }
      }
    }
  });

  return { setOpen, focusAndHighlight, handleJump, triggerDashboardRefresh, updateConnectionStatus };
}
