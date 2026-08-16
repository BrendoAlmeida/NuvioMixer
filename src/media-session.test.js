import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionManager } from './media.js';

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
    readdirSync() { return []; }
  };
}

function mix() {
  return {
    id: 'vod-pronta',
    video: { kind: 'url', url: 'https://video.example.test/movie.mp4' },
    audio: { kind: 'url', url: 'https://audio.example.test/movie.mp4' }
  };
}

function preflightResult(currentMix) {
  return {
    video: { source: currentMix.video, streams: [{ codecType: 'video', codecName: 'h264' }] },
    audio: { source: currentMix.audio, streams: [{ codecType: 'audio', codecName: 'aac' }] }
  };
}

function createManager({ preflightSource, spawnProcess, fileSystem = memoryFilesystem(), now = () => Date.now(), sleep = async () => {} }) {
  let generation = 0;
  return {
    fileSystem,
    manager: createSessionManager({
      sessionConfig: { dataDir: '/data', streamStartTimeoutMs: 1_000, sessionIdleMs: 60_000 },
      fileSystem,
      preflightSource,
      spawnProcess,
      now,
      sleep,
      generateId: () => `generation-${++generation}`
    })
  };
}

test('reutiliza uma playlist VOD finalizada após a saída do FFmpeg', async () => {
  let preflightCalls = 0;
  let launches = 0;
  const { manager, fileSystem } = createManager({
    preflightSource: async (...sources) => {
      preflightCalls += 1;
      return preflightResult({ video: sources[0], audio: sources[1] });
    },
    spawnProcess: (_command, args) => {
      launches += 1;
      fileSystem.files.set(args.at(-1), '#EXTM3U\n#EXT-X-ENDLIST\n');
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
  assert.equal(status.state, 'ready');
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
      fileSystem.files.set(args.at(-1), '#EXTM3U\n#EXT-X-ENDLIST\n');
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
      fileSystem.files.set(args.at(-1), '#EXTM3U\n#EXT-X-ENDLIST\n');
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
