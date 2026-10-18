/**
 * "Ask AI" slide-over sidebar component powered by local /v1/chat/completions.
 * Supports interactive CTA buttons (add/remove MCP, allow/deny origin, connect),
 * chapter/section navigation jump links (#quickstart, #details-allow-prefix, etc.),
 * and automatic dashboard element highlighting & expansion.
 */

import { extractHandshake } from '../web/handshake.mjs';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

  function setOpen(open) {
    drawer.setAttribute('data-open', open ? 'true' : 'false');
    drawer.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (triggerBtn) {
      triggerBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    if (open) {
      input.focus();
    }
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

  function appendMessage(role, textOrHtml, isHtml = false) {
    const div = doc.createElement('div');
    div.className = `ask-ai-msg ${role === 'user' ? 'ask-ai-msg-user' : 'ask-ai-msg-assistant'}`;
    if (isHtml) {
      div.innerHTML = textOrHtml;
    } else {
      div.textContent = textOrHtml;
    }
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function appendAssistantFormatted(markdown) {
    const html = formatAssistantMarkdown(markdown);
    return appendMessage('assistant', html, true);
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
      win.location.href = `http://127.0.0.1:${port}/admin/v1/open-dashboard?redirect=${encodeURIComponent(
        redirectUrl
      )}`;
      return;
    }

    if (actionName === 'focus') {
      const targetSelector = params.get('target');
      if (targetSelector) {
        focusAndHighlight(targetSelector);
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
        const res = await fetch(`http://127.0.0.1:${port}/admin/v1/sites`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${hs.adminKey}`
          },
          body: JSON.stringify({ url, name })
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
            ? `✅ 成功在 Dashboard 新增 MCP 站點 \`${data.site?.url || url}\`！已自動設定 URL Prefix Allowlist 與 Origin 授權。\n\n[📋 前往查看該站點](${siteId})`
            : `✅ Successfully added MCP site \`${data.site?.url || url}\`! Auto-configured URL prefix allowlist & origin.\n\n[📋 View registered site](${siteId})`
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
        focusAndHighlight(targetHash);
      }
      return;
    }

    const anchor = ev.target.closest('a');
    if (anchor) {
      const href = anchor.getAttribute('href');
      if (href && href.startsWith('#')) {
        ev.preventDefault();
        focusAndHighlight(href);
      }
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';

    appendMessage('user', prompt);
    const pendingEl = appendMessage('assistant', '…');

    // Auto-detect jump/navigation requests and trigger page navigation immediately
    if (/(?:跳轉|前往|打開|跳到|查看|jump to|go to|open)/i.test(prompt)) {
      if (/(?:quickstart|快速上手)/i.test(prompt)) {
        focusAndHighlight('#quickstart');
      } else if (/(?:allowlist|白名單|prefix)/i.test(prompt)) {
        focusAndHighlight('#details-allow-prefix');
      } else if (/(?:origin|來源)/i.test(prompt)) {
        focusAndHighlight('#details-allowed-origins');
      } else if (/(?:sites?|mcp|站點)/i.test(prompt)) {
        focusAndHighlight('#form-add-site');
      } else if (/(?:key|金鑰|rotate)/i.test(prompt)) {
        focusAndHighlight('#details-key-mgmt');
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
        pendingEl.innerHTML = formatAssistantMarkdown(
          (data && data.error && (data.error.message || data.error)) ||
            `HTTP ${res.status}: Origin not authorized on /v1. Run: \`npx ai-proxy allow-origin ${win.location.origin}\``
        );
        return;
      }

      const content =
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;

      pendingEl.innerHTML = formatAssistantMarkdown(content || JSON.stringify(data));
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch {
      pendingEl.innerHTML = formatAssistantMarkdown(
        lang === 'zh-TW'
          ? '無法連線至本機 ai-proxy (/v1)。請確認已啟動 `npx ai-proxy serve` 並允許此 Origin。\n\n[🔌 接上本機 ai-proxy (Connect)](action:connect)'
          : 'Could not reach local ai-proxy (/v1). Ensure `npx ai-proxy serve` is running and this Origin is allowed.\n\n[🔌 Connect to local ai-proxy](action:connect)'
      );
    }
  });

  return { setOpen, focusAndHighlight, triggerDashboardRefresh };
}
