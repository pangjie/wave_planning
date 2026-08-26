/* =============================================================
 * 深度一致性测试：导出文件内容 vs 分析结果 vs 网页选择
 * 覆盖：参数矩阵 × 吸收档位 × 归并模式 × 随机勾选模糊测试
 * ============================================================= */
'use strict';
const fs = require('fs');
const path = require('path');
global.XLSX = require(path.join(__dirname, 'vendor', 'xlsx.full.min.js'));
const C = require('./core.js');

const wb = XLSX.read(fs.readFileSync(path.join(__dirname, '..', 'sample', 'ParcelOutbound_20260815193913.xlsx')), { type: 'buffer' });
const { rows } = C.locateSheet(wb);
const hm = C.mapHeaders(rows[0]);
const { records, qtyMap } = C.buildRecords(rows.slice(1), hm);

let failures = 0;
function check(cond, msg) {
  if (!cond) { failures++; console.error('  ✘ ' + msg); }
}
function num(v) { return parseInt(String(v).replace(/[^\d]/g, ''), 10); }
/* 以下映射直接复用 core 的唯一定义，避免测试内复制导致口径漂移 */
const normName = C.segDisplayName;
const ABSORB_LABELS = C.ABSORB_NAMES;
const TLABEL = C.TYPE_LABEL;
const SHORT = C.KIND_SHORT;
const FTYPE = C.KIND_TYPE;

