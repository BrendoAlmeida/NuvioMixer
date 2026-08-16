const DEFAULT_API_BASE = 'https://api.torbox.app/v1/api';
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_MAX_WAIT_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WEB_DOWNLOAD_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_WEB_DOWNLOAD_CACHE_LIMIT = 64;
const PAGE_SIZE = 1_000;
const sharedWebDownloadCache = new Map();

function apiId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function hashKey(value) {
  return String(value || '').trim().toLowerCase();
}

function basename(value) {
  return String(value || '').replace(/\\/g, '/').split('/').pop().trim().toLowerCase();
}

function hasValue(value) {
  return Boolean(value) && (typeof value !== 'object' || Object.keys(value).length > 0);
}

/**
 * WebDL receives only `link` in the official API. Any source that depends on
 * request state must stay in the Mixer, where FFmpeg can send that state.
 */
export function hasPreservedRequestState(source) {
  if (!source || typeof source !== 'object') return false;
  const proxyHeaders = source.behaviorHints?.proxyHeaders?.request || source.proxyHeaders?.request;
  if ([source.headers, proxyHeaders].some(hasValue)) return true;
  return ['cookies', 'cookie', 'referer', 'referrer', 'origin', 'userAgent', 'user_agent', 'user-agent'].some((field) => hasValue(source[field]));
}

function normalizedHost(value) {
  return String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
}

function isPrivateOrSpecialIpv4(hostname) {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  const [first, second, third] = octets;
  return first === 0
    || first === 10
    || first === 127
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 169 && second === 254)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && (second === 0 || second === 168))
    || (first === 198 && (second === 18 || second === 19 || second === 51))
    || (first === 203 && second === 0 && third === 113)
    || first >= 224;
}

function isPrivateOrSpecialIpv6(hostname) {
  const host = normalizedHost(hostname);
  const mappedIpv4 = /(?:^|:)ffff:([0-9.]+)$/i.exec(host)?.[1];
  if (mappedIpv4 && isPrivateOrSpecialIpv4(mappedIpv4)) return true;
  return host === '::'
    || host === '::1'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || /^fe[89ab]/.test(host)
    || host.startsWith('ff')
    || host.startsWith('2001:db8:');
}

/**
 * This is deliberately stricter than the Mixer URL policy: WebDL is an
 * external request, so private/LAN and credential-bearing URLs never qualify.
 */
export function isPublicWebDownloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password) return false;
  const hostname = normalizedHost(url.hostname);
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) return false;
  return !isPrivateOrSpecialIpv4(hostname) && !isPrivateOrSpecialIpv6(hostname);
}

export function isHlsOrDashPlaylist(value) {
  try {
    const url = new URL(value);
    if (/\.(?:m3u8|mpd)$/i.test(url.pathname)) return true;
    return [...url.searchParams.entries()].some(([key, entry]) => /(?:format|type|extension|ext|manifest|playlist)/i.test(key) && /^(?:m3u8|mpd|hls|dash)$/i.test(entry));
  } catch {
    return true;
  }
}

function isDebridHost(hostname) {
  return hostname === 'torbox.app'
    || hostname.endsWith('.torbox.app')
    || /(?:^|\.)(?:real-debrid|alldebrid|premiumize)(?:\.|$)/i.test(hostname);
}

export function hasPreResolvedMarker(source) {
  const label = [source?.sourceAddonId, source?.sourceAddonName, source?.addonId, source?.addonName, source?.name, source?.title]
    .filter((value) => typeof value === 'string')
    .join(' ');
  return /\b(?:torbox|debrid|real[- ]?debrid|all[- ]?debrid|premiumize)\b/i.test(label)
    || (/torrentio/i.test(label) && /\b(?:tb|torbox)\b/i.test(label));
}

/**
 * Shared by stremio.js and the resolver so future callers cannot bypass the
 * WebDL safety boundary. Existing debrid/Torbox streams pass through unchanged.
 */
