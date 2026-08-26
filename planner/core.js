/* =============================================================
 * 波次规划工具 · 核心逻辑（纯计算不依赖 DOM；导出下载函数例外，仅依赖 XLSX 全局）
 * ============================================================= */
'use strict';

/* ---------- 1. 领域常量 ---------- */
var REQUIRED_COLS = [
  'outboundorderno/出库单号',
  'typeofordervariety/订单品种类型',
  'shippingcarrier/物流承运商',
  'package1trackingno./物流跟踪号',
  'sku1sku',
  'totalqtyofsku/总数量'
];
var REQUIRED_COLS_LABEL = {
  'outboundorderno/出库单号': 'Outbound Order No/出库单号',
  'typeofordervariety/订单品种类型': 'Type of order variety/订单品种类型',
  'shippingcarrier/物流承运商': 'Shipping Carrier/物流承运商',
  'package1trackingno./物流跟踪号': 'Package 1 Tracking No./物流跟踪号',
  'sku1sku': 'SKU 1 SKU',
  'totalqtyofsku/总数量': 'Total Qty of SKU/总数量'
};
var SKU_COL_RE = /^sku(\d+)sku$/;
var ABSORB_NAMES = { 1: '关闭', 2: '吸收多件', 3: '全量吸收多件', 4: '全量吸收非爆品' };
/* 第 2 档吸收阈值：已有 SKU 段 ≤70，新增 SKU 段 ≤60（与功能说明文档一致） */
var ABSORB_SAME_SKU_LIMIT = 70;
var ABSORB_NEW_SKU_LIMIT = 60;
var TYPE_ORDER = ['hot', 'paper', 'multi', 'mix'];
var TYPE_LABEL = { hot: '爆品', paper: '单件paper', multi: '多件', mix: '混件' };
var KIND_SHORT = { hot: '爆品', paper: '单件', multi: '多件', mix: '混件' };
var KIND_TYPE = { hot: '单件', paper: '单件paper', multi: '多件', mix: '混件paper' };
var DOMAIN_CHANNELS = ['CBT', 'CBS', 'SwiftX', 'SpeedX', 'YanWen', 'Gofo', 'UPS', 'USPS', 'Fedex', 'UniUni', 'BFE', '未识别'];
var MERGED_CHANNELS = ['CBT', 'CBS', '普通'];
/* 导出展示用分段名：不编号（爆品1 → 爆品；单件paper-2 → 单件paper） */
function segDisplayName(name) {
  return String(name).replace(/-\d+$/, '').replace(/\d+$/, '');
}
var DEFAULT_UNIFIED = { hotLine: 10, capacity: 400, multiSegs: 1, mixSegs: 1, absorb: 1 };
/* 爆品单SKU分段超过多项搜索单次上限（700 行）时按订单数均分拆分；与波次容量设置无关 */
var HOT_SINGLE_SKU_SPLIT_LIMIT = 700;
var CHANNEL_COLORS = {
  'CBT': 'E9E4F8', 'CBS': 'E2F2E1', 'SwiftX': 'DCE9FA', 'SpeedX': 'FCE9DC',
  'YanWen': 'DDF0ED', 'Gofo': 'DCF0F4', 'UPS': 'E5E7F8', 'USPS': 'E6F4E6',
  'Fedex': 'FBE4E8', 'UniUni': 'DDEEFC', 'BFE': 'FBF4DB', '未识别': 'EDEDED', '普通': 'E3EAF2'
};
function colorOf(id) { return CHANNEL_COLORS[id] || 'F0F2F5'; }

/* ---------- 2. 文本与数字清洗 ---------- */
function normHeader(v) {
  return String(v == null ? '' : v).trim().replace(/\s+/g, '').toLowerCase();
}
function text(v) {
  return String(v == null ? '' : v).trim();
}
function parseQty(v) {
  var s = String(v == null ? '' : v).replace(/,/g, '').trim();
  if (s === '') return 0;
  var n = Number(s);
  if (!isFinite(n) || n < 0) return 0;
  return n;
}
/* ---------- 3. 工作表定位与表头识别 ---------- */
function locateSheet(wb) {
  var names = wb.SheetNames || [];
  var exact = null, partial = null;
  for (var i = 0; i < names.length; i++) {
    var n = String(names[i] == null ? '' : names[i]).trim();
    if (exact === null && n === '出库单') exact = i;
    if (partial === null && n.indexOf('出库单') >= 0) partial = i;
  }
  var idx = exact !== null ? exact : partial;
  if (idx === null) throw new Error('工作簿中未找到「出库单」工作表');
  return { sheetName: names[idx], rows: XLSX.utils.sheet_to_json(wb.Sheets[names[idx]], { header: 1, raw: true, defval: '' }) };
}

function mapHeaders(headerRow) {
  var map = {};        // 归一化表头 -> 列索引
  var skuIdx = [];     // 已识别的 SKU n SKU 列（按 n 升序）
  var missing = [];
  (headerRow || []).forEach(function (h, ci) {
    var n = normHeader(h);
    if (n === '') return;
    if (!(n in map)) map[n] = ci;
    var m = SKU_COL_RE.exec(n);
    if (m) skuIdx.push({ n: parseInt(m[1], 10), ci: ci });
  });
  skuIdx.sort(function (a, b) { return a.n - b.n; });
  for (var i = 0; i < REQUIRED_COLS.length; i++) {
    if (!(REQUIRED_COLS[i] in map)) missing.push(REQUIRED_COLS_LABEL[REQUIRED_COLS[i]]);
  }
  if (missing.length) throw new Error('缺少必需列：' + missing.join('、'));
  return { map: map, skuIdx: skuIdx };
}

/* ---------- 4. 物流渠道识别 ---------- */
function trackingChannel(t) {
  var s = String(t == null ? '' : t).trim().toUpperCase();
  if (s.indexOf('SWX') === 0 && s.length === 21) return 'SwiftX';
  if (s.indexOf('SP') === 0) return 'SpeedX';
  if (s.indexOf('YW') === 0 && s.length === 17) return 'YanWen';
  if (s.indexOf('GF') === 0 && s.length === 18) return 'Gofo';
  if (s.indexOf('1Z') === 0 && s.length === 18) return 'UPS';
  if (s.indexOf('9') === 0 && s.length === 22) return 'USPS';
  if (s.length === 12 && /^[0-9]+$/.test(s) && (s.charAt(0) === '3' || s.charAt(0) === '8')) return 'Fedex';
  if (s.indexOf('U') === 0 && s.length === 19) return 'UniUni';
  if (s.indexOf('CK') === 0 && s.length === 17) return 'BFE';
  return '未识别';
}

/* ---------- 5. 数据行 -> 订单记录 ---------- */
function buildRecords(dataRows, headerMap) {
  var records = [];
  var byOrder = new Map(); // 出库单号 -> 订单记录（多行订单合并）
  var qtyMap = {}; // 出库单号 -> 总数量（首次遇到）
  var col = headerMap.map;
  var skuCols = headerMap.skuIdx.map(function (s) { return s.ci; });
  for (var i = 0; i < dataRows.length; i++) {
    var row = dataRows[i] || [];
    var outNo = text(row[col['outboundorderno/出库单号']]);
    var carrier = text(row[col['shippingcarrier/物流承运商']]);
    var type = text(row[col['typeofordervariety/订单品种类型']]);
    var tracking = text(row[col['package1trackingno./物流跟踪号']]);
    var skus = skuCols.map(function (ci) { return text(row[ci]); });
    var qty = parseQty(row[col['totalqtyofsku/总数量']]);
    var allEmpty = [outNo, carrier, type, tracking].concat(skus).every(function (v) { return v === ''; });
    if (allEmpty) continue;
    var carrierUp = carrier.toUpperCase();
    var orderNo = outNo !== '' ? outNo : ('第' + (i + 2) + '行');
    if (!(orderNo in qtyMap)) qtyMap[orderNo] = qty;
    /* 同一出库单号跨多行列出 SKU 时合并为一条订单记录，防止订单被拆进不同分段 */
    var rec = byOrder.get(orderNo);
    if (!rec) {
      rec = {
        excelRow: i + 2,
        orderNo: orderNo,
        type: type,
        carrier: carrierUp,
        sku1: '',
        skus: [],
        channelId: carrierUp === 'CBT' ? 'CBT' : (carrierUp === 'CBS' ? 'CBS' : trackingChannel(tracking)),
        carrierClass: carrierUp === 'CBT' ? 'CBT订单' : (carrierUp === 'CBS' ? 'CBS订单' : '普通订单'),
        qty: qty
      };
      byOrder.set(orderNo, rec);
      records.push(rec);
    }
    skus.forEach(function (s) {
      if (s !== '' && rec.skus.indexOf(s) === -1) {
        rec.skus.push(s);
        if (!rec.sku1) rec.sku1 = s;  // 首个非空 SKU
      }
    });
  }
  return { records: records, qtyMap: qtyMap };
}

