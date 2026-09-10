import assert from 'node:assert/strict';
import { it } from 'node:test';
import { compareWav } from '../tools/compare-wav.mjs';

function wav(samples, { rate = 48000, junk = false } = {}) {
  const out = Buffer.alloc(44 + samples.length * 2 + (junk ? 10 : 0));
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  let offset = 36;
  if (junk) { out.write('JUNK', offset); out.writeUInt32LE(1, offset + 4); offset += 10; }
  out.write('data', offset); out.writeUInt32LE(samples.length * 2, offset + 4);
  samples.forEach((sample, i) => out.writeInt16LE(sample, offset + 8 + i * 2));
  return out;
}

it('按 data 块比较 PCM，跳过带奇数长度填充的附加块', () => {
  assert.deepEqual(compareWav(wav([-5, 7]), wav([-4, 7], { junk: true })), { maxDelta: 1, byteIdentical: false });
  assert.deepEqual(compareWav(wav([-5, 7]), wav([-5, 7])), { maxDelta: 0, byteIdentical: true });
});
it('采样率、长度与帧不匹配不能被当作相同音频', () => {
  assert.throws(() => compareWav(wav([1]), wav([1], { rate: 24000 })), /采样率/u);
  assert.throws(() => compareWav(wav([1]), wav([1, 2])), /长度/u);
  assert.throws(() => compareWav(wav([1]), wav([1]).subarray(0, 45)), /截断/u);
});
