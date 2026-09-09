#!/usr/bin/env python3
"""把 vgmstream 的格式解析器注册表裁到只剩指定几项。

vgmstream_init.c 里的 init_vgmstream_functions[] 静态引用了全部 ~580 个格式
解析器，链接器因此一个都无法 GC——meta/（454 个文件）与它们各自拉起的
coding/ 解码器全部进了产物。把数组裁短后，未被引用的部分才会被丢弃。

只改数组本身，不动任何解析器源码：升级 upstream 时无需重新解冲突。

    python3 trim-formats.py <vgmstream_init.c> wwise [更多格式名…]
"""

import re
import sys


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2

    path, keep = sys.argv[1], sys.argv[2:]
    source = open(path, encoding="utf-8").read()

    start = source.index("init_vgmstream_functions[] = {")
    body_start = source.index("{", start) + 1
    body_end = source.index("\n};", body_start)
    body = source[body_start:body_end]

    # 逐项确认要保留的名字确实存在，避免拼错后静默裁成空表。
    present = set(re.findall(r"init_vgmstream_(\w+)", body))
    missing = [name for name in keep if name not in present]
    if missing:
        print(f"错误: 注册表里没有这些格式: {', '.join(missing)}", file=sys.stderr)
        return 1

    total = len(re.findall(r"^\s*init_vgmstream_\w+\s*,", body, re.M))
    kept = ",\n".join(f"    init_vgmstream_{name}" for name in keep)
    patched = f"{source[:body_start]}\n{kept},\n{source[body_end:]}"
    open(path, "w", encoding="utf-8").write(patched)

    print(f"格式注册表: {total} → {len(keep)} 项（保留 {', '.join(keep)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
