/**
 * Bilingual string tables (English and Traditional Chinese) and duplicate-key verifier.
 */

export const STRINGS = {
  en: {
    brand_title: 'ai-proxy · MCP Pages',
    nav_home: 'Overview',
    nav_docs: 'Docs',
    nav_dashboard: 'Dashboard',
    nav_mcp: 'MCP Page',
    nav_ask_ai: 'Ask AI',
    theme_system: 'System',
    theme_light: 'Light',
    theme_dark: 'Dark',
    lang_switch_label: '繁體中文',
    hero_title: 'Turn any static site into an MCP server—without a backend.',
    hero_subtitle:
      'MCP Pages standardizes client-side WebMCP tools for GitHub Pages and static sites. ai-proxy is the zero-dependency local relay that connects your browser tab to Claude Code and MCP clients.',
    cta_open_dashboard: 'Open Dashboard',
    cta_read_spec: 'Read Specification',
    cta_inspect_mcp: 'Inspect This Site’s MCP Page',
    quickstart_heading: 'Quick Start Commands',
    quickstart_desc:
      'Copy and run these commands in your terminal. The URL below automatically points to this deployment:',
    architecture_heading: 'How MCP Pages Works',
    security_heading: 'Seven Security Baselines for Shared Origins',
    security_desc:
      'All repositories on <user>.github.io share one browser Origin. ai-proxy isolates every page with URL prefix allowlists and fragment-to-history.state keys.',
    ask_ai_title: 'Ask AI (Local /v1 Demo)',
    ask_ai_placeholder: 'Ask how fragment key handoff or prefix allowlisting works...',
    ask_ai_send: 'Send',
    ask_ai_close: 'Close',
    ask_ai_hint:
      'Connects to http://127.0.0.1:8788/v1/chat/completions. Only explicitly named readOnlyHint:true tools are ever exposed.',
    dash_title: 'ai-proxy Relay Dashboard',
    dash_connect_btn: 'Connect to Local ai-proxy',
    dash_connect_desc:
      'No admin key is loaded in this tab. Click Connect to ask your local ai-proxy to open an authenticated dashboard tab.',
    dash_sites_heading: 'Registered MCP Sites',
    dash_add_site_btn: 'Add & Allow Site',
    dash_allowlist_heading: 'URL Prefix Allowlist',
    dash_origins_heading: '/v1 Chat Allowed Origins',
    dash_keys_heading: 'Key Rotation',
    dash_rotate_all_btn: 'Rotate All Site Keys',
    dash_rotate_admin_btn: 'Rotate Admin Key'
  },
  'zh-TW': {
    brand_title: 'ai-proxy · MCP Pages',
    nav_home: '總覽',
    nav_docs: '規範文件',
    nav_dashboard: '儀表板',
    nav_mcp: '本站 MCP 頁',
    nav_ask_ai: '問 AI',
    theme_system: '跟隨系統',
    theme_light: '亮色',
    theme_dark: '暗色',
    lang_switch_label: 'English',
    hero_title: '讓任何靜態網站不用後端，就能成為 MCP 工具伺服器。',
    hero_subtitle:
      'MCP Pages 定義了靜態網站提供 WebMCP 工具的開放規範；ai-proxy 是跑在讀者電腦上的零依賴參考轉送，將瀏覽器分頁安全地接上 Claude Code 與各類 AI 工具。',
    cta_open_dashboard: '開啟儀表板',
    cta_read_spec: '閱讀規範文件',
    cta_inspect_mcp: '檢視本站的 MCP 頁',
    quickstart_heading: '快速開始指令',
    quickstart_desc: '直接複製以下指令到終端機執行（網址已自動填入本站目前的部署路徑）：',
    architecture_heading: 'MCP Pages 運作架構',
    security_heading: '針對共用 Origin 的七條安全底線',
    security_desc:
      '<user>.github.io 上的所有網站共用同一個 Origin。ai-proxy 以網址前綴允許清單與 history.state 每頁獨立金鑰隔離敵意鄰居。',
    ask_ai_title: '問 AI（本機 /v1 對話示範）',
    ask_ai_placeholder: '詢問 URL fragment 金鑰交接或允許清單前綴如何運作…',
    ask_ai_send: '送出',
    ask_ai_close: '關閉',
    ask_ai_hint:
      '透過本機 http://127.0.0.1:8788/v1/chat/completions 回答；僅開放逐一點名的唯讀工具。',
    dash_title: 'ai-proxy 轉送狀態儀表板',
    dash_connect_btn: '接上本機 ai-proxy',
    dash_connect_desc:
      '此分頁尚未持有管理金鑰。按一下「接上本機 ai-proxy」，由本機轉送開啟帶金鑰的儀表板分頁。',
    dash_sites_heading: '已註冊的 MCP 網站',
    dash_add_site_btn: '新增並允許網站',
    dash_allowlist_heading: '網址前綴允許清單',
    dash_origins_heading: '/v1 對話允許的 Origin',
    dash_keys_heading: '金鑰輪換',
    dash_rotate_all_btn: '輪換所有網站金鑰',
    dash_rotate_admin_btn: '輪換管理金鑰'
  }
};

export function t(lang, key) {
  const table = STRINGS[lang] || STRINGS.en;
  return key in table ? table[key] : STRINGS.en[key] || key;
}

export function findDuplicateKeysInSource(sourceText) {
  const duplicates = [];
  const blockRegex = /(?:['"]?([a-zA-Z-]+)['"]?)\s*:\s*\{([^{}]*)\}/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(sourceText)) !== null) {
    const lang = blockMatch[1];
    if (lang !== 'en' && lang !== 'zh-TW') continue;
    const body = blockMatch[2];
    const seen = new Set();
    const keyRegex = /^\s*(?:['"]([^'"]+)['"]|([a-zA-Z0-9_]+))\s*:/gm;
    let keyMatch;
    while ((keyMatch = keyRegex.exec(body)) !== null) {
      const k = keyMatch[1] || keyMatch[2];
      if (seen.has(k)) {
        duplicates.push({ lang, key: k });
      }
      seen.add(k);
    }
  }
  return duplicates;
}
