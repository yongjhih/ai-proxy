/**
 * Robust token-based syntax highlighter for shell/bash and json.
 * Uses lexical tokenization instead of cascading regular expressions to eliminate partial-word replacements.
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const COMMANDS = new Set([
  'ai-proxy',
  'ai-proxy-docker',
  'docker-wrapper',
  'claude',
  'npx',
  'node',
  'docker',
  'git',
  'npm'
]);

const SUBCOMMANDS = new Set([
  'serve',
  'add',
  'remove',
  'allow',
  'allow-origin',
  'deny',
  'sites',
  'doctor',
  'open',
  'keys',
  'rotate',
  'vendor',
  'install',
  'devcontainer',
  'init',
  'up',
  'exec',
  'run'
]);

export function highlightCode(code, lang = 'bash') {
  const normalizedLang = (lang || 'bash').toLowerCase().replace(/^lang-/, '');
  const lines = code.split('\n');

  return lines
    .map((line) => {
      if (normalizedLang === 'json') {
        return highlightJsonLine(line);
      }
      return highlightShellLine(line);
    })
    .join('\n');
}

function highlightShellLine(line) {
  // If whole line is a comment
  if (line.trim().startsWith('#')) {
    return `<span class="token comment syn-comment">${escapeHtml(line)}</span>`;
  }

  // Tokenize line by splitting whitespace, strings, URLs, flags, and words
  const tokenRegex =
    /(\s+|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|https?:\/\/[^\s]+|--[a-zA-Z0-9_-]+|-[a-zA-Z0-9]|[a-zA-Z0-9_.-]+|[^\s\w])/g;
  let match;
  let html = '';

  while ((match = tokenRegex.exec(line)) !== null) {
    const token = match[0];

    if (/^\s+$/.test(token)) {
      html += token;
      continue;
    }

    if (token.startsWith('#')) {
      html += `<span class="token comment syn-comment">${escapeHtml(token)}</span>`;
      continue;
    }

    if (
      (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
      (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
    ) {
      html += `<span class="token string syn-string">${escapeHtml(token)}</span>`;
      continue;
    }

    if (token.startsWith('http://') || token.startsWith('https://')) {
      html += `<span class="token url syn-url">${escapeHtml(token)}</span>`;
      continue;
    }

    if (token.startsWith('-')) {
      html += `<span class="token parameter variable syn-flag">${escapeHtml(token)}</span>`;
      continue;
    }

    if (COMMANDS.has(token)) {
      html += `<span class="token cli-tool function syn-cmd">${escapeHtml(token)}</span>`;
      continue;
    }

    if (SUBCOMMANDS.has(token)) {
      html += `<span class="token cli-subcommand property syn-subcmd">${escapeHtml(token)}</span>`;
      continue;
    }

    if (/^\d+$/.test(token)) {
      html += `<span class="token number syn-num">${escapeHtml(token)}</span>`;
      continue;
    }

    if (/^[^\s\w]$/.test(token)) {
      html += `<span class="token punctuation">${escapeHtml(token)}</span>`;
      continue;
    }

    // Default plain text
    html += escapeHtml(token);
  }

  return html;
}

function highlightJsonLine(line) {
  let out = escapeHtml(line);
  // Keys: "key":
  out = out.replace(/(&quot;[^&]+&quot;)(\s*:)/g, '<span class="token property syn-key">$1</span>$2');
  // Strings: : "val"
  out = out.replace(/(:?\s*)(&quot;[^&]*&quot;)/g, '$1<span class="token string syn-string">$2</span>');
  // Numbers / Booleans
  out = out.replace(/\b(true|false|null)\b/g, '<span class="token boolean syn-keyword">$1</span>');
  out = out.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="token number syn-num">$1</span>');
  return out;
}

export function highlightAllCodeBlocks(root = globalThis.document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const blocks = root.querySelectorAll('pre code, pre[data-lang]');
  for (const block of blocks) {
    if (block.dataset.highlighted === 'true') continue;
    const raw = block.textContent;
    const lang = block.className || block.getAttribute('data-lang') || 'bash';
    block.innerHTML = highlightCode(raw, lang);
    block.dataset.highlighted = 'true';
  }
}
