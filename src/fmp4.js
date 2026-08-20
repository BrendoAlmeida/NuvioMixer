import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';

function atomOffsets(buffer, type) {
  const needle = Buffer.from(type);
  const offsets = [];
  let from = 0;
  while (from < buffer.length) {
    const typeOffset = buffer.indexOf(needle, from);
    if (typeOffset < 4) break;
    const start = typeOffset - 4;
    if (start + 8 > buffer.length) break;
    const size = buffer.readUInt32BE(start);
    if (size >= 8 && start + size <= buffer.length) offsets.push(typeOffset);
    from = typeOffset + 4;
  }
  return offsets;
}

function header(buffer, typeOffset, type) {
  const version = buffer[typeOffset + 4];
  if (version !== 0 && version !== 1) return null;
  const isVersionOne = version === 1;
  if (type === 'tkhd') {
    return {
      durationOffset: typeOffset + (isVersionOne ? 32 : 24),
      durationBytes: isVersionOne ? 8 : 4,
      timescale: null
    };
  }
  const timescaleOffset = typeOffset + (isVersionOne ? 24 : 16);
  const durationOffset = typeOffset + (isVersionOne ? 28 : 20);
  if (durationOffset + (isVersionOne ? 8 : 4) > buffer.length) return null;
  return {
    durationOffset,
    durationBytes: isVersionOne ? 8 : 4,
    timescale: buffer.readUInt32BE(timescaleOffset)
  };
}

function encodedDuration(seconds, timescale, bytes) {
  const units = Math.max(0, Math.round(seconds * timescale));
  const maximum = bytes === 4 ? 0xffffffff : Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(units) || units > maximum) return null;
  const value = Buffer.alloc(bytes);
  if (bytes === 4) value.writeUInt32BE(units);
  else value.writeBigUInt64BE(BigInt(units));
  return value;
}

/**
 * Returns the byte patches needed to declare a known duration in an fMP4's
 * initial moov atom. Fragment payloads remain untouched.
 */
export function fmp4DurationPatches(buffer, durationSeconds) {
  if (!Buffer.isBuffer(buffer) || !Number.isFinite(durationSeconds) || durationSeconds < 0) return [];
  const movie = atomOffsets(buffer, 'mvhd').map((offset) => header(buffer, offset, 'mvhd')).find(Boolean);
  if (!movie?.timescale) return [];

  const patches = [];
  const add = (entry, timescale) => {
    const value = entry && encodedDuration(durationSeconds, timescale, entry.durationBytes);
    if (value) patches.push({ offset: entry.durationOffset, value });
  };

  add(movie, movie.timescale);
  for (const offset of atomOffsets(buffer, 'tkhd')) add(header(buffer, offset, 'tkhd'), movie.timescale);
  for (const offset of atomOffsets(buffer, 'mdhd')) {
    const media = header(buffer, offset, 'mdhd');
    add(media, media?.timescale);
  }
  return patches;
}

export function isPlayableFmp4(buffer) {
  if (!Buffer.isBuffer(buffer)) return false;
  const boxes = ['ftyp', 'moov', 'moof', 'mdat'].map((type) => buffer.indexOf(Buffer.from(type)));
  return boxes.every((offset) => offset >= 0) && boxes.every((offset, index) => index === 0 || offset > boxes[index - 1]);
}

/**
 * Patch the short initialization header in-place. FFmpeg keeps the descriptor
 * at the start of a fragmented MP4 and only appends moof/mdat fragments later,
 * so this never rewrites or re-encodes media bytes.
 */
export function patchFmp4Duration(path, durationSeconds) {
  const patches = fmp4DurationPatches(readFileSync(path), durationSeconds);
  if (!patches.length) return false;
  const descriptor = openSync(path, 'r+');
  try {
    for (const patch of patches) writeSync(descriptor, patch.value, 0, patch.value.length, patch.offset);
  } finally {
    closeSync(descriptor);
  }
  return true;
}
