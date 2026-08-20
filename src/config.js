import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

function bool(value, fallback = false) {
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const config = {
  port: Number(process.env.PORT || 7337),
  baseUrl: (process.env.BASE_URL || 'http://localhost:7337').replace(/\/$/, ''),
  dataDir: resolve(process.env.DATA_DIR || './data'),
  masterKey: process.env.MASTER_KEY || '',
  allowInsecureHttp: bool(process.env.ALLOW_INSECURE_HTTP, true),
  allowPrivateNetwork: bool(process.env.ALLOW_PRIVATE_NETWORK, true),
  torrentGatewayUrl: process.env.TORRENT_GATEWAY_URL || '',
  // WebDL envia a URL da fonte ao Torbox; só habilite conscientemente para URLs públicas elegíveis.
  torboxResolveUrls: bool(process.env.TORBOX_RESOLVE_URLS, false),
  nuvioApiBase: (process.env.NUVIO_API_BASE || 'https://api.nuvio.tv').replace(/\/$/, ''),
  sessionIdleMs: Number(process.env.SESSION_IDLE_MS || 30 * 60 * 1000),
  streamStartTimeoutMs: positiveNumber(process.env.STREAM_START_TIMEOUT_MS, 120 * 1000),
  seekSegmentSeconds: positiveNumber(process.env.SEEK_SEGMENT_SECONDS, 4),
  keyframeIndexTimeoutMs: positiveNumber(process.env.KEYFRAME_INDEX_TIMEOUT_MS, 20 * 60 * 1000)
};

mkdirSync(config.dataDir, { recursive: true });
mkdirSync(resolve(config.dataDir, 'sessions'), { recursive: true });
mkdirSync(resolve(config.dataDir, 'keyframes'), { recursive: true });
mkdirSync(resolve(config.dataDir, 'preloads'), { recursive: true });
