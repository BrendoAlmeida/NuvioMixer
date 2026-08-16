import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { config } from './config.js';
import { cleanupSessions, discardSession, ensureSession, getSessionFile, preflight, sessionStatus, shutdownSessions } from './media.js';
import { deleteAddon, deleteMix, getMix, getNuvioConnection, getNuvioConnectionInfo, hasSecret, listAddons, listMixes, saveAddon, saveMix, saveNuvioConnection, saveSecret, updateAddon } from './store.js';
import { assertSourceUrl, connectNuvio, getStreams, importManifest, listNuvioAddons } from './stremio.js';
import { getCatalogDetail, searchCatalog } from './catalog.js';
import { cancelSourceJob, createSourceJob, getSourceJob, retryableAddonIds, subscribeSourceJob } from './source-jobs.js';
import { resolveSeriesEpisode, sourceSelector } from './series.js';

const publicDir = existsSync(join(process.cwd(), 'dist', 'index.html')) ? join(process.cwd(), 'dist') : join(process.cwd(), 'public');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.m3u8': 'application/vnd.apple.mpegurl', '.m4s': 'video/iso.segment', '.mp4': 'video/mp4', '.json': 'application/json; charset=utf-8' };
const runtimeMixes = new Map();
const runtimeMixLifetimeMs = 35 * 60 * 1000;

function send(response, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  response.end(payload);
}

function fail(response, status, error) { send(response, status, { error: error instanceof Error ? error.message : String(error) }); }

async function body(request) {
  let raw = '';
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 1_000_000) throw new Error('Corpo da requisição é grande demais.');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error('JSON inválido.'); }
}

function method(request, expected) { return request.method === expected; }