/* ---------- 6. 连续均衡分段（Linear Partition，分治优化 DP） ---------- */
/* 输入 items 的权重取 item.count；返回 k 个子序列（保持顺序，尽量使最大段和最轻）。
   k > items.length 时，空段补在末尾。 */
function linearPartition(items, k) {
  var n = items.length;
  var result = [];
  if (n === 0) { for (var e = 0; e < k; e++) result.push([]); return result; }
  var jmax = Math.min(k, n);
  var w = items.map(function (x) { return x.count; });
  var pref = new Float64Array(n + 1);
  for (var i = 0; i < n; i++) pref[i + 1] = pref[i] + w[i];
  var INF = 1e18;
  var dp = [], opt = [];
  for (var r = 0; r <= n; r++) {
    dp.push(new Float64Array(jmax + 1).fill(INF));
    opt.push(new Int32Array(jmax + 1));
  }
  dp[0][0] = 0;
  var j;
  var solve;
  solve = function (l, r, ml, mr) {
    if (l > r) return;
    var mid = (l + r) >> 1;
    var lo = Math.max(ml, j - 1, 0);
    var hi = Math.min(mr, mid - 1);
    var best = INF, bestM = -1;
    for (var m = lo; m <= hi; m++) {
      if (dp[m][j - 1] >= INF) continue;
      var val = Math.max(dp[m][j - 1], pref[mid] - pref[m]);
      if (val < best) { best = val; bestM = m; }
    }
    dp[mid][j] = best;
    opt[mid][j] = bestM;
    solve(l, mid - 1, ml, bestM);
    solve(mid + 1, r, bestM, mr);
  };
  for (j = 1; j <= jmax; j++) solve(j, n, 0, n);
  var ii = n, jj = jmax;
  while (jj > 0) {
    var mm = opt[ii][jj];
    result.unshift(items.slice(mm, ii));
    ii = mm; jj--;
  }
  while (result.length < k) result.push([]);
  return result;
}

/* 波次容量分段：超大 SKU（count > W）单独成段（允许超容量），
   其余按容量执行连续均衡分段（保持降序顺序）。 */
function partitionByCapacity(items, W) {
  var pieces = [];
  var run = [];
  var flushRun = function () {
    if (!run.length) return;
    var total = 0;
    for (var i = 0; i < run.length; i++) total += run[i].count;
    var k = Math.max(1, Math.ceil(total / W));
    if (k > run.length) k = run.length;
    for (;;) {
      var parts = linearPartition(run, k);
      var bad = parts.some(function (p) {
        if (p.length <= 1) return false;
        var s = 0;
        for (var i = 0; i < p.length; i++) s += p[i].count;
        return s > W;
      });
      if (!bad || k >= run.length) { pieces.push.apply(pieces, parts); break; }
      k++;
    }
    run = [];
  };
  for (var i = 0; i < items.length; i++) {
    if (items[i].count > W) { flushRun(); pieces.push([items[i]]); }
    else run.push(items[i]);
  }
  flushRun();
  return pieces;
}

/* ---------- 7. 混件连通组件 ---------- */
function buildComponents(groups) {
  var n = groups.length;
  var parent = [];
  for (var i = 0; i < n; i++) parent.push(i);
  function find(x) {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  }
  function union(a, b) {
    var ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  var skuToGroups = new Map();
  groups.forEach(function (g, gi) {
    for (var s = 0; s < g.set.length; s++) {
      var sku = g.set[s];
      var arr = skuToGroups.get(sku);
      if (!arr) { arr = []; skuToGroups.set(sku, arr); }
      arr.push(gi);
    }
  });
  skuToGroups.forEach(function (arr) {
    for (var i = 1; i < arr.length; i++) union(arr[0], arr[i]);
  });
  var compMap = new Map();
  groups.forEach(function (g, gi) {
    var root = find(gi);
    var comp = compMap.get(root);
    if (!comp) {
      comp = { groups: [], skuSet: new Set(), orderNos: new Set(), skuCounts: new Map(), count: 0 };
      compMap.set(root, comp);
    }
    comp.groups.push(g);
    for (var s = 0; s < g.set.length; s++) comp.skuSet.add(g.set[s]);
    for (var o = 0; o < g.orderNos.length; o++) comp.orderNos.add(g.orderNos[o]);
    for (var s2 = 0; s2 < g.set.length; s2++) {
      var sk = g.set[s2];
      comp.skuCounts.set(sk, (comp.skuCounts.get(sk) || 0) + g.count);
    }
    comp.count += g.count;
  });
  var comps = [];
  compMap.forEach(function (c) {
    c.skus = Array.from(c.skuSet).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
    comps.push(c);
  });
  comps.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.skus.join('\u0001').localeCompare(b.skus.join('\u0001'), 'zh');
  });
  return comps;
}

/* 离散均衡分配：组件整体放入当前订单数最少的目标段，并列取最前。 */
function discreteAllocate(components, N) {
  var slots = [];
  for (var i = 0; i < N; i++) {
    slots.push({ index: i, count: 0, skuSet: new Set(), orderNos: new Set(), skuCounts: new Map(), comps: [] });
  }
  components.forEach(function (comp) {
    var best = null;
    for (var i = 0; i < slots.length; i++) {
      if (best === null || slots[i].count < best.count) best = slots[i];
    }
    best.count += comp.count;
    comp.skuSet.forEach(function (sk) { best.skuSet.add(sk); });
    comp.orderNos.forEach(function (o) { best.orderNos.add(o); });
    comp.skuCounts.forEach(function (c, sk) { best.skuCounts.set(sk, (best.skuCounts.get(sk) || 0) + c); });
    best.comps.push(comp);
  });
  return slots;
}

/* ---------- 8. 最终分段 ---------- */
function finalizeSeg(kind, name, orderNos, skuPool, qtyMap) {
  var pickQty = 0;
  for (var i = 0; i < orderNos.length; i++) pickQty += (qtyMap[orderNos[i]] || 0);
  return {
    kind: kind, name: name, orderNos: orderNos, orderCount: orderNos.length,
    pickQty: pickQty, skuPool: skuPool, skuCount: skuPool.length
  };
}

function segFromItems(kind, prefix, parts, qtyMap) {
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i];
    if (!part.length) continue;
    var orderNos = [], seen = new Set(), pool = [];
    for (var t = 0; t < part.length; t++) {
      var it = part[t];
      pool.push({ sku: it.sku, count: it.count });
      for (var o = 0; o < it.orderNos.length; o++) {
        if (!seen.has(it.orderNos[o])) { seen.add(it.orderNos[o]); orderNos.push(it.orderNos[o]); }
      }
    }
    out.push(finalizeSeg(kind, prefix + (i + 1), orderNos, pool, qtyMap));
  }
  return out;
}

/* 爆品分段后处理：仅当分段只有一个 SKU 且订单数超过多项搜索单次上限（700）时，
   把订单列表均分成若干体量相当、每段 ≤700 单的分段（单SKU爆品段在容量分段中
   是原子单位，不会因容量拆分，故这里单独处理；多SKU分段保持不动）。
   全部爆品分段按顺序重新编号，保证分段名连续。 */
