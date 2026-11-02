/* 单件库位优先 UI 回归：合成订单 + 本地注入库位表；不依赖真实仓库数据。 */
'use strict';
const fs = require('fs');
const path = require('path');
const XLSX = require('./vendor/xlsx.full.min.js');
const T = require('./test-helpers.js');
const { assert, sleep } = T;

const P = T.paths(__dirname);
const HEAD = [
  'Outbound Order No/出库单号', 'Type of order variety/订单品种类型',
  'Shipping Carrier/物流承运商', 'Package 1\nTracking No./物流跟踪号',
  'SKU 1\nSKU', 'SKU 2\nSKU', 'Total Qty of SKU/总数量',
  'SKU 1\nRecommended Picking Location/推荐拣货库位1'
];
const rows = [HEAD];
function add(order, type, sku, loc, qty = '1', sku2 = '') {
  rows.push([order, type, 'CBT', 'SWX801780000226920621', sku, sku2, qty, loc]);
}
// 101 个 SKU × 7 单共享同一库位：每个 SKU 仍是单件（< hotLine），
// 但库位原子分量 707 单，用于验证 B 的分段池超过 700。
for (let i = 0; i < 101; i++) {
  for (let j = 0; j < 7; j++) add('P700-' + i + '-' + j, '单品单件', 'P700-' + i, 'L700');
}
add('P1-1', '单品单件', 'P1', 'L1');
add('P1-2', '单品单件', 'P1', 'L1');
add('P2-1', '单品单件', 'P2', 'L1');
add('P3-1', '单品单件', 'P3', 'L2');
add('P3-2', '单品单件', 'P3', 'L2');
add('XN-1', '单品单件', 'P4', 'XN-1');
add('MISS-1', '单品单件', 'P5', 'MISSING');
for (let i = 0; i < 10; i++) add('H1-' + i, '单品单件', 'H1', 'L3');
for (let i = 0; i < 2; i++) add('M1-' + i, '单品多件', 'M1', 'L4', '2');
add('X1-1', '多品混合', 'X1', 'L5', '2', 'X2');
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '出库单');
const synPath = P.tmp('paper-location-ui.xlsx');
fs.writeFileSync(synPath, XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
const LOC = {
  version: 'ui-test@1', source: 'synthetic', count: 4,
  nonPicking: ['XN-1'], priority: { L1: 300, L2: 200, L700: 100, L3: 50 }
};

(async () => {
  await T.withChrome({}, async chrome => {
    const ws = await T.connectCdp({ chrome });
    const drv = T.createDriver(ws, { pollTries: 200 });
    const { send, evalJs, poll } = drv;
    await drv.enablePage();
    const injected = await send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.LOCATION_PRIORITY_DATA=' + JSON.stringify(LOC) + ';'
    });
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 950, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: P.html });
    await poll('document.readyState', 'complete');
    await poll('window.__dshTest && window.__dshTest.state.locationReady', true, 100, 100);
    assert(await evalJs('document.querySelector(".paper-strategy-btn").dataset.strategy') === 'sku', '默认应为 SKU 均衡');
    await evalJs(T.importFileExpr(synPath));
    await poll('window.__dshTest.state.records.length', 727, 100, 100);
    const aPaper = await evalJs(`(function(){var a=window.__dshTest.curAnalysis();var n=0;a.channels.forEach(function(c){c.byType.paper.forEach(function(s){n+=s.orderCount;});});return n;})()`);
    assert(aPaper === 714, 'A 单件订单数应为 714，实际 ' + aPaper);

    await evalJs(`window.__dshTest.setUnifiedParam('paperSegs', 2)`);
    await evalJs(`document.querySelector('.paper-strategy-btn').click()`);
    await poll('window.__dshTest.state.paperStrategy', 'location', 100, 100);
    await sleep(300);
    const info = JSON.parse(await evalJs(`(function(){
      var a=window.__dshTest.curAnalysis(), m=window.__dshTest.state.modes.normal;
      var paper=0, unique=new Set(), mismatch=[], last=null, l1=null, p3=null, warn=document.getElementById('wmsLog').textContent;
      a.channels.forEach(function(c){
        c.byType.paper.forEach(function(s){
          paper+=s.orderCount; s.orderNos.forEach(function(no){unique.add(no);});
          if(noIn(s,'XN-1')&&noIn(s,'MISS-1')) last=s.name;
          if(noIn(s,'P1-1')&&noIn(s,'P2-1')) l1=s.name;
          if(noIn(s,'P3-1')&&noIn(s,'P3-2')) p3=s.name;
          var el=document.querySelector('.seg-line[data-seg="'+CSS.escape(c.id+'|'+s.name)+'"]');
          if(!el||el.textContent.indexOf(String(s.orderCount))<0||el.textContent.indexOf(String(s.skuPool.length))<0) mismatch.push(c.id+'|'+s.name);
        });
      });
      function noIn(s,no){return s.orderNos.indexOf(no)>=0;}
      return JSON.stringify({paper:paper,unique:unique.size,last:last,l1:l1,p3:p3,warn:warn,mismatch:mismatch,
        button:document.querySelector('.paper-strategy-btn').dataset.strategy});
    })()`));
    console.log('UI B', {paper: info.paper, unique: info.unique, last: info.last, l1: info.l1, p3: info.p3, warning: info.warn.slice(0, 70), mismatch: info.mismatch.length});
    assert(info.paper === 714 && info.unique === 714, 'B 单件订单守恒');
    assert(info.last && info.l1 && info.p3, '库位/SKU 原子或异常最后一段失败');
    assert(info.warn.indexOf('XN-1') >= 0 && info.warn.indexOf('MISSING') >= 0, '异常库位 warning 缺失');
    assert(info.mismatch.length === 0, 'DOM 与 analysis 不一致');
    assert(info.button === 'location', '策略按钮状态');
    assert(info.l1 !== info.last && info.p3 !== info.last, 'B 应生成两个单件段');

    // 选择生成模式后按钮应禁用；不改任何计划。
    await evalJs(`document.getElementById('wmsGenerate').click()`);
    await sleep(300);
    const lim = JSON.parse(await evalJs(`JSON.stringify({mode:window.__dshTest.wms.mode,disabled:document.getElementById('wmsRun').disabled,title:document.getElementById('wmsRun').title,hit:window.__dshTest.paperLimitState()})`));
    assert(lim.mode === 'generate_waves' && lim.disabled === true && lim.hit && lim.hit.count > 700 && lim.title.indexOf('700') >= 0, '700 未前置禁用: ' + JSON.stringify(lim));
    console.log('✔ B 策略、DOM、warning、700 前置禁用通过');

    // 9 表导出
    const exp = JSON.parse(await evalJs(`(function(){var d=window.__dshTest.buildExportNow();return JSON.stringify(d?{sheets:d.sheets.map(function(s){return s.name;}),waveRefs:d.sheets.find(function(s){return s.name==='波次表';}).waveRefs.length}:null);})()`));
    assert(exp && exp.sheets.length === 9, '9 表导出失败');

    // 离线：移除注入脚本，刷新后 B 不可用，A 正常导入。
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: injected.identifier });
    await send('Page.navigate', { url: P.html });
    await poll('document.readyState', 'complete');
    await poll('!!window.__dshTest', true);
    const off = JSON.parse(await evalJs(`JSON.stringify({ready:window.__dshTest.state.locationReady,strategy:window.__dshTest.state.paperStrategy,disabled:document.querySelector('.paper-strategy-btn').disabled})`));
    assert(off.ready === false && off.strategy === 'sku' && off.disabled === true, '离线页面应只支持 A: ' + JSON.stringify(off));
    await evalJs(T.importFileExpr(synPath));
    await poll('window.__dshTest.state.records.length', 727, 100, 100);
    assert(await evalJs(`window.__dshTest.curAnalysis().channels.reduce(function(n,c){return n+c.byType.paper.reduce(function(m,s){return m+s.orderCount;},0);},0)`) === 714, '离线 A 单件数');
    console.log('✔ 离线单文件 A-only 降级通过');
    console.log('单件库位优先 UI 测试全部通过 ✅');
  });
})().catch(e => { console.error('✘ 测试失败:', e.message); process.exitCode = 1; });
