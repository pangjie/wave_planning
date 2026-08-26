/* 核心逻辑回归测试（Node） */
'use strict';
const fs = require('fs');
const path = require('path');
global.XLSX = require(path.join(__dirname, 'vendor', 'xlsx.full.min.js'));
const C = require(path.join(__dirname, 'core.js'));

/* ---- 1. 线性分段 vs 暴力 DP ---- */
function brutePartition(items, k) {
  const n = items.length;
  const jmax = Math.min(k, n);
  const w = items.map(x => x.count);
  const pref = [0]; for (let i = 0; i < n; i++) pref.push(pref[i] + w[i]);
  const dp = Array.from({ length: n + 1 }, () => Array(jmax + 1).fill(Infinity));
  dp[0][0] = 0;
  for (let j = 1; j <= jmax; j++)
    for (let i = j; i <= n; i++)
      for (let m = j - 1; m < i; m++)
        dp[i][j] = Math.min(dp[i][j], Math.max(dp[m][j - 1], pref[i] - pref[m]));
  return dp[n][jmax];
}
function maxPart(parts) {
  return Math.max(...parts.map(p => p.reduce((s, x) => s + x.count, 0)));
}
function randTest() {
  for (let t = 0; t < 400; t++) {
    const n = 1 + Math.floor(Math.random() * 40);
    const k = 1 + Math.floor(Math.random() * 12);
    const items = Array.from({ length: n }, () => ({ count: 1 + Math.floor(Math.random() * 50) }));
    const parts = C.linearPartition(items, k);
    if (parts.length !== k) throw new Error('part count mismatch');
    // 顺序保持
    const flat = [].concat(...parts).map(x => x.count).join(',');
    const orig = items.map(x => x.count).join(',');
    if (flat !== orig) throw new Error('order broken');
    const got = maxPart(parts);
    const exp = brutePartition(items, k);
    if (got !== exp) throw new Error(`min-max mismatch: got ${got}, want ${exp}, items=${orig}, k=${k}`);
  }
  console.log('✔ linearPartition: 400 组随机对照暴力 DP 全部一致');
}
randTest();

/* ---- 2. 样本文件分析 ---- */
const wb = XLSX.read(fs.readFileSync(path.join(__dirname, '..', 'sample', 'ParcelOutbound_20260815193913.xlsx')), { type: 'buffer' });
const located = C.locateSheet(wb);
const { rows } = located;
console.log('工作表:', located.sheetName, '行数:', rows.length);
const hm = C.mapHeaders(rows[0]);
const { records, qtyMap } = C.buildRecords(rows.slice(1), hm);
console.log('有效记录:', records.length);

const a = C.analyze(records, qtyMap, 'normal', {});
const byId = {};
a.channels.forEach(c => (byId[c.id] = c));
function typeOrderStr(c) {
  return ['hot', 'paper', 'multi', 'mix'].map(t => c.byType[t].map(s => `${s.name}(${s.orderCount}单/${s.skuCount}SKU)`).join(',') || '-').join(' | ');
}
console.log('渠道:');
a.channels.forEach(c => {
  console.log(`  ${c.id}: 总数${c.total} 单品${c.singleCount} 多件${c.multiCount} 混件${c.mixCount} | 爆品SKU${c.hotSkuCount}/${c.hotOrderCount} 非爆SKU${c.paperSkuCount}/${c.paperOrderCount} | 分段: ` +
    typeOrderStr(c));
});
console.log('汇总:', JSON.stringify(a.totals));
console.log('波次统计:', JSON.stringify(a.waveStats));

/* 断言 */
function assert(cond, msg) { if (!cond) { console.error('✘ 断言失败: ' + msg); process.exit(1); } }
assert(records.length === 5700, '记录数应为 5700，实际 ' + records.length);
assert(a.totals.single === 4965 && a.totals.multi === 536 && a.totals.mix === 199, '类型统计不符');
const expectCh = { SwiftX: 1318, CBT: 1235, Gofo: 921, SpeedX: 796, USPS: 765, UPS: 341, Fedex: 136, YanWen: 125, CBS: 31, UniUni: 20, BFE: 2 };
Object.keys(expectCh).forEach(id => assert(byId[id] && byId[id].total === expectCh[id], `渠道 ${id} 应 ${expectCh[id]}，实际 ${byId[id] ? byId[id].total : '无'}`));
const chSum = a.channels.reduce((s, c) => s + c.total, 0);
assert(chSum === records.length, '渠道订单总数合计必须等于记录总数（不重不漏）: ' + chSum);
const typeSum = a.totals.single + a.totals.multi + a.totals.mix;
assert(typeSum === records.length, '三类合计必须等于记录总数: ' + typeSum);
console.log('✔ 样本文件：不重不漏（渠道合计=类型合计=5700）');

