# -*- coding: utf-8 -*-
"""
湖北高考志愿工作台 —— 数据构建脚本

把 data_raw/ 里的原始 JSON 规范化成前端可直接加载的 data/*.js，
同时做数据对账校验，任何异常都会写进 build_report.md（不静默掩盖）。

用法：
    python tools/build_data.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "data_raw")
DATA_DIR = os.path.join(ROOT, "data")
CN_TZ = timezone(timedelta(hours=8))

YEARS = (2024, 2025, 2026)
CATEGORIES = {"physics": "物理类", "history": "历史类"}
LEVELS = {"benke": "本科", "zhuanke": "专科"}

# 湖北新高考政策参数（会写进前端 config，实现时以当年官方文件为准）
POLICY = {
    "province": "湖北",
    "mode": "3+1+2（首选物理/历史，再选 2 科）",
    "first_subject": ["物理类", "历史类"],
    "second_subject": ["化学", "生物", "思想政治", "地理"],
    "batches": {
        "本科普通批": {
            "volunteers": 45, "majors_per_volunteer": 6, "mode": "院校专业组平行志愿",
            "evidence": "湖北省教育厅招生办公室 2026 年本科普通批第二次征集志愿公告："
                        "『本科普通批可填报不超过 45 个院校专业组志愿』",
            "evidence_url": "https://jyt.hubei.gov.cn/bmdt/ztzl/gxzs/xxgk/ywgg/202607/t20260730_5986035.shtml",
        },
        "高职高专普通批": {
            "volunteers": 30, "majors_per_volunteer": 6, "mode": "院校专业组平行志愿",
            "evidence": "湖北省教育厅招生办公室 2026 年高职高专普通批第一次征集志愿公告："
                        "『高职高专普通批可填报不超过 30 个院校专业组志愿』",
            "evidence_url": "https://jyt.hubei.gov.cn/bmdt/ztzl/gxzs/xxgk/ywgg/202608/t20260822_5999258.shtml",
        },
    },
    "parallel_rule": "分数（位次）优先、遵循志愿、一轮投档",
    "note": "上述数量来自官方公告原文。每年批次设置与志愿数量可能调整，以湖北省教育考试院当年公布的文件为准。",
}

# 批次线：来源为湖北省教育厅通知 / 中国教育在线「历年各地高考分数线」汇总页
# https://www.eol.cn/e_html/gk/fsx/index.shtml （湖北）
BATCH_LINES = {
    "source": "湖北省教育厅《录取控制分数线》通知；中国教育在线历年分数线汇总页",
    "source_url": "https://www.eol.cn/e_html/gk/fsx/index.shtml",
    "unit": "分",
    "lines": {
        "2026": {"物理类": {"本科批": 435, "特殊类型": 529, "高职高专": 200},
                 "历史类": {"本科批": 443, "特殊类型": 532, "高职高专": 200}},
        "2025": {"物理类": {"本科批": 426, "特殊类型": 516, "高职高专": 200},
                 "历史类": {"本科批": 442, "特殊类型": 536, "高职高专": 200}},
        "2024": {"物理类": {"本科批": 437, "特殊类型": 525, "高职高专": 200},
                 "历史类": {"本科批": 432, "特殊类型": 530, "高职高专": 200}},
    },
}

warnings: list[str] = []
stats: list[dict] = []


def log(msg: str) -> None:
    print(msg, flush=True)


def warn(msg: str) -> None:
    warnings.append(msg)
    log("  [警告] " + msg)


def jdump_compact(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":"))


def write_js(path: str, payload: str) -> int:
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(payload)
    return os.path.getsize(path)


GROUP_RE = re.compile(r"^\s*(\d{1,3})\s*[、,，\s]?\s*(.*?)\s*$")


def parse_group(raw: str | None) -> tuple[str, str]:
    """把 '03 化学' 拆成 ('03', '化学')；解析不出来就原样保留。"""
    if not raw:
        return "", ""
    m = GROUP_RE.match(str(raw))
    if not m:
        return "", str(raw).strip()
    return m.group(1), m.group(2)


# ------------------------------------------------------------------ 投档线


def build_admissions() -> None:
    for year in YEARS:
        for cat_key, cat_cn in CATEGORIES.items():
            for lv_key, lv_cn in LEVELS.items():
                src = os.path.join(RAW_DIR, f"admissions_{year}_{cat_key}_{lv_key}.json")
                if not os.path.exists(src):
                    warn(f"缺少原始文件 {os.path.basename(src)}，跳过")
                    continue

                with open(src, encoding="utf-8") as f:
                    doc = json.load(f)

                records = doc.get("records") or []
                declared = doc.get("count")
                if declared is not None and declared != len(records):
                    warn(f"{year} {cat_cn}{lv_cn}：count 声明 {declared} 条，实际 {len(records)} 条")

                out_records = []
                null_score = 0
                scores = []
                for r in records:
                    score = r.get("min_score")
                    if score is None:
                        null_score += 1
                    else:
                        if not isinstance(score, (int, float)) or not (0 < score <= 750):
                            warn(f"{year} {cat_cn}{lv_cn}：异常投档分 {score!r}（{r.get('school_name')}）")
                        else:
                            scores.append(int(score))

                    code, require = parse_group(r.get("major_group"))
                    if not code and r.get("major_group"):
                        warn(f"{year} {cat_cn}{lv_cn}：专业组编号解析失败 {r.get('major_group')!r}")

                    out_records.append([
                        str(r.get("school_code") or "").strip(),
                        str(r.get("school_name") or "").strip(),
                        str(r.get("school_province") or "").strip(),
                        code,
                        require,
                        int(score) if isinstance(score, (int, float)) else None,
                        "/".join(r.get("tags") or []),
                        (r.get("note") or "").strip(),
                    ])

                out_records.sort(key=lambda x: (x[5] is None, -(x[5] or 0)))

                payload = {
                    "year": year,
                    "category": cat_cn,
                    "level": lv_cn,
                    "batch": doc.get("batch") or "",
                    "count": len(out_records),
                    # [院校代码, 院校名称, 院校所在省, 专业组号, 选科要求, 投档最低分, 院校标签, 备注]
                    "records": out_records,
                }

                out = os.path.join(DATA_DIR, f"admissions_{year}_{cat_key}_{lv_key}.js")
                size = write_js(out, "GK.addAdmissions(" + jdump_compact(payload) + ");\n")

                stats.append({
                    "类别": f"{year} {cat_cn}{lv_cn}",
                    "记录数": len(out_records),
                    "缺额(无投档分)": null_score,
                    "最高投档分": max(scores) if scores else None,
                    "最低投档分": min(scores) if scores else None,
                    "文件大小": size,
                })
                log(f"  [生成] admissions_{year}_{cat_key}_{lv_key}.js  {len(out_records)} 条  {size:,} 字节")


# ------------------------------------------------------------------ 一分一段


def build_segments() -> None:
    for cat_key, cat_cn in CATEGORIES.items():
        src = os.path.join(RAW_DIR, f"segments_2024_{cat_key}.json")
        if not os.path.exists(src):
            warn(f"缺少一分一段原始文件 segments_2024_{cat_key}.json")
            continue

        with open(src, encoding="utf-8") as f:
            doc = json.load(f)
        rows = doc.get("data") if isinstance(doc, dict) else doc
        if not rows:
            warn(f"2024 {cat_cn} 一分一段：没有数据行")
            continue

        data = []
        prev_accum = 0
        for r in rows:
            try:
                score = int(str(r.get("score", "")).strip())
                accumulate = int(r.get("accumulate"))
                num = int(r.get("num"))
            except (TypeError, ValueError):
                warn(f"2024 {cat_cn} 一分一段：跳过无法解析的行 {r!r}")
                continue
            if accumulate < prev_accum:
                warn(f"2024 {cat_cn} 一分一段：累计人数在 {score} 分处回退（{prev_accum} → {accumulate}）")
            prev_accum = accumulate
            data.append([score, num, accumulate])

        # 分数从高到低
        data.sort(key=lambda x: -x[0])

        payload = {
            "year": 2024,
            "category": cat_cn,
            "source": "湖北省教育考试院 2024 年普通高考一分一段统计表",
            "fields": ["分数", "本分人数", "累计人数"],
            "data": data,
        }
        out = os.path.join(DATA_DIR, f"segments_2024_{cat_key}.js")
        size = write_js(out, "GK.addSegments(" + jdump_compact(payload) + ");\n")
        stats.append({
            "类别": f"2024 {cat_cn}一分一段",
            "记录数": len(data),
            "缺额(无投档分)": 0,
            "最高投档分": data[0][0] if data else None,
            "最低投档分": data[-1][0] if data else None,
            "文件大小": size,
        })
        log(f"  [生成] segments_2024_{cat_key}.js  {len(data)} 行  累计人数上限 {prev_accum:,}")


# ------------------------------------------------------------------ 对账校验


def cross_check() -> None:
    """跨表校验：投档分是否落在合理区间、专业组是否重复。"""
    for year in YEARS:
        for cat_key, cat_cn in CATEGORIES.items():
            path = os.path.join(DATA_DIR, f"admissions_{year}_{cat_key}_benke.js")
            if not os.path.exists(path):
                continue
            raw = open(path, encoding="utf-8").read()
            payload = json.loads(raw[raw.index("(") + 1: raw.rindex(")")])
            records = payload["records"]
            line = BATCH_LINES["lines"].get(str(year), {}).get(cat_cn, {}).get("本科批")
            if line is None:
                continue
            below = [r for r in records if r[5] is not None and r[5] < line - 100]
            if below:
                warn(f"{year} {cat_cn}本科：有 {len(below)} 条投档分低于本科线 {line} 达 100 分以上（如 "
                     f"{below[0][1]} {below[0][5]} 分），请核对原始 PDF")
            dup = {}
            for r in records:
                # 同一国标码会被本部 / 深圳 / 威海校区、中外合作办学、国家专项等共用，
                # 因此用「代码 + 名称 + 专业组 + 备注」作为唯一键，避免误报。
                k = (r[0], r[1], r[3], r[7])
                dup[k] = dup.get(k, 0) + 1
            dup = {k: v for k, v in dup.items() if v > 1}
            if dup:
                sample = list(dup.items())[:3]
                warn(
                    f"{year} {cat_cn}本科：{len(dup)} 条记录出现完全重复的"
                    f"「院校代码+名称+专业组+备注」，例如 {sample}"
                )


# ------------------------------------------------------------------ 元信息


def build_meta() -> None:
    sources_path = os.path.join(RAW_DIR, "sources.json")
    manifest = {}
    if os.path.exists(sources_path):
        manifest = json.load(open(sources_path, encoding="utf-8"))

    has_segments_by_cat = {
        cat_cn: os.path.exists(os.path.join(DATA_DIR, f"segments_2024_{cat_key}.js"))
        for cat_key, cat_cn in CATEGORIES.items()
    }

    meta = {
        "app": "湖北（武汉）高考志愿工作台",
        "province": "湖北",
        "candidate": "2027 届（现高三）武汉考生",
        "build_at": datetime.now(CN_TZ).isoformat(timespec="seconds"),
        "years_available": list(YEARS),
        "data_years_used": {
            "投档线（院校专业组）": ["2024", "2025", "2026"],
            "批次线": ["2024", "2025", "2026"],
            "一分一段（位次换算）": ["2024"],
        },
        "segments_available": has_segments_by_cat,
        "policy": POLICY,
        "batch_lines": BATCH_LINES,
        "sources": manifest.get("files", []),
        "source_manifest_at": manifest.get("generated_at"),
        "gap_notes": [
            "一分一段表目前只有 2024 年可程序化获取：湖北官方 2025/2026 一分一段以图片形式发布，"
            "需要人工录入后才能启用对应年份的「位次法」。",
            "未包含组内具体专业清单：原始投档线只到「院校专业组」粒度，"
            "专业栏需要对照当年官方《招生计划》填写。",
            "院校代号以湖北省当年《招生计划》公布的院校专业组代号为准，"
            "本工具展示的是国标院校代码（5 位），仅用于识别。",
        ],
        "disclaimer": (
            "本工具为个人志愿填报辅助工具，所有数据来自公开渠道，仅供参考；"
            "录取存在大小年波动、招生计划调整、专业级差等不确定因素，"
            "最终请以湖北省教育考试院、省招办和高校官网公布的信息为准。"
        ),
    }

    out = os.path.join(DATA_DIR, "meta.js")
    size = write_js(out, "GK.setMeta(" + jdump_compact(meta) + ");\n")
    log(f"  [生成] meta.js  {size:,} 字节")


def build_index() -> None:
    """生成一个清单文件，告诉前端要加载哪些数据文件。"""
    files = []
    if os.path.exists(os.path.join(DATA_DIR, "meta.js")):
        files.append("meta.js")
    for year in YEARS:
        for cat_key in CATEGORIES:
            for lv_key in LEVELS:
                name = f"admissions_{year}_{cat_key}_{lv_key}.js"
                if os.path.exists(os.path.join(DATA_DIR, name)):
                    files.append(name)
    for cat_key in CATEGORIES:
        name = f"segments_2024_{cat_key}.js"
        if os.path.exists(os.path.join(DATA_DIR, name)):
            files.append(name)

    payload = "GK.setIndex(" + jdump_compact({"files": files}) + ");\n"
    write_js(os.path.join(DATA_DIR, "index.js"), payload)
    log(f"  [生成] index.js  共 {len(files)} 个数据文件待加载")


# ------------------------------------------------------------------ 报告


def write_report() -> None:
    lines = [
        "# 数据构建与对账报告",
        "",
        f"构建时间：{datetime.now(CN_TZ).isoformat(timespec='seconds')}",
        "",
        "## 一、各类数据规模",
        "",
        "| 类别 | 记录数 | 缺额(无投档分) | 最高投档分 | 最低投档分 | 文件大小(字节) |",
        "| --- | ---: | ---: | ---: | ---: | ---: |",
    ]
    for s in stats:
        lines.append(
            f"| {s['类别']} | {s['记录数']:,} | {s['缺额(无投档分)']} | "
            f"{s['最高投档分']} | {s['最低投档分']} | {s['文件大小']:,} |"
        )

    lines += ["", "## 二、对账校验结果", ""]
    if warnings:
        lines.append(f"共发现 **{len(warnings)}** 条需要注意的问题：")
        lines.append("")
        for w in warnings:
            lines.append(f"- {w}")
    else:
        lines.append("未发现异常：记录数与声明一致、投档分区间合理、院校+专业组无重复。")

    lines += [
        "",
        "## 三、已知数据缺口（重要）",
        "",
        "1. 一分一段表只有 2024 年：湖北官方 2025/2026 年一分一段以图片发布，需人工录入。",
        "2. 组内专业清单缺失：原始数据只到「院校专业组」粒度。",
        "3. 院校代号以当年官方《招生计划》为准，本工具展示国标代码。",
        "",
        "## 四、校验方法说明",
        "",
        "- 记录数：与源文件 `count` 字段逐一对账。",
        "- 投档分：检查是否落在 1~750 区间，并与批次线交叉验证（低于本科线 100 分以上会告警）。",
        "- 专业组：检查同一院校同一年度是否存在重复的「院校+专业组」组合。",
        "- 一分一段：检查累计人数是否单调不减（分数从高到低）。",
        "",
    ]
    path = os.path.join(ROOT, "docs", "数据构建与对账报告.md")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    log(f"\n对账报告：{path}")


def main() -> int:
    os.makedirs(DATA_DIR, exist_ok=True)
    os.makedirs(os.path.join(ROOT, "docs"), exist_ok=True)

    log("1/4 生成投档线数据 …")
    build_admissions()
    log("\n2/4 生成一分一段数据 …")
    build_segments()
    log("\n3/4 交叉对账 …")
    cross_check()
    log("\n4/4 生成元信息与清单 …")
    build_meta()
    build_index()
    write_report()

    if warnings:
        log(f"\n完成，但有 {len(warnings)} 条告警（已写入报告）。")
    else:
        log("\n完成，数据校验通过。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
