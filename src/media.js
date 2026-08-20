import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { isPlayableFmp4, patchFmp4Duration } from './fmp4.js';
import { resolveSource } from './stremio.js';

const supportedVideo = new Set(['h264', 'hevc', 'av1']);
const supportedAudio = new Set(['aac', 'ac3', 'eac3', 'opus', 'mp3']);
const filesystem = { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync };
// A VOD cache is a media container, not just a download. Bump this whenever
// its playlist semantics change so a new player never combines old fragments
// with a newer manifest.
const vodCacheSchema = 3;

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

function seekInputArguments(source, seconds, duration) {
  const args = ['-ss', String(Math.max(0, seconds))];
  if (duration) args.push('-t', String(duration));
  return [...args, ...inputArguments(source)];
}

function mediaTime(value) { return Math.round(Number(value) * 1_000_000) / 1_000_000; }

function segmentNumber(index) { return String(index).padStart(5, '0'); }

export function vodSegmentName(index) { return `vod-segment-${segmentNumber(index)}-000.m4s`; }

function vodSegmentTemplate(index) { return `vod-segment-${segmentNumber(index)}-%03d.m4s`; }

function vodInitName(index) { return index === 0 ? 'vod-init.mp4' : `vod-init-${segmentNumber(index)}.mp4`; }

function vodChunkPlaylistName(index) { return `chunk-${segmentNumber(index)}.m3u8`; }

export function buildVodTimeline(keyframeTimes, duration, targetSeconds) {
  const keyframes = [...new Set((keyframeTimes || [])
    .map(mediaTime)
    .filter((time) => Number.isFinite(time) && time >= 0))]
    .sort((left, right) => left - right);
  const first = keyframes[0];
  if (!Number.isFinite(first) || !Number.isFinite(duration) || duration <= 0) throw new Error('Não foi possível indexar keyframes suficientes para a reprodução buscável.');
  const end = mediaTime(first + duration);
  const starts = [first];
  let current = first, keyframeIndex = 0;
  while (true) {
    while (keyframeIndex < keyframes.length && keyframes[keyframeIndex] < current + targetSeconds) keyframeIndex += 1;
    const next = keyframes[keyframeIndex];
    if (!Number.isFinite(next) || next >= end) break;
    starts.push(next);
    current = next;
  }
  return starts.map((sourceStart, index) => {
    const next = starts[index + 1] ?? end;
    return { sourceStart, duration: mediaTime(next - sourceStart) };
  }).filter((segment) => segment.duration > 0.001);
}

export function buildVodPlaylist(timeline, segmentInfo = {}) {
  if (!Array.isArray(timeline) || !timeline.length) throw new Error('A timeline VOD não possui segmentos reproduzíveis.');
  const durations = timeline.map((segment, index) => {
    const duration = Number(segmentInfo[index]?.duration);
    return Number.isFinite(duration) && duration > 0 ? duration : segment.duration;
  });
  const lines = [
    '#EXTM3U', '#EXT-X-VERSION:7',
    `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(...durations))}`,
    '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS', '#EXT-X-MAP:URI="vod-init.mp4"'
  ];
  for (let index = 0; index < timeline.length; index += 1) {
    const recorded = segmentInfo[index] || {};
    const duration = Number(recorded.duration);
    // The FFmpeg-produced EXTINF is authoritative. The keyframe timeline is
    // only a fallback for fragments that have not been produced yet.
    const actualDuration = durations[index];
    if (index && recorded.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
    lines.push(`#EXTINF:${actualDuration.toFixed(6)},`, vodSegmentName(index));
  }
  lines.push('#EXT-X-ENDLIST', '');
  return lines.join('\n');
}

/** ffprobe reads the source once to locate keyframes; the cached result contains no source URL or credentials. */
export async function probeVideoKeyframes(source, timeoutMs = config.keyframeIndexTimeoutMs) {
  const headers = headersArgument(source.headers);
  const args = ['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_frames', '-show_entries', 'frame=key_frame,best_effort_timestamp_time', '-of', 'json'];
  if (headers) args.push('-headers', headers);
  args.push(source.url);
  const { stdout } = await run('ffprobe', args, timeoutMs);
  return (JSON.parse(stdout).frames || [])
    .filter((frame) => Number(frame.key_frame) === 1)
    .map((frame) => Number(frame.best_effort_timestamp_time))
    .filter(Number.isFinite);
}

export function timelineCacheId(source, duration, targetSeconds) {
  const canonical = JSON.stringify({ url: source.url, headers: Object.entries(source.headers || {}).sort(([left], [right]) => left.localeCompare(right)), duration, targetSeconds });
  return createHash('sha256').update(canonical).digest('hex');
}

function timelineCachePath(source, duration, targetSeconds) {
  return join(config.dataDir, 'keyframes', `${timelineCacheId(source, duration, targetSeconds)}.json`);
}

export async function buildVodTimelineFromSource(source, duration, targetSeconds, timeoutMs = config.keyframeIndexTimeoutMs) {
  const path = timelineCachePath(source, duration, targetSeconds);
  try {
    const cached = JSON.parse(readFileSync(path, 'utf8'));
    if (cached?.duration === duration && cached?.targetSeconds === targetSeconds && Array.isArray(cached.timeline) && cached.timeline.length) return cached.timeline;
  } catch { /* The source may not have been indexed yet, or an interrupted cache is ignored. */ }
  const timeline = buildVodTimeline(await probeVideoKeyframes(source, timeoutMs), duration, targetSeconds);
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ duration, targetSeconds, timeline }), { mode: 0o600 });
  renameSync(temporary, path);
  return timeline;
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
  if (!supportedVideo.has(video.codecName)) throw new Error(`Vídeo ${video.codecName} não é aceito sem recodificação.`);
  if (!supportedAudio.has(audio.codecName)) throw new Error(`Áudio ${audio.codecName} não é aceito sem recodificação.`);
  if (!videoProbe.duration || !audioProbe.duration) throw new Error('Não foi possível determinar a duração das duas fontes.');
  const { adjustedAudioDuration, durationDriftSeconds } = durationAssessment(videoProbe.duration, audioProbe.duration, audioOffsetSeconds);
  const duration = Math.min(videoProbe.duration, adjustedAudioDuration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('A combinação não possui uma duração reproduzível após o offset do áudio.');
  return {
    video: videoProbe,
    audio: audioProbe,
    duration,
    adjustedAudioDuration,
    durationDriftSeconds,
    compatible: true
  };
}

export function buildFfmpegArgs(mix, directory, audioCodec, transport = 'hls') {
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
  if (transport === 'fmp4') {
    args.push(
      // E-AC-3 needs its first packets parsed before FFmpeg can write the MP4
      // initialization atom. delay_moov waits only for that first fragment.
      '-f', 'mp4', '-movflags', '+empty_moov+delay_moov+frag_keyframe+default_base_moof', '-flush_packets', '1',
      join(directory, 'stream.mp4')
    );
  } else {
    args.push(
      // An EVENT playlist is append-only while FFmpeg is running. It lets a client
      // start from the first complete fMP4 segment instead of waiting for the whole
      // title to be repackaged as a VOD playlist.
      '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0', '-hls_playlist_type', 'event', '-hls_flags', 'temp_file',
      '-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_segment_filename', join(directory, 'segment-%05d.m4s'),
      join(directory, 'master.m3u8')
    );
  }
  return args;
}

