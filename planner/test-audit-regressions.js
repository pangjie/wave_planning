/* Offline audit regressions. Run: node --test planner/test-audit-regressions.js
 * These assert the intended business behavior and deliberately remain red until
 * the audited defects are fixed. No browser, server, production data, or network.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const XLSX = require('./vendor/xlsx.full.min.js');

const coreSource = fs.readFileSync(path.join(__dirname, 'core.js'), 'utf8');
const appSource = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const HEADERS = [
  'Outbound Order No/出库单号', 'Type of order variety/订单品种类型',
  'Shipping Carrier/物流承运商', 'Package 1 Tracking No./物流跟踪号',
  'SKU 1 SKU', 'Total Qty of SKU/总数量'
];

function response(payload, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function element() {
  return {
    style: {}, dataset: {}, textContent: '', innerHTML: '', value: '', children: [],
    appendChild(child) { this.children.push(child); child.parentNode = this; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this); },
    setAttribute() {},
    classList: { add() {}, remove() {}, toggle() {} }
  };
}

function harness(t) {
  const elements = new Map();
  const timers = new Map();
  const timerDelays = new Map();
  const unexpected = [];
  const requests = [];
  let nextTimer = 0;
  let customFetch;
  const schedule = (fn, delay) => { timers.set(++nextTimer, fn); timerDelays.set(nextTimer, delay); return nextTimer; };
  const unschedule = id => { timers.delete(id); timerDelays.delete(id); };
  const context = vm.createContext({
    console, TextEncoder, Uint8Array, AbortController,
    AbortSignal: { timeout(ms) { const c = new AbortController(); schedule(() => c.abort(), ms); return c.signal; } },
    // Only the in-memory reader and sheet conversion enter the VM. Node file
    // helpers, require, process, and the host's fetch are never exposed to it.
    XLSX: { read: XLSX.read, utils: { sheet_to_json: XLSX.utils.sheet_to_json } },
    FileReader: class {
      readAsArrayBuffer(file) { this.result = file.bytes; this.onload(); }
    },
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    setTimeout: schedule, setInterval: schedule,
    clearTimeout: unschedule, clearInterval: unschedule,
    window: { addEventListener() {}, matchMedia: () => ({ matches: true }), __auditLog: [] },
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, element());
        return elements.get(id);
      },
      querySelectorAll: () => [], createElement: element
    },
    fetch(url, options = {}) {
      const fullUrl = String(url);
      // Existing timing tests route by pathname; retain the exact scoped URL for identity assertions.
      const request = { url: fullUrl.startsWith('/api/wave-records') ? fullUrl.split('?')[0] : fullUrl,
        fullUrl, method: options.method || 'GET', options };
      requests.push(request);
      if (customFetch) {
        const result = customFetch(request);
        if (result !== undefined) return result;
      }
      if (request.url === '/api/wave-records/clear' && request.method === 'POST') {
        return Promise.resolve(response({ status: 'ok' }));
      }
      if (request.url === '/api/exports' && request.method === 'GET') {
        return Promise.resolve(response([]));
      }
      if (request.url.endsWith('/planning-export') && request.method === 'POST') {
        return Promise.resolve(response({ file: 'audit.xlsx', url: '/api/exports/audit.xlsx' }));
      }
      unexpected.push(`${request.method} ${request.url}`);
      return Promise.reject(new Error(`Unstubbed request blocked: ${request.method} ${request.url}`));
    }
  });

  vm.runInContext(coreSource, context, { filename: 'core.js', timeout: 1000 });
  const initMarker = '  (function init() {';
  const closeMarker = '\n})();';
  assert.equal(appSource.split(initMarker).length, 2, 'VM harness must locate one app initializer');
  assert.ok(appSource.endsWith(closeMarker + '\n'), 'VM harness must locate the app closure');
  // Instrument only this in-memory copy. Subject functions and production test
  // hooks stay unchanged; boot-time DOM bindings and visual redraws are stubbed.
  const instrumented = appSource.replace(initMarker, `
  var auditOriginalRenderLog = wmsRenderLog;
  bindEvents = render = function () {};
  refreshSegLine = updateMarksInPlace = wmsRenderLog = wmsRenderState = function () {};
  wmsLogLine = function (text, cls) { window.__auditLog.push({text: text, cls: cls}); };
${initMarker}`).slice(0, -(closeMarker.length + 1)) + `
  window.__auditOnly = {
    setUnified: setUnified,
    toggleMerge: toggleMerge,
    applyWaveNos: wmsApplyWaveNos,
    clearWaveHistory: wmsClearWaveHistory,
    startPolling: wmsStartPolling,
    cancel: wmsCancel,
    setAvailable: wmsSetAvailable,
    autoExport: wmsAutoExport,
    identity: planIdentity, effectiveSegments: wmsEffectiveSegments, exportData: currentExportData,
    renderLog: auditOriginalRenderLog
  };
})();\n`;
  vm.runInContext(instrumented, context, { filename: 'app.js (offline audit VM)', timeout: 1000 });
  t.after(() => {
    timers.clear();
    timerDelays.clear();
    assert.deepEqual(unexpected, [], 'Every request must be explicitly stubbed, even when app code catches it');
  });
  return {
    core: context, api: context.window.__dshTest, audit: context.window.__auditOnly,
    timers, requests, elements, logs: context.window.__auditLog,
    fireTimeout(ms) {
      const ids = [...timerDelays].filter(([, delay]) => delay === ms).map(([id]) => id);
      assert.ok(ids.length, `Expected a scheduled ${ms} ms timeout`);
      for (const id of ids) { const fn = timers.get(id); unschedule(id); fn(); }
    },
    route(handler) { customFetch = handler; },
    importRows(rows, name = 'audit.xlsx') {
      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEADERS, ...rows]), '出库单');
      const bytes = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
      context.window.__dshTest.handleFile({ name, bytes });
      assert.equal(context.window.__dshTest.state.records.length, new Set(rows.map(row => row[0])).size,
        'Synthetic workbook must pass the actual import pipeline');
    }
  };
}

function singleRows(count, prefix = 'ORDER') {
  return Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, '单品单件', 'CBT', '', 'SKU-AUDIT', 1]);
}

test('USPS subdivision: default, toggle, absorption and distinct wave identities with USPS-only export labels', async t => {
  const h = harness(t);
  const pic = stc => { const s = '92'+stc+'0'.repeat(16); let sum=0; for(let i=s.length-1,w=3;i>=0;i--,w=4-w) sum+=Number(s[i])*w; return s+((10-sum%10)%10); };
  h.importRows([['H','单品单件','USPS',pic('184'),'A',1],['G','单品单件','USPS',pic('144'),'B',1]]);
  await drainMicrotasks();
  assert.equal(h.api.state.uspsSplit,true);
  assert.deepEqual(Array.from(h.api.state.records,r=>r.channelId),['USPS-H','USPS-G']);
  let segments = h.audit.effectiveSegments();
  assert.equal(segments.length,2);
  segments.forEach((s,i)=>h.api.state.waveNos.set(s.channel+'|'+s.seg_name,'W'+i));
  const table = h.audit.exportData().sheets.find(s=>s.name==='波次表');
  assert.equal(table.waveRefs.length,2);
  table.waveRefs.forEach((ref,i)=>{
    assert.match(ref.channel,/^USPS-[HG]$/);
    assert.ok(!table.aoa[ref.row][0].includes('-H') && !table.aoa[ref.row][0].includes('-G'));
    assert.equal(table.aoa[ref.row][2],'W'+i);
  });
  h.api.wms.active=true;
  h.api.toggleUspsSubdivision();
  assert.equal(h.api.state.uspsSplit,true);
  h.api.wms.active=false;
  h.api.toggleUspsSubdivision();
  assert.equal(h.api.state.uspsSplit,false);
  assert.ok(h.api.state.records.every(r=>r.channelId==='USPS'));
  h.api.toggleUspsSubdivision();
  // VM render is stubbed; synchronize through the same export path as the UI.
  h.audit.exportData();
  h.api.toggleOrdinaryEvolution();
  h.audit.exportData();
  h.api.state.modes.normal.sel.channels.delete('USPS-H');
  h.api.state.analysis.ordinary=null;
  assert.equal(h.api.curAnalysis().channels.find(c=>c.id==='普通').total,1);
  h.audit.toggleMerge();
  assert.equal(h.api.curAnalysis().channels.find(c=>c.id==='普通').total,2);
});

function analyzeRows(h, rows) {
  const imported = h.core.buildRecords(rows, h.core.mapHeaders(HEADERS));
  return h.core.analyze(imported.records, imported.qtyMap, 'normal', {});
}

function exportedSequence(h, analysis, names) {
  const data = h.core.buildExport(analysis, {
    channelSelected: new Set(['CBT']),
    segSelected: new Set(names.map(name => `CBT|${name}`))
  });
  const sheet = data.sheets.find(item => item.name === '单件SKU序列');
  assert.ok(sheet, 'Export must contain the single-item SKU sequence sheet');
  return Array.from(sheet.aoa.slice(2)).filter(row => row[1] === 'SKU-AUDIT');
}

async function drainMicrotasks() {
  for (let i = 0; i < 6; i++) await Promise.resolve();
}

test('A05: importing a new batch and changing hotLine preserves the other unified parameters', t => {
  const h = harness(t);
  h.importRows(singleRows(25, 'FIRST'));
  for (const [key, value] of Object.entries({ capacity: 800, multiSegs: 3, mixSegs: 2 })) {
    h.audit.setUnified(key, value);
  }
  h.importRows(singleRows(25, 'SECOND'));
  h.audit.setUnified('hotLine', 20);
  assert.equal(h.api.state.modes.normal.unified.capacity, 800);
  const channel = h.api.curAnalysis().channels.find(item => item.id === 'CBT');
  assert.deepEqual(JSON.parse(JSON.stringify(channel.params)),
    { hotLine: 20, capacity: 800, multiSegs: 3, mixSegs: 2, absorb: 1 },
    'Displayed unified values and effective channel values must agree after import');
});

for (const mode of ['normal', 'merged']) {
  for (const changed of ['capacity', 'hotLine', 'multiSegs', 'mixSegs', 'absorb']) {
    test(`A05: ${mode} reimport preserves all other parameters when ${changed} changes`, t => {
      const h = harness(t);
      h.api.state.merged = mode === 'merged';
      h.importRows(singleRows(25, 'FIRST'));
      const initial = { capacity: 800, hotLine: 30, multiSegs: 3, mixSegs: 2, absorb: 2 };
      for (const [key, value] of Object.entries(initial)) h.audit.setUnified(key, value);
      h.importRows(singleRows(25, 'SECOND'));
      const expected = { ...initial, [changed]: changed === 'capacity' ? 900 : initial[changed] + 1 };
      h.audit.setUnified(changed, expected[changed]);
      const channels = h.api.curAnalysis().channels;
      assert.ok(channels.length > 1);
      for (const channel of channels) assert.deepEqual(JSON.parse(JSON.stringify(channel.params)), expected);
      const untouched = h.api.state.modes[mode === 'normal' ? 'merged' : 'normal'].unified;
      assert.equal(untouched.capacity, 400, 'Other mode retains its independent unified settings');
    });
  }
}

test('A15: each 400-order child segment contains 400 occurrences of its single SKU', t => {
  const h = harness(t);
  const channel = analyzeRows(h, singleRows(800)).channels.find(item => item.id === 'CBT');
  assert.deepEqual(Array.from(channel.byType.hot, seg => seg.orderCount), [400, 400]);
  for (const seg of channel.byType.hot) {
    assert.equal(seg.skuPool.length, 1);
    assert.equal(seg.skuPool[0].count, 400, `${seg.name} SKU count must be scoped to its own 400 orders`);
  }
});

for (const name of ['爆品1', '爆品2']) {
  test(`A15: selecting only ${name} exports 400 SKU occurrences`, t => {
    const h = harness(t);
    const rows = exportedSequence(h, analyzeRows(h, singleRows(800)), [name]);
    assert.equal(rows.reduce((sum, row) => sum + row[2], 0), 400,
      'Partial selection must export exactly the selected child segment occurrences');
    assert.ok(rows.every(row => row[4] === 400), 'Sequence rows must refer to the selected segment size');
  });
}

test('A15 control: selecting both child segments retains all 800 SKU occurrences', t => {
  const h = harness(t);
  const rows = exportedSequence(h, analyzeRows(h, singleRows(800)), ['爆品1', '爆品2']);
  assert.equal(rows.reduce((sum, row) => sum + row[2], 0), 800);
});

for (const orderNo of ['ORDER-NORMAL', 'constructor', 'toString', '__proto__']) {
  test(`A26: order number ${orderNo} has a numeric quantity and preserves duplicate-row semantics`, t => {
    const h = harness(t);
    const rows = [
      [orderNo, '多品混合', 'CBT', '', 'SKU-ONE', 3],
      [orderNo, '多品混合', 'CBT', '', 'SKU-TWO', 3]
    ];
    const imported = h.core.buildRecords(rows, h.core.mapHeaders(HEADERS));
    assert.equal(imported.records.length, 1, 'Duplicate order rows must merge into one order');
    assert.equal(imported.qtyMap[orderNo], 3, 'Order quantities must not resolve inherited object properties');
    const channel = h.core.analyze(imported.records, imported.qtyMap, 'normal', {}).channels.find(ch => ch.id === 'CBT');
    assert.equal(channel.segments.reduce((sum, seg) => sum + seg.pickQty, 0), 3,
      'Merged order quantity is taken once, not once per SKU row');
  });
}

test('A04: a late old poll cannot stop a newer job or export the old job twice', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  const oldRequests = [];
  h.route(request => {
    if (request.url === '/api/jobs/old' && request.method === 'GET') {
      const pending = deferred();
      oldRequests.push(pending);
      return pending.promise;
    }
  });
  const oldJob = bindJob(h, { id: 'old', mode: 'generate_waves', status: 'running', events: [] });
  const terminal = { ...oldJob, status: 'succeeded', result: {
    segments: [{ channel: 'CBT', seg_name: '爆品1', wave_no: 'WOLD' }]
  } };
  h.audit.startPolling(oldJob, true);
  const first = h.api.wmsPollOnce();
  const overlapping = h.api.wmsPollOnce();
  assert.ok(oldRequests.length >= 1, 'Polling must request the current task');
  oldRequests[0].resolve(response(terminal));
  await first;
  h.audit.startPolling({ id: 'new', mode: 'pick_waves', status: 'running', events: [] }, true);
  const newTimer = h.api.wms.timer;
  // A fixed implementation may coalesce the overlapping call into the first.
  for (const pending of oldRequests.slice(1)) pending.resolve(response(terminal));
  await overlapping;
  await drainMicrotasks();
  assert.deepEqual({
    id: h.api.wms.jobId,
    active: h.api.wms.active,
    job: h.api.wms.job.id,
    newTimerScheduled: h.timers.has(newTimer),
    exportUploads: h.requests.filter(r => r.method === 'POST' && r.url.endsWith('/planning-export')).length
  }, { id: 'new', active: true, job: 'new', newTimerScheduled: true, exportUploads: 1 },
  'Late responses must preserve the newer task and its timer; the old terminal task exports only once');
});

function runningJob(id, mode = 'pick_waves') {
  return { id, mode, status: 'running', events: [] };
}

function generatedJob(id) {
  return { ...runningJob(id, 'generate_waves'), status: 'succeeded', result: {
    segments: [{ channel: 'CBT', seg_name: '爆品1', wave_no: 'W-' + id }]
  } };
}

function bindJob(h, job) {
  Object.assign(job, JSON.parse(JSON.stringify(h.audit.identity())), {
    has_plan_snapshot: true, segments: JSON.parse(JSON.stringify(h.audit.effectiveSegments()))
  });
  h.api.wms.planSnapshots.set(job.id, {
    batch_id: job.batch_id, plan_id: job.plan_id,
    snapshot: JSON.parse(JSON.stringify({ version: 1, workbook: h.audit.exportData() }))
  });
  return job;
}

function historyRecord(h, waveNo) {
  return { ...JSON.parse(JSON.stringify(h.audit.identity())),
    ...JSON.parse(JSON.stringify(h.audit.effectiveSegments()[0])), wave_no: waveNo };
}

for (const late of ['success', '404', 'network-error']) {
  test(`A04: late old ${late} after a new task starts is ignored`, async t => {
    const h = harness(t), stale = deferred();
    h.route(r => r.url === '/api/jobs/old' ? stale.promise : undefined);
    h.audit.startPolling(runningJob('old'), true);
    const reading = h.api.wmsPollOnce();
    await h.api.wmsPollOnce();
    assert.equal(h.requests.filter(r => r.url === '/api/jobs/old').length, 1, 'No overlapping GET');
    h.audit.startPolling(runningJob('new'), true);
    const timer = h.api.wms.timer;
    if (late === 'network-error') stale.reject(new Error('old connection failed'));
    else stale.resolve(response({ ...runningJob('old'), status: 'succeeded' }, late === '404' ? 404 : 200));
    await reading;
    assert.equal(h.api.wms.jobId, 'new');
    assert.equal(h.api.wms.job.id, 'new');
    assert.equal(h.api.wms.active, true);
    assert.equal(h.api.wms.errStreak, 0);
    assert.ok(h.timers.has(timer));
  });
}

test('A04: late JSON body cannot replace a newer task', async t => {
  const h = harness(t), body = deferred();
  h.route(r => r.url === '/api/jobs/old' ? Promise.resolve({ ok: true, status: 200, json: () => body.promise }) : undefined);
  h.audit.startPolling(runningJob('old'), true);
  const reading = h.api.wmsPollOnce();
  await drainMicrotasks();
  h.audit.startPolling(runningJob('new'), true);
  body.resolve(generatedJob('old'));
  await reading;
  assert.equal(h.api.wms.job.id, 'new');
  assert.equal(h.api.wms.terminalJobs.has('old'), false);
  assert.equal(h.requests.filter(r => r.method === 'POST').length, 0);
});

test('A04: cancellation invalidates in-flight reads before its response arrives', async t => {
  const h = harness(t), reading = deferred(), cancelling = deferred();
  h.route(r => r.url === '/api/jobs/old' ? reading.promise :
    r.url === '/api/jobs/old/cancel' ? cancelling.promise : undefined);
  h.audit.startPolling(runningJob('old'), true);
  const poll = h.api.wmsPollOnce();
  const cancel = h.audit.cancel();
  reading.resolve(response(generatedJob('old')));
  await poll;
  assert.equal(h.api.wms.job.status, 'running');
  assert.equal(h.api.wms.terminalJobs.has('old'), false);
  cancelling.resolve(response({ ...runningJob('old'), status: 'cancelled' }));
  await cancel;
  assert.equal(h.api.wms.job.status, 'cancelled');
  assert.equal(h.api.wms.active, false);
  assert.equal(h.api.wms.timer, null);
});

test('A04: late cancellation cannot stop a newer task; failed cancellation resumes reads', async t => {
  const h = harness(t), cancelling = deferred();
  h.route(r => r.url === '/api/jobs/old/cancel' ? cancelling.promise :
    r.url === '/api/jobs/new/cancel' ? Promise.resolve(response({}, 500)) : undefined);
  h.audit.startPolling(runningJob('old'), true);
  const pending = h.audit.cancel();
  h.audit.startPolling(runningJob('new'), true);
  cancelling.resolve(response({ ...runningJob('old'), status: 'cancelled' }));
  await pending;
  assert.equal(h.api.wms.jobId, 'new');
  await h.audit.cancel();
  assert.equal(h.api.wms.jobId, 'new');
  assert.equal(h.api.wms.cancelling, false);
  assert.ok(h.timers.has(h.api.wms.timer));
  assert.ok(h.logs.some(line => line.text.includes('取消请求未确认')));
});

for (const terminalStatus of ['succeeded', 'partial', 'cancelled', 'failed']) {
  test(`B8: cancel response ${terminalStatus} respects the same completion policy as polling`, async t => {
    const h = harness(t);
    h.importRows(singleRows(25));
    await drainMicrotasks();
    const finished = bindJob(h, { ...generatedJob('cancel-race'), status: terminalStatus });
    const uploaded = [];
    h.route(r => {
      if (r.url === '/api/jobs/cancel-race/cancel') return Promise.resolve(response(finished));
      if (r.url === '/api/jobs') return Promise.resolve(response([finished]));
      if (r.url.endsWith('/planning-export')) {
        uploaded.push(Buffer.from(r.options.body));
        return Promise.resolve(response({ file: 'race.xlsx' }));
      }
    });
    h.audit.startPolling({ ...finished, status: 'running', result: null }, true);
    await h.audit.cancel();
    assert.equal(uploaded.length, 1, 'Every ended generation task must export its submitted plan');
    assert.equal(h.api.wms.job.status, terminalStatus);
    assert.equal(h.api.wms.active, false);
    assert.equal(h.api.wms.jobId, null);
    assert.equal(h.api.state.waveNos.get('CBT|爆品1'), 'W-cancel-race', 'Confirmed results remain visible regardless of terminal status');
    const workbook = XLSX.read(uploaded[0], { type: 'buffer' });
    assert.equal(workbook.Sheets['波次表']['C2'].v, 'W-cancel-race');
    assert.equal(workbook.Sheets['波次表']['G2'].v, 25);
    assert.equal(workbook.SheetNames.length, 9);
    await h.api.wmsRestore();
    assert.equal(uploaded.length, 1, 'Later restore must not duplicate the export');
  });
}

test('B8: stale completed cancellation response cannot affect a newer task', async t => {
  const h = harness(t), cancelling = deferred();
  h.importRows(singleRows(25));
  await drainMicrotasks();
  const finished = bindJob(h, generatedJob('old-cancel'));
  h.route(r => r.url === '/api/jobs/old-cancel/cancel' ? cancelling.promise : undefined);
  h.audit.startPolling({ ...finished, status: 'running', result: null }, true);
  const pending = h.audit.cancel();
  h.audit.startPolling(runningJob('new-task'), true);
  const timer = h.api.wms.timer;
  cancelling.resolve(response(finished));
  await pending;
  assert.equal(h.api.wms.jobId, 'new-task');
  assert.equal(h.api.wms.active, true);
  assert.ok(h.timers.has(timer));
  assert.equal(h.api.state.waveNos.size, 0);
  assert.equal(h.requests.filter(r => r.url.endsWith('/planning-export')).length, 0);
});

test('A04: read timeout releases the in-flight slot, HTTP errors count and stop at the existing limit', async t => {
  const h = harness(t);
  let stall = true;
  h.route(r => {
    if (r.url !== '/api/jobs/one') return;
    if (!stall) return Promise.resolve(response({}, 500));
    return new Promise((resolve, reject) => r.options.signal.addEventListener('abort', () => reject(new Error('read timeout')), { once: true }));
  });
  h.audit.startPolling(runningJob('one'), true);
  const pending = h.api.wmsPollOnce();
  h.fireTimeout(10000);
  await pending;
  assert.equal(h.api.wms.pollRequest, null);
  assert.equal(h.api.wms.errStreak, 1);
  stall = false;
  for (let i = 0; i < 29; i++) await h.api.wmsPollOnce();
  assert.equal(h.api.wms.errStreak, 30);
  assert.equal(h.api.wms.jobId, null);
  assert.equal(h.api.wms.active, false);
  assert.ok(h.logs.some(line => line.text.includes('30 次失败')));
});

test('A04: mismatched task responses do not overwrite the tracked task', async t => {
  const h = harness(t);
  h.route(r => r.url === '/api/jobs/one' ? Promise.resolve(response(generatedJob('other'))) : undefined);
  h.audit.startPolling(runningJob('one'), true);
  await h.api.wmsPollOnce();
  assert.equal(h.api.wms.job.id, 'one');
  assert.equal(h.api.wms.errStreak, 1);
  assert.equal(h.api.wms.terminalJobs.size, 0);
});

test('A04: disconnect invalidates reads and a late restore cannot revive an old task', async t => {
  const h = harness(t), reading = deferred(), restoring = deferred();
  h.route(r => r.url === '/api/jobs/old' ? reading.promise : r.url === '/api/jobs' ? restoring.promise : undefined);
  h.api.wms.available = true;
  h.audit.startPolling(runningJob('old'), true);
  const pending = h.api.wmsPollOnce();
  h.audit.setAvailable(false);
  reading.resolve(response(generatedJob('old')));
  await pending;
  assert.equal(h.api.wms.jobId, null);
  assert.equal(h.api.wms.active, false);
  const restore = h.api.wmsRestore();
  h.audit.startPolling(runningJob('new'), true);
  restoring.resolve(response([runningJob('old')]));
  await restore;
  assert.equal(h.api.wms.jobId, 'new');
});

test('A04: repeated completion consumes one export and upload retries reuse the original bytes', async t => {
  const h = harness(t), uploads = [];
  h.importRows(singleRows(25));
  const completed = bindJob(h, generatedJob('generated'));
  let fail = true;
  h.route(r => {
    if (r.url === '/api/jobs/generated') return Promise.resolve(response(completed));
    if (r.url.endsWith('/planning-export')) { uploads.push(Buffer.from(r.options.body)); return Promise.resolve(response({}, fail ? 500 : 200)); }
  });
  h.audit.startPolling(runningJob('generated', 'generate_waves'), true);
  await h.api.wmsPollOnce();
  const entry = h.api.wms.exportJobs.get('generated');
  assert.equal(entry.done, false);
  assert.ok(entry.retryLink && entry.bytes);
  assert.ok(h.logs.some(line => line.text.includes('无需重新生成波次')));
  h.audit.startPolling(runningJob('generated', 'generate_waves'), true);
  await h.api.wmsPollOnce();
  assert.equal(uploads.length, 1, 'Repeated terminal response must not automatically upload again');
  h.importRows(singleRows(40, 'DIFFERENT'));
  fail = false;
  entry.retryLink.onclick({ preventDefault() {} });
  await h.audit.autoExport(completed);
  assert.equal(uploads.length, 2);
  assert.deepEqual(uploads[1], uploads[0], 'Retry must not export the modified plan');
  assert.equal(entry.done, true);
  assert.equal(entry.bytes, null, 'Successful save releases the cached file');
  assert.equal(entry.retryLink, null);
  await h.audit.autoExport(completed);
  assert.equal(uploads.length, 2);
  assert.equal(h.requests.filter(r => r.url === '/api/jobs' && r.method === 'POST').length, 0);
});

test('A04: failure to build a file does not later export another plan as the old job', async t => {
  const h = harness(t), job = generatedJob('no-file');
  assert.equal(await h.audit.autoExport(job), false);
  assert.ok(h.logs.some(line => line.text.includes('没有可靠的提交计划快照')));
  assert.equal(h.api.wms.exportJobs.get(job.id).retryLink, null);
  h.importRows(singleRows(25));
  assert.equal(await h.audit.autoExport(job), false);
  assert.equal(h.requests.filter(r => r.url.startsWith('/api/exports?')).length, 0);
});

test('A04: an old downloaded order file cannot import after a new task starts', async t => {
  const h = harness(t), download = deferred();
  h.importRows(singleRows(25, 'KEEP'));
  h.route(r => r.url === '/api/jobs/exporting' ? Promise.resolve(response({ ...runningJob('exporting', 'export'), status: 'succeeded' })) :
    r.url === '/api/jobs/exporting/file' ? Promise.resolve({ ok: true, arrayBuffer: () => download.promise }) : undefined);
  h.audit.startPolling(runningJob('exporting', 'export'), true);
  const pending = h.api.wmsPollOnce();
  await drainMicrotasks();
  assert.ok(h.requests.some(r => r.url.endsWith('/exporting/file')));
  h.audit.startPolling(runningJob('new'), true);
  download.resolve(new ArrayBuffer(0));
  await pending;
  assert.equal(h.api.wms.jobId, 'new');
  assert.equal(h.api.state.records.length, 25);
  assert.equal(h.api.state.records[0].orderNo, 'KEEP1');
});

test('A04: a timed-out submission releases the submit guard without repeating the POST', async t => {
  const h = harness(t);
  h.route(r => r.url === '/api/jobs' ? new Promise((resolve, reject) =>
    r.options.signal.addEventListener('abort', () => reject(new Error('submit timeout')), { once: true })) : undefined);
  const pending = h.api.wmsSubmit('export');
  await h.api.wmsSubmit('export');
  assert.equal(h.requests.length, 1);
  h.fireTimeout(10000);
  await pending;
  assert.equal(h.api.wms.submitting, false);
  assert.match(h.elements.get('status').textContent, /不要重复提交/);
  assert.equal(h.requests.length, 1);
});

test('A16: a history GET sent before successful clear cannot restore a cleared wave', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  h.api.wms.available = true;
  const stale = deferred();
  const oldRecord = historyRecord(h, 'WSTALE');
  h.route(request => request.url === '/api/wave-records' && request.method === 'GET'
    ? stale.promise : undefined);
  const reading = h.api.wmsSyncWaveRecords();
  await h.audit.clearWaveHistory();
  await drainMicrotasks();
  assert.equal(h.api.wms.clearPending, false, 'The mocked clear response must finish before the old GET');
  stale.resolve(response([oldRecord]));
  await reading;
  assert.equal(h.api.state.waveNos.has('CBT|爆品1'), false,
    'History responses from a cleared generation must be discarded');
});

test('A16: a late history JSON body is discarded after clearing', async t => {
  const h = harness(t), body = deferred();
  h.importRows(singleRows(25));
  await drainMicrotasks();
  h.api.wms.available = true;
  const oldRecord = historyRecord(h, 'WOLD');
  h.route(r => r.url === '/api/wave-records' ? Promise.resolve({ ok: true, json: () => body.promise }) : undefined);
  const reading = h.api.wmsSyncWaveRecords();
  await drainMicrotasks();
  await h.audit.clearWaveHistory();
  body.resolve([oldRecord]);
  await reading;
  assert.equal(h.api.state.waveNos.size, 0);
});

test('A16: clears are serialized and old success cannot unlock a newer failed clear', async t => {
  const h = harness(t), first = deferred(), second = deferred();
  let count = 0;
  h.route(r => r.url === '/api/wave-records/clear' ? (++count === 1 ? first.promise : second.promise) : undefined);
  const clearing1 = h.audit.clearWaveHistory();
  await drainMicrotasks();
  const clearing2 = h.audit.clearWaveHistory();
  await drainMicrotasks();
  assert.equal(count, 1);
  first.resolve(response({ status: 'ok' }));
  assert.equal(await clearing1, false);
  await drainMicrotasks();
  assert.equal(count, 2);
  assert.equal(h.api.wms.clearPending, true);
  second.resolve(response({}, 503));
  assert.equal(await clearing2, false);
  assert.equal(h.api.wms.clearPending, true);
  assert.ok(h.logs.some(line => line.text.includes('历史清理未确认')));
});

test('A16: an old failed clear cannot poison a newer successful clear', async t => {
  const h = harness(t), first = deferred();
  let count = 0;
  h.route(r => r.url === '/api/wave-records/clear' ? (++count === 1 ? first.promise : Promise.resolve(response({ status: 'ok' }))) : undefined);
  const old = h.audit.clearWaveHistory();
  await drainMicrotasks();
  const current = h.audit.clearWaveHistory();
  first.reject(new Error('old failure'));
  assert.equal(await old, false);
  assert.equal(await current, true);
  assert.equal(h.api.wms.clearPending, false);
  assert.equal(h.api.wms.historyRetryLink, null);
  assert.equal(h.logs.length, 0);
});

test('A16: failed clear blocks history reads and new generation until explicit retry succeeds', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  h.api.wms.available = true;
  let fail = true;
  h.route(r => r.url === '/api/wave-records/clear' ? Promise.resolve(response({}, fail ? 503 : 200)) : undefined);
  await h.audit.clearWaveHistory();
  const before = h.requests.length;
  await h.api.wmsSyncWaveRecords();
  await h.api.wmsSubmit('generate_waves');
  assert.equal(h.requests.length, before);
  assert.match(h.elements.get('status').textContent, /历史清理尚未确认/);
  const oldRetry = h.api.wms.historyRetryLink;
  fail = false;
  oldRetry.onclick({ preventDefault() {} });
  assert.equal(await h.api.wms.clearQueue, true);
  assert.equal(h.api.wms.clearPending, false);
  assert.equal(h.api.wms.historyRetryLink, null);
  const after = h.requests.length;
  oldRetry.onclick({ preventDefault() {} });
  await drainMicrotasks();
  assert.equal(h.requests.length, after, 'Detached old retry must not clear a newer plan');
});

test('A16: only one history read is in flight; timeout releases the slot', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  h.api.wms.available = true;
  let stalled = true, calls = 0;
  h.route(r => {
    if (r.url !== '/api/wave-records') return;
    calls++;
    if (!stalled) return Promise.resolve(response([historyRecord(h, 'WCURRENT')]));
    return new Promise((resolve, reject) => r.options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
  });
  const pending = h.api.wmsSyncWaveRecords();
  await h.api.wmsSyncWaveRecords();
  assert.equal(calls, 1);
  h.fireTimeout(10000);
  await pending;
  assert.equal(h.api.wms.historyRequest, null);
  stalled = false;
  await h.api.wmsSyncWaveRecords();
  assert.equal(calls, 2);
  assert.equal(h.api.state.waveNos.get('CBT|爆品1'), 'WCURRENT');
});

for (const change of ['reimport', 'failed-import', 'mode-roundtrip', 'job-start']) {
  test(`A16: ${change} invalidates an outstanding history response`, async t => {
    const h = harness(t), stale = deferred();
    h.importRows(singleRows(25));
    await drainMicrotasks();
    h.api.wms.available = true;
    const oldRecord = historyRecord(h, 'WOLD');
    h.route(r => r.url === '/api/wave-records' ? stale.promise : undefined);
    const reading = h.api.wmsSyncWaveRecords();
    if (change === 'reimport') h.importRows(singleRows(25, 'NEW'));
    if (change === 'failed-import') h.api.handleFile({ name: 'invalid.xlsx', bytes: new Uint8Array([0]) });
    if (change === 'mode-roundtrip') { h.audit.toggleMerge(); h.audit.toggleMerge(); }
    if (change === 'job-start') {
      h.audit.startPolling(runningJob('new'), true);
      h.api.wms.active = false; // Even a completed task must not revive pre-task reads.
      h.api.state.waveNos.set('CBT|爆品1', 'WNEW');
    }
    stale.resolve(response([oldRecord]));
    await reading;
    assert.notEqual(h.api.state.waveNos.get('CBT|爆品1'), 'WOLD');
    if (change === 'job-start') assert.equal(h.api.state.waveNos.get('CBT|爆品1'), 'WNEW');
  });
}

test('A16: disconnect discards reads but cannot orphan the active clear', async t => {
  const h = harness(t), clearing = deferred();
  h.api.wms.available = true;
  h.route(r => r.url === '/api/wave-records/clear' ? clearing.promise : undefined);
  const pending = h.audit.clearWaveHistory();
  await drainMicrotasks();
  h.audit.setAvailable(false);
  clearing.resolve(response({ status: 'ok' }));
  assert.equal(await pending, true);
  assert.equal(h.api.wms.clearPending, false);
});

test('A16: clear timeout is visible and does not accept a history read as confirmation', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  h.api.wms.available = true;
  h.route(r => r.url === '/api/wave-records/clear' ? new Promise((resolve, reject) =>
    r.options.signal.addEventListener('abort', () => reject(new Error('clear timeout')), { once: true })) : undefined);
  const pending = h.audit.clearWaveHistory();
  await drainMicrotasks();
  h.fireTimeout(10000);
  assert.equal(await pending, false);
  const count = h.requests.length;
  await h.api.wmsSyncWaveRecords();
  assert.equal(h.requests.length, count);
  assert.equal(h.api.wms.clearPending, true);
  assert.ok(h.logs.some(line => line.text.includes('clear timeout')));
});

test('A03: generation completion must export the submitted plan, not later capacity changes', async t => {
  const h = harness(t);
  h.importRows(singleRows(800).map((row, index) => {
    row[4] = 'SKU-' + Math.floor(index / 200);
    return row;
  }));
  await drainMicrotasks();
  let submitted, exported;
  h.route(r => {
    if (r.url === '/api/jobs' && r.method === 'POST') {
      submitted = JSON.parse(r.options.body);
      return Promise.resolve(response({ ...runningJob('snapshot-job', 'generate_waves'),
        ...submitted, plan_snapshot: undefined, has_plan_snapshot: true }));
    }
    if (r.url.endsWith('/planning-export')) {
      exported = Buffer.from(r.options.body);
      return Promise.resolve(response({ file: 'snapshot.xlsx', url: '/api/exports/snapshot.xlsx' }));
    }
  });
  await h.api.wmsSubmit('generate_waves');
  assert.deepEqual(submitted.segments.map(s => s.order_nos.length), [400, 400]);
  h.audit.setUnified('capacity', 200);
  assert.equal(h.api.curAnalysis().channels.find(c => c.id === 'CBT').segments.length, 4);
  await h.audit.applyWaveNos({
    id: 'snapshot-job', mode: 'generate_waves', status: 'succeeded',
    batch_id: submitted.batch_id, plan_id: submitted.plan_id, has_plan_snapshot: true,
    segments: submitted.segments,
    result: { segments: submitted.segments.map((s, index) => ({
      channel: s.channel, seg_name: s.seg_name, order_count: s.order_nos.length,
      wave_no: 'W' + (index + 1),
    })) },
  });
  assert.ok(exported, 'Completed generation should produce its original plan export');
  const workbook = XLSX.read(exported, { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['波次表'], { header: 1 });
  assert.deepEqual(rows.filter(row => /^W\d+$/.test(row[2])).map(row => [row[2], row[6]]),
    [['W1', 400], ['W2', 400]], 'Wave/order totals must remain bound to the submitted 400 + 400 order plan');
  assert.equal(h.api.state.waveNos.size, 0, 'Original waves must not mark the later 200-order segments');
  assert.equal(workbook.SheetNames.length, 9);
  for (const sheet of submitted.plan_snapshot.workbook.sheets) {
    if (sheet.name === '波次表') continue;
    const expected = XLSX.utils.sheet_to_json(XLSX.utils.aoa_to_sheet(sheet.aoa), { header: 1 });
    assert.deepEqual(XLSX.utils.sheet_to_json(workbook.Sheets[sheet.name], { header: 1 }), expected,
      sheet.name + ' must also come from the submitted snapshot');
  }
});

for (const change of ['batch', 'mode', 'selection', 'order', 'evolution']) {
  test(`A03: ${change} changes prevent old task completion from marking the new plan`, async t => {
    const h = harness(t);
    h.importRows(singleRows(25));
    await drainMicrotasks();
    const job = bindJob(h, generatedJob('bound'));
    const original = h.api.wms.planSnapshots.get(job.id);
    if (change === 'batch') h.importRows(singleRows(25)); // same file, distinct import
    if (change === 'mode') h.audit.toggleMerge();
    if (change === 'selection') h.api.state.modes.normal.sel.segs.delete('CBT|爆品1');
    if (change === 'order') h.api.state.modes.normal.order.sortMode = 'desc';
    if (change === 'evolution') h.api.state.ordinaryEvolved = true;
    await h.audit.applyWaveNos(job);
    assert.notEqual(h.audit.identity().plan_id, job.plan_id);
    assert.equal(h.api.state.waveNos.size, 0);
    assert.equal(h.api.wms.exportJobs.get(job.id).done, true);
    assert.equal(original.snapshot.workbook.sheets.find(s => s.name === '波次表').aoa[1][2], '', 'Snapshot itself stays immutable');
  });
}

for (const mismatch of ['legacy', 'batch', 'plan', 'orders', 'duplicate-orders', 'none']) {
  test(`A16: history ${mismatch} identity/order verification`, async t => {
    const h = harness(t);
    h.importRows(singleRows(25));
    await drainMicrotasks();
    const record = historyRecord(h, 'WVALID');
    if (mismatch === 'legacy') { delete record.batch_id; delete record.plan_id; }
    if (mismatch === 'batch') record.batch_id = 'other';
    if (mismatch === 'plan') record.plan_id = 'other';
    if (mismatch === 'orders') record.order_nos[0] = 'OTHER';
    if (mismatch === 'duplicate-orders') record.order_nos[0] = record.order_nos[1];
    if (mismatch === 'none') record.order_nos.reverse(); // equality is set-based
    h.api.wms.available = true;
    h.route(r => r.url === '/api/wave-records' ? Promise.resolve(response([record])) : undefined);
    await h.api.wmsSyncWaveRecords();
    assert.equal(h.api.state.waveNos.size, mismatch === 'none' ? 1 : 0);
    const query = new URL(h.requests.findLast(r => r.url === '/api/wave-records').fullUrl, 'http://test.invalid');
    assert.equal(query.searchParams.get('batch_id'), h.api.state.batchId);
    assert.equal(query.searchParams.get('plan_id'), h.api.state.planId);
  });
}

for (const status of ['succeeded', 'partial', 'cancelled', 'failed']) {
for (const completed of [false, true]) {
test(`Stopped plan: restore ${status}, confirmed=${completed}, without a current import`, async t => {
  const source = harness(t);
  source.importRows(singleRows(25));
  const job = bindJob(source, generatedJob('restored'));
  job.status = status;
  if (!completed) job.result = null;
  const saved = source.api.wms.planSnapshots.get(job.id);
  const restored = harness(t);
  let uploads = 0;
  restored.route(r => {
    if (r.url === '/api/jobs') return Promise.resolve(response([job]));
    if (r.url === '/api/jobs/restored/plan') return Promise.resolve(response(saved));
    if (r.url.endsWith('/planning-export')) { uploads++; return Promise.resolve(response({ file: 'one.xlsx' })); }
  });
  await restored.api.wmsRestore();
  assert.equal(uploads, 1);
  assert.equal(restored.api.state.records.length, 0);
  assert.equal(restored.api.state.waveNos.size, 0);
  await restored.api.wmsRestore();
  assert.equal(uploads, 1);
});
}
}

for (const stopStatus of ['cancelled', 'failed']) {
for (const completed of [false, true]) {
test(`Stopped plan: ${stopStatus}, confirmed=${completed}, exports all original sheets and retries identical bytes`, async t => {
  const h = harness(t);
  h.importRows(singleRows(800).map((row, i) => { row[4] = 'SKU-' + Math.floor(i / 100); return row; }));
  await drainMicrotasks();
  const job = bindJob(h, generatedJob('stopped'));
  job.status = stopStatus;
  const first = job.segments[0];
  job.result = completed ? { segments: [{channel:first.channel, seg_name:first.seg_name, wave_no:'WCONFIRMED'}] } : null;
  const saved = h.api.wms.planSnapshots.get(job.id);
  const table = saved.snapshot.workbook.sheets.find(s => s.name === '波次表');
  table.waveRefs.forEach(r => { table.aoa[r.row][2] = 'OLD-WAVE'; });
  const uploads = [];
  let fail = true;
  h.route(r => {
    if (r.url === '/api/jobs/stopped') return Promise.resolve(response(job));
    if (r.url.endsWith('/planning-export')) {
      uploads.push(Buffer.from(r.options.body));
      return Promise.resolve(response({}, fail ? 503 : 200));
    }
  });
  h.audit.startPolling({...job, status:'running', result:null}, true);
  h.importRows(singleRows(40, 'NEW-ORDER'));
  await h.api.wmsPollOnce();
  assert.equal(uploads.length, 1);
  assert.equal(h.api.state.waveNos.size, 0, 'Old stopped plan must not mark new orders');
  assert.ok(h.logs.some(l => l.text.includes('计划 ' + job.segments.length)));
  if (!completed) assert.ok(h.logs.some(l => l.text.includes('未确认生成任何波次')));
  const wb = XLSX.read(Buffer.from(uploads[0]), {type:'buffer'});
  assert.equal(wb.SheetNames.length, 9);
  for (const sheet of saved.snapshot.workbook.sheets) {
    const expected = JSON.parse(JSON.stringify(sheet.aoa));
    if (sheet.name === '波次表') {
      sheet.waveRefs.forEach(r => { expected[r.row][2] = completed && r.channel === first.channel && r.seg_name === first.seg_name ? 'WCONFIRMED' : ''; });
    }
    assert.deepEqual(XLSX.utils.sheet_to_json(wb.Sheets[sheet.name], {header:1}),
      XLSX.utils.sheet_to_json(XLSX.utils.aoa_to_sheet(expected), {header:1}), sheet.name);
  }
  assert.equal(table.aoa[table.waveRefs[0].row][2], 'OLD-WAVE', 'Snapshot itself is immutable');
  fail = false;
  await h.audit.autoExport(job);
  assert.deepEqual(uploads[1], uploads[0]);
  await h.audit.autoExport(job);
  assert.equal(uploads.length, 2);
  assert.equal(h.requests.filter(r => r.url === '/api/jobs' && r.method === 'POST').length, 0);
});
}
}

test('A03: a snapshot read failure retries the original job, never the current plan', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  const job = bindJob(h, generatedJob('retry-plan'));
  const saved = h.api.wms.planSnapshots.get(job.id);
  h.api.wms.planSnapshots.clear();
  let fail = true, bytes;
  h.route(r => {
    if (r.url.endsWith('/plan')) return Promise.resolve(response(saved, fail ? 503 : 200));
    if (r.url.endsWith('/planning-export')) { bytes = Buffer.from(r.options.body); return Promise.resolve(response({})); }
  });
  assert.equal(await h.audit.autoExport(job), false);
  h.importRows(singleRows(40, 'NEW'));
  fail = false;
  assert.equal(await h.audit.autoExport(job), true);
  const wb = XLSX.read(bytes, { type: 'buffer' });
  assert.equal(wb.Sheets['波次表']['G2'].v, 25);
});

test('A03: live wave events only mark the exact submitted plan and order set', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  const job = bindJob(h, runningJob('live', 'generate_waves'));
  job.events = [{ stage: 'segment_wave', message: JSON.stringify({ channel: 'CBT', seg_name: '爆品1', wave_no: 'WLIVE' }) }];
  h.audit.renderLog(job);
  assert.equal(h.api.state.waveNos.get('CBT|爆品1'), 'WLIVE');
  h.importRows(singleRows(25, 'REPLACEMENT'));
  h.api.wms.events = 0;
  h.audit.renderLog(job);
  assert.equal(h.api.state.waveNos.size, 0);
  assert.ok(h.elements.get('wmsLog').children.some(line => line.textContent.includes('WLIVE')), 'Old event remains visible in logs');
});

test('A16: retry clear retains original scope after the visible plan changes', async t => {
  const h = harness(t);
  h.importRows(singleRows(25));
  await drainMicrotasks();
  let fail = true;
  h.route(r => r.url === '/api/wave-records/clear' ? Promise.resolve(response({}, fail ? 503 : 200)) : undefined);
  await h.audit.clearWaveHistory();
  const originalUrl = h.requests.at(-1).fullUrl;
  const retry = h.api.wms.historyRetryLink;
  h.api.state.modes.normal.sel.segs.delete('CBT|爆品1');
  const changedIdentity = h.audit.identity();
  fail = false;
  retry.onclick({ preventDefault() {} });
  await h.api.wms.clearQueue;
  assert.equal(h.requests.at(-1).fullUrl, originalUrl);
  assert.notEqual(new URL(originalUrl, 'http://test.invalid').searchParams.get('plan_id'), changedIdentity.plan_id);
});