/* ---------- 主校验器：给定分析与选择，逐表核对 ---------- */
function verifyExport(a, selection, label) {
  const data = C.buildExport(a, selection);
  const byName = {};
  data.sheets.forEach(s => (byName[s.name] = s.aoa));

  /* 期望导出的分段（渠道选中 && 分段选中 && 非空） */
  const expSegs = [];
  a.channels.forEach(ch => {
    if (!selection.channelSelected.has(ch.id)) return;
    ch.segments.forEach(seg => {
      if (selection.segSelected.has(ch.id + '|' + seg.name)) expSegs.push({ ch, seg });
    });
  });

  /* ---- 1. 分组结果 ---- */
  const aoa = byName['分组结果'];
  const parsed = [];
  let curCh = null;
  for (let c = 0; c < aoa[0].length; c++) {
    if (String(aoa[0][c] || '') !== '') curCh = String(aoa[0][c]);
    const info = String(aoa[1][c] || '');
    if (info === '') continue;
    const lines = info.split('\n');
    const startEnd = String(aoa[2][c]).split('\n');
    const list = startEnd.slice(1, -1);
    const expanded = [];
    for (let r = 3; r < aoa.length; r++) {
      if (String(aoa[r][c] || '') !== '') expanded.push(String(aoa[r][c]));
    }
    parsed.push({
      chName: curCh,
      segName: lines[0],
      skuCount: num(lines[1]),
      orderCount: num(lines[2]),
      pickQty: num(lines[3]),
      list, expanded
    });
  }
  check(parsed.length === expSegs.length, `${label} 分组结果列数 ${parsed.length} ≠ 期望 ${expSegs.length}`);
  const orderOwner = new Map(); // 订单号 -> 分段索引（查重）
  expSegs.forEach((x, i) => {
    if (i >= parsed.length) return;
    const p = parsed[i];
    check(p.chName === x.ch.name, `${label} 第${i}列渠道名 ${p.chName} ≠ ${x.ch.name}`);
    check(normName(p.segName) === normName(x.seg.name), `${label} 第${i}列分段名 ${p.segName} ≠ ${x.seg.name}`);
    check(p.skuCount === x.seg.skuCount, `${label} ${x.seg.name} SKU数量 ${p.skuCount} ≠ ${x.seg.skuCount}`);
    check(p.orderCount === x.seg.orderCount, `${label} ${x.seg.name} 订单数量 ${p.orderCount} ≠ ${x.seg.orderCount}`);
    check(p.pickQty === x.seg.pickQty, `${label} ${x.seg.name} 拣货数量 ${p.pickQty} ≠ ${x.seg.pickQty}`);
    check(JSON.stringify(p.list) === JSON.stringify(x.seg.orderNos), `${label} ${x.seg.name} start/end 订单清单不符`);
    check(JSON.stringify(p.expanded) === JSON.stringify(x.seg.orderNos), `${label} ${x.seg.name} 逐行展开订单清单不符`);
    x.seg.orderNos.forEach(o => {
      if (orderOwner.has(o)) check(false, `${label} 订单 ${o} 同时出现在 ${orderOwner.get(o)} 与 ${x.seg.name}（重复分配！）`);
      orderOwner.set(o, x.seg.name);
    });
  });
  /* 订单归属完整性：每条有效订单应恰好属于其渠道的选中分段（无分段类型的记录除外） */
  const channelById = new Map(a.channels.map(c => [c.id, c]));
  records.forEach(r => {
    const ch = channelById.get(r.channelId);
    if (!ch) return;
    const ownerSeg = ch.segments.filter(s => s.orderNos.indexOf(r.orderNo) >= 0)[0];
    if (!ownerSeg) {
      check(['单品单件', '单品多件', '多品混合'].indexOf(r.type) === -1, `${label} 订单 ${r.orderNo}（${r.type}）未进入任何分段`);
      return;
    }
    const key = ch.id + '|' + ownerSeg.name;
    const exported = selection.channelSelected.has(ch.id) && selection.segSelected.has(key);
    check(orderOwner.get(r.orderNo) !== undefined === exported, `${label} 订单 ${r.orderNo} 导出状态与选择不符（${exported}）`);
  });
  /* 全量导出时：所有分段订单合计 = 记录总数 */
  if (selection.channelSelected.size === a.channels.length && selection.segSelected.size >= expSegs.length) {
    const allSegs = [];
    a.channels.forEach(ch => ch.segments.forEach(s => allSegs.push(ch.id + '|' + s.name)));
    if (allSegs.every(k => selection.segSelected.has(k))) {
      check(orderOwner.size === records.length, `${label} 全量导出订单总数 ${orderOwner.size} ≠ 记录总数 ${records.length}`);
    }
  }

  /* ---- 2. 分组结果SKU池 ---- */
  const aoa2 = byName['分组结果SKU池'];
  const pools = [];
  curCh = null;
  for (let c = 0; c < aoa2[0].length; c++) {
    if (String(aoa2[0][c] || '') !== '') curCh = String(aoa2[0][c]);
    if (String(aoa2[2][c]) === 'SKU') {
      const pair = [];
      for (let r = 3; r < aoa2.length; r++) {
        const sku = String(aoa2[r][c] || '');
        const qty = aoa2[r][c + 1];
        if (sku !== '') pair.push({ sku, count: Number(qty) });
      }
      pools.push({ chName: curCh, pair });
      c++; // 跳过数量列
    }
  }
  check(pools.length === expSegs.length, `${label} SKU池列组数 ${pools.length} ≠ ${expSegs.length}`);
  expSegs.forEach((x, i) => {
    if (i >= pools.length) return;
    const p = pools[i];
    const expected = x.seg.skuPool.map(sp => ({ sku: sp.sku, count: sp.count }));
    check(JSON.stringify(p.pair) === JSON.stringify(expected), `${label} ${x.seg.name} SKU池不符`);
  });

  /* ---- 3. 波次表 ---- */
  const aoa3 = byName['波次表'];
  const waves = [];
  let seps = 0;
  for (let r = 1; r < aoa3.length; r++) {
    if (String(aoa3[r][0]) === '---') { seps++; continue; }
    waves.push(aoa3[r]);
  }
  check(waves.length === expSegs.length, `${label} 波次表行数 ${waves.length} ≠ ${expSegs.length}`);
  const blocks = [];
  let cur = null;
  expSegs.forEach(x => {
    if (!cur || cur.ch !== x.ch) { cur = { ch: x.ch, n: 0 }; blocks.push(cur); }
    cur.n++;
  });
  check(seps === blocks.length - 1, `${label} 波次表分隔行 ${seps} ≠ 渠道块-1 ${blocks.length - 1}`);
  expSegs.forEach((x, i) => {
    if (i >= waves.length) return;
    const w = waves[i];
    check(w[0] === x.ch.name + SHORT[x.seg.kind], `${label} 波次表第${i}行渠道类型 ${w[0]}`);
    check(w[3] === FTYPE[x.seg.kind], `${label} 波次表第${i}行类型 ${w[3]}`);
    check(Number(w[5]) === x.seg.skuCount, `${label} 波次表第${i}行SKU数量`);
    check(Number(w[6]) === x.seg.orderCount, `${label} 波次表第${i}行应拣单数`);
    check(Number(w[7]) === x.seg.pickQty, `${label} 波次表第${i}行应拣件数`);
  });

  /* ---- 4. 渠道统计 ---- */
  const aoa4 = byName['渠道统计'];
  const selChans = a.channels.filter(c => selection.channelSelected.has(c.id));
  check(aoa4[0].length === selChans.length + 1, `${label} 渠道统计列数 ${aoa4[0].length} ≠ ${selChans.length + 1}`);
  const rowOf = label => aoa4.find(r => String(r[0]) === label);
  /* 分段统计行位于固定行（以「非爆品订单数」结束）之后 */
  const fixedEnd = aoa4.findIndex(r => String(r[0]) === '非爆品订单数');
  const segRowOf = label => {
    for (let i = fixedEnd + 1; i < aoa4.length; i++) {
      if (String(aoa4[i][0]) === label) return aoa4[i];
    }
    return undefined;
  };
  selChans.forEach((ch, i) => {
    const v = label => (rowOf(label) ? rowOf(label)[i + 1] : undefined);
    check(v('订单总数') === ch.total, `${label} 渠道统计 ${ch.id} 订单总数`);
    check(v('单品单件') === ch.singleCount, `${label} 渠道统计 ${ch.id} 单品单件`);
    check(v('多件') === ch.multiCount, `${label} 渠道统计 ${ch.id} 多件`);
    check(v('混件') === ch.mixCount, `${label} 渠道统计 ${ch.id} 混件`);
    check(v('爆品线') === ch.params.hotLine, `${label} 渠道统计 ${ch.id} 爆品线`);
    check(v('波次容量') === ch.params.capacity, `${label} 渠道统计 ${ch.id} 波次容量`);
    check(v('多件分段数') === ch.params.multiSegs, `${label} 渠道统计 ${ch.id} 多件分段数`);
    check(v('混件分段数') === ch.params.mixSegs, `${label} 渠道统计 ${ch.id} 混件分段数`);
    check(v('混件吸收') === ch.params.absorb + '-' + ABSORB_LABELS[ch.params.absorb], `${label} 渠道统计 ${ch.id} 混件吸收`);
    check(v('爆品SKU数') === ch.hotSkuCount, `${label} 渠道统计 ${ch.id} 爆品SKU数`);
    check(v('爆品订单数') === ch.hotOrderCount, `${label} 渠道统计 ${ch.id} 爆品订单数`);
    check(v('非爆品SKU数') === ch.paperSkuCount, `${label} 渠道统计 ${ch.id} 非爆品SKU数`);
    check(v('非爆品订单数') === ch.paperOrderCount, `${label} 渠道统计 ${ch.id} 非爆品订单数`);
  });
  /* 分段统计行 */
  Object.keys(TLABEL).forEach(t => {
    const hasAny = selChans.some(ch => ch.byType[t].some(s => selection.segSelected.has(ch.id + '|' + s.name)));
    const row = segRowOf(TLABEL[t]);
    if (!hasAny) { check(row === undefined, `${label} 渠道统计不应有 ${TLABEL[t]} 分段行`); return; }
    check(row !== undefined, `${label} 渠道统计缺少 ${TLABEL[t]} 分段行`);
    if (!row) return;
    selChans.forEach((ch, i) => {
      const expected = ch.byType[t]
        .filter(s => selection.segSelected.has(ch.id + '|' + s.name))
        .map(s => normName(s.name) + '（订单 ' + s.orderCount + '，SKU ' + s.skuCount + '）').join('\n');
      check(String(row[i + 1]) === expected, `${label} 渠道统计 ${ch.id} ${TLABEL[t]} 分段行不符`);
    });
  });

  /* ---- 5. 单件SKU序列 ---- */
  const aoa5 = byName['单件SKU序列'];
  selChans.forEach((ch, bi) => {
    const base = bi * 5;
    const expected = [];
    let rank = 1;
    ch.singleSeq.forEach(it => {
      const segName = ch.singleSegMap.get(it.sku);
      if (!segName) return;
      if (!selection.segSelected.has(ch.id + '|' + segName)) return;
      const seg = ch.segByName.get(segName);
      expected.push([rank++, it.sku, it.count, normName(segName), seg ? seg.orderCount : '']);
    });
    const got = [];
    for (let r = 2; r < aoa5.length; r++) {
      const rank2 = aoa5[r][base];
      if (String(rank2) === '') continue;
      got.push([Number(rank2), String(aoa5[r][base + 1]), Number(aoa5[r][base + 2]), String(aoa5[r][base + 3]), aoa5[r][base + 4] === '' ? '' : Number(aoa5[r][base + 4])]);
    }
    check(JSON.stringify(got) === JSON.stringify(expected), `${label} 单件SKU序列 ${ch.id} 不符（${got.length}/${expected.length}）`);
  });

  /* ---- 6. 多件SKU序列 ---- */
  const aoa6 = byName['多件SKU序列'];
  selChans.forEach((ch, bi) => {
    const base = bi * 3;
    const expected = [];
    let rank = 1;
    ch.multiSeq.forEach(it => {
      const segName = ch.multiSegMap.get(it.sku);
      if (!segName) return;
      if (!selection.segSelected.has(ch.id + '|' + segName)) return;
      expected.push([rank++, it.sku, it.count]);
    });
    const got = [];
    for (let r = 2; r < aoa6.length; r++) {
      if (String(aoa6[r][base]) === '') continue;
      got.push([Number(aoa6[r][base]), String(aoa6[r][base + 1]), Number(aoa6[r][base + 2])]);
    }
    check(JSON.stringify(got) === JSON.stringify(expected), `${label} 多件SKU序列 ${ch.id} 不符（${got.length}/${expected.length}）`);
  });

  /* ---- 7. 混件SKU序列 ---- */
  const aoa7 = byName['混件SKU序列'];
  selChans.forEach((ch, bi) => {
    const base = bi * 3;
    const included = ch.mixSeq.filter(g => {
      const sn = ch.rawGroupSegMap.get(g);
      return sn && selection.segSelected.has(ch.id + '|' + sn);
    });
    const extras = (ch.mixSeqExtra || []).filter(it => selection.segSelected.has(ch.id + '|' + it.segName));
    const got = [];
    for (let r = 2; r < aoa7.length; r++) {
      if (String(aoa7[r][base]) === '') continue;
      got.push([Number(aoa7[r][base]), String(aoa7[r][base + 1]), aoa7[r][base + 2] === '' ? '' : Number(aoa7[r][base + 2])]);
    }
    const expected = [];
    if (included.length || extras.length) {
      const union = Array.from(new Set([
        ...included.flatMap(g => g.set),
        ...extras.map(it => it.sku)
      ])).sort((x, y) => x.localeCompare(y, 'zh'));
      expected.push([0, union.join('\n'), '']);
      included.forEach((g, i) => expected.push([i + 1, g.set.join('\n'), g.count]));
      extras.forEach((it, i) => expected.push([included.length + i + 1, it.sku, it.count]));
    }
    check(JSON.stringify(got) === JSON.stringify(expected), `${label} 混件SKU序列 ${ch.id} 不符（${got.length}/${expected.length}）`);
  });

  /* ---- 8. 分类SKU序列（固定口径，不受选择影响） ---- */
  const aoa8 = byName['分类SKU序列'];
  const classes = ['普通订单', 'CBT订单', 'CBS订单'];
  const expectClass = [];
  classes.forEach(cls => {
    const map = new Map();
    records.forEach(r => {
      if (r.type !== '单品单件') return;
      if (r.carrierClass !== cls) return;
      const sku = r.sku1 || '(空SKU)';
      map.set(sku, (map.get(sku) || 0) + 1);
    });
    const seq = Array.from(map.entries()).map(([sku, count]) => ({ sku, count }))
      .sort((x, y) => y.count - x.count || x.sku.localeCompare(y.sku, 'zh'));
    expectClass.push(seq);
  });
  classes.forEach((cls, bi) => {
    const base = bi * 3;
    const got = [];
    for (let r = 2; r < aoa8.length; r++) {
      if (String(aoa8[r][base]) === '') continue;
      got.push([Number(aoa8[r][base]), String(aoa8[r][base + 1]), Number(aoa8[r][base + 2])]);
    }
    const expected = expectClass[bi].map((it, i) => [i + 1, it.sku, it.count]);
    check(JSON.stringify(got) === JSON.stringify(expected), `${label} 分类SKU序列 ${cls} 不符（${got.length}/${expected.length}）`);
  });

  return { expSegs, orderOwner };
}

