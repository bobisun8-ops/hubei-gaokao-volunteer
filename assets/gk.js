/* 湖北高考志愿工作台 —— 数据装载器
 * 说明：先把 data/*.js 注册到内存里，再启动 app.js。
 * 这样做的目的是：整个工具可以离线双击打开（file://），不需要任何服务器。
 */
(function () {
  "use strict";

  var store = {
    meta: null,
    index: { files: [] },
    admissions: [],   // {year, category, level, batch, count, records}
    segments: [],     // {year, category, data:[[score,num,accumulate]]}
  };

  window.GK = {
    addAdmissions: function (payload) { store.admissions.push(payload); },
    addSegments: function (payload) { store.segments.push(payload); },
    setMeta: function (meta) { store.meta = meta; },
    setIndex: function (idx) { store.index = idx; },
    store: store,
  };
})();
