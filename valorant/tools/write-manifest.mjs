// 只登记发布所需的公开产物，便于 CDN 上传后核对同一批 JS/WASM；不包含工作目录或环境变量。
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [dist, vgmstreamRef, emscriptenVersion, cmakeVersion, runtimeRevision] = process.argv.slice(2);
if (!dist || !vgmstreamRef || !emscriptenVersion || !cmakeVersion || !runtimeRevision) throw new Error('缺少构建清单参数');
const files = {};
for (const name of ['vgmstream-cli.js', 'vgmstream-cli.wasm', 'COPYING']) {
  const bytes = readFileSync(join(dist, name));
  files[name] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}
writeFileSync(join(dist, 'build-info.json'), JSON.stringify({
  runtimeRevision, vgmstreamRef, emscriptenVersion, cmakeVersion,
  exportedRuntimeMethods: ['FS', 'callMain', 'stackSave', 'stackRestore'],
  stackRestoration: 'callMain-finally', files,
}, null, 2) + '\n');
