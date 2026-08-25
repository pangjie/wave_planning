/* 浏览器端到端链路一致性：网页选择 → 内部导出数据 → 写入文件 → 回读比对 */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./test-helpers.js');

const P = T.paths(__dirname);
const PORT = 9391;
const USER_DIR = P.tmp('chrome-chain');
const DL_DIR = P.tmp('chain-download');
const HTML = P.html;
const SAMPLE = P.sample;
const { sleep, assert } = T;

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (a == null || b == null) return (a == null || a === '') && (b == null || b === '');
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  return String(a) === String(b);
}


const chrome = T.launchChrome({ port: PORT, userDataDir: USER_DIR });

(async () => {
  const ws = await T.connectCdp({ port: PORT });
  const drv = T.createDriver(ws);
  const { send, evalJs, poll } = drv;
  await drv.enablePage();
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL_DIR, eventsEnabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 950, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: HTML });
  await poll(`document.readyState`, 'complete');
  await poll(`document.querySelectorAll('#dash .prow').length`, 12);

  /* 1. 导入 */
  const b64 = fs.readFileSync(SAMPLE).toString('base64');
  await evalJs(`(function(){
    var bin = atob('${b64}');
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    window.__dshTest.handleFile(new File([bytes], 'sample.xlsx'));
    return 'ok';
  })()`);
  await poll(`window.__dshTest.state.records.length`, 5700);
  console.log('✔ 导入 5700 单');

  /* 2. 应用确定性操作组合 */
  const pattern = await evalJs(`(function(){
    /* 参数：CBT 容量 +200（两击）、CBT 吸收到第 3 档（两击）、爆品线 -1 */
    document.querySelector('#dash .arr-r[data-p="capacity"][data-ch="CBT"]').click();
    document.querySelector('#dash .arr-r[data-p="capacity"][data-ch="CBT"]').click();
    document.querySelector('#dash .aval[data-ch="CBT"]').click();
    document.querySelector('#dash .aval[data-ch="CBT"]').click();
    document.querySelector('#dash .arr-l[data-p="hotLine"][data-ch="Gofo"]').click();
    /* 渠道：否掉 UPS、Fedex */
    document.querySelector('#dash .chn[data-ch="UPS"]').click();
    document.querySelector('#dash .chn[data-ch="Fedex"]').click();
    /* 分段：否掉 CBT 爆品、SwiftX 单件、UPS 混件 */
    var cb = Array.prototype.slice.call(document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]'))[0];
    var sw = Array.prototype.slice.call(document.querySelectorAll('#dash .prow[data-ch="SwiftX"] .seg-line')).filter(function(l){return l.textContent.indexOf('单件') === 0;})[0];
    var us = Array.prototype.slice.call(document.querySelectorAll('#dash .prow[data-ch="UPS"] .seg-line')).filter(function(l){return l.textContent.indexOf('混件') === 0;})[0];
    cb.click();
    if (sw) sw.click();
    if (us) us.click();
    /* 拖动：Gofo 移到最前 */
    var src = document.querySelector('#dash .prow[data-ch="Gofo"] .chn');
    var dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer:dt}));
    var row0 = document.querySelector('#dash .prow');
    var rect = row0.getBoundingClientRect();
    row0.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt, clientY: rect.top + 2}));
    row0.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt, clientY: rect.top + 2}));
    src.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer:dt}));
    return 1;
  })()`);
  await sleep(600);

  /* 3. 校验：绿X 显示集合 == 导出集合 */
  const displayConsistent = await evalJs(`(function(){
    var data = window.__dshTest.buildExportNow();
    var exported = new Set();
    var m = window.__dshTest.state.modes[window.__dshTest.state.merged ? 'merged' : 'normal'].sel;
    var a = window.__dshTest.curAnalysis();
    a.channels.forEach(function(ch){
      ch.segments.forEach(function(s){
        var key = ch.id + '|' + s.name;
        if (m.channels.has(ch.id) && m.segs.has(key)) exported.add(key);
      });
    });
    var togs = Array.prototype.slice.call(document.querySelectorAll('#dash .seg-line[data-seg]'));
    var allMatch = togs.every(function(el){
      var isGreen = el.classList.contains('on');
      return isGreen === exported.has(el.dataset.seg);
    });
    return JSON.stringify({greenMatch: allMatch, greenCount: togs.filter(function(el){return el.classList.contains('on');}).length, exportedCount: exported.size});
  })()`);
  const dc = JSON.parse(displayConsistent);
  assert(dc.greenMatch === true && dc.greenCount === dc.exportedCount, '绿X 显示与导出集合不一致: ' + JSON.stringify(dc));
  console.log('✔ 绿X 显示 == 导出集合（' + dc.exportedCount + ' 个分段）');
  /* 3.5 导出渠道顺序跟随网页拖动顺序（Gofo 已拖到最前） */
  const orderCheck = await evalJs(`(function(){
    var data = window.__dshTest.buildExportNow();
    var s = data.sheets.filter(function(x){return x.name==='分组结果';})[0];
    return s.aoa[0].filter(function(v){return v && String(v).trim();}).join(',');
  })()`);
  assert(orderCheck.split(',')[0] === 'Gofo', '导出渠道顺序未跟随网页拖动: ' + orderCheck);
  console.log('✔ 导出渠道顺序跟随网页顺序: ' + orderCheck);

  /* 4. 捕获应用内部预期导出数据 */
  const expectedJson = await evalJs(`(function(){
    var data = window.__dshTest.buildExportNow();
    return JSON.stringify(data.sheets.map(function(s){ return {name: s.name, aoa: s.aoa}; }));
  })()`);
  fs.writeFileSync(path.join(__dirname, 'tmp', 'expected-export.json'), expectedJson);
  const expected = JSON.parse(expectedJson);
  console.log('✔ 捕获内部预期导出数据：' + expected.map(s => s.name).join(' / '));

  /* 5. 点击导出并等待下载 */
  fs.rmSync(DL_DIR, { recursive: true, force: true });
  fs.mkdirSync(DL_DIR, { recursive: true });
  await evalJs(`document.getElementById('btnExport').click()`);
  let downloaded = null;
  for (let i = 0; i < 100; i++) {
    const files = fs.readdirSync(DL_DIR).filter(f => f.endsWith('.xlsx') && !f.endsWith('.crdownload'));
    if (files.length) { downloaded = path.join(DL_DIR, files[0]); break; }
    await sleep(200);
  }
  assert(downloaded, '导出文件未下载');
  fs.copyFileSync(downloaded, path.join(__dirname, 'tmp', 'web-chain-export.xlsx'));
  console.log('✔ 下载: ' + path.basename(downloaded));

  /* 6. 回读下载文件并与内部预期逐格比对 */
  const XLSX = require(path.join(__dirname, 'vendor', 'xlsx.full.min.js'));
  const wb = XLSX.read(fs.readFileSync(downloaded), { type: 'buffer' });
  assert(wb.SheetNames.length === 8, '回读工作表数 ' + wb.SheetNames.length);
  let cellMismatches = 0;
  expected.forEach((exp, si) => {
    const name = exp.name;
    assert(wb.SheetNames[si] === name, `第${si + 1}个工作表名 ${wb.SheetNames[si]} ≠ ${name}`);
    const ws = wb.Sheets[name];
    const got = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' });
    const nRows = Math.max(exp.aoa.length, got.length);
    let nCols = 0;
    exp.aoa.forEach(r => { if (r.length > nCols) nCols = r.length; });
    got.forEach(r => { if (r.length > nCols) nCols = r.length; });
    for (let r = 0; r < nRows; r++) {
      for (let c = 0; c < nCols; c++) {
        const e = (exp.aoa[r] || [])[c];
        const g = (got[r] || [])[c];
        if (!deepEqual(e, g)) {
          cellMismatches++;
          if (cellMismatches <= 5) {
            console.error(`  ✘ ${name} [${r},${c}] 预期 ${JSON.stringify(e)} ≠ 回读 ${JSON.stringify(g)}`);
          }
        }
      }
    }
  });
  assert(cellMismatches === 0, `回读文件与内部预期不一致 ${cellMismatches} 处`);
  console.log('✔ 下载文件逐格回读比对：8 个工作表全部一致');

  /* 7. 波次表自动筛选回读 */
  const ws3 = wb.Sheets['波次表'];
  assert(ws3['!autofilter'] && ws3['!autofilter'].ref, '波次表自动筛选缺失');
  console.log('✔ 波次表自动筛选: ' + ws3['!autofilter'].ref);

  console.log('\n浏览器链路一致性测试全部通过 ✅');
  chrome.kill();
  process.exit(0);
})().catch(e => {
  console.error('✘ 测试失败:', e.message);
  try { chrome.kill(); } catch (err) { }
  process.exit(1);
});