export function canUseWebDownload(source) {
  if (!source || source.kind !== 'url' || typeof source.url !== 'string') return false;
  let hostname = '';
  try { hostname = normalizedHost(new URL(source.url).hostname); } catch { return false; }
  return !hasPreservedRequestState(source)
    && isPublicWebDownloadUrl(source.url)
    && !isHlsOrDashPlaylist(source.url)
    && !isDebridHost(hostname)
    && !hasPreResolvedMarker(source);
}

function formatProgress(item) {
  const progress = Number(item?.progress);
  if (Number.isFinite(progress)) return `${Math.max(0, Math.min(100, progress)).toFixed(progress % 1 ? 1 : 0)}%`;
  return item?.download_state ? String(item.download_state) : 'indisponível';
}

function sleepFor(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listItems(data) {
  if (Array.isArray(data)) return data;
  return data && typeof data === 'object' ? [data] : [];
}

function readyDownload(item) {
  return Boolean(item?.download_finished && item?.download_present && Array.isArray(item.files) && item.files.length);
}

function decodedVariants(value) {
  const variants = new Set([String(value)]);
  let decoded = String(value);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      variants.add(next);
      decoded = next;
    } catch {
      break;
    }
  }
  return variants;
}

function containsSecret(value, token) {
  const candidateVariants = decodedVariants(value);
  const tokenVariants = decodedVariants(token);
  tokenVariants.add(encodeURIComponent(token));
  tokenVariants.add(new URLSearchParams({ token }).get('token'));
  return [...candidateVariants].some((candidate) => [...tokenVariants].some((secret) => secret && candidate.includes(secret)));
}

function outputUrl(value, apiKey) {
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('Torbox não retornou uma URL CDN reproduzível.'); }
  if (!['https:', 'http:'].includes(url.protocol) || containsSecret(url.toString(), apiKey)) throw new Error('Torbox não retornou uma URL CDN reproduzível.');
  return url.toString();
}

function fileFor(source, files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error('Torbox não informou arquivos disponíveis para esta fonte.');
  let urlFilename = '';
  if (!source.filename && source.kind === 'url') {
    try { urlFilename = new URL(source.url).pathname; } catch { /* The URL was already checked by the caller. */ }
  }
  const requestedName = basename(source.filename || urlFilename);
  if (requestedName) {
    const exact = files.filter((file) => basename(file?.name) === requestedName && apiId(file?.id) !== null);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) throw new Error(`Torbox encontrou mais de um arquivo com o nome '${source.filename}'.`);
  }

  // Torbox documents files[].id, not a Stremio fileIdx mapping. Retain fileIdx
  // only as the compatibility fallback when an exact filename is unavailable.
  const index = Number(source.fileIdx);
  if (Number.isInteger(index) && index >= 0 && index < files.length && apiId(files[index]?.id) !== null) return files[index];

  const nameHint = requestedName ? ` '${source.filename}'` : '';
  throw new Error(`Torbox não encontrou o arquivo${nameHint}; o fileIdx ${Number.isFinite(index) ? index : 'ausente'} não corresponde a um arquivo disponível.`);
}

/**
 * Produz um magnet v1 a partir do infoHash e dos hints `tracker:` do Stream Object.
 * DHT não é incluído: o formato de magnet aceito pelo Torbox só precisa do hash e
 * trackers HTTP/UDP são os únicos hints documentados pelo contrato Stremio.
 */
export function buildMagnet(source) {
  const infoHash = String(source?.infoHash || '').trim();
  if (!/^(?:[a-fA-F0-9]{40}|[a-zA-Z2-7]{32})$/.test(infoHash)) throw new Error('Torbox requer um infoHash BitTorrent v1 válido.');

  const params = new URLSearchParams({ xt: `urn:btih:${infoHash}` });
  for (const hint of Array.isArray(source?.sources) ? source.sources : []) {
    if (typeof hint !== 'string' || !hint.startsWith('tracker:')) continue;
    const tracker = hint.slice('tracker:'.length);
    try {
      const url = new URL(tracker);
      if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'udp:') params.append('tr', tracker);
    } catch { /* Hints inválidos não impedem que o infoHash seja resolvido. */ }
  }
  return `magnet:?${params.toString()}`;
}

