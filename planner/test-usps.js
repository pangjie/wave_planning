'use strict';
const assert = require('node:assert/strict');
const C = require('./core.js');
function pic(stc, length = 22, prefix = '92') {
  const body = prefix + stc + '0'.repeat(length - 6);
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = 4-w) sum += Number(body[i])*w;
  return body + ((10-sum%10)%10);
}
assert.equal(C.USPS_H_STCS.size, 43);
for (const stc of C.USPS_H_STCS) for (const len of [22,26]) for (const prefix of ['92','93','94','95']) {
  const p = pic(stc,len,prefix);
  for (const raw of [p, '42012345'+p, '420123456789'+p, ' '+p.slice(0,5)+'\n'+p.slice(5)]) assert.equal(C.uspsType(raw),'USPS-H');
  assert.equal(C.uspsType(p.slice(0,-1)+((Number(p.at(-1))+1)%10)), 'USPS-G');
}
for (const s of ['001','144','359','346','349']) assert.equal(C.uspsType(pic(s)), 'USPS-G');
for (const raw of [null,undefined,'',Number(pic('184')),pic('184').slice(1),'abc'+pic('184'),'９２１８４', '1'+pic('184'), '4201234'+pic('184')]) assert.equal(C.uspsType(raw),'USPS-G');
const headers = ['Outbound Order No/出库单号','Type of order variety/订单品种类型','Shipping Carrier/物流承运商','Package 1 Tracking No./物流跟踪号','SKU 1 SKU','Total Qty of SKU/总数量'];
const rows = [['H','单品单件','USPS',pic('184'),'A',1],['G','单品单件','USPS',pic('144'),'B',1],['H','单品单件','USPS',pic('144'),'C',1],['C','单品单件','CBT',pic('184'),'D',1]];
const {records,qtyMap} = C.buildRecords(rows,C.mapHeaders(headers));
C.applyUspsSubdivision(records,true);
assert.deepEqual(records.map(r=>r.channelId),['USPS-H','USPS-G','CBT']);
const analysis = C.analyze(records,qtyMap,'normal',{},true);
assert.equal(C.residentChannels(analysis).length,12);
assert.ok(!analysis.channels.some(c=>c.id==='USPS'));
const ordered = C.sortByFixed(analysis.channels.slice(),'normal').filter(c=>c.total).map(c=>c.id);
assert.deepEqual(ordered,['CBT','USPS-H','USPS-G']);
const merged = C.analyze(records,qtyMap,'merged',{},true);
assert.equal(merged.channels.find(c=>c.id==='普通').total,2);
const selected = new Set(['CBT','USPS-G']);
const segs = new Set(analysis.channels.flatMap(c=>c.segments.map(s=>c.id+'|'+s.name)));
const ordinary = C.buildOrdinaryEvolvedAnalysis(analysis,records,qtyMap,()=>C.DEFAULT_UNIFIED,selected,segs);
assert.equal(ordinary.channels.find(c=>c.id==='普通').total,1);
const allChannels = new Set(analysis.channels.map(c=>c.id));
const withoutG = new Set([...segs].filter(k=>!k.startsWith('USPS-G|')));
assert.equal(C.buildOrdinaryEvolvedAnalysis(analysis,records,qtyMap,()=>C.DEFAULT_UNIFIED,allChannels,withoutG).channels.find(c=>c.id==='普通').total,1);
const withoutBoth = new Set([...segs].filter(k=>!/^USPS-[HG]\|/.test(k)));
assert.equal(C.buildOrdinaryEvolvedAnalysis(analysis,records,qtyMap,()=>C.DEFAULT_UNIFIED,allChannels,withoutBoth).channels.find(c=>c.id==='普通').total,2);
assert.deepEqual(C.customerChannelIds([],true).slice(0,3),['CBT','USPS-H','USPS-G']);
C.applyUspsSubdivision(records,false);
assert.deepEqual(records.map(r=>r.channelId),['USPS','USPS','CBT']);
assert.deepEqual(rows[0][3],pic('184'));
console.log('USPS：43 STC × 2 长度 × 4 前缀、路由、校验、重复订单、归并、吸收、排序通过');
