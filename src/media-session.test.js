import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildVodTimeline, createSessionManager } from './media.js';

class MockChild extends EventEmitter {
  constructor() {
    super();
    this.exitCode = 0;
    this.killed = false;
    this.stderr = new EventEmitter();
  }

  kill() { this.killed = true; }
}

function memoryFilesystem() {
  const files = new Map();
  const directories = new Set();
  return {
    files,
    existsSync(path) { return files.has(path) || directories.has(path); },
    mkdirSync(path) { directories.add(path); },
    writeFileSync(path, contents) { files.set(path, contents); },
    readFileSync(path) {
      if (!files.has(path)) throw new Error(`Arquivo inexistente: ${path}`);
      return files.get(path);
    },
    rmSync(path) {
      directories.delete(path);
      for (const file of files.keys()) if (file === path || file.startsWith(`${path}/`)) files.delete(file);
    },
    statSync(path) {
      if (files.has(path)) return { size: files.get(path).length, mtimeMs: 0 };
      if (directories.has(path)) return { size: 0, mtimeMs: 0 };
      throw new Error(`Caminho inexistente: ${path}`);
    },
    readdirSync(path, options = {}) {
      const prefix = `${path}/`;
      const names = new Set();
      for (const candidate of [...directories, ...files.keys()]) {
        if (!candidate.startsWith(prefix)) continue;
        const name = candidate.slice(prefix.length).split('/')[0];
        if (name) names.add(name);
      }
      return [...names].map((name) => ({ name, isDirectory: () => directories.has(`${path}/${name}`) }));
    }
  };
}

function mix() {
  return {
    id: 'stream-pronta',
    video: { kind: 'url', url: 'https://video.example.test/movie.mp4' },
    audio: { kind: 'url', url: 'https://audio.example.test/movie.mp4' }
  };
}

function preflightResult(currentMix) {
  return {
    video: { source: currentMix.video, streams: [{ codecType: 'video', codecName: 'h264' }] },
    audio: { source: currentMix.audio, streams: [{ codecType: 'audio', codecName: 'aac' }] },
    duration: 12
  };
}

function writePlaylist(fileSystem, output, { final = false } = {}) {
  const directory = output.replace(/\/master\.m3u8$/, '');
  fileSystem.files.set(`${directory}/init.mp4`, 'init');
  fileSystem.files.set(`${directory}/segment-00000.m4s`, 'segment');
  fileSystem.files.set(output, `#EXTM3U\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nsegment-00000.m4s\n${final ? '#EXT-X-ENDLIST\n' : ''}`);
}

function createManager({ preflightSource, spawnProcess, fileSystem = memoryFilesystem(), patchFmp4Header, buildVodTimelineSource = async (_source, duration, targetSeconds) => buildVodTimeline([0, 4, 8], duration, targetSeconds), now = () => Date.now(), sleep = async () => {}, sessionConfig = {} }) {
  let generation = 0;
  return {
    fileSystem,
    manager: createSessionManager({
      sessionConfig: { dataDir: '/data', streamStartTimeoutMs: 1_000, sessionIdleMs: 60_000, seekSegmentSeconds: 4, keyframeIndexTimeoutMs: 1_000, ...sessionConfig },
      fileSystem,
      preflightSource,
      patchFmp4Header,
      buildVodTimelineSource,
      spawnProcess,
      now,
      sleep,
      generateId: () => `generation-${++generation}`
    })
  };
}

test('reutiliza uma playlist HLS finalizada após a saída do FFmpeg', async () => {
  let preflightCalls = 0;
  let launches = 0;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => {
      preflightCalls += 1;
      return preflightResult({ video: sources[0], audio: sources[1] });
    },
    spawnProcess: (_command, args) => {
      launches += 1;
      writePlaylist(fileSystem, args.at(-1), { final: true });
      return new MockChild();
    }
  });
  const currentMix = mix();

  const first = await manager.ensureSession(currentMix);
  const second = await manager.ensureSession(currentMix);

  assert.equal(second, first);
  assert.equal(preflightCalls, 1);
  assert.equal(launches, 1);
  assert.equal(manager.getSessionFile(currentMix.id, 'master.m3u8'), '/data/sessions/generation-1/master.m3u8');
  const status = manager.sessionStatus(currentMix.id);
  assert.equal(status.running, false);
  assert.equal(status.state, 'ready', status.error);
  assert.equal(status.diagnosticAvailable, false);
  assert.equal('source' in status.preflight.video, false);
  assert.equal('source' in status.preflight.audio, false);
  assert.equal(JSON.stringify(status).includes('video.example.test'), false);
  assert.equal(JSON.stringify(status).includes('audio.example.test'), false);
});

