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
  T.assert(ambient.backgroundImage === 'none', '页面主体不得加载背景图片');

  const themeDecor = JSON.parse(await evalJs(`(function(){
    return JSON.stringify(['dracula','yellow','jade','reddust','seaclear'].map(function(theme){
      document.body.dataset.theme=theme;
      var body=getComputedStyle(document.body);
      var before=getComputedStyle(document.body,'::before');
      var after=getComputedStyle(document.body,'::after');
      return {theme:theme,bg:body.backgroundColor,glow:before.backgroundImage,pattern:after.backgroundImage};
    }));
  })()`));
  T.assert(themeDecor.every(function(x){return x.glow !== 'none' && x.pattern !== 'none';}), '五套主题都必须具有自己的静态背景装饰');
  T.assert(new Set(themeDecor.map(function(x){return x.bg;})).size === 5, '五套主题必须具有不同的提亮底色');
  T.assert(new Set(themeDecor.map(function(x){return x.glow + x.pattern;})).size === 5, '五套主题的背景装饰不能完全相同');
  await evalJs(`document.body.dataset.theme='dracula'`);

  const savedTheme = JSON.parse(await evalJs(`(function(){
    document.getElementById('themeBtn').click();
    document.querySelector('#themeList [data-v="yellow"]').click();
    return JSON.stringify({theme:document.body.dataset.theme,stored:localStorage.getItem('wave-planner-theme')});
  })()`));
  T.assert(savedTheme.theme === 'yellow' && savedTheme.stored === 'yellow', '选择主题后必须写入浏览器本地存储');
  await send('Page.reload');
  await poll('document.readyState', 'complete');
  const restoredTheme = JSON.parse(await evalJs(`JSON.stringify({
    theme:document.body.dataset.theme,
    checked:document.querySelector('#themeList [data-v="yellow"]').getAttribute('aria-checked'),
    menuOn:document.querySelector('#themeList [data-v="yellow"]').classList.contains('on'),
    title:document.getElementById('themeBtn').title
  })`));
  T.assert(restoredTheme.theme === 'yellow' && restoredTheme.checked === 'true' && restoredTheme.menuOn, '刷新页面后必须恢复上次主题及菜单状态');
  T.assert(restoredTheme.title.indexOf('黄天当立') >= 0, '恢复主题后按钮提示必须同步');
  await evalJs(`(function(){
    document.getElementById('themeBtn').click();
    document.querySelector('#themeList [data-v="dracula"]').click();
  })()`);

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
  console.log('✔ 五套主题均使用不同的提亮底色与静态配色装饰');
  console.log('✔ 主题选择写入本地存储，刷新后自动恢复并同步菜单状态');
  console.log('✔ 概览数字滚动正常，点击粒子层已完全移除');
  console.log('✔ 普通 / 未识别进退化功能保留，链接特效已完全移除');
});
