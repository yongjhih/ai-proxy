/**
 * Lightweight, zero-dependency Prism/Primer-style syntax highlighter for shell, bash, json, and js.
 * Works seamlessly in both browser and static rendering without external dependencies.
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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
  // If whole line or trailing part has comment
  const commentIndex = line.indexOf('#');
  if (commentIndex === 0) {
    return `<span class="syn-comment">${escapeHtml(line)}</span>`;
  }

  let codePart = line;
  let commentPart = '';
  if (commentIndex > 0 && /\s/.test(line[commentIndex - 1])) {
    codePart = line.slice(0, commentIndex);
    commentPart = `<span class="syn-comment">${escapeHtml(line.slice(commentIndex))}</span>`;
  }

  // Tokenize codePart
  let out = escapeHtml(codePart);

  // Highlighting flags like --name, --port, -p, etc.
  out = out.replace(/(--[a-zA-Z0-9_-]+|-[a-zA-Z0-9])/g, '<span class="syn-flag">$1</span>');

  // Command verbs: npx, node, ai-proxy, ai-proxy-docker, docker, claude, git, npm
  out = out.replace(
    /\b(npx|node|ai-proxy-docker|ai-proxy|docker-wrapper|docker|claude|git|npm)\b/g,
    '<span class="syn-cmd">$1</span>'
  );

  // Subcommands: serve, add, remove, allow, allow-origin, deny, sites, doctor, open, keys, rotate, vendor, install, devcontainer, run
  out = out.replace(
    /\b(serve|add|remove|allow|allow-origin|deny|sites|doctor|open|keys|rotate|vendor|install|devcontainer|init|up|exec|run)\b/g,
    '<span class="syn-subcmd">$1</span>'
  );

  // URLs
  out = out.replace(
    /(https?:\/\/[^\s"'<>]+)/g,
    '<span class="syn-url">$1</span>'
  );

  return out + commentPart;
}

function highlightJsonLine(line) {
  let out = escapeHtml(line);
  // Keys: "key":
  out = out.replace(/(&quot;[^&]+&quot;)(\s*:)/g, '<span class="syn-key">$1</span>$2');
  // Strings: : "val"
  out = out.replace(/(:?\s*)(&quot;[^&]*&quot;)/g, '$1<span class="syn-string">$2</span>');
  // Numbers / Booleans
  out = out.replace(/\b(true|false|null)\b/g, '<span class="syn-keyword">$1</span>');
  out = out.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="syn-num">$1</span>');
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