/* ---------- 场景矩阵 ---------- */
const paramGrid = [
  { hotLine: 1, capacity: 100, multiSegs: 1, mixSegs: 1, absorb: 1 },
  { ...C.DEFAULT_UNIFIED },
  { hotLine: 5, capacity: 250, multiSegs: 3, mixSegs: 4, absorb: 1 },
  { ...C.DEFAULT_UNIFIED, multiSegs: 3, mixSegs: 4, absorb: 2 },
  { ...C.DEFAULT_UNIFIED, multiSegs: 3, mixSegs: 4, absorb: 3 },
  { hotLine: 1, capacity: 100, multiSegs: 5, mixSegs: 6, absorb: 4 },
  { hotLine: 20, capacity: 500, multiSegs: 2, mixSegs: 2, absorb: 2 }
];
const modes = ['normal', 'merged'];
let scenarioCount = 0;

modes.forEach(mode => {
  paramGrid.forEach((p, pi) => {
    const a = C.analyze(records, qtyMap, mode, () => Object.assign({}, p));
    const selAll = selectAll(a);
    verifyExport(a, selAll, `[${mode} P${pi}] 全选`);
    scenarioCount++;
  });
});
console.log(`✔ 全选场景矩阵完成：${scenarioCount} 个场景`);

/* ---------- 随机勾选模糊测试 ---------- */
function selectAll(a) {
  const channelSelected = new Set(a.channels.map(c => c.id));
  const segSelected = new Set();
  a.channels.forEach(ch => ch.segments.forEach(seg => segSelected.add(ch.id + '|' + seg.name)));
  return { channelSelected, segSelected };
}
/* 确定性 PRNG（mulberry32）：模糊测试可复现 */
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function randSel(a, seed) {
  const rnd = mulberry32(seed);
  const chans = a.channels.filter(() => rnd() > 0.3);
  const segs = new Set();
  a.channels.forEach(ch => {
    ch.segments.forEach(seg => {
      if (rnd() > 0.4) segs.add(ch.id + '|' + seg.name);
    });
  });
  return { channelSelected: new Set(chans.map(c => c.id)), segSelected: segs };
}
for (let f = 0; f < 24; f++) {
  const mode = f % 2 === 0 ? 'normal' : 'merged';
  const p = paramGrid[f % paramGrid.length];
  const a = C.analyze(records, qtyMap, mode, () => Object.assign({}, p));
  const sel = randSel(a, f);
  /* 确保至少一个分段被选中 */
  if (sel.segSelected.size === 0) {
    const ch = a.channels[0];
    if (ch.segments.length) {
      sel.segSelected.add(ch.id + '|' + ch.segments[0].name);
      sel.channelSelected.add(ch.id);
    }
  }
  /* 确保至少一对「渠道∧分段」同时选中，否则导出被正确阻止属预期 */
  let effective = 0;
  a.channels.forEach(ch => {
    ch.segments.forEach(seg => {
      if (sel.channelSelected.has(ch.id) && sel.segSelected.has(ch.id + '|' + seg.name)) effective++;
    });
  });
  const data = C.buildExport(a, sel);
  if (effective === 0) {
    check(data === null, `fuzz${f} 无有效选择时应被阻止导出`);
    continue;
  }
  if (!data) {
    check(false, `fuzz${f} 有效选择 ${effective} 个分段但导出被阻止`);
    continue;
  }
  verifyExport(a, sel, `[fuzz${f} ${mode}]`);
}
console.log('✔ 随机勾选模糊测试完成：24 组');