export function buildVodSegmentArgs(mix, directory, audioCodec, { index, sourceStart, duration }) {
  const audioOffset = Number(mix.audioOffsetSeconds || 0);
  const audioStart = Math.max(0, sourceStart - audioOffset);
  // Keep the diagnostics panel actionable. FFmpeg writes normal container and
  // stream metadata to stderr, so only error-level output should be retained.
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  args.push(...seekInputArguments(mix.video, sourceStart, duration));
  if (audioOffset) args.push('-itsoffset', String(audioOffset));
  args.push(...seekInputArguments(mix.audio, audioStart, duration));
  args.push(
    '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-map_metadata', '0',
    '-c:v', 'copy', '-c:a', 'copy', '-copyts', '-start_at_zero'
  );
  if (audioCodec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  args.push(
    // The source starts on a real keyframe and hls_time exceeds the indexed
    // interval, so FFmpeg emits one complete, independently decodable segment.
    '-f', 'hls', '-hls_time', String(duration + 1), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_flags', 'temp_file+independent_segments', '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', vodInitName(index),
    '-hls_segment_filename', join(directory, vodSegmentTemplate(index)),
    join(directory, vodChunkPlaylistName(index))
  );
  return args;
}

/**
 * Produces a whole requested VOD interval in one remuxing pass. The delivery
 * remains HLS/fMP4, but the sources are read continuously instead of reopened
 * once for every cached fragment.
 */
export function buildContinuousVodPreloadArgs(mix, directory, audioCodec, { startIndex, sourceStart, duration, targetSeconds }) {
  const audioOffset = Number(mix.audioOffsetSeconds || 0);
  const audioStart = Math.max(0, sourceStart - audioOffset);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  args.push(...seekInputArguments(mix.video, sourceStart, duration));
  if (audioOffset) args.push('-itsoffset', String(audioOffset));
  args.push(...seekInputArguments(mix.audio, audioStart, duration));
  args.push(
    '-map', '0:v:0', '-map', '1:a:0', '-shortest', '-map_metadata', '0',
    '-c:v', 'copy', '-c:a', 'copy', '-copyts', '-start_at_zero'
  );
  if (audioCodec === 'aac') args.push('-bsf:a', 'aac_adtstoasc');
  args.push(
    '-f', 'hls', '-hls_time', String(targetSeconds), '-hls_list_size', '0', '-hls_playlist_type', 'vod',
    '-hls_flags', 'temp_file+independent_segments', '-start_number', String(startIndex), '-hls_segment_type', 'fmp4',
    '-hls_fmp4_init_filename', 'vod-init.mp4',
    '-hls_segment_filename', join(directory, 'vod-segment-%05d-000.m4s'),
    join(directory, `preload-${segmentNumber(startIndex)}.m3u8`)
  );
  return args;
}

/**
 * Creates progressive HLS and fMP4 sessions. Dependency injection keeps its concurrent
 * state machine testable without starting FFmpeg or touching the host filesystem.
 */
export function createSessionManager({
  sessionConfig = config,
  fileSystem = filesystem,
  spawnProcess = spawn,
  preflightSource = preflight,
  buildVodTimelineSource = buildVodTimelineFromSource,
  patchFmp4Header = patchFmp4Duration,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  generateId = randomUUID
} = {}) {
  const sessions = new Map();
  const preloadTasks = new Map();
  const preloadSubscribers = new Set();
  const root = join(sessionConfig.dataDir, 'sessions');
  const preloadRoot = join(sessionConfig.dataDir, 'preloads');
  const playlistFor = (directory) => join(directory, 'master.m3u8');
  const mp4For = (directory) => join(directory, 'stream.mp4');
  const vodPlaylistFor = (directory) => join(directory, 'vod.m3u8');
  const sessionKey = (mixId, transport) => `${transport}:${mixId}`;
  const cacheInfoName = 'preload.json';

  function redactDiagnostic(value) {
    return String(value || '')
      .replace(/https?:\/\/[^\s'"<>]+/gi, '[URL OCULTA]')
      .replace(/\b(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, (entry) => `${entry.split(/[:=]/)[0]}: [OCULTO]`)
      .slice(-1200);
  }

  function cacheFingerprint(mix, check) {
    const normalize = (source) => source?.kind === 'torrent'
      ? { kind: 'torrent', infoHash: source.infoHash, fileIdx: source.fileIdx }
      : { kind: 'url', url: source?.url, headers: Object.entries(source?.headers || {}).sort(([left], [right]) => left.localeCompare(right)) };
    return createHash('sha256').update(JSON.stringify({
      video: normalize(check.video.source), audio: normalize(check.audio.source), duration: check.duration,
      offset: Number(mix.audioOffsetSeconds || 0), targetSeconds: sessionConfig.seekSegmentSeconds || 4,
      cacheSchema: vodCacheSchema
    })).digest('hex');
  }

  function cacheDirectory(mixId, fingerprint) { return join(preloadRoot, mixId, fingerprint); }
  function cacheInfoPath(directory) { return join(directory, cacheInfoName); }

  function readCacheInfo(directory) {
    try {
      const value = JSON.parse(fileSystem.readFileSync(cacheInfoPath(directory), 'utf8'));
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  }

  function writeCacheInfo(session) {
    if (!session.persistent || !session.directory || session.cancelled) return;
    const previous = readCacheInfo(session.directory) || {};
    const payload = {
      version: vodCacheSchema,
      cacheSchema: vodCacheSchema,
      mixId: session.id,
      cacheKey: session.cacheKey,
      createdAt: previous.createdAt || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(),
      duration: session.preflight?.duration || previous.duration || null,
      timeline: session.vodTimeline || previous.timeline || [],
      segmentInfo: session.vodSegmentInfo || previous.segmentInfo || {},
      renderedPreloadPlaylist: session.renderedPreloadPlaylist || previous.renderedPreloadPlaylist || null,
      keyframeCacheId: session.keyframeCacheId || previous.keyframeCacheId || null,
      state: session.cacheState || previous.state || 'partial',
      events: (session.events || previous.events || []).slice(-80),
      warnings: session.warnings || previous.warnings || []
    };
    fileSystem.writeFileSync(cacheInfoPath(session.directory), JSON.stringify(payload));
  }

  function writeVodPlaylist(session) {
    if (!session.persistent || !session.directory || !session.vodTimeline?.length) return;
    fileSystem.writeFileSync(vodPlaylistFor(session.directory), buildVodPlaylist(session.vodTimeline, session.vodSegmentInfo));
  }

  function playlistDurations(path) {
    try {
      const lines = String(fileSystem.readFileSync(path)).split(/\r?\n/);
      const entries = [];
      let duration = null;
      for (const line of lines) {
        const extinf = /^#EXTINF:([0-9.]+)/.exec(line);
        if (extinf) {
          duration = Number(extinf[1]);
          continue;
        }
        const segment = /^vod-segment-(\d{5})-000\.m4s$/.exec(line);
        if (segment && Number.isFinite(duration) && duration > 0) entries.push({ index: Number(segment[1]), duration });
        if (segment) duration = null;
      }
      return entries;
    } catch { return []; }
  }

  function recordPlaylistDurations(session, path, { discontinuityAt = null } = {}) {
    const entries = playlistDurations(path);
    if (!entries.length) return false;
    for (const entry of entries) {
      const previous = session.vodSegmentInfo[entry.index] || {};
      session.vodSegmentInfo[entry.index] = {
        ...previous,
        duration: entry.duration,
        discontinuity: previous.discontinuity || (discontinuityAt === entry.index && entry.index > 0)
      };
    }
    writeVodPlaylist(session);
    writeCacheInfo(session);
    return true;
  }

  /**
   * The HLS muxer is the authority on where copied media can be cut. Its
   * output can contain a different number of fragments than a keyframe probe
   * predicted, so after a continuous preload we rebuild the delivery timeline
   * around the actual playlist instead of assigning its files to guessed
   * keyframe indexes.
   */
  function rebaseTimelineFromContinuousPlaylist(session, path, first) {
    const entries = playlistDurations(path).sort((left, right) => left.index - right.index);
    if (!entries.length || entries[0].index !== first || entries.some((entry, offset) => entry.index !== first + offset)) return false;
    const previous = session.vodTimeline || [];
    const sourceStart = previous[first]?.sourceStart;
    if (!Number.isFinite(sourceStart)) return false;

    let sourceCursor = sourceStart;
    const generated = entries.map((entry, offset) => {
      const segment = { sourceStart: sourceCursor, duration: entry.duration };
      sourceCursor += entry.duration;
      const prior = session.vodSegmentInfo[entry.index] || {};
      session.vodSegmentInfo[entry.index] = {
        ...prior,
        duration: entry.duration,
        discontinuity: prior.discontinuity || (offset === 0 && first > 0)
      };
      return segment;
    });

    // Resume from the first independently decodable source keyframe after
    // the locally rendered interval. This can leave only a tiny keyframe-gap,
    // rather than jumping by the difference between two segment counts.
    const suffixStart = previous.findIndex((segment, index) => index >= first && segment.sourceStart >= sourceCursor - 0.001);
    const suffix = suffixStart < 0 ? [] : previous.slice(suffixStart);
    session.vodTimeline = [...previous.slice(0, first), ...generated, ...suffix];
    const fallbackIndex = first + generated.length;
    if (suffix.length) {
      // This segment will be created on demand by a separate FFmpeg process.
      // Advertise the reset before the player asks for it, since a VOD
      // playlist normally is not refreshed at that boundary.
      session.vodSegmentInfo[fallbackIndex] = {
        ...(session.vodSegmentInfo[fallbackIndex] || {}),
        discontinuity: true
      };
    }
    session.renderedPreloadPlaylist = path.slice(session.directory.length + 1);
    writeVodPlaylist(session);
    writeCacheInfo(session);
    return true;
  }

  function sessionEvent(session, level, message) {
    const event = { at: new Date(now()).toISOString(), level, message: redactDiagnostic(message) };
    session.events = [...(session.events || []), event].slice(-80);
    writeCacheInfo(session);
    for (const subscriber of preloadSubscribers) if (subscriber.mixId === session.id) subscriber.listener(preloadStatus(session.id));
  }

  function taskEvent(task, level, message) {
    task.events = [...task.events, { at: new Date(now()).toISOString(), level, message: redactDiagnostic(message) }].slice(-80);
    for (const subscriber of preloadSubscribers) if (subscriber.mixId === task.mixId) subscriber.listener(preloadStatus(task.mixId));
  }

  function readDirectories(directory) {
    try { return fileSystem.readdirSync(directory, { withFileTypes: true }); } catch { return []; }
  }

  function fileBytes(directory) {
    let total = 0;
    for (const entry of readDirectories(directory)) {
      const path = join(directory, entry.name);
      if (entry.isDirectory?.()) total += fileBytes(path);
      else {
        try { total += fileSystem.statSync(path).size || 0; } catch { /* A file can disappear during cleanup. */ }
      }
    }
    return total;
  }

  function cacheEntries(mixId) {
    return readDirectories(join(preloadRoot, mixId))
      .filter((entry) => entry.isDirectory?.())
      .map((entry) => {
        const directory = join(preloadRoot, mixId, entry.name);
        const info = readCacheInfo(directory);
        return info?.cacheSchema === vodCacheSchema ? { directory, info } : null;
      })
      .filter(Boolean)
      .sort((left, right) => {
        const count = (entry) => (entry.info.timeline || []).reduce((total, _segment, index) => total + (fileSystem.existsSync(join(entry.directory, vodSegmentName(index))) ? 1 : 0), 0);
        return count(right) - count(left) || String(right.info.updatedAt).localeCompare(String(left.info.updatedAt));
      });
  }

  function publicCache(entry) {
    const timeline = entry.info.timeline || [];
    let elapsed = 0;
    const cachedRanges = [];
    for (let index = 0; index < timeline.length; index += 1) {
      const duration = Number(timeline[index].duration || 0);
      const startSeconds = elapsed;
      elapsed += duration;
      if (!fileSystem.existsSync(join(entry.directory, vodSegmentName(index)))) continue;
      const previous = cachedRanges.at(-1);
      if (previous && Math.abs(previous.endSeconds - startSeconds) < 0.01) previous.endSeconds = elapsed;
      else cachedRanges.push({ startSeconds, endSeconds: elapsed });
    }
    const preparedSegments = timeline.reduce((count, _segment, index) => count + (fileSystem.existsSync(join(entry.directory, vodSegmentName(index))) ? 1 : 0), 0);
    return {
      cacheKey: entry.info.cacheKey,
      state: entry.info.state || (preparedSegments ? 'partial' : 'idle'),
      duration: entry.info.duration || null,
      totalSegments: timeline.length,
      preparedSegments,
      cachedRanges,
      bytes: fileBytes(entry.directory),
      updatedAt: entry.info.updatedAt || null,
      events: (entry.info.events || []).slice(-80),
      warnings: entry.info.warnings || []
    };
  }

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

  function isPlayablePlaylist(directory) {
    const playlist = playlistFor(directory);
    try {
      if (!fileSystem.existsSync(playlist) || fileSystem.statSync(playlist).size === 0) return false;
      const content = fileSystem.readFileSync(playlist, 'utf8');
      const init = /#EXT-X-MAP:URI="([^"]+)"/.exec(content)?.[1];
      const segment = content.split('\n').find((line) => /^segment-\d{5}\.m4s$/.test(line));
      return Boolean(init && segment
        && fileSystem.existsSync(join(directory, init))
        && fileSystem.existsSync(join(directory, segment)));
    } catch {
      // A playlist and a segment can be replaced atomically by FFmpeg while this
      // check runs. The next poll will retry against the new files.
      return false;
    }
  }

  function isPlayableMp4(session) {
    const output = mp4For(session.directory);
    try {
      if (!fileSystem.existsSync(output) || fileSystem.statSync(output).size === 0) return false;
      if (!isPlayableFmp4(fileSystem.readFileSync(output))) return false;
      if (!session.durationPatched) {
        if (!patchFmp4Header(output, session.preflight.duration)) return false;
        session.durationPatched = true;
      }
      return true;
    } catch {
      return false;
    }
  }

  function isPlayableVod(session) {
    try {
      return Boolean(session.directory
        && fileSystem.existsSync(vodPlaylistFor(session.directory))
        && fileSystem.existsSync(join(session.directory, 'vod-init.mp4'))
        && fileSystem.existsSync(join(session.directory, vodSegmentName(0))));
    } catch { return false; }
  }

  function isPlayableOutput(session) {
    if (session.transport === 'fmp4') return isPlayableMp4(session);
    if (session.transport === 'vod') return isPlayableVod(session);
    return isPlayablePlaylist(session.directory);
  }

  function isFinalOutput(session) {
    if (session.transport === 'fmp4') return Boolean(session.child && session.child.exitCode === 0);
    if (session.transport === 'vod') return isPlayableVod(session);
    return isFinalPlaylist(session.directory);
  }

  function isCurrent(session) {
    return sessions.get(session.key) === session && !session.cancelled;
  }

  function stopSession(key) {
    const session = sessions.get(key);
    if (!session) return null;
    session.cancelled = true;
    if (session.child && session.child.exitCode === null && !session.child.killed) session.child.kill('SIGTERM');
    if (session.preloadChild && session.preloadChild.exitCode === null && !session.preloadChild.killed) session.preloadChild.kill('SIGTERM');
    for (const child of session.children || []) if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
    for (const item of session.vodQueue || []) item.reject(new Error('A preparação da stream foi cancelada.'));
    session.vodQueue = [];
    for (const deferred of session.continuousPending?.values() || []) deferred.reject(new Error('A preparação da stream foi cancelada.'));
    session.continuousPending?.clear();
    sessions.delete(key);
    return session;
  }

  function waitForVodSegment(session, index, child) {
    const output = join(session.directory, vodSegmentName(index));
    const init = index === 0 ? join(session.directory, 'vod-init.mp4') : null;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.children.delete(child);
        if (error) reject(error);
        else resolve();
      };
      timer = setTimeout(() => {
        if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
        finish(new Error(`A preparação do segmento buscável demorou mais de ${Math.ceil(sessionConfig.streamStartTimeoutMs / 1000)}s.`));
      }, sessionConfig.streamStartTimeoutMs);
      child.on('error', () => finish(new Error('O FFmpeg não pôde iniciar a preparação do segmento buscável.')));
      child.on('close', (code) => {
        session.finishedAt = now();
        finish(code === 0 && fileSystem.existsSync(output) && (!init || fileSystem.existsSync(init)) ? null : new Error('O FFmpeg encerrou antes de produzir o segmento buscável.'));
      });
    });
  }

  function waitForContinuousPreload(session, child) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        session.children.delete(child);
        if (session.preloadChild === child) session.preloadChild = null;
        if (error) reject(error);
        else resolve();
      };
      child.on('error', () => finish(new Error('O FFmpeg não pôde iniciar o preload contínuo.')));
      child.on('close', (code) => {
        session.finishedAt = now();
        finish(code === 0 ? null : new Error('O FFmpeg encerrou antes de concluir o intervalo solicitado.'));
      });
    });
  }

  function rateLimited(diagnostic) {
    return /(?:HTTP\s+error\s+429|429\s+Too\s+Many\s+Requests)/i.test(String(diagnostic || ''));
  }

  async function waitForVodCooldown(session) {
    const remaining = Math.max(0, Number(session.rateLimitUntil || 0) - now());
    if (remaining) await sleep(remaining);
  }

  function vodSegmentFailure(diagnostic, fallback) {
    if (rateLimited(diagnostic)) {
      return new Error('A fonte continua limitando requisições (HTTP 429) após as tentativas automáticas. O cache já preparado foi preservado; tente retomar o preload em alguns minutos.');
    }
    if (/(?:HTTP\s+error\s+403|403\s+Forbidden)/i.test(String(diagnostic || ''))) {
      return new Error('A fonte recusou acesso (HTTP 403) enquanto o segmento era preparado. Atualize a combinação ou tente novamente para renovar o link temporário.');
    }
    return fallback;
  }

  function prepareVodSegmentForSession(session, index) {
    const segment = session.vodTimeline?.[index];
    if (!segment) return Promise.reject(new Error('Segmento buscável fora da duração da mídia.'));
    const output = join(session.directory, vodSegmentName(index));
    if (fileSystem.existsSync(output)) return Promise.resolve();
    const audioCodec = session.preflight.audio.streams.find((stream) => stream.codecType === 'audio')?.codecName;
    const args = buildVodSegmentArgs({ ...session.mix, video: session.preflight.video.source, audio: session.preflight.audio.source }, session.directory, audioCodec, { index, ...segment });
    // Providers frequently answer 429 for a few minutes during maintenance or
    // when their debrid cache is warming up. Keep the cache resumable and give
    // that window time to recover instead of failing after only 50 seconds.
    const retryDelays = [5_000, 15_000, 30_000, 60_000, 120_000];
    const attempt = async (retry = 0) => {
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
      await waitForVodCooldown(session);
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
      session.stderr = '';
      sessionEvent(session, 'info', retry ? `Tentando novamente o segmento ${index + 1} após limite temporário da fonte.` : `Preparando segmento ${index + 1} de ${session.vodTimeline.length}.`);
      const child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      session.children.add(child);
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
        session.stderr = stderr;
      });
      try {
        await waitForVodSegment(session, index, child);
        // A standalone request starts a fresh fMP4 timeline. Marking it as a
        // discontinuity lets HLS players reset safely instead of carrying the
        // timestamp base from the preceding continuous cache block.
        recordPlaylistDurations(session, join(session.directory, vodChunkPlaylistName(index)), { discontinuityAt: index });
      } catch (error) {
        // A debrid CDN can close a first range request before FFmpeg has any
        // diagnostic to report. Treat an empty diagnostic like an interrupted
        // read and retry it, while retaining the specific 429 message below.
        const retryable = rateLimited(stderr) || sourceInterrupted(stderr) || !String(stderr).trim();
        if (retryable && retry < retryDelays.length && isCurrent(session)) {
          const delay = retryDelays[retry];
          session.rateLimitUntil = Math.max(Number(session.rateLimitUntil || 0), now() + delay);
          sessionEvent(session, 'warning', rateLimited(stderr)
            ? `A fonte limitou as requisições; aguardando ${Math.ceil(delay / 1000)} s antes de continuar.`
            : `A fonte interrompeu a leitura inicial; aguardando ${Math.ceil(delay / 1000)} s antes de tentar novamente.`);
          await sleep(delay);
          return attempt(retry + 1);
        }
        throw vodSegmentFailure(stderr, error);
      }
    };
    return attempt();
  }

  function drainVodQueue(session) {
    while (isCurrent(session) && session.vodActiveSegments < session.vodMaxConcurrent && session.vodQueue.length) {
      const item = session.vodQueue.shift();
      session.vodActiveSegments += 1;
      void Promise.resolve()
        .then(() => prepareVodSegmentForSession(session, item.index))
        .then(() => {
          sessionEvent(session, 'success', `Segmento ${item.index + 1} pronto localmente.`);
          item.resolve();
        }, (error) => {
          sessionEvent(session, 'error', error.message || 'Falha ao preparar um segmento.');
          item.reject(error);
        })
        .finally(() => {
          if (session.segmentJobs.get(item.index) === item.job) session.segmentJobs.delete(item.index);
          session.vodActiveSegments = Math.max(0, session.vodActiveSegments - 1);
          drainVodQueue(session);
        });
    }
  }

  function ensureVodSegmentForSession(session, index, { background = false } = {}) {
    const segment = session.vodTimeline?.[index];
    if (!segment) return Promise.reject(new Error('Segmento buscável fora da duração da mídia.'));
    const output = join(session.directory, vodSegmentName(index));
    if (fileSystem.existsSync(output)) return Promise.resolve();
    const existing = session.segmentJobs.get(index);
    if (existing) return existing;
    const continuous = session.continuousPending.get(index);
    if (continuous) return continuous.promise;

    let resolveJob, rejectJob;
    const job = new Promise((resolve, reject) => { resolveJob = resolve; rejectJob = reject; });
    session.segmentJobs.set(index, job);
    const item = { index, job, resolve: resolveJob, reject: rejectJob };
    // A viewer seeking is allowed to pass pending background work, but never
    // interrupts an active remux that is already writing a cache fragment.
    if (background) session.vodQueue.push(item);
    else session.vodQueue.unshift(item);
    drainVodQueue(session);
    return job;
  }

  function notifyPreload(task) {
    for (const subscriber of preloadSubscribers) if (subscriber.mixId === task.mixId) subscriber.listener(preloadStatus(task.mixId));
  }

  function updateContinuousPreload(task, session, indexes) {
    const prepared = indexes.filter((index) => fileSystem.existsSync(join(session.directory, vodSegmentName(index))));
    const pending = indexes.filter((index) => !fileSystem.existsSync(join(session.directory, vodSegmentName(index))));
    task.completedSegments = prepared.length;
    task.currentSegment = pending.length ? pending[0] + 1 : null;
    task.activeSegments = pending.length ? [pending[0] + 1] : [];
    const elapsedMs = Math.max(1, now() - task.startedAt);
    task.transferredBytes = Math.max(0, fileBytes(session.directory) - task.initialBytes);
    task.speedBytesPerSecond = task.transferredBytes / (elapsedMs / 1000);
    task.updatedAt = new Date(now()).toISOString();
    notifyPreload(task);
  }

  function settleContinuousSegments(session, error = null) {
    for (const [index, deferred] of session.continuousPending) {
      if (fileSystem.existsSync(join(session.directory, vodSegmentName(index)))) {
        session.continuousPending.delete(index);
        deferred.resolve();
      } else if (error) {
        session.continuousPending.delete(index);
        deferred.reject(error);
      }
    }
  }

  function registerContinuousSegments(session, indexes) {
    for (const index of indexes) {
      if (fileSystem.existsSync(join(session.directory, vodSegmentName(index))) || session.continuousPending.has(index)) continue;
      let resolve, reject;
      const promise = new Promise((nextResolve, nextReject) => { resolve = nextResolve; reject = nextReject; });
      // The promise is consumed only when a client requests that particular
      // fragment while the continuous preload is running.
      promise.catch(() => {});
      session.continuousPending.set(index, { promise, resolve, reject });
    }
  }

  function sourceInterrupted(diagnostic) {
    return rateLimited(diagnostic)
      || /(?:stream ends prematurely|read error at pos|connection reset|i\/o error|resource temporarily unavailable|timed out)/i.test(String(diagnostic || ''));
  }

  async function preloadContinuousBlock(session, task, indexes) {
    const first = indexes[0];
    const timeline = session.vodTimeline;
    const sourceStart = timeline[first].sourceStart;
    const duration = indexes.reduce((total, index) => total + timeline[index].duration, 0);
    const audioCodec = session.preflight.audio.streams.find((stream) => stream.codecType === 'audio')?.codecName;
    const args = buildContinuousVodPreloadArgs({ ...session.mix, video: session.preflight.video.source, audio: session.preflight.audio.source }, session.directory, audioCodec, {
      startIndex: first, sourceStart, duration, targetSeconds: sessionConfig.seekSegmentSeconds || 4
    });
    // This worker is also used by normal VOD playback. Keep its retry window
    // consistent with an on-demand fragment so a transient debrid/CDN limit
    // does not turn into a new FFmpeg process for the very next segment.
    const retryDelays = [5_000, 15_000, 30_000, 60_000, 120_000];
    registerContinuousSegments(session, indexes);
    for (let attempt = 0; ; attempt += 1) {
      if (task.cancelled || !isCurrent(session)) throw new Error('O preload contínuo foi cancelado.');
      task.currentSegment = first + 1;
      task.activeSegments = [first + 1];
      task.updatedAt = new Date(now()).toISOString();
      session.stderr = '';
      sessionEvent(session, 'info', attempt ? `Retomando o cache contínuo a partir do segmento ${first + 1}.` : `Preparando continuamente os segmentos ${first + 1} a ${indexes.at(-1) + 1}.`);
      const child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      session.children.add(child);
      session.preloadChild = child;
      let stderr = '';
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
        session.stderr = stderr;
      });
      // Resolve a waiting HLS request as soon as FFmpeg atomically publishes a
      // fragment. One second here is long enough to look like a pause at a
      // segment boundary, even when the bytes are already on disk.
      const meter = setInterval(() => {
        settleContinuousSegments(session);
        updateContinuousPreload(task, session, task.indexes);
      }, 200);
      meter.unref?.();
      try {
        await waitForContinuousPreload(session, child);
        settleContinuousSegments(session);
        // HLS chooses the exact cuts after remuxing. Persist those EXTINF
        // values rather than the preliminary keyframe estimates used to plan
        // the preload; Nuvio relies on the playlist clock for seeking.
        recordPlaylistDurations(session, join(session.directory, `preload-${segmentNumber(first)}.m3u8`), { discontinuityAt: first });
        rebaseTimelineFromContinuousPlaylist(session, join(session.directory, `preload-${segmentNumber(first)}.m3u8`), first);
        updateContinuousPreload(task, session, task.indexes);
        const missing = indexes.filter((index) => !fileSystem.existsSync(join(session.directory, vodSegmentName(index))));
        if (!missing.length) return;
        throw new Error('O FFmpeg encerrou antes de produzir todo o intervalo contínuo solicitado.');
      } catch (error) {
        // Some CDNs close the first range read before FFmpeg has emitted a
        // diagnostic. It is still a transient source interruption, not a
        // reason to fall back to a per-segment remux.
        const retryable = sourceInterrupted(stderr) || !String(stderr).trim();
        if (retryable && attempt < retryDelays.length && isCurrent(session) && !task.cancelled) {
          const delay = retryDelays[attempt];
          sessionEvent(session, 'warning', rateLimited(stderr)
            ? `A fonte limitou as requisições contínuas; aguardando ${Math.ceil(delay / 1000)} s antes de retomar.`
            : `A origem interrompeu a leitura contínua; aguardando ${Math.ceil(delay / 1000)} s antes de retomar.`);
          await sleep(delay);
          continue;
        }
        const failure = vodSegmentFailure(stderr, error);
        settleContinuousSegments(session, failure);
        throw failure;
      } finally {
        clearInterval(meter);
      }
    }
  }

  function missingContinuousBlocks(session, indexes) {
    const blocks = [];
    let current = [];
    for (const index of indexes) {
      if (fileSystem.existsSync(join(session.directory, vodSegmentName(index)))) {
        if (current.length) blocks.push(current);
        current = [];
      } else current.push(index);
    }
    if (current.length) blocks.push(current);
    return blocks;
  }

  /**
   * Normal searchable-VOD playback is a continuous remux too. Starting one
   * process at the manifest avoids reopening a remote source at every HLS
   * boundary and keeps all fMP4 fragments on the same timestamp base and init
   * segment. Files become the incremental local cache as they are produced.
   */
  function startVodAutofill(session) {
    if (session.vodAutofillPromise) return session.vodAutofillPromise;
    const indexes = session.vodTimeline
      .map((_segment, index) => index)
      .filter((index) => !fileSystem.existsSync(join(session.directory, vodSegmentName(index))));
    if (!indexes.length) return Promise.resolve();

    const task = {
      mixId: session.id,
      indexes,
      startedAt: now(),
      initialBytes: fileBytes(session.directory),
      completedSegments: 0,
      currentSegment: null,
      activeSegments: [],
      transferredBytes: 0,
      speedBytesPerSecond: 0,
      updatedAt: new Date(now()).toISOString(),
      cancelled: false
    };
    session.vodAutofillTask = task;
    sessionEvent(session, 'info', 'Preparando o VOD continuamente para evitar pausas entre segmentos.');
    const worker = preloadContinuousBlock(session, task, indexes);
    session.vodAutofillPromise = worker;
    // The request for the manifest observes errors through the first fragment;
    // later failures are retained in the diagnostics without an unhandled
    // rejection when no player happens to be waiting at that instant.
    void worker.then(
      () => { if (session.vodAutofillPromise === worker) session.vodAutofillTask = null; },
      (error) => {
        session.vodAutofillError = error;
        if (isCurrent(session)) sessionEvent(session, 'error', error instanceof Error ? error.message : error);
        if (session.vodAutofillPromise === worker) session.vodAutofillTask = null;
      }
    );
    return worker;
  }

  function discardSession(mixId, transport) {
    const keys = transport ? [sessionKey(mixId, transport)] : [...sessions.values()].filter((session) => session.id === mixId).map((session) => session.key);
    for (const key of keys) {
      const session = stopSession(key);
      if (session?.directory && !session.persistent) fileSystem.rmSync(session.directory, { recursive: true, force: true });
    }
  }

  async function waitForPlayableOutput(session) {
    const started = now();
    while (now() - started < sessionConfig.streamStartTimeoutMs) {
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
      if (isPlayableOutput(session)) return;
      if (session.processError) throw session.processError;
      if (session.child?.exitCode !== null) throw new Error('O FFmpeg encerrou antes de produzir a mídia inicial.');
      await sleep(150);
    }
    throw new Error(`A preparação inicial da stream demorou mais de ${Math.ceil(sessionConfig.streamStartTimeoutMs / 1000)}s.`);
  }

  async function prepareSession(mix, session) {
    try {
      const check = await preflightSource(mix.video, mix.audio, mix.audioOffsetSeconds);
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');

      const audioCodec = check.audio.streams.find((stream) => stream.codecType === 'audio')?.codecName;
      session.preflight = check;
      if (session.transport === 'vod') {
        const requestedCacheKey = cacheFingerprint(mix, check);
        // Temporary debrid URLs may rotate even though the saved combination
        // and media did not. Prefer a compatible, substantially populated
        // cache over a brand-new directory so a restart never strands a local
        // preload just because a signed link changed.
        const reusable = cacheEntries(mix.id).find((entry) => {
          const cachedDuration = Number(entry.info.duration);
          const prepared = (entry.info.timeline || []).reduce((total, _segment, index) => total + (fileSystem.existsSync(join(entry.directory, vodSegmentName(index))) ? 1 : 0), 0);
          return prepared > 1 && Number.isFinite(cachedDuration) && Math.abs(cachedDuration - check.duration) < 0.1;
        });
        session.cacheKey = reusable?.info.cacheKey || requestedCacheKey;
        session.keyframeCacheId = timelineCacheId(check.video.source, check.duration, sessionConfig.seekSegmentSeconds || 4);
        session.directory = reusable?.directory || cacheDirectory(mix.id, session.cacheKey);
        session.persistent = true;
        session.cacheState = 'indexing';
        const cacheInfo = reusable?.info || readCacheInfo(session.directory);
        session.events = cacheInfo?.events || [];
        session.vodSegmentInfo = cacheInfo?.segmentInfo && typeof cacheInfo.segmentInfo === 'object' ? cacheInfo.segmentInfo : {};
        session.warnings = check.durationDriftSeconds > 0.1 ? [`As durações das fontes divergem ${check.durationDriftSeconds.toFixed(1)} s.`] : [];
        fileSystem.mkdirSync(session.directory, { recursive: true });
        session.indexingStartedAt = now();
        sessionEvent(session, 'info', 'Validando fontes e indexando keyframes para o VOD buscável.');
        session.vodTimeline = await buildVodTimelineSource(check.video.source, check.duration, sessionConfig.seekSegmentSeconds || 4, sessionConfig.keyframeIndexTimeoutMs);
        session.indexingStartedAt = null;
        if (!session.vodTimeline.length) throw new Error('A fonte de vídeo não possui keyframes suficientes para a reprodução buscável sem recodificação.');
        const renderedPlaylistName = cacheInfo?.renderedPreloadPlaylist
          || readDirectories(session.directory).map((entry) => entry.name).filter((name) => /^preload-\d{5}\.m3u8$/.test(name)).sort()[0];
        const renderedPlaylist = renderedPlaylistName ? join(session.directory, renderedPlaylistName) : null;
        if (renderedPlaylist && fileSystem.existsSync(renderedPlaylist)) {
          // Migrates caches made just before renderedPreloadPlaylist was added.
          const first = Number(/preload-(\d{5})\.m3u8$/.exec(renderedPlaylist)?.[1]);
          if (Number.isFinite(first)) rebaseTimelineFromContinuousPlaylist(session, renderedPlaylist, first);
        }
        if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
        writeVodPlaylist(session);
        if (session.autoVod) {
          // Do not make the player discover each fragment by waiting for a new
          // source request. A single continuous muxer writes the first segment
          // and keeps producing the following ones in the background.
          startVodAutofill(session);
          await ensureVodSegmentForSession(session, 0);
        }
        if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
        session.state = 'ready';
        session.cacheState = 'partial';
        sessionEvent(session, 'success', 'VOD pronto para iniciar no Nuvio.');
        return session;
      }
      const directory = createGenerationDirectory();
      session.directory = directory;
      const args = buildFfmpegArgs({ ...mix, video: check.video.source, audio: check.audio.source }, directory, audioCodec, session.transport);
      const child = spawnProcess('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';

      session.child = child;
      child.stderr?.on('data', (chunk) => {
        stderr = `${stderr}${chunk}`.slice(-4000);
        session.stderr = stderr;
      });
      child.on('error', () => {
        session.processError = new Error('O FFmpeg não pôde iniciar a preparação da stream.');
        session.finishedAt = now();
      });
      child.on('close', () => {
        session.finishedAt = now();
        if (!isCurrent(session) || session.state === 'preparing') return;
        session.state = isFinalOutput(session) ? 'ready' : 'failed';
      });

      await waitForPlayableOutput(session);
      if (!isCurrent(session)) throw new Error('A preparação da stream foi cancelada.');
      session.state = isFinalOutput(session) ? 'ready' : 'streaming';
      return session;
    } catch (error) {
      if (session.persistent && !session.cancelled) {
        session.indexingStartedAt = null;
        session.cacheState = 'failed';
        sessionEvent(session, 'error', error instanceof Error ? error.message : error);
      }
      if (sessions.get(session.key) === session) discardSession(session.id, session.transport);
      throw error;
    }
  }

  function ensureSession(mix, transport = 'hls', { autoVod = true } = {}) {
    if (transport !== 'hls' && transport !== 'fmp4' && transport !== 'vod') throw new Error('Transporte de reprodução não suportado.');
    const key = sessionKey(mix.id, transport);
    const existing = sessions.get(key);
    if (existing) {
      existing.lastAccess = now();
      if (existing.state === 'ready' && isFinalOutput(existing)) return Promise.resolve(existing);
      if (existing.state === 'streaming' && isPlayableOutput(existing)) return Promise.resolve(existing);
      if (existing.state === 'preparing') return existing.readyPromise;
      discardSession(mix.id, transport);
    }

    // Register the placeholder before preflight so simultaneous requests share one promise.
    const session = {
      id: mix.id,
      key,
      transport,
      mix,
      directory: null,
      child: null,
      children: new Set(),
      preloadChild: null,
      vodAutofillPromise: null,
      vodAutofillTask: null,
      vodAutofillError: null,
      segmentJobs: new Map(),
      continuousPending: new Map(),
      vodQueue: [],
      vodActiveSegments: 0,
      vodMaxConcurrent: 1,
      rateLimitUntil: 0,
      vodTimeline: null,
      vodSegmentInfo: {},
      renderedPreloadPlaylist: null,
      lastAccess: now(),
      stderr: '',
      preflight: null,
      finishedAt: null,
      processError: null,
      durationPatched: false,
      persistent: false,
      cacheKey: null,
      cacheState: null,
      keyframeCacheId: null,
      autoVod: transport === 'vod' && autoVod,
      events: [],
      warnings: [],
      indexingStartedAt: null,
      state: 'preparing',
      cancelled: false,
      readyPromise: null
    };
    sessions.set(key, session);
    session.readyPromise = prepareSession(mix, session);
    return session.readyPromise;
  }

  function getSessionFile(mixId, filename, transport = 'hls') {
    const session = sessions.get(sessionKey(mixId, transport));
    if (!session || !session.directory) return null;
    session.lastAccess = now();
    if (transport === 'fmp4' && filename !== 'stream.mp4') return null;
    if (transport === 'hls' && !/^(master\.m3u8|init\.mp4|segment-\d{5}\.m4s)$/.test(filename)) return null;
    if (transport === 'vod' && !/^(vod\.m3u8|vod-init\.mp4|vod-segment-\d{5}-\d{3}\.m4s)$/.test(filename)) return null;
    const path = join(session.directory, filename);
    return fileSystem.existsSync(path) ? path : null;
  }

  function sessionStatus(mixId, transport = 'hls') {
    const session = sessions.get(sessionKey(mixId, transport));
    if (!session) return null;
    return {
      running: Boolean((session.child && session.child.exitCode === null) || session.children?.size),
      state: session.state,
      finishedAt: session.finishedAt,
      lastAccess: session.lastAccess,
      diagnosticAvailable: Boolean(session.stderr || session.processError),
      diagnostics: session.stderr || session.processError ? redactDiagnostic(session.processError?.message || session.stderr) : null,
      indexingElapsedSeconds: session.indexingStartedAt ? Math.max(0, Math.floor((now() - session.indexingStartedAt) / 1000)) : null,
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

  function matchingIndices(timeline, options) {
    const mode = ['start', 'range', 'all', 'from'].includes(options?.mode) ? options.mode : 'start';
    const duration = timeline.reduce((total, segment) => total + segment.duration, 0);
    const start = mode === 'all' || mode === 'start' ? 0 : Math.max(0, Number(options?.startSeconds || 0));
    const requestedEnd = mode === 'start' ? Math.min(duration, start + timeline[0].duration) : mode === 'all' || mode === 'from' || options?.endSeconds === '' || options?.endSeconds === undefined || options?.endSeconds === null ? duration : Number(options.endSeconds);
    if (!Number.isFinite(requestedEnd) || requestedEnd <= start || start >= duration) throw new Error('Informe um intervalo de preload dentro da duração da mídia.');
    let elapsed = 0;
    const indexes = [];
    for (let index = 0; index < timeline.length; index += 1) {
      const next = elapsed + timeline[index].duration;
      if (next > start && elapsed < requestedEnd) indexes.push(index);
      elapsed = next;
    }
    if (!indexes.length) throw new Error('O intervalo selecionado não contém segmentos reproduzíveis.');
    return { mode, startSeconds: start, endSeconds: requestedEnd, indexes };
  }

  function preloadStatus(mixId) {
    const task = preloadTasks.get(mixId);
    const activeSession = sessions.get(sessionKey(mixId, 'vod'));
    const indexingElapsedSeconds = activeSession?.indexingStartedAt ? Math.max(0, Math.floor((now() - activeSession.indexingStartedAt) / 1000)) : null;
    const entries = cacheEntries(mixId).map(publicCache);
    const current = entries[0] || null;
    if (task) return {
      state: task.state,
      mode: task.mode,
      startSeconds: task.startSeconds,
      endSeconds: task.endSeconds,
      totalSegments: task.totalSegments,
      completedSegments: task.completedSegments,
      currentSegment: task.currentSegment,
      activeSegments: task.activeSegments || [],
      error: task.error || null,
      updatedAt: task.updatedAt,
      running: ['indexing', 'preloading'].includes(task.state),
      indexingElapsedSeconds,
      speedBytesPerSecond: task.speedBytesPerSecond || 0,
      transferredBytes: task.transferredBytes || 0,
      cache: current,
      events: [...(current?.events || []), ...task.events].slice(-80),
      warnings: current?.warnings || []
    };
    if (!current) return { state: 'idle', running: false, cache: null, events: [], warnings: [] };
    return {
      state: current.preparedSegments >= current.totalSegments && current.totalSegments ? 'ready' : current.state,
      running: false,
      totalSegments: current.totalSegments,
      completedSegments: current.preparedSegments,
      cache: current,
      events: current.events,
      warnings: current.warnings
    };
  }

  function startPreload(mix, options = {}) {
    const previous = preloadTasks.get(mix.id);
    if (previous && ['indexing', 'preloading'].includes(previous.state)) return preloadStatus(mix.id);
    const task = {
      mixId: mix.id,
      state: 'indexing',
      mode: options.mode || 'start',
      startSeconds: options.startSeconds ?? 0,
      endSeconds: options.endSeconds ?? null,
      totalSegments: 0,
      completedSegments: 0,
      currentSegment: null,
      activeSegments: [],
      startedAt: null,
      initialBytes: null,
      transferredBytes: 0,
      speedBytesPerSecond: 0,
      events: [],
      error: null,
      updatedAt: new Date(now()).toISOString(),
      cancelled: false
    };
    preloadTasks.set(mix.id, task);
    taskEvent(task, 'info', 'Preload local solicitado.');
    void (async () => {
      try {
        // A manual preload owns its requested interval. It must not first
        // launch the playback autofill for the entire title, otherwise a
        // short range would open a second source reader unnecessarily.
        const session = await ensureSession(mix, 'vod', { autoVod: false });
        if (task.cancelled) { task.state = 'cancelled'; return; }
        const selection = matchingIndices(session.vodTimeline, options);
        Object.assign(task, selection, {
          state: 'preloading', totalSegments: selection.indexes.length, updatedAt: new Date(now()).toISOString(),
          startedAt: now(), initialBytes: fileBytes(session.directory)
        });
        session.cacheState = 'preloading';
        updateContinuousPreload(task, session, selection.indexes);
        if (session.vodAutofillPromise) {
          // Playback may already be filling this exact cache. Reuse that one
          // continuous reader instead of racing it with a second FFmpeg.
          sessionEvent(session, 'info', 'A reprodução já está preparando este VOD continuamente; reutilizando os segmentos em andamento.');
          await Promise.all(selection.indexes.map((index) => ensureVodSegmentForSession(session, index)));
        } else {
          const blocks = missingContinuousBlocks(session, selection.indexes);
          sessionEvent(session, 'info', blocks.length ? `Preload contínuo iniciado em ${blocks.length} intervalo(s), sem reabrir a fonte por segmento.` : 'O intervalo solicitado já está no cache local.');
          for (const block of blocks) {
            if (task.cancelled) {
              task.state = 'cancelled';
              session.cacheState = 'partial';
              sessionEvent(session, 'warning', 'Preload cancelado; o trecho já preparado foi mantido.');
              return;
            }
            await preloadContinuousBlock(session, task, block);
          }
        }
        updateContinuousPreload(task, session, selection.indexes);
        const complete = session.vodTimeline.every((_segment, index) => fileSystem.existsSync(join(session.directory, vodSegmentName(index))));
        session.cacheState = complete ? 'ready' : 'partial';
        task.state = complete ? 'ready' : 'partial';
        taskEvent(task, 'success', complete ? 'Toda a mídia está pronta localmente.' : 'O intervalo escolhido está pronto localmente.');
        sessionEvent(session, 'success', complete ? 'Cache VOD completo.' : 'Cache VOD parcial atualizado.');
      } catch (error) {
        const wasCancelled = task.cancelled;
        task.cancelled = true;
        task.state = wasCancelled ? 'cancelled' : 'failed';
        task.error = redactDiagnostic(error instanceof Error ? error.message : error);
        task.updatedAt = new Date(now()).toISOString();
        taskEvent(task, 'error', task.error);
      } finally {
        for (const subscriber of preloadSubscribers) if (subscriber.mixId === mix.id) subscriber.listener(preloadStatus(mix.id));
      }
    })();
    return preloadStatus(mix.id);
  }

  function cancelPreload(mixId) {
    const task = preloadTasks.get(mixId);
    if (!task || !['indexing', 'preloading'].includes(task.state)) return null;
    task.cancelled = true;
    const session = sessions.get(sessionKey(mixId, 'vod'));
    if (session?.preloadChild && session.preloadChild.exitCode === null && !session.preloadChild.killed) session.preloadChild.kill('SIGTERM');
    task.updatedAt = new Date(now()).toISOString();
    taskEvent(task, 'warning', 'Cancelamento solicitado; a geração contínua será interrompida e o trecho pronto será mantido.');
    return preloadStatus(mixId);
  }

  function clearPreloadCache(mixId, { includeKeyframes = false } = {}) {
    const entries = cacheEntries(mixId);
    const keyframes = new Set(entries.map((entry) => entry.info.keyframeCacheId).filter(Boolean));
    const task = preloadTasks.get(mixId);
    if (task) task.cancelled = true;
    preloadTasks.delete(mixId);
    const active = sessions.get(sessionKey(mixId, 'vod'));
    if (active) stopSession(active.key);
    const directory = join(preloadRoot, mixId);
    fileSystem.rmSync(directory, { recursive: true, force: true });
    if (includeKeyframes) for (const id of keyframes) {
      const indexPath = join(sessionConfig.dataDir, 'keyframes', `${id}.json`);
      if (fileSystem.existsSync(indexPath)) fileSystem.rmSync(indexPath, { force: true });
    }
    for (const subscriber of preloadSubscribers) if (subscriber.mixId === mixId) subscriber.listener(preloadStatus(mixId));
    return { cleared: true, includeKeyframes };
  }

  function clearAllPreloadCaches({ includeKeyframes = true } = {}) {
    const ids = readDirectories(preloadRoot).filter((entry) => entry.isDirectory?.()).map((entry) => entry.name);
    for (const id of ids) clearPreloadCache(id, { includeKeyframes });
    if (includeKeyframes) {
      const keyframeRoot = join(sessionConfig.dataDir, 'keyframes');
      fileSystem.rmSync(keyframeRoot, { recursive: true, force: true });
      fileSystem.mkdirSync(keyframeRoot, { recursive: true });
    }
    return { cleared: ids.length, includeKeyframes };
  }

  function getCachedVodFile(mixId, filename) {
    if (!/^(vod\.m3u8|vod-init\.mp4|vod-segment-\d{5}-\d{3}\.m4s)$/.test(filename)) return null;
    for (const entry of cacheEntries(mixId)) {
      const path = join(entry.directory, filename);
      if (fileSystem.existsSync(path)) return path;
    }
    return null;
  }

  function subscribePreload(mixId, listener) {
    const subscriber = { mixId, listener };
    preloadSubscribers.add(subscriber);
    listener(preloadStatus(mixId));
    return () => preloadSubscribers.delete(subscriber);
  }

  function cleanupSessions() {
    for (const session of sessions.values()) {
      if (now() - session.lastAccess > sessionConfig.sessionIdleMs) discardSession(session.id, session.transport);
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

  function shutdownSessions() { for (const session of [...sessions.values()]) discardSession(session.id, session.transport); }

  async function ensureVodSegment(mix, index) {
    const session = await ensureSession(mix, 'vod');
    if (!isCurrent(session)) throw new Error('A sessão buscável não está mais disponível.');
    session.lastAccess = now();
    await ensureVodSegmentForSession(session, index);
    return session;
  }

  return {
    ensureSession, ensureVodSegment, getSessionFile, getCachedVodFile, sessionStatus,
    preloadStatus, startPreload, cancelPreload, clearPreloadCache, clearAllPreloadCaches,
    subscribePreload, cleanupSessions, shutdownSessions, discardSession
  };
}

const defaultSessionManager = createSessionManager();

export const ensureSession = (...args) => defaultSessionManager.ensureSession(...args);
export const ensureVodSegment = (...args) => defaultSessionManager.ensureVodSegment(...args);
export const getSessionFile = (...args) => defaultSessionManager.getSessionFile(...args);
export const getCachedVodFile = (...args) => defaultSessionManager.getCachedVodFile(...args);
export const sessionStatus = (...args) => defaultSessionManager.sessionStatus(...args);
export const preloadStatus = (...args) => defaultSessionManager.preloadStatus(...args);
export const startPreload = (...args) => defaultSessionManager.startPreload(...args);
export const cancelPreload = (...args) => defaultSessionManager.cancelPreload(...args);
export const clearPreloadCache = (...args) => defaultSessionManager.clearPreloadCache(...args);
export const clearAllPreloadCaches = (...args) => defaultSessionManager.clearAllPreloadCaches(...args);
export const subscribePreload = (...args) => defaultSessionManager.subscribePreload(...args);
export const cleanupSessions = (...args) => defaultSessionManager.cleanupSessions(...args);
export const shutdownSessions = (...args) => defaultSessionManager.shutdownSessions(...args);
export const discardSession = (...args) => defaultSessionManager.discardSession(...args);
