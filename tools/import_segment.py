# -*- coding: utf-8 -*-
"""
湖北高考志愿工作台 —— 一分一段表导入器

为什么需要它：
  湖北省教育考试院把 2025/2026 年的一分一段表以「图片」形式发布，
  程序无法直接读取。没有它，对应年份就只能用线差法（分差法）估算。
  把官方表里的数字录进来（或从学校发的纸质/PDF 表抄录），
  该年份就自动解锁「位次法」，精度更高。

支持的输入格式（自动识别，列顺序为 分数、本段人数、累计人数）：
  1) 三列：691,3,25
  2) 两列：691,25          （只有分数和累计人数，本段人数自动推算）
  3) 直接粘贴官方表格文本，允许用空格 / 制表符 / 逗号 / 顿号分隔
  4) 带表头也行，脚本会自动跳过非数字行

用法：
    # 生成空白模板，照着官方表填
    python tools/import_segment.py --template --year 2026 --category 物理类

    # 导入（CSV / TXT 都可以）
    python tools/import_segment.py --year 2026 --category 物理类 --input 2026物理一分一段.csv

    # 导入后请重新构建，让前端加载到新数据
    python tools/build_data.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(ROOT, "data")
RAW_DIR = os.path.join(ROOT, "data_raw")
CN_TZ = timezone(timedelta(hours=8))

YEAR_TO_KEY = {2024: "2024", 2025: "2025", 2026: "2026", 2027: "2027"}
CAT_TO_KEY = {"物理类": "physics", "历史类": "history"}


def log(msg: str) -> None:
    print(msg, flush=True)


def parse_lines(text: str) -> list[tuple[int, int | None, int | None]]:
    """把任意粘贴文本解析成 (分数, 本段人数, 累计人数) 列表。"""
    rows = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # 统一全角符号
        line = line.replace("，", ",").replace("、", ",").replace("　", " ")
        nums = re.findall(r"\d+(?:\.\d+)?", line)
        if not nums:
            continue
        vals = [int(float(n)) for n in nums]
        if len(vals) == 1:
            rows.append((vals[0], None, None))
        elif len(vals) == 2:
            # 两列：可能是 (分数, 累计人数) 或 (分数, 本段人数)
            rows.append((vals[0], None, vals[1]))
        else:
            rows.append((vals[0], vals[1], vals[2]))
    return rows


def normalize(rows: list[tuple[int, int | None, int | None]]) -> tuple[list[list[int]], list[str]]:
    """补全缺失列、排序、校验，返回 (data, warnings)。"""
    warnings: list[str] = []

    # 只保留 100~750 之间的分数行，避免把页码、年份等噪声带进来
    cleaned = [(s, n, a) for (s, n, a) in rows if 100 <= s <= 750]
    dropped = len(rows) - len(cleaned)
    if dropped > 0:
        warnings.append(f"忽略了 {dropped} 行无法识别为分数段的内容（分数不在 100~750 范围）")

    if not cleaned:
        raise ValueError("没有解析到任何有效的「分数」行，请检查输入格式。")

    # 同分数只保留一条（后出现的覆盖前者）
    by_score: dict[int, tuple[int, int | None, int | None]] = {}
    for s, n, a in cleaned:
        by_score[s] = (s, n, a)
    ordered = [by_score[s] for s in sorted(by_score, reverse=True)]

    # 判断是「累计人数」模式还是「本段人数」模式
    has_accumulate = sum(1 for (_, _, a) in ordered if a is not None)
    use_accumulate = has_accumulate >= max(3, len(ordered) // 2)

    data: list[list[int]] = []
    if use_accumulate:
        prev = 0
        for s, n, a in ordered:
            if a is None:
                warnings.append(f"{s} 分缺少累计人数，已按上一行推算")
                a = prev
            if a < prev:
                warnings.append(f"{s} 分累计人数回退（{prev} → {a}），已按较大值处理")
                a = prev
            num = (a - prev) if n is None else n
            if num < 0:
                num = 0
            data.append([s, num, a])
            prev = a
    else:
        total = 0
        for s, n, _ in ordered:
            n = n or 0
            total += n
            data.append([s, n, total])
        warnings.append("输入看起来是「本段人数」格式，累计人数由脚本累加得到，请抽查几个分数核对")

    # 一致性检查：累计人数应等于本段人数之和
    if use_accumulate and len(data) > 5:
        accum_last = data[-1][2]
        sum_num = sum(row[1] for row in data)
        if accum_last and abs(accum_last - sum_num) / accum_last > 0.02:
            warnings.append(
                f"累计人数合计 {accum_last:,} 与本段人数合计 {sum_num:,} 相差超过 2%，"
                "可能是漏抄了中间分数段，建议补齐后再用"
            )

    # 广播：低于最低分的一律用最大累计人数（位次法用不到，但保证单调）
    return data, warnings


def write_js(year: int, category: str, data: list[list[int]], source_note: str) -> str:
    payload = {
        "year": year,
        "category": category,
        "source": source_note,
        "fields": ["分数", "本分人数", "累计人数"],
        "data": data,
    }
    cat_key = CAT_TO_KEY[category]
    out = os.path.join(DATA_DIR, f"segments_{year}_{cat_key}.js")
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write("GK.addSegments(" + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ");\n")
    return out


def rebuild_index() -> None:
    """重新扫描 data/ 目录，刷新前端加载清单（不动已经生成的数据文件）。"""
    files = []
    if os.path.exists(os.path.join(DATA_DIR, "meta.js")):
        files.append("meta.js")
    names = sorted(os.listdir(DATA_DIR))
    for n in names:
        if n.startswith("admissions_") and n.endswith(".js"):
            files.append(n)
    for n in names:
        if n.startswith("segments_") and n.endswith(".js"):
            files.append(n)
    with open(os.path.join(DATA_DIR, "index.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write("GK.setIndex(" + json.dumps({"files": files}, ensure_ascii=False, separators=(",", ":")) + ");\n")
    log(f"已刷新加载清单 data/index.js（共 {len(files)} 个文件）")


def make_template(year: int, category: str) -> str:
    """生成从 750 到 100 的空白模板，照着官方表填累计人数即可。"""
    path = os.path.join(ROOT, f"一分一段模板_{year}_{category}.csv")
    with open(path, "w", encoding="utf-8-sig", newline="\n") as f:
        f.write("分数,本段人数,累计人数\n")
        for s in range(750, 99, -1):
            f.write(f"{s},,\n")
    return path


def main() -> int:
    ap = argparse.ArgumentParser(description="导入湖北一分一段表，解锁位次法")
    ap.add_argument("--year", type=int, required=True, help="年份，例如 2026")
    ap.add_argument("--category", required=True, choices=["物理类", "历史类"])
    ap.add_argument("--input", help="CSV / TXT 文件路径；不填则从标准输入读取")
    ap.add_argument("--template", action="store_true", help="只生成空白模板，不导入")
    ap.add_argument("--note", default="", help="来源备注，写进数据文件，例如『省考试院官网 PDF 手工录入』")
    args = ap.parse_args()

    if args.template:
        path = make_template(args.year, args.category)
        log(f"已生成模板：{path}")
        log("照着官方一分一段表，把「累计人数」列填上（本段人数可留空），然后：")
        log(f"  python tools/import_segment.py --year {args.year} --category {args.category} --input \"{os.path.basename(path)}\"")
        return 0

    if args.input:
        if not os.path.exists(args.input):
            log(f"找不到输入文件：{args.input}")
            return 1
        with open(args.input, encoding="utf-8-sig") as f:
            text = f.read()
        src_desc = args.input
    else:
        log("请粘贴一分一段表内容（分数 / 本段人数 / 累计人数），粘贴完按 Ctrl+Z 回车结束：")
        text = sys.stdin.read()
        src_desc = "手工录入"

    try:
        rows = parse_lines(text)
        data, warnings = normalize(rows)
    except ValueError as e:
        log(f"解析失败：{e}")
        return 1

    note = args.note or f"用户导入（{src_desc}）"
    note = f"{note}；导入时间 {datetime.now(CN_TZ).isoformat(timespec='seconds')}"

    os.makedirs(DATA_DIR, exist_ok=True)
    out = write_js(args.year, args.category, data, note)

    log(f"\n解析到 {len(data)} 个分数段：{data[0][0]} 分（累计 {data[0][2]:,}）"
        f" ~ {data[-1][0]} 分（累计 {data[-1][2]:,}）")
    if warnings:
        log("\n需要注意的地方：")
        for w in warnings:
            log("  - " + w)
    log(f"\n已写入：{out}")

    # 顺便记一份原始输入，方便日后核对
    os.makedirs(RAW_DIR, exist_ok=True)
    keep = os.path.join(RAW_DIR, f"segments_{args.year}_{CAT_TO_KEY[args.category]}.imported.txt")
    with open(keep, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    log(f"原始录入内容已备份：{keep}")

    rebuild_index()
    log("\n完成。重新打开（或刷新）index.html 即可使用该年份的位次法。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