function splitOversizedHotSegments(hotSegs, qtyMap) {
  var out = [];
  var segNo = 0;
  for (var i = 0; i < hotSegs.length; i++) {
    var seg = hotSegs[i];
    var k = (seg.skuCount === 1 && seg.orderCount > HOT_SINGLE_SKU_SPLIT_LIMIT)
      ? Math.ceil(seg.orderCount / HOT_SINGLE_SKU_SPLIT_LIMIT) : 1;
    var base = Math.floor(seg.orderCount / k);
    var rem = seg.orderCount % k;
    var pos = 0;
    for (var c = 0; c < k; c++) {
      var size = base + (c < rem ? 1 : 0);
      var chunk = seg.orderNos.slice(pos, pos + size);
      pos += size;
      segNo++;
      out.push(finalizeSeg('hot', '爆品' + segNo, chunk, seg.skuPool, qtyMap));
    }
  }
  return out;
}

function slotsToMixSegs(slots, qtyMap) {
  var out = [];
  for (var i = 0; i < slots.length; i++) {
    var s = slots[i];
    if (s.orderNos.size === 0) continue;
    var pool = [];
    s.skuCounts.forEach(function (c, sku) { pool.push({ sku: sku, count: c }); });
    pool.sort(function (a, b) { return b.count - a.count || a.sku.localeCompare(b.sku, 'zh'); });
    out.push(finalizeSeg('mix', '混件' + (s.index + 1), Array.from(s.orderNos), pool, qtyMap));
  }
  return out;
}

/* ---------- 9. 单渠道分析 ---------- */
function analyzeChannel(id, records, qtyMap, p) {
  var singleMap = new Map(), multiMap = new Map(), mixGroups = new Map();
  var singleCount = 0, multiCount = 0, mixCount = 0;
  records.forEach(function (r) {
    if (r.type === '单品单件') {
      singleCount++;
      var sku = r.sku1 !== '' ? r.sku1 : '(空SKU)';
      var g = singleMap.get(sku);
      if (!g) { g = { sku: sku, count: 0, orderNos: new Set() }; singleMap.set(sku, g); }
      g.count++;
      g.orderNos.add(r.orderNo);
    } else if (r.type === '单品多件') {
      multiCount++;
      var sku2 = r.sku1 !== '' ? r.sku1 : '(空SKU)';
      var g2 = multiMap.get(sku2);
      if (!g2) { g2 = { sku: sku2, orderNos: new Set() }; multiMap.set(sku2, g2); }
      g2.orderNos.add(r.orderNo);
    } else {
      /* 多品混合及任何未识别的品种类型：全部进入混件池，绝不丢单 */
      mixCount++;
      var set = [], seen = new Set();
      for (var s = 0; s < r.skus.length; s++) {
        if (r.skus[s] !== '' && !seen.has(r.skus[s])) { seen.add(r.skus[s]); set.push(r.skus[s]); }
      }
      set.sort(function (a, b) { return a.localeCompare(b, 'zh'); });
      if (!set.length) set = ['(空SKU)'];
      var key = set.join('\u0001');
      var g3 = mixGroups.get(key);
      if (!g3) { g3 = { set: set, key: key, orderNos: new Set() }; mixGroups.set(key, g3); }
      g3.orderNos.add(r.orderNo);
    }
  });

  var cmpSku = function (a, b) { return b.count - a.count || a.sku.localeCompare(b.sku, 'zh'); };
  var singleSeq = [];
  singleMap.forEach(function (g) { singleSeq.push({ sku: g.sku, count: g.count, orderNos: Array.from(g.orderNos) }); });
  singleSeq.sort(cmpSku);
  var multiSeq = [];
  multiMap.forEach(function (g) { multiSeq.push({ sku: g.sku, count: g.orderNos.size, orderNos: Array.from(g.orderNos) }); });
  multiSeq.sort(cmpSku);
  var mixSeq = [];
  mixGroups.forEach(function (g) { mixSeq.push({ set: g.set, key: g.key, count: g.orderNos.size, orderNos: Array.from(g.orderNos) }); });
  mixSeq.sort(function (a, b) {
    if (b.count !== a.count) return b.count - a.count;
    return a.set.join('\u0001').localeCompare(b.set.join('\u0001'), 'zh');
  });

  var hotSeq = singleSeq.filter(function (g) { return g.count >= p.hotLine; });
  var paperSeq = singleSeq.filter(function (g) { return g.count < p.hotLine; });
  var hotOrderCount = 0, paperOrderCount = 0;
  hotSeq.forEach(function (g) { hotOrderCount += g.count; });
  paperSeq.forEach(function (g) { paperOrderCount += g.count; });

  /* 爆品 / 单件paper 容量分段 */
  var hotSegs = splitOversizedHotSegments(
    segFromItems('hot', '爆品', partitionByCapacity(hotSeq, p.capacity), qtyMap),
    qtyMap
  );
  var paperSegs = segFromItems('paper', '单件paper-', partitionByCapacity(paperSeq, p.capacity), qtyMap);

  /* 原始混件组件与离散分段 */
  var mixComponents = buildComponents(mixSeq);
  var slots = discreteAllocate(mixComponents, p.mixSegs);
  var rawGroupSegMap = new Map(); // 原始混件集合对象 -> 最终分段名（仅 1/2 档由 slots 构建；3/4 档重建）
  var mixSeqExtra = []; // 被吸收/重建进混件段的 SKU（sku, count, segName），供混件SKU序列补全
  var singleSegMap = new Map(); // 单品单件 SKU -> 最终分段名
  var multiSegMap = new Map();  // 多件 SKU -> 最终分段名
  hotSegs.forEach(function (seg) { seg.skuPool.forEach(function (sp) { singleSegMap.set(sp.sku, seg.name); }); });
  paperSegs.forEach(function (seg) { seg.skuPool.forEach(function (sp) { singleSegMap.set(sp.sku, seg.name); }); });

  var finalMixSegs, finalMultiSegs, finalPaperSegs;

  function absorbIntoSlot(s, it) {
    s.count += it.count;
    s.skuSet.add(it.sku);
    for (var o = 0; o < it.orderNos.length; o++) s.orderNos.add(it.orderNos[o]);
    s.skuCounts.set(it.sku, (s.skuCounts.get(it.sku) || 0) + it.count);
  }

  if (p.absorb === 1 || p.absorb === 2) {
    slots.forEach(function (s) {
      for (var ci = 0; ci < s.comps.length; ci++) {
        var comp = s.comps[ci];
        for (var gi = 0; gi < comp.groups.length; gi++) {
          rawGroupSegMap.set(comp.groups[gi], '混件' + (s.index + 1));
        }
      }
    });
  }
  if (p.absorb === 1) {
    finalPaperSegs = paperSegs;
    finalMultiSegs = segFromItems('multi', '多件', linearPartition(multiSeq, p.multiSegs), qtyMap);
    finalMixSegs = slotsToMixSegs(slots, qtyMap);
  } else if (p.absorb === 2) {
    finalPaperSegs = paperSegs;
    var mixSlots = slots.filter(function (s) { return s.orderNos.size > 0; });
    var absorbed = new Set();
    if (mixSlots.length) {
      /* 第一阶段：已有 SKU，吸收后不超过 70 */
      for (var i = multiSeq.length - 1; i >= 0; i--) {
        var it = multiSeq[i];
        var target = null;
        for (var si = 0; si < mixSlots.length; si++) {
          if (mixSlots[si].skuSet.has(it.sku)) { target = mixSlots[si]; break; }
        }
        if (!target) continue;
        if (target.count + it.count <= ABSORB_SAME_SKU_LIMIT) {
          absorbIntoSlot(target, it);
          absorbed.add(it.sku);
          mixSeqExtra.push({ sku: it.sku, count: it.count, segName: '混件' + (target.index + 1) });
        }
      }
      /* 第二阶段：新增 SKU，吸收后不超过 60，选当前最轻的非空分段 */
      for (var i2 = multiSeq.length - 1; i2 >= 0; i2--) {
        var it2 = multiSeq[i2];
        if (absorbed.has(it2.sku)) continue;
        var exists = mixSlots.some(function (s) { return s.skuSet.has(it2.sku); });
        if (exists) continue;
        var best = null;
        for (var si2 = 0; si2 < mixSlots.length; si2++) {
          var s2 = mixSlots[si2];
          if (s2.count + it2.count <= ABSORB_NEW_SKU_LIMIT && (best === null || s2.count < best.count)) best = s2;
        }
        if (best) {
          absorbIntoSlot(best, it2);
          absorbed.add(it2.sku);
          mixSeqExtra.push({ sku: it2.sku, count: it2.count, segName: '混件' + (best.index + 1) });
        }
      }
    }
    var remaining = multiSeq.filter(function (it) { return !absorbed.has(it.sku); });
    finalMultiSegs = segFromItems('multi', '多件', linearPartition(remaining, p.multiSegs), qtyMap);
    finalMixSegs = slotsToMixSegs(mixSlots, qtyMap);
  } else {
    /* 第 3 / 4 档：重建混件订单池 */
    var poolGroups = mixSeq.slice();
    multiSeq.forEach(function (it) { poolGroups.push({ set: [it.sku], orderNos: it.orderNos, count: it.count }); });
    if (p.absorb === 4) {
      paperSeq.forEach(function (it) { poolGroups.push({ set: [it.sku], orderNos: it.orderNos, count: it.count }); });
    }
    var comps2 = buildComponents(poolGroups);
    var slots2 = discreteAllocate(comps2, p.mixSegs);
    var skuToSeg = new Map();
    slots2.forEach(function (s) {
      var name = '混件' + (s.index + 1);
      s.skuSet.forEach(function (sk) { if (!skuToSeg.has(sk)) skuToSeg.set(sk, name); });
      for (var ci = 0; ci < s.comps.length; ci++) {
        for (var gi = 0; gi < s.comps[ci].groups.length; gi++) {
          var grp = s.comps[ci].groups[gi];
          if (mixSeq.indexOf(grp) >= 0) rawGroupSegMap.set(grp, name);
        }
      }
    });
    finalMixSegs = slotsToMixSegs(slots2, qtyMap);
    finalMultiSegs = [];
    finalPaperSegs = p.absorb === 4 ? [] : paperSegs;
    multiSeq.forEach(function (it) {
      var sn = skuToSeg.get(it.sku);
      if (sn) mixSeqExtra.push({ sku: it.sku, count: it.count, segName: sn });
    });
    if (p.absorb === 4) {
      paperSeq.forEach(function (it) {
        var sn2 = skuToSeg.get(it.sku) || '';
        singleSegMap.set(it.sku, sn2);
        if (sn2) mixSeqExtra.push({ sku: it.sku, count: it.count, segName: sn2 });
      });
    }
  }

  finalMultiSegs.forEach(function (seg) { seg.skuPool.forEach(function (sp) { multiSegMap.set(sp.sku, seg.name); }); });

  var segments = hotSegs.concat(finalPaperSegs, finalMultiSegs, finalMixSegs);
  var segByName = new Map();
  segments.forEach(function (s) { segByName.set(s.name, s); });
  var byType = { hot: hotSegs, paper: finalPaperSegs, multi: finalMultiSegs, mix: finalMixSegs };

  return {
    id: id, name: id,
    total: records.length,
    singleCount: singleCount, multiCount: multiCount, mixCount: mixCount,
    params: { hotLine: p.hotLine, capacity: p.capacity, multiSegs: p.multiSegs, mixSegs: p.mixSegs, absorb: p.absorb },
    hotSeq: hotSeq, paperSeq: paperSeq, singleSeq: singleSeq, multiSeq: multiSeq, mixSeq: mixSeq,
    hotSkuCount: hotSeq.length, hotOrderCount: hotOrderCount,
    paperSkuCount: paperSeq.length, paperOrderCount: paperOrderCount,
    segments: segments, byType: byType, segByName: segByName,
    singleSegMap: singleSegMap, multiSegMap: multiSegMap, rawGroupSegMap: rawGroupSegMap,
    mixSeqExtra: mixSeqExtra
  };
}

