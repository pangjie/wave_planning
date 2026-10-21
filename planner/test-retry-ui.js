'use strict';
const path = require('path');
const T = require('./test-helpers.js');
const {createMockServer} = require('./mock-wms-server.js');
const attempts=[];
const mock=createMockServer({samplePath:T.paths(__dirname).sample,
  htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html'),
  retryHandler(original,body){
    T.assert(body.confirm_production===true,'明确确认');
    attempts.push(original.id);
    return {...original,id:'round-'+attempts.length,parent_id:original.id,attempt:original.attempt+1,status:'running',
      created_at:new Date(Date.now()+attempts.length*1000).toISOString(),events:[],result:null};
  }});
const root={id:'original',mode:'print_waves',status:'failed',checkpoint_version:1,attempt:1,
  created_at:new Date().toISOString(),wave_nos:['W1','W2'],print_files:{W1:{path:'mock.pdf',sha256:'x'}},events:[],result:null};
mock.jobs.set(root.id,root);
(async()=>{
  const site=await mock.listen();
  try {
    await T.withChrome({allowedOrigins:[site]},async chrome=>{
      const d=T.createDriver(await T.connectCdp({chrome}));
      await d.enablePage();
      await d.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      await d.send('Page.navigate',{url:site+'/'});
      await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
      await d.evalJs('document.fonts.ready.then(()=>true)');
      T.assert(await d.evalJs(`getComputedStyle(document.getElementById('wmsNewTask')).display !== 'none'`),'新建入口可见');
      const logHeights=[];
      for (const [width,height] of [[1440,1100],[1440,1400],[1440,1100],[1440,700],[390,844]]) {
        await d.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
        await d.evalJs('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');
        T.assert(await d.evalJs(`(()=>{
          const progress=document.getElementById('wmsRetryProgress'),log=document.getElementById('wmsLog');
          const section=document.getElementById('wmsSection').getBoundingClientRect(),p=progress.getBoundingClientRect();
          log.textContent='短日志';
          const shortHeight=log.offsetHeight;
          log.textContent=('测试日志\\n').repeat(300);
          const before=log.getBoundingClientRect();
          log.scrollTop=log.scrollHeight;
          return getComputedStyle(progress).textAlign==='center' && p.width>0 &&
            Math.abs(p.left+p.width/2-section.left-section.width/2)<1 &&
            log.offsetHeight>=160 && log.offsetHeight===shortHeight && log.scrollHeight>log.clientHeight && log.scrollTop>0 &&
            (innerWidth>900 || log.offsetHeight<=320) &&
            before.right<=innerWidth && before.height===log.getBoundingClientRect().height;
        })()`),'轮次居中、日志扩高且内部滚动，无横向溢出：'+width+'×'+height);
        logHeights.push(await d.evalJs(`document.getElementById('wmsLog').offsetHeight`));
        if(width>900 && height>=1100) T.assert(await d.evalJs(`(()=>{const side=document.querySelector('.side');return side.scrollHeight<=side.clientHeight+1;})()`),'高屏幕侧栏无需额外滚动');
      }
      T.assert(logHeights[1]-logHeights[0]===300 && logHeights[2]===logHeights[0],'日志完整利用剩余空间并随窗口伸缩：'+logHeights.join(','));
      T.assert(logHeights[3]===160,'低屏幕保留最低可读高度');
      await d.send('Emulation.clearDeviceMetricsOverride');
      await d.evalJs(`document.getElementById('wmsWaves').value='CHANGED';document.getElementById('wmsRun').click(); true`);
      await d.poll(`document.getElementById('wmsRun').textContent`,'取消任务');
      T.assert(attempts[0]==='original','使用原任务');
      T.assert(await d.evalJs(`window.__dshTest.wms.job.wave_nos.join(',')`)==='W1,W2','不读取当前文本框');
      mock.jobs.get('round-1').status='failed';
      await d.evalJs('window.__dshTest.wmsPollOnce().then(()=>true)');
      await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
      await d.send('Page.reload',{});
      await d.poll(`document.getElementById('wmsRun').textContent`,'重试任务');
      await d.evalJs(`document.getElementById('wmsRun').click(); true`);
      await d.poll(`document.getElementById('wmsRun').textContent`,'取消任务');
      T.assert(attempts[1]==='round-1','刷新恢复最新轮次');
      mock.jobs.get('round-2').status='succeeded';
      await d.evalJs('window.__dshTest.wmsPollOnce().then(()=>true)');
      await d.poll(`document.getElementById('wmsRun').textContent`,'开始任务');
      T.assert(await d.evalJs(`getComputedStyle(document.getElementById('wmsNewTask')).display === 'none'`),'完成后隐藏新建入口');
      console.log('✔ 失败重试、运行取消、再次失败、刷新恢复、原输入绑定和完成按钮均正确');
    });
  } finally {await mock.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