function streamFile(request, response, path) {
  const stats = statSync(path);
  const contentType = mime[extname(path)] || 'application/octet-stream';
  const range = request.headers.range;
  if (!range) {
    response.writeHead(200, { 'content-type': contentType, 'content-length': stats.size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    createReadStream(path).pipe(response);
    return;
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match) return fail(response, 416, 'Range inválido.');
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : stats.size - 1;
  if (start > end || end >= stats.size) return fail(response, 416, 'Range fora do arquivo.');
  response.writeHead(206, { 'content-type': contentType, 'content-length': end - start + 1, 'content-range': `bytes ${start}-${end}/${stats.size}`, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  createReadStream(path, { start, end }).pipe(response);
}

function streamPlaylist(response, path, token) {
  const suffix = `token=${encodeURIComponent(token)}`;
  const playlist = readFileSync(path, 'utf8')
    .replace(/URI="([^"]+)"/g, (_match, resource) => `URI="${resource}${resource.includes('?') ? '&' : '?'}${suffix}"`)
    .split('\n')
    .map((line) => line && !line.startsWith('#') ? `${line}${line.includes('?') ? '&' : '?'}${suffix}` : line)
    .join('\n');
  response.writeHead(200, { 'content-type': mime['.m3u8'], 'cache-control': 'no-store' });
  response.end(playlist);
}

function sanitizeSource(source) {
  if (!source || typeof source !== 'object') throw new Error('Fonte ausente.');
  if (source.kind === 'url') {
    assertSourceUrl(source.url);
    const headers = Object.fromEntries(Object.entries(source.headers || {}).filter(([key, value]) => /^[A-Za-z0-9-]+$/.test(key) && typeof value === 'string' && !/[\r\n]/.test(value)));
    return { kind: 'url', url: source.url, headers, title: String(source.title || ''), name: String(source.name || ''), filename: source.filename || null, sourceAddonId: source.sourceAddonId || null, sourceAddonName: source.sourceAddonName || null };
  }
  if (source.kind === 'torrent' && /^[a-fA-F0-9]{40}$|^[a-zA-Z2-7]{32}$/.test(source.infoHash || '')) return { kind: 'torrent', infoHash: source.infoHash, fileIdx: Number(source.fileIdx || 0), sources: Array.isArray(source.sources) ? source.sources.slice(0, 30) : [], title: String(source.title || ''), name: String(source.name || ''), filename: typeof source.filename === 'string' ? source.filename.slice(0, 500) : null, sourceAddonId: source.sourceAddonId || null, sourceAddonName: source.sourceAddonName || null };
  throw new Error('Tipo de fonte não suportado.');
}

function mixResponse(mix) {
  const url = `${config.baseUrl}/play/${mix.id}/master.m3u8?token=${encodeURIComponent(mix.playToken)}`;
  return {
    name: 'NuvioMixer', title: mix.label, description: `${mix.video.sourceAddonName || 'Vídeo'} + ${mix.audio.sourceAddonName || 'Áudio'}${mix.scope === 'series' || mix.generatedFromTemplateId ? ' · automático por episódio' : ''} · sem recodificação`,
    url, behaviorHints: { notWebReady: true, filename: `${mix.label.replace(/[^\w.-]+/g, '_')}.mp4`, bingeGroup: `nuviomixer-${mix.id}` }
  };
}

function createRuntimeMix(input) {
  const now = Date.now();
  const mix = {
    id: randomUUID(),
    playToken: randomBytes(24).toString('base64url'),
    label: input.label,
    contentId: input.contentId,
    videoId: input.videoId,
    type: input.type,
    audioOffsetSeconds: Number(input.audioOffsetSeconds || 0),
    video: input.video,
    audio: input.audio,
    generatedFromTemplateId: input.generatedFromTemplateId || null,
    isPreview: Boolean(input.isPreview),
    expiresAt: now + runtimeMixLifetimeMs,
    lastAccess: now
  };
  runtimeMixes.set(mix.id, mix);
  return mix;
}

function findPlayableMix(id) {
  const stored = getMix(id);
  if (stored) return stored;
  const runtime = runtimeMixes.get(id);
  if (!runtime || runtime.expiresAt < Date.now()) return null;
  runtime.lastAccess = Date.now();
  return runtime;
}

function removeRuntimeMix(id) {
  if (!runtimeMixes.delete(id)) return false;
  discardSession(id);
  return true;
}

function cleanupRuntimeMixes() {
  for (const [id, mix] of runtimeMixes) if (mix.expiresAt < Date.now()) removeRuntimeMix(id);
}

async function resolveTemplateMix(template, videoId) {
  const cached = [...runtimeMixes.values()].find((mix) => mix.generatedFromTemplateId === template.id && mix.videoId === videoId && mix.expiresAt >= Date.now());
  if (cached) return cached;
  const sources = await resolveSeriesEpisode({ template, videoId, addons: listAddons(), getStreams });
  if (!sources) return null;
  try {
    await preflight(sources.video, sources.audio, template.audioOffsetSeconds);
  } catch {
    return null;
  }
  return createRuntimeMix({
    ...template,
    ...sources,
    videoId,
    label: `${template.label} · ${videoId}`,
    generatedFromTemplateId: template.id
  });
}

function selectedAddons(input) {
  const active = listAddons().filter((addon) => addon.enabled);
  if (!Array.isArray(input.addonIds) || !input.addonIds.length) return active;
  const requested = new Set(input.addonIds.map(String));
  return active.filter((addon) => requested.has(addon.id));
}

async function importNuvioAddons(profileId) {
  const connection = getNuvioConnection();
  if (!connection?.secret?.accessToken) throw new Error('Conecte uma conta Nuvio antes de importar addons.');
  if (!connection.secret.publishableKey) throw new Error('A conexão Nuvio precisa ser renovada para usar a chave pública atual do servidor.');
  const requestedProfileId = Number(profileId) || connection.profileId;
  const result = await listNuvioAddons({ apiBase: connection.apiBase, publishableKey: connection.secret.publishableKey, accessToken: connection.secret.accessToken, refreshToken: connection.secret.refreshToken }, requestedProfileId);
  if (result.connection.accessToken !== connection.secret.accessToken || requestedProfileId !== connection.profileId) {
    saveNuvioConnection({ apiBase: result.connection.apiBase, profileId: requestedProfileId, secret: { publishableKey: result.connection.publishableKey, accessToken: result.connection.accessToken, refreshToken: result.connection.refreshToken } });
  }
  const imported = [];
  for (const manifestUrl of result.addons) {
    try { imported.push(saveAddon(await importManifest(manifestUrl))); } catch { /* Um addon ruim não interrompe a sincronização dos demais. */ }
  }
  return { addons: imported, imported: imported.length };
}

async function handleApi(request, response, url) {
  if (url.pathname === '/api/health' && method(request, 'GET')) {
    const torboxConfigured = Boolean(config.masterKey && hasSecret('debrid:torbox'));
    return send(response, 200, {
      ok: true,
      version: '0.1.0',
      baseUrl: config.baseUrl,
      torrentGatewayConfigured: Boolean(config.torrentGatewayUrl),
      torboxConfigured,
      torrentSourceAvailable: Boolean(config.torrentGatewayUrl || torboxConfigured),
      credentialsStorageReady: Boolean(config.masterKey)
    });
  }
  if (url.pathname === '/api/addons' && method(request, 'GET')) return send(response, 200, { addons: listAddons() });
  if (url.pathname === '/api/addons' && method(request, 'POST')) {
    const input = await body(request);
    const imported = await importManifest(input.manifestUrl);
    return send(response, 201, { addon: saveAddon(imported) });
  }
  if (url.pathname.startsWith('/api/addons/') && method(request, 'PATCH')) {
    const input = await body(request);
    const addon = updateAddon(url.pathname.split('/').pop(), input);
    return addon ? send(response, 200, { addon }) : fail(response, 404, 'Addon não encontrado.');
  }
  if (url.pathname.startsWith('/api/addons/') && method(request, 'DELETE')) return deleteAddon(url.pathname.split('/').pop()) ? send(response, 204, '') : fail(response, 404, 'Addon não encontrado.');

  if (url.pathname === '/api/sources' && method(request, 'POST')) {
    const input = await body(request);
    const videoId = input.videoId || input.contentId;
    if (!videoId || !input.type) throw new Error('videoId e type são obrigatórios.');
    const active = selectedAddons(input);
    const settled = await Promise.allSettled(active.map(async (addon) => ({ addon, streams: await getStreams(addon, input.type, videoId) })));
    const results = settled.flatMap((item) => item.status === 'fulfilled' ? item.value.streams : []);
    const errors = settled.flatMap((item, index) => item.status === 'rejected' ? [{ addon: active[index].name, error: item.reason.message }] : []);
    return send(response, 200, { streams: results, errors });
  }
  if (url.pathname === '/api/source-searches' && method(request, 'POST')) {
    const input = await body(request);
    if (!input.videoId || !input.type) throw new Error('videoId e type são obrigatórios.');
    const job = createSourceJob({ addons: selectedAddons(input), videoId: String(input.videoId), type: input.type, getStreams, concurrency: 4 });
    return send(response, 201, { job });
  }
  const sourceJobMatch = /^\/api\/source-searches\/([^/]+)(?:\/(events|retry))?$/.exec(url.pathname);
  if (sourceJobMatch) {
    const [, jobId, action] = sourceJobMatch;
    if (!action && method(request, 'GET')) {
      const job = getSourceJob(jobId);
      return job ? send(response, 200, { job }) : fail(response, 404, 'Busca de fontes não encontrada.');
    }
    if (action === 'events' && method(request, 'GET')) {
      response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive' });
      response.write(': connected\n\n');
      const unsubscribe = subscribeSourceJob(jobId, (event, payload) => response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
      if (!unsubscribe) return response.end();
      request.on('close', unsubscribe);
      return;
    }
    if (action === 'retry' && method(request, 'POST')) {
      const current = getSourceJob(jobId);
      if (!current) return fail(response, 404, 'Busca de fontes não encontrada.');
      const addonIds = retryableAddonIds(jobId);
      const job = createSourceJob({ addons: selectedAddons({ addonIds }), videoId: current.videoId, type: current.type, getStreams, concurrency: 4 });
      return send(response, 201, { job });
    }
    if (!action && method(request, 'DELETE')) {
      const job = cancelSourceJob(jobId);
      return job ? send(response, 200, { job }) : fail(response, 404, 'Busca de fontes não encontrada.');
    }
  }
  if (url.pathname === '/api/catalog/search' && method(request, 'GET')) {
    const query = url.searchParams.get('q')?.trim();
    const type = url.searchParams.get('type') || 'movie';
    if (!query || !['movie', 'series'].includes(type)) throw new Error('Informe um título e tipo válidos.');
    return send(response, 200, { metas: await searchCatalog(query, type) });
  }
  const catalogDetailMatch = /^\/api\/catalog\/(movie|series)\/([^/]+)$/.exec(url.pathname);
  if (catalogDetailMatch && method(request, 'GET')) return send(response, 200, { meta: await getCatalogDetail(catalogDetailMatch[1], decodeURIComponent(catalogDetailMatch[2])) });

  if (url.pathname === '/api/preflight' && method(request, 'POST')) {
    const input = await body(request);
    const result = await preflight(sanitizeSource(input.video), sanitizeSource(input.audio), input.audioOffsetSeconds);
    return send(response, 200, {
      compatible: result.compatible,
      duration: result.duration,
      adjustedAudioDuration: result.adjustedAudioDuration,
      durationDriftSeconds: result.durationDriftSeconds,
      video: result.video.streams,
      audio: result.audio.streams
    });
  }

  if (url.pathname === '/api/previews' && method(request, 'POST')) {
    const input = await body(request);
    const preview = createRuntimeMix({
      label: 'Prévia de sincronização', contentId: 'preview', videoId: 'preview', type: 'movie', isPreview: true,
      audioOffsetSeconds: input.audioOffsetSeconds,
      video: sanitizeSource(input.video), audio: sanitizeSource(input.audio)
    });
    try {
      await ensureSession(preview);
      return send(response, 201, { preview: { id: preview.id, url: `/play/${preview.id}/master.m3u8?token=${encodeURIComponent(preview.playToken)}`, audioOffsetSeconds: preview.audioOffsetSeconds } });
    } catch (error) {
      removeRuntimeMix(preview.id);
      throw error;
    }
  }
  const previewMatch = /^\/api\/previews\/([^/]+)$/.exec(url.pathname);
  if (previewMatch && method(request, 'DELETE')) {
    const preview = runtimeMixes.get(previewMatch[1]);
    return preview?.isPreview && removeRuntimeMix(preview.id) ? send(response, 204, '') : fail(response, 404, 'Prévia não encontrada.');
  }

  if (url.pathname === '/api/mixes' && method(request, 'GET')) return send(response, 200, { mixes: listMixes() });
  if (url.pathname === '/api/mixes' && method(request, 'POST')) {
    const input = await body(request);
    if (!input.label || !input.contentId || !input.videoId) throw new Error('Nome, ID do conteúdo e ID do vídeo são obrigatórios.');
    const video = sanitizeSource(input.video), audio = sanitizeSource(input.audio);
    await preflight(video, audio, input.audioOffsetSeconds);
    const scope = input.type === 'series' && input.scope === 'series' ? 'series' : 'single';
    return send(response, 201, { mix: saveMix({ ...input, scope, video, audio, videoSelector: scope === 'series' ? sourceSelector(video) : null, audioSelector: scope === 'series' ? sourceSelector(audio) : null }) });
  }
  if (url.pathname.startsWith('/api/mixes/') && method(request, 'DELETE')) {
    const id = url.pathname.split('/').pop();
    for (const [runtimeId, mix] of runtimeMixes) if (mix.generatedFromTemplateId === id) removeRuntimeMix(runtimeId);
    return deleteMix(id) ? send(response, 204, '') : fail(response, 404, 'Combinação não encontrada.');
  }
  if (url.pathname.startsWith('/api/mixes/') && url.pathname.endsWith('/status') && method(request, 'GET')) {
    const id = url.pathname.split('/')[3];
    return send(response, 200, { session: sessionStatus(id) });
  }

  if (url.pathname.startsWith('/api/debrid/') && method(request, 'POST')) {
    const provider = url.pathname.split('/').pop();
    if (!/^(realdebrid|alldebrid|premiumize|torbox)$/i.test(provider)) throw new Error('Provedor debrid não suportado.');
    const input = await body(request);
    if (!input.apiKey || typeof input.apiKey !== 'string') throw new Error('apiKey é obrigatório.');
    saveSecret(`debrid:${provider.toLowerCase()}`, { apiKey: input.apiKey });
    return send(response, 204, '');
  }

  if (url.pathname === '/api/nuvio/connection' && method(request, 'GET')) {
    const connection = getNuvioConnectionInfo();
    return send(response, 200, {
      previouslyConnected: Boolean(connection),
      sessionAvailable: Boolean(connection && config.masterKey),
      profileId: connection?.profileId || null,
      updatedAt: connection?.updatedAt || null,
      apiBase: connection?.apiBase || null,
    });
  }
  if (url.pathname === '/api/nuvio/connect' && method(request, 'POST')) {
    if (!config.masterKey) throw new Error('Defina MASTER_KEY no arquivo .env antes de conectar sua conta. Ela protege a sessão Nuvio salva no volume Docker.');
    const input = await body(request);
    const connection = await connectNuvio(input);
    const selectedProfileId = Number(input.profileId) || connection.profiles[0]?.profileId || null;
    saveNuvioConnection({ apiBase: connection.apiBase, profileId: selectedProfileId, secret: { publishableKey: connection.publishableKey, accessToken: connection.accessToken, refreshToken: connection.refreshToken } });
    let imported = 0;
    let importError = null;
    try { ({ imported } = await importNuvioAddons(selectedProfileId)); }
    catch (error) { importError = error instanceof Error ? error.message : 'Não foi possível sincronizar os addons.'; }
    return send(response, 200, { connected: true, apiBase: connection.apiBase, profileId: selectedProfileId, profiles: connection.profiles, imported, importError });
  }
  if (url.pathname === '/api/nuvio/import-addons' && method(request, 'POST')) {
    const input = await body(request);
    return send(response, 200, await importNuvioAddons(input.profileId));
  }
  return fail(response, 404, 'Rota da API não encontrada.');
}

async function handler(request, response) {
  try {
    const url = new URL(request.url, config.baseUrl);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (url.pathname === '/manifest.json') return send(response, 200, {
      id: 'local.nuviomixer', version: '0.1.0', name: 'NuvioMixer', description: 'Combina vídeo e áudio sem recodificação.', resources: ['stream'], types: ['movie', 'series'], behaviorHints: { configurable: true }
    }, { 'access-control-allow-origin': '*' });
    const streamMatch = /^\/stream\/([^/]+)\/([^/]+)\.json$/.exec(url.pathname);
    if (streamMatch) {
      const [, type, contentId] = streamMatch;
      const videoId = decodeURIComponent(contentId);
      const mixes = listMixes();
      const saved = mixes.filter((mix) => mix.scope !== 'series' && mix.type === type && (mix.videoId || mix.contentId) === videoId);
      const templates = type === 'series' ? mixes.filter((mix) => mix.scope === 'series' && mix.type === 'series') : [];
      const generated = (await Promise.all(templates.map((template) => resolveTemplateMix(template, videoId)))).filter(Boolean);
      const streams = [...saved, ...generated].map(mixResponse);
      return send(response, 200, { streams }, { 'access-control-allow-origin': '*' });
    }
    const playMatch = /^\/play\/([^/]+)\/(master\.m3u8|init\.mp4|segment-\d{5}\.m4s)$/.exec(url.pathname);
    if (playMatch) {
      const [, mixId, filename] = playMatch, mix = findPlayableMix(mixId);
      if (!mix || url.searchParams.get('token') !== mix.playToken) return fail(response, 404, 'Sessão não encontrada.');
      if (filename === 'master.m3u8') await ensureSession(mix);
      const path = getSessionFile(mixId, filename);
      if (!path) return fail(response, 404, 'Segmento ainda não está disponível.');
      return filename === 'master.m3u8' ? streamPlaylist(response, path, mix.playToken) : streamFile(request, response, path);
    }
    const requested = url.pathname.replace(/^\//, '');
    if (requested && /^[A-Za-z0-9._/-]+$/.test(requested) && !requested.includes('..')) {
      const path = join(publicDir, requested);
      if (existsSync(path) && statSync(path).isFile()) return streamFile(request, response, path);
    }
    return streamFile(request, response, join(publicDir, 'index.html'));
  } catch (error) {
    const status = error.code === 'ENOENT' ? 404 : 400;
    return fail(response, status, error);
  }
}

const server = createServer((request, response) => {
  handler(request, response).catch((error) => fail(response, 500, error));
});
server.listen(config.port, () => console.log(`NuvioMixer disponível em ${config.baseUrl}`));
setInterval(cleanupSessions, 60_000).unref();
setInterval(cleanupRuntimeMixes, 60_000).unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { shutdownSessions(); server.close(() => process.exit(0)); });
