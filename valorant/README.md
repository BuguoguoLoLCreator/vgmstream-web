# VALORANT PROTOCOL 语音站专用 vgmstream WASM 构建

上游 [vgmstream-web](https://github.com/KatieFrogs/vgmstream-web) 的 README 给的是通用配方：
克隆 vgmstream、`emcmake cmake` + `make`，产出一份**开启全部解码库**的 `vgmstream-cli.wasm`。
本目录在此基础上做 VALORANT 场景的裁剪与契约固定，产物供
[Valorant-Protocol](https://github.com/BuguoguoLoLCreator/Valorant-Protocol) 的语音站
（`/voice`）在浏览器 Worker 内解码 `.wem` 使用。

上游播放器（`index.html`、`js/`、`css/`）原样保留，本目录不改动它。

## 用法

以下命令从 `valorant/` 目录执行。

```bash
./build.sh                        # 用钉住的 vgmstream / Emscripten / CMake 构建
VGMSTREAM_REF=master VGM_RUNTIME_REVISION=dev-master ./build.sh  # 升级时另起修订号
```

工具链（CMake 3.31.6 + Emscripten 6.0.9）自动装进 `.work/`，不需要 root、不污染系统。
需要 Git、Python 3.10+、make 和 C 编译环境；macOS 可用 `EMSDK_PYTHON=/path/to/python3.13` 指定 Python。
支持 Linux x86_64/aarch64 和 macOS arm64/x86_64；本次完整构建在 macOS arm64 验证。
`VGM_WORK_DIR` 可把下载、源码和构建缓存放到其它目录，`VGM_BUILD_JOBS` 控制并发（默认 8）。

产物落在 `dist/`：`vgmstream-cli.js`、`vgmstream-cli.wasm`、`COPYING`、`build-info.json`。
构建清单记录实际 upstream 提交、工具链版本和三个公开文件的 SHA-256。
脚本在退出前运行真实 WASM 自检，缺少栈接口或连续调用后栈漂移均会使构建失败。

## 与通用配方的五点差异

### 1. 只保留 Wwise Vorbis，其余解码库全关

VALORANT 的语音 `.wem` 全部是 Wwise Vorbis。判定依据不是推测：用
`tools/sample-formats.mjs` 对 **520 个真实文件**（11 位特工、中英双音轨、跨初代到最新代际）
做 Range 抽样读 RIFF `fmt ` 标记，结果 100% 为 `0xFFFF`，没有出现 Opus、XMA、ADPCM。

因此关掉 `USE_FFMPEG` / `USE_MPEG` / `USE_ATRAC9` / `USE_CELT` / `USE_SPEEX` /
`USE_G719` / `USE_G7221`，只留 `USE_VORBIS`。其中 FFmpeg 是体积占比最大的一块。

**这条是有前提的裁剪。** 若 Riot 之后改用 Wwise Opus 之类的编码，本构建会解不出该文件
（表现为解码失败而非静默错音）。升级或怀疑时重跑一次抽样即可确认。

### 2. 把格式注册表裁到只剩 Wwise

体积上最大的一刀。`src/vgmstream_init.c` 的 `init_vgmstream_functions[]` 静态引用了
**559 个**格式解析器，链接器因此一个都无法 GC——`meta/`（454 个文件）连同它们各自
拉起的 `coding/` 解码器全部进了产物。`trim-formats.py` 把这张表裁到只剩
`init_vgmstream_wwise`，其余代码随即被丢弃：wasm 1863 KB → 1210 KB，brotli 后 615 → 361 KB。

脚本只改注册表数组、不动任何解析器源码，升级 upstream 时不会产生冲突；要多留格式就
`VGM_KEEP_FORMATS="wwise riff" ./build.sh`。

### 3. 声明 Module 接口，并让 callMain 自动恢复栈

新版 emscripten 默认收窄了可从 `Module` 读取的入参。不声明的话，
`Module.wasmBinary`、`Module.print`、`Module.printErr` 会被**静默忽略**——
胶水里 `var wasmBinary;` 是个从不赋值的局部变量，`out`/`err` 直接写死成 `console.log/error`。

其中 `wasmBinary` 尤其关键。调用方预置字节后，胶水不会去 `fetch`；一旦没预置，
它会走 `WebAssembly.instantiateStreaming`，而 streaming **强校验响应
`Content-Type: application/wasm`**。CDN 的压缩白名单通常不含该类型，站点是靠把
wasm 对象传成 `text/plain` 才换来 br/gzip 压缩的——两者不可兼得。所以这条不是可选项。

`-sEXPORTED_RUNTIME_METHODS=FS,callMain,stackSave,stackRestore` 显式导出文件系统、CLI 和栈接口。
原始 Emscripten `callMain` 每次为 argv 分配 WASM 栈却不归还；旧产物用本站参数每次留下 128 字节，
有效 WEM 也会在反复调用后损坏运行时。仅导出接口或增大栈大小都不会自动修复调用。

`restore-stack.js` 通过 `--post-js` 加入胶水，用 `try/finally` 保存、恢复每次调用的栈，
同时更新全局 `callMain` 与 `Module.callMain`，覆盖正常返回、非零退出码和异常。
本站 Worker 还会成对保存/恢复栈；两层保护可安全嵌套，旧客户端的全局入口同样受到保护。
没有修改音频解码算法、codec 选择或格式裁剪。致命 WASM 错误仍应销毁实例，恢复栈不能修复其它已损坏状态。

### 4. `MinSizeRel` 而非 `Release`，且刻意不用 LTO

`MinSizeRel` 实测 wasm 小 12%（brotli 后 615 KB vs 664 KB），解码耗时反而略低
（同一文件 5 次均值 9.7 ms vs 10.1 ms，差异在噪声内）。没有理由用更大的那个。

以下三个开关**试过并刻意放弃**：

| 开关 | 收益 | 放弃原因 |
| --- | --- | --- |
| `-flto` | 历史实验 wasm 再少一半（1210 → 599 KB） | 历史连续解码出现 `memory access out of bounds`。当时未排除 argv 栈累积，因此不能据此确认 C 代码 UB；本次保持关闭，重新启用须单独验证。 |
| `-sMALLOC=emmalloc` | 约 2 KB（br 后） | 回归能过，但收益不值得多一个变量。 |
| `--closure 1` | 约 4 KB（br 后） | 会重命名全局，使 `self.FS` / `self.callMain` 失效。站内 Worker 依赖这两个全局。 |

前两条合起来省不到总量的 2%，第一条还会静默产出坏构建——这是「再压一点」的收益上限。

### 5. 钉住源码与工具链版本

`build.sh` 固定 `VGMSTREAM_REF`、`EMSDK_VERSION` 和 `CMAKE_VER`，避免 `emsdk latest` 无声改变产物。
构建清单使用解析后的完整 upstream commit；更换源码、工具链或编译参数时必须设置新的
`VGM_RUNTIME_REVISION`，并重新跑单实例压力测试和新旧产物比较。

## 验证工具

```bash
# 1. 抽样真实 wem 的编码分布——裁剪 codec 前必做
node tools/sample-formats.mjs wem-urls.txt 400

# 2. 单文件解码 + 元数据（模拟站内 Worker 环境，非浏览器）
node tools/run-vgmstream.mjs dist/vgmstream-cli.js sample.wem out.wav

# 3. 新旧构建批量逐样本比对
node tools/batch-compare.mjs wem-urls.txt 400 old/vgmstream-cli.js dist/vgmstream-cli.js 0

# 4. 新产物全程复用同一个 WASM 实例，检查栈、MEMFS、句柄与重复 WAV 字节
node tools/stress-decode.mjs dist/vgmstream-cli.js samples 10000

# 5. 不依赖 WASM 下载的调用保护与 WAV 比较工具回归
node --test tests/*.test.mjs
```

验证工具共用 `tools/runtime.mjs`，用 `node:vm` 建立模拟 Worker 的全局环境来加载真实胶水和 WASM。
不能用 `require()`（非模块化脚本的 `var Module` 会变成模块局部，配置读不到、`FS` 取不着），
也不能用 `new Function()` 包装（作用域链改变会导致 wasm 导入解析失败，报
`function import requires a callable`）。验证驱动本身不替调用恢复栈，避免掩盖产物漏带 `--post-js` 的问题。

批量比较的新运行时始终复用；缺少栈接口的旧基线按样本重新初始化，避免旧版先爆栈而污染比较。
下载失败、样本不足、解码失败、PCM 格式/长度变化或超过允许偏差都会返回非零退出码。
最后一个参数为最大允许 PCM16 偏差：本次修复用 `0`；历史 r1810 → r2117 升级可用默认 `1`。
下载缓存默认在 `samples/`，可用 `VGM_SAMPLE_DIR` 覆盖；WEM、WAV、日志与构建目录不提交。

## r2117-stack-v1 验证结果

- 对照当前生产 r2117：4 位特工 × 2 种语言 × 50 段，共 400 个 WEM，WAV **400/400 逐字节相同**，PCM 最大偏差 0。
- 同一实例循环上述 400 段共 10,000 次：栈指针始终为 `1044928`，WASM 内存保持 `17,825,792` 字节，文件与句柄均回收。
- 新产物胶水 62,456 字节（+502），WASM 1,238,907 字节（+28）。这是当前固定工具链在 macOS arm64 的结果。

## 发布与回滚

把 `dist/` 的四个公开文件整批上传到独立目录 `vgmstream/r2117-stack-v1/`，按 `build-info.json` 核验哈希。
目录需匿名 CORS；WASM 保持 `Content-Type: text/plain` 以适配现有 CDN 压缩策略，JS 使用 JavaScript 类型。
带修订号的目录可用 `Cache-Control: public, max-age=31536000, immutable`，发布后不得原地覆盖。

**先上传并核验运行时，再把本站构建环境的 `PUBLIC_VOICE_WASM_BASE` 切到新目录并重新发布前端。**
只改本站代码默认值不会覆盖显式配置的旧环境变量。保留旧目录；回滚时切回旧地址并重建前端，
本站遇到缺少栈接口的旧运行时会退回每段解码后回收 Worker 的兼容方式。

部署包只应包含这四个公开文件，不包含 `.work/`、源码、样本、环境文件或日志。

## 历史压缩验证

针对 60 个真实 VALORANT wem，新构建与线上旧构建（r1810 全量）逐样本比对：

| 项 | 结果 |
| --- | --- |
| 解码成功 | 60/60，两版输出长度完全一致 |
| 最大单样本偏差 | 1（16-bit 满量程 32768，约 −90 dBFS） |
| 传输体积（wasm + 胶水，brotli） | 1301 KB → **377 KB** |

逐步的体积变化：

| 配置 | wasm 裸 | wasm brotli |
| --- | --- | --- |
| r1810 全量（历史基线） | 3738 KB | 1280 KB |
| r2117 + 裁 codec | 1863 KB | 615 KB |
| + 裁格式注册表 | 1210 KB | **361 KB** |

±1 LSB 的差异来自 r2117 内部改用 float 解码（元数据新增 `sample type: float`），
与 r1810 的定点路径舍入不同，不可闻。

## 许可

vgmstream 为 ISC，`dist/COPYING` 随产物一同分发。上游 vgmstream-web 的许可见仓库根 `LICENSE`。