/* ---------- 10. 渠道默认排序 ---------- */
function sortByDefault(chans) {
  chans.sort(function (a, b) {
    if (a.id === '未识别' && b.id !== '未识别') return 1;
    if (b.id === '未识别' && a.id !== '未识别') return -1;
    if (b.total !== a.total) return b.total - a.total;
    return a.id.localeCompare(b.id, 'zh');
  });
  return chans;
}

/* ---------- 11. 分类 SKU 序列（固定口径） ---------- */
function buildClassSeq(records) {
  var classes = { '普通订单': new Map(), 'CBT订单': new Map(), 'CBS订单': new Map() };
  records.forEach(function (r) {
    if (r.type !== '单品单件') return;
    var m = classes[r.carrierClass];
    var sku = r.sku1 !== '' ? r.sku1 : '(空SKU)';
    m.set(sku, (m.get(sku) || 0) + 1);
  });
  var out = [];
  ['普通订单', 'CBT订单', 'CBS订单'].forEach(function (cls) {
    var seq = [];
    classes[cls].forEach(function (c, sku) { seq.push({ sku: sku, count: c }); });
    seq.sort(function (a, b) { return b.count - a.count || a.sku.localeCompare(b.sku, 'zh'); });
    out.push({ name: cls, id: '', seq: seq });
  });
  return out;
}

/* ---------- 12. 全量分析 ---------- */
function analyze(records, qtyMap, mode, paramsFor) {
  var resolver = typeof paramsFor === 'function' ? paramsFor : function (id) {
    return (paramsFor && paramsFor[id]) || {
      hotLine: DEFAULT_UNIFIED.hotLine, capacity: DEFAULT_UNIFIED.capacity,
      multiSegs: DEFAULT_UNIFIED.multiSegs, mixSegs: DEFAULT_UNIFIED.mixSegs, absorb: DEFAULT_UNIFIED.absorb
    };
  };
  var byChan = new Map();
  records.forEach(function (r) {
    var id = mode === 'merged' ? (r.carrier === 'CBT' ? 'CBT' : (r.carrier === 'CBS' ? 'CBS' : '普通')) : r.channelId;
    var arr = byChan.get(id);
    if (!arr) { arr = []; byChan.set(id, arr); }
    arr.push(r);
  });
  /* 空渠道（订单 0）也列入，与参照一致 */
  (mode === 'merged' ? MERGED_CHANNELS : DOMAIN_CHANNELS).forEach(function (id) {
    if (!byChan.has(id)) byChan.set(id, []);
  });
  var chans = [];
  byChan.forEach(function (recs, id) {
    chans.push(analyzeChannel(id, recs, qtyMap, resolver(id)));
  });
  sortByDefault(chans);
  var totals = { all: records.length, single: 0, multi: 0, mix: 0 };
  chans.forEach(function (c) { totals.single += c.singleCount; totals.multi += c.multiCount; totals.mix += c.mixCount; });
  var waveStats = { hot: { waves: 0, orders: 0 }, paper: { waves: 0, orders: 0 }, multi: { waves: 0, orders: 0 }, mix: { waves: 0, orders: 0 } };
  chans.forEach(function (c) {
    TYPE_ORDER.forEach(function (t) {
      c.byType[t].forEach(function (s) { waveStats[t].waves++; waveStats[t].orders += s.orderCount; });
    });
  });
  return { mode: mode, channels: chans, totals: totals, waveStats: waveStats, classSeq: buildClassSeq(records) };
}

/* =============================================================
 * 13. 导出：8 个工作表
 * ============================================================= */
function collectBlocks(channels, selected, segSelected) {
  var blocks = [];
  channels.forEach(function (ch) {
    if (!selected.has(ch.id)) return;
    var segs = ch.segments.filter(function (s) { return segSelected.has(ch.id + '|' + s.name); });
    if (segs.length) blocks.push({ ch: ch, segs: segs });
  });
  return blocks;
}
function segInfoText(seg) {
  return segDisplayName(seg.name) + '\nSKU数量：' + seg.skuCount + '\n订单数量：' + seg.orderCount + '\n拣货数量：' + seg.pickQty;
}
function fillOf(id) {
  return { patternType: 'solid', fgColor: { rgb: 'FF' + colorOf(id) } };
}

