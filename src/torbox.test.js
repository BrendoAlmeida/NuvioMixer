import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMagnet, createTorboxResolver } from './torbox.js';
import { config } from './config.js';
import { canResolveWebDownload, resolveSource, resolveTorrent, resolveWebDownload, streamEndpoint } from './stremio.js';

const hash = '0123456789abcdef0123456789abcdef01234567';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
}

function resolverWith(fetchImpl, options = {}) {
  return createTorboxResolver({
    apiKey: 'test-api-key', apiBase: 'https://torbox.test/v1/api', fetchImpl,
    sleep: async () => {}, now: () => 0, pollIntervalMs: 0, maxWaitMs: 1,
    webDownloadCache: new Map(), ...options
  });
}

test('monta magnet com infoHash e apenas hints tracker HTTP/UDP', () => {
  const magnet = new URL(buildMagnet({ infoHash: hash, sources: ['tracker:udp://tracker.example:80/announce', 'tracker:https://tracker.example/announce', 'dht:node', 'tracker:ftp://invalid.example'] }));
  assert.equal(magnet.searchParams.get('xt'), `urn:btih:${hash}`);
  assert.deepEqual(magnet.searchParams.getAll('tr'), ['udp://tracker.example:80/announce', 'https://tracker.example/announce']);
});

test('a reconsulta de fontes adiciona um cache-buster sem alterar o endpoint normal', () => {
  const addon = { transportUrl: 'https://addon.example/manifest.json?token=ignored' };
  const normal = new URL(streamEndpoint(addon, 'series', 'tt22248376:1:7'));
  const refreshed = new URL(streamEndpoint(addon, 'series', 'tt22248376:1:7', { cacheBust: 123 }));
  assert.equal(normal.pathname, '/stream/series/tt22248376%3A1%3A7.json');
  assert.equal(normal.searchParams.has('_nuviomixer_refresh'), false);
  assert.equal(refreshed.searchParams.get('_nuviomixer_refresh'), '123');
});

test('cria torrent, espera disponibilidade, usa fileIdx e nunca retorna a chave', async () => {
  const calls = [];
  let poll = 0;
  const resolver = resolverWith(async (url, options) => {
    const request = new URL(url);
    calls.push({ request, options });
    if (request.pathname.endsWith('/torrents/mylist') && !request.searchParams.has('id')) return json({ success: true, data: [] });
    if (request.pathname.endsWith('/torrents/createtorrent')) return json({ success: true, data: { torrent_id: 41, hash } });
    if (request.pathname.endsWith('/torrents/mylist')) {
      poll += 1;
      return json({ success: true, data: [{ id: 41, hash, download_finished: poll > 1, download_present: poll > 1, progress: poll > 1 ? 100 : 40, files: poll > 1 ? [{ id: 8, name: 'first.mkv' }, { id: 9, name: 'target.mkv' }] : [] }] });
    }
    if (request.pathname.endsWith('/torrents/requestdl')) return json({ success: true, data: 'https://cdn.torbox.test/file.mkv' });
    throw new Error(`Requisição inesperada: ${request.pathname}`);
  });

  const result = await resolver.resolveTorrent({ kind: 'torrent', infoHash: hash, fileIdx: 1, sources: ['tracker:udp://tracker.example:80/announce'] });
  assert.equal(result.url, 'https://cdn.torbox.test/file.mkv');
  assert.equal(JSON.stringify(result).includes('test-api-key'), false);
  const create = calls.find(({ request }) => request.pathname.endsWith('/torrents/createtorrent'));
  assert.equal(create.options.headers.authorization, 'Bearer test-api-key');
  assert.equal(create.options.body.get('magnet').includes('tr=udp%3A%2F%2Ftracker.example%3A80%2Fannounce'), true);
  const download = calls.find(({ request }) => request.pathname.endsWith('/torrents/requestdl'));
  assert.equal(download.request.searchParams.get('token'), 'test-api-key');
  assert.equal(download.request.searchParams.get('file_id'), '9');
  assert.equal(download.request.searchParams.get('redirect'), 'false');
  assert.equal(download.options.headers.authorization, undefined);
});

