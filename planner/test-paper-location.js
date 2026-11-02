/* 单件库位优先核心回归：不依赖真实订单/库位表，全部合成数据。 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const core = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const ctx = {
  console, Map, Set, Array, Object, JSON, Math, Number, String, RegExp, Date,
  isFinite, parseInt, parseFloat, Int32Array, Float64Array, Infinity, NaN
};
vm.createContext(ctx);
vm.runInContext(core, ctx);

const HEAD = [
  'Outbound Order No/出库单号', 'Type of order variety/订单品种类型',
  'Shipping Carrier/物流承运商', 'Package 1\nTracking No./物流跟踪号',
  'SKU 1\nSKU', 'SKU 2\nSKU', 'Total Qty of SKU/总数量',
  'SKU 1\nRecommended Picking Location/推荐拣货库位1',
  'SKU 1\nRecommended Picking Location/推荐拣货库位2'
];
const rows = [HEAD];
function add(order, type, sku, loc, qty = '1', sku2 = '') {
  rows.push([order, type, 'CBT', 'SWX801780000226920621', sku, sku2, qty, loc, '']);
}
add('P1-1', '单品单件', 'P1', 'L1');
add('P1-2', '单品单件', 'P1', 'L1');
add('P2-1', '单品单件', 'P2', 'L1');
add('P3-1', '单品单件', 'P3', 'L2');
add('P3-2', '单品单件', 'P3', 'L2');
add('XN-1', '单品单件', 'P4', 'XN-1');
add('MISS-1', '单品单件', 'P5', 'MISSING');
for (let i = 0; i < 3; i++) add('H1-' + i, '单品单件', 'H1', 'L3');
for (let i = 0; i < 2; i++) add('M1-' + i, '单品多件', 'M1', 'L4', '2');
add('X1-1', '多品混合', 'X1', 'L5', '2', 'X2');

const hm = ctx.mapHeaders(rows[0]);
assert.strictEqual(JSON.stringify(hm.locIdx[1]), JSON.stringify([7, 8]), '库位列应被识别');
const br = ctx.buildRecords(rows.slice(1), hm);
assert.strictEqual(br.records.length, 13, '订单合并数');
const p1 = br.records.find(r => r.orderNo === 'P1-1');
assert.strictEqual(JSON.stringify([...p1.skuLocations.get('P1')]), JSON.stringify(['L1']), '订单应保留 SKU 库位');

const params = { hotLine: 3, capacity: 400, paperSegs: 2, multiSegs: 1, mixSegs: 1, absorb: 1 };
const locData = { version: 'test@1', priority: { L1: 300, L2: 200, L3: 100 }, nonPicking: ['XN-1'] };
const A = ctx.analyze(br.records, br.qtyMap, 'normal', () => params, false, 'sku', null);
const B = ctx.analyze(br.records, br.qtyMap, 'normal', () => params, false, 'location', locData);
const chA = A.channels.find(c => c.id === 'CBT');
const chB = B.channels.find(c => c.id === 'CBT');
const aPaper = chA.byType.paper.flatMap(s => s.orderNos).sort();
const bPaper = chB.byType.paper.flatMap(s => s.orderNos).sort();
assert.strictEqual(JSON.stringify(bPaper), JSON.stringify(aPaper), 'B 的单件订单集合必须等于 A');
assert.strictEqual(bPaper.length, 7, '单件订单数');
assert.strictEqual(new Set(bPaper).size, 7, 'B 无重复单件订单');
assert.strictEqual(JSON.stringify(B.warnings), JSON.stringify(['XN-1', 'MISSING']), '异常库位应告警');
// 同库位 L1 的 P1/P2 必须同段；同 SKU P3 两单必须同段。
function segOf(segments, no) {
  return segments.find(s => s.orderNos.indexOf(no) >= 0);
}
const sP1 = segOf(chB.byType.paper, 'P1-1');
const sP2 = segOf(chB.byType.paper, 'P2-1');
assert.strictEqual(sP1.name, sP2.name, '同一库位订单不得拆分');
const sP3a = segOf(chB.byType.paper, 'P3-1');
const sP3b = segOf(chB.byType.paper, 'P3-2');
assert.strictEqual(sP3a.name, sP3b.name, '同一 SKU 订单不得拆分');
// 异常分量进入最后一段。
const last = chB.byType.paper[chB.byType.paper.length - 1];
assert(last.orderNos.includes('XN-1') && last.orderNos.includes('MISS-1'), '异常订单应进入最后一段');
assert(chB.byType.hot.some(s => s.orderNos.includes('H1-0')), '爆品应在 hot 段');
assert(!chB.byType.paper.some(s => s.orderNos.includes('H1-0')), '爆品不得进入单件段');

// absorb=4：单件/多件都并入混件，B 不创建 paper/multi。
const p4 = { ...params, absorb: 4 };
const B4 = ctx.analyze(br.records, br.qtyMap, 'normal', () => p4, false, 'location', locData);
const ch4 = B4.channels.find(c => c.id === 'CBT');
assert.strictEqual(ch4.byType.paper.length, 0, 'absorb=4 不应有单件段');
assert.strictEqual(ch4.byType.multi.length, 0, 'absorb=4 不应有多件段');
const mixOrders = ch4.byType.mix.flatMap(s => s.orderNos);
assert(mixOrders.includes('P1-1') && mixOrders.includes('M1-0'), 'absorb=4 单件/多件应进混件');
assert.strictEqual(mixOrders.length, new Set(mixOrders).size, 'absorb=4 混件无重复');

// 类型断言必须拒绝“单件订单混入爆品段”这种矛盾。
const segs = chB.segments;
const hotSeg = chB.byType.hot[0];
const paperOrder = chB.byType.paper[0].orderNos[0];
const forged = [{ ...hotSeg, orderNos: hotSeg.orderNos.concat([paperOrder]) }];
assert.throws(() => ctx.assertSegmentKinds('CBT', chB.records || br.records, forged, chB.params), /不是爆品单件/);

console.log('✔ 库位列识别与订单库位保留');
console.log('✔ B 单件集合与 A 一致、无重复');
console.log('✔ 同库位/同 SKU 不拆、异常库位进最后一段并告警');
console.log('✔ absorb=4 不创建单件/多件段，订单进混件');
console.log('✔ 类型断言拒绝矛盾分段');
console.log('单件库位优先核心测试全部通过 ✅');
