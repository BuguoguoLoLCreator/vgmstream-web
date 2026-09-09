// 批量回归：同一批真实 wem 分别用两个构建解码，比对样本数与逐样本偏差。
// 用于确认「换 r2117 + 裁剪 codec」不改变可听结果。
//
//   node batch-compare.mjs <urls.txt> <数量> <旧胶水.js> <新胶水.js>

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const [listPath, countArg, oldGlue, newGlue] = process.argv.slice(2);
const urls = readFileSync(listPath, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
const count = Number(countArg) || 30;
const step = Math.max(1, Math.floor(urls.length / count));
const picked = urls.filter((_, i) => i % step === 0).slice(0, count);

mkdirSync('samples', { recursive: true });

/** 起一个 vgmstream 运行时实例（模拟 Worker 环境，见 run-vgmstream.mjs 的说明）。 */
async function boot(gluePath) {
  const glueAbs = resolve(gluePath);
  const stdout = [];
  const stderr = [];
  let settle;
  const ready = new Promise((done, fail) => { settle = { done, fail }; });
  const Module = {
    wasmBinary: readFileSync(glueAbs.replace(/\.js$/u, '.wasm')),
    noInitialRun: true,
    print: (t) => stdout.push(t),
    printErr: (t) => stderr.push(t),
    onRuntimeInitialized: () => settle.done(),
    onAbort: (r) => settle.fail(new Error(String(r))),
  };
  const sandbox = {
    Module,
    WorkerGlobalScope: function WorkerGlobalScope() {},
    console, performance, setTimeout, clearTimeout,
    TextDecoder, TextEncoder, URL, Blob, fetch,
    location: { href: `file://${glueAbs}` },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.runInContext(readFileSync(glueAbs, 'utf8'), vm.createContext(sandbox), { filename: glueAbs });
  await ready;
  const FS = sandbox.FS ?? Module.FS;
  const callMain = sandbox.callMain ?? Module.callMain;
  return {
    decode(bytes) {
      stdout.length = 0;
      stderr.length = 0;
      try { FS.unlink('/in.wem'); } catch { /* 首次不存在 */ }
      try { FS.unlink('/out.wav'); } catch { /* 同上 */ }
      FS.writeFile('/in.wem', bytes);
      callMain(['-I', '-o', '/out.wav', '-i', '/in.wem']);
      try {
        return { wav: Buffer.from(FS.readFile('/out.wav')), err: stderr.join('\n') };
      } catch {
        return { wav: null, err: stderr.join('\n') || '无产物' };
      }
    },
  };
}

const oldRt = await boot(oldGlue);
const newRt = await boot(newGlue);

let ok = 0;
let sizeMismatch = 0;
let failedOld = 0;
let failedNew = 0;
let worstDelta = 0;
let totalDiffRatio = 0;
const problems = [];

for (const [i, url] of picked.entries()) {
  const name = `samples/${url.slice(-12)}`;
  if (!existsSync(name)) {
    const res = await fetch(url);
    if (!res.ok) { problems.push(`${url} 下载 HTTP ${res.status}`); continue; }
    writeFileSync(name, Buffer.from(await res.arrayBuffer()));
  }
  const bytes = new Uint8Array(readFileSync(name));

  const a = oldRt.decode(bytes);
  const b = newRt.decode(new Uint8Array(bytes));
  if (!a.wav) { failedOld += 1; problems.push(`${name} 旧版失败: ${a.err.slice(0, 80)}`); continue; }
  if (!b.wav) { failedNew += 1; problems.push(`${name} 新版失败: ${b.err.slice(0, 80)}`); continue; }
  if (a.wav.length !== b.wav.length) {
    sizeMismatch += 1;
    problems.push(`${name} 长度不同: ${a.wav.length} vs ${b.wav.length}`);
    continue;
  }

  let diff = 0;
  let maxd = 0;
  for (let p = 44; p + 1 < a.wav.length; p += 2) {
    const x = a.wav.readInt16LE(p);
    const y = b.wav.readInt16LE(p);
    if (x !== y) { diff += 1; const d = Math.abs(x - y); if (d > maxd) worstDelta = Math.max(worstDelta, d), maxd = d; }
  }
  totalDiffRatio += diff / ((a.wav.length - 44) / 2);
  ok += 1;
  if ((i + 1) % 10 === 0) process.stderr.write(`  已比对 ${i + 1}/${picked.length}\n`);
}

console.log(`\n样本 ${picked.length} 个`);
console.log(`  两版均解码成功且长度一致: ${ok}`);
console.log(`  旧版失败 ${failedOld} / 新版失败 ${failedNew} / 长度不一致 ${sizeMismatch}`);
console.log(`  最大单样本偏差: ${worstDelta} (16bit 满量程 32768)`);
if (ok) console.log(`  平均差异样本占比: ${(totalDiffRatio / ok * 100).toFixed(1)}%`);
if (problems.length) console.log('\n问题:\n  ' + problems.slice(0, 10).join('\n  '));
