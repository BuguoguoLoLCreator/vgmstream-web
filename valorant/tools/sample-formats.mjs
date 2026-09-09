// 抽样真实 wem 的 RIFF fmt 标记，判断除 Wwise Vorbis 外还需要哪些 codec。
// 只取每个文件前 64 字节（Range 请求），代价极小。
//
//   node sample-formats.mjs <urls.txt> [每批数量]

import { readFileSync, writeFileSync } from 'node:fs';

const [listPath, limitArg] = process.argv.slice(2);
const urls = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const limit = Number(limitArg ?? 0) || urls.length;

// 均匀抽样而不是取前 N 条：同一事件的多段录音通常连续排列，取前 N 条会偏向少数事件。
const step = Math.max(1, Math.floor(urls.length / limit));
const picked = urls.filter((_, i) => i % step === 0).slice(0, limit);

const CODEC_NAMES = {
  0x0001: 'PCM',
  0x0002: 'Wwise IMA/ADPCM',
  0x0011: 'IMA ADPCM',
  0x0069: 'XBOX IMA',
  0x0161: 'WMA v2',
  0x0165: 'XMA1',
  0x0166: 'XMA2',
  0x3039: 'Wwise Opus (OPUSNX)',
  0x3040: 'Wwise Opus',
  0x3041: 'Wwise Opus (WEM)',
  0xffff: 'Wwise Vorbis',
};

const tally = new Map();
const oddballs = [];
let failed = 0;

async function probe(url) {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-63' } });
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 24 || buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('非 RIFF');
    // RIFF/WAVE 下 fmt 块紧跟在 'WAVE' 之后：0x0c='fmt ', 0x10=块长, 0x14=wFormatTag
    const tag = buf.readUInt16LE(0x14);
    const channels = buf.readUInt16LE(0x16);
    const rate = buf.readUInt32LE(0x18);
    tally.set(tag, (tally.get(tag) ?? 0) + 1);
    if (tag !== 0xffff) oddballs.push({ url, tag, channels, rate });
  } catch (e) {
    failed += 1;
    if (failed <= 3) console.error(`  探测失败 ${url.slice(-20)}: ${e.message}`);
  }
}

// 并发 12，避免把 CDN 打出限流。
const queue = [...picked];
await Promise.all(Array.from({ length: 12 }, async () => {
  for (let next = queue.shift(); next; next = queue.shift()) await probe(next);
}));

console.log(`抽样 ${picked.length} / 总计 ${urls.length}，失败 ${failed}`);
for (const [tag, count] of [...tally].sort((a, b) => b[1] - a[1])) {
  const name = CODEC_NAMES[tag] ?? '未知';
  console.log(`  0x${tag.toString(16).padStart(4, '0')}  ${String(count).padStart(4)} 个  ${name}`);
}
if (oddballs.length) {
  writeFileSync('oddball-urls.txt', oddballs.map((o) => o.url).join('\n'));
  console.log(`\n非 Vorbis 样本已写入 oddball-urls.txt（${oddballs.length} 条）`);
}
