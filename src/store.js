import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';

const dbPath = join(config.dataDir, 'mixer.json');

function blank() {
  return { version: 1, addons: [], mixes: [], secrets: [], nuvio: null };
}

function read() {
  if (!existsSync(dbPath)) return blank();
  try { return { ...blank(), ...JSON.parse(readFileSync(dbPath, 'utf8')) }; }
  catch { throw new Error('O banco local do NuvioMixer está inválido. Restaure um backup antes de continuar.'); }
}

function write(value) {
  const temporary = `${dbPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, dbPath);
}

function encryptionKey() {
  if (!config.masterKey) throw new Error('MASTER_KEY é obrigatório antes de salvar credenciais.');
  const key = Buffer.from(config.masterKey, 'base64');
  if (key.length !== 32) throw new Error('MASTER_KEY deve ser uma chave base64 de 32 bytes.');
  return key;
}

export function encrypt(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decrypt(value) {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(value.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(value.ciphertext, 'base64')), decipher.final()]).toString('utf8'));
}

export function listAddons() { return read().addons; }

export function saveAddon(addon) {
  const db = read();
  const now = new Date().toISOString();
  const record = { id: addon.id || randomUUID(), name: addon.name, manifestUrl: addon.manifestUrl, transportUrl: addon.transportUrl || addon.manifestUrl, enabled: addon.enabled !== false, manifest: addon.manifest, createdAt: addon.createdAt || now, updatedAt: now };
  const index = db.addons.findIndex((item) => item.manifestUrl === record.manifestUrl);
  if (index >= 0) db.addons[index] = { ...db.addons[index], ...record, id: db.addons[index].id, createdAt: db.addons[index].createdAt };
  else db.addons.push(record);
  write(db);
  return record;
}

export function updateAddon(id, updates) {
  const db = read();
  const index = db.addons.findIndex((addon) => addon.id === id);
  if (index < 0) return null;
  const current = db.addons[index];
  const record = { ...current, enabled: typeof updates.enabled === 'boolean' ? updates.enabled : current.enabled, updatedAt: new Date().toISOString() };
  db.addons[index] = record;
  write(db);
  return record;
}

export function deleteAddon(id) {
  const db = read();
  const count = db.addons.length;
  db.addons = db.addons.filter((addon) => addon.id !== id);
  if (count === db.addons.length) return false;
  write(db);
  return true;
}

export function listMixes() { return read().mixes; }
export function getMix(id) { return read().mixes.find((mix) => mix.id === id); }

export function saveMix(input) {
  const db = read();
  const now = new Date().toISOString();
  const existing = input.id ? db.mixes.find((mix) => mix.id === input.id) : null;
  const record = {
    id: existing?.id || randomUUID(),
    playToken: existing?.playToken || randomBytes(24).toString('base64url'),
    label: input.label,
    contentId: input.contentId,
    videoId: input.videoId || input.contentId,
    type: input.type || 'movie',
    scope: input.scope === 'series' ? 'series' : 'single',
    season: input.season ?? null,
    episode: input.episode ?? null,
    audioOffsetSeconds: Number(input.audioOffsetSeconds || 0),
    videoSelector: input.videoSelector || null,
    audioSelector: input.audioSelector || null,
    video: input.video,
    audio: input.audio,
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };
  if (existing) db.mixes = db.mixes.map((mix) => mix.id === existing.id ? record : mix);
  else db.mixes.push(record);
  write(db);
  return record;
}

export function deleteMix(id) {
  const db = read();
  const count = db.mixes.length;
  db.mixes = db.mixes.filter((mix) => mix.id !== id);
  if (count === db.mixes.length) return false;
  write(db);
  return true;
}

export function saveSecret(kind, value) {
  const db = read();
  const encrypted = encrypt(value);
  const index = db.secrets.findIndex((secret) => secret.kind === kind);
  const record = { kind, ...encrypted, updatedAt: new Date().toISOString() };
  if (index >= 0) db.secrets[index] = record; else db.secrets.push(record);
  write(db);
}

export function getSecret(kind) {
  const secret = read().secrets.find((candidate) => candidate.kind === kind);
  return secret ? decrypt(secret) : null;
}

export function saveNuvioConnection(connection) {
  const db = read();
  db.nuvio = { apiBase: connection.apiBase, profileId: connection.profileId || null, updatedAt: new Date().toISOString() };
  write(db);
  saveSecret('nuvio', connection.secret);
  return db.nuvio;
}

export function getNuvioConnection() {
  const db = read();
  if (!db.nuvio) return null;
  return { ...db.nuvio, secret: getSecret('nuvio') };
}

export function getNuvioConnectionInfo() {
  const nuvio = read().nuvio;
  if (!nuvio) return null;
  return { apiBase: nuvio.apiBase, profileId: nuvio.profileId, updatedAt: nuvio.updatedAt };
}