test('deduplica chamadas simultâneas antes do preflight e inicia somente um FFmpeg', async () => {
  let resolvePreflight;
  let preflightCalls = 0;
  let launches = 0;
  const pendingPreflight = new Promise((resolve) => { resolvePreflight = resolve; });
  const { manager, fileSystem } = createManager({
    preflightSource: () => {
      preflightCalls += 1;
      return pendingPreflight;
    },
    spawnProcess: (_command, args) => {
      launches += 1;
      writePlaylist(fileSystem, args.at(-1), { final: true });
      return new MockChild();
    }
  });
  const currentMix = mix();

  const first = manager.ensureSession(currentMix);
  const second = manager.ensureSession(currentMix);
  assert.equal(first, second);
  assert.equal(preflightCalls, 1);
  assert.equal(launches, 0);

  resolvePreflight(preflightResult(currentMix));
  const [firstSession, secondSession] = await Promise.all([first, second]);

  assert.equal(secondSession, firstSession);
  assert.equal(launches, 1);
});

test('usa diretórios de geração isolados quando uma sessão é substituída', async () => {
  let launches = 0;
  let wakeFirstWait;
  let firstOutput;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      if (launches === 1) {
        firstOutput = args.at(-1);
        const child = new MockChild();
        child.exitCode = null;
        return child;
      }
      writePlaylist(fileSystem, args.at(-1), { final: true });
      return new MockChild();
    },
    sleep: () => new Promise((resolve) => { wakeFirstWait = resolve; })
  });
  const currentMix = mix();
  const first = manager.ensureSession(currentMix);
  await new Promise((resolve) => setImmediate(resolve));

  manager.discardSession(currentMix.id);
  wakeFirstWait();
  await assert.rejects(first, /cancelada/);

  const replacement = await manager.ensureSession(currentMix);
  const replacementPlaylist = manager.getSessionFile(currentMix.id, 'master.m3u8');
  assert.equal(launches, 2);
  assert.notEqual(replacement.directory, firstOutput.replace(/\/master\.m3u8$/, ''));

  // Simula um FFmpeg antigo tentando gravar depois de ter sido encerrado.
  fileSystem.files.set(firstOutput, '#EXTM3U\n#EXT-X-ENDLIST\n#EXTINF:999,\nold.m4s\n');
  assert.equal(manager.getSessionFile(currentMix.id, 'master.m3u8'), replacementPlaylist);
  assert.equal(fileSystem.readFileSync(replacementPlaylist).includes('old.m4s'), false);
});

test('libera a playlist assim que os primeiros segmentos ficam disponíveis e mantém o FFmpeg em execução', async () => {
  let launches = 0;
  let child;
  let output;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      output = args.at(-1);
      writePlaylist(fileSystem, output);
      child = new MockChild();
      child.exitCode = null;
      return child;
    }
  });
  const currentMix = mix();

  const first = await manager.ensureSession(currentMix);
  const second = await manager.ensureSession(currentMix);

  assert.equal(second, first);
  assert.equal(launches, 1);
  assert.equal(manager.sessionStatus(currentMix.id).state, 'streaming');
  assert.equal(manager.sessionStatus(currentMix.id).running, true);
  assert.equal(manager.getSessionFile(currentMix.id, 'segment-00000.m4s'), `${output.replace(/\/master\.m3u8$/, '')}/segment-00000.m4s`);

  writePlaylist(fileSystem, output, { final: true });
  child.exitCode = 0;
  child.emit('close');
  assert.equal(manager.sessionStatus(currentMix.id).state, 'ready');
  assert.equal(manager.sessionStatus(currentMix.id).running, false);
});

test('inicia fMP4 progressivo com duração declarada sem esperar o arquivo inteiro', async () => {
  let child;
  let patchedDuration = null;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    patchFmp4Header: (_path, duration) => { patchedDuration = duration; return true; },
    spawnProcess: (_command, args) => {
      const output = args.at(-1);
      fileSystem.files.set(output, Buffer.from('ftyp--moov--moof--mdat'));
      child = new MockChild();
      child.exitCode = null;
      return child;
    }
  });
  const currentMix = mix();

  const session = await manager.ensureSession(currentMix, 'fmp4');
  assert.equal(session.transport, 'fmp4');
  assert.equal(manager.sessionStatus(currentMix.id, 'fmp4').state, 'streaming');
  assert.equal(manager.getSessionFile(currentMix.id, 'stream.mp4', 'fmp4'), '/data/sessions/generation-1/stream.mp4');
  assert.equal(patchedDuration, 12);

  child.exitCode = 0;
  child.emit('close');
  assert.equal(manager.sessionStatus(currentMix.id, 'fmp4').state, 'ready');
});

