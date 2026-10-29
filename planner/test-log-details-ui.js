// 浏览器回归：简要日志与日志详情分工，关键状态保留，耗时等细节仅在详情展示。
'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
// 刻意混用时区、拼接乱序事件及晚于实际开始的截单时间，避免仅 reverse() 蒙混过关。
const schedule={config:{enabled:false,cutoff_time:'16:00',timezone:'America/New_York',advance_minutes:30},runs:[{
 id:'cutoff-order',cutoff:'2026-10-27T20:00:00Z',status:'waiting',timezone:'America/New_York',
 events:[{at:'2026-10-27T17:30:00Z',message:'截单开始'},{at:'2026-10-27T17:40:00Z',message:'截单阶段完成'},{at:'2026-10-27T13:35:00-04:00',message:'截单旧事件'}],
 current_events:[{at:'2026-10-27T17:45:00Z',message:'截单最新事件'},{message:'无时间提示'}]
}],browser_busy:false};
const mock=createMockServer({samplePath:T.paths(__dirname).sample,htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html'),schedule});
const job={id:'logs-test',mode:'print_waves',status:'failed',checkpoint_version:1,attempt:2,created_at:'2026-10-27T14:12:43-04:00',wave_nos:['W1','W2'],print_files:{W1:{}},events:[
 {at:'2026-10-27T14:12:43-04:00',stage:'download_timing',message:'耗时分解：定位 121ms，文件接收 291ms。'},
 {at:'2026-10-27T14:12:44-04:00',stage:'failed',message:'模拟打印节点失败：W2，已保留 W1。'}]};
mock.jobs.set(job.id,job);
mock.jobs.set('older-test',{...job,id:'older-test',created_at:'2026-10-27T19:00:00+02:00'});
(async()=>{const site=await mock.listen();try{await T.withChrome({allowedOrigins:[site]},async chrome=>{
 const d=T.createDriver(await T.connectCdp({chrome}));await d.enablePage();await d.send('Page.navigate',{url:site+'/'});
 await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
 T.assert(await d.evalJs(`document.getElementById('wmsLog').contains(document.getElementById('wmsRetryProgress'))`),'进度在日志窗口内');
 T.assert(await d.evalJs(`!document.getElementById('wmsLog').textContent.includes('121ms') && !document.getElementById('wmsLog').textContent.includes('14:12:43')`),'侧栏不显示耗时和秒数');
 await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
 await d.poll(`document.getElementById('logDetailsContent').textContent.includes('121ms')`,true);
 T.assert(await d.evalJs(`document.getElementById('logDetailsContent').textContent.includes('模拟打印节点失败')`),'完整故障保留');
 await d.poll(`!!document.querySelector('[data-log-id="cutoff-order"]')`,true);
 const checkOrder=async()=>{
  T.assert(await d.evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.log-task')).map(s=>s.dataset.logId).filter(id=>id!=='page-notices'))`)==='["logs-test","cutoff-order","older-test"]','任务按真实开始时刻倒序，正确比较时区');
  T.assert(await d.evalJs(`document.querySelector('[data-log-id="logs-test"] .log-event p').textContent.includes('模拟打印节点失败')`),'组内最新失败先于较早耗时');
  T.assert(await d.evalJs(`JSON.stringify(Array.from(document.querySelectorAll('[data-log-id="cutoff-order"] .log-event p')).map(p=>p.textContent))`)==='["截单最新事件","截单阶段完成","截单旧事件","截单开始","无时间提示"]','截单拼接事件统一倒序，无时间事件置末');
  T.assert(await d.evalJs(`document.querySelector('[data-log-id="logs-test"] time').textContent===new Date('2026-10-27T14:12:44-04:00').toLocaleString('zh-CN',{hour12:false})`),'统一按本机时区显示');
 };
 await checkOrder();
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
 await d.poll(`!!document.querySelector('[data-log-id="cutoff-order"]')`,true);
 await checkOrder();
 console.log('✔ 简要日志、窗口内进度、完整详情、响应式布局和刷新恢复通过');
});}finally{await mock.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