test('reutiliza hash existente, prioriza filename e informa progresso se ainda não estiver pronto', async () => {
  const calls = [];
  const resolver = resolverWith(async (url) => {
    const request = new URL(url);
    calls.push(request);
    if (request.pathname.endsWith('/torrents/mylist') && !request.searchParams.has('id')) return json({ success: true, data: [{ id: 73, hash }] });
    if (request.pathname.endsWith('/torrents/mylist')) return json({ success: true, data: [{ id: 73, hash, download_finished: true, download_present: true, files: [{ id: 1, name: 'wrong.mkv' }, { id: 2, name: 'Correct.MKV' }] }] });
    if (request.pathname.endsWith('/torrents/requestdl')) return json({ success: true, data: 'https://cdn.torbox.test/correct.mkv' });
    throw new Error('Requisição inesperada.');
  });
  await resolver.resolveTorrent({ kind: 'torrent', infoHash: hash, fileIdx: 0, filename: 'correct.mkv' });
  assert.equal(calls.some((request) => request.pathname.endsWith('/torrents/createtorrent')), false);
  assert.equal(calls.find((request) => request.pathname.endsWith('/torrents/requestdl')).searchParams.get('file_id'), '2');

  const notReady = resolverWith(async (url) => {
    const request = new URL(url);
    if (!request.searchParams.has('id')) return json({ success: true, data: [{ id: 75, hash }] });
    return json({ success: true, data: [{ id: 75, hash, download_finished: false, download_present: false, progress: 37, files: [] }] });
  }, { maxWaitMs: 0 });
  await assert.rejects(notReady.resolveTorrent({ kind: 'torrent', infoHash: hash, fileIdx: 0 }), /Progresso: 37%/);
});

test('repete falhas transitórias e explica falha de DNS sem expor a chave', async () => {
  let calls = 0;
  const delays = [];
  const resolver = resolverWith(async (url) => {
    calls += 1;
    const request = new URL(url);
    if (request.pathname.endsWith('/torrents/mylist')) {
      if (calls === 1) return json({ success: false, detail: 'temporariamente indisponível' }, 503);
      return json({ success: true, data: [{ id: 73, hash, download_finished: false, download_present: false, progress: 20, files: [] }] });
    }
    throw new Error('Requisição inesperada.');
  }, { sleep: async (milliseconds) => { delays.push(milliseconds); }, maxWaitMs: 0 });
  await assert.rejects(resolver.resolveTorrent({ kind: 'torrent', infoHash: hash, fileIdx: 0 }), /Progresso: 20%/);
  assert.equal(calls, 3);
  assert.deepEqual(delays, [1_000]);

  const dnsFailure = resolverWith(async () => {
    const error = new TypeError('fetch failed');
    error.cause = { code: 'ENOTFOUND' };
    throw error;
  }, { sleep: async () => {}, requestAttempts: 2 });
  await assert.rejects(dnsFailure.resolveTorrent({ kind: 'torrent', infoHash: hash, fileIdx: 0 }), (error) => {
    assert.match(error.message, /DNS do servidor não conseguiu localizar api\.torbox\.app/);
    assert.equal(error.message.includes('test-api-key'), false);
    return true;
  });
});

test('WebDL é opt-in e recusa fontes que dependem de headers', async () => {
  let called = false;
  const resolver = resolverWith(async (url, options) => {
    const request = new URL(url);
    called = true;
    if (request.pathname.endsWith('/webdl/createwebdownload')) {
      assert.equal(options.headers.authorization, 'Bearer test-api-key');
      assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
      assert.equal(options.body.get('link'), 'https://direct.example/video.mp4');
      assert.equal([...options.body.keys()].join(','), 'link');
      return json({ success: true, data: { web_id: 91 } });
    }
    if (request.pathname.endsWith('/webdl/mylist')) return json({ success: true, data: [{ id: 91, download_finished: true, download_present: true, files: [{ id: 5, name: 'video.mp4' }] }] });
    if (request.pathname.endsWith('/webdl/requestdl')) return json({ success: true, data: 'https://cdn.torbox.test/video.mp4' });
    throw new Error('Requisição inesperada.');
  });
  const direct = { kind: 'url', url: 'https://direct.example/video.mp4', headers: {} };
  assert.equal(await resolver.resolveWebDownload(direct), direct);
  const result = await resolver.resolveWebDownload(direct, { requested: true });
  assert.equal(result.url, 'https://cdn.torbox.test/video.mp4');
  assert.equal(called, true);
  await assert.rejects(
    resolver.resolveWebDownload({ ...direct, headers: { Referer: 'https://direct.example' } }, { requested: true }),
    /URLs HTTP\(S\) públicas de arquivo.*sem cabeçalhos, cookies ou estado de requisição/
  );
});