test('inicia o VOD buscável com um único remux contínuo e reutiliza os próximos segmentos', async () => {
  let launches = 0;
  let startNumber = null;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      const template = args[args.indexOf('-hls_segment_filename') + 1];
      const init = args[args.indexOf('-hls_fmp4_init_filename') + 1];
      const continuous = args.includes('-start_number');
      startNumber = continuous ? Number(args[args.indexOf('-start_number') + 1]) : null;
      const directory = continuous ? template.replace(/\/vod-segment-%05d-000\.m4s$/, '') : template.replace(/\/vod-segment-\d{5}-%03d\.m4s$/, '');
      if (continuous) {
        const start = Number(args[args.indexOf('-start_number') + 1]);
        for (let index = start; index < 3; index += 1) fileSystem.files.set(template.replace('%05d', String(index).padStart(5, '0')), 'segment');
      } else fileSystem.files.set(template.replace('%03d', '000'), 'segment');
      fileSystem.files.set(`${directory}/${init}`, 'init');
      const child = new MockChild();
      child.exitCode = null;
      queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    }
  });
  const currentMix = mix();

  const session = await manager.ensureSession(currentMix, 'vod');
  assert.equal(launches, 1);
  assert.equal(startNumber, 0);
  assert.match(fileSystem.readFileSync(`${session.directory}/vod.m3u8`), /vod-segment-00002-000\.m4s/);
  await Promise.all([manager.ensureVodSegment(currentMix, 2), manager.ensureVodSegment(currentMix, 2)]);
  assert.equal(launches, 1);
  assert.equal(manager.getSessionFile(currentMix.id, 'vod-segment-00002-000.m4s', 'vod'), `${session.directory}/vod-segment-00002-000.m4s`);
});

test('repete um segmento VOD após resposta 429 temporária da fonte', async () => {
  let launches = 0;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      const child = new MockChild();
      child.exitCode = null;
      if (launches === 1) {
        queueMicrotask(() => {
          child.stderr.emit('data', 'HTTP error 429 Too Many Requests');
          child.exitCode = 1; child.emit('close', 1);
        });
        return child;
      }
      const template = args[args.indexOf('-hls_segment_filename') + 1];
      const init = args[args.indexOf('-hls_fmp4_init_filename') + 1];
      const continuous = args.includes('-start_number');
      const directory = continuous ? template.replace(/\/vod-segment-%05d-000\.m4s$/, '') : template.replace(/\/vod-segment-\d{5}-%03d\.m4s$/, '');
      if (continuous) {
        const start = Number(args[args.indexOf('-start_number') + 1]);
        for (let index = start; index < 3; index += 1) fileSystem.files.set(template.replace('%05d', String(index).padStart(5, '0')), 'segment');
      } else fileSystem.files.set(template.replace('%03d', '000'), 'segment');
      fileSystem.files.set(`${directory}/${init}`, 'init');
      queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    }
  });

  await manager.ensureSession(mix(), 'vod');
  assert.equal(launches, 2);
  assert.match(manager.preloadStatus('stream-pronta').events.map((event) => event.message).join('\n'), /limitou as requisições/);
});

test('repete o segmento inicial quando a origem fecha sem diagnóstico', async () => {
  let launches = 0;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      const child = new MockChild();
      child.exitCode = null;
      if (launches === 1) {
        queueMicrotask(() => { child.exitCode = 1; child.emit('close', 1); });
        return child;
      }
      const template = args[args.indexOf('-hls_segment_filename') + 1];
      const init = args[args.indexOf('-hls_fmp4_init_filename') + 1];
      const continuous = args.includes('-start_number');
      const directory = continuous ? template.replace(/\/vod-segment-%05d-000\.m4s$/, '') : template.replace(/\/vod-segment-\d{5}-%03d\.m4s$/, '');
      if (continuous) {
        const start = Number(args[args.indexOf('-start_number') + 1]);
        for (let index = start; index < 3; index += 1) fileSystem.files.set(template.replace('%05d', String(index).padStart(5, '0')), 'segment');
      } else fileSystem.files.set(template.replace('%03d', '000'), 'segment');
      fileSystem.files.set(`${directory}/${init}`, 'init');
      queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    }
  });

  await manager.ensureSession(mix(), 'vod');
  assert.equal(launches, 2);
  assert.match(manager.preloadStatus('stream-pronta').events.map((event) => event.message).join('\n'), /interrompeu a leitura contínua/);
});

