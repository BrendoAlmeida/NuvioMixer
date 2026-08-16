import { config } from './config.js';

function privateAddress(hostname) {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' || normalized.endsWith('.local') || /^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(normalized) || normalized === '::1';
}

export function assertSourceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('URL de origem inválida.'); }
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('A origem deve usar HTTP(S).');
  if (url.protocol === 'http:' && !config.allowInsecureHttp) throw new Error('HTTP inseguro está desabilitado.');
  if (privateAddress(url.hostname) && !config.allowPrivateNetwork) throw new Error('Acesso à rede privada está desabilitado.');
  return url;
}

export async function fetchJson(url, options = {}) {
  assertSourceUrl(url);
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(options.timeoutMs || 15000), headers: options.headers });
  if (!response.ok) throw new Error(`A origem respondeu HTTP ${response.status}.`);
  return response.json();
}

export async function importManifest(manifestUrl) {
  const manifest = await fetchJson(manifestUrl);
  for (const field of ['id', 'name', 'version', 'resources', 'types']) if (!manifest[field]) throw new Error(`Manifest inválido: campo '${field}' ausente.`);
  const resources = manifest.resources.map((resource) => typeof resource === 'string' ? resource : resource.name);
  if (!resources.includes('stream')) throw new Error('O addon não declara o recurso stream.');
  return { name: manifest.name, manifestUrl, transportUrl: manifestUrl, manifest };
}

function streamEndpoint(addon, type, id) {
  const root = addon.transportUrl.replace(/\/manifest\.json(?:\?.*)?$/, '').replace(/\/$/, '');
  return `${root}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
}

export function normalizeStream(stream, addon) {
  const proxyHeaders = stream.behaviorHints?.proxyHeaders?.request || stream.headers || {};
  if (stream.url) return {
    kind: 'url', name: stream.name || addon.name, title: stream.description || stream.title || stream.name || addon.name,
    url: stream.url, headers: proxyHeaders, filename: stream.behaviorHints?.filename || stream.filename || null,
    quality: stream.quality || null, sourceAddonId: addon.id, sourceAddonName: addon.name
  };
  if (stream.infoHash) return {
    kind: 'torrent', name: stream.name || addon.name, title: stream.description || stream.title || stream.name || addon.name,
    infoHash: stream.infoHash, fileIdx: Number(stream.fileIdx || 0), sources: stream.sources || [],
    quality: stream.quality || null, sourceAddonId: addon.id, sourceAddonName: addon.name
  };
  return null;
}

export async function getStreams(addon, type, id) {
  const response = await fetchJson(streamEndpoint(addon, type, id));
  if (!Array.isArray(response.streams)) throw new Error(`${addon.name} retornou uma resposta de streams inválida.`);
  return response.streams.map((stream) => normalizeStream(stream, addon)).filter(Boolean);
}

export async function resolveTorrent(source) {
  if (!config.torrentGatewayUrl) throw new Error('Esta fonte é torrent. Configure TORRENT_GATEWAY_URL para disponibilizá-la sem alterar o vídeo.');
  const url = new URL('/resolve', config.torrentGatewayUrl);
  url.searchParams.set('infoHash', source.infoHash);
  url.searchParams.set('fileIdx', String(source.fileIdx));
  const result = await fetchJson(url.toString());
  if (!result.url) throw new Error('O gateway de torrent não devolveu uma URL reproduzível.');
  return { ...source, kind: 'url', url: result.url, headers: result.headers || {} };
}

function errorMessage(payload, fallback) {
  return payload?.msg || payload?.error_description || payload?.message || payload?.error || fallback;
}

async function responseJson(response) {
  return response.json().catch(() => null);
}

function nuvioHeaders(publishableKey, accessToken = null) {
  return {
    apikey: publishableKey,
    authorization: `Bearer ${accessToken || publishableKey}`,
    'user-agent': 'NuvioMixer/0.1.0',
  };
}

export async function discoverNuvioServer(input = config.nuvioApiBase) {
  const base = assertSourceUrl(input).toString().replace(/\/$/, '');
  const discoveryUrl = new URL('/.well-known/nuvio', base).toString();
  const response = await fetch(discoveryUrl, { headers: { accept: 'application/json', 'user-agent': 'NuvioMixer/0.1.0' }, signal: AbortSignal.timeout(15000) });
  const document = await responseJson(response);
  if (!response.ok) throw new Error(`Não foi possível descobrir o servidor Nuvio (HTTP ${response.status}).`);
  if (document?.version !== 1 || String(document?.service).toLowerCase() !== 'nuvio' || !document?.capabilities?.email_password_auth || !document?.publishable_key || !document?.backend_url) {
    throw new Error('O servidor informado não publicou uma configuração Nuvio compatível com login por e-mail.');
  }
  assertSourceUrl(document.backend_url);
  return { apiBase: String(document.backend_url).replace(/\/$/, ''), publishableKey: document.publishable_key };
}

export async function connectNuvio({ apiBase = config.nuvioApiBase, email, password }) {
  if (!email || !password) throw new Error('E-mail e senha Nuvio são obrigatórios.');
  const discovery = await discoverNuvioServer(apiBase);
  const response = await fetch(`${discovery.apiBase}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { ...nuvioHeaders(discovery.publishableKey), 'content-type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password }),
    signal: AbortSignal.timeout(15000)
  });
  const token = await responseJson(response);
  if (!response.ok) throw new Error(`Login Nuvio recusado: ${errorMessage(token, `HTTP ${response.status}`)}`);
  if (!token?.access_token || !token?.refresh_token) throw new Error('O Nuvio não retornou uma sessão renovável.');
  const validation = await fetch(`${discovery.apiBase}/auth/v1/user`, { headers: nuvioHeaders(discovery.publishableKey, token.access_token), signal: AbortSignal.timeout(15000) });
  if (!validation.ok) throw new Error('O Nuvio aceitou o login, mas a sessão não pôde ser validada.');
  const connection = { ...discovery, accessToken: token.access_token, refreshToken: token.refresh_token };
  return { ...connection, profiles: await listNuvioProfiles(connection) };
}

