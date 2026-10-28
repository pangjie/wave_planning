/* =============================================================
 * 波次规划工具界面
 * 业务逻辑（core.js）与桌面版完全一致；概览、矩阵与任务状态实时联动，
 * 高频交互优先就地更新，避免扰动页面结构。
 * ============================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var THEME_STORAGE_KEY = 'wave-planner-theme';
  var THEME_IDS = ['dracula', 'yellow', 'jade', 'reddust', 'seaclear'];
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 渠道终端文本色 */
  var CH_TEXT_COLOR = {
    'CBT': '#c4b5fd', 'CBS': '#86efac', 'SwiftX': '#93c5fd', 'SpeedX': '#fdba74',
    'YanWen': '#5eead4', 'Gofo': '#67e8f9', 'UPS': '#a5b4fc', 'USPS': '#6ee7b7',
    'USPS-H': '#fdba74', 'USPS-G': '#6ee7b7',
    'Fedex': '#fda4af', 'UniUni': '#7dd3fc', 'BFE': '#fde68a', '未识别': '#9ca3af', '普通': '#cbd5e1'
  };
  function chColor(id) { return CH_TEXT_COLOR[id] || '#c9d1d9'; }

  /* ---------- 状态 ---------- */
  function makeModeState() {
    return {
      unified: { hotLine: 10, capacity: 400, multiSegs: 1, mixSegs: 1, absorb: 1 },
      per: new Map(),
      order: { sortMode: 'fixed', custom: false, list: [] },
      sel: { channels: new Set(), segs: new Set(), seenChannels: new Set(), seenSegs: new Set() }
    };
  }
  var uspsSplitDefault = true;
  try { uspsSplitDefault = localStorage.getItem('wave-usps-split') !== 'off'; } catch (e) { }
  var state = {
    uspsSplit: uspsSplitDefault,
    waveNos: new Map(),  // 分段键(chId|segName) -> 波次号（生成波次后回填）
    records: [],
    qtyMap: {},
    merged: false,
    ordinaryEvolved: false,
    modes: { normal: makeModeState(), merged: makeModeState() },
    analysis: { normal: null, merged: null, ordinary: null }
  };

  function modeKey() { return state.merged ? 'merged' : 'normal'; }
  // 每次导入都有独立身份；计划改动产生新身份，不用名称猜测旧波次归属。
  function newPlanId() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + '-' + Math.random().toString(36).slice(2);
  }
  function planIdentity() {
    if (!state.batchId) state.batchId = newPlanId();
    var m = ms();
    var signature = JSON.stringify([state.batchId, state.merged, state.ordinaryEvolved, state.uspsSplit,
      m.unified, Array.from(m.per), m.order, Array.from(m.sel.channels).sort(), Array.from(m.sel.segs).sort()]);
    if (state.planSignature !== signature) {
      state.planSignature = signature;
      state.planId = newPlanId();
      state.waveNos = new Map();
      document.querySelectorAll('.seg-line.waved').forEach(function (el) { el.classList.remove('waved'); });
      if (wms) wmsInvalidateHistoryReads(false);
    }
    return { batch_id: state.batchId, plan_id: state.planId };
  }
  function planQuery(identity) {
    return '?batch_id=' + encodeURIComponent(identity.batch_id) + '&plan_id=' + encodeURIComponent(identity.plan_id);
  }
  function sameOrders(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    var orders = new Set(left);
    return orders.size === left.length && new Set(right).size === right.length && right.every(function (no) { return orders.has(no); });
  }
  function matchesCurrentSegment(identity, segment) {
    var current = planIdentity();
    if (!identity || identity.batch_id !== current.batch_id || identity.plan_id !== current.plan_id) return false;
    return wmsEffectiveSegments().some(function (s) {
      return s.channel === segment.channel && s.seg_name === segment.seg_name && sameOrders(s.order_nos, segment.order_nos);
    });
  }
  function jobSegmentMatches(job, outcome) {
    var segment = (job.segments || []).find(function (s) { return s.channel === outcome.channel && s.seg_name === outcome.seg_name; });
    return !!segment && matchesCurrentSegment(job, segment);
  }
  function ms() { return state.modes[modeKey()]; }
  function paramsResolver(key) {
    var m = state.modes[key];
    return function (id) { return m.per.get(id) || m.unified; };
  }
  function getAnalysis(key) {
    key = key === 'merged' ? 'merged' : 'normal';
    if (!state.analysis[key]) {
      state.analysis[key] = analyze(state.records, state.qtyMap, key, paramsResolver(key), state.uspsSplit);
    }
    if (key === 'normal' && state.ordinaryEvolved) {
      if (!state.analysis.ordinary) {
        var normalMode = state.modes.normal;
        // Source segments must receive their default selection before deciding
        // which orders are disabled and therefore absorbed by Ordinary.
        syncSelection(state.analysis.normal, normalMode);
        state.analysis.ordinary = buildOrdinaryEvolvedAnalysis(
          state.analysis.normal, state.records, state.qtyMap, paramsResolver('normal'),
          normalMode.sel.channels, normalMode.sel.segs
        );
      }
      return state.analysis.ordinary;
    }
    return state.analysis[key];
  }
  function curAnalysis() { return getAnalysis(modeKey()); }
  function invalidate(key) {
    state.analysis[key] = null;
    if (key === 'normal') state.analysis.ordinary = null;
  }
  function invalidateOrdinary() { state.analysis.ordinary = null; }

  /* ---------- 渠道顺序 ---------- */
  function orderedChannels(a, orderState) {
    var sortMode = orderState.sortMode === 'desc' ? 'desc' : 'fixed';
    if (!orderState.custom || !orderState.list.length) {
      return sortChannelsForDisplay(a.channels.slice(), a.mode, sortMode);
    }
    var byId = new Map(a.channels.map(function (c) { return [c.id, c]; }));
    var out = [], used = new Set();
    orderState.list.forEach(function (id) {
      var c = byId.get(id);
      if (c) { out.push(c); used.add(id); }
    });
    var news = a.channels.filter(function (c) { return !used.has(c.id); });
    sortChannelsForDisplay(news, a.mode, sortMode);
    out = out.concat(news);
    /* 手动排序也不能改变「未识别」绝对置底的规则。 */
    var unknown = out.filter(function (c) { return c.id === '未识别'; });
    return out.filter(function (c) { return c.id !== '未识别'; }).concat(unknown);
  }

  /* ---------- 参数读写 ---------- */
  function parseParam(p, v, unified) {
    if (p === 'absorb') {
      var a = Math.round(Number(v));
      if (!isFinite(a) || a < 1 || a > 4) return unified.absorb;
      return a;
    }
    var n = Math.floor(Number(v));
    if (!isFinite(n) || n < minOf(p)) return unified[p];
    return n;
  }
  function setUnified(p, v) {
    var key = modeKey();
    var m = ms();
    var val = parseParam(p, v, m.unified);
    wmsClearWaveHistory();  // 重新分段后旧波次号不再对应新分段
    m.unified[p] = val;
    getAnalysis(key).channels.forEach(function (ch) {
      var pp = m.per.get(ch.id);
      if (!pp) { pp = Object.assign({}, m.unified); m.per.set(ch.id, pp); }
      pp[p] = val;
    });
    invalidate(key);
    render();
  }
  function setChannelParam(chId, p, v) {
    var key = modeKey();
    var m = ms();
    var pp = m.per.get(chId);
    if (!pp) { pp = Object.assign({}, m.unified); m.per.set(chId, pp); }
    wmsClearWaveHistory();  // 重新分段后旧波次号不再对应新分段
    pp[p] = parseParam(p, v, m.unified);
    invalidate(key);
    render();
  }
  function stepOf(p) { return p === 'capacity' ? 100 : 1; }
  function minOf(p) { return stepOf(p); }
  function currentParam(chId, p) {
    var m = ms();
    return (chId ? (m.per.get(chId) || m.unified) : m.unified)[p];
  }
  function stepParam(chId, p, dir) {
    var next = currentParam(chId, p) + dir * stepOf(p);
    if (next < minOf(p)) next = minOf(p);
    if (chId) setChannelParam(chId, p, next);
    else setUnified(p, next);
  }
  function cycleAbsorb(chId) {
    var cur = currentParam(chId, 'absorb');
    var next = (cur % 4) + 1;
    if (chId) setChannelParam(chId, 'absorb', next);
    else setUnified('absorb', next);
  }

  /* ---------- 状态条（替代操作日志） ---------- */
  var statusTimer = null;
  function status(msg, kind) {
    var el = $('status');
    el.textContent = msg || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
    clearTimeout(statusTimer);
    if (msg) statusTimer = setTimeout(function () { el.textContent = ''; el.className = 'status'; }, 5000);
  }

  /* ---------- 纯视觉反馈（不参与订单、渠道与分段计算） ---------- */
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function metricMarkup(id, value, suffix) {
    return '<strong id="' + id + '" data-roll-value="' + value + '"><span class="metric-number">' + value +
      '</span><span class="metric-unit">' + suffix + '</span></strong>';
  }
  function collectMetricValues() {
    var values = {};
    Array.prototype.forEach.call(document.querySelectorAll('#dash [data-roll-value]'), function (el) {
      values[el.id] = Number(el.dataset.rollValue) || 0;
    });
    return values;
  }
  function animateMetric(el, target, fromValue) {
    if (!el) return;
    target = Math.max(0, Math.round(Number(target) || 0));
    var numberEl = el.querySelector('.metric-number');
    if (!numberEl) return;
    var current = fromValue == null ? Number(numberEl.textContent) : Number(fromValue);
    if (!isFinite(current)) current = target;
    current = Math.max(0, Math.round(current));
    el.dataset.rollValue = String(target);
    if (el._metricFrame) cancelAnimationFrame(el._metricFrame);
    if (reduceMotion || current === target) {
      numberEl.textContent = String(target);
      return;
    }
    var started = performance.now();
    var duration = 460;
    el.classList.remove('metric-rolling');
    void el.offsetWidth;
    el.classList.add('metric-rolling');
    function frame(now) {
      if (!el.isConnected) return;
      var p = Math.min(1, (now - started) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      numberEl.textContent = String(Math.round(current + (target - current) * eased));
      if (p < 1) el._metricFrame = requestAnimationFrame(frame);
      else {
        el._metricFrame = null;
        numberEl.textContent = String(target);
        setTimeout(function () { if (el.isConnected) el.classList.remove('metric-rolling'); }, 60);
      }
    }
    el._metricFrame = requestAnimationFrame(frame);
  }
  function animateRenderedMetrics(previous) {
    Array.prototype.forEach.call(document.querySelectorAll('#dash [data-roll-value]'), function (el) {
      var target = Number(el.dataset.rollValue) || 0;
      animateMetric(el, target, Object.prototype.hasOwnProperty.call(previous, el.id) ? previous[el.id] : 0);
    });
  }
  /* ---------- 导入 ---------- */
  function clearData() {
    wmsInvalidateHistoryReads();
    var keepN = state.modes.normal.unified;
    var keepM = state.modes.merged.unified;
    state.waveNos = new Map();
    state.batchId = newPlanId();
    state.planSignature = null;
    state.records = [];
    state.qtyMap = {};
    state.ordinaryEvolved = false;
    state.analysis = { normal: null, merged: null, ordinary: null };
    state.modes.normal = makeModeState();
    state.modes.merged = makeModeState();
    state.modes.normal.unified = keepN;
    state.modes.merged.unified = keepM;
  }
  function syncSelection(a, m) {
    m = m || ms();
    a.channels.forEach(function (ch) {
      if (!m.sel.seenChannels.has(ch.id)) {
        m.sel.seenChannels.add(ch.id);
        if (channelEnabledByDefault(ch)) m.sel.channels.add(ch.id);
      }
      ch.segments.forEach(function (s) {
        var k = ch.id + '|' + s.name;
        if (!m.sel.seenSegs.has(k)) { m.sel.seenSegs.add(k); m.sel.segs.add(k); }
      });
    });
  }
  function handleFile(file, onDone) {
    var reader = new FileReader();
    reader.onerror = function () { status('文件读取失败，请重试', 'err'); if(onDone) onDone(false); };
    reader.onload = function () {
      var loaded = false;
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        var loc = locateSheet(wb);
        var hm = mapHeaders(loc.rows[0]);
        var br = buildRecords(loc.rows.slice(1), hm);
        if (!br.records.length) throw new Error('「出库单」工作表中没有有效订单数据');
        clearData();
        state.records = br.records;
        applyUspsSubdivision(state.records, state.uspsSplit);
        state.qtyMap = br.qtyMap;
        var a = getAnalysis(modeKey());
        syncSelection(a);
        /* 导入新订单文件即视为新一批：清理既往波次生成历史（本地状态 + 后端记录） */
        wmsClearWaveHistory();
        /* 导入成功仅记入日志（左上角不再显示文件名栏） */
        wmsLogLine('已导入 ' + file.name + '（' + br.records.length + ' 单）。', 'imported');
        loaded = true;
      } catch (e) {
        clearData();
        status('导入失败：' + (e && e.message ? e.message : '文件解析失败'), 'err');
      }
      render();
      if(onDone) onDone(loaded);
    };
    reader.readAsArrayBuffer(file);
  }

  /* =============================================================
   * 合并表：参数（左） + 渠道分段总览（右），按渠道对齐
   * ============================================================= */
  /* 渠道标签：开启=渠道配色，否掉=灰色（一致变色） */
  var OFF_TAG_COLOR = '#8b949e';
  function tagColor(id) {
    return ms().sel.channels.has(id) ? chColor(id) : OFF_TAG_COLOR;
  }
  function togHtml(state, dataAttr, title) {
    var glyph = state === 'on' ? '[x]' : (state === 'some' ? '[~]' : '[ ]');
    var checked = state === 'some' ? 'mixed' : (state === 'on' ? 'true' : 'false');
    return '<span class="tog ' + state + '" ' + dataAttr + ' role="checkbox" tabindex="0" aria-checked="' + checked +
      '" title="' + esc(title) + '">' + glyph + '</span>';
  }
  /* 页面显示名（仅影响显示，不影响逻辑与导出） */
  var UI_ABSORB_NAMES = { 1: '关闭', 2: '吸收', 3: '多件', 4: '全量' };
  var UI_TYPE_LABEL = { hot: '爆品', paper: '单件', multi: '多件', mix: '混件' };
  function uiSegName(name) { return String(name).replace('单件paper', '单件').replace(/-?\d+$/, ''); }

  /* ---------- 有效导出状态（渠道优先） ---------- */
  function segEffectiveOn(chId, segName) {
    var m = ms();
    return m.sel.channels.has(chId) && m.sel.segs.has(chId + '|' + segName);
  }
  function chMasterState() {
    var a = curAnalysis(), m = ms();
    var ids = a.channels.map(function (c) { return c.id; });
    if (!ids.length) return 'off';
    var on = ids.filter(function (id) { return m.sel.channels.has(id); }).length;
    return on === ids.length ? 'on' : (on > 0 ? 'some' : 'off');
  }
  function typeMasterState(t) {
    var a = curAnalysis(), m = ms();
    var total = 0, on = 0;
    a.channels.forEach(function (ch) {
      var chOn = m.sel.channels.has(ch.id);
      ch.byType[t].forEach(function (s) {
        total++;
        if (chOn && m.sel.segs.has(ch.id + '|' + s.name)) on++;
      });
    });
    if (!total) return 'off';
    return on === total ? 'on' : (on > 0 ? 'some' : 'off');
  }
  /* 仅统计有绿X（实际会导出）的分段 */
  function effectiveSegStats() {
    var m = ms();
    var a = curAnalysis();
    var st = { hot: { waves: 0, orders: 0 }, paper: { waves: 0, orders: 0 }, multi: { waves: 0, orders: 0 }, mix: { waves: 0, orders: 0 } };
    a.channels.forEach(function (ch) {
      var chOn = m.sel.channels.has(ch.id);
      TYPE_ORDER.forEach(function (t) {
        ch.byType[t].forEach(function (s) {
          if (chOn && m.sel.segs.has(ch.id + '|' + s.name)) { st[t].waves++; st[t].orders += s.orderCount; }
        });
      });
    });
    return st;
  }
  function paramCell(chId, p, val) {
    var atMin = val <= minOf(p);
    var shown = p === 'capacity' ? (val / 100) + 'H' : val;
    return '<span class="stepper">' +
      '<span class="arr arr-l' + (atMin ? ' limit' : '') + '" data-ch="' + esc(chId || '') + '" data-p="' + p +
      '" data-dir="-1" role="button" tabindex="0" title="减少 ' + stepOf(p) + '">◀</span>' +
      '<span class="pval">' + shown + '</span>' +
      '<span class="arr arr-r" data-ch="' + esc(chId || '') + '" data-p="' + p +
      '" data-dir="1" role="button" tabindex="0" title="增加 ' + stepOf(p) + '">▶</span></span>';
  }
  function absorbCell(chId, val) {
    return '<span class="aval" data-ch="' + esc(chId || '') + '" role="button" tabindex="0" title="单击切换档位（关闭 → 吸收 → 多件 → 全量）">' +
      UI_ABSORB_NAMES[val] + '</span>';
  }
  function segLineHtml(ch, s) {
    var key = ch.id + '|' + s.name;
    var effOn = segEffectiveOn(ch.id, s.name);
    var label = uiSegName(s.name) + '·' + s.orderCount + '·' + s.skuCount;
    return '<div class="seg-line ' + (effOn ? 'on' : 'off') + (state.waveNos.has(key) && effOn ? ' waved' : '') + '" data-seg="' + esc(key) +
      '" role="checkbox" tabindex="0" aria-checked="' + (effOn ? 'true' : 'false') + '" title="' + esc(s.name) +
      '（点击切换导出勾选）"><span class="seg-name">' + esc(label) + '</span></div>';
  }
  function typeHeadHtml(t) {
    var state = typeMasterState(t);
    return togHtml(state, 'data-master="t:' + t + '"', '点击全选/取消「' + UI_TYPE_LABEL[t] + '」类型全部分段') +
      '<span class="type-tog" data-master="t:' + t + '">' + UI_TYPE_LABEL[t] + '</span>';
  }
  function effectiveOrderSum() {
    var m = ms();
    return selectedOrderCount(curAnalysis(), m.sel.channels, m.sel.segs);
  }
  function effectiveChannelOrderSum(ch) {
    var m = ms();
    return selectedOrderCountForChannel(ch, m.sel.channels, m.sel.segs);
  }
  function segTdHtml(ch, t) {
    var html = '';
    ch.byType[t].forEach(function (s) { html += segLineHtml(ch, s); });
    return html || '<span class="cell-dim">—</span>';
  }

  function dashHtml() {
    var a = curAnalysis();
    var m = ms();
    var chans = orderedChannels(a, m.order);
    var u = m.unified;
    var st = effectiveSegStats();

    var activeChans = residentChannels(Object.assign({}, a, { channels: chans }));
    var selectedChans = activeChans.filter(function (ch) { return m.sel.channels.has(ch.id); }).length;
    var selectedWaves = TYPE_ORDER.reduce(function (n, t) { return n + st[t].waves; }, 0);
    var selectedOrders = effectiveOrderSum();
    var selectedSkus = selectedSkuCount(a, state.records, m.sel.channels, m.sel.segs);
    var rows = '';
    /* 统一行 */
    rows += '<tr class="urowe">' +
      '<td><span class="dim">统一调整</span></td>' +
      '<td class="num" data-order-total>' + selectedOrders + '</td>' +
      '<td>' + paramCell('', 'capacity', u.capacity) + '</td>' +
      '<td>' + paramCell('', 'hotLine', u.hotLine) + '</td>' +
      '<td>' + paramCell('', 'multiSegs', u.multiSegs) + '</td>' +
      '<td>' + paramCell('', 'mixSegs', u.mixSegs) + '</td>' +
      '<td>' + absorbCell('', u.absorb) + '</td>';
    TYPE_ORDER.forEach(function (t) {
      rows += '<td class="segtd"><span class="cell-dim type-count" data-t="' + t + '">' +
        '<span class="wc">' + st[t].waves + '波</span>/<span class="oc">' + st[t].orders + '单</span></span></td>';
    });
    rows += '</tr>';

    chans.forEach(function (ch) {
      var p = m.per.get(ch.id) || m.unified;
      var holdHint = !state.merged && ((!state.ordinaryEvolved && ch.id === '未识别') || (state.ordinaryEvolved && ch.id === '普通'))
        ? (state.ordinaryEvolved ? ' · 按住3秒退化为未识别' : ' · 按住3秒进化为普通') : '';
      if (!state.merged && /^USPS(?:-[HG])?$/.test(ch.id)) holdHint = ' · 按住3秒' + (state.uspsSplit ? '关闭' : '开启') + 'USPS细分';
      rows += '<tr class="prow' + (m.sel.channels.has(ch.id) ? '' : ' off') + '" data-ch="' + esc(ch.id) + '">' +
        '<td class="left"><div class="ch-cell">' +
        '<span class="chn" role="button" aria-pressed="' + (m.sel.channels.has(ch.id) ? 'true' : 'false') +
        '" tabindex="0" draggable="true" data-ch="' + esc(ch.id) + '" style="--chc:' + tagColor(ch.id) +
        '" title="点击切换渠道勾选 · 拖动排序 · 聚焦后 Alt+↑↓' + holdHint + '">' + esc(ch.id) + '</span></div></td>' +
        '<td class="num" data-channel-orders>' + effectiveChannelOrderSum(ch) + '</td>' +
        '<td>' + paramCell(ch.id, 'capacity', p.capacity) + '</td>' +
        '<td>' + paramCell(ch.id, 'hotLine', p.hotLine) + '</td>' +
        '<td>' + paramCell(ch.id, 'multiSegs', p.multiSegs) + '</td>' +
        '<td>' + paramCell(ch.id, 'mixSegs', p.mixSegs) + '</td>' +
        '<td>' + absorbCell(ch.id, p.absorb) + '</td>';
      TYPE_ORDER.forEach(function (t) {
        rows += '<td class="segtd">' + segTdHtml(ch, t) + '</td>';
      });
      rows += '</tr>';
    });

    var head = '<tr>' +
      '<th class="left">' + togHtml(chMasterState(), 'data-master="ch"', '点击全选/取消全部渠道') +
      '<span class="type-tog" data-master="ch">渠道</span></th>' +
      '<th>激活订单</th>' +
      '<th>容量</th>' +
      '<th>爆品</th>' +
      '<th>多件</th>' +
      '<th>混件</th>' +
      '<th>吸收</th>' +
      TYPE_ORDER.map(function (t) { return '<th class="type-head">' + typeHeadHtml(t) + '</th>'; }).join('') +
      '</tr>';

    return '<section class="dash-summary"><div class="summary-title"><strong>规划概览</strong><span>' +
      (state.merged ? '渠道归并' : '渠道拆分') + '</span></div>' +
      '<div class="metric-grid">' +
        '<div class="metric"><small>导入订单</small>' + metricMarkup('totalOrderMetric', state.records.length, '单') + '</div>' +
        '<div class="metric"><small>激活订单</small>' + metricMarkup('selectedOrderMetric', selectedOrders, '单') + '</div>' +
        '<div class="metric"><small>激活波次</small>' + metricMarkup('selectedWaveMetric', selectedWaves, '波') + '</div>' +
        '<div class="metric"><small>活跃SKU</small>' + metricMarkup('selectedSkuMetric', selectedSkus, '个') + '</div>' +
        '<div class="metric"><small>活跃渠道</small>' + metricMarkup('selectedChannelMetric', selectedChans, '/' + activeChans.length) + '</div>' +
      '</div></section>' +
      '<section class="matrix-panel"><div class="twrap"><table class="pt">' +
      '<colgroup><col style="width:10%"><col style="width:6%"><col style="width:6%">' +
      '<col style="width:6%"><col style="width:6%"><col style="width:6%"><col style="width:6%">' +
      '<col style="width:13.5%"><col style="width:13.5%"><col style="width:13.5%"><col style="width:13.5%"></colgroup>' +
      '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div></section>';
  }

  /* ---------- 渲染（保持滚动位置，结构稳定；空数据也显示表格骨架） ---------- */
  function renderDash() {
    var previousMetrics = collectMetricValues();
    $('dash').innerHTML = dashHtml();
    animateRenderedMetrics(previousMetrics);
  }
  function renderBar() {
    var ok = typeof XLSX !== 'undefined';
    $('engineLabel').textContent = ok ? '' : 'FAIL';
    $('engineLabel').className = ok ? 'ok' : 'fail';
    $('engineLabelWrap').style.display = ok ? 'none' : '';
    $('modeLabel').textContent = state.merged ? '归并' : '拆分';
    $('modeLabel').className = state.merged ? 'mode-toggle on' : 'mode-toggle';
    $('modeLabel').setAttribute('aria-pressed', state.merged ? 'true' : 'false');
    var sortMode = ms().order.sortMode === 'desc' ? 'desc' : 'fixed';
    $('sortModeLabel').textContent = sortMode === 'desc' ? '降序' : '固定';
    $('sortModeLabel').className = 'mode-toggle sort-toggle' + (sortMode === 'desc' ? ' on' : '');
    $('sortModeLabel').setAttribute('aria-pressed', sortMode === 'desc' ? 'true' : 'false');
    $('sortModeLabel').title = '点击切换渠道排序（固定 / 降序）；手动拖动后再次点击可恢复规则排序';
    $('btnExport').disabled = !state.records.length;
  }
  function render() {
    var out = $('out');
    var oldTable = out.querySelector('.twrap');
    var tableTop = oldTable ? oldTable.scrollTop : 0;
    var tableLeft = oldTable ? oldTable.scrollLeft : 0;
    /* 调整参数产生的新分段/新渠道默认选中 */
    if (state.records.length) syncSelection(curAnalysis());
    planIdentity();
    renderDash();
    renderBar();
    var newTable = out.querySelector('.twrap');
    if (newTable) {
      newTable.scrollTop = tableTop;
      newTable.scrollLeft = tableLeft;
    }
  }

  /* ---------- 导出 ---------- */
  function currentExportState() {
    var m = ms();
    return { channelSelected: m.sel.channels, segSelected: m.sel.segs, waveNos: state.waveNos };
  }
  function currentExportData() {
    planIdentity();
    var m = ms();
    var a = curAnalysis();
    /* 渠道顺序与网页显示一致（手动拖动后的顺序） */
    return buildExport(Object.assign({}, a, { channels: orderedChannels(a, m.order) }),
      currentExportState());
  }
  function doExport() {
    if (!state.records.length) { status('尚未导入订单文件', 'err'); return; }
    var data = currentExportData();
    if (!data) {
      status('没有可导出的分段：请先勾选渠道与分段', 'err');
      return;
    }
    try {
      downloadWorkbook(data);
      status('已导出 ' + data.filename, 'ok');
    } catch (err) {
      status('导出失败：' + (err && err.message ? err.message : err), 'err');
    }
  }

  /* =============================================================
   * 交互（就地更新优先，不重渲染）
   * ============================================================= */
  function updateMarksInPlace() {
    planIdentity();
    var oc = document.querySelector('#dash [data-order-total]');
    if (oc) oc.textContent = effectiveOrderSum();
    Array.prototype.forEach.call(document.querySelectorAll('#dash .prow[data-ch]'), function (row) {
      var ch = channelById(row.dataset.ch);
      var count = row.querySelector('[data-channel-orders]');
      if (ch && count) count.textContent = effectiveChannelOrderSum(ch);
    });
    var chEl = document.querySelector('#dash .tog[data-master="ch"]');
    if (chEl) setGlyphState(chEl, chMasterState());
    var st = effectiveSegStats();
    TYPE_ORDER.forEach(function (t) {
      var el = document.querySelector('#dash .tog[data-master="t:' + t + '"]');
      if (el) setGlyphState(el, typeMasterState(t));
      var c = document.querySelector('#dash .type-count[data-t="' + t + '"]');
      if (c) c.innerHTML = '<span class="wc">' + st[t].waves + '波</span>/<span class="oc">' + st[t].orders + '单</span>';
    });
    var selectedOrderMetric = $('selectedOrderMetric');
    if (selectedOrderMetric) animateMetric(selectedOrderMetric, effectiveOrderSum());
    var selectedWaveMetric = $('selectedWaveMetric');
    if (selectedWaveMetric) {
      var waves = TYPE_ORDER.reduce(function (n, t) { return n + st[t].waves; }, 0);
      animateMetric(selectedWaveMetric, waves);
    }
    var selectedSkuMetric = $('selectedSkuMetric');
    if (selectedSkuMetric) {
      var m = ms();
      animateMetric(selectedSkuMetric, selectedSkuCount(curAnalysis(), state.records, m.sel.channels, m.sel.segs));
    }
    var selectedChannelMetric = $('selectedChannelMetric');
    if (selectedChannelMetric) {
      var active = residentChannels(curAnalysis());
      var selected = active.filter(function (ch) { return ms().sel.channels.has(ch.id); }).length;
      var unit = selectedChannelMetric.querySelector('.metric-unit');
      if (unit) unit.textContent = '/' + active.length;
      animateMetric(selectedChannelMetric, selected);
    }
  }
  function setGlyphState(el, state) {
    el.textContent = state === 'on' ? '[x]' : (state === 'some' ? '[~]' : '[ ]');
    el.classList.toggle('on', state === 'on');
    el.classList.toggle('some', state === 'some');
    el.classList.toggle('off', state === 'off');
    el.setAttribute('aria-checked', state === 'some' ? 'mixed' : (state === 'on' ? 'true' : 'false'));
  }
  function segElOf(key) {
    return document.querySelector('#dash .seg-line[data-seg="' + CSS.escape(key) + '"]');
  }
  function segParts(key) {
    var i = key.indexOf('|');
    return { chId: key.slice(0, i), segName: key.slice(i + 1) };
  }
  function refreshSegLine(key) {
    planIdentity();
    var el = segElOf(key);
    var p = segParts(key);
    var effOn = segEffectiveOn(p.chId, p.segName);
    if (el) {
      el.classList.toggle('on', effOn);
      el.classList.toggle('off', !effOn);
      el.classList.toggle('waved', state.waveNos.has(key) && effOn);
      el.setAttribute('aria-checked', effOn ? 'true' : 'false');
    }
  }
  function rerenderOrdinaryAfterSelection() {
    if (state.merged || !state.ordinaryEvolved) return false;
    invalidateOrdinary();
    wmsClearWaveHistory();
    render();
    return true;
  }
  /* 与类型全选框同模式：纯切换，无渠道联动；若某渠道全部分段被否掉，该渠道自动否掉 */
  function toggleSeg(key) {
    var m = ms();
    if (m.sel.segs.has(key)) m.sel.segs.delete(key);
    else m.sel.segs.add(key);
    refreshSegLine(key);
    autoDisableChannel(segParts(key).chId);
    if (rerenderOrdinaryAfterSelection()) return;
    updateMarksInPlace();
  }
  /* 渠道开关：点击开启 → 点亮渠道并选中其全部分段；点击关闭 → 只关渠道（分段状态保留） */
  function toggleChannel(id) {
    var m = ms();
    if (m.sel.channels.has(id)) {
      m.sel.channels.delete(id);
    } else {
      m.sel.channels.add(id);
      var ch = curAnalysis().channels.filter(function (c) { return c.id === id; })[0];
      if (ch) {
        ch.segments.forEach(function (s) { m.sel.segs.add(id + '|' + s.name); });
      }
    }
    refreshChnRow(id);
    var ch2 = channelById(id);
    if (ch2) {
      ch2.segments.forEach(function (s) { refreshSegLine(id + '|' + s.name); });
    }
    if (rerenderOrdinaryAfterSelection()) return;
    updateMarksInPlace();
  }
  /* 渠道全部分段被否掉时，渠道自动转为否掉 */
  function channelById(id) {
    return curAnalysis().channels.filter(function (c) { return c.id === id; })[0];
  }
  function refreshChnRow(id) {
    var row = document.querySelector('#dash .prow[data-ch="' + CSS.escape(id) + '"]');
    if (row) row.classList.toggle('off', !ms().sel.channels.has(id));
    var el = document.querySelector('#dash .chn[data-ch="' + CSS.escape(id) + '"]');
    if (el) {
      el.style.setProperty('--chc', tagColor(id));
      el.setAttribute('aria-pressed', ms().sel.channels.has(id) ? 'true' : 'false');
    }
  }
  function autoDisableChannel(chId) {
    var m = ms();
    var ch = channelById(chId);
    if (!ch || !ch.segments.length) return;
    var anyOn = ch.segments.some(function (s) { return m.sel.segs.has(chId + '|' + s.name); });
    if (anyOn || !m.sel.channels.has(chId)) return;
    m.sel.channels.delete(chId);
    refreshChnRow(chId);
  }
  function toggleAllChannels() {
    var m = ms();
    var ids = curAnalysis().channels.map(function (c) { return c.id; });
    if (!ids.length) return;
    var all = ids.every(function (id) { return m.sel.channels.has(id); });
    ids.forEach(function (id) {
      if (all) m.sel.channels.delete(id);
      else m.sel.channels.add(id);
    });
    /* 渠道标签与全部分段标记、文字颜色就地刷新 */
    Array.prototype.forEach.call(document.querySelectorAll('#dash .chn[data-ch]'), function (el) {
      refreshChnRow(el.dataset.ch);
    });
    Array.prototype.forEach.call(document.querySelectorAll('#dash .seg-line[data-seg]'), function (el) {
      refreshSegLine(el.dataset.seg);
    });
    if (rerenderOrdinaryAfterSelection()) return;
    updateMarksInPlace();
  }
  function toggleAllType(t) {
    var m = ms();
    var keys = [];
    curAnalysis().channels.forEach(function (ch) {
      ch.byType[t].forEach(function (s) { keys.push(ch.id + '|' + s.name); });
    });
    if (!keys.length) return;
    var all = keys.every(function (k) { return m.sel.segs.has(k); });
    keys.forEach(function (k) {
      if (all) m.sel.segs.delete(k);
      else m.sel.segs.add(k);
    });
    keys.forEach(refreshSegLine);
    /* 受影响渠道：全部分段被否掉时自动否掉渠道 */
    var chIds = new Set();
    keys.forEach(function (k) { chIds.add(k.slice(0, k.indexOf('|'))); });
    chIds.forEach(autoDisableChannel);
    if (rerenderOrdinaryAfterSelection()) return;
    updateMarksInPlace();
  }
  function toggleMerge() {
    wmsInvalidateHistoryReads(false);
    state.merged = !state.merged;
    if (state.merged) {
      /* 归并后仅默认选中有订单的渠道；零订单渠道保持关闭。 */
      var m = state.modes.merged;
      var a = getAnalysis('merged');
      m.sel.channels = new Set(a.channels.filter(channelEnabledByDefault).map(function (c) { return c.id; }));
      m.sel.seenChannels = new Set(m.sel.channels);
      m.sel.segs = new Set();
      a.channels.forEach(function (ch) {
        ch.segments.forEach(function (s) {
          m.sel.segs.add(ch.id + '|' + s.name);
        });
      });
      m.sel.seenSegs = new Set(m.sel.segs);
    }
    render();
  }
  function clearOrdinarySegSelection(m) {
    Array.from(m.sel.segs).forEach(function (key) {
      if (key.indexOf('普通|') === 0) m.sel.segs.delete(key);
    });
    Array.from(m.sel.seenSegs).forEach(function (key) {
      if (key.indexOf('普通|') === 0) m.sel.seenSegs.delete(key);
    });
  }
  function toggleOrdinaryEvolution() {
    if (state.merged) return;
    var m = state.modes.normal;
    var current = getAnalysis('normal');
    var ids = orderedChannels(current, m.order).map(function (ch) { return ch.id; });
    var evolving = !state.ordinaryEvolved;
    clearOrdinarySegSelection(m);
    if (evolving) {
      state.ordinaryEvolved = true;
      ids = ids.map(function (id) { return id === '未识别' ? '普通' : id; });
      if (ids.indexOf('普通') < 0) ids.push('普通');
      m.sel.channels.delete('未识别');
      m.sel.channels.add('普通');
      m.sel.seenChannels.delete('未识别');
      m.sel.seenChannels.add('普通');
    } else {
      state.ordinaryEvolved = false;
      ids = ids.filter(function (id) { return id !== '普通' && id !== '未识别'; });
      ids.push('未识别');
      m.sel.channels.delete('普通');
      m.sel.channels.delete('未识别');
      m.sel.seenChannels.delete('普通');
      m.sel.seenChannels.add('未识别');
    }
    m.order.custom = true;
    m.order.list = ids;
    invalidateOrdinary();
    wmsClearWaveHistory();
    chnPress = { el: null, x: 0, y: 0, moved: false };
    render();
  }
  function toggleUspsSubdivision() {
    if (state.merged || (wms && (wms.active || wms.submitting))) return;
    var m = state.modes.normal;
    if (!state.uspsSplit) {
      ['USPS-H', 'USPS-G'].forEach(function (id) {
        if (!m.per.has(id)) m.per.set(id, Object.assign({}, m.per.get('USPS') || m.unified));
      });
    }
    state.uspsSplit = !state.uspsSplit;
    try { localStorage.setItem('wave-usps-split', state.uspsSplit ? 'on' : 'off'); } catch (e) { }
    ['USPS', 'USPS-H', 'USPS-G'].forEach(function (id) {
      m.sel.channels.delete(id); m.sel.seenChannels.delete(id);
      [m.sel.segs, m.sel.seenSegs].forEach(function (set) {
        Array.from(set).forEach(function (key) { if (key.indexOf(id + '|') === 0) set.delete(key); });
      });
    });
    var order = [];
    m.order.list.forEach(function (id) {
      var ids = /^USPS(?:-[HG])?$/.test(id) ? (state.uspsSplit ? ['USPS-H', 'USPS-G'] : ['USPS']) : [id];
      ids.forEach(function (v) { if (order.indexOf(v) < 0) order.push(v); });
    });
    m.order.list = order;
    applyUspsSubdivision(state.records, state.uspsSplit);
    invalidate('normal'); invalidate('merged');
    clearOrdinarySegSelection(m);
    wmsClearWaveHistory();
    chnPress = { el: null, x: 0, y: 0, moved: false };
    render();
  }
  function toggleSortMode() {
    var order = ms().order;
    order.sortMode = order.sortMode === 'desc' ? 'fixed' : 'desc';
    order.custom = false;
    order.list = [];
    render();
  }
  function applyManualOrder(ids) {
    var m = ms();
    m.order.custom = true;
    m.order.list = ids.slice();
    render();
  }

  /* ---------- 拖动排序 ---------- */
  var dragState = { row: null };
  var chnPress = { el: null, x: 0, y: 0, moved: false };
  var evolutionHold = { timer: null, el: null, pointerId: null, x: 0, y: 0 };
  var suppressChannelClickUntil = 0;
  function isEvolutionTarget(el) {
    if (!el || state.merged || (wms && (wms.active || wms.submitting))) return false;
    if (/^USPS(?:-[HG])?$/.test(el.dataset.ch)) return true;
    return (!state.ordinaryEvolved && el.dataset.ch === '未识别') ||
      (state.ordinaryEvolved && el.dataset.ch === '普通');
  }
  function cancelEvolutionHold() {
    if (evolutionHold.timer) clearTimeout(evolutionHold.timer);
    if (evolutionHold.el) evolutionHold.el.classList.remove('evolution-hold');
    evolutionHold = { timer: null, el: null, pointerId: null, x: 0, y: 0 };
  }
  function beginEvolutionHold(el, e) {
    cancelEvolutionHold();
    if (!isEvolutionTarget(el)) return;
    evolutionHold.el = el;
    evolutionHold.pointerId = e.pointerId;
    evolutionHold.x = e.clientX;
    evolutionHold.y = e.clientY;
    el.classList.add('evolution-hold');
    evolutionHold.timer = setTimeout(function () {
      if (!evolutionHold.el || !isEvolutionTarget(evolutionHold.el)) return;
      suppressChannelClickUntil = Date.now() + 900;
      var usps = /^USPS(?:-[HG])?$/.test(evolutionHold.el.dataset.ch);
      cancelEvolutionHold();
      if (usps) toggleUspsSubdivision();
      else toggleOrdinaryEvolution();
    }, 3000);
  }
  function clearDropMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('#dash .prow'), function (r) {
      r.classList.remove('drop-before', 'drop-after');
    });
  }
  function endDrag() {
    cancelEvolutionHold();
    if (dragState.row) dragState.row.classList.remove('dragging');
    clearDropMarks();
    dragState.row = null;
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) {
        handleFile(this.files[0]);
      }
      this.value = '';
    });
    $('btnExport').addEventListener('click', doExport);

    /* 渠道模式切换：拆分 / 归并 */
    $('modeLabel').addEventListener('click', toggleMerge);
    $('sortModeLabel').addEventListener('click', toggleSortMode);

    /* 页面配置：齿轮按钮 + 配置面板（主题，列表固定向下弹出；字体固定为 Sarasa Mono SC） */
    function validTheme(v) {
      return THEME_IDS.indexOf(v) >= 0 ? v : 'dracula';
    }
    function syncThemeControl(v) {
      var active = null;
      Array.prototype.forEach.call($('themeList').children, function (x) {
        var on = x.getAttribute('data-v') === v;
        x.classList.toggle('on', on);
        x.setAttribute('aria-checked', on ? 'true' : 'false');
        if (on) active = x;
      });
      if (active) $('themeBtn').title = '当前主题：' + active.textContent;
    }
    function applyTheme(v, persist) {
      /* 主题只改外观（body 属性 → CSS 变量），不触碰任何页面状态与运行中的任务 */
      v = validTheme(v);
      document.body.setAttribute('data-theme', v);
      syncThemeControl(v);
      var themeMeta = document.querySelector('meta[name="theme-color"]');
      if (themeMeta) themeMeta.setAttribute('content', getComputedStyle(document.body).backgroundColor);
      if (persist) {
        try { localStorage.setItem(THEME_STORAGE_KEY, v); } catch (e) { }
      }
    }
    function closeCfgLists() {
      $('themeList').hidden = true;
      $('themeBtn').setAttribute('aria-expanded', 'false');
    }
    function bindCfgList(btnId, listId, apply) {
      $(btnId).addEventListener('click', function (e) {
        e.stopPropagation();
        ['themeList'].forEach(function (id) {
          if (id !== listId) $(id).hidden = true;
        });
        $(listId).hidden = !$(listId).hidden;
        $(btnId).setAttribute('aria-expanded', $(listId).hidden ? 'false' : 'true');
      });
      $(listId).addEventListener('click', function (e) {
        var li = e.target.closest ? e.target.closest('li[data-v]') : null;
        if (!li) return;
        e.stopPropagation();
        apply(li.getAttribute('data-v'), true);
        $(listId).hidden = true;
        $(btnId).setAttribute('aria-expanded', 'false');
      });
      $(listId).addEventListener('keydown', function (e) {
        var li = e.target.closest ? e.target.closest('li[data-v]') : null;
        if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); li.click(); }
      });
    }
    bindCfgList('themeBtn', 'themeList', applyTheme);
    applyTheme(document.body.getAttribute('data-theme'), false);
    document.addEventListener('click', function (e) {
      if (!(e.target.closest && e.target.closest('.cfg-wrap'))) closeCfgLists();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') closeCfgLists();
    });

    /* WMS 联动 */
    $('wmsExport').addEventListener('click', function () { wmsSelectMode('export'); });
    $('wmsGenerate').addEventListener('click', function () { wmsSelectMode('generate_waves'); });
    $('wmsPrint').addEventListener('click', function () { wmsSelectMode('print_waves'); });
    $('wmsPick').addEventListener('click', function () { wmsSelectMode('pick_waves'); });
    $('wmsRun').addEventListener('click', function () {
      if (wms.active) wmsCancel();
      else if (wmsRetryTarget()) wmsRetry();
      else wmsSubmit(wms.mode);
    });
    $('wmsNewTask').addEventListener('click', function () {
      var job = wmsRetryTarget();
      if (!job || !window.confirm('新建任务不会续跑原任务。请先调整输入，避免重复生成已有波次。确定放弃当前重试入口？')) return;
      wms.retryDismissed.add(job.id);
      wmsUpdateRunButton();
    });
    $('browserModeVal').addEventListener('click', wmsToggleBrowserMode);
    ['modeLabel', 'sortModeLabel', 'browserModeVal'].forEach(function (id) {
      $(id).addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.click(); }
      });
    });
    /* 初始显示与标记一致（无头），无需在 wms 对象定义前渲染 */
    fetch('/api/health', { signal: AbortSignal.timeout(1500) })
      .then(function (r) { return r.ok; })
      .then(wmsSetAvailable)
      .catch(function () { wmsSetAvailable(false); });

    /* 拆分模式特殊渠道：按住 3 秒且不移动，在「未识别 / 普通」之间切换。 */
    $('out').addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      var chn = e.target.closest ? e.target.closest('.chn[data-ch]') : null;
      if (chn) beginEvolutionHold(chn, e);
    });
    document.addEventListener('pointermove', function (e) {
      if (!evolutionHold.el || e.pointerId !== evolutionHold.pointerId) return;
      var dx = e.clientX - evolutionHold.x, dy = e.clientY - evolutionHold.y;
      if (dx * dx + dy * dy > 25) cancelEvolutionHold();
    });
    document.addEventListener('pointerup', cancelEvolutionHold);
    document.addEventListener('pointercancel', cancelEvolutionHold);

    /* 点击交互（委托） */
    $('out').addEventListener('click', function (e) {
      var t = e.target;
      var segEl = t.closest ? t.closest('.seg-line[data-seg]') : null;
      if (segEl) { toggleSeg(segEl.dataset.seg); return; }
      var chnEl = t.closest ? t.closest('.chn[data-ch]') : null;
      if (chnEl) {
        if (Date.now() < suppressChannelClickUntil) {
          chnPress = { el: null, x: 0, y: 0, moved: false };
          return;
        }
        /* 点击切换：按下→松开且位移小于阈值才切换；拖动（有位移）不切换；
           无按下记录（键盘/程序触发）也视为点击 */
        var real = chnPress.el === chnEl;
        if ((real && !chnPress.moved) || !real) toggleChannel(chnEl.dataset.ch);
        chnPress = { el: null, x: 0, y: 0, moved: false };
        return;
      }
      var master = t.closest ? t.closest('[data-master]') : null;
      if (master) {
        var mk = master.dataset.master;
        if (mk === 'ch') toggleAllChannels();
        else if (mk.indexOf('t:') === 0) toggleAllType(mk.slice(2));
        return;
      }
      var arr = t.closest ? t.closest('.arr[data-p]') : null;
      if (arr) {
        if (arr.classList.contains('limit')) return;
        stepParam(arr.dataset.ch || '', arr.dataset.p, Number(arr.dataset.dir));
        return;
      }
      var aval = t.closest ? t.closest('.aval[data-ch]') : null;
      if (aval) { cycleAbsorb(aval.dataset.ch || ''); return; }
    });

    /* Alt+↑↓ 移动渠道（聚焦渠道名） */
    $('out').addEventListener('keydown', function (e) {
      if (!e.altKey && (e.key === 'Enter' || e.key === ' ')) {
        var interactive = e.target.closest ? e.target.closest('.seg-line[data-seg],.chn[data-ch],[data-master],.arr[data-p],.aval[data-ch]') : null;
        if (interactive) { e.preventDefault(); interactive.click(); return; }
      }
      if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
      var chn = e.target.closest ? e.target.closest('.chn') : null;
      if (!chn) return;
      e.preventDefault();
      var rows = orderedChannels(curAnalysis(), ms().order).map(function (c) { return c.id; });
      var idx = rows.indexOf(chn.dataset.ch);
      var nidx = e.key === 'ArrowUp' ? idx - 1 : idx + 1;
      if (nidx < 0 || nidx >= rows.length) return;
      var tmp = rows[idx]; rows[idx] = rows[nidx]; rows[nidx] = tmp;
      applyManualOrder(rows);
    });

    /* 渠道名按下/移动：记录位移用于区分点击与拖动 */
    $('out').addEventListener('mousedown', function (e) {
      var chn = e.target.closest ? e.target.closest('.chn') : null;
      if (!chn) return;
      chnPress = { el: chn, x: e.clientX, y: e.clientY, moved: false };
    });
    document.addEventListener('mousemove', function (e) {
      if (!chnPress.el || chnPress.moved) return;
      var dx = e.clientX - chnPress.x, dy = e.clientY - chnPress.y;
      if (dx * dx + dy * dy > 25) chnPress.moved = true;
    });

    /* 拖动排序（渠道名） */
    $('out').addEventListener('dragstart', function (e) {
      var chn = e.target.closest ? e.target.closest('.chn') : null;
      if (!chn) { e.preventDefault(); return; }
      cancelEvolutionHold();
      dragState.row = chn;
      chn.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try { e.dataTransfer.setData('text/plain', chn.dataset.ch); } catch (err) { }
    });
    $('out').addEventListener('dragover', function (e) {
      if (!dragState.row) return;
      e.preventDefault();
      var row = e.target.closest ? e.target.closest('.prow') : null;
      clearDropMarks();
      if (!row || row.dataset.ch === dragState.row.dataset.ch) return;
      var rect = row.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) row.classList.add('drop-before');
      else row.classList.add('drop-after');
    });
    $('out').addEventListener('drop', function (e) {
      if (!dragState.row) return;
      e.preventDefault();
      var srcId = dragState.row.dataset.ch;
      var row = e.target.closest ? e.target.closest('.prow') : null;
      var ids = orderedChannels(curAnalysis(), ms().order).map(function (c) { return c.id; });
      clearDropMarks();
      if (row && row.dataset.ch && row.dataset.ch !== srcId) {
        var rect = row.getBoundingClientRect();
        var before = e.clientY < rect.top + rect.height / 2;
        var from = ids.indexOf(srcId);
        ids.splice(from, 1);
        ids.splice(ids.indexOf(row.dataset.ch) + (before ? 0 : 1), 0, srcId);
        applyManualOrder(ids);
      }
      endDrag();
    });
    $('out').addEventListener('dragend', endDrag);

  }

  /* ---------- 初始化 ---------- */
  (function init() {
    bindEvents();
    render();
    window.addEventListener('resize', function () {
      if (state.records.length) render();
    });
  })();

  /* =============================================================
   * WMS 联动：本地自动化服务（http://127.0.0.1:8000）
   * file:// 打开时服务不可达，本区域自动隐藏（纯规划模式不受影响）
   * ============================================================= */
  var WMS_STATE_LABEL = {
    queued: '排队中', running: '执行中', succeeded: '已完成',
    partial: '部分完成', failed: '失败', cancelled: '已取消'
  };
  var WMS_ACTIVE = ['queued', 'running'];
  var WMS_DONE = ['succeeded', 'partial', 'failed', 'cancelled'];
  var wms = { available: false, job: null, jobId: null, timer: null, events: 0, active: false, clearPending: false, errStreak: 0, recTimer: null, healthTimer: null, mode: null, linkedExports: new Set(), headless: true, jobLinks: new Set(), restoredIds: new Set(), pollEpoch: 0, pollRequest: null, submitting: false, cancelling: false, terminalJobs: new Set(), exportJobs: new Map(), historyEpoch: 0, historyRequest: null, clearQueue: Promise.resolve(), historyRetryLink: null };

  function wmsInvalidateHistoryReads(advance) {
    if (advance !== false) wms.historyEpoch += 1;
    if (wms.historyRequest) {
      clearTimeout(wms.historyRequest.timeout);
      wms.historyRequest.controller.abort();
    }
    wms.historyRequest = null;
  }
  wms.planSnapshots = new Map();
  wms.latestJobs = new Map();
  var detailJobs = new Map(), detailNotices = [], summaryCards = new Map();
  var logPanel = $('wmsPanel'), retryProgress = $('wmsRetryProgress');
  wms.retryDismissed = new Set();
  wms.followPrint = false;
  try {wms.followPrint = localStorage.getItem('wave-follow-print') === 'on';} catch(e) {}
  function wmsFollowToggleState() {
    var button=$('wmsFollowPrint');
    button.setAttribute('aria-pressed',String(wms.followPrint));
    button.title='跟随打印已'+(wms.followPrint?'开启':'关闭')+'：生成全部成功并保存规划文件后，自动打印本次单件和混件';
    button.disabled=wms.active || wms.submitting || cutoffBusy;
  }
  $('wmsFollowPrint').onclick=function(){
    if(wms.active || wms.submitting || cutoffBusy) return;
    wms.followPrint=!wms.followPrint;
    try{localStorage.setItem('wave-follow-print',wms.followPrint?'on':'off');}catch(e){}
    wmsFollowToggleState();
  };
  wmsFollowToggleState();
  function wmsRememberJob(job) {
    detailJobs.set(job.id,job);
    renderLogDetails();
    var previous = wms.latestJobs.get(job.mode);
    if (!previous || previous.id === job.id || (previous.created_at || '') <= (job.created_at || '')) wms.latestJobs.set(job.mode, job);
  }
  function wmsRetryTarget() {
    var job = wms.latestJobs.get(wms.mode);
    return job && job.checkpoint_version === 1 && !wms.retryDismissed.has(job.id) &&
      ['generate_waves', 'print_waves'].indexOf(job.mode) >= 0 &&
      ['failed', 'partial'].indexOf(job.status) >= 0 ? job : null;
  }
  async function wmsRetry() {
    var original = wmsRetryTarget();
    if (!original || wms.active || wms.submitting) return;
    wms.submitting = true;
    wmsUpdateRunButton();
    var epoch = wms.pollEpoch;
    try {
      var resp = await fetch('/api/jobs/' + original.id + '/retry', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({confirm_production: true}), signal: AbortSignal.timeout(10000)
      });
      if (epoch !== wms.pollEpoch) return;
      if (!resp.ok) {
        var error = await resp.json();
        status('无法续跑：' + (error.detail || resp.status), 'err');
        return;
      }
      var job = await resp.json();
      if (epoch !== wms.pollEpoch) return;
      wmsStartPolling(job);
    } catch (e) {
      status('重试请求结果未确认。再次点击仍查询同一重试轮次，不会新建重复任务。', 'err');
    } finally { wms.submitting = false; wmsUpdateRunButton(); }
  }

  function wmsClearWaveHistory(scope) {
    scope = scope || planIdentity();
    /* 先废弃读取，再串行清理；只有最新一代清理成功才能恢复同步。 */
    wmsInvalidateHistoryReads();
    var epoch = wms.historyEpoch;
    state.waveNos = new Map();
    wms.clearPending = true;
    if (wms.historyRetryLink) wms.historyRetryLink.remove();
    wms.historyRetryLink = null;
    wms.clearQueue = wms.clearQueue.then(async function () {
      // 快速连续改参时，尚未开始的旧清理可合并到最新一次。
      if (epoch !== wms.historyEpoch) return false;
      try {
        var resp = await fetch('/api/wave-records/clear' + planQuery(scope), { method: 'POST', signal: AbortSignal.timeout(10000) });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        if (epoch !== wms.historyEpoch) return false;
        wms.clearPending = false;
        return true;
      } catch (e) {
        if (epoch !== wms.historyEpoch) return false;
        wmsLogLine('历史清理未确认，已暂停波次回填和新建波次：' + e.message + '。请重试清理；不要据此重复执行已有任务。', 'warn');
        var line = document.createElement('div');
        line.className = 'ev link';
        var link = document.createElement('a');
        link.href = '#';
        link.textContent = '重试清理历史';
        link.onclick = function (event) {
          event.preventDefault();
          if (epoch === wms.historyEpoch) wmsClearWaveHistory(scope);
        };
        line.appendChild(link);
        $('wmsLog').appendChild(line);
        wms.historyRetryLink = link;
        return false;
      }
    });
    return wms.clearQueue;
  }
  function wmsRestoreHistoryRetry() {
    // 重建任务日志会移除旧链接；保留其清理代次检查，恢复同一个重试入口。
    if (wms.clearPending && wms.historyRetryLink) {
      $('wmsLog').appendChild(wms.historyRetryLink.parentNode);
    }
  }
  function wmsRenderModeSel() {
    var btns = document.querySelectorAll('.side-wms .wms-mode');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('sel', btns[i].getAttribute('data-mode') === wms.mode);
    }
  }
  function wmsUpdateRunButton() {
    wmsFollowToggleState();
    var run = $('wmsRun');
    var retry = wmsRetryTarget();
    run.disabled = wms.submitting || (!wms.active && cutoffBusy) || (wms.active ? false : !wms.mode);
    run.textContent = wms.active ? '取消任务' : retry ? '重试任务' : '开始任务';
    $('wmsNewTask').hidden = wms.active || !retry;
    $('wmsNewTask').disabled = wms.submitting;
    var tracked = wms.active ? wms.job : retry;
    var progress = retryProgress;
    progress.hidden = !tracked || tracked.checkpoint_version !== 1 || ['generate_waves','print_waves'].indexOf(tracked.mode) < 0;
    if (!progress.hidden) {
      var count = tracked.mode === 'generate_waves' ? Object.values(tracked.node_states || {}).filter(function (v) { return v === 'done'; }).length : Object.keys(tracked.print_files || {}).length;
      var total = tracked.mode === 'generate_waves' ? tracked.segments.length : tracked.wave_nos.length;
      progress.textContent = '第 ' + (tracked.attempt || 1) + ' 轮 · 已记录 ' + count + '/' + total;
    }
  }
  function wmsRenderBrowserMode() {
    var el = $('browserModeVal');
    el.textContent = wms.headless ? '无头' : '有头';
    el.classList.toggle('on', !wms.headless);
    el.setAttribute('aria-pressed', wms.headless ? 'false' : 'true');
  }
  function wmsToggleBrowserMode() {
    wms.headless = !wms.headless;
    wmsRenderBrowserMode();
  }
  function wmsSelectMode(mode) {
    if (wms.active || wms.submitting) return;
    wms.mode = (wms.mode === mode) ? null : mode;  // 再次点击同一功能取消选择
    wmsRenderModeSel();
    wmsUpdateRunButton();
  }
  function wmsParseWaves() {
    var out = [], seen = {};
    $('wmsWaves').value.split('\n').forEach(function (line) {
      var v = line.trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      if (!/^[A-Za-z0-9_-]+$/.test(v)) { out.push('__INVALID__:' + v); return; }
      out.push(v);
    });
    return out;
  }
  function wmsSetBusy(active) {
    wms.active = active;
    var btns = document.querySelectorAll('.side-wms .wms-mode');
    for (var i = 0; i < btns.length; i++) btns[i].disabled = active;
    $('wmsWaves').disabled = active;
    wmsUpdateRunButton();
  }
  function wmsRenderState() {
    if(logPanel.parentNode !== $('wmsLog')) $('wmsLog').appendChild(logPanel);
    var st = $('wmsState');
    st.textContent = wms.job ? (WMS_STATE_LABEL[wms.job.status] || wms.job.status) : '空闲';
    st.className = 'wms-state ' + (wms.job ? wms.job.status : '');
    wmsUpdateRunButton();
  }
  var WMS_MODE_LABEL = {
    export: '全量分析', generate_waves: '生成波次',
    print_waves: '打印波次', pick_waves: '批量拣货'
  };
  function wmsStageLabel(stage,status) {
    if(WMS_DONE.indexOf(status)>=0) return {succeeded:'任务完成',failed:'任务失败，请查看日志详情',partial:'部分完成，请查看日志详情',cancelled:'任务已取消'}[status];
    if(!stage || stage==='queued') return '等待执行';
    if(stage==='completed') return '任务完成';
    if(stage==='segment_wave') return '波次已生成';
    if(stage==='print_checkpoint') return '打印文件已保存';
    if(stage==='export_checkpoint') return '导出任务已记录';
    if(/launch|navigat|opened|waiting_data/.test(stage)) return '准备浏览器和页面';
    if(/merg/.test(stage)) return '合并打印文档';
    if(/download/.test(stage)) return '下载订单文件';
    if(/task_|waiting_export/.test(stage)) return '等待导出文件';
    if(/template|dialog|submitt/.test(stage)) return '校验并提交';
    if(/print|pdf/.test(stage)) return '打印波次';
    if(/segment|wave|search/.test(stage)) return '处理波次';
    if(/cancel/.test(stage)) return '正在取消';
    if(/warn|fail|error/.test(stage)) return '遇到提示，请查看日志详情';
    return '任务执行中';
  }
  function wmsSummary(job) {
    var card=summaryCards.get(job.id);
    if(!card || card.parentNode!==$('wmsLog')) {
      card=document.createElement('div');card.className='ev task-summary';
      $('wmsLog').appendChild(card);summaryCards.set(job.id,card);
    }
    var last=(job.events||[]).slice(-1)[0];
    var text=wmsStageLabel(last&&last.stage,job.status);
    if(job.mode==='generate_waves' || job.mode==='print_waves') {
      var total=job.mode==='generate_waves'?(job.segments||[]).length:(job.wave_nos||[]).length;
      var done=job.mode==='generate_waves'?((job.result&&job.result.segments)||[]).filter(function(s){return !!s.wave_no;}).length:Object.keys(job.print_files||{}).length;
      if(job.mode==='generate_waves') done=Math.max(done,Object.values(job.node_states||{}).filter(function(s){return s==='done';}).length);
      if(job.status==='succeeded') done=total;
      text+=' · '+done+'/'+total+' 个波次';
    }
    card.textContent=text;
  }
  function renderLogDetails() {
    if(!detailJobs || $('logDetailsPanel').hidden!==false) return;
    var list=$('logDetailsContent');
    var entries=Array.from(detailJobs.values()).filter(function(j){return !j.schedule_run_id;}).map(function(j){
      var events=(j.events||[]).slice();
      if(j.follow_print_error) events.push({stage:'跟随打印未启动',message:j.follow_print_error});
      return {id:j.id,title:(j.generation_job_id?'跟随打印':WMS_MODE_LABEL[j.mode]||j.mode)+' · '+(WMS_STATE_LABEL[j.status]||j.status),at:j.created_at,attempt:j.attempt,events:events};
    });
    if(cutoffData) (cutoffData.runs||[]).forEach(function(r){entries.push({id:r.id,title:'定时截单 · '+(cutoffLabels[r.status]||r.status),at:r.cutoff,events:(r.events||[]).concat(r.current_events||[])});});
    entries.sort(function(a,b){return String(b.at||'').localeCompare(String(a.at||''));});
    if(detailNotices.length) entries.unshift({id:'page-notices',title:'页面操作与提示',events:detailNotices});
    var signature=JSON.stringify(entries);
    if(list.dataset.signature===signature) return;
    list.dataset.signature=signature;
    var panel=$('logDetailsPanel'),scroll=panel.scrollTop;
    list.replaceChildren();
    entries.forEach(function(entry){
      var section=document.createElement('section');section.className='log-task';
      var title=document.createElement('h3');title.textContent=entry.title;section.appendChild(title);
      var meta=document.createElement('div');meta.className='log-task-meta';meta.textContent=(entry.at?entry.at.slice(0,19).replace('T',' ')+' · ':'')+(entry.attempt?'第 '+entry.attempt+' 轮 · ':'')+entry.events.length+' 条记录';section.appendChild(meta);
      entry.events.forEach(function(ev){
        var row=document.createElement('div');row.className='log-event '+(ev.stage||'');
        var time=document.createElement('time');time.textContent=ev.at?String(ev.at).slice(0,19).replace('T',' '):'—';
        var stage=document.createElement('strong');
        var stageNames={failed:'执行失败',warning:'执行提示',segment_warning:'分段提示',persistence_warning:'记录保存异常',download_timing:'耗时统计',segment_start:'开始处理分段',segment_wave:'波次生成结果',print_checkpoint:'打印文件记录',export_checkpoint:'导出任务记录',completed:'执行完成',completed_with_warnings:'部分完成',cancelled:'已取消',queued:'已进入队列'};
        stage.textContent=stageNames[ev.stage]||ev.stage||'执行记录';stage.title=ev.stage||'';
        var message=document.createElement('p');var text=ev.message;
        if(typeof text!=='string') text=JSON.stringify(text,null,2);
        else if(/^[\[{]/.test(text)) {try{text=JSON.stringify(JSON.parse(text),null,2);}catch(e){}}
        message.textContent=text;row.append(time,stage,message);section.appendChild(row);
      });
      list.appendChild(section);
    });
    if(!entries.length) list.textContent='暂无任务日志。';
    panel.scrollTop=scroll;
  }
  var detailFetching=false;
  async function refreshLogDetails() {
    if($('logDetailsPanel').hidden || detailFetching) return;
    detailFetching=true;
    try {
      var r=await fetch('/api/jobs',{signal:AbortSignal.timeout(5000)});
      if(!r.ok) throw new Error('HTTP '+r.status);
      var jobs=await r.json();jobs.forEach(function(j){detailJobs.set(j.id,j);});
      renderLogDetails();$('logDetailsStatus').textContent='按任务展示完整过程；执行中的记录自动更新。';
    }catch(e){$('logDetailsStatus').textContent='日志更新失败，已保留现有记录：'+e.message;}
    finally{detailFetching=false;}
  }
  $('btnLogDetails').onclick=function(){
    var open=$('logDetailsPanel').hidden;
    $('logDetailsPanel').hidden=!open;$('schedulePanel').hidden=true;$('out').hidden=open;
    $('btnLogDetails').setAttribute('aria-expanded',String(open));$('btnSchedule').setAttribute('aria-expanded','false');
    if(open){renderLogDetails();refreshLogDetails();}
  };
  setInterval(refreshLogDetails,5000);
  function wmsJobHeaderLine(job) {
    var line = document.createElement('div');
    line.className = 'ev jobhead';
    var t = job.created_at ? String(job.created_at).slice(11, 16) : '';
    line.textContent = '▶ ' + t + ' 开始任务：' + (job.generation_job_id ? '跟随打印' : (WMS_MODE_LABEL[job.mode] || job.mode)) + (job.attempt > 1 ? ' · 第 ' + job.attempt + ' 轮续跑' : '');
    return line;
  }
  function wmsLinkLine(href, download, text) {
    var line = document.createElement('div');
    line.className = 'ev link';
    var a = document.createElement('a');
    a.href = href;
    a.download = download;
    a.textContent = text;
    line.appendChild(a);
    return line;
  }
  function wmsAppendDownloadLinks(job) {
    /* 每个任务的可下载文件只挂一次；刷新页面后靠恢复流程重新挂载 */
    var log = $('wmsLog');
    if (job.status === 'succeeded' && job.mode === 'export' &&
        job.result && job.result.task_filename && !wms.jobLinks.has(job.id + ':file')) {
      wms.jobLinks.add(job.id + ':file');
      log.appendChild(wmsLinkLine(
        '/api/jobs/' + job.id + '/file',
        job.result.task_filename,
        '下载订单文件：' + job.result.task_filename
      ));
    }
    if (job.result && job.result.merged_file && !wms.jobLinks.has(job.id + ':merged')) {
      wms.jobLinks.add(job.id + ':merged');
      var mergedName = String(job.result.merged_file).split('/').pop();
      log.appendChild(wmsLinkLine(
        '/api/jobs/' + job.id + '/merged', mergedName, '下载合并文档：' + mergedName
      ));
    }
  }
  function wmsRenderLog(job) {
    if(logPanel.parentNode !== $('wmsLog')) $('wmsLog').appendChild(logPanel);
    wmsRememberJob(job);
    if (job.follow_print) wmsFollowWatch(job);
    var log = $('wmsLog');
    while (wms.events < job.events.length) {
      var ev = job.events[wms.events++];
      // Structured checkpoints are internal recovery facts, not user log prose.
      if (ev.stage === 'segment_start' || ev.stage === 'print_checkpoint' || ev.stage === 'export_checkpoint') continue;
      /* 逐段波次事件：生成一个立即回填一个并变绿 */
      if (ev.stage === 'segment_wave') {
        try {
          var wv = JSON.parse(ev.message);
          if (wv && wv.wave_no) {
            var key = wv.channel + '|' + wv.seg_name;
            if (jobSegmentMatches(job, wv) && state.waveNos.get(key) !== wv.wave_no) {
              state.waveNos.set(key, wv.wave_no);
              refreshSegLine(key);
              updateMarksInPlace();
            }
            continue;
          }
        } catch (e) { /* 完整原文已保留在日志详情。 */ }
      }
    }
    /* 任务完成后挂载其可下载文件（导出文件 / 合并文档），每个任务仅一次 */
    wmsAppendDownloadLinks(job);
    wmsSummary(job);
    log.scrollTop = log.scrollHeight;
    var last = job.events[job.events.length - 1];
    $('wmsMsg').textContent = job.generation_job_id?'跟随打印':(WMS_MODE_LABEL[job.mode]||job.mode);
    wmsRenderState();
  }
  function wmsStopPolling() {
    if (wms.timer) { clearInterval(wms.timer); wms.timer = null; }
    wms.pollEpoch += 1;
    var request = wms.pollRequest;
    wms.pollRequest = null;
    if (request) {
      clearTimeout(request.timeout);
      request.controller.abort();
    }
  }
  async function wmsAutoImport(job, epoch) {
    try {
      var resp = await fetch('/api/jobs/' + job.id + '/file');
      if (!resp.ok) return;
      var buf = await resp.arrayBuffer();
      if (epoch !== wms.pollEpoch) return;
      var name = (job.result && job.result.task_filename) || 'ParcelOutbound.xlsx';
      handleFile(new File([buf], name));
    } catch (e) { /* 自动导入失败不影响任务结果展示 */ }
  }
  function wmsLogLine(text, cls) {
    detailNotices.push({at:new Date().toISOString(),stage:cls||'提示',message:text});
    renderLogDetails();
    if(cls==='synced') return;
    if(['err','warn','failed'].indexOf(cls)>=0 && text.length>100) text=text.split(/[：:]/)[0]+'；请查看日志详情。';
    var log = $('wmsLog');
    var line = document.createElement('div');
    line.className = 'ev ' + (cls || 'warn');
    line.textContent = text;
    log.appendChild(line);
    log.scrollTop = log.scrollHeight;
  }
  function wmsAbortPolling(text) {
    /* 任务记录丢失/服务中断：停止轮询恢复空闲，提示用户刷新后重新提交 */
    wmsStopPolling();
    wms.jobId = null;
    wms.job = null;
    wmsSetBusy(false);
    wmsRenderState();
    wmsLogLine(text);
  }
  async function wmsPollOnce() {
    if (!wms.jobId || wms.pollRequest || wms.cancelling) return;
    var request = { jobId: wms.jobId, epoch: wms.pollEpoch, controller: new AbortController() };
    wms.pollRequest = request;
    request.timeout = setTimeout(function () { request.controller.abort(); }, 10000);
    function current() {
      return wms.pollRequest === request && wms.jobId === request.jobId && wms.pollEpoch === request.epoch;
    }
    try {
      var resp = await fetch('/api/jobs/' + request.jobId, { signal: request.controller.signal });
      if (!current()) return;
      if (resp.status === 404) {
        wmsAbortPolling('任务记录不存在（本地服务可能已重启）。请刷新页面后重新提交任务。');
        return;
      }
      if (!resp.ok) throw new Error('任务查询失败：HTTP ' + resp.status);
      var job = await resp.json();
      if (!current()) return;
      if (!job || job.id !== request.jobId) throw new Error('任务查询返回了不匹配的任务');
      wms.job = job;
      wmsRenderLog(job);
      wms.errStreak = 0;
      var done = WMS_DONE.indexOf(job.status) !== -1;
      if (done) {
        wmsStopPolling();
        wms.jobId = null;
        wmsSetBusy(false);
        await wmsHandleTerminal(job);
      }
    } catch (e) {
      if (!current()) return;
      /* 连接中断：连续失败约 30 次后停止轮询并恢复空闲 */
      wms.errStreak = (wms.errStreak || 0) + 1;
      if (wms.errStreak >= 30) wmsAbortPolling('无法连接本地 WMS 服务（' + wms.errStreak + ' 次失败）。请确认服务已启动后刷新页面。');
    } finally {
      clearTimeout(request.timeout);
      if (wms.pollRequest === request) wms.pollRequest = null;
    }
  }
  async function wmsHandleTerminal(job) {
    wmsRememberJob(job);
    wmsUpdateRunButton();
    // Polling, cancellation responses and restored completed plans share the
    // same once-only result handling; clicking cancel cannot undo completion.
    if (WMS_DONE.indexOf(job.status) === -1 || wms.terminalJobs.has(job.id)) return;
    wms.terminalJobs.add(job.id);
    if (job.mode === 'generate_waves') {
      if (job.status === 'cancelled' || job.status === 'failed') {
        var confirmed = ((job.result && job.result.segments) || []).filter(function (s) { return s.wave_no; }).length;
        wmsLogLine('任务已停止：已完成 ' + confirmed + ' / 计划 ' + job.segments.length + ' 个分段；将按提交计划保存波次规划。' +
          (confirmed ? '' : '本次未确认生成任何波次。'), 'warn');
      }
      await wmsApplyWaveNos(job);
    }
    else if (job.status === 'succeeded' && job.mode === 'export' && !job.schedule_run_id) await wmsAutoImport(job, wms.pollEpoch);
  }
  function wmsStartPolling(job, alreadyRendered) {
    wms.latestJobs.set(job.mode, job);
    wms.mode = job.mode;
    wmsRenderModeSel();
    wmsInvalidateHistoryReads(false);
    wmsStopPolling();
    wms.job = job;
    wms.jobId = job.id;
    wms.errStreak = 0;
    wms.cancelling = false;
    if (!alreadyRendered) {
      wms.events = 0;
      var log = $('wmsLog');
      log.appendChild(wmsJobHeaderLine(job));
      wmsRenderLog(job);
    }
    wmsSetBusy(true);
    wms.timer = setInterval(wmsPollOnce, 1000);
  }
  function wmsEffectiveSegments() {
    var m = ms();
    var a = curAnalysis();
    var segs = [];
    orderedChannels(a, m.order).forEach(function (ch) {
      if (!m.sel.channels.has(ch.id)) return;
      ch.segments.forEach(function (s) {
        if (m.sel.segs.has(ch.id + '|' + s.name)) {
          segs.push({ channel: ch.id, seg_name: s.name, order_nos: s.orderNos.slice() });
        }
      });
    });
    return segs;
  }
  function wmsPlannedPrintWaves() {
    // Same ordered/selected blocks as the wave table; use internal kinds,
    // since the table's type text also labels hot-product waves as 单件.
    planIdentity();
    if (!state.records.length) return [];
    var m = ms(), seen = new Set(), waves = [];
    collectBlocks(orderedChannels(curAnalysis(), m.order), m.sel.channels, m.sel.segs).forEach(function (block) {
      block.segs.forEach(function (seg) {
        if (seg.kind !== 'paper' && seg.kind !== 'mix') return;
        var wave = state.waveNos.get(block.ch.id + '|' + seg.name);
        if (!wave || seen.has(wave)) return;
        if (!/^[A-Za-z0-9_-]+$/.test(wave)) throw new Error('当前规划中的波次号格式异常：' + wave);
        seen.add(wave); waves.push(wave);
      });
    });
    return waves;
  }
  async function wmsSubmit(mode) {
    if (!mode || wms.active || wms.submitting) return;
    if (mode === 'generate_waves' && wms.clearPending) {
      status('历史清理尚未确认，请等待完成或在日志中重试清理后再建立波次。', 'err');
      return;
    }
    var waves = [];
    var autoPrint = mode === 'print_waves' && !$('wmsWaves').value.trim();
    if (mode !== 'export') {
      var parsed = wmsParseWaves();
      var bad = parsed.filter(function (v) { return v.indexOf('__INVALID__:') === 0; });
      waves = parsed.filter(function (v) { return v.indexOf('__INVALID__:') !== 0; });
      if (bad.length) {
        status('波次号格式异常：' + bad.map(function (v) { return v.slice(12); }).join('、'), 'err');
        return;
      }
      if (autoPrint) {
        try { waves = wmsPlannedPrintWaves(); }
        catch (e) { status(e.message, 'err'); return; }
        if (!waves.length) { status('当前规划没有已生成的单件或混件波次', 'err'); return; }
      }
    }
    var body = {
      mode: mode,
      browser_mode: wms.headless ? 'headless' : 'headed',
      confirm_production: true
    };
    if (mode === 'generate_waves') {
      body.follow_print = wms.followPrint;
      body.segments = wmsEffectiveSegments();
      if (!body.segments.length) { status('没有可生成波次的分段：请先勾选渠道与分段', 'err'); return; }
      Object.assign(body, planIdentity());
      try {
        body.plan_snapshot = JSON.parse(JSON.stringify({ version: 1, workbook: currentExportData() }));
      } catch (e) { status('无法保存提交计划，未建立波次：' + e.message, 'err'); return; }
    } else if (mode !== 'export') body.wave_nos = waves;
    wmsStopPolling();
    var epoch = wms.pollEpoch;
    wms.submitting = true;
    try {
      var resp = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000)
      });
      if (epoch !== wms.pollEpoch) return;
      if (resp.status === 409) { status('已有任务在执行，请等待当前任务结束', 'err'); return; }
      if (!resp.ok) {
        var detail = '';
        try { detail = JSON.parse(await resp.text()).detail || ''; } catch (e) { }
        status('提交失败：' + (detail || '未知错误（HTTP ' + resp.status + '）'), 'err');
        return;
      }
      var job = await resp.json();
      if (epoch !== wms.pollEpoch) return;
      if (body.plan_snapshot && job.batch_id === body.batch_id && job.plan_id === body.plan_id) {
        wms.planSnapshots.set(job.id, { batch_id: body.batch_id, plan_id: body.plan_id, snapshot: body.plan_snapshot });
      }
      wmsStartPolling(job);
      if (autoPrint) wmsLogLine('打印清单自动取自当前规划：已生成的单件、混件，共 ' + waves.length + ' 个波次，按波次表顺序执行。', 'info');
    } catch (e) { if (epoch === wms.pollEpoch) status('提交结果未确认，请刷新查询任务状态，不要重复提交。', 'err'); }
    finally { wms.submitting = false; wmsUpdateRunButton(); }
  }
  async function wmsCancel() {
    if (!wms.jobId || wms.cancelling) return;
    var id = wms.jobId;
    wmsStopPolling(); // 取消请求发出即废弃旧查询，不能等其返回后再作废。
    var epoch = wms.pollEpoch;
    wms.cancelling = true;
    function current() { return wms.jobId === id && wms.pollEpoch === epoch; }
    try {
      var resp = await fetch('/api/jobs/' + id + '/cancel', { method: 'POST', signal: AbortSignal.timeout(10000) });
      if (!current()) return;
      if (resp.ok) {
        var job = await resp.json();
        if (!current()) return;
        if (!job || job.id !== id) throw new Error('取消响应的任务不匹配');
        wms.job = job;
        wmsRenderLog(job);
        wmsStopPolling();
        wms.jobId = null;
        wmsSetBusy(false);
        await wmsHandleTerminal(job);
      } else throw new Error('HTTP ' + resp.status);
    } catch (e) {
      if (current()) {
        wmsLogLine('取消请求未确认，将继续查询本任务状态：' + e.message, 'warn');
        wmsStartPolling(wms.job, true);
      }
    } finally { if (current() || !wms.jobId) wms.cancelling = false; }
  }
  /* 波次记录同步：从后端拉取已生成的波次号，回填到匹配分段（文字变绿）；导出统一在任务完成时进行 */
  async function wmsSyncWaveRecords() {
    if (!wms.available || wms.active || wms.clearPending || wms.historyRequest) return;
    var a;
    try { a = curAnalysis(); } catch (e) { return; }
    if (!a) return;
    var segKeys = new Set();
    a.channels.forEach(function (c) {
      c.segments.forEach(function (s) { segKeys.add(c.id + '|' + s.name); });
    });
    if (!segKeys.size) return;
    var identity = planIdentity();
    var epoch = wms.historyEpoch;
    var recordsAtStart = state.records;
    var controller = new AbortController();
    var request = { controller: controller, timeout: null };
    var timeout = setTimeout(function () { controller.abort(); }, 10000);
    request.timeout = timeout;
    wms.historyRequest = request;
    function current() {
      return wms.historyRequest === request && epoch === wms.historyEpoch &&
        wms.available && !wms.active && !wms.clearPending &&
        recordsAtStart === state.records && a === curAnalysis() && identity.plan_id === planIdentity().plan_id;
    }
    try {
      var resp = await fetch('/api/wave-records' + planQuery(identity), { signal: controller.signal });
      if (!current() || !resp.ok) return;
      var records = await resp.json();
      if (!current() || !Array.isArray(records)) return;
      var changed = 0;
      (records || []).forEach(function (r) {
        if (!r || !r.wave_no) return;
        var key = r.channel + '|' + r.seg_name;
        if (!segKeys.has(key) || !matchesCurrentSegment(r, r)) return;
        if (state.waveNos.get(key) === r.wave_no) return;
        state.waveNos.set(key, r.wave_no);
        refreshSegLine(key);
        changed += 1;
      });
      if (changed) {
        updateMarksInPlace();
        wmsLogLine('后台同步：补充回填 ' + changed + ' 个已完成分段的波次号（页面累计 ' + state.waveNos.size + ' 个，对应分段已变绿）。', 'synced');
      }
    } catch (e) { /* 读取中断由下一轮查询恢复，不能充当清理成功。 */ }
    finally {
      clearTimeout(timeout);
      if (wms.historyRequest === request) wms.historyRequest = null;
    }
  }
  /* 任务结束后回填已确认波次，并导出完整提交计划，包括取消、失败和零完成。 */
  async function wmsApplyWaveNos(job) {
    var outcomes = (job.result && job.result.segments) || [];
    var changed = false;
    outcomes.forEach(function (o) {
      if (o.wave_no) {
        var key = o.channel + '|' + o.seg_name;
        if (jobSegmentMatches(job, o) && state.waveNos.get(key) !== o.wave_no) {
          state.waveNos.set(key, o.wave_no);
          changed = true;
        }
      }
    });
    if (changed) {
      /* 就地刷新分段行（含变绿），并重算汇总；UI 异常不阻断导出 */
      try {
        outcomes.forEach(function (o) {
          if (o.wave_no) refreshSegLine(o.channel + '|' + o.seg_name);
        });
        updateMarksInPlace();
      } catch (e) { }
    }
    if (WMS_DONE.indexOf(job.status) !== -1) {
      await wmsAutoExport(job);
    }
  }
  function wmsBuildExportBuffer() {
    var data = currentExportData();
    if (!data) return null;
    var u8 = buildXlsxBuffer(data.sheets);
    var bin = '';
    for (var i = 0; i < u8.length; i += 8192) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + 8192, u8.length)));
    }
    return btoa(bin);
  }
  function wmsRenderExportLinks() {
    /* 从后端拉取最近导出清单，为尚未展示的文件追加下载链接（刷新页面后仍可恢复） */
    fetch('/api/exports')
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (items) {
        var log = $('wmsLog');
        (items || []).forEach(function (it) {
          if (!it || !it.file || wms.linkedExports.has(it.file)) return;
          wms.linkedExports.add(it.file);
          var line = document.createElement('div');
          line.className = 'ev link';
          var a = document.createElement('a');
          a.href = it.url;
          a.download = it.file;
          a.textContent = '下载波次规划：' + it.file;
          line.appendChild(a);
          log.appendChild(line);
        });
        log.scrollTop = log.scrollHeight;
      })
      .catch(function () { });
  }
  function wmsAutoExport(job) {
    if (job.planning_export_file) { wmsRenderExportLinks(); return Promise.resolve(true); }
    var entry = wms.exportJobs.get(job.id);
    if (!entry) {
      entry = { bytes: null, filename: '', pending: null, done: false, retryLink: null };
      wms.exportJobs.set(job.id, entry);
      if (!job.has_plan_snapshot || !job.batch_id || !job.plan_id) {
        entry.unbound = true;
        wmsLogLine('此任务没有可靠的提交计划快照，已保留日志，但不会回填或自动导出当前计划；无需重新生成波次。', 'warn');
      }
    }
    if (entry.done) return Promise.resolve(true);
    if (entry.pending) return entry.pending;
    if (entry.unbound) return Promise.resolve(false);
    entry.pending = Promise.resolve().then(async function () {
      try {
        if (!entry.bytes) {
          var saved = wms.planSnapshots.get(job.id);
          if (!saved) {
            var planResp = await fetch('/api/jobs/' + job.id + '/plan', { signal: AbortSignal.timeout(10000) });
            if (!planResp.ok) throw new Error('提交计划快照读取失败：HTTP ' + planResp.status);
            saved = await planResp.json();
          }
          if (saved.batch_id !== job.batch_id || saved.plan_id !== job.plan_id) throw new Error('提交计划身份不匹配');
          var data = JSON.parse(JSON.stringify(saved.snapshot.workbook));
          var table = data.sheets.find(function (s) { return s.name === '波次表'; });
          if (!table || !Array.isArray(table.waveRefs) || table.waveRefs.length !== job.segments.length) throw new Error('提交计划波次表无效');
          // Snapshot may contain earlier runs' numbers. Only this job's confirmed
          // results belong in its export; keep the cached original untouched.
          table.waveRefs.forEach(function (ref) {
            if (!table.aoa[ref.row]) throw new Error('提交计划波次行无效');
            table.aoa[ref.row][2] = '';
          });
          var outcomes = (job.result && job.result.segments) || [];
          outcomes.forEach(function (o) {
            if (!o.wave_no) return;
            var ref = table.waveRefs.find(function (r) { return r.channel === o.channel && r.seg_name === o.seg_name; });
            if (!ref || !table.aoa[ref.row]) throw new Error('已确认波次不属于提交计划');
            table.aoa[ref.row][2] = o.wave_no;
          });
          entry.filename = data.filename;
          entry.bytes = buildXlsxBuffer(data.sheets);
        }
        if (entry.retryLink) entry.retryLink.textContent = '保存中…';
        var resp = await fetch('/api/jobs/' + job.id + '/planning-export', {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
          body: entry.bytes, signal: AbortSignal.timeout(10000)
        });
        if (!resp.ok) throw new Error('服务返回 ' + resp.status);
        entry.done = true;
        entry.bytes = null;
        wms.planSnapshots.delete(job.id);
        if (entry.retryLink) { entry.retryLink.parentNode.remove(); entry.retryLink = null; }
        wmsRenderExportLinks();
        if (job.follow_print) wmsRefreshFollow();
        return true;
      } catch (e) {
        wmsLogLine('自动导出失败：' + (e && e.message ? e.message : e) + '。可重试保存文件，无需重新生成波次。', 'err');
        if (!entry.retryLink) {
          var line = document.createElement('div');
          line.className = 'ev link';
          var link = document.createElement('a');
          link.href = '#';
          link.onclick = function (event) { event.preventDefault(); wmsAutoExport(job); };
          line.appendChild(link);
          $('wmsLog').appendChild(line);
          entry.retryLink = link;
        }
        entry.retryLink.textContent = '重试保存文件：' + (entry.filename || '波次规划');
        return false;
      }
    }).finally(function () { entry.pending = null; });
    return entry.pending;
  }
  var followCards = new Map(), followSeen = new Set(), followRequest = false, followTimer = null;
  function wmsFollowWatch(job) {
    if (!followCards.has(job.id)) {
      var card = document.createElement('div');
      card.className = 'ev follow-print-status';
      $('wmsLog').appendChild(card);
      followCards.set(job.id, card);
    }
    wmsFollowCard(job);
    if (!followTimer) followTimer = setInterval(wmsRefreshFollow, 3000);
  }
  function wmsFollowCard(job) {
    var card = followCards.get(job.id);
    if (!card) return;
    card.innerHTML = '';
    var labels = {waiting_generation:'等待生成完成',waiting_file:'等待规划文件保存',pending:'等待浏览器空闲',started:'已启动',cancelled:'已取消',skipped:'没有单件或混件，已跳过',blocked:'未启动，请查看日志详情'};
    var stopped = ['failed','partial','cancelled'].indexOf(job.status)>=0;
    card.textContent = '跟随打印 · ' + (stopped ? '生成未全部完成，不自动打印' : (labels[job.follow_print_state]||'等待生成完成'));
    if (!job.follow_print_job_id && !stopped && ['waiting_generation','waiting_file','pending'].indexOf(job.follow_print_state)>=0) {
      var cancel = document.createElement('a'); cancel.href='#'; cancel.textContent='　取消跟随打印';
      cancel.onclick=async function(e){e.preventDefault();try{
        var r=await fetch('/api/jobs/'+job.id+'/follow-print/cancel',{method:'POST'});
        if(!r.ok) throw new Error('状态已变化，请刷新后取消打印任务');
        await wmsRefreshFollow();
      }catch(err){wmsLogLine(err.message);}};
      card.appendChild(cancel);
    }
  }
  async function wmsRefreshFollow() {
    if(followRequest || !followCards.size) return;
    followRequest=true;
    var epoch=wms.pollEpoch;
    try {
      var response=await fetch('/api/jobs',{signal:AbortSignal.timeout(5000)});
      if(!response.ok) return;
      var jobs=await response.json();
      jobs.forEach(function(j){if(j.follow_print) wmsFollowCard(j);});
      jobs.forEach(function(parent){
        if(!parent.follow_print_job_id || !followCards.has(parent.id)) return;
        var child=jobs.find(function(j){return j.id===parent.follow_print_job_id;});
        var visited=new Set();
        while(child && child.retry_job_id && !visited.has(child.id)){
          visited.add(child.id); child=jobs.find(function(j){return j.id===child.retry_job_id;});
        }
        if(child) followCards.get(parent.id).textContent='跟随打印 · '+(WMS_STATE_LABEL[child.status]||child.status);
      });
      if(epoch!==wms.pollEpoch || wms.active || wms.submitting) return;
      // Adopt only a new linked print attempt; never repeatedly override manual choices.
      var child=jobs.find(function(j){return j.generation_job_id && followCards.has(j.generation_job_id) && !j.retry_job_id && !followSeen.has(j.id);});
      if(child){
        followSeen.add(child.id);
        wmsStartPolling(child,false);
        await wmsPollOnce();
      }
    } catch(e) { /* Reconcile again after connectivity returns. */ }
    finally {followRequest=false;}
  }
  function wmsEnsureHealthLoop() {
    if (wms.healthTimer) return;
    wms.healthTimer = setInterval(function () {
      fetch('/api/health', { signal: AbortSignal.timeout(1500) })
        .then(function (r) { return r.ok; })
        .then(wmsSetAvailable)
        .catch(function () { wmsSetAvailable(false); });
    }, 10000);
  }
  function wmsSetAvailable(ok) {
    wmsEnsureHealthLoop();
    if (wms.available === ok) return;  // 状态未变化时不动界面
    if (!ok) wmsInvalidateHistoryReads(false);
    wms.available = ok;
    if(!ok) cutoffIndicator(null);
    $('wmsSection').style.display = ok ? '' : 'none';
    $('wmsPanel').hidden = !ok;
    $('wmsDot').className = 'wms-dot ' + (ok ? 'ok' : 'err');
    if (ok) {
      wmsRestore();  // 内部在日志重建完成后追加波次规划导出链接
      if (!wms.recTimer) {
        wms.recTimer = setInterval(wmsSyncWaveRecords, 5000);
        wmsSyncWaveRecords();
      }
    } else if (wms.recTimer) {
      clearInterval(wms.recTimer);
      wms.recTimer = null;
    }
    if (!ok) wmsAbortPolling('本地 WMS 服务连接已中断；恢复连接后将重新查询任务状态，请勿据此重复提交。');
  }
  async function wmsRestore() {
    var epoch = wms.pollEpoch;
    try {
      var resp = await fetch('/api/jobs');
      if (resp.ok) {
        var jobs = (await resp.json()).filter(function(j){return !j.schedule_run_id;});
        if (epoch !== wms.pollEpoch || wms.active || wms.submitting) return;
        if (jobs.length) {
          var log = $('wmsLog');
          if (!wms.restoredIds.size) log.innerHTML = '';
          /* 旧 → 新渲染当天全部任务日志，并挂载各自的可下载文件链接 */
          jobs.slice().reverse().forEach(function (j) {
            if (wms.restoredIds.has(j.id)) return;
            wms.restoredIds.add(j.id);
            log.appendChild(wmsJobHeaderLine(j));
            wms.events = 0;
            wms.job = j;
            wmsRenderLog(j);
          });
          var activeJob = null;
          jobs.forEach(function (j) {
            if (WMS_ACTIVE.indexOf(j.status) !== -1 && !activeJob) activeJob = j;
          });
          if (activeJob) wmsStartPolling(activeJob, true);
          else {
            wms.job = jobs[0];
            if (!wms.mode && jobs[0].checkpoint_version === 1 && ['failed','partial'].indexOf(jobs[0].status) >= 0 && ['generate_waves','print_waves'].indexOf(jobs[0].mode) >= 0) {
              wms.mode = jobs[0].mode;
              wmsRenderModeSel();
            }
            wmsRenderState();
          }
          // 页面离线时已完成的计划也能从提交快照恢复导出，无需重新执行 WMS。
          for (var j of jobs) {
            if (j.mode === 'generate_waves' && WMS_DONE.indexOf(j.status) !== -1 && !wms.terminalJobs.has(j.id)) {
              await wmsHandleTerminal(j);
            }
          }
        }
      }
    } catch (e) { }
    /* 日志重建完成后才追加当天波次规划导出链接，避免与日志重建竞争（先渲染后追加，防止被清空） */
    wmsRenderExportLinks();
    wmsRestoreHistoryRetry();
  }

  /* 一个每日截单；调度、下载和合并属于后端，只有用户点击才分析。 */
  var cutoffBusy = false, cutoffLoading = false, cutoffData = null, cutoffDirty = false, cutoffRequest = false;
  var cutoffLabels = {base:'预导出中',waiting:'等待截单',delta:'增量导出中',merge:'合并校验中',succeeded:'文件已就绪',failed:'失败',missed:'已错过'};
  function cutoffView(open) {
    $('logDetailsPanel').hidden = true;
    $('btnLogDetails').setAttribute('aria-expanded','false');
    $('schedulePanel').hidden = !open;
    $('out').hidden = open;
    $('btnSchedule').setAttribute('aria-expanded', String(open));
  }
  function cutoffTime(value, zone) {
    if(!value) return '—';
    return new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
  }
  function cutoffFileLink(run, download) {
    var a = document.createElement('a');
    a.className = 'schedule-file';
    a.href = '/api/schedule/runs/' + encodeURIComponent(run.id) + '/file';
    a.textContent = download ? '下载' : run.filename + ' · 点击加载分析';
    if(download) {a.download = run.filename;}
    else a.onclick = function(e){e.preventDefault();cutoffLoad(run);};
    return a;
  }
  async function cutoffLoad(run) {
    if(cutoffLoading || wms.active || wms.submitting || cutoffBusy) {status('请等待当前任务结束后再加载截单订单。','err');return;}
    cutoffLoading=true; wms.submitting=true; wmsUpdateRunButton(); $('btnImport').disabled=true;
    try {
      var jobs = await cutoffFetch('/api/jobs');
      if(jobs.some(function(j){return WMS_ACTIVE.indexOf(j.status)>=0;})) throw new Error('后台任务正在运行，请稍后加载。');
      if(state.records.length && !window.confirm('加载截单订单将替换当前规划与波次标记，是否继续？')) return;
      var response=await fetch('/api/schedule/runs/'+encodeURIComponent(run.id)+'/file',{signal:AbortSignal.timeout(60000)});
      if(!response.ok) throw new Error('截单文件无法读取，请检查执行记录或下载文件。');
      var bytes=await response.arrayBuffer();
      var loaded=await new Promise(function(resolve){handleFile(new File([bytes],run.filename),resolve);});
      if(loaded) {cutoffView(false);wmsLogLine('已加载截单结果：'+cutoffTime(run.cutoff,run.timezone)+'（'+run.timezone+'）。','completed');}
    } catch(e) {status(e.message,'err');wmsLogLine('截单加载失败：'+e.message,'failed');}
    finally {cutoffLoading=false;wms.submitting=false;$('btnImport').disabled=false;wmsUpdateRunButton();}
  }
  async function cutoffFetch(url, options) {
    var response=await fetch(url,Object.assign({signal:AbortSignal.timeout(10000)},options||{}));
    var data=await response.json();
    if(!response.ok) throw new Error(typeof data.detail==='string'?data.detail:JSON.stringify(data.detail||'请求失败'));
    return data;
  }
  function cutoffIndicator(data) {
    var latest=data && data.runs && data.runs[0];
    var attention=!!(data && (data.error || (latest && ['failed','missed'].indexOf(latest.status)>=0)));
    var healthy=!!(data && data.config.enabled && !attention);
    var label=!data?'服务未连接':attention?'需要检查执行记录':!data.config.enabled?'未启用':data.browser_busy?'正在执行':'已启用，调度正常';
    $('btnSchedule').classList.toggle('scheduled-on',healthy);
    $('btnSchedule').title='定时任务：'+label;
    $('btnSchedule').setAttribute('aria-label','定时任务：'+label);
  }
  function cutoffRender(data, fill) {
    cutoffData=data; cutoffBusy=!!data.browser_busy; wmsUpdateRunButton();
    cutoffIndicator(data);
    var c=data.config;
    if(fill && !cutoffDirty) {
      $('scheduleEnabled').checked=c.enabled;$('scheduleTime').value=c.cutoff_time;
      $('scheduleAdvance').value=c.advance_minutes;$('scheduleTimezone').value=c.timezone;
    }
    $('scheduleSave').disabled=!!data.error;
    $('scheduleMessage').textContent=data.error || (c.enabled ? '下次预导出：'+cutoffTime(data.next_base,c.timezone)+'；截单：'+cutoffTime(data.next_cutoff,c.timezone)+'（'+c.timezone+'）' : '定时截单已停用。保存启用后才会执行。');
    var list=$('scheduleRuns');
    var signature=JSON.stringify(data.runs);
    if(list.dataset.signature!==signature) {
      var expanded=Array.from(list.querySelectorAll('details[open]')).map(function(el){return el.dataset.run;});
      list.replaceChildren();list.dataset.signature=signature;
      data.runs.forEach(function(run){
        var card=document.createElement('details');card.className='schedule-run';card.dataset.run=run.id;card.open=expanded.indexOf(run.id)>=0;
        var title=document.createElement('summary');title.textContent=cutoffTime(run.cutoff,run.timezone)+' · '+(cutoffLabels[run.status]||run.status)+' · '+run.timezone;card.appendChild(title);
        if(run.status==='succeeded') {var p=document.createElement('p');p.append(cutoffFileLink(run,false),document.createTextNode('　'),cutoffFileLink(run,true));card.appendChild(p);}
        if(run.status==='failed') {var retry=document.createElement('button');retry.className='bb';retry.textContent='重试失败阶段';retry.onclick=async function(){retry.disabled=true;try{cutoffRender(await cutoffFetch('/api/schedule/runs/'+encodeURIComponent(run.id)+'/retry',{method:'POST'}),false);}catch(e){$('scheduleMessage').textContent=e.message;retry.disabled=false;}};card.appendChild(retry);}
        var logs=document.createElement('button');logs.className='bb';logs.textContent='查看日志详情';logs.onclick=function(){$('btnLogDetails').click();};card.appendChild(logs);list.appendChild(card);
      });
    }
    data.runs.slice(0,5).reverse().forEach(function(run){
      var id='cutoff-log-'+run.id, line=$(id), sig=JSON.stringify(run);
      if(line && line.dataset.signature===sig) return;
      var log=$('wmsLog'), atBottom=log.scrollTop+log.clientHeight>=log.scrollHeight-30;
      if(!line) {line=document.createElement('div');line.id=id;line.className='ev link cutoff-log';log.appendChild(line);}
      line.dataset.signature=sig;line.replaceChildren();
      var title=document.createElement('div');title.className='ev jobhead';title.textContent='截单 '+cutoffTime(run.cutoff,run.timezone)+' · '+(cutoffLabels[run.status]||run.status);line.appendChild(title);
      if(run.status==='succeeded') line.append(cutoffFileLink(run,false),cutoffFileLink(run,true));
      if(run.status==='failed') {var hint=document.createElement('div');hint.textContent='截单失败，请在定时任务中重试；原因见日志详情。';line.appendChild(hint);}
      if(atBottom) log.scrollTop=log.scrollHeight;
    });
    renderLogDetails();
  }
  async function cutoffRefresh() {
    if(cutoffRequest) return;
    cutoffRequest=true;
    try {var data=await cutoffFetch('/api/schedule');if(data && data.config && Array.isArray(data.runs)) cutoffRender(data,true);}
    catch(e) {cutoffIndicator(null);$('scheduleMessage').textContent='定时服务不可用：'+e.message;$('scheduleSave').disabled=true;}
    finally {cutoffRequest=false;}
  }
  function cutoffInit() {
  $('btnSchedule').onclick=function(){cutoffView($('schedulePanel').hidden);if(!$('schedulePanel').hidden) cutoffRefresh();};
  $('scheduleForm').addEventListener('input',function(){cutoffDirty=true;});
  $('scheduleForm').onsubmit=async function(e){
    e.preventDefault();$('scheduleSave').disabled=true;
    try {
      var data=await cutoffFetch('/api/schedule',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:$('scheduleEnabled').checked,cutoff_time:$('scheduleTime').value,advance_minutes:Number($('scheduleAdvance').value),timezone:$('scheduleTimezone').value.trim()})});
      cutoffDirty=false;cutoffRender(data,true);wmsLogLine('定时截单配置已保存，范围为截单时刻往前一周。','completed');
    }catch(err){$('scheduleMessage').textContent=err.message;}
    finally{$('scheduleSave').disabled=false;}
  };
  if(location.protocol!=='file:') {cutoffRefresh();setInterval(function(){if(wms.available) cutoffRefresh();},5000);}
  }
  cutoffInit();

  /* 测试钩子 */
  window.__dshTest = {
    handleFile: handleFile,
    cutoffRefresh: cutoffRefresh,
    cutoffLoad: cutoffLoad,
    state: state,
    wms: wms,
    wmsSubmit: wmsSubmit,
    wmsSyncWaveRecords: wmsSyncWaveRecords,
    wmsPollOnce: wmsPollOnce,
    wmsRestore: wmsRestore,
    wmsRetry: wmsRetry,
    curAnalysis: curAnalysis,
    getAnalysis: getAnalysis,
    toggleOrdinaryEvolution: toggleOrdinaryEvolution,
    toggleUspsSubdivision: toggleUspsSubdivision,
    buildExportBuffer: wmsBuildExportBuffer,
    buildExportNow: function () {
      return currentExportData();
    }
  };
})();