test('preserva o cache e informa o limite da fonte depois de esgotar as tentativas 429', async () => {
  let launches = 0;
  const { manager } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: () => {
      launches += 1;
      const child = new MockChild();
      child.exitCode = null;
      queueMicrotask(() => {
        child.stderr.emit('data', 'HTTP error 429 Too Many Requests');
        child.exitCode = 1; child.emit('close', 1);
      });
      return child;
    }
  });

  await assert.rejects(manager.ensureSession(mix(), 'vod'), /continua limitando requisições \(HTTP 429\)/);
  assert.equal(launches, 6);
  assert.match(manager.preloadStatus('stream-pronta').events.map((event) => event.message).join('\n'), /120 s/);
});

test('faz preload VOD persistente, expõe progresso e preserva segmentos locais', async () => {
  let launches = 0;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      const template = args[args.indexOf('-hls_segment_filename') + 1];
      const init = args[args.indexOf('-hls_fmp4_init_filename') + 1];
      const continuous = args.includes('-start_number');
      const directory = continuous ? template.replace(/\/vod-segment-%05d-000\.m4s$/, '') : template.replace(/\/vod-segment-\d{5}-%03d\.m4s$/, '');
      if (continuous) {
        const start = Number(args[args.indexOf('-start_number') + 1]);
        for (let index = start; index < 3; index += 1) fileSystem.files.set(template.replace('%05d', String(index).padStart(5, '0')), 'segment');
      } else fileSystem.files.set(template.replace('%03d', '000'), 'segment');
      fileSystem.files.set(`${directory}/${init}`, 'init');
      const child = new MockChild();
      child.exitCode = null;
      queueMicrotask(() => { child.exitCode = 0; child.emit('close', 0); });
      return child;
    }
  });
  const currentMix = mix();

  manager.startPreload(currentMix, { mode: 'all' });
  for (let attempt = 0; attempt < 12 && manager.preloadStatus(currentMix.id).state !== 'ready'; attempt += 1) await new Promise(setImmediate);
  const status = manager.preloadStatus(currentMix.id);
  assert.equal(status.state, 'ready', status.error);
  assert.equal(status.completedSegments, 3);
  assert.equal(status.cache.preparedSegments, 3);
  assert.deepEqual(status.cache.cachedRanges, [{ startSeconds: 0, endSeconds: 12 }]);
  assert.ok(status.transferredBytes > 0);
  assert.ok(status.speedBytesPerSecond > 0);
  assert.equal(launches, 1);
  assert.match(manager.getCachedVodFile(currentMix.id, 'vod.m3u8'), /\/data\/preloads\/stream-pronta\//);

  manager.clearPreloadCache(currentMix.id, { includeKeyframes: false });
  assert.equal(manager.preloadStatus(currentMix.id).state, 'idle');
});

test('prepara um trecho contínuo e deixa o restante para a stream sob demanda', async () => {
  let launches = 0;
  const currentMix = mix();
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: (_command, args) => {
      launches += 1;
      const template = args[args.indexOf('-hls_segment_filename') + 1];
      const init = args[args.indexOf('-hls_fmp4_init_filename') + 1];
      const continuous = args.includes('-start_number');
      const directory = continuous ? template.replace(/\/vod-segment-%05d-000\.m4s$/, '') : template.replace(/\/vod-segment-\d{5}-%03d\.m4s$/, '');
      const child = new MockChild();
      child.exitCode = null;
      queueMicrotask(() => {
        if (continuous) {
          const start = Number(args[args.indexOf('-start_number') + 1]);
          fileSystem.files.set(template.replace('%05d', String(start).padStart(5, '0')), 'segment');
        } else fileSystem.files.set(template.replace('%03d', '000'), 'segment');
        fileSystem.files.set(`${directory}/${init}`, 'init');
        child.exitCode = 0; child.emit('close', 0);
      });
      return child;
    }
  });

  manager.startPreload(currentMix, { mode: 'range', startSeconds: 4, endSeconds: 8 });
  for (let attempt = 0; attempt < 12 && manager.preloadStatus(currentMix.id).state !== 'ready'; attempt += 1) await new Promise(setImmediate);
  const status = manager.preloadStatus(currentMix.id);
  assert.equal(launches, 1);
  assert.equal(status.state, 'partial');
  assert.equal(status.cache.preparedSegments, 1);
  assert.deepEqual(status.cache.cachedRanges, [{ startSeconds: 4, endSeconds: 8 }]);
});

test('falha rapidamente quando o processo FFmpeg emite erro', async () => {
  const { manager } = createManager({
    preflightSource: async (...sources) => preflightResult({ video: sources[0], audio: sources[1] }),
    spawnProcess: () => {
      const child = new MockChild();
      child.exitCode = null;
      queueMicrotask(() => child.emit('error', new Error('spawn failed')));
      return child;
    },
    sleep: async () => {}
  });
  await assert.rejects(manager.ensureSession(mix()), /FFmpeg não pôde iniciar/);
});
