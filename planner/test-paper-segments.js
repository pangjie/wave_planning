// 纯计算回归：单件按段数均衡、同 SKU 不拆、爆品容量不限制单件，以及订单守恒。
'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const C=require('./core.js');
function fixture(){
 const records=[],qtyMap={};let seq=0;
 function add(n,sku,type='单品单件',skus=[sku],channelId='USPS-H'){
  for(let i=0;i<n;i++){const orderNo='ORDER'+(++seq);const qty=type==='单品单件'?1:3;
   records.push({orderNo,type,sku1:sku,skus,qty,channelId,carrier:'USPS',carrierClass:'普通订单'});qtyMap[orderNo]=qty;
  }
 }
 for(let i=0;i<240;i++) add(4,'S'+i);
 add(30,'HOT');add(8,'S1','单品多件');add(5,'S2','多品混合',['S2','S3']);
 return {records,qtyMap};
}
function conserved(ch,records,qtyMap){
 const all=ch.segments.flatMap(s=>s.orderNos);
 assert.equal(all.length,new Set(all).size,'各最终分段不重单');
 assert.deepEqual(new Set(all),new Set(records.map(r=>r.orderNo)),'订单集合完全一致');
 assert.equal(ch.segments.reduce((sum,s)=>sum+s.pickQty,0),records.reduce((sum,r)=>sum+qtyMap[r.orderNo],0));
}
test('单件默认1段，容量只影响爆品；指定2段得到480/480，SKU不拆散',()=>{
 const {records,qtyMap}=fixture();
 const a=C.analyzeChannel('USPS-H',records,qtyMap,{...C.DEFAULT_UNIFIED,capacity:100});
 const b=C.analyzeChannel('USPS-H',records,qtyMap,{...C.DEFAULT_UNIFIED,capacity:800});
 assert.deepEqual(a.byType.paper,b.byType.paper);assert.equal(a.byType.paper.length,1);assert.equal(a.byType.paper[0].orderCount,960);
 const two=C.analyzeChannel('USPS-H',records,qtyMap,{...C.DEFAULT_UNIFIED,paperSegs:2});
 assert.deepEqual(two.byType.paper.map(s=>s.orderCount),[480,480]);
 const skus=two.byType.paper.flatMap(s=>s.skuPool.map(p=>p.sku));assert.equal(skus.length,new Set(skus).size);
 conserved(two,records,qtyMap);
 const legacy=C.analyzeChannel('USPS-H',records,qtyMap,{capacity:400,hotLine:10,multiSegs:1,mixSegs:1,absorb:1});
 assert.equal(legacy.params.paperSegs,1);
});
test('各段数、吸收档位、空池和过量段数均无漏单重单，结果稳定',()=>{
 const {records,qtyMap}=fixture();
 for(const paperSegs of [1,2,3,7,260]) for(const absorb of [1,2,3,4]){
  const params={...C.DEFAULT_UNIFIED,paperSegs,absorb,multiSegs:3,mixSegs:3};
  const ch=C.analyzeChannel('USPS-H',records,qtyMap,params);conserved(ch,records,qtyMap);
  assert.deepEqual(ch.segments,C.analyzeChannel('USPS-H',records,qtyMap,params).segments);
  assert.equal(ch.byType.paper.length,absorb===4?0:Math.min(paperSegs,240));
  assert.ok(ch.segments.every(s=>s.orderCount>0));
 }
 assert.equal(C.analyzeChannel('USPS-H',[],{}, {...C.DEFAULT_UNIFIED,paperSegs:100}).segments.length,0);
});
test('H/G关闭分段转入普通后，激活输出集合不重不漏；归并也守恒',()=>{
 const {records,qtyMap}=fixture();
 records.forEach((r,i)=>r.channelId=i%2?'USPS-H':'USPS-G');
 const resolve=()=>({...C.DEFAULT_UNIFIED,paperSegs:3});
 const base=C.analyze(records,qtyMap,'normal',resolve,true);
 const channels=new Set(base.channels.map(c=>c.id)),selected=new Set(base.channels.flatMap(c=>c.segments.map(s=>c.id+'|'+s.name)));
 selected.delete('USPS-H|单件paper-2');selected.delete('USPS-G|单件paper-1');
 const evolved=C.buildOrdinaryEvolvedAnalysis(base,records,qtyMap,resolve,channels,selected);
 const ordinary=evolved.channels.find(c=>c.id==='普通');
 const active=evolved.channels.flatMap(c=>c.segments.filter(s=>c.id==='普通'||selected.has(c.id+'|'+s.name)).flatMap(s=>s.orderNos));
 assert.equal(active.length,new Set(active).size);assert.deepEqual(new Set(active),new Set(records.map(r=>r.orderNo)));
 assert.equal(ordinary.params.paperSegs,3);
 const merged=C.analyze(records,qtyMap,'merged',resolve,true).channels.find(c=>c.id==='普通');conserved(merged,records,qtyMap);
});
