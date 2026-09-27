# -*- coding: utf-8 -*-
"""
把整个工作台打包成一个「单文件 HTML」——方便直接发给别人（微信 / QQ 发一个文件即可）。

生成的 HTML 自带全部数据和样式，双击就能用，不需要解压、不需要联网、不需要服务器。

用法：
    python tools/build_single_file.py
    # 输出：湖北高考志愿工作台-单文件版.html
"""

from __future__ import annotations

import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
ASSETS_DIR = os.path.join(ROOT, "assets")
OUT = os.path.join(ROOT, "湖北高考志愿工作台-单文件版.html")


def read(path: str) -> str:
    with open(path, encoding="utf-8") as f:
        return f.read()


def safe_for_inline_script(code: str) -> str:
    """内联到 <script> 里时，避免出现会提前闭合标签的字符序列。"""
    return code.replace("</script", "<\\/script").replace("<!--", "<\\!--")


def main() -> int:
    index = read(os.path.join(ROOT, "index.html"))
    css = read(os.path.join(ASSETS_DIR, "style.css"))
    gk = read(os.path.join(ASSETS_DIR, "gk.js"))
    app = read(os.path.join(ASSETS_DIR, "app.js"))

    index_list = json.loads(
        re.search(r"GK\.setIndex\((\{.*\})\);", read(os.path.join(DATA_DIR, "index.js")), re.S).group(1)
    )["files"]

    data_blocks = []
    total = 0
    for name in index_list:
        code = read(os.path.join(DATA_DIR, name))
        total += len(code)
        data_blocks.append(f"<script>/* {name} */\n{safe_for_inline_script(code)}</script>")

    # 样式内联
    index = index.replace(
        '<link rel="stylesheet" href="assets/style.css" />',
        "<style>\n" + css + "\n</style>",
    )

    # 三处外链脚本替换为一个内联块：装载器 → 数据 → 逻辑
    inline = (
        "<script>\n" + safe_for_inline_script(gk) + "\n</script>\n"
        + "\n".join(data_blocks) + "\n"
        + "<script>\n" + safe_for_inline_script(app) + "\n</script>"
    )
    # 注意：替换内容里含正则反斜杠，必须用函数形式的 repl，否则会被当成转义序列
    index = re.sub(
        r'<script src="assets/gk\.js"></script>\s*'
        r'<script src="data/index\.js"></script>\s*'
        r'<script src="assets/app\.js"></script>',
        lambda _m: inline,
        index,
    )

    # 单文件版不需要动态加载 data/*.js
    index = index.replace(
        "var files = (GK.store.index && GK.store.index.files) || [];",
        "var files = [];   // 单文件版：数据已全部内联",
    )

    if 'src="assets/' in index or 'src="data/' in index:
        print("警告：仍存在未内联的外部引用，请检查 index.html", file=sys.stderr)

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(index)

    size = os.path.getsize(OUT)
    print(f"已生成：{OUT}")
    print(f"大小：{size:,} 字节（其中数据 {total:,} 字符，共 {len(index_list)} 个文件）")
    print("直接把这个 HTML 文件发给别人即可，双击就能用。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
