'use strict';
const path=require('path');
const T=require('./test-helpers.js');
const {createMockServer}=require('./mock-wms-server.js');
const mock=createMockServer({samplePath:T.paths(__dirname).sample,
  htmlSource:path.join(__dirname,'..','wms/project/frontend/dist/index.html')});
(async()=>{
  const site=await mock.listen();
  try {
    await T.withChrome({allowedOrigins:[site]},async chrome=>{
      const d=T.createDriver(await T.connectCdp({chrome}));
      await d.enablePage();
      await d.send('Page.navigate',{url:site+'/'});
      await d.poll('window.__dshTest && window.__dshTest.wms.available',true);
      await d.evalJs(T.importFileExpr(T.paths(__dirname).sample));
      await d.poll('window.__dshTest.state.records.length',5700);
      const expected=JSON.parse(await d.evalJs(`JSON.stringify((function(){
        var api=window.__dshTest; api.buildExportNow();
        var n=0; api.curAnalysis().channels.forEach(function(ch){ch.segments.forEach(function(s){api.state.waveNos.set(ch.id+'|'+s.name,'W'+(++n));});});
        return api.buildExportNow().sheets.find(function(s){return s.name==='波次表';}).aoa.filter(function(r){return r[3]==='单件paper'||r[3]==='混件paper';}).map(function(r){return r[2];});
      })())`));
      T.assert(expected.length>0,'自动清单非空');
      await d.evalJs(`document.getElementById('wmsPrint').click();document.getElementById('wmsWaves').value=' ';document.getElementById('wmsRun').click();true`);
      await d.poll(`window.__dshTest.wms.job && window.__dshTest.wms.job.status`,'succeeded');
      const request=mock.requests.find(r=>r.mode==='print_waves');
      T.assert(JSON.stringify(request.wave_nos)===JSON.stringify(expected),'清单严格等于波次表筛选顺序');
      T.assert(await d.evalJs(`document.getElementById('wmsWaves').value.trim()`)==='','输入框保持空白');
      T.assert(await d.evalJs(`document.getElementById('wmsLog').textContent.includes('自动取自当前规划')`),'日志标明自动来源');
      console.log('✔ 自动打印 '+expected.length+' 个单件/混件波次，含 USPS 细分，提交顺序与波次表一致');
    });
  } finally {await mock.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