/* 分段不变量 */
a.channels.forEach(c => {
  /* 爆品/paper：普通段不超过容量（超大 SKU 段除外） */
  ['hot', 'paper'].forEach(t => {
    c.byType[t].forEach(s => {
      if (s.skuCount === 1) return; // 单个 SKU 段允许超容量
      assert(s.orderCount <= c.params.capacity, `${c.id} ${s.name} 超过容量: ${s.orderCount} > ${c.params.capacity}`);
    });
  });
  /* 多件：分段数 ≤ 多件分段数 */
  assert(c.byType.multi.length <= c.params.multiSegs, `${c.id} 多件分段数超限`);
  /* 混件：不同分段 SKU 互斥 */
  const mixSegs = c.byType.mix;
  for (let i = 0; i < mixSegs.length; i++)
    for (let j = i + 1; j < mixSegs.length; j++) {
      const si = new Set(mixSegs[i].skuPool.map(p => p.sku));
      const sj = mixSegs[j].skuPool.map(p => p.sku);
      assert(!sj.some(s => si.has(s)), `${c.id} 混件分段 ${mixSegs[i].name}/${mixSegs[j].name} SKU 有交集`);
    }
  /* 分段订单合计 = 渠道订单总数 */
  const segOrders = new Set();
  c.segments.forEach(s => s.orderNos.forEach(o => segOrders.add(o)));
  assert(segOrders.size === c.total, `${c.id} 分段订单数与总数不符: ${segOrders.size} vs ${c.total}`);
  /* 拣货数量 = 总数量合计 */
  const pick = c.segments.reduce((s, seg) => s + seg.pickQty, 0);
  const recs = records.filter(r => (r.channelId === c.id));
  const qtySum = recs.reduce((s, r) => s + r.qty, 0);
  assert(pick === qtySum, `${c.id} 拣货数量不符: ${pick} vs ${qtySum}`);
});
console.log('✔ 分段不变量：容量上限 / SKU 互斥 / 订单不重不漏 / 拣货数量');

/* ---- 3. 混件吸收各档位 ---- */
const cbt = byId.CBT;
const p1 = { ...C.DEFAULT_UNIFIED };
const cb1 = C.analyzeChannel('CBT', records.filter(r => r.channelId === 'CBT'), qtyMap, p1);
const cb2 = C.analyzeChannel('CBT', records.filter(r => r.channelId === 'CBT'), qtyMap, { ...p1, absorb: 2 });
const cb3 = C.analyzeChannel('CBT', records.filter(r => r.channelId === 'CBT'), qtyMap, { ...p1, absorb: 3 });
const cb4 = C.analyzeChannel('CBT', records.filter(r => r.channelId === 'CBT'), qtyMap, { ...p1, absorb: 4 });
console.log('CBT 各档位: 1档 多件' + cb1.byType.multi.length + ' 混件' + cb1.byType.mix.length +
  ' | 2档 多件' + cb2.byType.multi.length + ' 混件' + cb2.byType.mix.length +
  ' | 3档 多件' + cb3.byType.multi.length + ' 混件' + cb3.byType.mix.length +
  ' | 4档 多件' + cb4.byType.multi.length + ' paper' + cb4.byType.paper.length + ' 混件' + cb4.byType.mix.length);
assert(cb3.byType.multi.length === 0, '3 档后多件池应为空');
assert(cb4.byType.multi.length === 0 && cb4.byType.paper.length === 0, '4 档后多件/单件paper池应为空');
assert(cb4.byType.hot.length === cb1.byType.hot.length, '4 档爆品不应变化');
/* 2 档上限检查 */
cb2.byType.mix.forEach(s => assert(s.orderCount <= 70 + 200, '2 档混件段订单数异常'));
/* 各档订单总数不丢失 */
[cb1, cb2, cb3, cb4].forEach(cb => {
  const all = new Set();
  cb.segments.forEach(s => s.orderNos.forEach(o => all.add(o)));
  assert(all.size === cbt.total, '吸收后订单丢失');
});
console.log('✔ 混件吸收 4 档：池清空 / 爆品保留 / 订单不丢失');

