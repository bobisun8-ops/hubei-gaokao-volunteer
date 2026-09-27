/* 湖北高考志愿工作台 —— 主逻辑
 * 定位方法：
 *   1) 线差法：我的等效分 = 我的分数 − 我的划线 + 参考年批次线；与参考年投档最低分比较分差。
 *   2) 位次法：当参考年存在一分一段表时，把投档最低分换算成位次，与我的全省位次比较。
 * 不编造数据：所有结论都能追溯到 data/ 里的一条原始记录，缺数据就显示缺数据。
 */
(function () {
  "use strict";

  // ------------------------------------------------------------------ 常量

  var SECOND_SUBJECTS = ["化学", "生物", "思想政治", "地理"];

  // 武汉高校（按校名判断用；用于「只看武汉市内院校」筛选）
  var WUHAN_SCHOOLS = [
    "武汉大学", "华中科技大学", "武汉理工大学", "华中师范大学", "华中农业大学",
    "中南财经政法大学", "中国地质大学（武汉）", "中国地质大学(武汉)", "中南民族大学",
    "湖北大学", "湖北工业大学", "武汉科技大学", "江汉大学", "武汉工程大学",
    "武汉纺织大学", "武汉轻工大学", "湖北经济学院", "湖北中医药大学", "湖北警官学院",
    "武汉体育学院", "武汉音乐学院", "湖北美术学院", "武汉学院", "武汉商学院",
    "武汉城市学院", "武昌首义学院", "文华学院", "华夏理工学院", "武汉工程科技学院",
    "武汉华夏理工学院", "武汉晴川学院", "武汉传媒学院", "武汉设计工程学院",
    "湖北商贸学院", "湖北大学知行学院", "武汉文理学院", "武汉工商学院", "武昌理工学院",
    "汉口学院", "武汉东湖学院", "湖北第二师范学院", "湖北幼儿师范高等专科学校",
    "武汉职业技术学院", "武汉船舶职业技术学院", "武汉铁路职业技术学院",
    "武汉软件工程职业学院", "武汉城市职业学院", "武汉电力职业技术学院",
    "湖北交通职业技术学院", "湖北城市建设职业技术学院", "武汉交通职业学院",
    "武汉警官职业学院", "海军工程大学", "空军预警学院", "陆军工程大学军械士官学校",
  ];

  var STORE_KEY = "gk-hubei-plan-v1";

  // ------------------------------------------------------------------ 状态

  var state = {
    first: "物理类",
    seconds: [],
    level: "本科",
    score: null,
    myLine: null,
    rank: null,
    refYear: 2026,
    tags: [],
    provinces: [],
    onlyWuhan: false,
    excludeCoop: true,
    excludeSpecial: true,
    includeEmpty: false,
    cut: { chong: -10, wen: 0, bao: 12 },
    page: 1,
    pageSize: 100,
    sortBy: "grade",
    showRisk: false,
    matches: [],
    position: null,
    plan: [],
  };

  var trendIndex = {};   // key -> {2024, 2025, 2026}
  var loaded = { admissions: 0, segments: 0 };

  // ------------------------------------------------------------------ 工具

  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function fmt(v) { return (v === null || v === undefined) ? "—" : String(v); }

  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }

  function isWuhan(name) {
    if (name.indexOf("武汉") >= 0) return true;
    for (var i = 0; i < WUHAN_SCHOOLS.length; i++) {
      if (name === WUHAN_SCHOOLS[i]) return true;
    }
    return false;
  }

  function tagsOf(record) {
    var t = record[6] || "";
    return t ? t.split("/") : [];
  }

  function tagClass(t) {
    if (t === "985") return "tag top";
    if (t === "211" || t === "双一流") return "tag";
    if (t === "民办") return "tag private";
    return "tag plain";
  }

  function typeLabel(record) {
    var t = tagsOf(record);
    if (!t.length) return ["普通本科", "tag plain"];
    return [t.join(" · "), tagClass(t[t.length - 1])];
  }

  function recordNote(record) {
    return (record[7] || "").replace(/^\[|\]$/g, "").trim();
  }

  function isSpecialNote(note) {
    return /专项|民族班|预科|定向|西藏|新疆|南疆|内地班|免费|公费/.test(note || "");
  }

  function isCoopNote(record, note) {
    return /中外合作|合作办学|高收费/.test(note || "");
  }

  // ------------------------------------------------------------------ 数据访问

  function dataOf(year, category, level) {
    var list = GK.store.admissions;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.year === year && d.category === category && d.level === level) return d;
    }
    return null;
  }

  function segmentsOf(year, category) {
    var list = GK.store.segments;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.year === year && d.category === category) return d;
    }
    return null;
  }

  function batchLine(year, category, level) {
    var lines = (GK.store.meta && GK.store.meta.batch_lines && GK.store.meta.batch_lines.lines) || {};
    var y = lines[String(year)];
    if (!y || !y[category]) return null;
    var key = level === "本科" ? "本科批" : "高职高专";
    return y[category][key];
  }

  /** 该层次的志愿数量上限：本科普通批 45 个，高职高专普通批 30 个（依据官方公告，见 meta.policy） */
  function volunteerCap() {
    return state.level === "本科" ? 45 : 30;
  }

  function trendKey(r, year, category, level) {
    return [category, level, r[0], r[1], r[3], recordNote(r)].join("|") + "|" + year;
  }

  function baseKey(r, category, level) {
    return [category, level, r[0], r[1], r[3], recordNote(r)].join("|");
  }

  function buildTrendIndex() {
    trendIndex = {};
    GK.store.admissions.forEach(function (d) {
      d.records.forEach(function (r) {
        var k = baseKey(r, d.category, d.level);
        if (!trendIndex[k]) trendIndex[k] = {};
        trendIndex[k][d.year] = r[5];
      });
    });
  }

  /** 一分一段：分数 → 位次（累计人数）。表里没有该分数时做线性插值。 */
  function rankByScore(seg, score) {
    if (!seg || score === null) return null;
    var rows = seg.data;   // 已按分数降序排列
    if (!rows.length) return null;
    if (score >= rows[0][0]) return rows[0][2];
    if (score <= rows[rows.length - 1][0]) return rows[rows.length - 1][2];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][0] === score) return rows[i][2];
      if (rows[i][0] < score && rows[i - 1][0] > score) {
        var hi = rows[i - 1], lo = rows[i];
        var t = (hi[0] - score) / (hi[0] - lo[0]);
        return Math.round(hi[2] + (lo[2] - hi[2]) * t);
      }
    }
    return null;
  }

  /** 一分一段：位次 → 等位分 */
  function scoreByRank(seg, rank) {
    if (!seg || rank === null) return null;
    var rows = seg.data;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i][2] >= rank) return rows[i][0];
    }
    return rows.length ? rows[rows.length - 1][0] : null;
  }

  // ------------------------------------------------------------------ 定位

  function computePosition() {
    var refYear = state.refYear;
    var seg = segmentsOf(refYear, state.first);
    var line = batchLine(refYear, state.first, state.level);
    var pos = {
      refYear: refYear,
      method: "线差法",
      refLine: line,
      segAvailable: !!seg,
      rank: null,
      equivScore: null,
      score: state.score,
      myLine: state.myLine,
    };

    if (state.rank) {
      pos.rank = state.rank;
      if (seg) {
        pos.method = "位次法";
        pos.equivScore = scoreByRank(seg, state.rank);
      } else {
        pos.method = "位次（无法换算，参考年缺一分一段）";
      }
    }

    if (state.score !== null) {
      var usedLine = state.myLine !== null ? state.myLine : line;
      pos.usedLine = usedLine;
      pos.equivScore = state.score - (usedLine || 0) + (line || 0);
    }

    state.position = pos;
    return pos;
  }

  // ------------------------------------------------------------------ 选科过滤

  function requirePass(requireText, seconds) {
    var req = (requireText || "").trim();
    if (!req || req === "不限") return true;
    if (/或/.test(req)) {
      return req.split(/或/).some(function (s) { return seconds.indexOf(s.trim()) >= 0; });
    }
    if (/[+和]/.test(req)) {
      return req.split(/[+和]/).every(function (s) {
        var t = s.trim();
        return !t || seconds.indexOf(t) >= 0;
      });
    }
    return seconds.indexOf(req) >= 0;
  }

  // ------------------------------------------------------------------ 分档

  function classifyByScoreDiff(diff) {
    if (diff === null) return ["数据缺失", "risk"];
    if (diff < state.cut.chong) return ["风险", "risk"];
    if (diff < state.cut.wen) return ["冲", "chong"];
    if (diff < state.cut.bao) return ["稳", "wen"];
    if (diff < state.cut.bao + 30) return ["保", "bao"];
    return ["超保", "over"];
  }

  function classifyByRankRatio(ratio) {
    if (ratio === null) return ["数据缺失", "risk"];
    if (ratio > 1.15) return ["风险", "risk"];
    if (ratio > 1.0) return ["冲", "chong"];
    if (ratio >= 0.85) return ["稳", "wen"];
    if (ratio >= 0.6) return ["保", "bao"];
    return ["超保", "over"];
  }

  // ------------------------------------------------------------------ 匹配

  function runMatch() {
    state.seconds = getChecked("in-second");
    state.tags = getChecked("in-tags");
    state.first = $("in-first").value;
    state.level = $("in-level").value;
    state.score = num($("in-score").value);
    state.myLine = num($("in-line").value);
    state.rank = num($("in-rank").value);
    state.refYear = Number($("in-year").value);
    state.onlyWuhan = $("in-wuhan").checked;
    state.excludeCoop = $("in-exclude-coop").checked;
    state.excludeSpecial = $("in-exclude-special").checked;
    state.includeEmpty = $("in-include-empty").checked;
    state.cut.chong = Number($("in-chong").value);
    state.cut.wen = Number($("in-wen").value);
    state.cut.bao = Number($("in-bao").value);
    state.provinces = $("in-provinces").value.split(/[、,，\s]+/).filter(Boolean);

    if (state.seconds.length !== 2) {
      alert("请勾选 2 门再选科目。");
      return;
    }
    if (state.score === null && state.rank === null) {
      alert("请填写本次考试总分，或填写全省位次。");
      return;
    }
    if (state.rank === null && state.myLine === null) {
      var autoLine = batchLine(state.refYear, state.first, state.level);
      if (!autoLine) {
        alert("该年份没有批次线数据，请填写「本次考试划线」。");
        return;
      }
    }

    var pos = computePosition();
    var ds = dataOf(state.refYear, state.first, state.level);
    if (!ds) {
      alert("没有 " + state.refYear + " 年 " + state.first + state.level + " 的数据。");
      return;
    }
    var seg = segmentsOf(state.refYear, state.first);

    var out = [];
    ds.records.forEach(function (r) {
      if (!requirePass(r[4], state.seconds)) return;

      if (state.provinces.length && state.provinces.indexOf(r[2]) < 0) return;
      if (state.onlyWuhan && !isWuhan(r[1])) return;

      var note = recordNote(r);
      if (state.excludeCoop && isCoopNote(r, note)) return;
      if (state.excludeSpecial && isSpecialNote(note)) return;
      if (r[5] === null && !state.includeEmpty) return;

      var myTags = tagsOf(r);
      if (state.tags.length) {
        var want = state.tags.slice();
        var hit = want.some(function (w) {
          if (w === "普通本科") return myTags.length === 0;
          return myTags.indexOf(w) >= 0;
        });
        if (!hit) return;
      }

      var score = r[5];
      var diff = null, ratio = null, grade, cls;

      if (pos.method === "位次法" && seg && score !== null) {
        var recRank = rankByScore(seg, score);
        if (recRank && state.rank) {
          ratio = state.rank / recRank;
          var g = classifyByRankRatio(ratio);
          grade = g[0]; cls = g[1];
        }
      }
      if (!grade) {
        diff = (pos.equivScore !== null && score !== null) ? (pos.equivScore - score) : null;
        var g2 = classifyByScoreDiff(diff);
        grade = g2[0]; cls = g2[1];
      }

      if (grade === "风险" && !state.showRisk) return;

      var tk = baseKey(r, state.first, state.level);
      var trend = trendIndex[tk] || {};

      out.push({
        record: r,
        note: note,
        score: score,
        refLine: pos.refLine,
        diff: diff,
        ratio: ratio,
        grade: grade,
        cls: cls,
        rank: seg && score !== null ? rankByScore(seg, score) : null,
        trend: trend,
      });
    });

    sortMatches(out);

    state.matches = out;
    state.page = 1;
    renderStats();
    renderMatches();
  }

  var GRADE_ORDER = { "冲": 1, "稳": 2, "保": 3, "超保": 4, "风险": 5, "数据缺失": 6 };

  function gapOf(m) {
    // 用于「离我有多近」的排序：分差法用 |分差|，位次法用 |位次比−1|
    if (m.ratio !== null && m.ratio !== undefined) return Math.abs(m.ratio - 1);
    if (m.diff !== null && m.diff !== undefined) return Math.abs(m.diff) / 100;
    return 99;
  }

  function sortMatches(list) {
    var mode = state.sortBy;
    list.sort(function (a, b) {
      if (mode === "score") {
        var sa = a.score === null ? -1 : a.score;
        var sb = b.score === null ? -1 : b.score;
        if (sa !== sb) return sb - sa;
      } else if (mode === "gap") {
        var d = gapOf(a) - gapOf(b);
        if (d !== 0) return d;
      } else {
        var g = (GRADE_ORDER[a.grade] || 9) - (GRADE_ORDER[b.grade] || 9);
        if (g !== 0) return g;
        var e = gapOf(a) - gapOf(b);
        if (e !== 0) return e;
        var sc = (b.score || 0) - (a.score || 0);
        if (sc !== 0) return sc;
      }
      var na = a.record[1] || "", nb = b.record[1] || "";
      return na < nb ? -1 : (na > nb ? 1 : 0);
    });
  }

  function getChecked(containerId) {
    var box = $(containerId);
    if (!box) return [];
    return Array.prototype.slice.call(box.querySelectorAll("input:checked")).map(function (i) { return i.value; });
  }

  // ------------------------------------------------------------------ 渲染：概览

  function renderStats() {
    var pos = state.position;
    var counts = { 冲: 0, 稳: 0, 保: 0, 超保: 0, 风险: 0 };
    state.matches.forEach(function (m) { counts[m.grade] = (counts[m.grade] || 0) + 1; });
    if (!state.showRisk) counts["风险"] = null;

    var bar = $("statbar");
    bar.innerHTML = "";

    function card(k, v, cls) {
      var d = el("div", "stat" + (cls ? " " + cls : ""));
      d.appendChild(el("div", "k", k));
      d.appendChild(el("div", "v", v));
      bar.appendChild(d);
    }

    var methodText = pos ? pos.method : "—";
    var eq = pos && pos.equivScore !== null ? pos.equivScore + " 分" : "—";
    card("定位方法", methodText);
    card("等效分（换算到 " + state.refYear + " 年）", eq);
    card("我的位次", state.rank ? state.rank.toLocaleString() : "未填");
    card("匹配到", state.matches.length + " 个院校专业组");
    card("冲", counts["冲"], "chong");
    card("稳", counts["稳"], "wen");
    card("保", counts["保"], "bao");
    card("超保（过于保守）", counts["超保"]);

    var reasons = [];
    if (state.rank && !segmentsOf(state.refYear, state.first)) {
      reasons.push("参考年（" + state.refYear + "）缺一分一段表，已自动改用线差法");
    }
    if (state.myLine === null) {
      reasons.push("未填模拟划线，已用 " + state.refYear + " 年官方批次线换算");
    }
    $("match-summary").innerHTML = state.matches.length
      ? ("共 " + state.matches.length + " 条" + (reasons.length ? "（" + reasons.join("；") + "）" : ""))
      : "没有匹配结果，试试放宽筛选条件。";
  }

  // ------------------------------------------------------------------ 渲染：匹配表

  function renderMatches() {
    var tbody = $("tbody-match");
    tbody.innerHTML = "";
    var start = (state.page - 1) * state.pageSize;
    var pageRows = state.matches.slice(start, start + state.pageSize);

    $("th-trend-25").textContent = "2025";
    $("th-trend-24").textContent = "2024";

    pageRows.forEach(function (m) {
      var r = m.record;
      var tr = el("tr");

      var tdName = el("td", "sticky-l");
      var t = typeLabel(r)[0];
      tdName.innerHTML = '<b>' + escapeHtml(r[1]) + "</b>";
      if (r[3]) {
        var g = el("span", "muted", "　专业组 " + r[3]);
        tdName.appendChild(g);
      }
      tr.appendChild(tdName);

      tr.appendChild(el("td", null, r[2]));
      tr.appendChild(el("td", null, r[4] || "不限"));

      var tdScore = el("td", "num");
      tdScore.innerHTML = "<b>" + fmt(m.score) + "</b>";
      tr.appendChild(tdScore);

      var tdDiff = el("td", "num");
      if (m.ratio !== null && m.ratio !== undefined) {
        tdDiff.innerHTML = '<span class="' + (m.ratio > 1 ? "diff-neg" : "diff-pos") + '">' +
          "位次×" + m.ratio.toFixed(2) + "</span>";
      } else if (m.diff !== null) {
        tdDiff.innerHTML = '<span class="' + (m.diff < 0 ? "diff-neg" : (m.diff > 0 ? "diff-pos" : "diff-zero")) + '">' +
          (m.diff > 0 ? "+" : "") + m.diff + "</span>";
      } else {
        tdDiff.textContent = "—";
      }
      tr.appendChild(tdDiff);

      if (m.score !== null && m.refLine !== undefined && m.refLine !== null && m.score < m.refLine - 30) {
        tdScore.title = "低于 " + state.refYear + " 年批次线 " + m.refLine + " 分，通常是预科班 / 降分补录 / 缺额，请核对原始投档线";
        tdScore.innerHTML += ' <span class="tag private" title="低于批次线，需核对">低线</span>';
      }

      tr.appendChild(el("td", "num", fmt(m.trend[2025])));
      tr.appendChild(el("td", "num", fmt(m.trend[2024])));

      var tdGrade = el("td");
      tdGrade.appendChild(el("span", "pill " + m.cls, m.grade));
      tr.appendChild(tdGrade);

      tr.appendChild(el("td", null, m.note || "—"));

      var tdOp = el("td", "op");
      var btn = el("button", "btn small ghost", "加入志愿表");
      btn.addEventListener("click", function () { addToPlan(m); });
      tdOp.appendChild(btn);
      tr.appendChild(tdOp);

      tbody.appendChild(tr);
    });

    renderPager();
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderPager() {
    var pager = $("pager-match");
    pager.innerHTML = "";
    var total = Math.max(1, Math.ceil(state.matches.length / state.pageSize));
    if (total <= 1) return;
    function pageBtn(p, label) {
      var b = el("button", p === state.page ? "active" : "", label);
      b.addEventListener("click", function () { state.page = p; renderMatches(); });
      return b;
    }
    pager.appendChild(pageBtn(Math.max(1, state.page - 1), "上一页"));
    var from = Math.max(1, state.page - 3), to = Math.min(total, from + 6);
    for (var p = from; p <= to; p++) pager.appendChild(pageBtn(p, String(p)));
    pager.appendChild(pageBtn(Math.min(total, state.page + 1), "下一页"));
  }

  // ------------------------------------------------------------------ 志愿表

  function planKey(item) {
    var r = item.record;
    return [r[0], r[1], r[3], item.note].join("|");
  }

  function addToPlan(m) {
    var item = {
      record: m.record, note: m.note, score: m.score, grade: m.grade,
      cls: m.cls, diff: m.diff, trend: m.trend,
      collegeCode: "", groupCode: m.record[3] || "",
      majors: ["", "", "", "", "", ""],
      obey: "是",
    };
    if (state.plan.some(function (p) { return planKey(p) === planKey(item); })) {
      flash("这条已经在志愿表里了：" + item.record[1]);
      return;
    }
    var cap = volunteerCap();
    if (state.plan.length >= cap) {
      alert("湖北" + (state.level === "本科" ? "本科普通批" : "高职高专普通批") +
        "最多 " + cap + " 个院校专业组志愿，已满。");
      return;
    }
    state.plan.push(item);
    savePlan();
    renderPlan();
    flash("已加入志愿表（第 " + state.plan.length + " 个）：" + item.record[1]);
  }

  function renderPlan() {
    var tbody = $("tbody-plan");
    tbody.innerHTML = "";
    $("plan-count").textContent = String(state.plan.length);

    state.plan.forEach(function (item, idx) {
      var r = item.record;
      var tr = el("tr");

      tr.appendChild(el("td", "num", idx + 1));

      var tdCode = el("td");
      var codeInput = document.createElement("input");
      codeInput.placeholder = "填官方代号";
      codeInput.value = item.collegeCode;
      codeInput.addEventListener("input", function () { item.collegeCode = this.value; savePlan(); });
      tdCode.appendChild(codeInput);
      tr.appendChild(tdCode);

      var tdGroup = el("td");
      var gInput = document.createElement("input");
      gInput.value = item.groupCode;
      gInput.addEventListener("input", function () { item.groupCode = this.value; savePlan(); });
      tdGroup.appendChild(gInput);
      tr.appendChild(tdGroup);

      var tdName = el("td", "sticky-l2");
      tdName.innerHTML = "<b>" + escapeHtml(r[1]) + "</b>";
      tr.appendChild(tdName);

      tr.appendChild(el("td", null, r[4] || "不限"));

      var tdScore = el("td", "num");
      tdScore.textContent = fmt(item.score);
      tr.appendChild(tdScore);

      var tdGrade = el("td");
      tdGrade.appendChild(el("span", "pill " + item.cls, item.grade));
      tr.appendChild(tdGrade);

      item.majors.forEach(function (mj, i) {
        var td = el("td");
        var inp = document.createElement("input");
        inp.placeholder = "专业" + (i + 1);
        inp.value = mj;
        inp.addEventListener("input", function () { item.majors[i] = this.value; savePlan(); });
        td.appendChild(inp);
        tr.appendChild(td);
      });

      var tdObey = el("td");
      var sel = document.createElement("select");
      ["是", "否"].forEach(function (v) {
        var o = document.createElement("option");
        o.value = v; o.textContent = v;
        if (item.obey === v) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener("change", function () { item.obey = this.value; savePlan(); });
      tdObey.appendChild(sel);
      tr.appendChild(tdObey);

      var tdOp = el("td", "op");
      var up = el("button", "btn small ghost", "↑");
      up.addEventListener("click", function () { movePlan(idx, -1); });
      var dn = el("button", "btn small ghost", "↓");
      dn.addEventListener("click", function () { movePlan(idx, 1); });
      var del = el("button", "btn small ghost", "删除");
      del.addEventListener("click", function () {
        state.plan.splice(idx, 1); savePlan(); renderPlan();
      });
      tdOp.appendChild(up); tdOp.appendChild(dn); tdOp.appendChild(del);
      tr.appendChild(tdOp);

      tbody.appendChild(tr);
    });

    var notice = $("plan-notice");
    var msgs = [];
    if (state.plan.length === 0) {
      notice.className = "notice";
    } else {
      var cap = volunteerCap();
      if (state.plan.length < cap) msgs.push("还可以再加 " + (cap - state.plan.length) + " 个院校专业组志愿。");
      var risky = state.plan.filter(function (p) { return p.grade === "冲" || p.grade === "风险"; }).length;
      var safe = state.plan.filter(function (p) { return p.grade === "保" || p.grade === "超保"; }).length;
      if (risky === 0) msgs.push("没有冲的志愿，可能浪费分数；一般建议冲 8~15 个。");
      if (safe < 10) msgs.push("保底志愿偏少（建议 10 个以上），注意滑档风险。");
      var noObey = state.plan.filter(function (p) { return p.obey === "否"; }).length;
      if (noObey > 3) msgs.push("有 " + noObey + " 个专业不服从调剂，退档风险明显上升。");
      if (state.plan.length >= cap) msgs.push("已达 " + cap + " 个上限。");
      var tips = "专业组代号目前是参考年（" + state.refYear + " 年）的，2027 年招生计划下发后请逐个核对更新。";
      notice.className = "notice show " + (msgs.length ? "warn" : "ok");
      notice.innerHTML = (msgs.length ? ("<b>志愿表体检：</b>" + msgs.join(" ")) : "志愿表结构看起来合理。") +
        ' <span class="muted">' + tips + "</span>";
    }

    $("plan-summary").textContent = state.plan.length
      ? ("共 " + state.plan.length + " 个院校专业组志愿")
      : "还没有加入志愿";
  }

  function movePlan(idx, delta) {
    var to = idx + delta;
    if (to < 0 || to >= state.plan.length) return;
    var tmp = state.plan[idx];
    state.plan[idx] = state.plan[to];
    state.plan[to] = tmp;
    savePlan(); renderPlan();
  }

  function savePlan() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state.plan)); } catch (e) { /* file:// 下可能不可用 */ }
  }

  function loadPlan() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) state.plan = JSON.parse(raw) || [];
    } catch (e) { state.plan = []; }
  }

  function flash(msg) {
    var n = $("plan-notice");
    n.className = "notice show ok";
    n.textContent = msg;
    setTimeout(function () { renderPlan(); }, 1800);
  }

  // ------------------------------------------------------------------ 导出

  function download(filename, content, mime) {
    var blob = new Blob(["\ufeff" + content], { type: mime || "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  function csvCell(v) {
    var s = (v === null || v === undefined) ? "" : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }

  function exportMatches() {
    if (!state.matches.length) { alert("还没有匹配结果。"); return; }
    var head = ["院校代号(国标)", "院校名称", "所在省", "专业组号", "选科要求",
      state.refYear + "投档分", "我的分差", "2025投档分", "2024投档分", "档位", "备注"];
    var lines = [head.map(csvCell).join(",")];
    state.matches.forEach(function (m) {
      lines.push([
        m.record[0], m.record[1], m.record[2], m.record[3], m.record[4],
        m.score, m.diff, m.trend[2025], m.trend[2024], m.grade, m.note,
      ].map(csvCell).join(","));
    });
    download("湖北高考匹配结果_" + state.refYear + "_" + state.first + state.level + ".csv", lines.join("\r\n"));
  }

  function exportPlan() {
    if (!state.plan.length) { alert("志愿表还是空的。"); return; }
    var head = ["志愿号", "院校代号", "专业组代号", "院校名称", "选科要求",
      "参考投档分", "档位", "专业1", "专业2", "专业3", "专业4", "专业5", "专业6", "服从调剂", "备注"];
    var lines = [head.map(csvCell).join(",")];
    state.plan.forEach(function (p, i) {
      lines.push([
        i + 1, p.collegeCode, p.groupCode, p.record[1], p.record[4],
        p.score, p.grade,
        p.majors[0], p.majors[1], p.majors[2], p.majors[3], p.majors[4], p.majors[5],
        p.obey, p.note,
      ].map(csvCell).join(","));
    });
    lines.push("");
    lines.push([csvCell("说明"), csvCell(
      "院校代号与专业组代号请以湖北省当年《招生计划》为准；本表为预案，参考数据截至 " +
      (GK.store.meta ? GK.store.meta.years_available.join("/") : "") + " 年投档线。"
    )].join(","));
    download("湖北高考志愿表_预案_" + new Date().toISOString().slice(0, 10) + ".csv", lines.join("\r\n"));
  }

  // ------------------------------------------------------------------ 模拟投档

  function runSimulation() {
    var out = $("sim-out");
    out.innerHTML = "";
    if (!state.plan.length) {
      out.appendChild(el("p", "muted", "请先在「匹配结果」里把志愿加入志愿表，再运行模拟。"));
      return;
    }
    var pos = state.position || computePosition();
    var p = el("p", "hit");
    if (pos.method === "位次法" && state.rank) {
      p.innerHTML = "按位次法模拟：我的位次 <b>" + state.rank.toLocaleString() + "</b>";
    } else {
      p.innerHTML = "按线差法模拟：我的等效分 <b>" + fmt(pos.equivScore) + "</b> 分（" +
        state.refYear + " 年口径）";
    }
    out.appendChild(p);

    var ol = el("ol");
    var hitIdx = -1;
    for (var i = 0; i < state.plan.length; i++) {
      var item = state.plan[i];
      var li = el("li");
      var ok;
      if (pos.method === "位次法" && state.rank && item.record[5] !== null) {
        var seg = segmentsOf(state.refYear, state.first);
        var recRank = rankByScore(seg, item.record[5]);
        ok = recRank !== null && state.rank <= recRank;
        li.textContent = (i + 1) + ". " + item.record[1] + "（" + fmt(item.score) + " 分 / 位次 " +
          fmt(recRank) + "）→ " + (ok ? "够线" : "不够线");
      } else {
        ok = pos.equivScore !== null && item.score !== null && pos.equivScore >= item.score;
        li.textContent = (i + 1) + ". " + item.record[1] + "（" + fmt(item.score) + " 分）→ " +
          (ok ? "够线" : "不够线");
      }
      if (ok && hitIdx < 0) {
        hitIdx = i;
        li.style.color = "#167a3c";
        li.style.fontWeight = "700";
      }
      ol.appendChild(li);
    }
    out.appendChild(ol);

    var res = el("p", "hit");
    if (hitIdx < 0) {
      res.innerHTML = "<b>模拟结果：</b>你的所有志愿都不够线，<b>会滑档</b>。必须补充保底志愿。";
      res.style.color = "#e0453a";
    } else {
      res.innerHTML = "<b>模拟结果：</b>投档到第 <b>" + (hitIdx + 1) + "</b> 个志愿 —— " +
        escapeHtml(state.plan[hitIdx].record[1]) + "。第 " + (hitIdx + 2) + " 个及以后的志愿不再检索。";
    }
    out.appendChild(res);

    var tip = el("p", "muted");
    tip.textContent = "提醒：这是按往年投档线做的一轮投档推演，不包含专业级差、体检限制、单科成绩要求等条件，" +
      "也不预测今年分数线的变化。投档成功后仍可能因为不服从调剂、专业受限而退档。";
    out.appendChild(tip);
  }

  // ------------------------------------------------------------------ 数据体检 / 弹窗

  function renderQuality() {
    var box = $("quality-out");
    box.className = "quality";
    box.innerHTML = "";
    var meta = GK.store.meta || {};

    var h = el("h3", null, "已加载数据集");
    box.appendChild(h);
    var table = el("table");
    table.innerHTML = "<thead><tr><th>年份</th><th>科类</th><th>层次</th><th>批次</th>" +
      "<th>记录数</th><th>最高分</th><th>最低分</th></tr></thead>";
    var tb = el("tbody");
    GK.store.admissions.slice().sort(function (a, b) {
      return a.year - b.year || a.category.localeCompare(b.category) || a.level.localeCompare(b.level);
    }).forEach(function (d) {
      var scores = d.records.map(function (r) { return r[5]; }).filter(function (v) { return v !== null; });
      var tr = el("tr");
      [d.year, d.category, d.level, d.batch || "—", d.count,
        scores.length ? Math.max.apply(null, scores) : "—",
        scores.length ? Math.min.apply(null, scores) : "—"].forEach(function (v) {
        tr.appendChild(el("td", null, v));
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);

    box.appendChild(el("h3", null, "一分一段表（位次换算用）"));
    var segTable = el("table");
    segTable.innerHTML = "<thead><tr><th>年份</th><th>科类</th><th>分数段行数</th><th>最高分</th><th>最低分</th><th>累计人数上限</th></tr></thead>";
    var segBody = el("tbody");
    GK.store.segments.forEach(function (s) {
      var tr = el("tr");
      [s.year, s.category, s.data.length, s.data[0][0], s.data[s.data.length - 1][0],
        s.data[s.data.length - 1][2].toLocaleString()].forEach(function (v) {
        tr.appendChild(el("td", null, v));
      });
      segBody.appendChild(tr);
    });
    segTable.appendChild(segBody);
    box.appendChild(segTable);

    var note = el("div", "warnbox");
    note.innerHTML = "<b>已知数据缺口（务必了解）：</b><ul>" +
      (meta.gap_notes || []).map(function (g) { return "<li>" + escapeHtml(g) + "</li>"; }).join("") +
      "</ul>";
    box.appendChild(note);

    box.appendChild(el("h3", null, "批次线与政策参数"));
    var bl = (meta.batch_lines && meta.batch_lines.lines) || {};
    var blTable = el("table");
    blTable.innerHTML = "<thead><tr><th>年份</th><th>科类</th><th>本科批</th><th>特殊类型</th><th>高职高专</th></tr></thead>";
    var blBody = el("tbody");
    Object.keys(bl).sort().reverse().forEach(function (y) {
      ["物理类", "历史类"].forEach(function (c) {
        if (!bl[y][c]) return;
        var tr = el("tr");
        [y, c, bl[y][c]["本科批"], bl[y][c]["特殊类型"], bl[y][c]["高职高专"]].forEach(function (v) {
          tr.appendChild(el("td", null, v));
        });
        blBody.appendChild(tr);
      });
    });
    blTable.appendChild(blBody);
    box.appendChild(blTable);
  }

  function showSources() {
    var meta = GK.store.meta || {};
    var html = "<p>" + escapeHtml(meta.disclaimer || "") + "</p>";
    html += "<h4>数据文件与校验值</h4><table><thead><tr><th>文件</th><th>说明</th><th>大小</th><th>SHA-256（前 12 位）</th></tr></thead><tbody>";
    (meta.sources || []).forEach(function (s) {
      html += "<tr><td>" + escapeHtml(s.file) + "</td><td>" + escapeHtml(s.desc) +
        "</td><td>" + (s.bytes || 0).toLocaleString() + "</td><td>" +
        escapeHtml((s.sha256 || "").slice(0, 12)) + "</td></tr>";
    });
    html += "</tbody></table>";
    html += "<h4>数据来源</h4><ul>";
    html += "<li>投档线（院校专业组）：湖北省招办公布的投档最低分 PDF，经开源项目 secnotes/gaokao（MIT）结构化整理。</li>";
    html += "<li>一分一段表（2024）：湖北省教育考试院公布，经 FlySky-z/gaokao-analysis 数字化。</li>";
    html += "<li>批次线：湖北省教育厅《录取控制分数线》通知，中国教育在线历年分数线汇总页核对。</li>";
    html += "</ul>";
    html += "<h4>抓取时间</h4><p>" + escapeHtml(meta.source_manifest_at || "—") + "</p>";
    openModal("数据来源与免责声明", html);
  }

  function showHelp() {
    openModal("使用说明", [
      "<h4>这个工具是干什么的</h4>",
      "<p>把湖北（武汉）考生的分数/位次，和近三年真实的院校专业组投档线对上，生成一份按「冲稳保」分档、可以直接照着填系统的志愿表预案。</p>",
      "<h4>怎么用（三步）</h4>",
      "<ol><li>左侧填考生情况：首选科目、再选 2 科、报考层次。</li>",
      "<li>填成绩定位：高三平时用模考分数 + 学校给的模拟划线；有全省位次就填上（更准）。</li>",
      "<li>点「开始匹配」，把合适的院校专业组「加入志愿表」，最后导出 CSV 或打印。</li></ol>",
      "<h4>两种定位方法的区别</h4>",
      "<ul><li><b>线差法</b>：分数 − 划线 = 线差，用线差跨年比较，不受当年试题难度影响。默认方法。</li>",
      "<li><b>位次法</b>：用全省位次直接比较，最准；但需要对应年份的一分一段表。</li>",
      "<li>目前只有 2024 年有一分一段表，所以选 2026 年做参考时只能用线差法。把 2025/2026 的一分一段表录进来（见 tools/import_segment.py）就能用位次法。</li></ul>",
      "<h4>为什么要留「院校代号」空栏</h4>",
      "<p>湖北志愿填报用的是当年《招生计划》里的院校专业组代号，每年都会变，现在无法预知。本工具只做预案，代号等到 2027 年 6 月计划下发后对照填写。</p>",
      "<h4>它不会做什么</h4>",
      "<ul><li>不预测今年的分数线，也不给出「录取概率」这种伪精确的数字。</li>",
      "<li>不编造数据：任何一条推荐都能在「数据体检」里追溯到来源文件。</li></ul>",
    ].join(""));
  }

  function openModal(title, html) {
    $("modal-title").textContent = title;
    $("modal-body").innerHTML = html;
    $("modal").classList.add("show");
  }

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach(function (t) {
      t.classList.toggle("active", t.dataset.tab === name);
    });
    document.querySelectorAll(".tabpane").forEach(function (p) {
      p.classList.toggle("active", p.id === "pane-" + name);
    });
    if (name === "quality") renderQuality();
  }

  // ------------------------------------------------------------------ 初始化

  function loadDataFiles(cb) {
    var files = (GK.store.index && GK.store.index.files) || [];
    var pending = files.length;
    if (!pending) { cb(); return; }
    files.forEach(function (name) {
      var s = document.createElement("script");
      s.src = "data/" + name;
      s.onload = function () { if (--pending === 0) cb(); };
      s.onerror = function () {
        console.error("数据文件加载失败：" + name);
        if (--pending === 0) cb();
      };
      document.head.appendChild(s);
    });
  }

  function bindUI() {
    $("btn-run").addEventListener("click", runMatch);
    $("btn-export-match").addEventListener("click", exportMatches);
    $("btn-export-plan").addEventListener("click", exportPlan);
    $("btn-print-plan").addEventListener("click", function () { window.print(); });
    $("btn-clear-plan").addEventListener("click", function () {
      if (state.plan.length && confirm("确定清空志愿表？")) {
        state.plan = []; savePlan(); renderPlan();
      }
    });
    $("btn-sort-plan").addEventListener("click", function () {
      var order = { "冲": 1, "稳": 2, "保": 3, "超保": 4, "风险": 5 };
      state.plan.sort(function (a, b) {
        var d = (order[a.grade] || 9) - (order[b.grade] || 9);
        if (d !== 0) return d;
        return (b.score || 0) - (a.score || 0);
      });
      savePlan(); renderPlan();
    });
    $("btn-run-sim").addEventListener("click", runSimulation);
    $("btn-sources").addEventListener("click", showSources);
    $("btn-help").addEventListener("click", showHelp);
    $("modal-close").addEventListener("click", function () { $("modal").classList.remove("show"); });
    $("modal").addEventListener("click", function (e) {
      if (e.target === $("modal")) $("modal").classList.remove("show");
    });
    $("in-pagesize").addEventListener("change", function () {
      state.pageSize = Number(this.value); state.page = 1; renderMatches();
    });
    $("in-sort").addEventListener("change", function () {
      state.sortBy = this.value;
      sortMatches(state.matches);
      state.page = 1;
      renderMatches();
    });
    [["in-chong", "v-chong"], ["in-wen", "v-wen"], ["in-bao", "v-bao"]].forEach(function (pair) {
      var input = $(pair[0]), out = $(pair[1]);
      input.addEventListener("input", function () {
        out.textContent = this.value;
        state.cut[pair[0] === "in-chong" ? "chong" : (pair[0] === "in-wen" ? "wen" : "bao")] = Number(this.value);
      });
    });
    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchTab(t.dataset.tab); });
    });
    $("in-first").addEventListener("change", function () {
      state.first = this.value;
      refreshYearHint();
      if (state.matches.length) runMatch();
    });
    $("in-level").addEventListener("change", refreshYearHint);
    $("in-year").addEventListener("change", refreshYearHint);
  }

  function refreshYearHint() {
    var y = Number($("in-year").value);
    var cat = $("in-first").value;
    var level = $("in-level").value;
    var seg = segmentsOf(y, cat);
    var line = batchLine(y, cat, level);
    var parts = [];
    parts.push(line ? (y + " 年" + cat + (level === "本科" ? "本科批" : "高职高专") + "线 " + line + " 分") : "缺批次线");
    parts.push(seg ? "有一分一段表（可用位次法）" : "缺一分一段表（用线差法）");
    $("year-hint").textContent = parts.join("；");
  }

  function fillYearOptions() {
    var sel = $("in-year");
    sel.innerHTML = "";
    var years = (GK.store.meta && GK.store.meta.years_available) || [2026, 2025, 2024];
    years.slice().sort(function (a, b) { return b - a; }).forEach(function (y) {
      var o = document.createElement("option");
      o.value = String(y);
      o.textContent = y + " 年" + (y === 2026 ? "（最新）" : "");
      sel.appendChild(o);
    });
    sel.value = String(years[years.length - 1]);
    state.refYear = Number(sel.value);
  }

  function init() {
    loadDataFiles(function () {
      loaded.admissions = GK.store.admissions.length;
      loaded.segments = GK.store.segments.length;
      buildTrendIndex();
      loadPlan();
      fillYearOptions();
      bindUI();
      refreshYearHint();

      // 默认勾选一个常见组合，避免空手开始
      var checks = document.querySelectorAll("#in-second input");
      Array.prototype.forEach.call(checks, function (c, i) { c.checked = i < 2; });

      var total = GK.store.admissions.reduce(function (a, d) { return a + d.count; }, 0);
      $("headline").textContent = "湖北 " + (GK.store.meta ? GK.store.meta.years_available.join("/") : "") +
        " 年院校专业组投档线 · 共 " + total.toLocaleString() + " 条记录 · 离线可用";
      $("foot-line").textContent = (GK.store.meta && GK.store.meta.disclaimer) || "";
      renderPlan();
      renderStats();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
