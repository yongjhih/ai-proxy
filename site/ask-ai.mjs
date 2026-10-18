/**
 * "Ask AI" slide-over sidebar component powered by local /v1/chat/completions.
 */

import { extractHandshake } from '../web/handshake.mjs';
import { t } from './i18n.mjs';

export function initAskAiDrawer({ lang = 'en', win = globalThis.window } = {}) {
  const doc = win && win.document;
  if (!doc) return null;

  const { mcpPort } = extractHandshake(win);
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

  function appendMessage(role, text) {
    const div = doc.createElement('div');
    div.className = `ask-ai-msg ${role === 'user' ? 'ask-ai-msg-user' : 'ask-ai-msg-assistant'}`;
    div.textContent = text;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const prompt = input.value.trim();
    if (!prompt) return;
    input.value = '';

    appendMessage('user', prompt);
    const pendingEl = appendMessage('assistant', '...');

    try {
      const port = Number.parseInt(win.location.port || '', 10) || mcpPort || 8788;
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'local-default',
          messages: [
            {
              role: 'system',
              content:
                'You are the MCP Pages & ai-proxy documentation assistant. Answer concisely.'
            },
            { role: 'user', content: prompt }
          ],
          stream: false
        })
      });

      const data = await res.json();
      if (!res.ok) {
        pendingEl.textContent =
          (data && data.error && (data.error.message || data.error)) ||
          `HTTP ${res.status}: Origin not authorized on /v1. Run: npx ai-proxy allow-origin ${win.location.origin}`;
        return;
      }

      const content =
        data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content;
      pendingEl.textContent = content || JSON.stringify(data);
    } catch {
      pendingEl.textContent =
        lang === 'zh-TW'
          ? '無法連線至本機 ai-proxy (/v1)。請確認已啟動 `npx ai-proxy serve` 並允許此 Origin。'
          : 'Could not reach local ai-proxy (/v1). Ensure `npx ai-proxy serve` is running and this Origin is allowed.';
    }
  });

  return { setOpen };
}
