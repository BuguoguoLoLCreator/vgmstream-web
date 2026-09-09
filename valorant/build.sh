#!/usr/bin/env bash
#
# 为 VALORANT PROTOCOL 语音站构建精简版 vgmstream WASM。
#
# 与上游 README 的通用配方的区别，以及每一条的理由，见同目录 README.md。
# 产物：dist/vgmstream-cli.js + dist/vgmstream-cli.wasm
#
#   ./build.sh                     # 用默认 pin 的 vgmstream 版本构建
#   VGMSTREAM_REF=master ./build.sh   # 跟随上游最新
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="${VGM_WORK_DIR:-$HERE/.work}"
DIST="$HERE/dist"

# 默认钉住已验证过的 upstream 提交，保证任何机器上构建结果可复现。
# 升级时改这里，并重新跑 tools/batch-compare.mjs 回归。
VGMSTREAM_REF="${VGMSTREAM_REF:-09c9f40caae4747e44b6a993b3d5b654cef4d1f7}"
CMAKE_VER="${CMAKE_VER:-3.31.6}"

mkdir -p "$WORK"
cd "$WORK"

# ---------- 工具链（免 root，装在 .work 内，不污染系统） ----------
CMAKE_DIR="$WORK/cmake-$CMAKE_VER-linux-x86_64"
if [ ! -x "$CMAKE_DIR/bin/cmake" ]; then
  echo "==> 下载 cmake $CMAKE_VER"
  curl -sfL --max-time 900 \
    "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VER/cmake-$CMAKE_VER-linux-x86_64.tar.gz" \
    -o cmake.tar.gz
  tar -xzf cmake.tar.gz
  rm -f cmake.tar.gz
fi
export PATH="$CMAKE_DIR/bin:$PATH"

if [ ! -d emsdk ]; then
  echo "==> 克隆 emsdk"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git emsdk
fi
echo "==> 安装并激活 emsdk latest"
(cd emsdk && ./emsdk install latest >/dev/null && ./emsdk activate latest >/dev/null)
# shellcheck disable=SC1091
source emsdk/emsdk_env.sh >/dev/null 2>&1
echo "    emcc: $(emcc --version | head -1)"

# ---------- 源码 ----------
if [ ! -d vgmstream ]; then
  echo "==> 克隆 vgmstream"
  git clone https://github.com/vgmstream/vgmstream.git vgmstream
fi
echo "==> 切到 $VGMSTREAM_REF"
git -C vgmstream fetch --all --tags --quiet
git -C vgmstream checkout --quiet "$VGMSTREAM_REF"
# 每次都从干净源码重新打补丁，避免重复运行时叠加。
git -C vgmstream reset --hard --quiet
echo "    $(git -C vgmstream log -1 --format='%h %ad' --date=short)"

# ---------- 裁剪格式注册表 ----------
# 这是体积上最大的一刀：注册表静态引用全部 559 个格式解析器，链接器因此一个都
# 无法 GC。裁到只剩 wwise 后，未被引用的 meta/ 与 coding/ 才会被丢弃。
echo "==> 裁剪格式注册表"
python3 "$HERE/trim-formats.py" "$WORK/vgmstream/src/vgmstream_init.c" ${VGM_KEEP_FORMATS:-wwise} \
  | sed 's/^/    /'

# ---------- 配置 ----------
# codec 裁剪：VALORANT 的 wem 全部是 Wwise Vorbis（fmt 标记 0xFFFF），
# 抽样 520 个真实文件（11 位特工 / 中英双轨 / 跨代际）验证，无一例外。
# 因此只保留 libvorbis，其余解码库全关——FFmpeg 是其中体积占比最大的一块。
#
# INCOMING_MODULE_JS_API：新版 emscripten 默认收窄了可从 Module 读取的入参，
# 不显式声明的话 Module.wasmBinary / print / printErr 会被静默忽略。
# wasmBinary 尤其关键：调用方预置字节后胶水就不会走 instantiateStreaming，
# 而 streaming 强校验 Content-Type 必须是 application/wasm——CDN 的压缩白名单
# 通常不含该类型，站点靠把对象传成 text/plain 换取压缩，两者不可兼得。
#
# MinSizeRel 而非 Release：实测 wasm 小 12%（br 后 615 vs 664 KB）且解码不更慢。
#
# 刻意不用的三个开关，都实测过：
#   -flto            体积再少一半，但产物会在连续解码时 memory access out of bounds。
#                    vgmstream 的 C 代码里有 LTO 会踩中的 UB。单文件测试发现不了，
#                    必须跑 tools/batch-compare.mjs 才暴露。**不要加回来。**
#   -sMALLOC=emmalloc 回归能过，但只省约 2 KB（br 后），不值得多一个变量。
#   --closure 1      省约 4 KB（br 后），但会重命名全局，使 self.FS / self.callMain
#                    失效。站内 Worker 依赖这两个全局，收益远小于代价。
BUILD_DIR="$WORK/build"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"
cd "$BUILD_DIR"

emcmake cmake "$WORK/vgmstream" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DUSE_FFMPEG=OFF \
  -DUSE_MPEG=OFF \
  -DUSE_ATRAC9=OFF \
  -DUSE_CELT=OFF \
  -DUSE_SPEEX=OFF \
  -DUSE_G719=OFF \
  -DUSE_G7221=OFF \
  -DUSE_VORBIS=ON \
  -DBUILD_CLI=ON \
  -DBUILD_V123=OFF \
  -DBUILD_AUDACIOUS=OFF \
  -DCMAKE_EXE_LINKER_FLAGS="-sINCOMING_MODULE_JS_API=wasmBinary,noInitialRun,print,printErr,onRuntimeInitialized,onAbort,locateFile -sEXPORTED_RUNTIME_METHODS=FS,callMain" \
  >/dev/null

echo "==> 编译"
make -j"$(nproc)" 2>&1 | tail -3

# ---------- 产物 ----------
mkdir -p "$DIST"
cp cli/vgmstream-cli.js cli/vgmstream-cli.wasm "$DIST/"
cp "$WORK/vgmstream/COPYING" "$DIST/COPYING"

echo
echo "==> 产物（$DIST）"
for f in vgmstream-cli.js vgmstream-cli.wasm COPYING; do
  printf '    %-20s %8d bytes\n' "$f" "$(stat -c%s "$DIST/$f")"
done
echo
echo "下一步：node tools/batch-compare.mjs <urls.txt> 60 <旧胶水.js> dist/vgmstream-cli.js"