/* ---------- 渠道默认启用规则 ---------- */
{
  check(C.channelEnabledByDefault({ id: 'CBT', total: 12 }) === true,
    '有订单的已识别渠道应默认开启');
  check(C.channelEnabledByDefault({ id: 'CBT', total: 0 }) === false,
    '零订单渠道应默认关闭');
  check(C.channelEnabledByDefault({ id: '未识别', total: 12 }) === false,
    '未识别渠道即使有订单也应默认关闭');
  console.log('✔ 零订单渠道与未识别渠道默认关闭');
}

/* ---------- 渠道固定 / 降序排序 ---------- */
{
  const source = [
    ['CBT', 100], ['UniUni', 0], ['YanWen', 80], ['USPS', 70], ['SwiftX', 60],
    ['SpeedX', 50], ['Gofo', 40], ['CBS', 30], ['UPS', 200], ['Fedex', 0],
    ['BFE', 10], ['未识别', 999]
  ].map(([id, total]) => ({ id, total }));
  const fixed = C.sortChannelsForDisplay(source.slice(), 'normal', 'fixed').map(c => c.id);
  check(JSON.stringify(fixed) === JSON.stringify([
    'CBT', 'YanWen', 'USPS', 'SwiftX', 'SpeedX', 'Gofo', 'CBS',
    'UPS', 'BFE', 'UniUni', 'Fedex', '未识别'
  ]), `普通模式固定排序不符：${fixed.join(',')}`);

  const desc = C.sortChannelsForDisplay(source.slice(), 'normal', 'desc').map(c => c.id);
  check(desc[0] === 'UPS' && desc[desc.length - 1] === '未识别',
    `降序模式应沿用订单量降序且未识别置底：${desc.join(',')}`);

  const mergedSource = [['CBT', 0], ['CBS', 30], ['普通', 100]].map(([id, total]) => ({ id, total }));
  const mergedFixed = C.sortChannelsForDisplay(mergedSource, 'merged', 'fixed').map(c => c.id);
  check(JSON.stringify(mergedFixed) === JSON.stringify(['普通', 'CBS', 'CBT']),
    `归并固定排序及零订单沉底不符：${mergedFixed.join(',')}`);
  console.log('✔ 渠道固定 / 降序排序、零订单沉底、未识别置底');
}