/* ---- 工作表一：分组结果 ---- */
function sheetGroupResult(blocks) {
  var cols = [], blockRanges = [];
  blocks.forEach(function (b, bi) {
    var from = cols.length;
    b.segs.forEach(function (seg) { cols.push({ kind: 'seg', ch: b.ch, seg: seg }); });
    blockRanges.push({ ch: b.ch, from: from, to: cols.length - 1 });
    if (bi < blocks.length - 1) cols.push({ kind: 'gap' });
  });
  var maxOrders = 0;
  cols.forEach(function (c) { if (c.kind === 'seg' && c.seg.orderNos.length > maxOrders) maxOrders = c.seg.orderNos.length; });
  var aoa = [], merges = [], styles = [];
  var r0 = cols.map(function () { return ''; });
  blockRanges.forEach(function (br) {
    r0[br.from] = br.ch.name;
    merges.push({ s: { r: 0, c: br.from }, e: { r: 0, c: br.to } });
  });
  aoa.push(r0);
  aoa.push(cols.map(function (c) { return c.kind === 'seg' ? segInfoText(c.seg) : ''; }));
  aoa.push(cols.map(function (c) {
    return c.kind === 'seg' ? 'start\n' + c.seg.orderNos.join('\n') + '\nend' : '';
  }));
  for (var i = 0; i < maxOrders; i++) {
    aoa.push(cols.map(function (c) { return c.kind === 'seg' ? (i < c.seg.orderNos.length ? c.seg.orderNos[i] : '') : ''; }));
  }
  cols.forEach(function (c, ci) {
    if (c.kind === 'gap') {
      for (var r = 0; r < aoa.length; r++) styles.push({ r: r, c: ci, s: { border: {} } });
      return;
    }
    var fill = fillOf(c.ch.id);
    styles.push({ r: 0, c: ci, s: { fill: fill, font: { sz: 16, bold: true }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } });
    styles.push({ r: 1, c: ci, s: { fill: fill, font: { sz: 16 }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } });
    styles.push({ r: 2, c: ci, s: { fill: fill, alignment: { horizontal: 'left', vertical: 'top', wrapText: true } } });
    for (var r2 = 3; r2 < aoa.length; r2++) styles.push({ r: r2, c: ci, s: { fill: fill, alignment: { horizontal: 'left', vertical: 'center' } } });
  });
  return {
    name: '分组结果',
    aoa: aoa, merges: merges, styles: styles,
    rows: [{ hpt: 28 }, { hpt: 92 }, { hpt: 75 }],
    cols: cols.map(function (c) { return { wch: c.kind === 'gap' ? 2 : 18 }; })
  };
}

/* ---- 工作表二：分组结果SKU池 ---- */
function sheetGroupSkuPool(blocks) {
  var cols = [], blockRanges = [], segRanges = [];
  blocks.forEach(function (b, bi) {
    var from = cols.length;
    b.segs.forEach(function (seg) {
      var s = cols.length;
      cols.push({ kind: 'sku', seg: seg }, { kind: 'qty', seg: seg });
      segRanges.push({ seg: seg, from: s, to: s + 1 });
    });
    blockRanges.push({ ch: b.ch, from: from, to: cols.length - 1 });
    if (bi < blocks.length - 1) cols.push({ kind: 'gap' });
  });
  var maxPool = 0;
  cols.forEach(function (c) { if (c.kind !== 'gap' && c.seg.skuPool.length > maxPool) maxPool = c.seg.skuPool.length; });
  var aoa = [], merges = [], styles = [];
  var r0 = cols.map(function () { return ''; });
  blockRanges.forEach(function (br) {
    r0[br.from] = br.ch.name;
    merges.push({ s: { r: 0, c: br.from }, e: { r: 0, c: br.to } });
  });
  aoa.push(r0);
  var r1 = cols.map(function () { return ''; });
  segRanges.forEach(function (sr) {
    r1[sr.from] = segInfoText(sr.seg);
    merges.push({ s: { r: 1, c: sr.from }, e: { r: 1, c: sr.to } });
  });
  aoa.push(r1);
  aoa.push(cols.map(function (c) { return c.kind === 'sku' ? 'SKU' : (c.kind === 'qty' ? '数量' : ''); }));
  for (var i = 0; i < maxPool; i++) {
    aoa.push(cols.map(function (c) {
      if (c.kind === 'sku') return i < c.seg.skuPool.length ? c.seg.skuPool[i].sku : '';
      if (c.kind === 'qty') return i < c.seg.skuPool.length ? c.seg.skuPool[i].count : '';
      return '';
    }));
  }
  var ownerBySeg = new Map();
  blocks.forEach(function (b) {
    b.segs.forEach(function (seg) { ownerBySeg.set(seg, b.ch); });
  });
  cols.forEach(function (c, ci) {
    if (c.kind === 'gap') {
      for (var r = 0; r < aoa.length; r++) styles.push({ r: r, c: ci, s: { border: {} } });
      return;
    }
    var fill = fillOf(ownerBySeg.get(c.seg).id);
    styles.push({ r: 0, c: ci, s: { fill: fill, font: { sz: 16, bold: true }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } });
    styles.push({ r: 1, c: ci, s: { fill: fill, font: { sz: 16 }, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } });
    styles.push({ r: 2, c: ci, s: { fill: fill, font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } } });
    for (var r2 = 3; r2 < aoa.length; r2++) styles.push({ r: r2, c: ci, s: { fill: fill, alignment: { horizontal: 'left', vertical: 'center' } } });
  });
  return {
    name: '分组结果SKU池',
    aoa: aoa, merges: merges, styles: styles,
    rows: [{ hpt: 28 }, { hpt: 92 }],
    cols: cols.map(function (c) { return { wch: c.kind === 'gap' ? 2 : (c.kind === 'qty' ? 8 : 20) }; })
  };
}

/* ---- 工作表三：波次表 ---- */
function sheetWaveTable(blocks, waveNos) {
  var header = ['渠道类型', '姓名', '波次号', '类型', '分发时间', 'SKU数量', '应拣单数', '应拣件数', '结束时间'];
  var aoa = [header.slice()], styles = [];
  for (var c = 0; c < 9; c++) styles.push({ r: 0, c: c, s: { font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } } });
  blocks.forEach(function (b, bi) {
    b.segs.forEach(function (seg) {
      var r = aoa.length;
      var waveNo = waveNos ? (waveNos.get(b.ch.id + '|' + seg.name) || '') : '';
      aoa.push([
        b.ch.name + KIND_SHORT[seg.kind], '', waveNo, KIND_TYPE[seg.kind], '',
        seg.skuCount, seg.orderCount, seg.pickQty, ''
      ]);
      /* 数据行按渠道着色，颜色与分组结果一致；表头/分隔行不填充 */
      var fill = fillOf(b.ch.id);
      for (var cc = 0; cc < 9; cc++) {
        var align = cc === 0 ? 'left' : (cc >= 5 && cc <= 7 ? 'center' : 'left');
        styles.push({ r: r, c: cc, s: { fill: fill, alignment: { horizontal: align, vertical: 'center' } } });
      }
    });
    if (bi < blocks.length - 1) {
      var sr = aoa.length;
      aoa.push(['---', '---', '---', '---', '---', '---', '---', '---', '---']);
      for (var sc = 0; sc < 9; sc++) {
        styles.push({ r: sr, c: sc, s: { alignment: { horizontal: 'center', vertical: 'center' } } });
      }
    }
  });
  return {
    name: '波次表',
    aoa: aoa, styles: styles,
    cols: [14, 12, 16, 11, 12, 10, 10, 10, 12].map(function (w) { return { wch: w }; }),
    autofilter: 'A1:I' + aoa.length
  };
}

