# -*- coding: utf-8 -*-
"""
湖北高考志愿工作台 —— 数据获取脚本

职责：把所有外部数据源下载到 data_raw/，并记录来源、抓取时间、字节数、SHA-256。
只用 Python 标准库，不需要 pip install。

用法：
    python tools/fetch_data.py            # 抓取全部数据源
    python tools/fetch_data.py --only admissions
    python tools/fetch_data.py --check    # 只校验已有文件，不下载

数据来源与许可：
  1) 投档线（院校专业组）   secnotes/gaokao                MIT
  2) 一分一段表（2024）      FlySky-z/gaokao-analysis       公开数据
  3) 批次线（录取控制分数线） 湖北省教育厅 / 中国教育在线      官方公开
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data_raw")

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
CN_TZ = timezone(timedelta(hours=8))

# ---------------------------------------------------------------- 数据源清单

SECNOTES_MIRRORS = [
    "https://cdn.jsdelivr.net/gh/secnotes/gaokao@main/{path}",
    "https://raw.githubusercontent.com/secnotes/gaokao/main/{path}",
    "https://gcore.jsdelivr.net/gh/secnotes/gaokao@main/{path}",
]

YEARS = (2024, 2025, 2026)
CATEGORIES = {"physics": "物理类", "history": "历史类"}
LEVELS = {"benke": "本科", "zhuanke": "专科"}

ADMISSION_SOURCES = []
for _y in YEARS:
    for _cat, _cat_cn in CATEGORIES.items():
        for _lv, _lv_cn in LEVELS.items():
            _rel = f"data/by_province/hubei/{_y}_{_cat}_{_lv}.json"
            ADMISSION_SOURCES.append(
                {
                    "kind": "admissions",
                    "key": f"admissions_{_y}_{_cat}_{_lv}",
                    "path": _rel,
                    "urls": [m.format(path=_rel) for m in SECNOTES_MIRRORS],
                    "out": f"admissions_{_y}_{_cat}_{_lv}.json",
                    "publisher": "湖北省招办（原始投档线 PDF），经 secnotes/gaokao 结构化",
                    "license": "MIT（数据整理）／原始数据为政府公开信息",
                    "desc": f"湖北 {_y} 年 {_cat_cn}{_lv_cn}批 院校专业组投档最低分",
                }
            )

SEGMENT_SOURCES = [
    {
        "kind": "segments",
        "key": "segments_2024_physics",
        "urls": [
            "https://cdn.jsdelivr.net/gh/FlySky-z/gaokao-analysis@main/web/data/ranking_score_hubei_physics.json",
            "https://raw.githubusercontent.com/FlySky-z/gaokao-analysis/main/web/data/ranking_score_hubei_physics.json",
        ],
        "out": "segments_2024_physics.json",
        "publisher": "湖北省教育考试院（2024 一分一段表），经 FlySky-z/gaokao-analysis 数字化",
        "license": "公开数据",
        "desc": "湖北 2024 年普通高考一分一段表（首选物理）",
    },
    {
        "kind": "segments",
        "key": "segments_2024_history",
        "urls": [
            "https://cdn.jsdelivr.net/gh/FlySky-z/gaokao-analysis@main/web/data/ranking_score_hubei_history.json",
            "https://raw.githubusercontent.com/FlySky-z/gaokao-analysis/main/web/data/ranking_score_hubei_history.json",
        ],
        "out": "segments_2024_history.json",
        "publisher": "湖北省教育考试院（2024 一分一段表），经 FlySky-z/gaokao-analysis 数字化",
        "license": "公开数据",
        "desc": "湖北 2024 年普通高考一分一段表（首选历史）",
    },
]

ALL_SOURCES = ADMISSION_SOURCES + SEGMENT_SOURCES


# ---------------------------------------------------------------- 工具函数


def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def http_get(url: str, timeout: int = 90) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "zh-CN,zh;q=0.9",
            "Referer": "https://github.com/secnotes/gaokao",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def fetch_one(src: dict, force: bool = False) -> dict:
    dest = os.path.join(RAW_DIR, src["out"])
    if os.path.exists(dest) and not force:
        size = os.path.getsize(dest)
        log(f"  [跳过] {src['out']} 已存在（{size:,} 字节）")
        return {
            "key": src["key"],
            "kind": src["kind"],
            "file": src["out"],
            "bytes": size,
            "sha256": sha256_of(dest),
            "url": "（本次未重新下载）",
            "publisher": src["publisher"],
            "license": src["license"],
            "desc": src["desc"],
        }

    last_err = None
    for url in src["urls"]:
        try:
            log(f"  [下载] {src['out']}  <-  {url}")
            data = http_get(url)
            if len(data) < 200:
                raise ValueError(f"返回内容过短（{len(data)} 字节），疑似错误页")
            tmp = dest + ".part"
            with open(tmp, "wb") as f:
                f.write(data)
            os.replace(tmp, dest)
            log(f"  [完成] {src['out']}  {len(data):,} 字节")
            return {
                "key": src["key"],
                "kind": src["kind"],
                "file": src["out"],
                "bytes": len(data),
                "sha256": sha256_of(dest),
                "url": url,
                "publisher": src["publisher"],
                "license": src["license"],
                "desc": src["desc"],
            }
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, TimeoutError, OSError) as e:
            last_err = e
            log(f"  [失败] {url}  ->  {e}")
            time.sleep(1.0)

    raise RuntimeError(f"{src['out']} 全部镜像均下载失败：{last_err}")


# ---------------------------------------------------------------- 主流程


def main() -> int:
    ap = argparse.ArgumentParser(description="下载湖北高考志愿数据到 data_raw/")
    ap.add_argument("--only", choices=["admissions", "segments"], help="只抓取某一类数据")
    ap.add_argument("--force", action="store_true", help="即使本地已存在也重新下载")
    ap.add_argument("--check", action="store_true", help="只校验已有文件，不联网下载")
    args = ap.parse_args()

    os.makedirs(RAW_DIR, exist_ok=True)

    sources = ALL_SOURCES
    if args.only:
        sources = [s for s in sources if s["kind"] == args.only]

    log(f"目标目录：{RAW_DIR}")
    log(f"待处理数据源：{len(sources)} 个\n")

    records = []
    failures = []
    for i, src in enumerate(sources, 1):
        log(f"[{i}/{len(sources)}] {src['desc']}")
        if args.check:
            dest = os.path.join(RAW_DIR, src["out"])
            if not os.path.exists(dest):
                failures.append(src["out"])
                log("  [缺失] 文件不存在")
                continue
            records.append(
                {
                    "key": src["key"],
                    "kind": src["kind"],
                    "file": src["out"],
                    "bytes": os.path.getsize(dest),
                    "sha256": sha256_of(dest),
                    "url": "（--check 模式，未记录）",
                    "publisher": src["publisher"],
                    "license": src["license"],
                    "desc": src["desc"],
                }
            )
            continue
        try:
            records.append(fetch_one(src, force=args.force))
        except Exception as e:  # noqa: BLE001
            failures.append(src["out"])
            log(f"  [错误] {e}")

    manifest_path = os.path.join(RAW_DIR, "sources.json")
    manifest = {
        "province": "湖北",
        "purpose": "高考志愿填报工作台（考生为武汉考生）",
        "generated_at": datetime.now(CN_TZ).isoformat(timespec="seconds"),
        "note": (
            "所有数据均为公开的招生录取信息，仅用于个人志愿填报分析，"
            "不得用于商业用途；最终以湖北省教育考试院、省招办及高校官网公布为准。"
        ),
        "files": records,
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    log(f"\n来源清单已写入：{manifest_path}")

    if failures:
        log(f"\n有 {len(failures)} 个文件未获取：{', '.join(failures)}")
        log("（可稍后重跑：python tools/fetch_data.py）")
        return 1
    log("\n全部数据源就绪。下一步：python tools/build_data.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
