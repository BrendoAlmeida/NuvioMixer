import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { resolveSource } from './stremio.js';

const supportedVideo = new Set(['h264', 'hevc', 'av1']);
const supportedAudio = new Set(['aac', 'ac3', 'eac3', 'opus', 'mp3']);
const filesystem = { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync };

function run(command, args, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} excedeu o tempo limite.`)); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} falhou (${code}): ${stderr.slice(-800)}`));
    });
  });
}

function headersArgument(headers = {}) {
  const entries = Object.entries(headers).filter(([key, value]) => key && value !== undefined && !/[\r\n]/.test(`${key}${value}`));
  return entries.length ? `${entries.map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n` : null;
}

async function resolvedSource(source) {
  return resolveSource(source);
}

function inputArguments(source) {
  const headers = headersArgument(source.headers);
  const args = [];
  if (headers) args.push('-headers', headers);
  return args.concat(['-i', source.url]);
}

export async function probe(source) {
  const playable = await resolvedSource(source);
  const headers = headersArgument(playable.headers);
  const args = ['-v', 'error', '-show_format', '-show_streams', '-of', 'json'];
  if (headers) args.push('-headers', headers);
  args.push(playable.url);
  const { stdout } = await run('ffprobe', args);
  const parsed = JSON.parse(stdout);
  const streams = (parsed.streams || []).map((stream) => ({
    index: stream.index, codecType: stream.codec_type, codecName: stream.codec_name,
    profile: stream.profile || null, width: stream.width || null, height: stream.height || null,
    channels: stream.channels || null, sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    language: stream.tags?.language || null, duration: Number(stream.duration || parsed.format?.duration || 0)
  }));
  return { source: playable, duration: Number(parsed.format?.duration || 0), streams };
}

export function durationAssessment(videoDuration, audioDuration, audioOffsetSeconds = 0) {
  const adjustedAudioDuration = Number(audioDuration) + Number(audioOffsetSeconds || 0);
  return { adjustedAudioDuration, durationDriftSeconds: Math.abs(Number(videoDuration) - adjustedAudioDuration) };
}

export async function preflight(videoSource, audioSource, audioOffsetSeconds = 0) {
  const [videoProbe, audioProbe] = await Promise.all([probe(videoSource), probe(audioSource)]);
  const video = videoProbe.streams.find((stream) => stream.codecType === 'video');
  const audio = audioProbe.streams.find((stream) => stream.codecType === 'audio');
  if (!video) throw new Error('A fonte de vídeo não contém uma faixa de vídeo reproduzível.');
  if (!audio) throw new Error('A fonte de áudio não contém uma faixa de áudio reproduzível.');
  if (!supportedVideo.has(video.codecName)) throw new Error(`Vídeo ${video.codecName} não é aceito no HLS sem recodificação.`);
  if (!supportedAudio.has(audio.codecName)) throw new Error(`Áudio ${audio.codecName} não é aceito no HLS sem recodificação.`);
  if (!videoProbe.duration || !audioProbe.duration) throw new Error('Não foi possível determinar a duração das duas fontes.');
  const { adjustedAudioDuration, durationDriftSeconds } = durationAssessment(videoProbe.duration, audioProbe.duration, audioOffsetSeconds);
  return {
    video: videoProbe,
    audio: audioProbe,
    duration: videoProbe.duration,
    adjustedAudioDuration,
    durationDriftSeconds,
    compatible: true
  };
}

