/* 纯色主题背景、概览数字滚动、无点击粒子与普通渠道进退化回归测试 */
'use strict';
const T = require('./test-helpers.js');

const P = T.paths(__dirname);
const PORT = 9341;
const USER_DIR = P.tmp('visual-effects-profile');
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

  const ambient = JSON.parse(await evalJs(`(function(){
    var bodyStyle=getComputedStyle(document.body);
    return JSON.stringify({
      button:!!document.getElementById('ambientFxBtn'),
      dataFx:document.body.hasAttribute('data-fx'),
      backdrop:!!document.querySelector('.app-backdrop,.theme-scene,.theme-light,.theme-atmosphere'),
      backgroundImage:bodyStyle.backgroundImage
    });
  })()`));
  T.assert(!ambient.button, '右上角不应保留环境特效按钮');
  T.assert(!ambient.dataFx && !ambient.backdrop, '页面不应保留环境特效状态或背景场景层');
  T.assert(ambient.backgroundImage === 'none', '页面背景必须只使用主题底色，不能加载背景图或渐变特效');

  await evalJs(T.importFileExpr(P.sample));
  await poll('window.__dshTest.state.records.length > 0', true);
  await T.sleep(650);

  const interaction = JSON.parse(await evalJs(`(function(){
    var metric=document.getElementById('selectedOrderMetric');
    var before=Number(metric.dataset.rollValue);
    var seg=document.querySelector('#dash .prow[data-ch="USPS"] .seg-line.on[data-seg]');
    seg.click();
    return JSON.stringify({
      before:before,
      target:Number(metric.dataset.rollValue),
      rolling:metric.classList.contains('metric-rolling'),
      particles:document.querySelectorAll('.fx-particle').length,
      interactionLayer:!!document.getElementById('interactionFxLayer'),
      sourceChannel:seg.closest('.prow').dataset.ch,
      hasNumber:!!metric.querySelector('.metric-number'),
      color:getComputedStyle(metric).color
    });
  })()`));
  T.assert(interaction.target < interaction.before, '关闭分段后激活订单目标值应下降');
  T.assert(interaction.rolling && interaction.hasNumber, '概览数字未触发滚动动画');
  T.assert(interaction.particles === 0 && !interaction.interactionLayer, '分段、渠道和导入点击不得再产生粒子层');
  T.assert(interaction.sourceChannel === 'USPS', '进退化测试必须关闭一个可被普通渠道吸收的非 CBT/CBS 分段');
  await T.sleep(650);
  T.assert(await evalJs(`document.querySelector('#selectedOrderMetric .metric-number').textContent`) === String(interaction.target), '数字滚动结束值不正确');

  const evolution = JSON.parse(await evalJs(`(function(){
    window.__dshTest.toggleOrdinaryEvolution();
    var evolved={
      state:window.__dshTest.state.ordinaryEvolved,
      ordinary:!!document.querySelector('#dash .prow[data-ch="普通"]'),
      links:document.querySelectorAll('.flow-fx-layer,.flow-path,.flow-route-tag').length
    };
    window.__dshTest.toggleOrdinaryEvolution();
    return JSON.stringify({evolved:evolved,devolved:{
      state:window.__dshTest.state.ordinaryEvolved,
      unknown:!!document.querySelector('#dash .prow[data-ch="未识别"]'),
      links:document.querySelectorAll('.flow-fx-layer,.flow-path,.flow-route-tag').length
    }});
  })()`));
  T.assert(evolution.evolved.state && evolution.evolved.ordinary, '未识别应仍可进化为普通');
  T.assert(!evolution.devolved.state && evolution.devolved.unknown, '普通应仍可退化为未识别');
  T.assert(evolution.evolved.links === 0 && evolution.devolved.links === 0, '普通 / 未识别进退化不得生成链接特效');

  console.log('✔ 环境特效按钮、状态、背景层和背景图已完全移除');
  console.log('✔ 概览数字滚动正常，点击粒子层已完全移除');
  console.log('✔ 普通 / 未识别进退化功能保留，链接特效已完全移除');
});
