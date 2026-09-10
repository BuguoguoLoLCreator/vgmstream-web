// node tools/batch-compare.mjs <urls.txt> <数量> <旧胶水.js> <新胶水.js> [最大允许 PCM 偏差=1]
// 新运行时全程复用；旧运行时按文件重新创建，避免旧 callMain 的栈泄漏污染比较基线。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { bootRuntime } from './runtime.mjs';
import { compareWav } from './compare-wav.mjs';

const [listPath, countArg, oldGlue, newGlue, deltaArg = '1'] = process.argv.slice(2);
const count = Number(countArg);
const allowedDelta = Number(deltaArg);
if (!listPath || !oldGlue || !newGlue || !Number.isSafeInteger(count) || count < 1 ||
    !Number.isSafeInteger(allowedDelta) || allowedDelta < 0 || allowedDelta > 65535) {
  console.error('用法: node tools/batch-compare.mjs <urls.txt> <数量> <旧胶水.js> <新胶水.js> [最大允许 PCM 偏差=1]');
  process.exit(2);
}
const urls = [...new Set(readFileSync(listPath, 'utf8').split('\n').map(s => s.trim()).filter(s => s && !s.startsWith('#')))];
assert.ok(urls.length >= count, 'URL 数量不足，不能把少测样本当作全量通过');
const picked = Array.from({ length: count }, (_, i) => urls[Math.floor(i * urls.length / count)]);
const sampleDir = process.env.VGM_SAMPLE_DIR || 'samples';
mkdirSync(sampleDir, { recursive: true });
const newRt = await bootRuntime(newGlue);
let passed = 0;
let byteIdentical = 0;
let worstDelta = 0;
const problems = [];

for (const [i, url] of picked.entries()) {
  try {
    const name = join(sampleDir, createHash('sha256').update(url).digest('hex') + '.wem');
    if (!existsSync(name)) {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!response.ok) throw new Error(`下载 HTTP ${response.status}`);
      writeFileSync(name, new Uint8Array(await response.arrayBuffer()));
    }
    const bytes = readFileSync(name);
    const oldRt = await bootRuntime(oldGlue, { requireStackApi: false });
    const a = oldRt.decode(bytes).wav;
    const b = newRt.decode(bytes).wav;
    const result = compareWav(a, b);
    worstDelta = Math.max(worstDelta, result.maxDelta);
    if (result.byteIdentical) byteIdentical++;
    assert.ok(result.maxDelta <= allowedDelta, `PCM 偏差 ${result.maxDelta} 超过 ${allowedDelta}`);
    passed++;
  } catch (error) {
    problems.push({ url, error: error.message });
  }
  if ((i + 1) % 50 === 0) console.error(`已比对 ${i + 1}/${count}`);
}
console.log(JSON.stringify({ samples: count, passed, byteIdentical, worstDelta, allowedDelta, problems }, null, 2));
if (problems.length || passed !== count) process.exitCode = 1;
