// 浏览器回归：单件参数调整与重新勾选、渠道开关保持，以及导出参数一致性。
'use strict';
const T=require('./test-helpers.js');
(async()=>{await T.withChrome({},async chrome=>{
 const d=T.createDriver(await T.connectCdp({chrome}));await d.enablePage();await d.send('Page.navigate',{url:T.paths(__dirname).html});
 await d.poll('document.readyState','complete');await d.evalJs(T.importFileExpr(T.paths(__dirname).sample));await d.poll('window.__dshTest.state.records.length',5700);
 const click=async selector=>d.evalJs(`document.querySelector(${JSON.stringify(selector)}).click();true`);
 const paper=()=>d.evalJs(`JSON.stringify(window.__dshTest.curAnalysis().channels.find(c=>c.id==='SwiftX').byType.paper.map(s=>s.orderNos))`);
 const original=await paper();
 T.assert(JSON.parse(original).length===1 && JSON.parse(original)[0].length===850,'默认1段，超过原容量仍保留全部订单');
 await click('.arr-r[data-ch="SwiftX"][data-p="capacity"]');T.assert(await paper()===original,'容量不改变单件');
 await click('[data-seg="SwiftX|单件paper-1"]');
 await d.evalJs(`window.__dshTest.toggleOrdinaryEvolution();true`);
 await click('.arr-r[data-ch="SwiftX"][data-p="paperSegs"]');
 T.assert(JSON.parse(await paper()).length===2,'独立调整单件段数');
 T.assert(await d.evalJs(`window.__dshTest.curAnalysis().channels.find(c=>c.id==='SwiftX').byType.paper.every(s=>window.__dshTest.state.modes.normal.sel.segs.has('SwiftX|'+s.name))`),'重新划分后不继承关闭状态');
 T.assert(await d.evalJs(`(()=>{const api=window.__dshTest,a=api.curAnalysis(),m=api.state.modes.normal;const ids=a.channels.filter(c=>m.sel.channels.has(c.id)).flatMap(c=>c.segments.filter(s=>m.sel.segs.has(c.id+'|'+s.name)).flatMap(s=>s.orderNos));return ids.length===new Set(ids).size;})()`),'普通吸收重新计算，无重单');
 await click('.chn[data-ch="SwiftX"]');
 await click('.arr-r[data-ch="SwiftX"][data-p="paperSegs"]');
 T.assert(await d.evalJs(`!window.__dshTest.state.modes.normal.sel.channels.has('SwiftX')`),'关闭渠道仍保持关闭');
 await click('.arr-r[data-ch=""][data-p="paperSegs"]');
 T.assert(await d.evalJs(`window.__dshTest.curAnalysis().channels.every(c=>c.params.paperSegs===2)`),'统一调整覆盖H/G和普通');
 T.assert(await d.evalJs(`window.__dshTest.buildExportNow().sheets.some(s=>s.aoa.some(row=>row[0]==='单件分段数'))`),'规划导出包含新参数');
 await d.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1100,deviceScaleFactor:1,mobile:false});
 T.assert(await d.evalJs(`Array.from(document.querySelectorAll('.stepper')).every(el=>{const a=el.getBoundingClientRect(),b=el.parentElement.getBoundingClientRect();return a.left>=b.left && a.right<=b.right;})`),'参数控件不溢出单元格');
 if(process.env.PAPER_TEST_SHOTS) await T.captureShot(d.send,'paper-segments',process.env.PAPER_TEST_SHOTS);
 console.log('✔ 单件分段参数、容量独立、勾选重置、普通吸收、导出和布局验证通过');
});})().catch(e=>{console.error(e);process.exitCode=1;});
