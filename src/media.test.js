import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from './config.js';
import { assertSourceUrl, normalizeStream } from './stremio.js';
import { buildFfmpegArgs, durationAssessment } from './media.js';

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

test('encerra no menor fluxo e produz uma playlist HLS VOD', () => {
  const args = buildFfmpegArgs({
    video: { kind: 'url', url: 'https://example.test/video.mp4' },
    audio: { kind: 'url', url: 'https://example.test/audio.mp4' }
  }, '/tmp/nuvio-mixer-test', 'aac');
  assert.equal(args.includes('-shortest'), true);
  assert.equal(args[args.indexOf('-hls_playlist_type') + 1], 'vod');
  assert.equal(args[args.indexOf('-c:v') + 1], 'copy');
  assert.equal(args[args.indexOf('-c:a') + 1], 'copy');
});