/* ---- 工作表四：渠道统计 ---- */
function sheetChannelStats(channels, selected, segSelected) {
  var selChans = channels.filter(function (c) { return selected.has(c.id); });
  var rows = [];
  function push(label, fn) {
    rows.push([label].concat(selChans.map(fn)));
  }
  push('订单总数', function (c) { return c.total; });
  push('单品单件', function (c) { return c.singleCount; });
  push('多件', function (c) { return c.multiCount; });
  push('混件', function (c) { return c.mixCount; });
  push('爆品线', function (c) { return c.params.hotLine; });
  push('波次容量', function (c) { return c.params.capacity; });
  push('多件分段数', function (c) { return c.params.multiSegs; });
  push('混件分段数', function (c) { return c.params.mixSegs; });
  push('混件吸收', function (c) { return c.params.absorb + '-' + ABSORB_NAMES[c.params.absorb]; });
  push('爆品SKU数', function (c) { return c.hotSkuCount; });
  push('爆品订单数', function (c) { return c.hotOrderCount; });
  push('非爆品SKU数', function (c) { return c.paperSkuCount; });
  push('非爆品订单数', function (c) { return c.paperOrderCount; });
  TYPE_ORDER.forEach(function (t) {
    var hasAny = selChans.some(function (c) {
      return c.byType[t].some(function (s) { return segSelected.has(c.id + '|' + s.name); });
    });
    if (!hasAny) return;
    push(TYPE_LABEL[t], function (c) {
      return c.byType[t].filter(function (s) { return segSelected.has(c.id + '|' + s.name); })
        .map(function (s) { return segDisplayName(s.name) + '（订单 ' + s.orderCount + '，SKU ' + s.skuCount + '）'; })
        .join('\n');
    });
  });
  var aoa = [['统计项目'].concat(selChans.map(function (c) { return c.name; }))].concat(rows);
  var styles = [];
  for (var cc = 0; cc < aoa[0].length; cc++) {
    styles.push({ r: 0, c: cc, s: { fill: { patternType: 'solid', fgColor: { rgb: 'FFF2F5FA' } }, font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } } });
  }
  selChans.forEach(function (c, i) {
    var fill = fillOf(c.id);
    for (var r = 1; r < aoa.length; r++) {
      styles.push({ r: r, c: i + 1, s: { fill: fill, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } });
    }
  });
  for (var r2 = 1; r2 < aoa.length; r2++) {
    styles.push({ r: r2, c: 0, s: { font: { bold: true }, alignment: { horizontal: 'left', vertical: 'center' } } });
  }
  var widths = [{ wch: 12 }];
  selChans.forEach(function () { widths.push({ wch: 24 }); });
  return { name: '渠道统计', aoa: aoa, styles: styles, cols: widths };
}

/* ---- 工作表五/六/七 骨架 ---- */
function seqSheetBase(name, selChans, colCount, headers) {
  var cols = [], blockRanges = [];
  selChans.forEach(function (ch) {
    var from = cols.length;
    for (var i = 0; i < colCount; i++) cols.push({ ch: ch });
    blockRanges.push({ ch: ch, from: from, to: cols.length - 1 });
  });
  var aoa = [], merges = [], styles = [];
  var r0 = cols.map(function () { return ''; });
  blockRanges.forEach(function (br) {
    r0[br.from] = br.ch.name;
    merges.push({ s: { r: 0, c: br.from }, e: { r: 0, c: br.to } });
  });
  aoa.push(r0);
  var r1 = [];
  selChans.forEach(function () { r1 = r1.concat(headers); });
  aoa.push(r1);
  cols.forEach(function (c, ci) {
    var fill = fillOf(c.ch.id);
    styles.push({ r: 0, c: ci, s: { fill: fill, font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } } });
    styles.push({ r: 1, c: ci, s: { fill: fill, font: { bold: true }, alignment: { horizontal: 'center', vertical: 'center' } } });
  });
  function addRows(rowsByCh) {
    var maxRows = 0;
    rowsByCh.forEach(function (rows) { if (rows.length > maxRows) maxRows = rows.length; });
    for (var i = 0; i < maxRows; i++) {
      var row = [];
      rowsByCh.forEach(function (rows) {
        row = row.concat(rows[i] || new Array(colCount).fill(''));
      });
      aoa.push(row);
    }
    var colFills = cols.map(function (c) { return fillOf(c.ch.id); });
    for (var r = 2; r < aoa.length; r++) {
      for (var cc = 0; cc < cols.length; cc++) {
        styles.push({ r: r, c: cc, s: { fill: colFills[cc], alignment: { horizontal: 'center', vertical: 'center', wrapText: true } } });
      }
    }
  }
  return { name: name, aoa: aoa, merges: merges, styles: styles, addRows: addRows };
}

/* ---- 工作表五：单件SKU序列 ---- */
function sheetSingleSeq(channels, selected, segSelected) {
  var selChans = channels.filter(function (c) { return selected.has(c.id); });
  var sheet = seqSheetBase('单件SKU序列', selChans, 5, ['排序', 'SKU', '出现数量', '分段', '分段总订单数']);
  var rowsByCh = selChans.map(function (ch) {
    var rows = [], rank = 1;
    ch.singleSeq.forEach(function (it) {
      var segName = ch.singleSegMap.get(it.sku);
      if (!segName) return;
      if (!segSelected.has(ch.id + '|' + segName)) return;
      var seg = ch.segByName.get(segName);
      rows.push([rank++, it.sku, it.count, segDisplayName(segName), seg ? seg.orderCount : '']);
    });
    return rows;
  });
  sheet.addRows(rowsByCh);
  sheet.cols = [{ wch: 6 }, { wch: 24 }, { wch: 10 }, { wch: 16 }, { wch: 14 }];
  return sheet;
}

/* ---- 工作表六：多件SKU序列 ---- */
function sheetMultiSeq(channels, selected, segSelected) {
  var selChans = channels.filter(function (c) { return selected.has(c.id); });
  var sheet = seqSheetBase('多件SKU序列', selChans, 3, ['排序', 'SKU', '订单数量']);
  var rowsByCh = selChans.map(function (ch) {
    var rows = [], rank = 1;
    ch.multiSeq.forEach(function (it) {
      var segName = ch.multiSegMap.get(it.sku);
      if (!segName) return;
      if (!segSelected.has(ch.id + '|' + segName)) return;
      rows.push([rank++, it.sku, it.count]);
    });
    return rows;
  });
  sheet.addRows(rowsByCh);
  sheet.cols = [{ wch: 6 }, { wch: 24 }, { wch: 10 }];
  return sheet;
}

/* ---- 工作表七：混件SKU序列 ---- */
function sheetMixSeq(channels, selected, segSelected) {
  var selChans = channels.filter(function (c) { return selected.has(c.id); });
  var sheet = seqSheetBase('混件SKU序列', selChans, 3, ['排序', 'SKU集合', '订单数量']);
  var rowsByCh = selChans.map(function (ch) {
    var rows = [];
    var included = ch.mixSeq.filter(function (g) {
      var sn = ch.rawGroupSegMap.get(g);
      return sn && segSelected.has(ch.id + '|' + sn);
    });
    var extras = (ch.mixSeqExtra || []).filter(function (it) {
      return segSelected.has(ch.id + '|' + it.segName);
    });
    if (included.length || extras.length) {
      var union = [];
      var uSet = new Set();
      included.forEach(function (g) { g.set.forEach(function (sk) { uSet.add(sk); }); });
      extras.forEach(function (it) { uSet.add(it.sku); });
      union = Array.from(uSet).sort(function (a, b) { return a.localeCompare(b, 'zh'); });
      rows.push([0, union.join('\n'), '']);
      included.forEach(function (g, i) { rows.push([i + 1, g.set.join('\n'), g.count]); });
      extras.forEach(function (it, i) { rows.push([included.length + i + 1, it.sku, it.count]); });
    }
    return rows;
  });
  sheet.addRows(rowsByCh);
  sheet.cols = [{ wch: 6 }, { wch: 40 }, { wch: 10 }];
  return sheet;
}