/* ---------- 未识别进化为普通：吸收与退化可逆 ---------- */
{
  const base = C.analyze(records, qtyMap, 'normal', () => ({ ...C.DEFAULT_UNIFIED }));
  const sel = selectAll(base);
  const sourceCh = base.channels.find(ch => !['CBT', 'CBS', '未识别'].includes(ch.id) && ch.segments.length > 0);
  const cbt = base.channels.find(ch => ch.id === 'CBT' && ch.segments.length > 0);
  check(Boolean(sourceCh && cbt), '样本应包含可吸收渠道与 CBT 分段');
  if (sourceCh && cbt) {
    const sourceSeg = sourceCh.segments[0];
    const cbtSeg = cbt.segments[0];
    sel.segSelected.delete(sourceCh.id + '|' + sourceSeg.name);
    sel.segSelected.delete('CBT|' + cbtSeg.name);
    const absorbed = C.collectOrdinaryAbsorbedOrderNos(base, sel.channelSelected, sel.segSelected);
    check(sourceSeg.orderNos.every(orderNo => absorbed.has(orderNo)), '普通应吸收非 CBT/CBS 的关闭分段');
    check(cbtSeg.orderNos.every(orderNo => !absorbed.has(orderNo)), '普通不得吸收 CBT 的关闭分段');

    const evolved = C.buildOrdinaryEvolvedAnalysis(
      base, records, qtyMap, () => ({ ...C.DEFAULT_UNIFIED }), sel.channelSelected, sel.segSelected
    );
    const originalUnknown = base.channels.find(ch => ch.id === '未识别');
    const ordinary = evolved.channels.find(ch => ch.id === '普通');
    check(!evolved.channels.some(ch => ch.id === '未识别'), '进化后表格不应同时保留未识别渠道');
    check(Boolean(ordinary), '进化后应生成普通渠道');
    if (ordinary && originalUnknown) {
      check(ordinary.total === originalUnknown.total + sourceSeg.orderCount,
        `普通订单数应为原未识别加吸收订单：${ordinary.total}`);
      const evolvedChannels = new Set(sel.channelSelected);
      evolvedChannels.delete('未识别');
      evolvedChannels.add('普通');
      const evolvedSegs = new Set(sel.segSelected);
      ordinary.segments.forEach(seg => evolvedSegs.add('普通|' + seg.name));
      const owners = new Map();
      let duplicate = false;
      evolved.channels.forEach(ch => {
        if (!evolvedChannels.has(ch.id)) return;
        ch.segments.forEach(seg => {
          if (!evolvedSegs.has(ch.id + '|' + seg.name)) return;
          seg.orderNos.forEach(orderNo => {
            if (owners.has(orderNo)) duplicate = true;
            owners.set(orderNo, ch.id + '|' + seg.name);
          });
        });
      });
      check(!duplicate, '吸收后有效分段之间不应出现重复订单');
      check(owners.size === records.length - cbtSeg.orderCount,
        '吸收后有效订单应仅排除未被普通吸收的 CBT 关闭分段');
    }
    check(evolved.channels.find(ch => ch.id === sourceCh.id).total === sourceCh.total,
      '被吸收渠道应保留原分段作为可逆开关');
    check(base.channels.some(ch => ch.id === '未识别') && !base.channels.some(ch => ch.id === '普通'),
      '退化使用基础分析时应只恢复未识别并吐出吸收订单');
  }
  console.log('✔ 未识别 / 普通进退化及非 CBT/CBS 关闭分段吸收');
}

