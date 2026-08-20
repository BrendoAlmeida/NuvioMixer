import assert from 'node:assert/strict';
import test from 'node:test';
import { fmp4DurationPatches, isPlayableFmp4 } from './fmp4.js';

function box(type, length = 40) {
  const value = Buffer.alloc(length);
  value.writeUInt32BE(length, 0);
  value.write(type, 4);
  return value;
}

function initialization() {
  const ftyp = box('ftyp', 12);
  const mvhd = box('mvhd');
  mvhd.writeUInt32BE(1000, 20);
  const tkhd = box('tkhd');
  const video = box('mdhd');
  video.writeUInt32BE(90_000, 20);
  const audio = box('mdhd');
  audio.writeUInt32BE(48_000, 20);
  const moov = Buffer.concat([box('moov', 8), mvhd, tkhd, video, audio]);
  return Buffer.concat([ftyp, moov, box('moof', 8), box('mdat', 8)]);
}

test('declara duração conhecida no cabeçalho fMP4 sem tocar nos fragmentos', () => {
  const file = initialization();
  const patches = fmp4DurationPatches(file, 10.5);
  for (const patch of patches) patch.value.copy(file, patch.offset);

  const mvhd = file.indexOf(Buffer.from('mvhd'));
  const tkhd = file.indexOf(Buffer.from('tkhd'));
  const mdhd = [...file.entries()].map(([offset]) => offset).filter((offset) => file.subarray(offset, offset + 4).toString() === 'mdhd');
  assert.equal(file.readUInt32BE(mvhd + 20), 10_500);
  assert.equal(file.readUInt32BE(tkhd + 24), 10_500);
  assert.equal(file.readUInt32BE(mdhd[0] + 20), 945_000);
  assert.equal(file.readUInt32BE(mdhd[1] + 20), 504_000);
  assert.equal(isPlayableFmp4(file), true);
});

test('recusa um arquivo que ainda não contém a primeira mídia fragmentada', () => {
  assert.equal(isPlayableFmp4(initialization().subarray(0, -16)), false);
});