/* ---- 工作表八：分类SKU序列 ---- */
function sheetClassSeq(classSeq) {
  var sheet = seqSheetBase('分类SKU序列', classSeq, 3, ['排序', 'SKU', '出现数量']);
  var rowsByCh = classSeq.map(function (cls) {
    return cls.seq.map(function (it, i) { return [i + 1, it.sku, it.count]; });
  });
  sheet.addRows(rowsByCh);
  sheet.cols = [{ wch: 6 }, { wch: 24 }, { wch: 10 }];
  return sheet;
}

/* ---- 汇总导出数据 ---- */
function buildExport(analysis, exportState) {
  var selected = exportState.channelSelected;
  var segSelected = exportState.segSelected;
  var blocks = collectBlocks(analysis.channels, selected, segSelected);
  if (!blocks.length) return null;
  var sheets = [
    sheetGroupResult(blocks),
    sheetGroupSkuPool(blocks),
    sheetWaveTable(blocks, exportState.waveNos || null),
    sheetChannelStats(analysis.channels, selected, segSelected),
    sheetSingleSeq(analysis.channels, selected, segSelected),
    sheetMultiSeq(analysis.channels, selected, segSelected),
    sheetMixSeq(analysis.channels, selected, segSelected),
    sheetClassSeq(analysis.classSeq)
  ];
  var d = new Date();
  var ymd = '' + d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, '0') +
    String(d.getDate()).padStart(2, '0');
  return { sheets: sheets, filename: '波次规划' + ymd + '.xlsx' };
}

/* ---- 工作簿写出：自建 OOXML + STORE ZIP（全量样式支持） ---- */
function sanitizeSheetName(name) {
  var n = String(name).replace(/[\[\]\*\/\\\?:]/g, ' ').trim();
  return n.length > 31 ? n.slice(0, 31) : n;
}
function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/\r/g, '').replace(/\n/g, '&#10;');
}
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  var crc = 0xFFFFFFFF;
  for (var i = 0; i < u8.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ u8[i]) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function zipStore(files) {
  var enc = new TextEncoder();
  var parts = [], offset = 0, central = [];
  function pushU16(v) { var b = new Uint8Array(2); b[0] = v & 255; b[1] = (v >>> 8) & 255; parts.push(b); offset += 2; }
  function pushU32(v) { var b = new Uint8Array(4); b[0] = v & 255; b[1] = (v >>> 8) & 255; b[2] = (v >>> 16) & 255; b[3] = (v >>> 24) & 255; parts.push(b); offset += 4; }
  files.forEach(function (f) {
    var nameB = enc.encode(f.name);
    var crc = crc32(f.data);
    var localOff = offset;
    pushU32(0x04034b50); pushU16(20); pushU16(0x0800); pushU16(0); pushU16(0); pushU16(0);
    pushU32(crc); pushU32(f.data.length); pushU32(f.data.length);
    pushU16(nameB.length); pushU16(0);
    parts.push(nameB); offset += nameB.length;
    parts.push(f.data); offset += f.data.length;
    central.push({ nameB: nameB, crc: crc, size: f.data.length, off: localOff });
  });
  var cdStart = offset;
  central.forEach(function (c) {
    pushU32(0x02014b50); pushU16(20); pushU16(20); pushU16(0x0800); pushU16(0); pushU16(0); pushU16(0);
    pushU32(c.crc); pushU32(c.size); pushU32(c.size);
    pushU16(c.nameB.length); pushU16(0); pushU16(0); pushU16(0); pushU16(0);
    pushU32(0); pushU32(c.off);
    parts.push(c.nameB); offset += c.nameB.length;
  });
  var cdSize = offset - cdStart;
  pushU32(0x06054b50); pushU16(0); pushU16(0);
  pushU16(central.length); pushU16(central.length);
  pushU32(cdSize); pushU32(cdStart); pushU16(0);
  var out = new Uint8Array(offset), p = 0;
  parts.forEach(function (b) { out.set(b, p); p += b.length; });
  return out;
}
function colName(n) {
  var s = '';
  n++;
  while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/* 样式注册表：字体 / 填充 / 边框 / XF */
function StyleRegistry() {
  this.fonts = ['<font><sz val="12"/><name val="Calibri"/><family val="2"/></font>'];
  this.fontKeys = new Map([['12,0', 0]]);
  this.fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  this.fillKeys = new Map();
  this.borders = [
    /* 索引 0 必须是空边框（WPS/Excel 约定：0 = 无边框）；细线边框从索引 1 起 */
    '<border><left/><right/><top/><bottom/><diagonal/></border>',
    '<border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border>'
  ];
  this.xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>'];
  this.xfKeys = new Map();
}
StyleRegistry.prototype.fontId = function (f) {
  var sz = (f && f.sz) || 12;
  var bold = f && f.bold ? 1 : 0;
  var key = sz + ',' + bold;
  if (this.fontKeys.has(key)) return this.fontKeys.get(key);
  var id = this.fonts.length;
  this.fonts.push('<font>' + (bold ? '<b/>' : '') + '<sz val="' + sz + '"/><name val="Calibri"/><family val="2"/></font>');
  this.fontKeys.set(key, id);
  return id;
};
StyleRegistry.prototype.fillId = function (fill) {
  var rgb = fill && fill.fgColor && fill.fgColor.rgb ? String(fill.fgColor.rgb).replace('#', '').toUpperCase() : '';
  if (!rgb) return 0;
  if (this.fillKeys.has(rgb)) return this.fillKeys.get(rgb);
  var id = this.fills.length;
  this.fills.push('<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>');
  this.fillKeys.set(rgb, id);
  return id;
};
StyleRegistry.prototype.borderId = function (s) {
  if (!s || !s.border) return 1; /* 默认细线 */
  var b = s.border;
  return (b.top || b.bottom || b.left || b.right) ? 1 : 0; /* 空边框(间隔列) → 0 */
};
StyleRegistry.prototype.xfId = function (s) {
  var fontId = s && s.font ? this.fontId(s.font) : 0;
  var fillId = s && s.fill ? this.fillId(s.fill) : 0;
  var borderId = this.borderId(s);
  var al = s && s.alignment ? s.alignment : null;
  var h = al && al.horizontal ? al.horizontal : '';
  var v = al && al.vertical ? al.vertical : '';
  var w = al && al.wrapText ? '1' : '';
  var key = fontId + ',' + fillId + ',' + borderId + ',' + h + '|' + v + '|' + w;
  if (this.xfKeys.has(key)) return this.xfKeys.get(key);
  var id = this.xfs.length;
  var attrs = 'numFmtId="0" fontId="' + fontId + '" fillId="' + fillId + '" borderId="' + borderId + '" xfId="0"';
  if (fontId) attrs += ' applyFont="1"';
  if (fillId) attrs += ' applyFill="1"';
  attrs += ' applyBorder="1"';
  if (h || v || w) {
    attrs += ' applyAlignment="1"';
    var aAttrs = '';
    if (h) aAttrs += ' horizontal="' + h + '"';
    if (v) aAttrs += ' vertical="' + v + '"';
    if (w) aAttrs += ' wrapText="1"';
    this.xfs.push('<xf ' + attrs + '><alignment' + aAttrs + '/></xf>');
  } else {
    this.xfs.push('<xf ' + attrs + '/>');
  }
  this.xfKeys.set(key, id);
  return id;
};
StyleRegistry.prototype.registerSheet = function (spec) {
  var nRows = spec.aoa.length;
  var nCols = 0;
  spec.aoa.forEach(function (r) { if (r.length > nCols) nCols = r.length; });
  var grid = new Uint32Array(nRows * nCols);
  (spec.styles || []).forEach(function (st) {
    if (st.r < nRows && st.c < nCols) grid[st.r * nCols + st.c] = this.xfId(st.s);
  }, this);
  return { grid: grid, nCols: nCols, nRows: nRows };
};
StyleRegistry.prototype.stylesXml = function () {
  var o = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">',
    '<fonts count="' + this.fonts.length + '">' + this.fonts.join('') + '</fonts>',
    '<fills count="' + this.fills.length + '">' + this.fills.join('') + '</fills>',
    '<borders count="' + this.borders.length + '">' + this.borders.join('') + '</borders>',
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="1"/></cellStyleXfs>',
    '<cellXfs count="' + this.xfs.length + '">' + this.xfs.join('') + '</cellXfs>',
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>',
    '<dxfs count="0"/>',
    '<tableStyles count="0" defaultTableStyle="TableStyleMedium9" defaultPivotStyle="PivotStyleMedium4"/>',
    '</styleSheet>'];
  return o.join('');
};