test('WebDL é desabilitado por padrão e só encaminha explicitamente URLs públicas elegíveis', async () => {
  const direct = { kind: 'url', url: 'https://direct.example/audio.mp4', headers: {}, sourceAddonName: 'FrostStream' };
  let webDownloadCalls = 0;
  const torboxResolver = {
    resolveWebDownload: async (source, options) => {
      webDownloadCalls += 1;
      assert.deepEqual(options, { requested: true });
      return { ...source, url: 'https://cdn.torbox.test/audio.mp4', headers: {} };
    }
  };

  assert.equal(config.torboxResolveUrls, false);
  assert.equal(await resolveSource(direct, { torboxResolver }), direct);
  assert.equal(webDownloadCalls, 0);

  const resolved = await resolveSource(direct, { torboxResolver, requested: true });
  assert.equal(resolved.url, 'https://cdn.torbox.test/audio.mp4');
  assert.equal(webDownloadCalls, 1);

  for (const protectedSource of [
    { ...direct, headers: { Referer: 'https://froststream.example' } },
    { ...direct, cookies: 'session=abc' },
    { ...direct, origin: 'https://origin.example' },
    { ...direct, userAgent: 'FrostStream/1.0' },
    { ...direct, proxyHeaders: { request: { 'X-Source': 'FrostStream' } } },
    { ...direct, url: 'http://127.0.0.1/private.mp4' },
    { ...direct, url: 'http://192.168.1.1/private.mp4' },
    { ...direct, url: 'http://[::1]/private.mp4' },
    { ...direct, url: 'https://private.local/private.mp4' },
    { ...direct, url: 'https://direct.example/playlist.m3u8' },
    { ...direct, url: 'https://direct.example/manifest.mpd' },
    { ...direct, sourceAddonName: 'Torrentio TB', name: 'Torrentio TB 4K' },
    { ...direct, sourceAddonName: 'Torbox' },
    { ...direct, url: 'https://cdn.torbox.app/file.mp4' },
    { ...direct, sourceAddonName: 'Real-Debrid' }
  ]) {
    assert.equal(canResolveWebDownload(protectedSource), false);
    assert.equal(await resolveSource(protectedSource, { torboxResolver, requested: true }), protectedSource);
  }
  assert.equal(webDownloadCalls, 1);
});

test('WebDL preserva a URL sem chave e trata pedidos explícitos com as mesmas proteções', async () => {
  const direct = { kind: 'url', url: 'https://direct.example/audio.mp4', headers: {} };
  assert.equal(await resolveWebDownload(direct, { torboxResolver: null }), direct);
  assert.equal(await resolveWebDownload(direct, { requested: true, torboxResolver: null }), direct);
  const sourceWithOrigin = { ...direct, headers: { Origin: 'https://origin.example' } };
  assert.equal(await resolveWebDownload(sourceWithOrigin, {
    requested: true,
    torboxResolver: { resolveWebDownload: async () => { throw new Error('não deve ser chamado'); } }
  }), sourceWithOrigin);

  for (const protectedSource of [
    { ...direct, cookies: 'session=abc' },
    { ...direct, referer: 'https://referer.example' },
    { ...direct, proxyHeaders: { request: { Referer: 'https://referer.example' } } },
    { ...direct, url: 'https://direct.example/master.m3u8' }
  ]) {
    await assert.rejects(resolverWith(async () => { throw new Error('não deve ser chamado'); }).resolveWebDownload(protectedSource, { requested: true }), /URLs HTTP\(S\) públicas de arquivo/);
  }

  let calls = 0;
  const resolver = { resolveWebDownload: async (source) => { calls += 1; return source; } };
  assert.equal(await resolveWebDownload(direct, { requested: false, torboxResolver: resolver }), direct);
  assert.equal(calls, 0);

  const originalEnabled = config.torboxResolveUrls;
  config.torboxResolveUrls = false;
  try {
    assert.equal(await resolveWebDownload(direct, { torboxResolver: resolver }), direct);
    assert.equal(calls, 0);
  } finally {
    config.torboxResolveUrls = originalEnabled;
  }
});

