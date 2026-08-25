/* =============================================================
 * 波次规划工具 · 终端风格界面（纯点击操作）
 * 业务逻辑（core.js）与桌面版完全一致；页面无命令行输入、无操作日志，
 * 所有交互就地更新，不扰动页面结构。
 * ============================================================= */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* 渠道终端文本色 */
  var CH_TEXT_COLOR = {
    'CBT': '#c4b5fd', 'CBS': '#86efac', 'SwiftX': '#93c5fd', 'SpeedX': '#fdba74',
    'YanWen': '#5eead4', 'Gofo': '#67e8f9', 'UPS': '#a5b4fc', 'USPS': '#6ee7b7',
    'Fedex': '#fda4af', 'UniUni': '#7dd3fc', 'BFE': '#fde68a', '未识别': '#9ca3af', '普通': '#cbd5e1'
  };
  function chColor(id) { return CH_TEXT_COLOR[id] || '#c9d1d9'; }

  /* ---------- 状态 ---------- */
  function makeModeState() {
    return {
      unified: { hotLine: 10, capacity: 400, multiSegs: 1, mixSegs: 1, absorb: 1 },
      per: new Map(),
      order: { custom: false, list: [] },
      sel: { channels: new Set(), segs: new Set(), seenChannels: new Set(), seenSegs: new Set() }
    };
  }
  var state = {
    waveNos: new Map(),  // 分段键(chId|segName) -> 波次号（生成波次后回填）
    records: [],
    qtyMap: {},
    merged: false,
    modes: { normal: makeModeState(), merged: makeModeState() },
    analysis: { normal: null, merged: null }
  };

  function modeKey() { return state.merged ? 'merged' : 'normal'; }
  function ms() { return state.modes[modeKey()]; }
  function paramsResolver(key) {
    var m = state.modes[key];
    return function (id) { return m.per.get(id) || m.unified; };
  }
  function getAnalysis(key) {
    key = key === 'merged' ? 'merged' : 'normal';
    if (!state.analysis[key]) {
      state.analysis[key] = analyze(state.records, state.qtyMap, key, paramsResolver(key));
    }
    return state.analysis[key];
  }
  function curAnalysis() { return getAnalysis(modeKey()); }
  function invalidate(key) { state.analysis[key] = null; }

  /* ---------- 渠道顺序 ---------- */
  function orderedChannels(a, orderState) {
    if (!orderState.custom || !orderState.list.length) return a.channels.slice();
    var byId = new Map(a.channels.map(function (c) { return [c.id, c]; }));
    var out = [], used = new Set();
    orderState.list.forEach(function (id) {
      var c = byId.get(id);
      if (c) { out.push(c); used.add(id); }
    });
    var news = a.channels.filter(function (c) { return !used.has(c.id); });
    sortByDefault(news);
    return out.concat(news);
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
      if (!pp) { pp = Object.assign({}, DEFAULT_UNIFIED); m.per.set(ch.id, pp); }
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

  /* ---------- 导入 ---------- */
  function clearData() {
    var keepN = state.modes.normal.unified;
    var keepM = state.modes.merged.unified;
    state.waveNos = new Map();
    state.records = [];
    state.qtyMap = {};
    state.analysis = { normal: null, merged: null };
    state.modes.normal = makeModeState();
    state.modes.merged = makeModeState();
    state.modes.normal.unified = keepN;
    state.modes.merged.unified = keepM;
  }
  function syncSelection(a) {
    var m = ms();
    a.channels.forEach(function (ch) {
      if (!m.sel.seenChannels.has(ch.id)) { m.sel.seenChannels.add(ch.id); m.sel.channels.add(ch.id); }
      ch.segments.forEach(function (s) {
        var k = ch.id + '|' + s.name;
        if (!m.sel.seenSegs.has(k)) { m.sel.seenSegs.add(k); m.sel.segs.add(k); }
      });
    });
  }
  function handleFile(file) {
    var reader = new FileReader();
    reader.onerror = function () { status('文件读取失败，请重试', 'err'); };
    reader.onload = function () {
      try {
        var wb = XLSX.read(new Uint8Array(reader.result), { type: 'array' });
        var loc = locateSheet(wb);
        var hm = mapHeaders(loc.rows[0]);
        var br = buildRecords(loc.rows.slice(1), hm);
        if (!br.records.length) throw new Error('「出库单」工作表中没有有效订单数据');
        clearData();
        state.records = br.records;
        state.qtyMap = br.qtyMap;
        var a = getAnalysis(modeKey());
        syncSelection(a);
        /* 导入新订单文件即视为新一批：清理既往波次生成历史（本地状态 + 后端记录） */
        wmsClearWaveHistory();
        /* 导入成功仅记入日志（左上角不再显示文件名栏） */
        wmsLogLine('已导入 ' + file.name + '（' + br.records.length + ' 单）。', 'imported');
      } catch (e) {
        clearData();
        status('导入失败：' + (e && e.message ? e.message : '文件解析失败'), 'err');
      }
      render();
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
    return '<span class="tog ' + state + '" ' + dataAttr + ' title="' + esc(title) + '">' + glyph + '</span>';
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
    if (p === 'capacity') val = (val / 100) + 'H';
    var atMin = val <= minOf(p);
    return '<span class="arr arr-l' + (atMin ? ' limit' : '') + '" data-ch="' + esc(chId || '') + '" data-p="' + p +
      '" data-dir="-1" title="-' + stepOf(p) + '">◀</span>' +
      '<span class="pval">' + val + '</span>' +
      '<span class="arr arr-r" data-ch="' + esc(chId || '') + '" data-p="' + p +
      '" data-dir="1" title="+' + stepOf(p) + '">▶</span>';
  }
  function absorbCell(chId, val) {
    return '<span class="aval" data-ch="' + esc(chId || '') + '" title="单击切换档位（关闭 → 吸收 → 多件 → 全量）">' +
      UI_ABSORB_NAMES[val] + '</span>';
  }
  function segLineHtml(ch, s) {
    var key = ch.id + '|' + s.name;
    var effOn = segEffectiveOn(ch.id, s.name);
    var label = uiSegName(s.name) + '·' + s.orderCount + '·' + s.skuCount;
    return '<div class="seg-line ' + (effOn ? 'on' : 'off') + (state.waveNos.has(key) && effOn ? ' waved' : '') + '" data-seg="' + esc(key) +
      '" title="' + esc(s.name) + '（点击切换导出勾选）"><span class="seg-name">' + esc(label) + '</span></div>';
  }
  function typeHeadHtml(t) {
    var state = typeMasterState(t);
    return togHtml(state, 'data-master="t:' + t + '"', '点击全选/取消「' + UI_TYPE_LABEL[t] + '」类型全部分段') +
      '<span class="type-tog" data-master="t:' + t + '">' + UI_TYPE_LABEL[t] + '</span>';
  }
  function effectiveOrderSum() {
    var m = ms();
    var sum = 0;
    curAnalysis().channels.forEach(function (c) { if (m.sel.channels.has(c.id)) sum += c.total; });
    return sum;
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

    var rows = '';
    /* 统一行 */
    rows += '<tr class="urowe">' +
      '<td><span class="dim">统一调整</span></td>' +
      '<td class="num">' + effectiveOrderSum() + '</td>' +
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
      rows += '<tr class="prow' + (m.sel.channels.has(ch.id) ? '' : ' off') + '" data-ch="' + esc(ch.id) + '">' +
        '<td class="left"><div class="ch-cell">' +
        '<span class="chn" tabindex="0" draggable="true" data-ch="' + esc(ch.id) + '" style="--chc:' + tagColor(ch.id) +
        '" title="点击切换渠道勾选 · 拖动排序 · 聚焦后 Alt+↑↓">' + esc(ch.id) + '</span></div></td>' +
        '<td class="num">' + ch.total + '</td>' +
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
      '<th>订单</th>' +
      '<th>容量</th>' +
      '<th>爆品</th>' +
      '<th>多件</th>' +
      '<th>混件</th>' +
      '<th>吸收</th>' +
      TYPE_ORDER.map(function (t) { return '<th class="left">' + typeHeadHtml(t) + '</th>'; }).join('') +
      '</tr>';

    return '<div class="twrap"><table class="pt">' +
      '<colgroup><col style="width:104px"><col style="width:60px"><col style="width:60px">' +
      '<col style="width:60px"><col style="width:60px"><col style="width:60px"><col style="width:60px">' +
      '<col style="width:114px"><col style="width:114px"><col style="width:114px"><col style="width:114px"></colgroup>' +
      '<thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div>';
  }

  /* ---------- 渲染（保持滚动位置，结构稳定；空数据也显示表格骨架） ---------- */
  function renderDash() {
    $('dash').innerHTML = dashHtml();
  }
  function renderBar() {
    var ok = typeof XLSX !== 'undefined';
    $('engineLabel').textContent = ok ? '' : 'FAIL';
    $('engineLabel').className = ok ? 'ok' : 'fail';
    $('engineLabelWrap').style.display = ok ? 'none' : '';
    $('modeLabel').textContent = state.merged ? '归并' : '拆分';
    $('modeLabel').className = state.merged ? 'mode-toggle on' : 'mode-toggle';
    $('btnExport').disabled = !state.records.length;
  }
  function render() {
    var out = $('out');
    var st = out.scrollTop;
    /* 调整参数产生的新分段/新渠道默认选中 */
    if (state.records.length) syncSelection(curAnalysis());
    renderDash();
    renderBar();
    out.scrollTop = st;
  }

  /* ---------- 导出 ---------- */
  function currentExportState() {
    var m = ms();
    return { channelSelected: m.sel.channels, segSelected: m.sel.segs, waveNos: state.waveNos };
  }
  function currentExportData() {
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
    var oc = document.querySelector('#dash .urowe td.num');
    if (oc) oc.textContent = effectiveOrderSum();
    var chEl = document.querySelector('#dash .tog[data-master="ch"]');
    if (chEl) setGlyphState(chEl, chMasterState());
    var st = effectiveSegStats();
    TYPE_ORDER.forEach(function (t) {
      var el = document.querySelector('#dash .tog[data-master="t:' + t + '"]');
      if (el) setGlyphState(el, typeMasterState(t));
      var c = document.querySelector('#dash .type-count[data-t="' + t + '"]');
      if (c) c.innerHTML = '<span class="wc">' + st[t].waves + '波</span>/<span class="oc">' + st[t].orders + '单</span>';
    });
  }
  function setGlyphState(el, state) {
    el.textContent = state === 'on' ? '[x]' : (state === 'some' ? '[~]' : '[ ]');
    el.classList.toggle('on', state === 'on');
    el.classList.toggle('some', state === 'some');
    el.classList.toggle('off', state === 'off');
  }
  function segElOf(key) {
    return document.querySelector('#dash .seg-line[data-seg="' + CSS.escape(key) + '"]');
  }
  function segParts(key) {
    var i = key.indexOf('|');
    return { chId: key.slice(0, i), segName: key.slice(i + 1) };
  }
  function refreshSegLine(key) {
    var el = segElOf(key);
    var p = segParts(key);
    var effOn = segEffectiveOn(p.chId, p.segName);
    if (el) {
      el.classList.toggle('on', effOn);
      el.classList.toggle('off', !effOn);
      el.classList.toggle('waved', state.waveNos.has(key) && effOn);
    }
  }
  /* 与类型全选框同模式：纯切换，无渠道联动；若某渠道全部分段被否掉，该渠道自动否掉 */
  function toggleSeg(key) {
    var m = ms();
    if (m.sel.segs.has(key)) m.sel.segs.delete(key);
    else m.sel.segs.add(key);
    refreshSegLine(key);
    autoDisableChannel(segParts(key).chId);
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
    if (el) el.style.setProperty('--chc', tagColor(id));
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
    updateMarksInPlace();
  }
  function toggleMerge() {
    state.merged = !state.merged;
    if (state.merged) {
      /* 归并后默认三个归并渠道（CBT/CBS/普通）全部已选 */
      var m = state.modes.merged;
      var a = getAnalysis('merged');
      m.sel.channels = new Set(a.channels.map(function (c) { return c.id; }));
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
  function applyManualOrder(ids) {
    var m = ms();
    m.order.custom = true;
    m.order.list = ids.slice();
    render();
  }

  /* ---------- 拖动排序 ---------- */
  var dragState = { row: null };
  var chnPress = { el: null, x: 0, y: 0, moved: false };
  function clearDropMarks() {
    Array.prototype.forEach.call(document.querySelectorAll('#dash .prow'), function (r) {
      r.classList.remove('drop-before', 'drop-after');
    });
  }
  function endDrag() {
    if (dragState.row) dragState.row.classList.remove('dragging');
    clearDropMarks();
    dragState.row = null;
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $('btnImport').addEventListener('click', function () { $('fileInput').click(); });
    $('fileInput').addEventListener('change', function () {
      if (this.files && this.files[0]) handleFile(this.files[0]);
      this.value = '';
    });
    $('btnExport').addEventListener('click', doExport);

    /* 渠道模式切换：拆分 / 归并 */
    $('modeLabel').addEventListener('click', toggleMerge);

    /* 页面配置：齿轮按钮 + 配置面板（主题，列表固定向下弹出；字体固定为 Sarasa Mono SC） */
    function applyTheme(v) {
      /* 主题只改外观（body 属性 → CSS 变量），不触碰任何页面状态与运行中的任务 */
      if (v) document.body.setAttribute('data-theme', v);
      else document.body.removeAttribute('data-theme');
    }
    function closeCfgLists() {
      $('themeList').hidden = true;
    }
    function bindCfgList(btnId, listId, apply) {
      $(btnId).addEventListener('click', function (e) {
        e.stopPropagation();
        ['themeList'].forEach(function (id) {
          if (id !== listId) $(id).hidden = true;
        });
        $(listId).hidden = !$(listId).hidden;
      });
      $(listId).addEventListener('click', function (e) {
        var li = e.target.closest ? e.target.closest('li[data-v]') : null;
        if (!li) return;
        e.stopPropagation();
        apply(li.getAttribute('data-v'));
        $(btnId).title = '当前主题：' + li.textContent;
        Array.prototype.forEach.call($(listId).children, function (x) { x.classList.toggle('on', x === li); });
        $(listId).hidden = true;
      });
    }
    bindCfgList('themeBtn', 'themeList', applyTheme);
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
      else wmsSubmit(wms.mode);
    });
    $('browserModeVal').addEventListener('click', wmsToggleBrowserMode);
    /* 初始显示与标记一致（无头），无需在 wms 对象定义前渲染 */
    fetch('/api/health', { signal: AbortSignal.timeout(1500) })
      .then(function (r) { return r.ok; })
      .then(wmsSetAvailable)
      .catch(function () { wmsSetAvailable(false); });

    /* 文件拖入 */
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) {
      e.preventDefault();
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    /* 点击交互（委托） */
    $('out').addEventListener('click', function (e) {
      var t = e.target;
      var segEl = t.closest ? t.closest('.seg-line[data-seg]') : null;
      if (segEl) { toggleSeg(segEl.dataset.seg); return; }
      var chnEl = t.closest ? t.closest('.chn[data-ch]') : null;
      if (chnEl) {
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
  function syncGutter() {
    var out = $('out');
    var g = Math.max(0, out.offsetWidth - out.clientWidth);
    document.documentElement.style.setProperty('--gutter', g + 'px');
    /* 页面最大宽度 = 表格容器宽 920 + 操作栏 200 + 左右留白 28 + 滚动条槽位 + 2px 余量，
       确保任何平台的滚动条宽度下表格容器都不会被挤窄而产生横向滚动条 */
    document.documentElement.style.setProperty('--shellmax', (920 + 200 + 28 + g + 2) + 'px');
  }
  (function init() {
    bindEvents();
    render();
    syncGutter();
    window.addEventListener('resize', function () {
      syncGutter();
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
  var wms = { available: false, job: null, jobId: null, timer: null, events: 0, active: false, clearPending: false, errStreak: 0, recTimer: null, healthTimer: null, mode: null, linkedExports: new Set(), headless: true, jobLinks: new Set(), restoredIds: new Set() };

  function wmsClearWaveHistory() {
    /* 历史不跨批次保留：清空本地波次号，并请求后端清空记录 */
    state.waveNos = new Map();
    wms.clearPending = true;
    fetch('/api/wave-records/clear', { method: 'POST' })
      .then(function (r) { if (r.ok) wms.clearPending = false; })
      .catch(function () { });
  }
  function wmsRenderModeSel() {
    var btns = document.querySelectorAll('.side-wms .wms-mode');
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('sel', btns[i].getAttribute('data-mode') === wms.mode);
    }
  }
  function wmsUpdateRunButton() {
    var run = $('wmsRun');
    run.disabled = wms.active ? false : !wms.mode;
    run.textContent = wms.active ? '取消任务' : '开始任务';
  }
  function wmsRenderBrowserMode() {
    var el = $('browserModeVal');
    el.textContent = wms.headless ? '无头' : '有头';
    el.classList.toggle('on', !wms.headless);
  }
  function wmsToggleBrowserMode() {
    wms.headless = !wms.headless;
    wmsRenderBrowserMode();
  }
  function wmsSelectMode(mode) {
    if (wms.active) return;
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
    var st = $('wmsState');
    st.textContent = wms.job ? (WMS_STATE_LABEL[wms.job.status] || wms.job.status) : '空闲';
    st.className = 'wms-state ' + (wms.job ? wms.job.status : '');
  }
  var WMS_MODE_LABEL = {
    export: '全量分析', generate_waves: '生成波次',
    print_waves: '打印波次', pick_waves: '批量拣货'
  };
  function wmsJobHeaderLine(job) {
    var line = document.createElement('div');
    line.className = 'ev jobhead';
    var t = job.created_at ? String(job.created_at).slice(11, 19) : '';
    line.textContent = '▶ ' + t + ' 开始任务：' + (WMS_MODE_LABEL[job.mode] || job.mode);
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
    var log = $('wmsLog');
    while (wms.events < job.events.length) {
      var ev = job.events[wms.events++];
      var line = document.createElement('div');
      line.className = 'ev ' + ev.stage;
      var t = ev.at ? String(ev.at).slice(11, 19) : '';
      /* 逐段波次事件：生成一个立即回填一个并变绿 */
      if (ev.stage === 'segment_wave') {
        try {
          var wv = JSON.parse(ev.message);
          if (wv && wv.wave_no) {
            var key = wv.channel + '|' + wv.seg_name;
            if (state.waveNos.get(key) !== wv.wave_no) {
              state.waveNos.set(key, wv.wave_no);
              refreshSegLine(key);
              updateMarksInPlace();
            }
            line.textContent = t + ' [波次生成] ' + wv.channel + ' ' + wv.seg_name + ' → ' + wv.wave_no;
            log.appendChild(line);
            log.scrollTop = log.scrollHeight;
            continue;
          }
        } catch (e) { /* 非结构化消息按普通事件展示 */ }
      }
      line.textContent = t + ' [' + ev.stage + '] ' + ev.message;
      log.appendChild(line);
    }
    /* 任务完成后挂载其可下载文件（导出文件 / 合并文档），每个任务仅一次 */
    wmsAppendDownloadLinks(job);
    log.scrollTop = log.scrollHeight;
    var last = job.events[job.events.length - 1];
    $('wmsMsg').textContent = last ? last.message : '';
    wmsRenderState();
  }
  function wmsStopPolling() {
    if (wms.timer) { clearInterval(wms.timer); wms.timer = null; }
  }
  async function wmsAutoImport(job) {
    try {
      var resp = await fetch('/api/jobs/' + job.id + '/file');
      if (!resp.ok) return;
      var buf = await resp.arrayBuffer();
      var name = (job.result && job.result.task_filename) || 'ParcelOutbound.xlsx';
      handleFile(new File([buf], name));
    } catch (e) { /* 自动导入失败不影响任务结果展示 */ }
  }
  function wmsLogLine(text, cls) {
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
    if (!wms.jobId) return;
    try {
      var resp = await fetch('/api/jobs/' + wms.jobId);
      if (resp.status === 404) {
        wmsAbortPolling('任务记录不存在（本地服务可能已重启）。请刷新页面后重新提交任务。');
        return;
      }
      if (!resp.ok) return;
      var job = await resp.json();
      wms.job = job;
      wmsRenderLog(job);
      wms.errStreak = 0;
      var done = WMS_DONE.indexOf(job.status) !== -1;
      if (done) {
        wmsStopPolling();
        wms.jobId = null;
        wmsSetBusy(false);
        if (job.mode === 'generate_waves') await wmsApplyWaveNos(job);
        else if (job.status === 'succeeded' && job.mode === 'export') await wmsAutoImport(job);
      }
    } catch (e) {
      /* 连接中断：连续失败约 30 次后停止轮询并恢复空闲 */
      wms.errStreak = (wms.errStreak || 0) + 1;
      if (wms.errStreak >= 30) wmsAbortPolling('无法连接本地 WMS 服务（' + wms.errStreak + ' 次失败）。请确认服务已启动后刷新页面。');
    }
  }
  function wmsStartPolling(job, alreadyRendered) {
    wmsStopPolling();
    wms.job = job;
    wms.jobId = job.id;
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
  async function wmsSubmit(mode) {
    if (!mode || wms.active) return;
    var waves = [];
    if (mode !== 'export') {
      var parsed = wmsParseWaves();
      var bad = parsed.filter(function (v) { return v.indexOf('__INVALID__:') === 0; });
      waves = parsed.filter(function (v) { return v.indexOf('__INVALID__:') !== 0; });
      if (bad.length) {
        status('波次号格式异常：' + bad.map(function (v) { return v.slice(12); }).join('、'), 'err');
        return;
      }
      if (mode === 'print_waves' && !waves.length) { status('打印波次时至少输入一个波次号', 'err'); return; }
    }
    var body = {
      mode: mode,
      browser_mode: wms.headless ? 'headless' : 'headed',
      confirm_production: true
    };
    if (mode === 'generate_waves') {
      body.segments = wmsEffectiveSegments();
      if (!body.segments.length) { status('没有可生成波次的分段：请先勾选渠道与分段', 'err'); return; }
    } else if (mode !== 'export') body.wave_nos = waves;
    try {
      var resp = await fetch('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (resp.status === 409) { status('已有任务在执行，请等待当前任务结束', 'err'); return; }
      if (!resp.ok) {
        var detail = '';
        try { detail = JSON.parse(await resp.text()).detail || ''; } catch (e) { }
        status('提交失败：' + (detail || '未知错误（HTTP ' + resp.status + '）'), 'err');
        return;
      }
      var job = await resp.json();
      wmsStartPolling(job);
    } catch (e) { status('无法连接本地 WMS 服务', 'err'); }
  }
  async function wmsCancel() {
    if (!wms.jobId) return;
    try {
      var resp = await fetch('/api/jobs/' + wms.jobId + '/cancel', { method: 'POST' });
      if (resp.ok) {
        var job = await resp.json();
        wms.job = job;
        wmsRenderLog(job);
        wmsStopPolling();
        wms.jobId = null;
        wmsSetBusy(false);
      }
    } catch (e) { }
  }
  /* 波次记录同步：从后端拉取已生成的波次号，回填到匹配分段（文字变绿）；导出统一在任务完成时进行 */
  async function wmsSyncWaveRecords() {
    if (!wms.available || wms.active) return;
    var a;
    try { a = curAnalysis(); } catch (e) { return; }
    if (!a) return;
    var segKeys = new Set();
    a.channels.forEach(function (c) {
      c.segments.forEach(function (s) { segKeys.add(c.id + '|' + s.name); });
    });
    if (!segKeys.size) return;
    try {
      var resp = await fetch('/api/wave-records');
      if (!resp.ok) return;
      var records = await resp.json();
      if (wms.clearPending) {
        /* 刚导入新文件：等待后端清理生效，期间不应用历史记录 */
        if (!records || records.length === 0) wms.clearPending = false;
        return;
      }
      var changed = 0;
      (records || []).forEach(function (r) {
        if (!r || !r.wave_no) return;
        var key = r.channel + '|' + r.seg_name;
        if (!segKeys.has(key)) return;
        if (state.waveNos.get(key) === r.wave_no) return;
        state.waveNos.set(key, r.wave_no);
        refreshSegLine(key);
        changed += 1;
      });
      if (changed) {
        updateMarksInPlace();
        wmsLogLine('后台同步：补充回填 ' + changed + ' 个已完成分段的波次号（页面累计 ' + state.waveNos.size + ' 个，对应分段已变绿）。', 'synced');
      }
    } catch (e) { /* 连接中断静默重试 */ }
  }
  /* 生成波次完成：回填波次号（分段文字变绿），成功/部分完成时自动导出一次并给下载链接 */
  async function wmsApplyWaveNos(job) {
    var outcomes = (job.result && job.result.segments) || [];
    var anyWave = false;
    var changed = false;
    outcomes.forEach(function (o) {
      if (o.wave_no) {
        anyWave = true;
        var key = o.channel + '|' + o.seg_name;
        if (state.waveNos.get(key) !== o.wave_no) {
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
    if (anyWave && (job.status === 'succeeded' || job.status === 'partial')) {
      await wmsAutoExport();
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
  async function wmsAutoExport() {
    try {
      var buf = wmsBuildExportBuffer();
      if (!buf) {
        wmsLogLine('自动导出跳过：当前没有可导出的分段（请先勾选渠道与分段）。', 'warn');
        return;
      }
      var d = new Date();
      var ymd = '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
      var fname = '波次规划' + ymd + '.xlsx';
      var u8 = Uint8Array.from(atob(buf), function (c) { return c.charCodeAt(0); });
      var resp = await fetch('/api/exports?filename=' + encodeURIComponent(fname), {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: u8
      });
      if (!resp.ok) {
        wmsLogLine('自动导出失败：服务返回 ' + resp.status + '。', 'err');
        return;
      }
      /* 日志追加下载链接（同时兼容刷新后从导出清单恢复） */
      wmsRenderExportLinks();
    } catch (e) {
      wmsLogLine('自动导出失败：' + (e && e.message ? e.message : e) + '。', 'err');
    }
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
    wms.available = ok;
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
  }
  async function wmsRestore() {
    try {
      var resp = await fetch('/api/jobs');
      if (resp.ok) {
        var jobs = await resp.json();
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
            wmsRenderState();
          }
        }
      }
    } catch (e) { }
    /* 日志重建完成后才追加当天波次规划导出链接，避免与日志重建竞争（先渲染后追加，防止被清空） */
    wmsRenderExportLinks();
  }

  /* 测试钩子 */
  window.__dshTest = {
    handleFile: handleFile,
    state: state,
    wms: wms,
    wmsSubmit: wmsSubmit,
    wmsSyncWaveRecords: wmsSyncWaveRecords,
    wmsPollOnce: wmsPollOnce,
    wmsRestore: wmsRestore,
    curAnalysis: curAnalysis,
    getAnalysis: getAnalysis,
    buildExportBuffer: wmsBuildExportBuffer,
    buildExportNow: function () {
      return currentExportData();
    }
  };
})();
