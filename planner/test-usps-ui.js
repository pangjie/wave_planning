'use strict';
const T = require('./test-helpers.js');
T.withChrome({}, async chrome => {
  const d = T.createDriver(await T.connectCdp({chrome}));
  await d.enablePage();
  const url = T.paths(__dirname).html;
  await d.send('Page.navigate',{url});
  await d.poll('document.readyState','complete');
  await d.evalJs(`(function(){
    function pic(stc) { var s='92'+stc+'0000000000000000',sum=0; for(var i=s.length-1,w=3;i>=0;i--,w=4-w)sum+=Number(s[i])*w; return s+((10-sum%10)%10); }
    var rows=[['Outbound Order No/出库单号','Type of order variety/订单品种类型','Shipping Carrier/物流承运商','Package 1 Tracking No./物流跟踪号','SKU 1 SKU','Total Qty of SKU/总数量'],['H','单品单件','USPS',pic('184'),'A',1],['G','单品单件','USPS',pic('144'),'B',1]];
    var wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(rows),'出库单');
    window.__dshTest.handleFile(new File([XLSX.write(wb,{type:'array',bookType:'xlsx'})],'usps.xlsx')); return true;
  })()`);
  await d.poll('window.__dshTest.state.records.length',2);
  T.assert(await d.evalJs(`!!document.querySelector('.chn[data-ch="USPS-H"]') && !!document.querySelector('.chn[data-ch="USPS-G"]') && !document.querySelector('.chn[data-ch="USPS"]')`),'默认开启');
  async function hold(id, cancel) {
    await d.evalJs(`document.querySelector('.chn[data-ch="${id}"]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse',button:0,clientX:100,clientY:100})); true`);
    if(cancel) await d.evalJs(`document.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,clientX:150,clientY:150})); true`);
    await T.sleep(3200);
    await d.evalJs(`document.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1})); true`);
  }
  await hold('USPS-H',true);
  T.assert(await d.evalJs('window.__dshTest.state.uspsSplit'),'移动取消长按');
  await hold('USPS-H');
  T.assert(await d.evalJs(`!window.__dshTest.state.uspsSplit && !!document.querySelector('.chn[data-ch="USPS"]')`),'H 长按关闭');
  await hold('USPS');
  T.assert(await d.evalJs('window.__dshTest.state.uspsSplit'),'USPS 长按开启');
  await hold('USPS-G');
  T.assert(await d.evalJs('!window.__dshTest.state.uspsSplit'),'G 长按关闭');
  await d.send('Page.reload',{});
  await d.poll('document.readyState','complete');
  T.assert(await d.evalJs('!window.__dshTest.state.uspsSplit'),'刷新记住关闭');
  console.log('✔ USPS 默认细分、长按 H/G 关闭、长按 USPS 开启、移动取消、刷新记忆');
}).catch(e=>{console.error(e);process.exitCode=1;});