export async function refreshNuvioConnection(connection) {
  const response = await fetch(`${connection.apiBase}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST', headers: { ...nuvioHeaders(connection.publishableKey), 'content-type': 'application/json' },
    body: JSON.stringify({ refresh_token: connection.refreshToken }), signal: AbortSignal.timeout(15000)
  });
  const token = await responseJson(response);
  if (!response.ok || !token?.access_token) throw new Error(`A sessão Nuvio expirou: ${errorMessage(token, 'reconecte a conta.')}`);
  return { ...connection, accessToken: token.access_token, refreshToken: token.refresh_token || connection.refreshToken };
}

async function nuvioRequest(connection, path, options = {}) {
  const request = () => fetch(`${connection.apiBase}${path}`, { ...options, headers: { ...nuvioHeaders(connection.publishableKey, connection.accessToken), ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) });
  let response = await request();
  if (response.status !== 401) return { response, connection };
  const refreshed = await refreshNuvioConnection(connection);
  response = await fetch(`${refreshed.apiBase}${path}`, { ...options, headers: { ...nuvioHeaders(refreshed.publishableKey, refreshed.accessToken), ...(options.headers || {}) }, signal: AbortSignal.timeout(15000) });
  return { response, connection: refreshed };
}

export async function listNuvioProfiles(connection) {
  const { response } = await nuvioRequest(connection, '/rest/v1/rpc/sync_pull_profiles', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const profiles = await responseJson(response);
  if (!response.ok || !Array.isArray(profiles)) throw new Error(`Não foi possível listar perfis Nuvio: ${errorMessage(profiles, `HTTP ${response.status}`)}`);
  return profiles.map((profile) => ({ profileId: Number(profile.profile_index), name: profile.name || `Perfil ${profile.profile_index}` })).filter((profile) => Number.isInteger(profile.profileId));
}

export async function listNuvioAddons(connection, profileId) {
  if (!Number.isInteger(Number(profileId))) throw new Error('Selecione um perfil Nuvio válido.');
  const { response, connection: refreshed } = await nuvioRequest(connection, `/rest/v1/addons?select=url,name,enabled,sort_order&profile_id=eq.${encodeURIComponent(profileId)}&order=sort_order.asc`);
  const records = await responseJson(response);
  if (!response.ok || !Array.isArray(records)) throw new Error(`Não foi possível listar addons no Nuvio: ${errorMessage(records, `HTTP ${response.status}`)}`);
  return { connection: refreshed, addons: records.map((item) => item.url).filter(Boolean) };
}