test('stremio prioriza o resolvedor Torbox injetado para torrents e preserva o gateway legado sem ele', async () => {
  const source = { kind: 'torrent', infoHash: hash, fileIdx: 0 };
  const viaTorbox = await resolveTorrent(source, { torboxResolver: { resolveTorrent: async () => ({ kind: 'url', url: 'https://cdn.torbox.test/stream' }) } });
  assert.equal(viaTorbox.url, 'https://cdn.torbox.test/stream');

  let gatewayUrl;
  const viaGateway = await resolveTorrent(source, {
    torboxResolver: null, torrentGatewayUrl: 'https://gateway.test/base',
    fetchJsonImpl: async (url) => { gatewayUrl = new URL(url); return { url: 'https://gateway.test/stream' }; }
  });
  assert.equal(viaGateway.url, 'https://gateway.test/stream');
  assert.equal(gatewayUrl.pathname, '/resolve');
  assert.equal(gatewayUrl.searchParams.get('infoHash'), hash);

  const direct = { kind: 'url', url: 'https://direct.example/audio.mp4', headers: {} };
  const unchanged = await resolveWebDownload(direct, { torboxResolver: null });
  assert.equal(unchanged, direct);
  const viaWebDl = await resolveWebDownload(direct, {
    requested: true,
    torboxResolver: { resolveWebDownload: async () => ({ ...direct, url: 'https://cdn.torbox.test/audio.mp4', headers: {} }) }
  });
  assert.equal(viaWebDl.url, 'https://cdn.torbox.test/audio.mp4');
});

test('WebDL compartilha uma única criação concorrente e reutiliza o resultado em cache', async () => {
  let creates = 0;
  let releaseCreate;
  const creation = new Promise((resolve) => { releaseCreate = resolve; });
  const resolver = resolverWith(async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith('/webdl/createwebdownload')) {
      creates += 1;
      await creation;
      return json({ success: true, data: { web_id: 91 } });
    }
    if (request.pathname.endsWith('/webdl/mylist')) return json({ success: true, data: [{ id: 91, download_finished: true, download_present: true, files: [{ id: 5, name: 'audio.mp4' }] }] });
    if (request.pathname.endsWith('/webdl/requestdl')) return json({ success: true, data: 'https://cdn.torbox.test/audio.mp4' });
    throw new Error('Requisição inesperada.');
  });
  const source = { kind: 'url', url: 'https://direct.example/audio.mp4', headers: {} };
  const first = resolver.resolveWebDownload(source, { requested: true });
  const second = resolver.resolveWebDownload(source, { requested: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(creates, 1);
  releaseCreate();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.url, 'https://cdn.torbox.test/audio.mp4');
  assert.equal(secondResult.url, 'https://cdn.torbox.test/audio.mp4');
  const thirdResult = await resolver.resolveWebDownload(source, { requested: true });
  assert.equal(thirdResult.url, 'https://cdn.torbox.test/audio.mp4');
  assert.equal(creates, 1);
});

test('rejeita link de retorno com chave Torbox crua ou percent-encoded sem vazar segredo', async () => {
  const token = 'api/key?secret';
  const resolver = resolverWith(async (url) => {
    const request = new URL(url);
    if (request.pathname.endsWith('/webdl/createwebdownload')) return json({ success: true, data: { web_id: 91 } });
    if (request.pathname.endsWith('/webdl/mylist')) return json({ success: true, data: [{ id: 91, download_finished: true, download_present: true, files: [{ id: 5, name: 'secret.mp4' }] }] });
    if (request.pathname.endsWith('/webdl/requestdl')) return json({ success: true, data: `https://cdn.torbox.test/file.mp4?auth=${encodeURIComponent(token)}` });
    throw new Error('Requisição inesperada.');
  }, { apiKey: token });
  const source = { kind: 'url', url: 'https://direct.example/secret.mp4', headers: {} };
  await assert.rejects(resolver.resolveWebDownload(source, { requested: true }), (error) => {
    assert.match(error.message, /URL CDN reproduzível/);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(source.url), false);
    return true;
  });
});
