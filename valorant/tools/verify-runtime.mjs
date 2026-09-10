// 构建后运行，无需音频样本；实际 WASM 的全局/Module 两个入口必须都能反复调用。
import assert from 'node:assert/strict';
import { bootRuntime } from './runtime.mjs';

const [glue] = process.argv.slice(2);
if (!glue) throw new Error('用法: node tools/verify-runtime.mjs <glue.js>');
const rt = await bootRuntime(glue);
assert.equal(rt.Module.callMain, rt.sandbox.callMain, '全局和 Module 的 callMain 必须使用同一保护入口');
const stack = rt.stackPointer();
for (let i = 0; i < 100; i++) {
  // 帮助命令的具体退出码由 CLI 定义，此处只验证调用返回后栈严格归位。
  assert.equal(typeof rt.Module.callMain(['-h']), 'number');
  assert.equal(rt.stackPointer(), stack, `第 ${i + 1} 次 callMain 未恢复栈`);
}
console.log('运行时验证通过：栈接口已导出，callMain 连续 100 次栈位置不变。');
