/* Ordinary evolution must use the final source selection, including new segments. */
'use strict';
const T = require('./test-helpers.js');
const XLSX = require('./vendor/xlsx.full.min.js');

T.withChrome({}, async chrome => {
  const d = T.createDriver(await T.connectCdp({ chrome }));
  await d.enablePage();
  await d.send('Page.navigate', { url: T.paths(__dirname).html });
  await d.poll('document.readyState', 'complete');
  // This regression deliberately exercises the unsplit legacy USPS channel.
  await d.evalJs('window.__dshTest.toggleUspsSubdivision(); true');
  await d.evalJs(`(function () {
    var rows = [['Outbound Order No/出库单号', 'Type of order variety/订单品种类型',
      'Shipping Carrier/物流承运商', 'Package 1 Tracking No./物流跟踪号', 'SKU 1 SKU', 'Total Qty of SKU/总数量']];
    for (var i = 0; i < 800; i++) rows.push(['U' + i, '单品单件', 'USPS', '9' + '0'.repeat(21), 'SKU-' + Math.floor(i / 100), 1]);
    for (var i = 0; i < 25; i++) rows.push(['C' + i, '单品单件', 'CBT', '', 'CBT-SKU', 1]);
    for (var i = 0; i < 25; i++) rows.push(['B' + i, '单品单件', 'CBS', '', 'CBS-SKU', 1]);
    for (var i = 0; i < 7; i++) rows.push(['X' + i, '单品单件', '', '', 'UNKNOWN-SKU', 1]);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), '出库单');
    window.__dshTest.handleFile(new File([XLSX.write(wb, {type: 'array', bookType: 'xlsx'})], 'isolated.xlsx'));
    return true;
  })()`);
  await d.poll('window.__dshTest.state.records.length', 857);
  await d.evalJs('window.__dshTest.toggleOrdinaryEvolution(); true');

  async function verify(label) {
    const actual = JSON.parse(await d.evalJs(`JSON.stringify((function () {
      var api = window.__dshTest, a = api.curAnalysis(), m = api.state.modes.normal;
      var source = api.state.analysis.normal;
      var absorbed = new Set(api.state.records.filter(function(r) { return r.channelId === '未识别'; }).map(function(r) { return r.orderNo; }));
      source.channels.forEach(function(ch) {
        if (['CBT','CBS','未识别','普通'].includes(ch.id)) return;
        ch.segments.forEach(function(s) {
          if (!m.sel.channels.has(ch.id) || !m.sel.segs.has(ch.id + '|' + s.name)) s.orderNos.forEach(function(no) { absorbed.add(no); });
        });
      });
      var ordinary = a.channels.find(function(ch) { return ch.id === '普通'; });
      var effective = a.channels.flatMap(function(ch) {
        return m.sel.channels.has(ch.id) ? ch.segments.filter(function(s) { return m.sel.segs.has(ch.id + '|' + s.name); }).flatMap(function(s) { return s.orderNos; }) : [];
      });
      var ordinarySelected = ordinary.segments.filter(function(s) { return m.sel.channels.has('普通') && m.sel.segs.has('普通|' + s.name); }).reduce(function(n,s) { return n + s.orderCount; }, 0);
      return { expected: Array.from(absorbed).sort(), actual: ordinary.segments.flatMap(function(s) {return s.orderNos;}).sort(),
        displayed: Number(document.querySelector('.prow[data-ch="普通"] [data-channel-orders]').textContent), ordinarySelected: ordinarySelected,
        effective: effective.length, unique: new Set(effective).size,
        totalDisplayed: Number(document.querySelector('[data-order-total]').textContent) };
    })())`));
    T.assert(JSON.stringify(actual.actual) === JSON.stringify(actual.expected), label + ': 普通订单归属错误 ' + JSON.stringify({actual:actual.actual.length, expected:actual.expected.length}));
    T.assert(actual.displayed === actual.ordinarySelected, label + ': 普通显示与勾选不一致');
    T.assert(actual.effective === actual.unique && actual.totalDisplayed === actual.unique, label + ': 重复订单或总量错误 ' + JSON.stringify(actual));
    const bytes = Buffer.from(await d.evalJs('window.__dshTest.buildExportBuffer()'), 'base64');
    const wb = XLSX.read(bytes, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets['波次表'], {header:1}).slice(1);
    const count = rows.reduce((n,r) => n + (typeof r[6] === 'number' ? r[6] : 0), 0);
    T.assert(count === actual.unique && wb.SheetNames.length === 9, label + ': 导出重复订单或缺表');
    console.log('✔ ' + label + '：普通归属、显示、全局数量和九表导出一致');
  }
  async function click(selector) { await d.evalJs(`document.querySelector(${JSON.stringify(selector)}).click(); true`); }
  await verify('进化后');
  await click('.arr[data-ch="USPS"][data-p="capacity"][data-dir="-1"]');
  await verify('渠道容量 400→300，新分段默认勾选');
  await click('.seg-line[data-seg="USPS|爆品1"]');
  await verify('关闭源渠道一个分段');
  await click('.arr[data-ch="USPS"][data-p="capacity"][data-dir="-1"]');
  await verify('渠道容量 300→200，保留已有关闭状态');
  await click('.arr[data-ch=""][data-p="capacity"][data-dir="-1"]');
  await verify('统一容量调整');
  await click('.chn[data-ch="USPS"]');
  await verify('源渠道整体关闭');
  await click('.arr[data-ch="USPS"][data-p="capacity"][data-dir="-1"]');
  await verify('关闭渠道重新分段');
  await click('.chn[data-ch="USPS"]');
  await verify('源渠道重新开启');
  await click('.seg-line[data-seg="CBT|爆品1"]');
  await verify('CBT 分段开关不被普通吸收');
  await d.evalJs('window.__dshTest.toggleOrdinaryEvolution(); window.__dshTest.toggleOrdinaryEvolution(); true');
  await verify('退化再进化');
});
