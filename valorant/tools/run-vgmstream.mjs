// node tools/run-vgmstream.mjs <glue.js> <input.wem> [out.wav]
// 用真实 WASM 连续读取元数据和解码，栈/文件清理由共用验证驱动检查。
import { readFileSync, writeFileSync } from 'node:fs';
import { bootRuntime } from './runtime.mjs';

const [glue, input, output] = process.argv.slice(2);
if (!glue || !input) {
  console.error('用法: node tools/run-vgmstream.mjs <glue.js> <input.wem> [out.wav]');
  process.exit(2);
}
const rt = await bootRuntime(glue);
const { wav, info } = rt.decode(readFileSync(input), { metadata: true });
if (info.stdout) console.log(info.stdout);
if (info.stderr) console.error(info.stderr);
console.log(`WAV ${wav.length} 字节`);
if (output) {
  writeFileSync(output, wav);
  console.log(`已写入 ${output}`);
}
