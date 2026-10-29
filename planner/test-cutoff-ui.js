// 浏览器回归：截单配置、状态及文件加载入口；使用模拟服务，不提交真实截单。
'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
const run={id:'cutoff-1',cutoff:'2026-10-27T11:00:00Z',timezone:'America/New_York',status:'succeeded',
  filename:'截单订单_2026-10-27_0700.xlsx',events:[{at:'2026-10-27T11:01:00Z',message:'合并校验完成，点击加载分析。'}],current_events:[]};
const schedule={config:{enabled:false,cutoff_time:'07:00',timezone:'America/New_York',advance_minutes:30},
  next_cutoff:null,next_base:null,error:null,browser_busy:false,runs:[run]};
const mock=createMockServer({samplePath:T.paths(__dirname).sample,
  htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html'),schedule});
(async()=>{
  const site=await mock.listen();
  try {
    await T.withChrome({allowedOrigins:[site]},async chrome=>{
      const d=T.createDriver(await T.connectCdp({chrome}));
      await d.enablePage();await d.send('Page.navigate',{url:site+'/'});
      await d.poll(`!!document.querySelector('#cutoff-log-cutoff-1 a')`,true);
      T.assert(await d.evalJs('window.__dshTest.state.records.length')===0,'打开页面不自动加载');
      T.assert(await d.evalJs(`!document.getElementById('btnSchedule').classList.contains('scheduled-on')`),'停用无状态点');
      schedule.config.enabled=true;
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      T.assert(await d.evalJs(`document.getElementById('btnSchedule').classList.contains('scheduled-on')`),'启用正常显示状态点');
      run.status='failed';
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      T.assert(await d.evalJs(`!document.getElementById('btnSchedule').classList.contains('scheduled-on')`),'失败不显示正常状态');
      run.status='succeeded';schedule.error='调度异常';
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      T.assert(await d.evalJs(`!document.getElementById('btnSchedule').classList.contains('scheduled-on')`),'调度异常不显示正常状态');
      schedule.error=null;
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      T.assert(await d.evalJs(`!document.querySelector('#cutoff-log-cutoff-1 details')`),'侧栏不包含详细日志');
      await d.evalJs(`document.getElementById('btnLogDetails').click();true`);
      T.assert(await d.evalJs(`!document.getElementById('logDetailsPanel').hidden && document.getElementById('out').hidden`),'打开日志详情页面');
      run.events.push({at:'2026-10-27T11:02:00Z',message:'新增测试记录'});
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      T.assert(await d.evalJs(`document.getElementById('logDetailsContent').textContent.includes('新增测试记录')`),'详细日志实时更新');
      T.assert(await d.evalJs(`!document.getElementById('wmsLog').textContent.includes('新增测试记录')`),'详情不混入侧栏');
      await d.evalJs(`document.getElementById('btnSchedule').click();true`);
      T.assert(await d.evalJs(`document.getElementById('out').hidden && !document.getElementById('schedulePanel').hidden`),'配置页切换');
      T.assert(await d.evalJs(`document.getElementById('logDetailsPanel').hidden`),'页面切换互斥');
      for(const [width,height] of [[1440,1000],[390,844]]) {
        await d.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
        T.assert(await d.evalJs(`document.getElementById('schedulePanel').scrollWidth<=document.getElementById('schedulePanel').clientWidth+1`),'配置页无横向溢出');
      }
      await d.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
      if(process.env.CUTOFF_TEST_SHOTS) await T.captureShot(d.send,'cutoff-settings',process.env.CUTOFF_TEST_SHOTS);
      await d.evalJs(`document.getElementById('scheduleTime').value='08:00';document.getElementById('scheduleForm').dispatchEvent(new Event('input',{bubbles:true}));window.__dshTest.cutoffRefresh().then(()=>true)`);
      T.assert(await d.evalJs(`document.getElementById('scheduleTime').value`)==='08:00','轮询不覆盖编辑');
      await d.evalJs(`document.getElementById('scheduleForm').requestSubmit();true`);
      await d.poll(`document.getElementById('wmsLog').textContent.includes('定时截单配置已保存')`,true);
      T.assert(schedule.config.cutoff_time==='08:00','保存配置');
      schedule.browser_busy=true;
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      await d.evalJs(`document.querySelector('#cutoff-log-cutoff-1 a').click();true`);
      T.assert(mock.requests.filter(r=>r.mode==='cutoff_file').length===0,'执行中禁止加载');
      schedule.browser_busy=false;
      await d.evalJs('window.__dshTest.cutoffRefresh().then(()=>true)');
      await d.evalJs(`document.querySelector('#cutoff-log-cutoff-1 a').click();true`);
      await d.poll('window.__dshTest.state.records.length',5700);
      T.assert(await d.evalJs(`document.getElementById('schedulePanel').hidden && !document.getElementById('out').hidden`),'导入后返回规划');
      T.assert(mock.requests.filter(r=>r.mode==='cutoff_file').length===1,'一次点击仅读取一次');
      await d.evalJs(`document.getElementById('btnSchedule').click();document.getElementById('btnSchedule').click();true`);
      T.assert(await d.evalJs('window.__dshTest.state.records.length')===5700,'切换页面不丢规划');
      await d.send('Page.reload',{});
      await d.poll(`!!document.querySelector('#cutoff-log-cutoff-1 a')`,true);
      T.assert(await d.evalJs('window.__dshTest.state.records.length')===0,'刷新恢复链接，不自动导入');
      T.assert(await d.evalJs(`document.getElementById('scheduleTime').value`)==='08:00','刷新恢复配置');
      console.log('✔ 定时配置、编辑保护、日志恢复、一键加载、忙时保护与页面切换通过');
    });
  } finally {await mock.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
