// 浏览器回归：简要日志与日志详情分工，关键状态保留，耗时等细节仅在详情展示。
'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
const now=new Date();
function atToday(h,m){const d=new Date(now);d.setHours(h,m,0,0);return d.toISOString();}
const todayIso=now.toISOString();
const yesterdayIso=new Date(now.getTime()-86400000).toISOString();
const logEventOld=new Date(now.getTime()-2000).toISOString();
const logEventFail=new Date(now.getTime()-1000).toISOString();
const schedule={config:{enabled:false,cutoff_time:'16:00',timezone:'America/New_York',advance_minutes:30},runs:[{
 id:'cutoff-order',cutoff:atToday(9,0),status:'waiting',timezone:'America/New_York',
 events:[{at:atToday(8,30),message:'截单开始'},{at:atToday(8,40),message:'截单阶段完成'},{at:atToday(8,35),message:'截单旧事件'}],
 current_events:[{at:atToday(8,45),message:'截单最新事件'},{message:'无时间提示'}]
}],browser_busy:false};
const mock=createMockServer({samplePath:T.paths(__dirname).sample,htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html'),schedule});
const job={id:'logs-test',mode:'print_waves',status:'failed',checkpoint_version:1,attempt:2,created_at:todayIso,wave_nos:['W1','W2'],print_files:{W1:{}},events:[
 {at:logEventOld,stage:'download_timing',message:'耗时分解：定位 121ms，文件接收 291ms。'},
 {at:logEventFail,stage:'failed',message:'模拟打印节点失败：W2，已保留 W1。'}]};
mock.jobs.set(job.id,job);
mock.jobs.set('older-test',{...job,id:'older-test',created_at:yesterdayIso});
(async()=>{const site=await mock.listen();try{await T.withChrome({allowedOrigins:[site]},async chrome=>{
 const d=T.createDriver(await T.connectCdp({chrome}));await d.enablePage();await d.send('Page.navigate',{url:site+'/'});
 await d.poll(`!!document.querySelector('#wmsLog .retry-hint a')`,true);
 await d.evalJs(`document.querySelector('#wmsLog .retry-hint a').click()`);
 await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
 T.assert(await d.evalJs(`document.getElementById('wmsLog').contains(document.getElementById('wmsRetryProgress'))`),'进度在日志窗口内');
 T.assert(await d.evalJs(`!document.getElementById('wmsLog').textContent.includes('121ms') && !document.getElementById('wmsLog').textContent.includes('14:12:43')`),'侧栏不显示耗时和秒数');
 await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
 await d.poll(`document.getElementById('logDetailsContent').textContent.includes('121ms')`,true);
 T.assert(await d.evalJs(`document.getElementById('logDetailsContent').textContent.includes('模拟打印节点失败')`),'完整故障保留');
 T.assert((await d.evalJs(`document.getElementById('logDetailsStatus').textContent`)).indexOf('默认显示当天')>=0,'日志详情应提示默认当天');
 T.assert(await d.evalJs(`!document.querySelector('[data-log-id="older-test"]')`),'默认不应显示前一天日志');
 T.assert(await d.evalJs(`!!document.querySelector('[data-log-id="cutoff-order"]')`),'当天截单日志应默认显示');
 T.assert(await d.evalJs(`document.querySelector('#logLoadMore') && document.getElementById('logDetailsContent').lastElementChild.id === 'logLoadMore'`),'底部应有加载更多按钮');
 T.assert(await d.evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.log-task')).map(s=>s.dataset.logId).filter(id=>id!=='page-notices'))`)==='["logs-test","cutoff-order"]','默认只显示当天任务');
 await d.evalJs(`document.getElementById('logLoadMore').click();true`);
 await d.poll(`!!document.querySelector('[data-log-id="older-test"]')`,true);
 T.assert(await d.evalJs(`!document.getElementById('logLoadMore')`),'全部可见后应移除加载更多');
 await d.evalJs(`document.getElementById('logDetailsPanel').scrollTop=document.getElementById('logDetailsPanel').scrollHeight;true`);
 const checkOrder=async()=>{
  T.assert(await d.evalJs(`JSON.stringify(Array.from(document.querySelectorAll('.log-task')).map(s=>s.dataset.logId).filter(id=>id!=='page-notices'))`)==='["logs-test","cutoff-order","older-test"]','任务按真实开始时刻倒序，正确比较时区');
  T.assert(await d.evalJs(`document.querySelector('[data-log-id="logs-test"] .log-event p').textContent.includes('模拟打印节点失败')`),'组内最新失败先于较早耗时');
  T.assert(await d.evalJs(`JSON.stringify(Array.from(document.querySelectorAll('[data-log-id="cutoff-order"] .log-event p')).map(p=>p.textContent))`)==='["截单最新事件","截单阶段完成","截单旧事件","截单开始","无时间提示"]','截单拼接事件统一倒序，无时间事件置末');
  T.assert(await d.evalJs(`document.querySelector('[data-log-id="logs-test"] time').textContent===new Date(${JSON.stringify(logEventFail)}).toLocaleString('zh-CN',{hour12:false})`),'统一按本机时区显示');
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
 await d.poll(`!!document.getElementById('wmsRun')`,true);
 await d.poll(`window.__dshTest && window.__dshTest.wms && window.__dshTest.wms.available`,true);
 await d.poll(`!!document.querySelector('#wmsLog .retry-hint a')`,true);
 await d.evalJs(`document.querySelector('#wmsLog .retry-hint a').click()`);
 await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
 await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
 await d.poll(`document.getElementById('logDetailsContent').textContent.includes('模拟打印节点失败')`,true);
 await d.poll(`!!document.querySelector('[data-log-id="cutoff-order"]')`,true);
 T.assert(await d.evalJs(`!document.querySelector('[data-log-id="older-test"]')`),'刷新后默认仍不显示前一天');
 T.assert(await d.evalJs(`!!document.getElementById('logLoadMore')`),'刷新后仍应在底部提供加载更多');
 await d.evalJs(`document.getElementById('logLoadMore').click();true`);
 await d.poll(`!!document.querySelector('[data-log-id="older-test"]')`,true);
 await checkOrder();
 console.log('✔ 简要日志、窗口内进度、完整详情、响应式布局和刷新恢复通过');
});}finally{await mock.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