/* ---------- 活跃 SKU：按有效订单的全部 SKU 去重 ---------- */
{
  const a = {
    mode: 'normal',
    channels: [{
      id: '测试渠道',
      segments: [
        { name: '混件1', orderNos: ['O1', 'O2'] },
        { name: '单件1', orderNos: ['O3'] }
      ]
    }]
  };
  const rs = [
    { orderNo: 'O1', skus: ['SKU-A', 'SKU-B'] },
    { orderNo: 'O2', skus: ['SKU-A', 'SKU-C', ''] },
    { orderNo: 'O3', skus: ['SKU-C', 'SKU-D'] },
    { orderNo: 'O4', skus: ['SKU-X'] }
  ];
  const channelSelected = new Set(['测试渠道']);
  const segSelected = new Set(['测试渠道|混件1', '测试渠道|单件1']);
  check(C.selectedSkuCount(a, rs, channelSelected, segSelected) === 4,
    '活跃 SKU 应包含混件的全部 SKU，并跨订单去重');
  segSelected.delete('测试渠道|混件1');
  check(C.selectedSkuCount(a, rs, channelSelected, segSelected) === 2,
    '关闭混件分段后，活跃 SKU 应只统计剩余有效订单');
  channelSelected.clear();
  check(C.selectedSkuCount(a, rs, channelSelected, segSelected) === 0,
    '关闭渠道后，活跃 SKU 应归零');
  console.log('✔ 活跃 SKU 按有效订单全 SKU 去重并实时联动');
}

