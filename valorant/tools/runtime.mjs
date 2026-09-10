// 验证用真实 Emscripten 驱动。此处刻意不替 callMain 恢复栈，否则会掩盖构建产物的回归。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

export async function bootRuntime(gluePath, { requireStackApi = true } = {}) {
  const glueAbs = resolve(gluePath);
  const stdout = [];
  const stderr = [];
  let readyResolve;
  let readyReject;
  let aborted = null;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // 同步胶水异常也要接住 onAbort 的拒绝，避免它脱离本次调用。
  void ready.catch(() => undefined);
  const Module = {
    wasmBinary: readFileSync(glueAbs.replace(/\.js$/u, '.wasm')),
    noInitialRun: true,
    print: text => stdout.push(text),
    printErr: text => stderr.push(text),
    onRuntimeInitialized: () => readyResolve(),
    onAbort: reason => { aborted = new Error(`运行时中止: ${reason}`); readyReject(aborted); },
  };
  const sandbox = {
    Module, WorkerGlobalScope: function WorkerGlobalScope() {},
    console, performance, setTimeout, clearTimeout, TextDecoder, TextEncoder, URL, Blob,
    // 预置 wasmBinary 后必须离线可加载；不能意外从别的地址取到另一版 WASM。
    fetch: () => { throw new Error('验证运行时不允许联网'); },
    location: { href: pathToFileURL(glueAbs).href },
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const timer = setTimeout(() => readyReject(new Error('初始化超时')), 30_000);
  try {
    vm.runInContext(readFileSync(glueAbs, 'utf8'), vm.createContext(sandbox), { filename: glueAbs });
    await ready;
  } finally {
    clearTimeout(timer);
  }
  const FS = Module.FS ?? sandbox.FS;
  const callMain = Module.callMain ?? sandbox.callMain;
  assert.equal(typeof callMain, 'function', '缺少 callMain');
  assert.ok(FS, '缺少 FS');
  const hasStackApi = typeof Module.stackSave === 'function' && typeof Module.stackRestore === 'function';
  if (requireStackApi) assert.ok(hasStackApi, '必须导出 stackSave 与 stackRestore');
  const baselineFiles = FS.readdir('/').sort();
  const baselineStreams = FS.streams.filter(Boolean).length;

  const run = args => {
    stdout.length = 0;
    stderr.length = 0;
    if (aborted) throw aborted;
    const before = hasStackApi ? Module.stackSave() : null;
    let code;
    try {
      code = callMain([...args]);
    } finally {
      if (hasStackApi) assert.equal(Module.stackSave(), before, 'callMain 返回/抛错后必须恢复 WASM 栈');
    }
    if (aborted) throw aborted;
    if (code !== 0) throw new Error(stderr.join('\n') || `vgmstream 退出码 ${code}`);
    return { stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };

  return {
    Module, sandbox, FS, run,
    stackPointer: () => hasStackApi ? Module.stackSave() : null,
    heapBytes: () => sandbox.HEAPU8.byteLength,
    decode(bytes, { metadata = false } = {}) {
      try {
        FS.writeFile('/input.wem', new Uint8Array(bytes));
        const info = metadata ? run(['-m', '-i', '/input.wem']) : null;
        run(['-I', '-o', '/output.wav', '-i', '/input.wem']);
        const wav = Buffer.from(FS.readFile('/output.wav'));
        assert.ok(wav.length > 44, '解码 WAV 不完整');
        return { wav, info };
      } finally {
        for (const path of ['/input.wem', '/output.wav']) {
          try { FS.unlink(path); } catch { /* 解码失败时可能没有生成文件 */ }
        }
        assert.deepEqual(FS.readdir('/').sort(), baselineFiles, 'MEMFS 文件未回收');
        assert.equal(FS.streams.filter(Boolean).length, baselineStreams, 'MEMFS 句柄未回收');
      }
    },
  };
}
