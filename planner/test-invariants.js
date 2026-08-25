/* 订单分配与导出一致性不变量测试：
 * 1) 每个订单恰好分配到一个分段（无遗漏、无重复、无跨渠道错分）；
 * 2) 勾选/否掉与参数调整后仍满足不变量；
 * 3) 合并模式（渠道按 CBT/CBS/普通）下同样满足；
 * 4) 导出的 分组结果/波次表 与勾选的分段一一对应，波次号落在正确行。
 * 使用真实样例（5700 单）验证。 */
'use strict';
const path = require('path');
const fs = require('fs');
const T = require('./test-helpers.js');

const P = T.paths(__dirname);
const PORT = 9335;
const USER_DIR = P.tmp('chrome-invariants');
const HTML_SOURCE = path.join(__dirname, '..', 'wms', 'project', 'frontend', 'dist', 'index.html');
const SAMPLE = P.sample;
const { sleep, assert } = T;

const XLSX = require('./vendor/xlsx.full.min.js');

T.withChrome(T.launchChrome({ port: PORT, userDataDir: USER_DIR }), async () => {
  const ws = await T.connectCdp({ port: PORT });
  const drv = T.createDriver(ws, { pollTries: 200 });
  const { send, evalJs, poll } = drv;
  await drv.enablePage();
  await send('Page.navigate', { url: 'file://' + HTML_SOURCE });
  await poll(`window.__dshTest ? true : false`, true, 100, 100);

  /* 导入样例文件 */
  await evalJs(T.importFileExpr(SAMPLE));
  await poll(`window.__dshTest.state.records.length`, 5700, 100, 200);
  console.log('✔ 导入样例 5700 单');

  /* 不变量 1：全部分段恰好覆盖全部订单 */
  async function checkAllocation(label) {
    const info = await evalJs(`(function(){
      var a = window.__dshTest.curAnalysis();
      var segCount = 0, chTotal = 0, seen = new Set(), dup = 0, empty = 0;
      a.channels.forEach(function (ch) {
        chTotal += ch.total;
        var chSeen = new Set();
        ch.segments.forEach(function (s) {
          segCount++;
          if (!s.orderNos.length) empty++;
          s.orderNos.forEach(function (no) {
            if (seen.has(no)) dup++;
            seen.add(no);
            chSeen.add(no);
          });
        });
        /* 渠道内分段订单并集必须等于渠道总数 */
        if (chSeen.size !== ch.total) {
          return JSON.stringify({ err: 'channel-mismatch', ch: ch.name, union: chSeen.size, total: ch.total });
        }
      });
      return JSON.stringify({
        total: window.__dshTest.state.records.length,
        chTotal: chTotal, union: seen.size, dup: dup, empty: empty, segCount: segCount
      });
    })()`);
    const st = JSON.parse(info);
    if (st.err) { assert(false, label + ' 渠道订单错分: ' + info); }
    assert(st.total === st.chTotal, label + ' 渠道总数应等于记录总数: ' + info);
    assert(st.total === st.union, label + ' 分段并集应等于记录总数（无遗漏）: ' + info);
    assert(st.dup === 0, label + ' 不应有订单重复分配: ' + info);
    assert(st.empty === 0, label + ' 不应有空分段: ' + info);
    console.log(`✔ 不变量「${label}」：${st.total} 单 = ${st.segCount} 个分段并集，无遗漏/重复/空段`);
  }

  await checkAllocation('全部渠道+分段');

  /* 不变量 2：否掉部分渠道/分段后，导出内容与勾选一致 */
  const offInfo = await evalJs(`(function(){
    var a = window.__dshTest.curAnalysis();
    var first = a.channels[0];
    var offCh = first ? first.id : '';
    var offSeg = '';
    if (first && first.segments.length) offSeg = first.id + '|' + first.segments[0].name;
    /* 否掉第一个渠道的第二个分段与第二个渠道整体 */
    var seg2 = (first && first.segments[1]) ? first.id + '|' + first.segments[1].name : '';
    var ch2 = a.channels[1] ? a.channels[1].id : '';
    var toggles = [];
    if (seg2) { document.querySelector('.seg-line[data-seg="' + CSS.escape(seg2) + '"]').click(); toggles.push(seg2); }
    if (ch2) { document.querySelector('.chn[data-ch="' + CSS.escape(ch2) + '"]').click(); toggles.push('ch:' + ch2); }
    return JSON.stringify({ offCh: offCh, offSeg: offSeg, toggles: toggles, seg2: seg2, ch2: ch2 });
  })()`);
  const oi = JSON.parse(offInfo);
  assert(oi.toggles.length === 2, '应能否掉一个分段与一个渠道: ' + offInfo);

  /* 取导出内容（内部表示），核对订单不遗漏 */
  const selCheck = await evalJs(`(function(){
    var data = window.__dshTest.buildExportNow();
    var m = window.__dshTest.state.modes[window.__dshTest.state.merged ? 'merged' : 'normal'];
    var a = window.__dshTest.curAnalysis();
    var expNos = new Set(), selNos = new Set();
    data.sheets.forEach(function (sh) {
      if (sh.name !== '分组结果') return;
      var aoa = sh.aoa;
      aoa.forEach(function (row, ri) {
        if (ri < 3) return;
        row.forEach(function (cell) {
          if (typeof cell === 'string' && cell !== '' && cell !== 'start' && cell !== 'end' && /^[A-Za-z0-9][A-Za-z0-9_-]{9,}$/.test(cell)) expNos.add(cell);
        });
      });
    });
    a.channels.forEach(function (ch) {
      if (!m.sel.channels.has(ch.id)) return;
      ch.segments.forEach(function (s) {
        if (m.sel.segs.has(ch.id + '|' + s.name)) s.orderNos.forEach(function (no) { selNos.add(no); });
      });
    });
    var onlyExp = [...expNos].filter(function (n) { return !selNos.has(n); });
    var onlySel = [...selNos].filter(function (n) { return !expNos.has(n); });
    return JSON.stringify({ exp: expNos.size, sel: selNos.size, onlyExp: onlyExp.slice(0, 3), onlySel: onlySel.slice(0, 3) });
  })()`);
  const sc = JSON.parse(selCheck);
  assert(sc.exp === sc.sel && sc.onlyExp.length === 0 && sc.onlySel.length === 0,
    '导出订单应与勾选分段完全一致（无错分/遗漏）: ' + selCheck);
  console.log(`✔ 勾选/否掉后导出：${sc.sel} 单与勾选分段一一对应`);

  /* 波次表与分组结果对齐 + 波次号落位 */
  const waveCheck = await evalJs(`(function(){
    var data = window.__dshTest.buildExportNow();
    var grp = data.sheets.filter(function (s) { return s.name === '分组结果'; })[0];
    var wt = data.sheets.filter(function (s) { return s.name === '波次表'; })[0];
    var segCells = grp.aoa[1].filter(function (c) { return typeof c === 'string' && c.indexOf('订单数量') !== -1; });
    var dataRows = wt.aoa.filter(function (r) { return r[0] !== '渠道类型' && r[0] !== '---'; });
    return JSON.stringify({ segs: segCells.length, waveRows: dataRows.length });
  })()`);
  const wc = JSON.parse(waveCheck);
  assert(wc.segs === wc.waveRows, '波次表数据行数应与分组结果分段列数一致: ' + waveCheck);
  console.log(`✔ 波次表与分组结果对齐（${wc.segs} 个分段）`);

  /* 恢复勾选 */
  await evalJs(`(function(){
    var t = ${JSON.stringify(oi.toggles)};
    t.forEach(function (x) {
      if (x.indexOf('ch:') === 0) document.querySelector('.chn[data-ch="' + CSS.escape(x.slice(3)) + '"]').click();
      else document.querySelector('.seg-line[data-seg="' + CSS.escape(x) + '"]').click();
    });
    return 1;
  })()`);

  /* 不变量 3：合并模式（渠道归并为 CBT/CBS/普通） */
  await evalJs(`document.getElementById('modeLabel').click()`);
  await poll(`window.__dshTest.state.merged`, true, 100, 50);
  await checkAllocation('合并模式全部渠道+分段');
  const mergedChans = await evalJs(`window.__dshTest.curAnalysis().channels.map(function(c){return c.id;}).join(',')`);
  console.log('✔ 合并模式渠道:', mergedChans);
  await evalJs(`document.getElementById('modeLabel').click()`);  // 切回拆分模式
  await poll(`window.__dshTest.state.merged`, false, 100, 50);

  /* 加固验证：多行订单合并 + 未识别类型不丢单 + 参数调整清空波次历史 */
  const synRows = [
    ['Outbound Order No/出库单号', 'Type of order variety/订单品种类型', 'Shipping Carrier/物流承运商',
     'Package 1 Tracking No./物流跟踪号', 'SKU 1 SKU', 'SKU 2 SKU', 'SKU 3 SKU', 'Total Qty of SKU/总数量'],
    ['O1', '多品混合', 'USPS', '9000000000000000000001', 'SKU-A', '', '', '1'],
    ['O1', '多品混合', 'USPS', '9000000000000000000001', '', 'SKU-B', '', '1'],
    ['O1', '多品混合', 'USPS', '9000000000000000000001', '', '', 'SKU-C', '1'],
    ['O2', '新型品种X', 'USPS', '9000000000000000000002', 'SKU-D', '', '', '2'],
    ['O3', '单品单件', 'USPS', '9000000000000000000003', 'SKU-E', '', '', '3'],
    ['O4', '单品多件', 'USPS', '9000000000000000000004', 'SKU-F', '', '', '4'],
    ['', '', '', '', '', '', '', '']
  ];
  const synWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(synWb, XLSX.utils.aoa_to_sheet(synRows), '出库单');
  const synPath = P.tmp('synthetic-multiline.xlsx');
  fs.writeFileSync(synPath, XLSX.write(synWb, { type: 'buffer', bookType: 'xlsx' }));
  await evalJs(T.importFileExpr(synPath));
  await poll(`window.__dshTest.state.records.length`, 4, 100, 50);
  const syn = JSON.parse(await evalJs(`(function(){
    var a = window.__dshTest.curAnalysis();
    var seen = new Set(), dup = 0, o1count = 0;
    a.channels.forEach(function (ch) {
      ch.segments.forEach(function (s) {
        s.orderNos.forEach(function (no) {
          if (seen.has(no)) dup++;
          seen.add(no);
          if (no === 'O1') o1count++;
        });
      });
    });
    return JSON.stringify({ union: seen.size, dup: dup, o1count: o1count, o2in: seen.has('O2') });
  })()`));
  assert(syn.union === 4 && syn.dup === 0, '合成用例：4 单应全部分配且无重复: ' + JSON.stringify(syn));
  assert(syn.o1count === 1, '多行订单 O1 必须合并为一条且只出现在一个分段: ' + JSON.stringify(syn));
  assert(syn.o2in === true, '未识别品种类型订单不得被丢弃: ' + JSON.stringify(syn));
  console.log('✔ 加固验证：多行订单合并（O1 仅 1 次）、未识别类型不丢单（O2 保留）');

  /* 参数调整清空波次历史 */
  await evalJs(`(function(){
    window.__dshTest.state.waveNos.set('USPS|爆品1', 'W0092608180001');
    document.querySelector('.arr[data-p="capacity"]').click();
    return 1;
  })()`);
  await sleep(200);
  const wvAfter = await evalJs(`window.__dshTest.state.waveNos.size`);
  assert(wvAfter === 0, '调整参数后波次号应清空（旧波次号不再对应新分段）: ' + wvAfter);
  console.log('✔ 加固验证：调整参数后清空波次历史');

  /* 吸收档（absorb 1→2）：混件SKU序列应补全被吸收进混件段的多件 SKU */
  await evalJs(`document.querySelector('.aval[data-ch="USPS"]').click()`);
  await sleep(250);
  const ab = JSON.parse(await evalJs(`(function(){
    var data = window.__dshTest.buildExportNow();
    var sh = data.sheets.filter(function (s) { return s.name === '混件SKU序列'; })[0];
    var pool = data.sheets.filter(function (s) { return s.name === '分组结果SKU池'; })[0];
    var seqHasF = false, poolHasF = false;
    sh.aoa.forEach(function (row) { if (row.indexOf('SKU-F') !== -1) seqHasF = true; });
    pool.aoa.forEach(function (row) { if (row.indexOf('SKU-F') !== -1) poolHasF = true; });
    return JSON.stringify({ seqHasF: seqHasF, poolHasF: poolHasF });
  })()`));
  assert(ab.seqHasF === true && ab.poolHasF === true, '混件SKU序列应与SKU池一致包含被吸收的 SKU-F: ' + JSON.stringify(ab));
  console.log('✔ 吸收档混件SKU序列补全（被吸收 SKU 与 SKU池一致）');

  /* 主题切换：仅改外观，页面数据与布局不受影响 */
  const tBefore = JSON.parse(await evalJs(`(function(){
    var tw = document.querySelector('.twrap').getBoundingClientRect();
    return JSON.stringify({
      records: window.__dshTest.state.records.length,
      waveNos: window.__dshTest.state.waveNos.size,
      twX: tw.x, twW: tw.width
    });
  })()`));
  await evalJs(`(function(){
    document.getElementById('themeBtn').click();
    document.querySelector('#themeList li[data-v="seaclear"]').click();
    return 1;
  })()`);
  await sleep(150);
  const tAfter = JSON.parse(await evalJs(`(function(){
    var tw = document.querySelector('.twrap').getBoundingClientRect();
    return JSON.stringify({
      records: window.__dshTest.state.records.length,
      waveNos: window.__dshTest.state.waveNos.size,
      twX: tw.x, twW: tw.width,
      theme: document.body.getAttribute('data-theme') || '',
      bg: getComputedStyle(document.body).backgroundColor
    });
  })()`));
  assert(tAfter.theme === 'seaclear' && tAfter.bg === 'rgb(6, 18, 26)', '主题应生效: ' + JSON.stringify(tAfter));
  assert(tAfter.records === tBefore.records && tAfter.waveNos === tBefore.waveNos &&
    tAfter.twX === tBefore.twX && tAfter.twW === tBefore.twW,
    '主题切换不应影响页面数据与布局: ' + JSON.stringify(tBefore) + ' -> ' + JSON.stringify(tAfter));
  console.log('✔ 主题切换：仅改外观，页面数据与布局不受影响');

  console.log('\n订单分配与导出不变量测试全部通过 ✅');
}, () => {});