/* 内联字符串（t="str"，与参照文件的写出格式一致，兼容 WPS 渲染） */
function strEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function sheetToXml(spec, reg) {
  var aoa = spec.aoa;
  var out = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
  out.push('<dimension ref="A1:' + colName(reg.nCols - 1) + reg.nRows + '"/>');
  out.push('<sheetViews><sheetView workbookViewId="0"/></sheetViews>');
  out.push('<sheetFormatPr defaultRowHeight="15"/>');
  if (spec.cols && spec.cols.length) {
    out.push('<cols>');
    for (var c = 0; c < reg.nCols; c++) {
      var w = (spec.cols[c] && spec.cols[c].wch) || 9;
      out.push('<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + w + '" customWidth="1"/>');
    }
    out.push('</cols>');
  }
  out.push('<sheetData>');
  for (var r = 0; r < reg.nRows; r++) {
    var ht = spec.rows && spec.rows[r] && spec.rows[r].hpt;
    out.push('<row r="' + (r + 1) + '"' + (ht ? ' ht="' + ht + '" customHeight="1"' : '') + '>');
    var rowArr = aoa[r] || [];
    for (var cc = 0; cc < reg.nCols; cc++) {
      var v = rowArr[cc];
      var addr = colName(cc) + (r + 1);
      var xi = reg.grid[r * reg.nCols + cc];
      if (typeof v === 'number' && isFinite(v)) {
        out.push('<c r="' + addr + '" s="' + xi + '"><v>' + v + '</v></c>');
      } else if (v != null && v !== '') {
        out.push('<c r="' + addr + '" s="' + xi + '" t="str" xml:space="preserve"><v xml:space="preserve">' + strEsc(v) + '</v></c>');
      } else {
        out.push('<c r="' + addr + '" s="' + xi + '" t="str"><v></v></c>');
      }
    }
    out.push('</row>');
  }
  out.push('</sheetData>');
  if (spec.autofilter) out.push('<autoFilter ref="' + spec.autofilter + '"/>');
  if (spec.merges && spec.merges.length) {
    out.push('<mergeCells count="' + spec.merges.length + '">');
    spec.merges.forEach(function (m) {
      out.push('<mergeCell ref="' + colName(m.s.c) + (m.s.r + 1) + ':' + colName(m.e.c) + (m.e.r + 1) + '"/>');
    });
    out.push('</mergeCells>');
  }
  out.push('</worksheet>');
  return out.join('');
}

var THEME1_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
'<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office">' +
'<a:themeElements><a:clrScheme name="Office">' +
'<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
'<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
'<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
'<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
'<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
'<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
'<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
'</a:clrScheme><a:fontScheme name="Office">' +
'<a:majorFont><a:latin typeface="等线 Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
'<a:minorFont><a:latin typeface="等线"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
'</a:fontScheme><a:fmtScheme name="Office">' +
'<a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
'<a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
'<a:ln w="12700" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>' +
'<a:ln w="19050" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln></a:lnStyleLst>' +
'<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
'<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
'</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>';

function contentTypesXml(nSheets) {
  var o = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'];
  for (var i = 1; i <= nSheets; i++) {
    o.push('<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
  }
  o.push('</Types>');
  return o.join('');
}
function rootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';
}
function workbookXml(sheets) {
  var o = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
    '<fileVersion appName="xl" lastEdited="6" lowestEdited="6" rupBuild="14420"/>',
    '<workbookPr defaultThemeVersion="166925"/>',
    '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews>',
    '<sheets>'];
  sheets.forEach(function (s, i) {
    o.push('<sheet name="' + xmlEsc(sanitizeSheetName(s.name)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>');
  });
  o.push('</sheets><calcPr calcId="171027"/></workbook>');
  return o.join('');
}
function workbookRelsXml(nSheets) {
  var o = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'];
  for (var i = 1; i <= nSheets; i++) {
    o.push('<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>');
  }
  o.push('<Relationship Id="rId' + (nSheets + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>');
  o.push('<Relationship Id="rId' + (nSheets + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>');
  o.push('</Relationships>');
  return o.join('');
}
function corePropsXml() {
  var now = new Date().toISOString();
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    '<dc:creator>波次规划工具</dc:creator><cp:lastModifiedBy>波次规划工具</cp:lastModifiedBy>' +
    '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
    '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
    '</cp:coreProperties>';
}
function appPropsXml(sheets) {
  var o = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">',
    '<Application>波次规划工具</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>',
    '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>工作表</vt:lpstr></vt:variant>' +
    '<vt:variant><vt:i4>' + sheets.length + '</vt:i4></vt:variant></vt:vector></HeadingPairs>',
    '<TitlesOfParts><vt:vector size="' + sheets.length + '" baseType="lpstr">'];
  sheets.forEach(function (s) { o.push('<vt:lpstr>' + xmlEsc(sanitizeSheetName(s.name)) + '</vt:lpstr>'); });
  o.push('</vt:vector></TitlesOfParts>');
  o.push('<Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged><AppVersion>16.0300</AppVersion></Properties>');
  return o.join('');
}

function buildXlsxBuffer(sheets) {
  var enc = new TextEncoder();
  var reg = new StyleRegistry();
  var files = [];
  var sheetParts = sheets.map(function (spec, i) {
    var grid = reg.registerSheet(spec);
    return { name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: enc.encode(sheetToXml(spec, grid)) };
  });
  files.push({ name: '[Content_Types].xml', data: enc.encode(contentTypesXml(sheets.length)) });
  files.push({ name: '_rels/.rels', data: enc.encode(rootRelsXml()) });
  files.push({ name: 'docProps/core.xml', data: enc.encode(corePropsXml()) });
  files.push({ name: 'docProps/app.xml', data: enc.encode(appPropsXml(sheets)) });
  files.push({ name: 'xl/workbook.xml', data: enc.encode(workbookXml(sheets)) });
  files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml(sheets.length)) });
  files.push({ name: 'xl/styles.xml', data: enc.encode(reg.stylesXml()) });
  files.push({ name: 'xl/theme/theme1.xml', data: enc.encode(THEME1_XML) });
  sheetParts.forEach(function (f) { files.push(f); });
  return zipStore(files);
}
function downloadWorkbook(exportData) {
  var u8 = buildXlsxBuffer(exportData.sheets);
  var blob = new Blob([u8], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  var url = URL.createObjectURL(blob);
  /* 保活：防止大 blob 在下载完成前被垃圾回收导致下载被取消 */
  var keep = (window.__dshBlobKeep = window.__dshBlobKeep || []);
  keep.push({ url: url, blob: blob });
  while (keep.length > 5) {
    var old = keep.shift();
    URL.revokeObjectURL(old.url);
  }
  var a = document.createElement('a');
  a.href = url;
  a.download = exportData.filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  return exportData.filename;
}

/* ---------- Node 测试钩子 ---------- */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    parseQty: parseQty, locateSheet: locateSheet, mapHeaders: mapHeaders,
    buildRecords: buildRecords, trackingChannel: trackingChannel,
    linearPartition: linearPartition, analyzeChannel: analyzeChannel,
    analyze: analyze, buildExport: buildExport, buildXlsxBuffer: buildXlsxBuffer,
    splitOversizedHotSegments: splitOversizedHotSegments,
    HOT_SINGLE_SKU_SPLIT_LIMIT: HOT_SINGLE_SKU_SPLIT_LIMIT,
    DEFAULT_UNIFIED: DEFAULT_UNIFIED,
    /* 测试与界面共用的展示映射（避免多份拷贝） */
    ABSORB_NAMES: ABSORB_NAMES, TYPE_LABEL: TYPE_LABEL,
    KIND_SHORT: KIND_SHORT, KIND_TYPE: KIND_TYPE,
    segDisplayName: segDisplayName
  };
}
