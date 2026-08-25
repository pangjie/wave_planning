/* Chrome headless 端到端测试（终端风格·点击版·固定列宽与归并开关） */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./test-helpers.js');

const P = T.paths(__dirname);
const PORT = 9333;
const USER_DIR = P.tmp('chrome-profile');
const DL_DIR = P.tmp('downloads');
const HTML = P.html;
const SAMPLE = P.sample;
const { sleep, assert } = T;
const GRAY = 'rgb(139, 148, 158)'; /* 渠道否掉标签灰（app.js OFF_TAG_COLOR） */

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
  console.log('✔ 页面加载');

  /* 1. 空状态：直接显示空表格骨架，无说明段落、无品牌文字 */
  const empty = await evalJs(`(function(){
    return JSON.stringify({
      hasThead: !!document.querySelector('#dash thead'),
      unifiedRow: !!document.querySelector('#dash .urowe'),
      prowCount: document.querySelectorAll('#dash .prow').length,
      noUsage: document.getElementById('dash').textContent.indexOf('波次规划工具 — 终端风格') === -1,
      noBar: !document.querySelector('.bar'),
      themeOptions: document.querySelectorAll('#themeList li').length,
      themeDefault: document.querySelector('#themeList li.on').textContent,
      themeAttr: document.body.getAttribute('data-theme') || '',
      fontGone: !document.getElementById('fontBtn'),
      themeBtnInBtns: !!(document.getElementById('themeBtn') && document.getElementById('themeBtn').closest('.side-btns')),
      themeBtnText: (document.getElementById('themeBtn') || {textContent: ''}).textContent,
      sideExists: !!document.querySelector('.side'),
      btnInSide: !!(document.getElementById('btnImport') && document.getElementById('btnImport').closest('.side')),
      fileRowGone: !document.getElementById('fileLabel'),
      modeInSide: !!(document.getElementById('modeLabel') && document.getElementById('modeLabel').closest('.side')),
      wmsGenBtn: !!document.getElementById('wmsGenerate'),
      sideW: Math.round(document.querySelector('.side').getBoundingClientRect().width),
      wmsHidden: document.getElementById('wmsSection').style.display === 'none' && document.getElementById('wmsPanel').hidden,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      hasButtons: !!document.getElementById('btnImport') && !!document.getElementById('btnExport'),
      noHint: document.getElementById('dash').textContent.indexOf('勾选语义') === -1,
      unifiedLabel: document.querySelector('#dash .urowe td:first-child').textContent,
      unifiedAlign: getComputedStyle(document.querySelector('#dash .urowe td:first-child')).textAlign,
      shellMaxW: getComputedStyle(document.querySelector('.shell')).maxWidth,
      modeLabel: document.getElementById('modeLabel').textContent,
      modeToggle: document.getElementById('modeLabel').className.indexOf('mode-toggle') !== -1,
      statsLines: document.querySelectorAll('#dash .statsline').length,
      noDupStats: document.getElementById('dash').textContent.indexOf('单品单件') === -1,
      engineHidden: document.getElementById('engineLabelWrap').style.display === 'none',
      engineText: document.getElementById('engineLabel').textContent
    });
  })()`);
  const em = JSON.parse(empty);
  assert(em.hasThead === true && em.unifiedRow === true && em.prowCount === 12, '空状态应显示 12 个渠道行的表格骨架（含空渠道）');
  assert(em.noUsage === true && em.noBar === true, '说明段落或品牌文字未移除，顶栏应彻底移除');
  assert(em.hasButtons === true, '导入/导出按钮缺失');
  assert(em.themeOptions === 5 && em.themeDefault === '光耀紫府', '主题应为 5 个选项且默认光耀紫府: ' + JSON.stringify({n: em.themeOptions, d: em.themeDefault}));
  assert(em.themeAttr === 'dracula', '默认主题属性应为 dracula: ' + em.themeAttr);
  assert(em.fontGone === true, '字体选择功能应已移除（字体固定 Sarasa Mono SC）');
  assert(em.sideExists === true && em.btnInSide === true && em.fileRowGone === true && em.modeInSide === true,
    '导入/导出与渠道模式应位于左侧操作栏，且导入文档行已移除: ' + JSON.stringify({s: em.sideExists, b: em.btnInSide, f: em.fileRowGone, m: em.modeInSide}));
  assert(em.themeBtnInBtns === true && em.themeBtnText === '主题', '主题按钮应位于按钮行且仅显示「主题」二字: ' + JSON.stringify({in: em.themeBtnInBtns, t: em.themeBtnText}));
  assert(em.wmsGenBtn === true, '操作栏应存在生成波次按钮');
  assert(em.sideW === 200, '操作栏宽度应为 200px: ' + em.sideW);
  assert(em.wmsHidden === true, 'file:// 打开时 WMS 联动区应隐藏（离线纯规划模式）');
  assert(em.bodyBg === 'rgb(40, 42, 54)', '默认主题应为光耀紫府（深紫底）: ' + em.bodyBg);
  assert(em.statsLines === 0, '表格上方统计条应已移除');
  assert(em.noHint === true, '底部勾选语义说明未移除');
  assert(em.unifiedLabel === '统一调整' && em.unifiedAlign === 'center', '统一行标签应为「统一调整」且水平居中: ' + JSON.stringify({l: em.unifiedLabel, a: em.unifiedAlign}));
  assert(em.shellMaxW === '1160px', '页面最大宽度应为 1160px: ' + em.shellMaxW);
  assert(await evalJs(`!document.getElementById('countLabel')`) === true, '顶栏不应再有订单统计');
  assert(em.modeLabel === '拆分' && em.modeToggle === true, '渠道模式应显示「拆分」且可点击: ' + em.modeLabel);
  assert(em.statsLines === 0 && em.noDupStats === true, '表格上方不应再有重复统计');
  assert(em.engineHidden === true && em.engineText === '', '引擎正常时不应显示引擎状态: ' + JSON.stringify({h: em.engineHidden, t: em.engineText}));
  console.log('✔ 空状态：表格骨架，渠道模式切换，统一调整居中，最大宽 1160px；顶栏已移除');

  /* 2. 导入 */
  await evalJs(T.importFileExpr(SAMPLE));
  await poll(`window.__dshTest.state.records.length`, 5700);
  assert(await evalJs(`document.getElementById('status').textContent`) === '', '导入订单后不应显示动作说明');
  assert(await evalJs(`document.querySelectorAll('#dash .prow').length`) === 12, '渠道行应为 12（含空渠道）');

  const struct = await evalJs(`(function(){
    var row = document.querySelector('#dash .prow');
    var cells = row.querySelectorAll('td');
    var ths = document.querySelectorAll('#dash thead th');
    var headTxt = Array.prototype.map.call(ths, function(th){return th.textContent;}).join('|');
    var paperLine = row.querySelectorAll('.segtd')[1].querySelector('.seg-line');
    var paperKey = paperLine ? paperLine.dataset.seg : '';
    var absorbTxt = row.querySelector('.aval').textContent;
    var wcColor = getComputedStyle(document.querySelector('#dash .type-count[data-t="hot"] .wc')).color;
    var ocColor = getComputedStyle(document.querySelector('#dash .type-count[data-t="hot"] .oc')).color;
    var headHasCount = headTxt.indexOf('波') !== -1;
    var urowCountTxt = Array.prototype.map.call(document.querySelectorAll('#dash .urowe .type-count'), function(el){ return el.textContent; }).join('|');
    var urowOrder = document.querySelector('#dash .urowe td.num').textContent;
    var th0w = ths[0].getBoundingClientRect().width;
    var midW = [1,2,3,4,5,6].map(function(i){ return Math.round(ths[i].getBoundingClientRect().width); });
    return JSON.stringify({
      cols: cells.length,
      order: cells[1].textContent,
      head: headTxt,
      paperShown: paperLine ? paperLine.textContent : '',
      paperKey: paperKey,
      absorbTxt: absorbTxt,
      wcColor: wcColor,
      ocColor: ocColor,
      headHasCount: headHasCount,
      urowCountTxt: urowCountTxt,
      urowOrder: urowOrder,
      th0w: Math.round(th0w),
      midW: midW,
      layout: getComputedStyle(document.querySelector('.pt')).tableLayout
    });
  })()`);
  const sc = JSON.parse(struct);
  assert(sc.cols === 11 && sc.order === '1318', '合并表结构错误');
  assert(sc.head.indexOf('渠道') !== -1 && sc.head.indexOf('爆品') !== -1 && sc.head.indexOf('单件') !== -1 &&
    sc.head.indexOf('多件') !== -1 && sc.head.indexOf('混件') !== -1, '表头类型名错误: ' + sc.head);
  assert(sc.head.indexOf('单件paper') === -1, '表头仍显示单件paper: ' + sc.head);
  assert(sc.head.indexOf('多件段') === -1 && sc.head.indexOf('混件段') === -1, '表头应为多件/混件而非多件段/混件段: ' + sc.head);
  assert(sc.paperShown.indexOf('单件·283·46') !== -1 && sc.paperShown.indexOf('单件paper') === -1, '单件paper 显示名或统计顺序错误: ' + sc.paperShown);
  assert(sc.paperKey === 'SwiftX|单件paper-1', '内部键名被改动（影响导出）: ' + sc.paperKey);
  assert(sc.absorbTxt === '关闭', '吸收列应只显示档位名（无数字）: ' + sc.absorbTxt);
  assert(sc.wcColor !== sc.ocColor, '波数/单量未着色区分');
  assert(sc.th0w === 104, '渠道列宽未固定为 104px: ' + sc.th0w);
  assert(sc.midW.every(function(w){return w === 60;}), '订单/容量/爆品/多件/混件/吸收六列应等宽 60px: ' + JSON.stringify(sc.midW));
  assert(sc.head.indexOf('爆品线') === -1 && sc.head.indexOf('容量') < sc.head.indexOf('爆品'), '列顺序应为 渠道/订单/容量/爆品/…: ' + sc.head);
  assert(sc.layout === 'fixed', '表格未使用固定布局');
  assert(sc.headHasCount === false, '表头类型列不应再显示波/单统计');
  assert(sc.urowCountTxt.indexOf('波') !== -1 && sc.urowCountTxt.split('|').length === 4, '波/单统计应在统一行类型列: ' + sc.urowCountTxt);
  assert(sc.urowOrder === '5700', '统一行订单总量应为 5700（全选时）: ' + sc.urowOrder);
  /* 操作栏紧贴表格：side.right == twrap.x */
  const align = await evalJs(`(function(){
    var t = document.querySelector('.twrap').getBoundingClientRect();
    var s = document.querySelector('.side').getBoundingClientRect();
    var b = document.querySelector('.side-btns').getBoundingClientRect();
    return JSON.stringify({sideRight: Math.round(s.right - t.x), sideW: Math.round(s.width), topGap: Math.round(b.top - t.top)});
  })()`);
  const al = JSON.parse(align);
  assert(Math.abs(al.sideRight) < 2 && al.sideW === 200, '操作栏与表格位置不一致: ' + JSON.stringify(al));
  assert(Math.abs(al.topGap) < 2, '操作栏与表格顶端应对齐: ' + JSON.stringify(al));
  console.log('✔ 导入：11 列结构；操作栏（200px）紧贴表格且顶端对齐（Δtop=' + al.topGap + 'px）');

  /* 2.5 渠道标签（p10k 等宽风格）、行内留空、否掉变色 */
  const tag = await evalJs(`(function(){
    var els = Array.prototype.slice.call(document.querySelectorAll('#dash .prow .chn'));
    var widths = els.map(function(el){ return Math.round(el.getBoundingClientRect().width * 100) / 100; });
    var el = els[0];
    var cs = getComputedStyle(el);
    var arrow = getComputedStyle(el, '::after');
    var td = document.querySelector('#dash .prow td:nth-child(2)');
    var tcs = getComputedStyle(td);
    var chTd = document.querySelector('#dash .prow td:first-child');
    var chevronEnd = el.getBoundingClientRect().right + 9;
    var tdRight = chTd.getBoundingClientRect().right;
    return JSON.stringify({
      widths: widths,
      equalWidth: widths.every(function(w){ return w === widths[0]; }),
      bg: cs.backgroundColor,
      color: cs.color,
      arrowColor: arrow.borderLeftColor,
      arrowVisible: parseFloat(arrow.borderTopWidth) > 0 && parseFloat(arrow.borderLeftWidth) > 0,
      padTop: Math.round(parseFloat(tcs.paddingTop)),
      vAlign: tcs.verticalAlign,
      chevronClearance: Math.round(tdRight - chevronEnd)
    });
  })()`);
  const tg = JSON.parse(tag);
  assert(tg.equalWidth === true, '渠道标签应等宽: ' + JSON.stringify(tg.widths));
  assert(tg.bg !== 'rgba(0, 0, 0, 0)' && tg.color === 'rgb(0, 0, 0)', '渠道标签应为彩色背景+黑字: ' + JSON.stringify(tg));
  assert(tg.arrowVisible === true && tg.arrowColor === tg.bg, '渠道标签右侧应有同色尖角: ' + JSON.stringify(tg));
  assert(tg.padTop >= 10 && tg.padTop <= 12 && tg.vAlign === 'top', '渠道行应上下各留半个行高且顶部对齐: ' + JSON.stringify(tg));
  assert(tg.chevronClearance >= 8, '尖角与表格线框太贴近: ' + tg.chevronClearance + 'px');
  console.log('✔ 渠道标签：等宽 p10k 风格（彩底黑字+尖角，与线框留出 ' + tg.chevronClearance + 'px）；行首尾留空、顶部对齐');

  /* 2.6 否掉渠道 → 标签变灰；否掉分段 → 文字变灰（一致变色） */
  const offColor = await evalJs(`(function(){
    document.querySelector('#dash .chn[data-ch="CBT"]').click();
    var cbtTag = document.querySelector('#dash .chn[data-ch="CBT"]');
    var otherTag = document.querySelector('#dash .chn[data-ch="SwiftX"]');
    var cbtVar = getComputedStyle(cbtTag).backgroundColor;
    var otherVar = getComputedStyle(otherTag).backgroundColor;
    var segOn = document.querySelector('#dash .prow[data-ch="Gofo"] .seg-line');
    var segOff = document.querySelector('#dash .prow[data-ch="CBT"] .seg-line');
    var onColor = getComputedStyle(segOn.querySelector('.seg-name')).color;
    var offColor = getComputedStyle(segOff.querySelector('.seg-name')).color;
    var offClass = segOff.classList.contains('off');
    /* 可调参数随渠道一并变色 */
    var arrOn = getComputedStyle(document.querySelector('#dash .prow[data-ch="Gofo"] .arr')).color;
    var arrOff = getComputedStyle(document.querySelector('#dash .prow[data-ch="CBT"] .arr')).color;
    var pvalOff = getComputedStyle(document.querySelector('#dash .prow[data-ch="CBT"] .pval')).color;
    var avalOff = getComputedStyle(document.querySelector('#dash .prow[data-ch="CBT"] .aval')).color;
    var rowOffClass = document.querySelector('#dash .prow[data-ch="CBT"]').classList.contains('off');
    /* 恢复 */
    document.querySelector('#dash .chn[data-ch="CBT"]').click();
    var restored = getComputedStyle(document.querySelector('#dash .chn[data-ch="CBT"]')).backgroundColor;
    return JSON.stringify({cbtVar: cbtVar, otherVar: otherVar, segOnColor: onColor, segOffColor: offColor, offClass: offClass,
      arrOn: arrOn, arrOff: arrOff, pvalOff: pvalOff, avalOff: avalOff, rowOffClass: rowOffClass,
      restoredOk: restored === otherVar || restored !== cbtVar});
  })()`);
  const oc = JSON.parse(offColor);
  assert(oc.cbtVar !== oc.otherVar, '否掉渠道后标签未变色');
  assert(oc.cbtVar === 'rgb(139, 148, 158)', '否掉渠道标签应为灰色: ' + oc.cbtVar);
  assert(oc.segOffColor !== oc.segOnColor && oc.offClass === true, '否掉分段后文字未变色');
  assert(oc.rowOffClass === true && oc.arrOff !== oc.arrOn, '否掉渠道后其可调参数未变色: ' + JSON.stringify({r: oc.rowOffClass, a: oc.arrOff, on: oc.arrOn}));
  assert(oc.arrOff === oc.pvalOff && oc.pvalOff === oc.avalOff, '参数变色应一致（灰）: ' + JSON.stringify({arr: oc.arrOff, pval: oc.pvalOff, aval: oc.avalOff}));
  assert(oc.restoredOk === true, '恢复渠道后标签颜色未还原');
  console.log('✔ 否掉渠道→标签变灰、否掉分段→文字变灰，恢复后还原');

  /* 3. 结构稳定 + 单段取消 → 类型全选框绿～ */
  const stable = await evalJs(`(function(){
    function geo(sel){
      var el = document.querySelector(sel);
      var r = el.getBoundingClientRect();
      return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',');
    }
    var before = { row: geo('#dash .prow'), head: geo('#dash thead th'), seg: geo('#dash .seg-line'), table: geo('#dash .twrap'), scroll: document.getElementById('out').scrollTop };
    var el = document.querySelector('#dash .seg-line[data-seg="CBT|单件paper-1"]');
    var key = el.dataset.seg;
    var clsBefore = el.className;
    el.click();
    var after = { row: geo('#dash .prow'), head: geo('#dash thead th'), seg: geo('#dash .seg-line'), table: geo('#dash .twrap'), scroll: document.getElementById('out').scrollTop };
    var el2 = document.querySelector('#dash .seg-line[data-seg="' + CSS.escape(key) + '"]');
    var paperMaster = document.querySelector('#dash [data-master="t:paper"].tog');
    var cnt = document.querySelector('#dash .type-count[data-t="paper"]').textContent;
    return JSON.stringify({
      same: JSON.stringify(before) === JSON.stringify(after),
      clsFlipped: clsBefore !== el2.className,
      paperMaster: {text: paperMaster.textContent, some: paperMaster.classList.contains('some')},
      count: cnt
    });
  })()`);
  const st = JSON.parse(stable);
  assert(st.same === true, '勾选分段导致布局变化');
  assert(st.clsFlipped === true, '分段行状态类未更新');
  assert(st.paperMaster.text === '[~]' && st.paperMaster.some === true, '类型全选框应为绿～');
  assert(st.count === '16波/2949单', '类型统计未按绿X更新: ' + st.count);
  console.log('✔ 结构稳定；取消 CBT 单件paper 后类型框=绿～，统计 16波/2949单（着色子元素就地更新）');

  /* 4. 类型全选三态 */
  async function hotMaster() {
    return await evalJs(`(function(){var el=document.querySelector('#dash [data-master="t:hot"].tog');return JSON.stringify({text:el.textContent,on:el.classList.contains('on'),some:el.classList.contains('some'),off:el.classList.contains('off')});})()`);
  }
  await evalJs(`(function(){document.querySelector('#dash [data-master="t:hot"].tog').click();return 1;})()`);
  assert(JSON.parse(await hotMaster()).off === true, '全选状态下点击应全否');
  await evalJs(`(function(){document.querySelector('#dash [data-master="t:hot"].tog').click();return 1;})()`);
  assert(JSON.parse(await hotMaster()).on === true, '全否后点击应恢复绿X');
  console.log('✔ 类型全选框三态：绿X → 灰空 → 绿X');

  /* 5. 渠道优先 */
  await evalJs(`(function(){document.querySelector('#dash .chn[data-ch="CBT"]').click();return 1;})()`);
  const cbtSegs = await evalJs(`(function(){
    return Array.prototype.every.call(document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]'), function(el){ return el.classList.contains('off') && !el.classList.contains('on'); });
  })()`);
  assert(cbtSegs === true, '关闭渠道后其分段仍显示绿色');
  const urowAfterCbtOff = await evalJs(`document.querySelector('#dash .urowe td.num').textContent`);
  assert(urowAfterCbtOff === '4465', '订单总量应排除否掉的 CBT: ' + urowAfterCbtOff);
  const chMasterMid = await evalJs(`(function(){var el=document.querySelector('#dash [data-master="ch"].tog');return JSON.stringify({text:el.textContent,some:el.classList.contains('some')});})()`);
  assert(JSON.parse(chMasterMid).text === '[~]' && JSON.parse(chMasterMid).some === true, '部分渠道关闭时渠道全选框应为绿～');
  /* 渠道全选框功能：全选/全不选 */
  await evalJs(`(function(){document.querySelector('#dash [data-master="ch"].tog').click();return 1;})()`);
  assert(await evalJs(`window.__dshTest.state.modes.normal.sel.channels.size`) === 12, '渠道全选框点击后应全选');
  assert(await evalJs(`document.querySelector('#dash .urowe td.num').textContent`) === '5700', '全选后订单总量应回 5700');
  await evalJs(`(function(){document.querySelector('#dash [data-master="ch"].tog').click();return 1;})()`);
  assert(await evalJs(`window.__dshTest.state.modes.normal.sel.channels.size`) === 0, '渠道全选框再次点击应全不选');
  assert(await evalJs(`document.querySelector('#dash .urowe td.num').textContent`) === '0', '全不选后订单总量应为 0');
  await evalJs(`(function(){document.querySelector('#dash [data-master="ch"].tog').click();return 1;})()`);
  assert(await evalJs(`window.__dshTest.state.modes.normal.sel.channels.size`) === 12, '渠道全选框恢复失败');
  /* 再次关闭 CBT，验证渠道未全开时类型全选框只能绿～（单件paper 跨多渠道，适合验证） */
  async function multiMaster() {
    return await evalJs(`(function(){var el=document.querySelector('#dash [data-master="t:multi"].tog');return JSON.stringify({text:el.textContent,on:el.classList.contains('on'),some:el.classList.contains('some'),off:el.classList.contains('off')});})()`);
  }
  await evalJs(`(function(){document.querySelector('#dash .chn[data-ch="CBT"]').click();return 1;})()`);
  assert(await evalJs(`document.querySelector('#dash .urowe td.num').textContent`) === '4465', '再次关闭 CBT 后订单总量应 4465');
  await evalJs(`(function(){document.querySelector('#dash [data-master="t:multi"].tog').click();return 1;})()`);
  await evalJs(`(function(){document.querySelector('#dash [data-master="t:multi"].tog').click();return 1;})()`);
  const hm = JSON.parse(await multiMaster());
  assert(hm.text === '[~]' && hm.some === true && hm.on === false, '渠道未全开时类型全选框出现了绿X');
  await evalJs(`(function(){document.querySelector('#dash .chn[data-ch="CBT"]').click();return 1;})()`);
  assert(JSON.parse(await multiMaster()).on === true, '渠道恢复后类型全选框应回绿X');
  assert(await evalJs(`document.querySelector('#dash .urowe td.num').textContent`) === '5700', '恢复 CBT 后订单总量应回 5700');
  console.log('✔ 渠道优先：全选框绿X/绿～/全选全不选；关闭渠道→分段全灰；恢复后回绿X');

  /* 6. 渠道模式切换（顶栏）：拆分 / 归并 */
  await evalJs(`(function(){document.getElementById('modeLabel').click();return 1;})()`);
  await poll(`window.__dshTest.state.merged`, true);
  assert(await evalJs(`document.querySelectorAll('#dash .prow').length`) === 3, '归并后应 3 行（CBT/CBS/普通）');
  assert(await evalJs(`document.getElementById('modeLabel').textContent`) === '归并', '渠道模式标签未更新');
  assert(await evalJs(`document.getElementById('modeLabel').className.indexOf('on') !== -1`) === true, '归并模式标签未高亮');
  const mergedSel = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.merged.sel;
    var a = window.__dshTest.getAnalysis('merged');
    var ids = a.channels.map(function(c){return c.id;});
    var allCh = ids.every(function(id){return m.channels.has(id);});
    var segKeys = [];
    a.channels.forEach(function(ch){ch.segments.forEach(function(s){segKeys.push(ch.id+'|'+s.name);});});
    var allSeg = segKeys.every(function(k){return m.segs.has(k);});
    var segOn = Array.prototype.every.call(document.querySelectorAll('#dash .seg-line[data-seg]'), function(el){return el.classList.contains('on');});
    return JSON.stringify({ids: ids.join(','), allCh: allCh, allSeg: allSeg, segOn: segOn});
  })()`);
  const ms2 = JSON.parse(mergedSel);
  assert(ms2.ids === '普通,CBT,CBS' && ms2.allCh === true && ms2.allSeg === true && ms2.segOn === true, '归并后默认渠道/分段未全选: ' + JSON.stringify(ms2));
  await evalJs(`(function(){document.getElementById('modeLabel').click();return 1;})()`);
  await poll(`window.__dshTest.state.merged`, false);
  assert(await evalJs(`document.getElementById('modeLabel').textContent`) === '拆分', '渠道模式标签未还原');
  assert(await evalJs(`document.querySelectorAll('#dash .prow').length`) === 12, '拆分后应 12 行（含空渠道）');
  console.log('✔ 渠道模式切换：顶栏点击 拆分⇄归并，归并默认全选，拆分还原全部渠道');

  /* 7. 数字步进与吸收循环 */
  async function clickSel(sel) { return await evalJs(`(function(){var el=document.querySelector('${sel}');if(!el)return false;el.click();return true;})()`); }
  await clickSel(`#dash .arr-r[data-p="capacity"][data-ch="CBT"]`);
  await poll(`(function(){return window.__dshTest.curAnalysis().channels.filter(function(c){return c.id==='CBT';})[0].params.capacity;})()`, 500);
  await clickSel(`#dash .arr-r[data-p="capacity"][data-ch="CBT"]`);
  assert(await evalJs(`window.__dshTest.curAnalysis().channels.filter(function(c){return c.id==='CBT';})[0].params.capacity`) === 600, '容量 +100 步进错误');
  for (let i = 0; i < 10; i++) await clickSel(`#dash .arr-l[data-p="capacity"][data-ch="CBT"]`);
  assert(await evalJs(`window.__dshTest.curAnalysis().channels.filter(function(c){return c.id==='CBT';})[0].params.capacity`) === 100, '容量下限钳制错误');
  /* 参数调整产生的新分段默认选中 */
  const newSeg = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.normal.sel;
    var togs = document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]');
    var allOn = Array.prototype.every.call(togs, function(el){
      return el.classList.contains('on') && m.segs.has(el.dataset.seg);
    });
    return JSON.stringify({count: togs.length, allOn: allOn});
  })()`);
  const ns = JSON.parse(newSeg);
  assert(ns.count > 4 && ns.allOn === true, '参数调整产生的新分段未默认选中: ' + JSON.stringify(ns));
  console.log('✔ 容量调至 100 产生 ' + ns.count + ' 个 CBT 分段，新分段全部默认选中');
  async function absorbOfCBT() {
    return await evalJs(`window.__dshTest.curAnalysis().channels.filter(function(c){return c.id==='CBT';})[0].params.absorb`);
  }
  await clickSel(`#dash .aval[data-ch="CBT"]`);
  assert(await absorbOfCBT() === 2, '吸收第 1 击应到 2');
  assert(await evalJs(`document.querySelector('#dash .prow[data-ch="CBT"] .aval').textContent`) === '吸收', '吸收档位名错误');
  await clickSel(`#dash .aval[data-ch="CBT"]`);
  assert(await absorbOfCBT() === 3 && await evalJs(`document.querySelector('#dash .prow[data-ch="CBT"] .aval').textContent`) === '多件', '吸收档位名错误');
  await clickSel(`#dash .aval[data-ch="CBT"]`);
  assert(await absorbOfCBT() === 4 && await evalJs(`document.querySelector('#dash .prow[data-ch="CBT"] .aval').textContent`) === '全量', '吸收档位名错误');
  await clickSel(`#dash .aval[data-ch="CBT"]`);
  assert(await absorbOfCBT() === 1, '吸收应循环回 1');
  console.log('✔ 数字步进（容量±100）· 吸收循环（关闭→吸收→多件→全量→关闭）');

  /* 7.5 渠道开关新规则：纯切换显示一致 + 点渠道全选分段 + 全段否掉自动关渠道 */
  /* A. 关闭渠道 → 点其分段：可见切换、渠道保持关闭、其他分段不受影响 */
  await evalJs(`(function(){document.querySelector('#dash .chn[data-ch="CBT"]').click();return 1;})()`);
  const deadKey = await evalJs(`(function(){
    var togs = document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]');
    return JSON.stringify({first: togs[0].dataset.seg, second: togs[1].dataset.seg, n: togs.length});
  })()`);
  const dk = JSON.parse(deadKey);
  const pure = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.normal.sel;
    var first = '${dk.first}', second = '${dk.second}';
    var beforeFirst = m.segs.has(first), beforeSecond = m.segs.has(second);
    var elBefore = document.querySelector('#dash .seg-line[data-seg="' + CSS.escape(first) + '"]');
    var clsBefore = elBefore.className;
    elBefore.click();
    var elAfter = document.querySelector('#dash .seg-line[data-seg="' + CSS.escape(first) + '"]');
    return JSON.stringify({
      toggled: beforeFirst !== m.segs.has(first),
      chStillOff: !m.channels.has('CBT'),
      stillGray: elAfter.classList.contains('off') && !elAfter.classList.contains('on'),
      clsUnchanged: clsBefore === elAfter.className,
      otherUnchanged: beforeSecond === m.segs.has(second)
    });
  })()`);
  const pu = JSON.parse(pure);
  assert(pu.toggled === true, '被否渠道分段点击应纯切换原始状态: ' + JSON.stringify(pu));
  assert(pu.chStillOff === true && pu.stillGray === true && pu.clsUnchanged === true && pu.otherUnchanged === true, '纯切换不应联动渠道/其他分段');
  /* B. 点击渠道标签 → 渠道点亮且其全部分段被选中 */
  await evalJs(`(function(){document.querySelector('#dash .chn[data-ch="CBT"]').click();return 1;})()`);
  const revAll = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.normal.sel;
    var togs = Array.prototype.slice.call(document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]'));
    return JSON.stringify({
      chOn: m.channels.has('CBT'),
      allSegOn: togs.every(function(el){ return m.segs.has(el.dataset.seg); }),
      allGreen: togs.every(function(el){ return el.classList.contains('on'); })
    });
  })()`);
  const ra = JSON.parse(revAll);
  assert(ra.chOn === true && ra.allSegOn === true && ra.allGreen === true, '点击渠道选择框应点亮渠道并全选其分段: ' + JSON.stringify(ra));
  /* C. 渠道全部分段被否掉 → 渠道自动转为否掉 */
  await evalJs(`(function(){
    document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]').forEach(function(el){ el.click(); });
    return 1;
  })()`);
  const autoOff = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.normal.sel;
    var chnTag = document.querySelector('#dash .chn[data-ch="CBT"]');
    return JSON.stringify({
      chOff: !m.channels.has('CBT'),
      chTagGray: getComputedStyle(chnTag).backgroundColor === 'rgb(139, 148, 158)'
    });
  })()`);
  const ao = JSON.parse(autoOff);
  assert(ao.chOff === true && ao.chTagGray === true, '全部分段否掉后渠道应自动否掉: ' + JSON.stringify(ao));
  /* D. 再点渠道标签 → 渠道点亮且全部分段选中 */
  await evalJs(`(function(){document.querySelector('#dash .chn[data-ch="CBT"]').click();return 1;})()`);
  const rev2 = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.normal.sel;
    var togs = Array.prototype.slice.call(document.querySelectorAll('#dash .prow[data-ch="CBT"] .seg-line[data-seg]'));
    return JSON.stringify({
      chOn: m.channels.has('CBT'),
      allSegOn: togs.every(function(el){ return m.segs.has(el.dataset.seg); }),
      allGreen: togs.every(function(el){ return el.classList.contains('on'); })
    });
  })()`);
  const r2 = JSON.parse(rev2);
  assert(r2.chOn === true && r2.allSegOn === true && r2.allGreen === true, '再点渠道选择框应全选其分段: ' + JSON.stringify(r2));
  /* E. 点击与拖动区分：按下后位移超过阈值再松开 → 不切换；正常点击 → 切换 */
  const clickVsDrag = await evalJs(`(function(){
    var m = window.__dshTest.state.modes.normal.sel;
    var tag = document.querySelector('#dash .chn[data-ch="CBT"]');
    var onBefore = m.channels.has('CBT');
    tag.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, clientX:10, clientY:10}));
    document.dispatchEvent(new MouseEvent('mousemove', {bubbles:true, clientX:50, clientY:50}));
    tag.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    var onAfterMovedClick = m.channels.has('CBT');
    tag.click();
    var onAfterPlainClick = m.channels.has('CBT');
    tag.click();
    var onRestored = m.channels.has('CBT');
    return JSON.stringify({onBefore:onBefore, movedNoFlip: onAfterMovedClick === onBefore,
      plainFlip: onAfterPlainClick !== onBefore, restored: onRestored === onBefore});
  })()`);
  const cvd = JSON.parse(clickVsDrag);
  assert(cvd.onBefore === true && cvd.movedNoFlip === true && cvd.plainFlip === true && cvd.restored === true,
    '点击/拖动区分失败: ' + JSON.stringify(cvd));
  console.log('✔ 渠道开关：纯切换显示一致；点渠道标签=全选其分段；全段否掉=渠道自动否掉；拖动不触发点击切换');

  /* 8. 导出（状态 + 页面内缓冲区验证；真实下载到盘由 web-chain 覆盖） */
  await evalJs(`document.getElementById('btnExport').click()`);
  await sleep(400);
  const expStatus = await evalJs(`document.getElementById('status').textContent`);
  assert(expStatus.indexOf('已导出') === 0, '导出状态错误: ' + expStatus);
  const b64buf = await evalJs(`window.__dshTest.buildExportBuffer()`);
  assert(typeof b64buf === 'string' && b64buf.length > 100000, '导出缓冲区异常: ' + (b64buf ? b64buf.length : 'null'));
  fs.writeFileSync(path.join(__dirname, 'tmp', 'e2e-export-click.xlsx'), Buffer.from(b64buf, 'base64'));
  await evalJs(`(function(){
    document.querySelector('#dash [data-master="ch"].tog').click();
    return 1;
  })()`);
  await evalJs(`document.getElementById('btnExport').click()`);
  await sleep(300);
  const stMsg = await evalJs(`document.getElementById('status').textContent`);
  assert(stMsg.indexOf('没有可导出的分段') === 0, '空选导出未阻止: ' + stMsg);
  await evalJs(`(function(){document.querySelector('#dash [data-master="ch"].tog').click();return 1;})()`);
  console.log('✔ 导出成功 + 全渠道关闭阻止导出');

  /* 10. 齿轮配置面板：配色 + 字体（列表固定向下弹出，字体真实生效） */
  const cfg = await evalJs(`(function(){
    function pick(listSel, v){ document.querySelector(listSel + ' li[data-v="' + v + '"]').click(); }
    /* 主题按钮：点击直接向下弹出列表（覆盖表格），选择即切换 */
    var tb = document.getElementById('themeBtn');
    tb.click();
    var tl = document.getElementById('themeList');
    var themeListShown = !tl.hidden;
    var tbRect = tb.getBoundingClientRect(), tlRect = tl.getBoundingClientRect();
    var themeDropsDown = tlRect.top >= tbRect.bottom - 1;
    var probe = document.elementFromPoint(tlRect.left + 8, tlRect.top + 8);
    var listOverTable = !!(probe && tl.contains(probe));
    pick('#themeList', 'yellow');
    var themeAttr = document.body.getAttribute('data-theme');
    var themeBtnTxt = tb.textContent;
    var themeBtnTitle = tb.title;
    var yellowBg = getComputedStyle(document.body).backgroundColor;
    var yellowAttr = document.body.getAttribute('data-theme');
    pick('#themeList', 'jade');
    var jadeBg = getComputedStyle(document.body).backgroundColor;
    var jadeAttr = document.body.getAttribute('data-theme');
    pick('#themeList', 'reddust');
    var reddustBg = getComputedStyle(document.body).backgroundColor;
    var reddustAttr = document.body.getAttribute('data-theme');
    pick('#themeList', 'seaclear');
    var seaclearBg = getComputedStyle(document.body).backgroundColor;
    var seaclearAttr = document.body.getAttribute('data-theme');
    pick('#themeList', 'dracula');
    var draculaBack = document.body.getAttribute('data-theme');
    /* Esc 关闭与外部点击关闭 */
    tb.click();
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    var hiddenByEsc = tl.hidden;
    tb.click();
    var reshown = !tl.hidden;
    document.body.click();
    var hiddenByOutside = tl.hidden;
    return JSON.stringify({themeListShown:themeListShown, themeDropsDown:themeDropsDown, listOverTable:listOverTable,
      themeBtnTxt:themeBtnTxt, themeBtnTitle:themeBtnTitle, themeAttr:themeAttr, yellowBg:yellowBg, yellowAttr:yellowAttr,
      jadeBg:jadeBg, jadeAttr:jadeAttr, reddustBg:reddustBg, reddustAttr:reddustAttr,
      seaclearBg:seaclearBg, seaclearAttr:seaclearAttr, draculaBack:draculaBack, hiddenByEsc:hiddenByEsc, reshown:reshown, hiddenByOutside:hiddenByOutside});
  })()`);
  const cf = JSON.parse(cfg);
  assert(cf.themeListShown === true && cf.themeDropsDown === true && cf.listOverTable === true, '主题列表应从按钮下方弹出并覆盖表格: ' + JSON.stringify(cf));
  assert(cf.themeBtnTxt === '主题' && cf.themeBtnTitle === '当前主题：黄天当立', '主题按钮文案应保持「主题」: ' + JSON.stringify(cf));
  assert(cf.yellowAttr === 'yellow' && cf.yellowBg === 'rgb(26, 20, 8)', '黄天当立主题未生效: ' + JSON.stringify(cf));
  assert(cf.jadeAttr === 'jade' && cf.jadeBg === 'rgb(12, 26, 22)', '蟠青丛翠主题未生效: ' + JSON.stringify(cf));
  assert(cf.reddustAttr === 'reddust' && cf.reddustBg === 'rgb(26, 13, 13)', '万丈红尘主题未生效: ' + JSON.stringify(cf));
  assert(cf.seaclearAttr === 'seaclear' && cf.seaclearBg === 'rgb(6, 18, 26)', '海晏河清主题未生效: ' + JSON.stringify(cf));
  assert(cf.draculaBack === 'dracula', '光耀紫府应可重新选中: ' + JSON.stringify(cf));
  assert(cf.hiddenByEsc === true && cf.reshown === true && cf.hiddenByOutside === true, '主题列表 Esc/点击外部关闭失败: ' + JSON.stringify(cf));
  /* 主题抽查：五档背景色 */
  const alt = await evalJs(`(function(){
    function bg(){ return getComputedStyle(document.body).backgroundColor; }
    function pick(listSel, v){ document.querySelector(listSel + ' li[data-v="' + v + '"]').click(); }
    var out = [];
    pick('#themeList', 'yellow'); out.push(bg());
    pick('#themeList', 'jade'); out.push(bg());
    pick('#themeList', 'reddust'); out.push(bg());
    pick('#themeList', 'seaclear'); out.push(bg());
    pick('#themeList', 'dracula'); out.push(bg());
    pick('#themeList', 'dracula');
    return JSON.stringify(out);
  })()`);
  const als = JSON.parse(alt);
  assert(als[0] === 'rgb(26, 20, 8)' && als[1] === 'rgb(12, 26, 22)' && als[2] === 'rgb(26, 13, 13)' && als[3] === 'rgb(6, 18, 26)' && als[4] === 'rgb(40, 42, 54)',
    '主题五档切换未生效: ' + JSON.stringify(als));
  console.log('✔ 主题按钮：点击直接向下弹出列表（覆盖表格），四档主题生效，Esc/点击外部关闭');
  /* 11. 拖动 + Alt+↓ */
  const dragRes = await evalJs(`(function(){
    var chns = Array.prototype.slice.call(document.querySelectorAll('#dash .prow .chn'));
    var src = chns[1];
    var dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer:dt}));
    var row0 = chns[0].closest('.prow');
    var rect = row0.getBoundingClientRect();
    row0.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt, clientY: rect.top + 2}));
    row0.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt, clientY: rect.top + 2}));
    src.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer:dt}));
    return window.__dshTest.state.modes.normal.order.list.join(',');
  })()`);
  assert(dragRes.split(',')[0] === 'CBT', '拖动排序未生效: ' + dragRes);
  const altRes = await evalJs(`(function(){
    var chns = Array.prototype.slice.call(document.querySelectorAll('#dash .prow .chn'));
    chns[0].focus();
    chns[0].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', altKey:true, bubbles:true, cancelable:true}));
    return window.__dshTest.state.modes.normal.order.list.join(',');
  })()`);
  assert(altRes.split(',')[1] === 'CBT', 'Alt+↓ 未生效: ' + altRes);
  console.log('✔ 拖动排序 + Alt+↓');
  /* 11.5 导出渠道顺序与网页显示一致（手动拖动后） */
  await evalJs(`(function(){
    var chns = Array.prototype.slice.call(document.querySelectorAll('#dash .prow .chn'));
    var src = chns[2];  /* Gofo */
    var dt = new DataTransfer();
    src.dispatchEvent(new DragEvent('dragstart', {bubbles:true, cancelable:true, dataTransfer:dt}));
    var row0 = chns[0].closest('.prow');
    var rect = row0.getBoundingClientRect();
    row0.dispatchEvent(new DragEvent('dragover', {bubbles:true, cancelable:true, dataTransfer:dt, clientY: rect.top + 2}));
    row0.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt, clientY: rect.top + 2}));
    src.dispatchEvent(new DragEvent('dragend', {bubbles:true, dataTransfer:dt}));
    return 1;
  })()`);
  const expOrder = await evalJs(`(function(){
    var a = window.__dshTest.getAnalysis();
    var m = window.__dshTest.state.modes.normal.sel;
    var data = window.__dshTest.buildExportNow();
    var s = data.sheets.filter(function(x){return x.name==='分组结果';})[0];
    var expRow = s.aoa[0].filter(function(v){return v && String(v).trim();});
    var pageOrder = window.__dshTest.state.modes.normal.order.list.filter(function(id){
      var ch = a.channels.filter(function(c){return c.id===id;})[0];
      return ch && ch.segments.some(function(sg){
        return m.channels.has(id) && m.segs.has(id + '|' + sg.name);
      });
    });
    return JSON.stringify({exp: expRow.join(','), page: pageOrder.join(',')});
  })()`);
  const eo = JSON.parse(expOrder);
  assert(eo.exp === eo.page && eo.page.split(',')[0] === 'Gofo', '导出渠道顺序未跟随网页顺序: ' + JSON.stringify(eo));
  console.log('✔ 导出渠道顺序与网页一致: ' + eo.page);

  /* 12. 参数改动保持滚动与列几何（固定列宽） */
  const scrollStable = await evalJs(`(function(){
    var out = document.getElementById('out');
    out.scrollTop = 200;
    var before = out.scrollTop;
    var th = document.querySelector('#dash thead th').getBoundingClientRect().x;
    var cell = document.querySelector('#dash .prow td:nth-child(3)').getBoundingClientRect().x;
    document.querySelector('#dash .arr-r[data-p="hotLine"][data-ch="SwiftX"]').click();
    return JSON.stringify({
      scrollKept: out.scrollTop === before,
      xKept: document.querySelector('#dash thead th').getBoundingClientRect().x === th && document.querySelector('#dash .prow td:nth-child(3)').getBoundingClientRect().x === cell
    });
  })()`);
  const sc2 = JSON.parse(scrollStable);
  assert(sc2.scrollKept === true && sc2.xKept === true, '参数改动导致滚动或列位置变化');
  console.log('✔ 参数改动后滚动位置与列几何保持不变');

  console.log('\n端到端测试（固定列宽版）全部通过 ✅');
  chrome.kill();
  process.exit(0);
})().catch(e => {
  console.error('✘ 测试失败:', e.message);
  try { chrome.kill(); } catch (err) { }
  process.exit(1);
});