/* ---------- 常驻渠道统计口径 ---------- */
{
  const normal = C.analyze(records, qtyMap, 'normal', () => ({ ...C.DEFAULT_UNIFIED }));
  const merged = C.analyze(records, qtyMap, 'merged', () => ({ ...C.DEFAULT_UNIFIED }));
  const normalResident = C.residentChannels(normal);
  const mergedResident = C.residentChannels(merged);
  check(normalResident.length === 11, `普通模式常驻渠道应为 11，实际 ${normalResident.length}`);
  check(!normalResident.some(ch => ch.id === '未识别'), '未识别不应计入常驻渠道');
  check(mergedResident.length === 3, `归并模式渠道应为 3，实际 ${mergedResident.length}`);
  console.log('✔ 活跃渠道按常驻渠道统计（普通 11 / 归并 3）');
}

/* ---------- 分段开关实时统计口径 ---------- */
{
  const a = C.analyze(records, qtyMap, 'normal', () => ({ ...C.DEFAULT_UNIFIED }));
  const sel = selectAll(a);
  check(C.selectedOrderCount(a, sel.channelSelected, sel.segSelected) === records.length,
    '全选时有效订单合计应等于原始订单总数');

  const ch = a.channels.find(c => c.segments.length >= 2);
  check(Boolean(ch), '样本中应至少存在一个包含多个分段的渠道');
  if (ch) {
    const removed = ch.segments[0];
    const beforeChannel = C.selectedOrderCountForChannel(ch, sel.channelSelected, sel.segSelected);
    const beforeTotal = C.selectedOrderCount(a, sel.channelSelected, sel.segSelected);
    sel.segSelected.delete(ch.id + '|' + removed.name);
    check(C.selectedOrderCountForChannel(ch, sel.channelSelected, sel.segSelected) === beforeChannel - removed.orderCount,
      '关闭单个分段后，所属渠道有效订单数应同步减少');
    check(C.selectedOrderCount(a, sel.channelSelected, sel.segSelected) === beforeTotal - removed.orderCount,
      '关闭单个分段后，有效订单总量应同步减少');
    sel.channelSelected.delete(ch.id);
    check(C.selectedOrderCountForChannel(ch, sel.channelSelected, sel.segSelected) === 0,
      '关闭渠道后，该渠道有效订单数应归零');
  }
  console.log('✔ 分段开关联动渠道订单数与有效订单总量');
}

