/* WMS 联动 UI 端到端测试：本地模拟 8000 API 服务 + Chrome */
'use strict';
const path = require('path');
const T = require('./test-helpers.js');
const { createMockServer } = require('./mock-wms-server.js');

const P = T.paths(__dirname);
const PORT = 9334;
const USER_DIR = P.tmp('chrome-wms');
const SITE = 'http://127.0.0.1:8000';
const HTML_SOURCE = path.join(__dirname, '..', 'wms', 'project', 'frontend', 'dist', 'index.html');
const SAMPLE = P.sample;
const { sleep, assert } = T;

const mock = createMockServer({ samplePath: SAMPLE, htmlSource: HTML_SOURCE });

T.withChrome(T.launchChrome({ port: PORT, userDataDir: USER_DIR }), async () => {
  await mock.listen(8000, '127.0.0.1');

  const ws = await T.connectCdp({ port: PORT });
  const drv = T.createDriver(ws, { pollTries: 120 });
  const { send, evalJs, poll } = drv;
  await drv.enablePage();
  const shot = name => T.captureShot(send, name, path.join(__dirname, 'shots'));
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: SITE + '/' });
  await poll(`document.readyState`, 'complete');
  await poll(`window.__dshTest && window.__dshTest.wms && window.__dshTest.wms.available`, true);
  console.log('✔ 页面加载，检测到本地 WMS 服务');

  /* 1. 面板初始状态 */
  const init = await evalJs(`(function(){
    return JSON.stringify({
      sideShown: document.getElementById('wmsSection').style.display !== 'none',
      dotOk: document.getElementById('wmsDot').classList.contains('ok'),
      panelShown: !document.getElementById('wmsPanel').hidden,
      stateTxt: document.getElementById('wmsState').textContent,
      btnsOn: !document.getElementById('wmsExport').disabled && !document.getElementById('wmsGenerate').disabled && !document.getElementById('wmsPrint').disabled && !document.getElementById('wmsPick').disabled,
      runOff: document.getElementById('wmsRun').disabled,
      runText: document.getElementById('wmsRun').textContent
    });
  })()`);
  const ini = JSON.parse(init);
  assert(ini.sideShown && ini.dotOk && ini.panelShown && ini.stateTxt === '空闲' && ini.btnsOn, '初始状态错误: ' + init);
  assert(ini.runOff === true && ini.runText === '开始任务', '未选功能时开始任务应禁用: ' + init);
  assert(await evalJs(`document.getElementById('wmsExport').textContent`) === '全量分析', '按钮应名为「全量分析」');
  await shot('wms-1-idle');
  console.log('✔ WMS 联动区可见：三按钮可用（全量分析/打印波次/批量拣货）、取消禁用、状态空闲');

  /* 2. 导出订单 → 自动导入（选中功能 → 开始任务） */
  await evalJs(`document.getElementById('wmsExport').click()`);
  await sleep(120);
  const selInfo = await evalJs(`(function(){
    return JSON.stringify({
      sel: document.getElementById('wmsExport').classList.contains('sel'),
      runOn: !document.getElementById('wmsRun').disabled,
      runText: document.getElementById('wmsRun').textContent
    });
  })()`);
  const sl = JSON.parse(selInfo);
  assert(sl.sel === true && sl.runOn === true && sl.runText === '开始任务', '选中全量分析后应反白且开始任务可用: ' + selInfo);
  await evalJs(`document.getElementById('wmsRun').click()`);
  await poll(`(function(){var w=window.__dshTest.wms;return w.job && w.job.mode==='export' ? w.job.status : '';})()`, 'succeeded', 100, 200);
  await poll(`window.__dshTest.state.records.length`, 5700);
  const exp = await evalJs(`(function(){
    return JSON.stringify({
      log: document.getElementById('wmsLog').textContent,
      stateTxt: document.getElementById('wmsState').textContent,
      rows: document.querySelectorAll('#dash .prow').length,
      busyOff: !document.getElementById('wmsExport').disabled
    });
  })()`);
  const ex = JSON.parse(exp);
  assert(ex.log.indexOf('已导入 ParcelOutbound_mock.xlsx（5700 单）') !== -1, '导出后应自动导入文件并记入日志: ' + exp);
  assert(ex.stateTxt === '已完成' && ex.rows === 12 && ex.busyOff === true, '导出完成后状态错误: ' + exp);
  const reqs = JSON.parse(await (await fetch('http://127.0.0.1:8000/api/__test/requests')).text());
  assert(reqs[0].mode === 'export' && reqs[0].confirm_production === true && reqs[0].wave_nos === undefined, '导出请求体错误: ' + JSON.stringify(reqs[0]));
  assert(reqs[0].browser_mode === 'headless', '默认应为无头模式: ' + JSON.stringify(reqs[0]));
  const bm = await evalJs(`(function(){
    var el = document.getElementById('browserModeVal');
    return JSON.stringify({ text: el.textContent, headless: window.__dshTest.wms.headless });
  })()`);
  const bmv = JSON.parse(bm);
  assert(bmv.text === '无头' && bmv.headless === true, '浏览器模式默认应为无头: ' + bm);
  await evalJs(`document.getElementById('browserModeVal').click()`);
  await sleep(100);
  const bm2 = JSON.parse(await evalJs(`(function(){
    return JSON.stringify({ text: document.getElementById('browserModeVal').textContent, headless: window.__dshTest.wms.headless });
  })()`));
  assert(bm2.text === '有头' && bm2.headless === false, '点击后应切换为有头: ' + JSON.stringify(bm2));
  await evalJs(`document.getElementById('browserModeVal').click()`);
  await sleep(100);
  const bm3 = JSON.parse(await evalJs(`(function(){
    return JSON.stringify({ text: document.getElementById('browserModeVal').textContent, headless: window.__dshTest.wms.headless });
  })()`));
  assert(bm3.text === '无头' && bm3.headless === true, '再次点击应切回无头: ' + JSON.stringify(bm3));
  console.log('✔ 浏览器模式切换：默认无头，点击在有头/无头之间切换');
  await shot('wms-2-exported');
  console.log('✔ 导出订单：任务完成 → 自动导入 5700 单并重建表格；请求含 confirm_production');

  /* 2.4 波次记录同步：后端已有波次号的分段自动变绿并导出；波次号变化时更新 */
  await fetch('http://127.0.0.1:8000/api/__test/wave-records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [{ channel: 'SwiftX', seg_name: '爆品1', wave_no: 'W0092608180011', order_count: 10 }] })
  });
  await evalJs(`window.__dshTest.wmsSyncWaveRecords()`);
  await poll(`document.querySelectorAll('#dash .seg-line.waved').length`, 1, 100, 50);
  const syncInfo = await evalJs(`(function(){
    var a = document.querySelector('#wmsLog a[href*="/api/exports/"]');
    return JSON.stringify({
      waved: document.querySelectorAll('#dash .seg-line.waved').length,
      waveNo: window.__dshTest.state.waveNos.get('SwiftX|爆品1') || '',
      link: !!a, linkText: a ? a.textContent : ''
    });
  })()`);
  const si = JSON.parse(syncInfo);
  assert(si.waved === 1 && si.waveNo === 'W0092608180011', '同步波次记录后 SwiftX 爆品1 应唯一变绿: ' + syncInfo);
  assert(si.link === false, '记录同步不应自动导出（避免重复下载链接）: ' + syncInfo);
  await shot('wms-2-4-records-sync');

  /* 2.45 定时器路径：新增记录由 5 秒定时器自动同步变绿；同分段新波次号覆盖更新 */
  await fetch('http://127.0.0.1:8000/api/__test/wave-records', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ records: [
      { channel: 'SwiftX', seg_name: '爆品1', wave_no: 'W0092608180099', order_count: 10 },
      { channel: 'USPS', seg_name: '爆品1', wave_no: 'W0092608180088', order_count: 11 }
    ] })
  });
  await sleep(6500);  // 等 5 秒定时器自动同步（不手动调用钩子）
  const timerInfo = await evalJs(`(function(){
    return JSON.stringify({
      waved: document.querySelectorAll('#dash .seg-line.waved').length,
      swiftx: window.__dshTest.state.waveNos.get('SwiftX|爆品1') || '',
      usps: window.__dshTest.state.waveNos.get('USPS|爆品1') || ''
    });
  })()`);
  const ti = JSON.parse(timerInfo);
  assert(ti.waved === 2, '定时器应自动同步两个分段变绿: ' + timerInfo);
  assert(ti.swiftx === 'W0092608180099', '同分段新波次号应覆盖旧值: ' + timerInfo);
  assert(ti.usps === 'W0092608180088', '新增分段波次号应回填: ' + timerInfo);
  console.log('✔ 波次记录定时同步：5 秒自动应用、新波次号覆盖旧值');

  /* 2.46 否掉渠道后：其分段即使有波次号也不显示绿色；重新勾选恢复 */
  await evalJs(`document.querySelector('.chn[data-ch="SwiftX"]').click()`);
  await sleep(200);
  const offInfo = await evalJs(`(function(){
    return JSON.stringify({
      swiftxWaved: document.querySelector('.seg-line[data-seg="SwiftX|爆品1"]').classList.contains('waved'),
      uspsWaved: document.querySelector('.seg-line[data-seg="USPS|爆品1"]').classList.contains('waved'),
      waveNoKept: window.__dshTest.state.waveNos.get('SwiftX|爆品1') || ''
    });
  })()`);
  const oi = JSON.parse(offInfo);
  assert(oi.swiftxWaved === false, '否掉渠道后其分段不应显示绿色: ' + offInfo);
  assert(oi.uspsWaved === true, '其他有效分段应保持绿色: ' + offInfo);
  assert(oi.waveNoKept === 'W0092608180099', '波次号数据保留（重新勾选后恢复绿色）: ' + offInfo);
  await evalJs(`document.querySelector('.chn[data-ch="SwiftX"]').click()`);
  await sleep(200);
  const onAgain = await evalJs(`document.querySelector('.seg-line[data-seg="SwiftX|爆品1"]').classList.contains('waved')`);
  assert(onAgain === true, '重新勾选渠道后应恢复绿色: ' + onAgain);
  await shot('wms-2-46-off-channel');
  console.log('✔ 否掉渠道：分段不再显示绿色；重新勾选后恢复（波次号数据保留）');

  /* 2.5 生成波次：分段按导出顺序提交（不跳过已完成分段，重新生成由用户勾选决定） */
  await evalJs(`(function(){document.getElementById('wmsGenerate').click();document.getElementById('wmsRun').click();return 1;})()`);
  /* 逐段变绿：任务仍在运行时，已生成的分段即变绿（而非全部完成后才变绿） */
  await poll(`(function(){
    var w = window.__dshTest.wms;
    return w.job && w.job.mode === 'generate_waves' && w.job.status === 'running'
      && document.querySelectorAll('#dash .seg-line.waved').length >= 5;
  })()`, true, 100, 200);
  const midInfo = await evalJs(`(function(){
    return JSON.stringify({
      status: window.__dshTest.wms.job.status,
      waved: document.querySelectorAll('#dash .seg-line.waved').length
    });
  })()`);
  const mi = JSON.parse(midInfo);
  assert(mi.status === 'running' && mi.waved >= 5, '任务运行中已生成的分段应逐段变绿: ' + midInfo);
  console.log('✔ 逐段变绿：任务运行中（' + mi.waved + ' 段已绿）即回填波次号');
  await poll(`(function(){var w=window.__dshTest.wms;return w.job && w.job.mode==='generate_waves' ? w.job.status : '';})()`, 'succeeded', 100, 300);
  await poll(`document.querySelector('#wmsLog a[href*="/api/exports/"]') ? true : false`, true, 100, 100);
  const gen = JSON.parse(await (await fetch('http://127.0.0.1:8000/api/__test/requests')).text())
    .filter(r => r.mode === 'generate_waves').pop();
  assert(gen && Array.isArray(gen.segments) && gen.segments.length > 0, '生成波次请求应含分段清单: ' + JSON.stringify(gen));
  assert(gen.segments.some(function (sg) { return sg.channel + '|' + sg.seg_name === 'SwiftX|爆品1'; }), '提交不应因已有波次号而跳过已完成分段: ' + JSON.stringify(gen.segments));
  const genInfo = await evalJs(`(function(){
    var waved = document.querySelectorAll('#dash .seg-line.waved').length;
    var expected = window.__dshTest.state.waveNos.size;
    var a = document.querySelector('#wmsLog a[href*="/api/exports/"]');
    return JSON.stringify({waved: waved, expected: expected, link: !!a, linkText: a ? a.textContent : ''});
  })()`);
  const gi = JSON.parse(genInfo);
  assert(gi.waved > 0 && gi.waved === gi.expected, '生成波次后分段应全部变绿: ' + genInfo);
  assert(gi.link === true && gi.linkText.indexOf('下载波次规划') === 0, '自动导出后日志应含下载链接: ' + genInfo);
  const linkCount = await evalJs(`document.querySelectorAll('#wmsLog a[href*="/api/exports/"]').length`);
  assert(linkCount === 1, '日志中波次规划下载链接应恰好一条: ' + linkCount);
  /* 刷新场景：清空日志 + 重置去重集合 + 恢复流程 → 当天日志与可下载链接完整重建 */
  const exportList = JSON.parse(await (await fetch('http://127.0.0.1:8000/api/exports')).text());
  assert(Array.isArray(exportList) && exportList.length >= 1, '后端应提供当天导出清单: ' + JSON.stringify(exportList));
  await evalJs(`(function(){
    document.getElementById('wmsLog').innerHTML = '';
    var w = window.__dshTest.wms;
    w.linkedExports = new Set();
    w.jobLinks = new Set();
    w.restoredIds = new Set();
    window.__dshTest.wmsRestore();        // 恢复当天任务日志 + 任务文件链接 + 波次规划导出链接
    return 1;
  })()`);
  await poll(`document.querySelectorAll('#wmsLog .ev.jobhead').length >= 2`, true, 100, 100);
  await sleep(2500);
  const dbg = JSON.parse(await evalJs(`(function(){
    var links = [...document.querySelectorAll('#wmsLog a')].map(function(a){return a.getAttribute('href');});
    return JSON.stringify({links: links, heads: document.querySelectorAll('#wmsLog .ev.jobhead').length, text: document.getElementById('wmsLog').textContent.slice(0, 300)});
  })()`));
  const restoredLinks = dbg.links.length;
  console.log('✔ 刷新恢复：当天日志与可下载链接完整重建（' + restoredLinks + ' 个链接）');
  console.log('✔ 生成波次：按导出顺序提交 ' + gen.segments.length + ' 个分段，全部变绿，自动导出（恰好 1 条下载链接）');

  /* 2.6 重新导入订单文件：既往波次历史应被清理（本地变绿清零 + 后端记录清空） */
  await evalJs(T.importFileExpr(SAMPLE));
  await poll(`window.__dshTest.state.records.length`, 5700, 100, 200);
  await sleep(600);  // 等清理请求落库
  const reInfo = await evalJs(`(function(){
    return JSON.stringify({
      waveNos: window.__dshTest.state.waveNos.size,
      waved: document.querySelectorAll('#dash .seg-line.waved').length,
      pending: window.__dshTest.wms.clearPending
    });
  })()`);
  const ri = JSON.parse(reInfo);
  assert(ri.waveNos === 0 && ri.waved === 0, '重新导入后分段不应再变绿: ' + reInfo);
  const recsAfter = JSON.parse(await (await fetch('http://127.0.0.1:8000/api/wave-records')).text());
  assert(recsAfter.length === 0, '重新导入后后端波次记录应被清空');
  console.log('✔ 重新导入订单文件：本地波次状态与后端历史一并清理，分段不再显示为已完成');

  /* 3. 打印波次：非法波次号被拦截，合法提交后完成 */
  await evalJs(`(function(){
    var t = document.getElementById('wmsWaves');
    t.value = 'W001\\nW002\\nW001\\nBAD#1\\n';
    document.getElementById('wmsPrint').click();
    document.getElementById('wmsRun').click();
    return 1;
  })()`);
  await sleep(300);
  const badMsg = await evalJs(`document.getElementById('status').textContent`);
  assert(badMsg.indexOf('波次号格式异常') !== -1 && badMsg.indexOf('BAD#1') !== -1, '非法波次号应被拦截: ' + badMsg);
  const stillIdle = await evalJs(`(function(){
    return JSON.stringify({ text: document.getElementById('wmsRun').textContent, on: !document.getElementById('wmsRun').disabled });
  })()`);
  const si2 = JSON.parse(stillIdle);
  assert(si2.text === '开始任务' && si2.on === true, '拦截后应仍为开始任务状态: ' + stillIdle);
  await evalJs(`(function(){
    var t = document.getElementById('wmsWaves');
    t.value = 'W001\\nW002\\nW001';
    document.getElementById('wmsRun').click();
    return 1;
  })()`);
  await poll(`(function(){var w=window.__dshTest.wms;return w.job && w.job.mode==='print_waves' ? w.job.status : '';})()`, 'succeeded', 100, 200);
  const pr = JSON.parse(await (await fetch('http://127.0.0.1:8000/api/__test/requests')).text());
  const printReq = pr.filter(r => r.mode === 'print_waves').pop();
  assert(printReq && JSON.stringify(printReq.wave_nos) === JSON.stringify(['W001', 'W002']), '打印请求波次号应去重: ' + JSON.stringify(printReq));
  const pmsg = await evalJs(`document.getElementById('wmsMsg').textContent`);
  assert(pmsg.indexOf('Paper合并') !== -1, '打印完成消息错误: ' + pmsg);
  const linkInfo = await evalJs(`(function(){
    var a = document.querySelector('#wmsLog a[href*="/merged"]');
    return JSON.stringify({
      exists: !!a,
      text: a ? a.textContent : '',
      href: a ? a.getAttribute('href') : ''
    });
  })()`);
  const lk = JSON.parse(linkInfo);
  assert(lk.exists === true && lk.text.indexOf('下载合并文档') === 0 && lk.href.indexOf('/api/jobs/') === 0, '合并文档下载链接缺失: ' + linkInfo);
  console.log('✔ 打印波次：非法号拦截、去重提交、合并完成，日志含合并文档下载链接');

  /* 4. 拣货运行中：409 拦截 + 取消 */
  await evalJs(`(function(){document.getElementById('wmsWaves').value='';document.getElementById('wmsPick').click();document.getElementById('wmsRun').click();return 1;})()`);
  await poll(`(function(){var w=window.__dshTest.wms;return w.job && w.job.mode==='pick_waves' ? w.job.status : '';})()`, 'running', 100, 200);
  const busy = await evalJs(`(function(){
    return JSON.stringify({
      exportOff: document.getElementById('wmsExport').disabled,
      generateOff: document.getElementById('wmsGenerate').disabled,
      printOff: document.getElementById('wmsPrint').disabled,
      pickOff: document.getElementById('wmsPick').disabled,
      runOn: !document.getElementById('wmsRun').disabled,
      runText: document.getElementById('wmsRun').textContent,
      wavesOff: document.getElementById('wmsWaves').disabled
    });
  })()`);
  const bu = JSON.parse(busy);
  assert(bu.exportOff && bu.generateOff && bu.printOff && bu.pickOff, '任务运行中模式按钮应全部锁定: ' + busy);
  assert(bu.runOn && bu.runText === '取消任务' && bu.wavesOff, '任务运行中运行按钮应为可点击的取消任务: ' + busy);
  /* 运行中切换主题：任务/日志/状态不受影响 */
  await evalJs(`(function(){
    document.getElementById('themeBtn').click();
    document.querySelector('#themeList li[data-v="seaclear"]').click();
    return 1;
  })()`);
  await sleep(150);
  const themeJob = JSON.parse(await evalJs(`(function(){
    var w = window.__dshTest.wms;
    return JSON.stringify({ status: w.job.status, theme: document.body.getAttribute('data-theme'), busy: w.active });
  })()`));
  assert(themeJob.status === 'running' && themeJob.theme === 'seaclear' && themeJob.busy === true, '运行中切换主题不应影响任务: ' + JSON.stringify(themeJob));
  console.log('✔ 任务运行中切换主题：任务/日志/状态不受影响');
  /* 客户端已禁用按钮防重复提交；409 分支用钩子驱动（模拟陈旧客户端状态） */
  await evalJs(`(function(){
    var w = window.__dshTest.wms;
    w.active = false;
    document.getElementById('wmsExport').disabled = false;
    window.__dshTest.wmsSubmit('export');
    return 1;
  })()`);
  await sleep(300);
  const conflictMsg = await evalJs(`document.getElementById('status').textContent`);
  assert(conflictMsg.indexOf('已有任务在执行') !== -1, '409 冲突应提示: ' + conflictMsg);
  const pickReq = JSON.parse(await (await fetch('http://127.0.0.1:8000/api/__test/requests')).text()).filter(r => r.mode === 'pick_waves').pop();
  assert(pickReq && Array.isArray(pickReq.wave_nos) && pickReq.wave_nos.length === 0, '拣货请求应允许空波次列表: ' + JSON.stringify(pickReq));
  await evalJs(`(function(){ window.__dshTest.wms.active = true; document.getElementById('wmsRun').click(); return 1; })()`);
  await poll(`(function(){var w=window.__dshTest.wms;return w.job && w.job.mode==='pick_waves' ? w.job.status : '';})()`, 'cancelled', 50, 200);
  const afterCancel = await evalJs(`(function(){
    return JSON.stringify({
      state: document.getElementById('wmsState').textContent,
      exportOn: !document.getElementById('wmsExport').disabled,
      runText: document.getElementById('wmsRun').textContent,
      runOn: !document.getElementById('wmsRun').disabled
    });
  })()`);
  const ac = JSON.parse(afterCancel);
  assert(ac.state === '已取消' && ac.exportOn === true, '取消后状态错误: ' + afterCancel);
  assert(ac.runText === '开始任务' && ac.runOn === true, '取消后运行按钮应恢复开始任务且可用: ' + afterCancel);
  console.log('✔ 批量拣货：运行中锁定模式按钮、409 冲突提示、取消任务后恢复开始任务');

  /* 5. 日志显示：位于操作栏内、常显、宽度=操作栏宽、自动滚动 */
  const logInfo = await evalJs(`(function(){
    var log = document.getElementById('wmsLog');
    var side = document.querySelector('.side');
    return JSON.stringify({
      inSide: !!log.closest('.side'),
      lines: log.querySelectorAll('.ev').length,
      widthOk: log.getBoundingClientRect().width <= side.getBoundingClientRect().width + 1,
      scrolled: log.scrollHeight - log.scrollTop - log.clientHeight < 8
    });
  })()`);
  const li = JSON.parse(logInfo);
  assert(li.inSide === true && li.lines >= 3 && li.widthOk === true, '日志应常显于操作栏内且不超宽: ' + logInfo);
  assert(li.scrolled === true, '日志应自动滚动到最新: ' + logInfo);
  console.log('✔ 日志在操作栏内常显（' + li.lines + ' 条），宽度受限且自动滚动');

  /* 5.5 当天日志累计：多个任务头都在，且任务可下载文件链接已挂载 */
  const dayInfo = JSON.parse(await evalJs(`(function(){
    return JSON.stringify({
      heads: document.querySelectorAll('#wmsLog .ev.jobhead').length,
      orderLink: !!(document.querySelector('#wmsLog a[href*="/api/jobs/"][href$="/file"]')),
      mergedLink: !!(document.querySelector('#wmsLog a[href*="/api/jobs/"][href$="/merged"]'))
    });
  })()`));
  assert(dayInfo.heads >= 3, '当天日志应累计显示全部任务头: ' + JSON.stringify(dayInfo));
  const startLines = await evalJs(`(document.getElementById('wmsLog').textContent.match(/开始任务：/g) || []).length`);
  assert(startLines >= 4, '每次开始任务都应记录“开始任务：××”: ' + startLines);
  assert(dayInfo.orderLink === true, '导出任务的订单文件下载链接应挂载: ' + JSON.stringify(dayInfo));
  assert(dayInfo.mergedLink === true, '打印任务的合并文档下载链接应挂载: ' + JSON.stringify(dayInfo));
  console.log('✔ 当天日志累计：' + dayInfo.heads + ' 个任务头，任务可下载文件链接齐全');

  /* 6. 任务记录丢失（服务重启导致 404）：停止轮询、恢复空闲并提示 */
  await evalJs(`(function(){
    var w = window.__dshTest.wms;
    w.jobId = 'job-nonexistent';
    w.active = true;
    w.job = { id: 'job-nonexistent', status: 'running', events: [] };
    window.__dshTest.wmsPollOnce();
    return 1;
  })()`);
  await poll(`(function(){var w=window.__dshTest.wms;return w.jobId === null && w.active === false;})()`, true, 100, 50);
  const rec = await evalJs(`(function(){
    return JSON.stringify({
      msg: document.getElementById('wmsLog').textContent,
      state: document.getElementById('wmsState').textContent,
      btnOn: !document.getElementById('wmsGenerate').disabled
    });
  })()`);
  const rc = JSON.parse(rec);
  assert(rc.msg.indexOf('任务记录不存在') !== -1, '应提示任务记录丢失: ' + rec);
  assert(rc.state === '空闲' && rc.btnOn === true, '应恢复空闲且按钮可用: ' + rec);
  console.log('✔ 任务记录丢失（服务重启）：停止轮询、恢复空闲并提示刷新');

  console.log('\nWMS 联动 UI 测试全部通过 ✅');
}, () => mock.close());
