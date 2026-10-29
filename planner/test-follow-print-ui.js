// 浏览器回归：生成按钮的跟随打印开关和关联任务展示；生产操作由模拟 API 替代。
'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
const mock=createMockServer({samplePath:T.paths(__dirname).sample,htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html')});
(async()=>{
 const site=await mock.listen();
 try{await T.withChrome({allowedOrigins:[site]},async chrome=>{
  const d=T.createDriver(await T.connectCdp({chrome}));
  await d.enablePage();await d.send('Page.navigate',{url:site+'/'});
  await d.poll('window.__dshTest && window.__dshTest.wms.available',true);
  T.assert(await d.evalJs(`document.getElementById('wmsFollowPrint').getAttribute('aria-pressed')`)==='false','默认关闭');
  const mode=await d.evalJs('window.__dshTest.wms.mode');
  await d.evalJs(`document.getElementById('wmsFollowPrint').click();true`);
  T.assert(await d.evalJs('window.__dshTest.wms.mode')===mode,'角标不切换任务');
  T.assert(mock.requests.length===0,'角标不启动任务');
  await d.send('Page.reload',{});
  await d.poll('window.__dshTest && window.__dshTest.wms.available',true);
  T.assert(await d.evalJs(`document.getElementById('wmsFollowPrint').getAttribute('aria-pressed')`)==='true','记住开关');
  await d.evalJs(T.importFileExpr(T.paths(__dirname).sample));
  await d.poll('window.__dshTest.state.records.length',5700);
  await d.evalJs(`document.getElementById('wmsWaves').value='MANUAL';document.getElementById('wmsGenerate').click();document.getElementById('wmsRun').click();true`);
  await d.poll('window.__dshTest.wms.active',true);
  T.assert(await d.evalJs(`document.getElementById('wmsFollowPrint').disabled`),'执行期间锁定');
  await d.poll(`!!document.querySelector('#wmsLog a[href$="/merged"]')`,true,180,500);
  const jobs=await (await fetch(site+'/api/jobs')).json();
  const parent=jobs.find(j=>j.mode==='generate_waves'),child=jobs.find(j=>j.generation_job_id);
  const plan=await (await fetch(site+'/api/jobs/'+parent.id+'/plan')).json();
  const refs=plan.snapshot.workbook.sheets.find(s=>s.name==='波次表').waveRefs;
  const expected=refs.filter(r=>['paper','mix'].includes(r.kind)).sort((a,b)=>a.row-b.row).map(r=>parent.result.segments.find(s=>s.channel===r.channel&&s.seg_name===r.seg_name).wave_no);
  T.assert(JSON.stringify(child.wave_nos)===JSON.stringify(expected),'跟随打印使用提交快照顺序，忽略手填输入');
  T.assert(!!parent.planning_export_file,'打印前已保存规划文件');
  await d.send('Page.reload',{});
  await d.poll(`!!document.querySelector('#wmsLog a[href$="/merged"]')`,true);
  T.assert((await (await fetch(site+'/api/jobs')).json()).length===2,'刷新不重复创建任务');
  console.log('✔ 跟随打印开关、记忆、锁定、自动衔接、顺序和恢复验证通过');
 });}finally{await mock.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