/* ---- 4. 大类归并 ---- */
const am = C.analyze(records, qtyMap, 'merged', {});
console.log('归并渠道:', am.channels.map(c => `${c.id}:${c.total}`).join(', '));
assert(am.channels.every(c => ['CBT', 'CBS', '普通'].includes(c.id)), '归并渠道名非法');
const mSum = am.channels.reduce((s, c) => s + c.total, 0);
assert(mSum === 5700, '归并合计应 5700');
const normalCh = am.channels.find(c => c.id === '普通');
assert(normalCh.total === 4434, '普通渠道应 4434，实际 ' + normalCh.total);
console.log('✔ 大类归并：合计 5700，普通=4434');

/* ---- 4.5 合成数据：混件吸收边界 ---- */
function mkRecords(list) {
  return list.map((x, i) => ({
    orderNo: 'O' + (i + 1), type: x[0], carrier: '', sku1: x[1] || '', skus: x[2] || [x[1]],
    channelId: 'X', carrierClass: '普通订单', qty: x[3] || 1, excelRow: i + 2
  }));
}
function mkChannel(recs, p) { return C.analyzeChannel('X', recs, {}, p); }
{
  /* 场景 A：已有 SKU 吸收 70 边界；新增 SKU 60 边界（=可吸收，>整组拒绝）
     混件: {A,B}×10 + {B,C}×10 → 组件1(20单,A,B,C)；{F,G}×5 → 组件2(5单,F,G)，mixSegs=2
     多件序列(降序): A×80, D×56, E×55, B×50 —— 处理顺序从末尾: B, E, D, A
     第一阶段: B 已在组件1 → 20+50=70 等于上限 → 吸收(混件1=70)；A 已在组件1 → 70+80>70 → 拒绝
     第二阶段: E 新SKU → 最轻非空段为组件2(5) → 5+55=60 等于上限 → 吸收(混件2=60)；D → 60+56>60 → 拒绝 */
  const mix = [];
  for (let i = 0; i < 10; i++) mix.push(['多品混合', '', ['A', 'B']]);
  for (let i = 0; i < 10; i++) mix.push(['多品混合', '', ['B', 'C']]);
  for (let i = 0; i < 5; i++) mix.push(['多品混合', '', ['F', 'G']]);
  const multi = [];
  for (let i = 0; i < 80; i++) multi.push(['单品多件', 'A', [], 3]);
  for (let i = 0; i < 56; i++) multi.push(['单品多件', 'D', [], 3]);
  for (let i = 0; i < 55; i++) multi.push(['单品多件', 'E', [], 3]);
  for (let i = 0; i < 50; i++) multi.push(['单品多件', 'B', [], 3]);
  const ch2 = mkChannel(mkRecords(mix.concat(multi)), { ...C.DEFAULT_UNIFIED, multiSegs: 2, mixSegs: 2, absorb: 2 });
  assert(ch2.byType.mix.length === 2, `场景A 混件应 2 段，实际 ${ch2.byType.mix.length}`);
  const m1 = ch2.byType.mix[0], m2 = ch2.byType.mix[1];
  assert(m1.orderCount === 70, `场景A 混件1 应 70（20+50 等于上限），实际 ${m1.orderCount}`);
  assert(m2.orderCount === 60, `场景A 混件2 应 60（5+55 等于上限），实际 ${m2.orderCount}`);
  assert(m1.skuPool.map(p => p.sku).sort().join(',') === 'A,B,C', '场景A 混件1 SKU 应为 A,B,C');
  assert(m2.skuPool.map(p => p.sku).sort().join(',') === 'E,F,G', '场景A 混件2 SKU 应为 E,F,G');
  const bCnt = m1.skuPool.find(p => p.sku === 'B').count;
  assert(bCnt === 70, `场景A B 出现数应 70（20混件+50多件），实际 ${bCnt}`);
  const multiRemain = ch2.byType.multi.reduce((s, x) => s + x.orderCount, 0);
  assert(multiRemain === 80 + 56, `场景A 剩余多件应 136（A80+D56），实际 ${multiRemain}`);
  const multiSkus = [].concat(...ch2.byType.multi.map(s => s.skuPool.map(p => p.sku))).sort();
  assert(multiSkus.join(',') === 'A,D', '场景A 剩余多件 SKU 应为 A,D（整组不拆分）');
  console.log('✔ 合成：第2档 70/60 边界（=吸收，>整组拒绝，先已有SKU后新增SKU，选最轻段）');
}
{
  /* 场景 B：没有混件分段时第 2 档不吸收 */
  const multi = [];
  for (let i = 0; i < 10; i++) multi.push(['单品多件', 'A', [], 2]);
  const ch2 = mkChannel(mkRecords(multi), { ...C.DEFAULT_UNIFIED, mixSegs: 2, absorb: 2 });
  assert(ch2.byType.mix.length === 0 && ch2.byType.multi.length === 1, '场景B 无混件时不吸收');
  console.log('✔ 合成：无原始混件段时第 2 档不凭空建池');
}
{
  /* 场景 C：第 3 档全量吸收多件并重建（共享 SKU 合并组件） */
  const mix = [['多品混合', '', ['A', 'B']]];
  const multi = [['单品多件', 'B', [], 2], ['单品多件', 'B', [], 2], ['单品多件', 'D', [], 2]];
  const ch3 = mkChannel(mkRecords(mix.concat(multi)), { ...C.DEFAULT_UNIFIED, multiSegs: 3, mixSegs: 4, absorb: 3 });
  assert(ch3.byType.multi.length === 0, '场景C 多件池应空');
  assert(ch3.byType.mix.length === 2, `场景C 应 2 个混件段（B 并入 {A,B} 组件，D 独立），实际 ${ch3.byType.mix.length}`);
  const all = new Set(); ch3.segments.forEach(s => s.orderNos.forEach(o => all.add(o)));
  assert(all.size === 4, '场景C 4 单全部保留');
  console.log('✔ 合成：第 3 档重建混件池（共享 SKU 并组件）');
}
{
  /* 场景 D：第 4 档全量吸收非爆品 */
  const mix = [['多品混合', '', ['X']]];
  const paper = [['单品单件', 'P1', [], 1], ['单品单件', 'P1', [], 1], ['单品单件', 'P2', [], 1]];
  const hot = [];
  for (let i = 0; i < 10; i++) hot.push(['单品单件', 'H1', [], 1]);
  const multi = [['单品多件', 'M1', [], 5]];
  const ch4 = mkChannel(mkRecords(mix.concat(paper, hot, multi)), { hotLine: 5, capacity: 400, multiSegs: 2, mixSegs: 3, absorb: 4 });
  assert(ch4.byType.paper.length === 0 && ch4.byType.multi.length === 0, '场景D paper/多件池应空');
  assert(ch4.byType.hot.length === 1 && ch4.byType.hot[0].orderCount === 10, '场景D 爆品保留');
  const mixOrders = ch4.byType.mix.reduce((s, x) => s + x.orderCount, 0);
  assert(mixOrders === 1 + 3 + 1, `场景D 混件应 5 单，实际 ${mixOrders}`);
  const skusInMix = new Set(); ch4.byType.mix.forEach(s => s.skuPool.forEach(p => skusInMix.add(p.sku)));
  assert([...skusInMix].sort().join(',') === 'M1,P1,P2,X', '场景D 混件 SKU 应 M1,P1,P2,X');
  assert(ch4.singleSegMap.get('P1') && ch4.singleSegMap.get('P1').indexOf('混件') === 0, '场景D P1 应映射到混件段');
  assert(ch4.singleSegMap.get('H1').indexOf('爆品') === 0, '场景D H1 应映射到爆品段');
  console.log('✔ 合成：第 4 档全量吸收非爆品（paper/多件清空、爆品保留、SKU 映射正确）');
}

