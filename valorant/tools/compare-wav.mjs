import assert from 'node:assert/strict';

/** vgmstream 默认输出 PCM16；按 RIFF 块定位音频，不能假定 data 总在第 44 字节。 */
function pcm16(wav) {
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', '缺少 RIFF 头');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', '缺少 WAVE 标记');
  let format;
  let data;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const tag = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const start = offset + 8;
    assert.ok(start + size <= wav.length, 'WAV 块被截断');
    if (tag === 'fmt ') {
      assert.ok(size >= 16, 'fmt 块过短');
      assert.equal(wav.readUInt16LE(start), 1, '不是 PCM');
      assert.equal(wav.readUInt16LE(start + 14), 16, '不是 PCM16');
      format = { channels: wav.readUInt16LE(start + 2), rate: wav.readUInt32LE(start + 4) };
    } else if (tag === 'data') data = wav.subarray(start, start + size);
    offset = start + size + (size % 2);
  }
  assert.ok(format && format.channels > 0 && format.rate > 0 && data?.length, '缺少有效 PCM 数据');
  assert.equal(data.length % (format.channels * 2), 0, 'PCM 帧不完整');
  return { ...format, data };
}

export function compareWav(a, b) {
  const x = pcm16(a);
  const y = pcm16(b);
  assert.equal(x.channels, y.channels, '声道数不同');
  assert.equal(x.rate, y.rate, '采样率不同');
  assert.equal(x.data.length, y.data.length, 'PCM 长度不同');
  let maxDelta = 0;
  for (let i = 0; i < x.data.length; i += 2) {
    maxDelta = Math.max(maxDelta, Math.abs(x.data.readInt16LE(i) - y.data.readInt16LE(i)));
  }
  return { maxDelta, byteIdentical: a.equals(b) };
}
