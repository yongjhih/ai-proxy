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
  let inList = false;

  function closeList() {
    if (inList) {
      result.push('</ul>');
      inList = false;
    }
  }

  function formatInline(text) {
    let out = escapeHtml(text);

    // Replace Markdown links [Text](Url)
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
        closeList();
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      codeBlockLines.push(rawLine);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    // List item
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        result.push('<ul>');
        inList = true;
      }
      result.push(`<li>${formatInline(trimmed.slice(2))}</li>`);
      continue;
    }

    closeList();

    // Blockquote
    if (trimmed.startsWith('> ')) {
      result.push(`<blockquote>${formatInline(trimmed.slice(2))}</blockquote>`);
      continue;
    }

    // Paragraph
    result.push(`<p>${formatInline(rawLine)}</p>`);
  }

  closeList();
  if (inCodeBlock && codeBlockLines.length > 0) {
    result.push(`<pre><code>${escapeHtml(codeBlockLines.join('\n'))}</code></pre>`);
  }

  return result.join('');
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
    if (!win || !win.sessionStorage) return [];
    try {
      const raw = win.sessionStorage.getItem(STORAGE_KEY_HISTORY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function saveStoredHistory(historyList) {
    if (!win || !win.sessionStorage) return;
    try {
      const trimmed = historyList.slice(-50);
      win.sessionStorage.setItem(STORAGE_KEY_HISTORY, JSON.stringify(trimmed));
    } catch {}
  }

  const messageHistory = loadStoredHistory();

  // If there is existing conversation history, render it
  if (messageHistory.length > 0) {
    messagesEl.innerHTML = '';
    for (const item of messageHistory) {
      const div = doc.createElement('div');
      div.className = `ask-ai-msg ${item.role === 'user' ? 'ask-ai-msg-user' : 'ask-ai-msg-assistant'}`;
      if (item.role === 'user') {
        div.textContent = item.content;
      } else {
        div.innerHTML = formatAssistantMarkdown(item.content);
      }
      messagesEl.appendChild(div);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function setOpen(open) {
    drawer.setAttribute('data-open', open ? 'true' : 'false');
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (win && win.sessionStorage) {
      try {
        win.sessionStorage.setItem(STORAGE_KEY_OPEN, open ? 'true' : 'false');
      } catch {}
    }
    if (open) {
      input.focus();
    }
  }

  // Restore drawer open state if it was open prior to navigating
  if (win && win.sessionStorage) {
    try {
      const savedOpen = win.sessionStorage.getItem(STORAGE_KEY_OPEN);
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
      if (win && win.sessionStorage) {
        try {
          win.sessionStorage.removeItem(STORAGE_KEY_HISTORY);
        } catch {}
      }
      messagesEl.innerHTML = '';
      appendAssistantFormatted(
        lang === 'zh-TW'
          ? '對話紀錄已清除。您可以隨時詢問我任何關於 MCP Pages 或 ai-proxy 的問題！\n\n- [🚀 前往快速上手指南](#quickstart)\n- [📋 查看 MCP sites 列表](#admin-dashboard-authenticated)\n- [🔒 查看安全性規範](doc.html?d=security)'
          : 'Chat history cleared. Feel free to ask me anything about MCP Pages or ai-proxy!\n\n- [🚀 Quickstart](#quickstart)\n- [📋 View MCP sites](#admin-dashboard-authenticated)\n- [🔒 Security baseline](doc.html?d=security)'
      );
    });
  }

  function appendMessage(role, textOrHtml, isHtml = false, rawMarkdown = null, persist = true) {
    const div = doc.createElement('div');
    div.className = `ask-ai-msg ${role === 'user' ? 'ask-ai-msg-user' : 'ask-ai-msg-assistant'}`;
    if (isHtml) {
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
    const html = formatAssistantMarkdown(markdown);
    return appendMessage('assistant', html, true, markdown, persist);
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
    const urlPort = win && win.location && win.location.port ? Number.parseInt(win.location.port, 10) : 0;
    const port = hs.mcpPort !== 8788 ? hs.mcpPort : urlPort || 8788;

    if (actionName === 'connect') {
      const redirectUrl = win.location.href;
      if (win && win.sessionStorage) {
        try {
          win.sessionStorage.setItem(STORAGE_KEY_OPEN, 'true');
        } catch {}
      }
      win.location.href = `http://127.0.0.1:${port}/admin/v1/open-dashboard?redirect=${encodeURIComponent(
        redirectUrl
      )}`;
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
      appendAssistantFormatted(
        lang === 'zh-TW'
          ? '此操作需要本機管理金鑰（admin-key）。\n\n[🔌 接上本機 ai-proxy (Connect)](action:connect)'
          : 'This action requires an admin key.\n\n[🔌 Connect to local ai-proxy](action:connect)'
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
        const res = await fetch(`http://127.0.0.1:${port}/admin/v1/sites`, {
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
        const res = await fetch(`http://127.0.0.1:${port}/admin/v1/sites/permission`, {
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
        const res = await fetch(`http://127.0.0.1:${port}/admin/v1/sites`, {
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
        const res = await fetch(`http://127.0.0.1:${port}/admin/v1/origins`, {
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
        const res = await fetch(`http://127.0.0.1:${port}/admin/v1/origins`, {
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
          if (win && win.sessionStorage) {
            try {
              win.sessionStorage.setItem(STORAGE_KEY_OPEN, 'true');
            } catch {}
          }
        }
      }
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';

    appendMessage('user', prompt);
    const pendingEl = appendMessage('assistant', '…', false, null, false);

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

    try {
      const hs = extractHandshake(win);
      const urlPort = win && win.location && win.location.port ? Number.parseInt(win.location.port, 10) : 0;
      const port = hs.mcpPort !== 8788 ? hs.mcpPort : urlPort || 8788;

      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local-default',
          messages: [
            {
              role: 'system',
              content:
                'You are the MCP Pages & ai-proxy documentation and dashboard assistant. Answer concisely and provide CTA action buttons or section links when relevant.'
            },
            { role: 'user', content: prompt }
          ],
          stream: false
        })
      });

      const data = await res.json();
      if (!res.ok) {
        const errorText =
          (data && data.error && (data.error.message || data.error)) ||
          `HTTP ${res.status}: Origin not authorized on /v1. Run: \`npx ai-proxy allow-origin ${win.location.origin}\``;
        pendingEl.innerHTML = formatAssistantMarkdown(errorText);
        messageHistory.push({ role: 'assistant', content: sanitizeForStorage(errorText) });
        saveStoredHistory(messageHistory);
        return;
      }

      const content =
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;

      const replyContent = content || JSON.stringify(data);
      pendingEl.innerHTML = formatAssistantMarkdown(replyContent);
      messageHistory.push({ role: 'assistant', content: sanitizeForStorage(replyContent) });
      saveStoredHistory(messageHistory);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch {
      const fallbackText =
        lang === 'zh-TW'
          ? '無法連線至本機 ai-proxy (/v1)。請確認已啟動 `npx ai-proxy serve` 並允許此 Origin。\n\n[🔌 接上本機 ai-proxy (Connect)](action:connect)'
          : 'Could not reach local ai-proxy (/v1). Ensure `npx ai-proxy serve` is running and this Origin is allowed.\n\n[🔌 Connect to local ai-proxy](action:connect)';
      pendingEl.innerHTML = formatAssistantMarkdown(fallbackText);
      messageHistory.push({ role: 'assistant', content: sanitizeForStorage(fallbackText) });
      saveStoredHistory(messageHistory);
    }
  });

  return { setOpen, focusAndHighlight, handleJump, triggerDashboardRefresh };
}