/* ---- 5. 导出工作簿 ---- */
const exportState = {
  channelSelected: new Set(a.channels.map(c => c.id)),
  segSelected: new Set()
};
a.channels.forEach(c => c.segments.forEach(s => exportState.segSelected.add(c.id + '|' + s.name)));
const exportData = C.buildExport(a, exportState);
assert(exportData && exportData.sheets.length === 8, '应导出 8 个工作表');
console.log('工作表顺序:', exportData.sheets.map(s => s.name).join(' → '));
assert(exportData.filename === '波次规划' + new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.xlsx', '文件名格式');
const outPath = path.join(__dirname, 'tmp', 'test-export.xlsx');
fs.writeFileSync(outPath, Buffer.from(C.buildXlsxBuffer(exportData.sheets)));
console.log('✔ 导出工作簿已生成: ' + outPath + '（' + exportData.filename + '）');

/* 导出过滤 */
const filtered = C.buildExport(a, { channelSelected: new Set(['CBT']), segSelected: new Set([...exportState.segSelected].filter(k => k.startsWith('CBT|爆品'))) });
assert(filtered && filtered.sheets.length === 8, '过滤后仍应有 8 个 sheet');
assert(C.buildExport(a, { channelSelected: new Set(), segSelected: exportState.segSelected }) === null, '未选渠道应返回 null');
console.log('✔ 三层导出过滤行为正确');

/* ---- 5.5 识别规则边界 ---- */
(function () {
  const tc = C.trackingChannel;
  assert(tc('SWX685110000141468083') === 'SwiftX', 'SWX21 应 SwiftX');
  assert(tc('swx68511000014146808') === '未识别', 'SWX 长度20 应未识别');
  assert(tc('SPXM123456789012345678901') === 'SpeedX', 'SP 任意长度应 SpeedX');
  assert(tc('YWNJC010168464270') === 'YanWen', 'YW17 应 YanWen');
  assert(tc('GFUS01058361007617') === 'Gofo', 'GF18 应 Gofo');
  assert(tc('1Z16E1H50317060838') === 'UPS', '1Z18 应 UPS');
  assert(tc('9200190419690867973789') === 'USPS', '9开头22位应 USPS');
  assert(tc('383100000001') === 'Fedex', '3开头12位数字应 Fedex');
  assert(tc('875700000001') === 'Fedex', '8开头12位数字应 Fedex');
  assert(tc('575700000001') === '未识别', '5开头12位应未识别');
  assert(tc('UUS68D7070532666053') === 'UniUni', 'U开头19位应 UniUni');
  assert(tc('CK123456789012345') === 'BFE', 'CK17 应 BFE');
  assert(tc('') === '未识别', '空跟踪号应未识别');
  console.log('✔ 物流跟踪号识别规则边界');

  /* 工作表定位 */
  const mk = (names) => ({ SheetNames: names, Sheets: {} });
  assert(C.locateSheet(mk(['拣货库位明细', '出库单'])).sheetName === '出库单', '精确匹配应优先');
  assert(C.locateSheet(mk(['出库单备份'])).sheetName === '出库单备份', '包含匹配应生效');
  let threw = false;
  try { C.locateSheet(mk(['订单明细'])); } catch (e) { threw = true; }
  assert(threw, '无出库单工作表应报错');
  console.log('✔ 出库单工作表定位规则');

  /* 表头变体：空格 / 换行 / 大小写 */
  const hdr = [' Outbound Order No/出库单号 ', 'Package 1\nTracking No./物流跟踪号', 'SKU 1\nSKU', 'SKU 2 SKU', 'SKU 12 SKU', 'Total Qty of SKU/总数量', 'Type of order variety/订单品种类型', 'Shipping Carrier/物流承运商'];
  const hm2 = C.mapHeaders(hdr);
  const idx = (n) => hm2.map[n];
  assert(idx('outboundorderno/出库单号') === 0, '带空格表头应识别');
  assert(idx('package1trackingno./物流跟踪号') === 1, '带换行表头应识别');
  assert(hm2.skuIdx.length === 3, '应识别 3 个 SKU 列，实际 ' + hm2.skuIdx.length);
  assert(hm2.skuIdx.map(s => s.n).join(',') === '1,2,12', 'SKU 列编号顺序应为 1,2,12');
  let threw2 = false;
  try { C.mapHeaders(['只有一列']); } catch (e) { threw2 = true; }
  assert(threw2, '缺列应报错');
  console.log('✔ 表头识别：空格/换行/SKU n SKU 自动发现/缺列报错');

  /* 数量解析 */
  assert(C.parseQty('1,234') === 1234, '逗号应移除');
  assert(C.parseQty('') === 0 && C.parseQty('abc') === 0 && C.parseQty('-3') === 0, '非法数量按 0');
  assert(C.parseQty(1) === 1, '数字类型直接解析');
  console.log('✔ 总数量解析规则');

  /* 空出库单号占位 */
  const recs = C.buildRecords([['', 'CBT', '单品单件', '9200190417705115343541', 'S1', 1]], {
    map: { 'outboundorderno/出库单号': 0, 'shippingcarrier/物流承运商': 1, 'typeofordervariety/订单品种类型': 2, 'package1trackingno./物流跟踪号': 3, 'sku1sku': 4, 'totalqtyofsku/总数量': 5 },
    skuIdx: [{ n: 1, ci: 4 }]
  });
  assert(recs.records.length === 1 && recs.records[0].orderNo === '第2行', '空出库单号应使用第N行占位');
  console.log('✔ 空出库单号占位（第N行）');

  /* 大类归并解析器（函数参数） */
  const am2 = C.analyze(records, qtyMap, 'merged', (id) => ({ hotLine: 7, capacity: 300, multiSegs: 2, mixSegs: 3, absorb: 2 }));
  assert(am2.channels.every(c => c.params.hotLine === 7 && c.params.capacity === 300), '解析器参数应生效');
  console.log('✔ 参数解析器（统一参数回退）');

  /* ---- 爆品单SKU超700拆分 ---- */
  const mkHot = (n, skuCount) => {
    const orderNos = Array.from({ length: n }, (_, i) => 'O' + i);
    const pool = Array.from({ length: skuCount }, (_, i) => ({ sku: 'SKU' + i, count: Math.ceil(n / skuCount) }));
    return { kind: 'hot', name: 'x', orderNos, orderCount: n, pickQty: n, skuPool: pool, skuCount };
  };
  const names = segs => segs.map(s => s.name + '(' + s.orderCount + ')').join(',');
  const flat = segs => segs.flatMap(s => s.orderNos);
  const qm = {};
  for (let i = 0; i < 1600; i++) qm['O' + i] = 1;

  // 800 单 单SKU → 2 段（400/400），每段 ≤700
  let hs = C.splitOversizedHotSegments([mkHot(800, 1)], qm);
  assert(names(hs) === '爆品1(400),爆品2(400)', '800单应拆成 400/400: ' + names(hs));
  assert(new Set(flat(hs)).size === 800, '拆分后订单不重不漏');

  // 1500 单 → 3 段（500/500/500）
  hs = C.splitOversizedHotSegments([mkHot(1500, 1)], qm);
  assert(names(hs) === '爆品1(500),爆品2(500),爆品3(500)', '1500单应拆成 3×500: ' + names(hs));

  // 1401 单 → 3 段（467/467/467）
  hs = C.splitOversizedHotSegments([mkHot(1401, 1)], qm);
  assert(names(hs) === '爆品1(467),爆品2(467),爆品3(467)', '1401单应拆成 3×467: ' + names(hs));
  assert(new Set(flat(hs)).size === 1401, '拆分后订单不重不漏');

  // 700 单 → 不拆；600 单（容量500场景）→ 不拆
  hs = C.splitOversizedHotSegments([mkHot(700, 1)], qm);
  assert(names(hs) === '爆品1(700)', '700单不应拆: ' + names(hs));
  hs = C.splitOversizedHotSegments([mkHot(600, 1)], qm);
  assert(names(hs) === '爆品1(600)', '600单（容量500）不应拆: ' + names(hs));

  // 800 单 但多SKU → 不拆
  const multi = mkHot(800, 2);
  hs = C.splitOversizedHotSegments([multi], qm);
  assert(hs.length === 1 && hs[0].orderCount === 800 && hs[0].skuCount === 2, '多SKU爆品段不应拆');

  // 混合序列重编号连续：600 / 800 / 500 → 爆品1(600), 爆品2(400), 爆品3(400), 爆品4(500)
  hs = C.splitOversizedHotSegments([mkHot(600, 1), mkHot(800, 1), mkHot(500, 1)], qm);
  assert(names(hs) === '爆品1(600),爆品2(400),爆品3(400),爆品4(500)', '混合序列编号应连续: ' + names(hs));
  assert(hs.every(s => s.orderCount <= 700), '拆分后每段都应 ≤700');
  console.log('✔ 爆品单SKU超700拆分（600/700/800/1401/1500/多SKU/混合编号）');
})();

console.log('\n全部核心测试通过 ✅');
