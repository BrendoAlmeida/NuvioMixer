import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { assertSourceUrl, normalizeStream } from './stremio.js';
import { buildContinuousVodPreloadArgs, buildFfmpegArgs, buildVodPlaylist, buildVodSegmentArgs, buildVodTimeline, durationAssessment } from './media.js';

test('normaliza stream HTTP e preserva proxy headers', () => {
  const source = normalizeStream({ url: 'https://example.test/movie.m3u8', name: 'Exemplo', behaviorHints: { proxyHeaders: { request: { Referer: 'https://example.test' } } } }, { id: 'a', name: 'Addon' });
  assert.equal(source.kind, 'url');
  assert.equal(source.headers.Referer, 'https://example.test');
});

test('normaliza stream torrent', () => {
  const source = normalizeStream({ infoHash: 'abc', fileIdx: 2 }, { id: 'a', name: 'Addon' });
  assert.equal(source.kind, 'torrent');
  assert.equal(source.fileIdx, 2);
});

test('recusa protocolos não HTTP', () => {
  assert.throws(() => assertSourceUrl('file:///etc/passwd'), /HTTP/);
});

test('aceita HTTP em modo de desenvolvimento', () => {
  if (config.allowInsecureHttp) assert.equal(assertSourceUrl('http://example.test/a').hostname, 'example.test');
});

test('trata divergência de duração como informação, sem limite de bloqueio', () => {
  assert.deepEqual(durationAssessment(7200, 7170.1, 0), { adjustedAudioDuration: 7170.1, durationDriftSeconds: 29.899999999999636 });
  assert.equal(durationAssessment(7200, 7170.1, 29.9).durationDriftSeconds < 0.001, true);
});

test('usa 120 segundos como espera inicial padrão da stream', () => {
  assert.equal(config.streamStartTimeoutMs, 120000);
});

test('encerra no menor fluxo e produz uma playlist HLS progressiva sem recodificação', () => {
  const args = buildFfmpegArgs({
    video: { kind: 'url', url: 'https://example.test/video.mp4' },
    audio: { kind: 'url', url: 'https://example.test/audio.mp4' }
  }, '/tmp/nuvio-mixer-test', 'aac');
  assert.equal(args.includes('-shortest'), true);
  assert.equal(args[args.indexOf('-hls_playlist_type') + 1], 'event');
  assert.equal(args.includes('temp_file'), true);
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('produz fMP4 fragmentado com cabeçalho inicial para duração declarada', () => {
  const args = buildFfmpegArgs({
    video: { kind: 'url', url: 'https://example.test/video.mp4' },
    audio: { kind: 'url', url: 'https://example.test/audio.mp4' }
  }, '/tmp/nuvio-mixer-test', 'eac3', 'fmp4');
  assert.equal(args[args.indexOf('-f') + 1], 'mp4');
  assert.equal(args[args.indexOf('-movflags') + 1], '+empty_moov+delay_moov+frag_keyframe+default_base_moof');
  assert.equal(args.includes('-flush_packets'), true);
  assert.equal(args.at(-1), '/tmp/nuvio-mixer-test/stream.mp4');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('produz manifesto VOD alinhado aos keyframes e com duração conhecida', () => {
  const timeline = buildVodTimeline([0, 4.25, 8.75], 10.5, 4);
  assert.deepEqual(timeline, [
    { sourceStart: 0, duration: 4.25 },
    { sourceStart: 4.25, duration: 4.5 },
    { sourceStart: 8.75, duration: 1.75 }
  ]);
  const playlist = buildVodPlaylist(timeline);
  assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
  assert.match(playlist, /#EXT-X-MAP:URI="vod-init\.mp4"/);
  assert.match(playlist, /#EXTINF:4\.250000,\nvod-segment-00000-000\.m4s/);
  assert.match(playlist, /#EXTINF:1\.750000,\nvod-segment-00002-000\.m4s/);
});

test('prioriza as durações efetivas e sinaliza transições entre remuxes VOD', () => {
  const playlist = buildVodPlaylist([
    { sourceStart: 0, duration: 4 },
    { sourceStart: 4, duration: 4 },
    { sourceStart: 8, duration: 4 }
  ], {
    1: { duration: 5.25, discontinuity: true },
    2: { duration: 3.5 }
  });
  assert.match(playlist, /#EXT-X-DISCONTINUITY\n#EXTINF:5\.250000,\nvod-segment-00001-000\.m4s/);
  assert.match(playlist, /#EXTINF:3\.500000,\nvod-segment-00002-000\.m4s/);
});

test('mantém a base de timestamp do primeiro keyframe ao montar a timeline VOD', () => {
  const timeline = buildVodTimeline([0.667, 5.75, 12.19], 15, 4);
  assert.deepEqual(timeline, [
    { sourceStart: 0.667, duration: 5.083 },
    { sourceStart: 5.75, duration: 6.44 },
    { sourceStart: 12.19, duration: 3.477 }
  ]);
});

test('busca vídeo e áudio no mesmo ponto ao gerar segmento VOD', () => {
  const args = buildVodSegmentArgs({
    video: { kind: 'url', url: 'https://example.test/video.mp4' },
    audio: { kind: 'url', url: 'https://example.test/audio.mp4' },
    audioOffsetSeconds: 1.5
  }, '/tmp/nuvio-mixer-test', 'aac', { index: 3, sourceStart: 12, duration: 4 });
  const inputSeeks = args.reduce((values, entry, index) => entry === '-ss' ? [...values, args[index + 1]] : values, []);
  assert.deepEqual(inputSeeks, ['12', '10.5']);
  assert.equal(args[args.indexOf('-loglevel') + 1], 'error');
  assert.equal(args[args.indexOf('-hls_segment_filename') + 1], '/tmp/nuvio-mixer-test/vod-segment-00003-%03d.m4s');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});

test('produz um intervalo VOD contínuo sem reabrir a origem por segmento', () => {
  const args = buildContinuousVodPreloadArgs({
    video: { kind: 'url', url: 'https://example.test/video.mkv' },
    audio: { kind: 'url', url: 'https://example.test/audio.mkv' },
    audioOffsetSeconds: 1.5
  }, '/tmp/nuvio-mixer-test', 'eac3', { startIndex: 12, sourceStart: 50, duration: 20, targetSeconds: 4 });
  const inputSeeks = args.reduce((values, entry, index) => entry === '-ss' ? [...values, args[index + 1]] : values, []);
  assert.deepEqual(inputSeeks, ['50', '48.5']);
  assert.equal(args[args.indexOf('-start_number') + 1], '12');
  assert.equal(args[args.indexOf('-hls_time') + 1], '4');
  assert.equal(args[args.indexOf('-hls_segment_filename') + 1], '/tmp/nuvio-mixer-test/vod-segment-%05d-000.m4s');
  assert.equal(args.at(-1), '/tmp/nuvio-mixer-test/preload-00012.m3u8');
});
