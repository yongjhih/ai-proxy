import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizePageUrl, isAllowedPageUrl } from '../web/url.mjs';

const ALLOW_TOOL_RE = /^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_-]+)$/;

export function generateSecretKey(prefix = 'mcp') {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

export function validateAllowToolSpec(spec) {
  if (typeof spec !== 'string' || !spec.trim()) {
    throw new Error('Invalid --allow-tool value: must be a non-empty string');
  }
  if (spec.includes('*')) {
    throw new Error(
      `Invalid --allow-tool "${spec}": wildcards are forbidden; name each tool individually as mcp__<server>__<tool>`
    );
  }
  const match = ALLOW_TOOL_RE.exec(spec.trim());
  if (!match) {
    throw new Error(
      `Invalid --allow-tool "${spec}": must match mcp__<server>__<tool> (whole-server grants are forbidden)`
    );
  }
  return {
    full: spec.trim(),
    server: match[1],
    tool: match[2]
  };
}

export const DEFAULT_ALLOWED_TOOLS = [
  'mcp__ai-proxy__about',
  'mcp__ai-proxy__spec',
  'mcp__ai-proxy__knowledge',
  'mcp__ai-proxy__cli_skills',
  'mcp__ai-proxy__site_tour',
  'mcp__ai-proxy__site_tools',
  'mcp__ai-proxy__sites'
];

export function deriveSiteSlug(normalizedUrl) {
  const parsed = new URL(normalizedUrl);
  if (
    (parsed.hostname === 'yongjhih.github.io' && parsed.pathname.startsWith('/ai-proxy')) ||
    ((parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      (parsed.pathname === '/mcp' || parsed.pathname === '/mcp.html'))
  ) {
    return 'ai-proxy';
  }
  const raw = `${parsed.hostname}${parsed.pathname}`
    .replace(/\/mcp(?:\.html)?$/i, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return raw || 'mcp-site';
}

export function getEquivalentPageUrls(rawUrl) {
  const normalized = normalizePageUrl(rawUrl);
  const parsed = new URL(normalized);
  const p = parsed.pathname;
  const variants = [normalized];
  if (p.endsWith('.html') && p !== '/index.html') {
    const alt = new URL(normalized);
    alt.pathname = p.slice(0, -'.html'.length) || '/';
    variants.push(alt.toString());
  } else if (p !== '/' && !p.endsWith('/')) {
    const lastSeg = p.slice(p.lastIndexOf('/') + 1);
    if (lastSeg && !lastSeg.includes('.')) {
      const alt = new URL(normalized);
      alt.pathname = `${p}.html`;
      variants.push(alt.toString());
    }
  }
  return variants;
}

export function createStore({ configDir = undefined } = {}) {
  const resolvedDir =
    configDir ||
    process.env.AI_PROXY_HOME ||
    path.join(os.homedir(), '.config', 'ai-proxy');
  const configFile = path.join(resolvedDir, 'config.json');

  let data = {
    version: 1,
    adminKey: generateSecretKey('adm'),
    allowlist: [],
    sites: {},
    allowedOrigins: [],
    openOriginMode: {
      enabled: false,
      expiresAt: null
    },
    allowedTools: [],
    allowedToolsExplicit: false
  };

  function load() {
    try {
      if (fs.existsSync(configFile)) {
        const raw = fs.readFileSync(configFile, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          const hasStoredAllowedTools = Array.isArray(parsed.allowedTools) && parsed.allowedTools.length > 0;
          data = {
            version: 1,
            adminKey:
              typeof parsed.adminKey === 'string' && parsed.adminKey
                ? parsed.adminKey
                : generateSecretKey('adm'),
            allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
            sites: parsed.sites && typeof parsed.sites === 'object' ? parsed.sites : {},
            allowedOrigins: Array.isArray(parsed.allowedOrigins) ? parsed.allowedOrigins : [],
            openOriginMode:
              parsed.openOriginMode && typeof parsed.openOriginMode === 'object'
                ? {
                    enabled: Boolean(parsed.openOriginMode.enabled),
                    expiresAt:
                      typeof parsed.openOriginMode.expiresAt === 'number'
                        ? parsed.openOriginMode.expiresAt
                        : null
                  }
                : { enabled: false, expiresAt: null },
            allowedTools: Array.isArray(parsed.allowedTools) ? parsed.allowedTools : [],
            allowedToolsExplicit: hasStoredAllowedTools
          };
        }
      } else {
        save();
      }
    } catch {
      // Keep in-memory defaults if file corrupt
    }
  }

  function save() {
    fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
    const tmpFile = `${configFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmpFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpFile, configFile);
  }

  load();

  function getAdminKey() {
    return data.adminKey;
  }

  function verifyAdminKey(token) {
    if (typeof token !== 'string' || !token) return false;
    const expected = Buffer.from(data.adminKey);
    const actual = Buffer.from(token);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  function resolveSiteKeyInStore(rawUrl) {
    const variants = getEquivalentPageUrls(rawUrl);
    for (const v of variants) {
      if (data.sites[v]) return v;
    }
    return variants[0];
  }

  function getOrCreatePageKey(rawUrl, { write = true } = {}) {
    const keyUrl = resolveSiteKeyInStore(rawUrl);
    if (!data.sites[keyUrl]) {
      data.sites[keyUrl] = {
        url: keyUrl,
        name: deriveSiteSlug(keyUrl),
        key: generateSecretKey('mcp'),
        addedAt: new Date().toISOString(),
        lastSeenAt: null,
        tools: [],
        write: write !== false
      };
      save();
    } else {
      let changed = false;
      if (!data.sites[keyUrl].key) {
        data.sites[keyUrl].key = generateSecretKey('mcp');
        changed = true;
      }
      if (data.sites[keyUrl].write === undefined) {
        data.sites[keyUrl].write = true;
        changed = true;
      }
      if (changed) save();
    }
    return data.sites[keyUrl].key;
  }

  function verifyPageKey(rawUrl, token) {
    if (typeof token !== 'string' || !token) return false;
    let keyUrl;
    try {
      keyUrl = resolveSiteKeyInStore(rawUrl);
    } catch {
      return false;
    }
    const site = data.sites[keyUrl];
    if (!site || !site.key) return false;
    const expected = Buffer.from(site.key);
    const actual = Buffer.from(token);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  }

  function allowPrefix(rawPrefix) {
    const normalized = normalizePageUrl(rawPrefix);
    if (!data.allowlist.includes(normalized)) {
      data.allowlist.push(normalized);
      save();
    }
    return [...data.allowlist];
  }

  function denyPrefix(rawPrefix) {
    const variants = getEquivalentPageUrls(rawPrefix).map((v) =>
      v.endsWith('/') ? v.slice(0, -1) : v
    );
    data.allowlist = data.allowlist.filter((item) => {
      const cleanItem = item.endsWith('/') ? item.slice(0, -1) : item;
      return !variants.includes(cleanItem);
    });
    save();
    return [...data.allowlist];
  }

  function isUrlAllowed(rawUrl) {
    try {
      const variants = getEquivalentPageUrls(rawUrl);
      return variants.some((v) => isAllowedPageUrl(v, data.allowlist));
    } catch {
      return false;
    }
  }

  function addSite({
    url,
    name = undefined,
    write = true,
    allowOrigin: shouldAllowOrigin = true,
    allowPrefix: shouldAllowPrefix = true
  }) {
    let raw = String(url || '').trim();
    try {
      const p = new URL(raw).pathname.replace(/\/+$/, '');
      if (!p.endsWith('/mcp') && !p.endsWith('.html')) {
        const u = new URL(raw);
        u.pathname = `${p}/mcp`;
        raw = u.toString();
      }
    } catch {}

    const normalized = normalizePageUrl(raw);
    const keyUrl = resolveSiteKeyInStore(normalized);
    if (shouldAllowPrefix !== false) {
      allowPrefix(normalized);
    }

    // Automatically allow directory prefix and origin if requested
    try {
      const parsed = new URL(normalized);
      if (shouldAllowOrigin !== false && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
        allowOrigin(parsed.origin);
      }
      const pathname = parsed.pathname;
      const lastSlash = pathname.lastIndexOf('/');
      if (shouldAllowPrefix !== false && lastSlash > 0) {
        const dirPrefix = `${parsed.origin}${pathname.slice(0, lastSlash + 1)}`;
        allowPrefix(dirPrefix);
      }
    } catch {}

    const key = getOrCreatePageKey(keyUrl, { write });
    data.sites[keyUrl].url = normalized;
    if (keyUrl !== normalized) {
      data.sites[normalized] = data.sites[keyUrl];
      delete data.sites[keyUrl];
    }
    if (name && typeof name === 'string') {
      data.sites[normalized].name = name.trim();
    }
    if (typeof write === 'boolean') {
      data.sites[normalized].write = write;
    } else if (data.sites[normalized].write === undefined) {
      data.sites[normalized].write = true;
    }
    save();
    return { ...data.sites[normalized], key };
  }

  function setSitePermission(rawUrl, { write = true } = {}) {
    const keyUrl = resolveSiteKeyInStore(rawUrl);
    if (!data.sites[keyUrl]) {
      throw new Error(`Site not found: ${rawUrl}`);
    }
    data.sites[keyUrl].write = Boolean(write);
    save();
    return { ...structuredClone(data.sites[keyUrl]), write: data.sites[keyUrl].write };
  }

  function removeSite(rawUrl) {
    const keyUrl = resolveSiteKeyInStore(rawUrl);
    const existing = data.sites[keyUrl] ? { ...data.sites[keyUrl] } : null;
    for (const v of getEquivalentPageUrls(rawUrl)) {
      delete data.sites[v];
    }
    denyPrefix(rawUrl);
    save();
    return existing;
  }

  function updateSiteTools(rawUrl, tools = [], title = '') {
    const keyUrl = resolveSiteKeyInStore(rawUrl);
    getOrCreatePageKey(keyUrl);
    data.sites[keyUrl].lastSeenAt = new Date().toISOString();
    if (title) {
      data.sites[keyUrl].title = title;
    }
    if (Array.isArray(tools)) {
      data.sites[keyUrl].tools = tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        annotations: {
          ...(t.annotations || {}),
          readOnlyHint: Boolean(t.annotations && t.annotations.readOnlyHint === true)
        }
      }));
    }
    save();
    return data.sites[keyUrl];
  }

  function listSites() {
    return Object.values(data.sites).map((s) => ({
      ...structuredClone(s),
      write: s.write !== false
    }));
  }

  function getSite(rawUrl) {
    try {
      const keyUrl = resolveSiteKeyInStore(rawUrl);
      if (!data.sites[keyUrl]) return null;
      const clone = structuredClone(data.sites[keyUrl]);
      clone.write = clone.write !== false;
      return clone;
    } catch {
      return null;
    }
  }

  function rotateKeys({ url = undefined, rotateAdmin = false } = {}) {
    const rotated = [];
    if (url) {
      const keyUrl = resolveSiteKeyInStore(url);
      getOrCreatePageKey(keyUrl);
      data.sites[keyUrl].key = generateSecretKey('mcp');
      rotated.push(keyUrl);
    } else if (!rotateAdmin) {
      for (const siteUrl of Object.keys(data.sites)) {
        data.sites[siteUrl].key = generateSecretKey('mcp');
        rotated.push(siteUrl);
      }
    }
    if (rotateAdmin) {
      data.adminKey = generateSecretKey('adm');
      rotated.push('admin');
    }
    save();
    return rotated;
  }

  function isOpenOriginActive() {
    if (!data.openOriginMode || !data.openOriginMode.enabled) {
      return false;
    }
    if (
      typeof data.openOriginMode.expiresAt === 'number' &&
      Date.now() > data.openOriginMode.expiresAt
    ) {
      data.openOriginMode.enabled = false;
      data.openOriginMode.expiresAt = null;
      save();
      return false;
    }
    return true;
  }

  function allowOrigin(originInput, { ttlSeconds = undefined } = {}) {
    if (originInput === '*') {
      const expiresAt =
        typeof ttlSeconds === 'number' && ttlSeconds > 0
          ? Date.now() + Math.round(ttlSeconds * 1000)
          : null;
      data.openOriginMode = {
        enabled: true,
        expiresAt
      };
      save();
      return { openOriginMode: { ...data.openOriginMode }, allowedOrigins: [...data.allowedOrigins] };
    }

    const parsed = new URL(originInput);
    const origin = parsed.origin;
    if (!data.allowedOrigins.includes(origin)) {
      data.allowedOrigins.push(origin);
      save();
    }
    return { openOriginMode: { ...data.openOriginMode }, allowedOrigins: [...data.allowedOrigins] };
  }

  function denyOrigin(originInput) {
    if (originInput === '*') {
      data.openOriginMode = { enabled: false, expiresAt: null };
      save();
      return { openOriginMode: { ...data.openOriginMode }, allowedOrigins: [...data.allowedOrigins] };
    }
    let origin = originInput;
    try {
      origin = new URL(originInput).origin;
    } catch {
      // keep raw
    }
    data.allowedOrigins = data.allowedOrigins.filter((o) => o !== origin);
    save();
    return { openOriginMode: { ...data.openOriginMode }, allowedOrigins: [...data.allowedOrigins] };
  }

  function isV1OriginAllowed(originHeader, selfOrigins = []) {
    if (!originHeader) return true; // Local CLI / non-browser request
    if (selfOrigins.includes(originHeader)) return true;
    try {
      const parsed = new URL(originHeader);
      if (
        parsed.hostname === 'localhost' ||
        parsed.hostname === '127.0.0.1' ||
        parsed.hostname === '[::1]'
      ) {
        return true;
      }
    } catch {
      return false;
    }
    if (data.allowedOrigins.includes(originHeader)) return true;
    if (isOpenOriginActive()) return true;
    return false;
  }

  function setAllowedTools(specs = []) {
    const validated = specs.map((s) => validateAllowToolSpec(s).full);
    data.allowedTools = Array.from(new Set(validated));
    data.allowedToolsExplicit = true;
    save();
    return [...data.allowedTools];
  }

  function getAllowedTools() {
    if (data.allowedToolsExplicit) {
      return [...data.allowedTools];
    }
    return data.allowedTools.length > 0 ? [...data.allowedTools] : [...DEFAULT_ALLOWED_TOOLS];
  }

  function getWarnings() {
    const warnings = [];
    if (isOpenOriginActive()) {
      const exp = data.openOriginMode.expiresAt
        ? ` (expires at ${new Date(data.openOriginMode.expiresAt).toISOString()})`
        : ' (no expiration set)';
      warnings.push(
        `WARNING: Open-origin mode ("*") is ACTIVE on /v1${exp}. Any website can send pure-chat prompts to your local model. Tools are disabled on /v1 while active.`
      );
    }
    return warnings;
  }

  function getSnapshot() {
    isOpenOriginActive();
    return {
      configDir: resolvedDir,
      configFile,
      allowlist: [...data.allowlist],
      allowedOrigins: [...data.allowedOrigins],
      openOriginMode: { ...data.openOriginMode },
      allowedTools: [...data.allowedTools],
      sites: listSites(),
      warnings: getWarnings()
    };
  }

  return {
    configDir: resolvedDir,
    configFile,
    load,
    save,
    getAdminKey,
    verifyAdminKey,
    getOrCreatePageKey,
    verifyPageKey,
    allowPrefix,
    denyPrefix,
    isUrlAllowed,
    addSite,
    setSitePermission,
    removeSite,
    updateSiteTools,
    listSites,
    getSite,
    rotateKeys,
    isOpenOriginActive,
    allowOrigin,
    denyOrigin,
    isV1OriginAllowed,
    setAllowedTools,
    getAllowedTools,
    getWarnings,
    getSnapshot
  };
}
