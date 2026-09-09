# VALORANT PROTOCOL 语音站专用 vgmstream WASM 构建

上游 [vgmstream-web](https://github.com/KatieFrogs/vgmstream-web) 的 README 给的是通用配方：
克隆 vgmstream、`emcmake cmake` + `make`，产出一份**开启全部解码库**的 `vgmstream-cli.wasm`。
本目录在此基础上做 VALORANT 场景的裁剪与契约固定，产物供
[Valorant-Protocol](https://github.com/BuguoguoLoLCreator/Valorant-Protocol) 的语音站
（`/voice`）在浏览器 Worker 内解码 `.wem` 使用。

上游播放器（`index.html`、`js/`、`css/`）原样保留，本目录不改动它。

## 用法

```bash
./build.sh                        # 用钉住的 vgmstream 版本构建
VGMSTREAM_REF=master ./build.sh   # 跟随上游最新
```

工具链（cmake + emsdk）自动装进 `.work/`，不需要 root、不污染系统。
产物落在 `dist/`：`vgmstream-cli.js`、`vgmstream-cli.wasm`、`COPYING`。

## 与通用配方的四点差异

### 1. 只保留 Wwise Vorbis，其余解码库全关

VALORANT 的语音 `.wem` 全部是 Wwise Vorbis。判定依据不是推测：用
`tools/sample-formats.mjs` 对 **520 个真实文件**（11 位特工、中英双音轨、跨初代到最新代际）
做 Range 抽样读 RIFF `fmt ` 标记，结果 100% 为 `0xFFFF`，没有出现 Opus、XMA、ADPCM。

因此关掉 `USE_FFMPEG` / `USE_MPEG` / `USE_ATRAC9` / `USE_CELT` / `USE_SPEEX` /
`USE_G719` / `USE_G7221`，只留 `USE_VORBIS`。其中 FFmpeg 是体积占比最大的一块。

**这条是有前提的裁剪。** 若 Riot 之后改用 Wwise Opus 之类的编码，本构建会解不出该文件
（表现为解码失败而非静默错音）。升级或怀疑时重跑一次抽样即可确认。

### 2. 显式声明 `INCOMING_MODULE_JS_API`

新版 emscripten 默认收窄了可从 `Module` 读取的入参。不声明的话，
`Module.wasmBinary`、`Module.print`、`Module.printErr` 会被**静默忽略**——
胶水里 `var wasmBinary;` 是个从不赋值的局部变量，`out`/`err` 直接写死成 `console.log/error`。

其中 `wasmBinary` 尤其关键。调用方预置字节后，胶水不会去 `fetch`；一旦没预置，
它会走 `WebAssembly.instantiateStreaming`，而 streaming **强校验响应
`Content-Type: application/wasm`**。CDN 的压缩白名单通常不含该类型，站点是靠把
wasm 对象传成 `text/plain` 才换来 br/gzip 压缩的——两者不可兼得。所以这条不是可选项。

同时 `-sEXPORTED_RUNTIME_METHODS=FS,callMain` 把这两个方法显式挂到 `Module` 上，
非模块化脚本原本就会把它们暴露为全局（Worker 里即 `self.FS`），两条路径都可用。

### 3. `MinSizeRel` 而非 `Release`

实测 wasm 小 12%（brotli 后 615 KB vs 664 KB），解码耗时反而略低
（同一文件 5 次均值 9.7 ms vs 10.1 ms，差异在噪声内）。没有理由用更大的那个。

### 4. 钉住 vgmstream 版本

`build.sh` 里的 `VGMSTREAM_REF` 默认指向已跑过回归的 upstream 提交，保证任何机器上
结果可复现。升级时改这个值，然后重跑回归。

## 验证工具

```bash
# 1. 抽样真实 wem 的编码分布——裁剪 codec 前必做
node tools/sample-formats.mjs wem-urls.txt 400

# 2. 单文件解码 + 元数据（模拟站内 Worker 环境，非浏览器）
node tools/run-vgmstream.mjs dist/vgmstream-cli.js sample.wem out.wav

# 3. 新旧构建批量逐样本比对
node tools/batch-compare.mjs wem-urls.txt 60 old/vgmstream-cli.js dist/vgmstream-cli.js
```

`run-vgmstream.mjs` 用 `node:vm` 建了一个模拟 Worker 的全局环境来加载胶水。
不能用 `require()`（非模块化脚本的 `var Module` 会变成模块局部，配置读不到、`FS` 取不着），
也不能用 `new Function()` 包装（作用域链改变会导致 wasm 导入解析失败，报
`function import requires a callable`）。

## 已验证结果

针对 60 个真实 VALORANT wem，新构建与线上旧构建（r1810 全量）逐样本比对：

| 项 | 结果 |
| --- | --- |
| 解码成功 | 60/60，两版输出长度完全一致 |
| 最大单样本偏差 | 1（16-bit 满量程 32768，约 −90 dBFS） |
| 传输体积（wasm + 胶水，brotli） | 1301 KB → **680 KB** |

±1 LSB 的差异来自 r2117 内部改用 float 解码（元数据新增 `sample type: float`），
与 r1810 的定点路径舍入不同，不可闻。

## 许可

vgmstream 为 ISC，`dist/COPYING` 随产物一同分发。上游 vgmstream-web 的许可见仓库根 `LICENSE`。
