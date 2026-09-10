// node tools/stress-decode.mjs <glue.js> <wem 目录或单文件> [次数=10000]
// 一次初始化、长期复用真实 WASM，逐次检查栈、MEMFS、句柄与 WAV 字节一致性。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { bootRuntime } from './runtime.mjs';

const [glue, input, countArg = '10000'] = process.argv.slice(2);
const count = Number(countArg);
if (!glue || !input || !Number.isSafeInteger(count) || count < 1) {
  console.error('用法: node tools/stress-decode.mjs <glue.js> <wem 目录或单文件> [次数=10000]');
  process.exit(2);
}
const root = resolve(input);
const paths = statSync(root).isDirectory()
  ? readdirSync(root).filter(name => name.endsWith('.wem')).sort().map(name => join(root, name))
  : [root];
assert.ok(paths.length, '没有 WEM 样本');
assert.ok(count >= paths.length, '解码次数不能少于样本数');
const files = paths.map(path => ({ path, bytes: readFileSync(path), hash: null }));
const rt = await bootRuntime(glue);
const stack = rt.stackPointer();
const heapBefore = rt.heapBytes();
const times = [];
for (let i = 0; i < count; i++) {
  const sample = files[i % files.length];
  const start = performance.now();
  const { wav } = rt.decode(sample.bytes);
  times.push(performance.now() - start);
  const hash = createHash('sha256').update(wav).digest('hex');
  if (sample.hash === null) sample.hash = hash;
  else assert.equal(hash, sample.hash, `${sample.path} 重复解码输出发生变化`);
  assert.equal(rt.stackPointer(), stack, `第 ${i + 1} 次调用后栈漂移`);
  if ((i + 1) % 1000 === 0) console.error(`已解码 ${i + 1}/${count}`);
}
times.sort((a, b) => a - b);
console.log(JSON.stringify({
  runtimeInstances: 1, samples: files.length, decodes: count,
  stackBefore: stack, stackAfter: rt.stackPointer(),
  heapBefore, heapAfter: rt.heapBytes(),
  decodeP50Ms: times[Math.floor(count * 0.5)], decodeP95Ms: times[Math.floor(count * 0.95)],
}, null, 2));
