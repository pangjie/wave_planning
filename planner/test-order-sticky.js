/* 固定渠道顺序与表头/统一调整行吸顶回归测试 */
'use strict';
const T = require('./test-helpers.js');

const P = T.paths(__dirname);
const PORT = 9340;
const USER_DIR = P.tmp('order-sticky-profile');
const chrome = T.launchChrome({ port: PORT, userDataDir: USER_DIR });

T.withChrome(chrome, async () => {
  const ws = await T.connectCdp({ port: PORT });
  const drv = T.createDriver(ws);
  const { send, evalJs, poll } = drv;
  await drv.enablePage();
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1920, height: 950, deviceScaleFactor: 1, mobile: false
  });
  await send('Page.navigate', { url: P.html });
  await poll('document.readyState', 'complete');
  await poll("document.querySelectorAll('#dash .prow').length", 12);

  /* 显式切到“降序”再切回“固定”，避免只验证初始默认值。 */
  await evalJs(`(function(){
    document.getElementById('sortModeLabel').click();
    document.getElementById('sortModeLabel').click();
    return true;
  })()`);

  const result = JSON.parse(await evalJs(`(function(){
    var wrap = document.querySelector('#dash .twrap');
    var head = document.querySelector('#dash thead th');
    var unified = document.querySelector('#dash .urowe td');
    var channel = document.querySelector('#dash .prow td');
    var order = Array.prototype.map.call(
      document.querySelectorAll('#dash .prow'),
      function(row){ return row.dataset.ch; }
    );

    /* 在真实表格滚动容器内触发纵向滚动。 */
    wrap.style.height = '360px';
    wrap.style.flex = 'none';
    wrap.scrollTop = 0;
    var before = {
      head: head.getBoundingClientRect().top,
      unified: unified.getBoundingClientRect().top,
      channel: channel.getBoundingClientRect().top
    };
    wrap.scrollTop = Math.min(220, wrap.scrollHeight - wrap.clientHeight);
    var after = {
      head: head.getBoundingClientRect().top,
      unified: unified.getBoundingClientRect().top,
      channel: channel.getBoundingClientRect().top
    };

    return JSON.stringify({
      mode: document.getElementById('modeLabel').textContent.trim(),
      sort: document.getElementById('sortModeLabel').textContent.trim(),
      order: order,
      scrollTop: wrap.scrollTop,
      headDelta: Math.abs(after.head - before.head),
      unifiedDelta: Math.abs(after.unified - before.unified),
      channelMoved: before.channel - after.channel,
      unifiedOffset: Math.abs(
        after.unified - (after.head + head.getBoundingClientRect().height)
      )
    });
  })()`));

  const expected = [
    'CBT', 'USPS', 'SwiftX', 'UPS', 'Fedex', 'SpeedX',
    'Gofo', 'CBS', 'BFE', 'UniUni', 'YanWen', '未识别'
  ];
  T.assert(result.mode === '拆分' && result.sort === '固定',
    '测试必须位于“拆分 / 固定”模式: ' + JSON.stringify(result));
  T.assert(JSON.stringify(result.order) === JSON.stringify(expected),
    '固定渠道顺序不符合要求: ' + JSON.stringify(result.order));
  T.assert(result.scrollTop > 0, '表格未产生可验证的纵向滚动');
  T.assert(result.headDelta < 2 && result.unifiedDelta < 2,
    '表头或“统一调整”行未锁定: ' + JSON.stringify(result));
  T.assert(result.channelMoved > 20,
    '渠道行应随表格滚动: ' + JSON.stringify(result));
  T.assert(result.unifiedOffset < 2,
    '“统一调整”行应紧贴在表头下方: ' + JSON.stringify(result));

  console.log('✔ 拆分/固定渠道顺序正确');
  console.log('✔ 表头与“统一调整”行锁定，渠道行独立滚动');
});
