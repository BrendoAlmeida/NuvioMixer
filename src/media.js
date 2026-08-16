import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { resolveTorrent } from './stremio.js';

const sessions = new Map();
const supportedVideo = new Set(['h264', 'hevc', 'av1']);
const supportedAudio = new Set(['aac', 'ac3', 'eac3', 'opus', 'mp3']);

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
  return source.kind === 'torrent' ? resolveTorrent(source) : source;
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

function cleanSessionDirectory(id) {
  const directory = join(config.dataDir, 'sessions', id);
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  return directory;
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

function stopSession(id) {
  const session = sessions.get(id);
  if (!session) return;
  if (!session.child.killed) session.child.kill('SIGTERM');
  sessions.delete(id);
}

export function discardSession(id) {
  stopSession(id);
  rmSync(join(config.dataDir, 'sessions', id), { recursive: true, force: true });
}

function isFinalPlaylist(playlist) {
  return existsSync(playlist) && statSync(playlist).size > 0 && readFileSync(playlist, 'utf8').includes('#EXT-X-ENDLIST');
}

async function waitForFinalPlaylist(directory, child) {
  const playlist = join(directory, 'master.m3u8');
  const started = Date.now();
  while (Date.now() - started < config.streamStartTimeoutMs) {
    if (isFinalPlaylist(playlist)) return;
    if (child.exitCode !== null) throw new Error('O FFmpeg encerrou antes de produzir a playlist.');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`A preparação da stream demorou mais de ${Math.ceil(config.streamStartTimeoutMs / 1000)}s.`);
}

export async function ensureSession(mix) {
  let session = sessions.get(mix.id);
  if (session && session.child.exitCode === null) {
    session.lastAccess = Date.now();
    return session;
  }
  const check = await preflight(mix.video, mix.audio, mix.audioOffsetSeconds);
  const directory = cleanSessionDirectory(mix.id);
  const audioCodec = check.audio.streams.find((stream) => stream.codecType === 'audio')?.codecName;
  const args = buildFfmpegArgs({ ...mix, video: check.video.source, audio: check.audio.source }, directory, audioCodec);
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  session = { id: mix.id, directory, child, lastAccess: Date.now(), stderr, preflight: check };
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); session.stderr = stderr; });
  child.on('close', () => { session.finishedAt = Date.now(); });
  sessions.set(mix.id, session);
  try {
    await waitForFinalPlaylist(directory, child);
    return session;
  } catch (error) {
    discardSession(mix.id);
    throw error;
  }
}

export function getSessionFile(mixId, filename) {
  const session = sessions.get(mixId);
  if (!session) return null;
  session.lastAccess = Date.now();
  if (!/^(master\.m3u8|init\.mp4|segment-\d{5}\.m4s)$/.test(filename)) return null;
  const path = join(session.directory, filename);
  return existsSync(path) ? path : null;
}

export function sessionStatus(mixId) {
  const session = sessions.get(mixId);
  if (!session) return null;
  return { running: session.child.exitCode === null, lastAccess: session.lastAccess, preflight: session.preflight, stderr: session.stderr };
}

export function cleanupSessions() {
  for (const [id, session] of sessions) if (Date.now() - session.lastAccess > config.sessionIdleMs) stopSession(id);
  const root = join(config.dataDir, 'sessions');
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const directory = join(root, entry.name);
    if (entry.isDirectory() && !sessions.has(entry.name) && Date.now() - statSync(directory).mtimeMs > config.sessionIdleMs) rmSync(directory, { recursive: true, force: true });
  }
}

export function shutdownSessions() { for (const id of sessions.keys()) stopSession(id); }