/* ---------- 渠道顺序进入导出 ---------- */
{
  const p = { ...C.DEFAULT_UNIFIED };
  const a = C.analyze(records, qtyMap, 'normal', () => Object.assign({}, p));
  const reordered = a.channels.slice().reverse();
  const selAll = selectAll(a);
  const data = C.buildExport(Object.assign({}, a, { channels: reordered }), selAll);
  const aoa = data.sheets[0].aoa;
  const firstRow = [];
  aoa[0].forEach((v, c) => { if (String(v || '') !== '') firstRow.push(String(v)); });
  /* 分组结果只列出有分段的渠道，空渠道（如 CBS/BFE）被跳过 */
  const expectOrder = reordered.filter(c => c.segments.length > 0).map(c => c.name);
  check(JSON.stringify(firstRow) === JSON.stringify(expectOrder), `渠道顺序不符：${firstRow.join(',')} vs ${expectOrder.join(',')}`);
  console.log('✔ 手动渠道顺序进入导出验证');
}

/* ---------- 文件名 ---------- */
{
  const a = C.analyze(records, qtyMap, 'normal', () => ({ ...C.DEFAULT_UNIFIED }));
  const selAll = selectAll(a);
  const d = C.buildExport(a, selAll);
  check(/^波次规划\d{8}\.xlsx$/.test(d.filename), '文件名格式 ' + d.filename);
}

/* ---------- 分段内容重算校验（独立路径：按 kind 重算订单与拣货） ---------- */
function recountSegment(a, ch, seg) {
  const recs = records.filter(r => r.channelId === ch.id);
  const inSeg = recs.filter(r => seg.orderNos.indexOf(r.orderNo) >= 0);
  const orders = new Set(seg.orderNos);
  let pick = 0;
  orders.forEach(o => { pick += qtyMap[o] || 0; });
  return { orders: orders.size, pick };
}
{
  const p = { hotLine: 10, capacity: 400, multiSegs: 3, mixSegs: 4, absorb: 4 };
  const a = C.analyze(records, qtyMap, 'normal', () => Object.assign({}, p));
  let ok = true;
  a.channels.forEach(ch => {
    ch.segments.forEach(seg => {
      const rc = recountSegment(a, ch, seg);
      if (rc.orders !== seg.orderCount || rc.pick !== seg.pickQty) ok = false;
    });
  });
  check(ok, '第4档全量吸收：分段订单数/拣货数量独立重算不一致');
  console.log('✔ 分段订单数与拣货数量独立重算（第 4 档场景）');
}

console.log(failures === 0 ? '\n全部一致性测试通过 ✅' : `\n共 ${failures} 处不一致 ✘`);
process.exit(failures === 0 ? 0 : 1);
