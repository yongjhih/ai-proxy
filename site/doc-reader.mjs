/**
 * SPA Documentation Reader with pushState navigation, Markdown-to-HTML rendering,
 * runtime base URL substitution (https://<host>/<org>/<repo>/), and Mermaid diagram rendering.
 */

import { highlightCode } from './syntax.mjs';

const VALID_DOCS = new Set([
  'index',
  'spec',
  'protocol',
  'security',
  'zh-TW/index',
  'zh-TW/spec',
  'zh-TW/protocol',
  'zh-TW/security'
]);

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function getRuntimeSiteBaseUrl(importMetaUrl, win = globalThis.window) {
  try {
    if (importMetaUrl) {
      return new URL('../', importMetaUrl).href;
    }
  } catch {
    // fallback
  }
  if (win && win.location) {
    return new URL('./', win.location.href).href;
  }
  return 'https://example.github.io/ai-proxy/';
}

export function replaceBaseUrlPlaceholder(text, siteBaseUrl) {
  const normalizedBase = siteBaseUrl.endsWith('/') ? siteBaseUrl : `${siteBaseUrl}/`;
  return String(text).replace(/https:\/\/<host>\/<org>\/<repo>\//g, normalizedBase);
}

function renderInlineMarkdown(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

export function renderMarkdownToHtml(markdownText, siteBaseUrl) {
  const substituted = replaceBaseUrlPlaceholder(markdownText, siteBaseUrl);
  const lines = substituted.replace(/\r\n/g, '\n').split('\n');
  const html = [];
  let inCodeBlock = false;
  let codeLang = '';
  let codeLines = [];
  let inList = null; // 'ul' | 'ol'
  let inTable = false;
  let tableHeaderDone = false;

  function closeList() {
    if (inList) {
      html.push(`</${inList}>`);
      inList = null;
    }
  }

  function closeTable() {
    if (inTable) {
      html.push('</tbody></table></div>');
      inTable = false;
      tableHeaderDone = false;
    }
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.startsWith('```')) {
      closeList();
      closeTable();
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeLang = line.slice(3).trim();
        codeLines = [];
      } else {
        const rawCode = codeLines.join('\n');
        if (codeLang === 'mermaid') {
          html.push(`<div class="mermaid">${escapeHtml(rawCode)}</div>`);
        } else {
          const highlighted = highlightCode(rawCode, codeLang || 'bash');
          html.push(
            `<pre><code class="lang-${escapeHtml(codeLang || 'text')}" data-highlighted="true">${highlighted}</code></pre>`
          );
        }
        inCodeBlock = false;
        codeLang = '';
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      closeTable();
      continue;
    }

    if (trimmed === '---') {
      closeList();
      closeTable();
      html.push('<hr style="border:none;border-top:1px solid var(--border-muted);margin:1.75rem 0;" />');
      continue;
    }

    // Table row
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      closeList();
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) {
        continue;
      }
      if (!inTable) {
        inTable = true;
        tableHeaderDone = false;
        html.push('<div class="data-table-wrap"><table class="data-table">');
      }
      if (!tableHeaderDone) {
        html.push(
          `<thead><tr>${cells.map((c) => `<th>${renderInlineMarkdown(c)}</th>`).join('')}</tr></thead><tbody>`
        );
        tableHeaderDone = true;
      } else {
        html.push(`<tr>${cells.map((c) => `<td>${renderInlineMarkdown(c)}</td>`).join('')}</tr>`);
      }
      continue;
    } else {
      closeTable();
    }

    // Headings
    const headingMatch = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (headingMatch) {
      closeList();
      const level = headingMatch[1].length;
      html.push(`<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      continue;
    }

    // Blockquote
    if (trimmed.startsWith('>')) {
      closeList();
      const quoteContent = trimmed.replace(/^>\s?/, '');
      html.push(`<div class="flash-banner">${renderInlineMarkdown(quoteContent)}</div>`);
      continue;
    }

    // Unordered list
    const ulMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (ulMatch) {
      if (inList !== 'ul') {
        closeList();
        inList = 'ul';
        html.push('<ul>');
      }
      html.push(`<li>${renderInlineMarkdown(ulMatch[1])}</li>`);
      continue;
    }

    // Ordered list
    const olMatch = /^\d+\.\s+(.+)$/.exec(trimmed);
    if (olMatch) {
      if (inList !== 'ol') {
        closeList();
        inList = 'ol';
        html.push('<ol>');
      }
      html.push(`<li>${renderInlineMarkdown(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  closeList();
  closeTable();
  return html.join('\n');
}

export async function initDocReader({ win = globalThis.window, importMetaUrl = import.meta.url } = {}) {
  const doc = win && win.document;
  if (!doc) return;

  const contentEl = doc.getElementById('doc-content');
  const sidebarEl = doc.getElementById('doc-sidebar-nav');
  if (!contentEl) return;

  const siteBaseUrl = getRuntimeSiteBaseUrl(importMetaUrl, win);

  function resolveDocIdFromLocation() {
    const params = new URLSearchParams(win.location.search);
    const d = params.get('d') || 'index';
    return VALID_DOCS.has(d) ? d : 'index';
  }

  async function renderMermaidDiagrams() {
    if (typeof win.renderAiProxyMermaid === 'function') {
      await win.renderAiProxyMermaid();
      return;
    }
    if (win.mermaid && typeof win.mermaid.run === 'function') {
      try {
        await win.mermaid.run({ querySelector: '.mermaid' });
      } catch {
        // Ignore mermaid render errors in headless offline environments
      }
    }
  }

  function updateSidebarActive(docId) {
    if (!sidebarEl) return;
    for (const a of sidebarEl.querySelectorAll('a[data-doc]')) {
      const target = a.getAttribute('data-doc');
      if (target === docId) {
        a.setAttribute('aria-current', 'true');
      } else {
        a.removeAttribute('aria-current');
      }
    }
  }

  async function loadDoc(docId, { pushHistory = false } = {}) {
    const cleanId = VALID_DOCS.has(docId) ? docId : 'index';
    if (pushHistory) {
      const nextUrl = `doc?d=${encodeURIComponent(cleanId)}`;
      win.history.pushState({ ...(win.history.state || {}), docId: cleanId }, '', nextUrl);
    }
    updateSidebarActive(cleanId);

    try {
      const mdUrl = new URL(`docs/${cleanId}.md`, siteBaseUrl).href;
      const res = await fetch(mdUrl);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const mdText = await res.text();
      contentEl.innerHTML = renderMarkdownToHtml(mdText, siteBaseUrl);
      await renderMermaidDiagrams();
      interceptInternalDocLinks();
    } catch (err) {
      contentEl.innerHTML = `<div class="flash-banner flash-danger">Failed to load documentation (${escapeHtml(
        cleanId
      )}): ${escapeHtml(err.message)}</div>`;
    }
  }

  function interceptInternalDocLinks() {
    for (const link of doc.querySelectorAll('a[href^="doc?d="], a[href^="doc.html?d="]')) {
      if (link.dataset.spaBound === 'true') continue;
      link.dataset.spaBound = 'true';
      link.addEventListener('click', (ev) => {
        if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
        ev.preventDefault();
        const href = link.getAttribute('href') || '';
        const params = new URLSearchParams(href.split('?')[1] || '');
        const nextDoc = params.get('d') || 'index';
        loadDoc(nextDoc, { pushHistory: true });
      });
    }
  }

  win.addEventListener('popstate', () => {
    loadDoc(resolveDocIdFromLocation(), { pushHistory: false });
  });

  interceptInternalDocLinks();
  await loadDoc(resolveDocIdFromLocation(), { pushHistory: false });
}
