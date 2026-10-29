// 竞态回归：分别延迟任务/截单响应，并用大量历史日志制造滚动溢出。
// 不仅断言节点存在，还验证截单标题和加载链接在日志视口内可见。
'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
(async()=>{
 for(const slowPath of ['/api/jobs','/api/schedule']){
  const schedule={config:{enabled:false,cutoff_time:'13:00',advance_minutes:30,timezone:'America/New_York'},runs:[{id:'ready',cutoff:'2026-10-27T17:00:00Z',timezone:'America/New_York',status:'succeeded',filename:'截单订单_2026-10-27_1300.xlsx',events:[],current_events:[]}],browser_busy:false};
  const mock=createMockServer({samplePath:T.paths(__dirname).sample,htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html'),schedule,responseDelays:{[slowPath]:300}});
  mock.jobs.set('finished',{id:'finished',mode:'print_waves',status:'succeeded',created_at:'2026-10-27T12:00:00-04:00',events:[],wave_nos:['W1'],result:{merged_file:'result.pdf'}});
  for(let i=0;i<25;i++) mock.jobs.set('history-'+i,{...mock.jobs.get('finished'),id:'history-'+i});
  const site=await mock.listen();
  try{await T.withChrome({allowedOrigins:[site]},async chrome=>{
   const d=T.createDriver(await T.connectCdp({chrome}));await d.enablePage();
   await d.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
   await d.send('Page.navigate',{url:site+'/'});
   await d.poll(`!!document.querySelector('#cutoff-log-ready a') && !!document.querySelector('#wmsLog a[href$="/merged"]')`,true,15,100);
   const visible=`(()=>{const log=document.getElementById('wmsLog').getBoundingClientRect(),card=document.getElementById('cutoff-log-ready'),title=card.querySelector('.jobhead').getBoundingClientRect(),link=card.querySelector('a').getBoundingClientRect();return title.top>=log.top&&title.bottom<=log.bottom&&link.top<log.bottom;})()`;
   await d.poll(visible,true,15,100);
   await d.evalJs(`window.savedCutoffNode=document.getElementById('cutoff-log-ready');window.__dshTest.wms.restoredIds.clear();window.__dshTest.wmsRestore().then(()=>true)`);
   T.assert(await d.evalJs(`document.getElementById('cutoff-log-ready')===window.savedCutoffNode && window.savedCutoffNode.isConnected`),'恢复普通任务不删除已显示的截单记录');
   await d.evalJs(`window.__dshTest.wmsRestore().then(()=>true)`);
   T.assert(await d.evalJs(`document.querySelectorAll('#cutoff-log-ready').length===1`),'重复恢复不复制截单记录');
   T.assert(await d.evalJs(visible),'大量历史日志恢复后，截单标题和加载入口在窗口可视区域');
   console.log('✔ '+slowPath+' 延迟返回时，截单记录立即保留，不依赖下轮5秒轮询');
  });}finally{await mock.close();}
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