export function buildFfmpegArgs(mix, directory, audioCodec) {
  const args = ['-hide_banner', '-nostdin', '-y'];
  args.push(...inputArguments(mix.video));
  if (mix.audioOffsetSeconds) args.push('-itsoffset', String(mix.audioOffsetSeconds));
  args.push(...inputArguments(mix.audio));
  args.push(
    '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-map_metadata', '0',
    '-c:v', 'copy', '-c:a', 'copy', '-copyts', '-start_at_zero',
  );
  // ADTS is a transport wrapper, not a re-encode. fMP4 requires ASC for AAC copied from TS/HLS.
  if (audioCodec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  args.push(
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
    '-hls_segment_filename', join(directory, 'segment-%05d.m4s'),
    join(directory, 'master.m3u8')
  );
  return args;
}

/**
 * Creates the VOD-session store. Dependency injection keeps its concurrent state machine
 * testable without starting FFmpeg or touching the host filesystem.
 */
export function createSessionManager({
  sessionConfig = config,
  fileSystem = filesystem,
  spawnProcess = spawn,
  preflightSource = preflight,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  generateId = randomUUID
} = {}) {
  const sessions = new Map();
  const root = join(sessionConfig.dataDir, 'sessions');
  const playlistFor = (directory) => join(directory, 'master.m3u8');

  function createGenerationDirectory() {
    // Never reuse a directory: a stopped FFmpeg can still race a replacement
    // process, but it can no longer write playlist files for the new generation.
    const directory = join(root, generateId());
    fileSystem.mkdirSync(directory, { recursive: true });
    return directory;
  }

  function isFinalPlaylist(directory) {
    const playlist = playlistFor(directory);
    try {
      return fileSystem.existsSync(playlist)
        && fileSystem.statSync(playlist).size > 0
        && fileSystem.readFileSync(playlist, 'utf8').includes('#EXT-X-ENDLIST');
    } catch {
      // The cleanup task can remove an expired session between filesystem checks.
      return false;
    }
  }

  function isCurrent(session) {
    return sessions.get(session.id) === session && !session.cancelled;
  }

  function stopSession(id) {
    const session = sessions.get(id);
    if (!session) return null;
    session.cancelled = true;
    if (session.child && session.child.exitCode === null && !session.child.killed) session.child.kill('SIGTERM');
    sessions.delete(id);
    return session;
  }

  function discardSession(id) {
    const session = stopSession(id);
    if (session?.directory) fileSystem.rmSync(session.directory, { recursive: true, force: true });
  }

  async function waitForFinalPlaylist(session) {
    const started = now();
    while (now() - started < sessionConfig.streamStartTimeoutMs) {
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
      if (isFinalPlaylist(session.directory)) return;
      if (session.processError) throw session.processError;
      if (session.child?.exitCode !== null) throw new Error('O FFmpeg encerrou antes de produzir a playlist.');
      await sleep(150);
    }
    throw new Error(`A preparação da stream demorou mais de ${Math.ceil(sessionConfig.streamStartTimeoutMs / 1000)}s.`);
  }

  async function prepareSession(mix, session) {
    try {
      const check = await preflightSource(mix.video, mix.audio, mix.audioOffsetSeconds);
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');

      const directory = createGenerationDirectory();
      const audioCodec = check.audio.streams.find((stream) => stream.codecType === 'audio')?.codecName;
      const args = buildFfmpegArgs({ ...mix, video: check.video.source, audio: check.audio.source }, directory, audioCodec);
      const child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';

      session.directory = directory;
      session.child = child;
      session.preflight = check;
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
        session.stderr = stderr;
      });
      child.on('error', () => {
        session.processError = new Error('O FFmpeg não pôde iniciar a preparação da stream.');
        session.finishedAt = now();
      });
      child.on('close', () => { session.finishedAt = now(); });

      await waitForFinalPlaylist(session);
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
      session.state = 'ready';
      return session;
    } catch (error) {
      if (sessions.get(session.id) === session) discardSession(session.id);
      throw error;
    }
  }

  function ensureSession(mix) {
    const existing = sessions.get(mix.id);
    if (existing) {
      existing.lastAccess = now();
      if (existing.state === 'ready' && isFinalPlaylist(existing.directory)) return Promise.resolve(existing);
      if (existing.state === 'preparing') return existing.readyPromise;
      discardSession(mix.id);
    }

    // Register the placeholder before preflight so simultaneous requests share one promise.
    const session = {
      id: mix.id,
      directory: null,
      child: null,
      lastAccess: now(),
      stderr: '',
      preflight: null,
      finishedAt: null,
      processError: null,
      state: 'preparing',
      cancelled: false,
      readyPromise: null
    };
    sessions.set(mix.id, session);
    session.readyPromise = prepareSession(mix, session);
    return session.readyPromise;
  }

  function getSessionFile(mixId, filename) {
    const session = sessions.get(mixId);
    if (!session || !session.directory) return null;
    session.lastAccess = now();
    if (!/^(master\.m3u8|init\.mp4|segment-\d{5}\.m4s)$/.test(filename)) return null;
    const path = join(session.directory, filename);
    return fileSystem.existsSync(path) ? path : null;
  }

  function sessionStatus(mixId) {
    const session = sessions.get(mixId);
    if (!session) return null;
    return {
      running: Boolean(session.child && session.child.exitCode === null),
      state: session.state,
      finishedAt: session.finishedAt,
      lastAccess: session.lastAccess,
      diagnosticAvailable: Boolean(session.stderr || session.processError),
      preflight: session.preflight ? {
        duration: session.preflight.duration,
        adjustedAudioDuration: session.preflight.adjustedAudioDuration,
        durationDriftSeconds: session.preflight.durationDriftSeconds,
        compatible: session.preflight.compatible,
        video: { duration: session.preflight.video?.duration, streams: session.preflight.video?.streams || [] },
        audio: { duration: session.preflight.audio?.duration, streams: session.preflight.audio?.streams || [] }
      } : null
    };
  }

  function cleanupSessions() {
    for (const [id, session] of sessions) {
      if (now() - session.lastAccess > sessionConfig.sessionIdleMs) discardSession(id);
    }
    if (!fileSystem.existsSync(root)) return;
    const activeDirectories = new Set([...sessions.values()].map((session) => session.directory).filter(Boolean));
    for (const entry of fileSystem.readdirSync(root, { withFileTypes: true })) {
      const directory = join(root, entry.name);
      if (entry.isDirectory() && !activeDirectories.has(directory) && now() - fileSystem.statSync(directory).mtimeMs > sessionConfig.sessionIdleMs) {
        fileSystem.rmSync(directory, { recursive: true, force: true });
      }
    }
  }

  function shutdownSessions() { for (const id of [...sessions.keys()]) discardSession(id); }

  return { ensureSession, getSessionFile, sessionStatus, cleanupSessions, shutdownSessions, discardSession };
}

const defaultSessionManager = createSessionManager();

export const ensureSession = (...args) => defaultSessionManager.ensureSession(...args);
export const getSessionFile = (...args) => defaultSessionManager.getSessionFile(...args);
export const sessionStatus = (...args) => defaultSessionManager.sessionStatus(...args);
export const cleanupSessions = (...args) => defaultSessionManager.cleanupSessions(...args);
export const shutdownSessions = (...args) => defaultSessionManager.shutdownSessions(...args);
export const discardSession = (...args) => defaultSessionManager.discardSession(...args);