// Contrato: https://api.torbox.app/openapi.json (torrents/mylist, createtorrent,
// requestdl e os equivalentes webdl; requestdl exige redirect=false).
export function createTorboxResolver({
  apiKey,
  apiBase = DEFAULT_API_BASE,
  fetchImpl = globalThis.fetch,
  sleep = sleepFor,
  now = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxWaitMs = DEFAULT_MAX_WAIT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  webDownloadCache = sharedWebDownloadCache,
  webDownloadCacheTtlMs = DEFAULT_WEB_DOWNLOAD_CACHE_TTL_MS,
  webDownloadCacheLimit = DEFAULT_WEB_DOWNLOAD_CACHE_LIMIT
} = {}) {
  const token = typeof apiKey === 'string' ? apiKey.trim() : '';
  if (!token) throw new Error('A chave de API do Torbox é obrigatória.');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch não está disponível para o resolvedor Torbox.');
  if (!(webDownloadCache instanceof Map)) throw new Error('O cache de WebDL deve ser um Map.');

  const root = new URL(`${String(apiBase).replace(/\/$/, '')}/`);
  const timeoutMs = positiveNumber(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
  const cacheTtlMs = positiveNumber(webDownloadCacheTtlMs, DEFAULT_WEB_DOWNLOAD_CACHE_TTL_MS);
  const cacheLimit = Math.max(1, Math.floor(positiveNumber(webDownloadCacheLimit, DEFAULT_WEB_DOWNLOAD_CACHE_LIMIT)));
  const cacheNamespace = `${root.toString()}\u0000${token}\u0000`;

  function endpoint(path, query = {}) {
    const url = new URL(path, root);
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    return url;
  }

  async function request(operation, path, { method = 'GET', query, headers, body, authorized = true } = {}) {
    let response;
    try {
      response = await fetchImpl(endpoint(path, query), {
        method,
        headers: { ...(authorized ? { authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new Error(`Torbox não pôde ser contatado durante ${operation}.`);
    }
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.success === false) throw new Error(`Torbox recusou ${operation} (HTTP ${response.status}).`);
    return payload?.data;
  }

  async function listTorrents(query = {}) {
    return listItems(await request('a consulta de torrents', 'torrents/mylist', { query }));
  }

  async function torrentById(torrentId) {
    const items = await listTorrents({ id: torrentId, bypass_cache: true });
    const torrent = items.find((item) => apiId(item?.id) === torrentId) || items[0];
    if (!torrent) throw new Error('Torbox não localizou o torrent solicitado.');
    return torrent;
  }

  async function existingTorrent(infoHash) {
    for (let offset = 0; offset < 100_000; offset += PAGE_SIZE) {
      const page = await listTorrents({ offset, limit: PAGE_SIZE });
      const match = page.find((item) => hashKey(item?.hash) === hashKey(infoHash));
      if (match) return match;
      if (page.length < PAGE_SIZE) return null;
    }
    throw new Error('Torbox possui torrents demais para localizar este infoHash com segurança.');
  }

  async function createTorrent(source) {
    const form = new FormData();
    form.set('magnet', buildMagnet(source));
    const data = await request('a criação do torrent', 'torrents/createtorrent', { method: 'POST', body: form });
    const torrentId = apiId(data?.torrent_id);
    if (torrentId === null) throw new Error('Torbox aceitou o torrent, mas não retornou um torrent_id utilizável.');
    return torrentId;
  }

  async function waitForTorrent(torrentId) {
    const deadline = now() + Math.max(0, Number(maxWaitMs) || 0);
    let last;
    do {
      last = await torrentById(torrentId);
      if (readyDownload(last)) return last;
      if (now() >= deadline) {
        if (last?.download_finished && last?.download_present && (!Array.isArray(last.files) || last.files.length === 0)) throw new Error('Torbox concluiu o torrent, mas não informou arquivos disponíveis.');
        throw new Error(`Torbox ainda está preparando o torrent. Progresso: ${formatProgress(last)}. Tente novamente quando o download estiver concluído.`);
      }
      await sleep(Math.max(0, Number(pollIntervalMs) || 0));
    } while (true);
  }

  async function requestDownload(kind, idName, itemId, fileId) {
    const data = await request('a URL de reprodução', `${kind}/requestdl`, {
      query: { token, [idName]: itemId, file_id: fileId, redirect: false },
      authorized: false
    });
    return outputUrl(data, token);
  }

  async function resolveTorrent(source) {
    if (!source || source.kind !== 'torrent') throw new Error('Torbox só pode resolver fontes torrent nesta operação.');
    const existing = await existingTorrent(source.infoHash);
    const torrentId = apiId(existing?.id) ?? await createTorrent(source);
    const torrent = await waitForTorrent(torrentId);
    const file = fileFor(source, torrent.files);
    const url = await requestDownload('torrents', 'torrent_id', torrentId, apiId(file.id));
    return { ...source, kind: 'url', url, headers: {} };
  }

  async function listWebDownloads(query = {}) {
    return listItems(await request('a consulta de downloads web', 'webdl/mylist', { query }));
  }

  async function webDownloadById(webId) {
    const items = await listWebDownloads({ id: webId, bypass_cache: true });
    const download = items.find((item) => apiId(item?.id) === webId) || items[0];
    if (!download) throw new Error('Torbox não localizou o download web solicitado.');
    return download;
  }

  async function waitForWebDownload(webId) {
    const deadline = now() + Math.max(0, Number(maxWaitMs) || 0);
    let last;
    do {
      last = await webDownloadById(webId);
      if (readyDownload(last)) return last;
      if (now() >= deadline) {
        if (last?.download_finished && last?.download_present && (!Array.isArray(last.files) || last.files.length === 0)) throw new Error('Torbox concluiu o download web, mas não informou arquivos disponíveis.');
        throw new Error(`Torbox ainda está preparando o download web. Progresso: ${formatProgress(last)}. Tente novamente quando o download estiver concluído.`);
      }
      await sleep(Math.max(0, Number(pollIntervalMs) || 0));
    } while (true);
  }

  function evictExpiredWebDownloads(timestamp) {
    for (const [key, entry] of webDownloadCache) if (entry.expiresAt <= timestamp) webDownloadCache.delete(key);
    while (webDownloadCache.size >= cacheLimit) webDownloadCache.delete(webDownloadCache.keys().next().value);
  }

  function cachedWebDownload(directUrl, resolve) {
    const key = `${cacheNamespace}${directUrl}`;
    const timestamp = now();
    const current = webDownloadCache.get(key);
    if (current && current.expiresAt > timestamp) return current.promise;
    if (current) webDownloadCache.delete(key);
    evictExpiredWebDownloads(timestamp);

    const entry = { expiresAt: timestamp + cacheTtlMs, promise: null };
    entry.promise = Promise.resolve()
      .then(resolve)
      .then((url) => {
        if (webDownloadCache.get(key) === entry) entry.expiresAt = now() + cacheTtlMs;
        return url;
      }, (error) => {
        if (webDownloadCache.get(key) === entry) webDownloadCache.delete(key);
        throw error;
      });
    webDownloadCache.set(key, entry);
    return entry.promise;
  }

  async function resolveWebDownload(source, { requested = false } = {}) {
    if (!requested) return source;
    if (!canUseWebDownload(source)) throw new Error('Torbox WebDL só aceita URLs HTTP(S) públicas de arquivo, sem cabeçalhos, cookies ou estado de requisição e que não sejam playlists HLS/DASH.');
    const directUrl = new URL(source.url).toString();
    const url = await cachedWebDownload(directUrl, async () => {
      const form = new URLSearchParams({ link: directUrl });
      const data = await request('a criação do download web', 'webdl/createwebdownload', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form
      });
      const webId = apiId(data?.webdownload_id ?? data?.web_id ?? data?.id);
      if (webId === null) throw new Error('Torbox aceitou o download web, mas não retornou um identificador utilizável.');
      const download = await waitForWebDownload(webId);
      const file = fileFor(source, download.files);
      return requestDownload('webdl', 'web_id', webId, apiId(file.id));
    });
    return { ...source, url, headers: {} };
  }

  return { resolveTorrent, resolveWebDownload };
}
