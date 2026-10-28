'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
const mock=createMockServer({samplePath:T.paths(__dirname).sample,htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html')});
const job={id:'logs-test',mode:'print_waves',status:'failed',checkpoint_version:1,attempt:2,created_at:'2026-10-27T14:12:43-04:00',wave_nos:['W1','W2'],print_files:{W1:{}},events:[
 {at:'2026-10-27T14:12:43-04:00',stage:'download_timing',message:'耗时分解：定位 121ms，文件接收 291ms。'},
 {at:'2026-10-27T14:12:44-04:00',stage:'failed',message:'模拟打印节点失败：W2，已保留 W1。'}]};
mock.jobs.set(job.id,job);
(async()=>{const site=await mock.listen();try{await T.withChrome({allowedOrigins:[site]},async chrome=>{
 const d=T.createDriver(await T.connectCdp({chrome}));await d.enablePage();await d.send('Page.navigate',{url:site+'/'});
 await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
 T.assert(await d.evalJs(`document.getElementById('wmsLog').contains(document.getElementById('wmsRetryProgress'))`),'进度在日志窗口内');
 T.assert(await d.evalJs(`!document.getElementById('wmsLog').textContent.includes('121ms') && !document.getElementById('wmsLog').textContent.includes('14:12:43')`),'侧栏不显示耗时和秒数');
 await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
 await d.poll(`document.getElementById('logDetailsContent').textContent.includes('121ms')`,true);
 T.assert(await d.evalJs(`document.getElementById('logDetailsContent').textContent.includes('模拟打印节点失败')`),'完整故障保留');
 for(const width of [1440,390]){
  await d.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
  T.assert(await d.evalJs(`document.getElementById('logDetailsPanel').scrollWidth <= document.getElementById('logDetailsPanel').clientWidth+1`),'详情无横向溢出');
 }
 await d.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
 if(process.env.LOG_TEST_SHOTS) await T.captureShot(d.send,'log-details',process.env.LOG_TEST_SHOTS);
 await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
 T.assert(await d.evalJs(`!document.getElementById('out').hidden`),'返回规划');
 await d.send('Page.reload',{});
 await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
 await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
 await d.poll(`document.getElementById('logDetailsContent').textContent.includes('模拟打印节点失败')`,true);
 console.log('✔ 简要日志、窗口内进度、完整详情、响应式布局和刷新恢复通过');
});}finally{await mock.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
