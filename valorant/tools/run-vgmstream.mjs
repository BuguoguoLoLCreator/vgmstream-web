// 在 Node 里以「模拟 Worker 环境」驱动 vgmstream-cli 的 Emscripten 构建，
// 流程与站内 wem-worker.js 完全一致：预置 Module.wasmBinary → 加载胶水 →
// 等 onRuntimeInitialized → wem 写进 MEMFS → callMain → 读出 WAV。
//
//   node run-vgmstream.mjs <glue.js> <input.wem> [outWav]
//
// 为什么用 vm 而不是 require/new Function：胶水是非模块化的经典脚本，
// `var Module` / `var FS` / `callMain` 都落在脚本所在的全局对象上（浏览器 Worker 里就是 self）。
// CJS require 会让这些 var 变成模块局部（配置读不到、FS 取不着），
// new Function 包装则会改变作用域链导致 wasm 导入解析失败。vm 上下文能精确还原全局语义。

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const [gluePath, inputPath, outPath] = process.argv.slice(2);
if (!gluePath || !inputPath) {
  console.error('用法: node run-vgmstream.mjs <glue.js> <input.wem> [outWav]');
  process.exit(2);
}

const glueAbs = resolve(gluePath);
const wasmAbs = glueAbs.replace(/\.js$/u, '.wasm');
const stdout = [];
const stderr = [];

let settle;
const ready = new Promise((done, fail) => { settle = { done, fail }; });

const Module = {
  wasmBinary: readFileSync(wasmAbs),
  noInitialRun: true,
  print: (text) => stdout.push(text),
  printErr: (text) => stderr.push(text),
  onRuntimeInitialized: () => settle.done(),
  onAbort: (reason) => settle.fail(new Error(`运行时中止: ${reason}`)),
};

// 只提供 Worker 环境该有的东西：不给 process / window，胶水就会走 ENVIRONMENT_IS_WORKER 分支，
// 与线上一致；wasmBinary 已预置，因此它不会去 fetch 或读文件。
const sandbox = {
  Module,
  WorkerGlobalScope: function WorkerGlobalScope() {},
  console,
  performance,
  setTimeout,
  clearTimeout,
  TextDecoder,
  TextEncoder,
  URL,
  Blob,
  fetch,
  location: { href: `file://${glueAbs}` },
};
sandbox.self = sandbox;
sandbox.globalThis = sandbox;

const context = vm.createContext(sandbox);
vm.runInContext(readFileSync(glueAbs, 'utf8'), context, { filename: glueAbs });
await ready;

const FS = sandbox.FS ?? Module.FS;
const callMain = sandbox.callMain ?? Module.callMain;
if (!FS || !callMain) throw new Error(`胶水未暴露 FS/callMain（FS=${!!FS} callMain=${!!callMain}）`);

const IN = '/input.wem';
const OUT = '/output.wav';
FS.writeFile(IN, new Uint8Array(readFileSync(inputPath)));

const run = (label, args) => {
  stdout.length = 0;
  stderr.length = 0;
  callMain(args);
  console.log(`===== ${label} =====`);
  const out = stdout.join('\n').trim();
  if (out) console.log(out);
  const err = stderr.join('\n').trim();
  if (err) console.log(`--- stderr ---\n${err}`);
};

run('元数据', ['-m', '-i', IN]);
run('解码', ['-I', '-o', OUT, '-i', IN]);

const wav = FS.readFile(OUT);
console.log(`\nWAV ${wav.length} 字节`);
if (outPath) {
  writeFileSync(outPath, wav);
  console.log(`已写入 ${outPath}`);
}
