// 浏览器回归：生成按钮的跟随打印开关和关联任务展示；生产操作由模拟 API 替代。
'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
const mock=createMockServer({samplePath:T.paths(__dirname).sample,htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html')});
const oldAt=new Date(Date.now()-2*86400000).toISOString();
mock.jobs.set('old-parent',{id:'old-parent',mode:'generate_waves',status:'succeeded',checkpoint_version:1,created_at:oldAt,
  follow_print:true,follow_print_state:'started',follow_print_job_id:'old-child',segments:[],events:[],result:{segments:[]}});
mock.jobs.set('old-child',{id:'old-child',mode:'print_waves',status:'succeeded',generation_job_id:'old-parent',checkpoint_version:1,
  created_at:new Date(Date.now()-2*86400000+60000).toISOString(),wave_nos:[],print_files:{},events:[],result:{}});
(async()=>{
 const site=await mock.listen();
 try{await T.withChrome({allowedOrigins:[site]},async chrome=>{
  const d=T.createDriver(await T.connectCdp({chrome}));
  await d.enablePage();
  await d.send('Page.addScriptToEvaluateOnNewDocument',{source:`window.__runFlash=[];document.addEventListener('DOMContentLoaded',function(){var b=document.getElementById('wmsRun');if(!b)return;new MutationObserver(function(){if(!b.disabled)window.__runFlash.push({text:b.textContent,t:Date.now()});}).observe(b,{attributes:true,attributeFilter:['disabled'],childList:true,subtree:true,characterData:true});});`});
  await d.send('Page.navigate',{url:site+'/'});
  await d.poll('window.__dshTest && window.__dshTest.wms.available',true);
  await T.sleep(3500);
  T.assert(await d.evalJs(`window.__dshTest.wms.mode===null && document.getElementById('wmsRun').disabled === true`),'历史跟随打印完成不应激活开始任务');
  T.assert(await d.evalJs(`window.__runFlash.length===0`),'刷新后开始任务不应闪到可用: '+await d.evalJs(`JSON.stringify(window.__runFlash)`));
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
  // 700 单前置检查：默认 1 段会让大渠道超限并禁用开始任务。
  await d.evalJs(`window.__dshTest.setUnifiedParam('paperSegs', 2)`);
  T.assert(await d.evalJs(`window.__dshTest.paperLimitState()`)===null,'测试准备：单件段不应超过 700');
  await d.evalJs(`document.getElementById('wmsWaves').value='MANUAL';document.getElementById('wmsGenerate').click();document.getElementById('wmsRun').click();true`);
  await d.poll('window.__dshTest.wms.active',true);
  T.assert(await d.evalJs(`document.getElementById('wmsFollowPrint').disabled`),'执行期间锁定');
  await d.poll(`!!document.querySelector('#wmsLog a[href$="/merged"]')`,true,180,500);
  const jobs=await (await fetch(site+'/api/jobs')).json();
  const parent=jobs.find(j=>j.mode==='generate_waves' && j.id!=='old-parent'),child=jobs.find(j=>j.generation_job_id && j.generation_job_id!=='old-parent');
  const plan=await (await fetch(site+'/api/jobs/'+parent.id+'/plan')).json();
  const refs=plan.snapshot.workbook.sheets.find(s=>s.name==='波次表').waveRefs;
  const expected=refs.filter(r=>['paper','mix'].includes(r.kind)).sort((a,b)=>a.row-b.row).map(r=>parent.result.segments.find(s=>s.channel===r.channel&&s.seg_name===r.seg_name).wave_no);
  T.assert(JSON.stringify(child.wave_nos)===JSON.stringify(expected),'跟随打印使用提交快照顺序，忽略手填输入');
  T.assert(!!parent.planning_export_file,'打印前已保存规划文件');
  await d.send('Page.reload',{});
  await d.poll(`!!document.querySelector('#wmsLog a[href$="/merged"]')`,true);
  const after=await (await fetch(site+'/api/jobs')).json();
  T.assert(after.filter(j=>j.id!=='old-parent'&&j.id!=='old-child').length===2,'刷新不重复创建任务');
  console.log('✔ 跟随打印开关、记忆、锁定、自动衔接、顺序和恢复验证通过');
 });}finally{await mock.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
