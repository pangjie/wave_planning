/* 测试基建自己的安全回归；不启动 Chrome，不访问外网或任何已有本地服务。 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const T = require('./test-helpers');
const { createMockServer } = require('./mock-wms-server');

test('拒绝已有 profile、指定调试端口和额外 Chrome 参数，不删除传入目录', async () => {
  const dir = T.tempDir('sentinel');
  try {
    fs.writeFileSync(path.join(dir, 'keep'), 'untouched');
    await assert.rejects(T.launchChrome({ userDataDir: dir }), /不接受已有 profile/);
    await assert.rejects(T.launchChrome({ port: 8000 }), /不接受已有 profile/);
    await assert.rejects(T.launchChrome({ extraArgs: ['https://invalid.example'] }), /不接受已有 profile/);
    assert.equal(fs.readFileSync(path.join(dir, 'keep'), 'utf8'), 'untouched');
    assert.throws(() => T.rmDir(path.resolve(__dirname, '..')), /拒绝删除非本测试/);
    await assert.rejects(T.connectCdp({ port: 8000 }), /只能连接本测试/);
  } finally { T.rmDir(dir); }
});

test('临时路径和清理拒绝目录穿越及指向外部的符号链接', () => {
  const P = T.paths(__dirname);
  const root = P.tmp();
  try {
    assert.throws(() => P.tmp('..', 'outside'), /越界/);
    fs.symlinkSync(__dirname, P.tmp('link'));
    assert.throws(() => T.rmDir(P.tmp('link', 'vendor')), /符号链接/);
  } finally { T.rmDir(root); }
});

test('assert 抛错而不是退出进程，调用者 finally 仍执行', () => {
  let cleaned = false;
  assert.throws(() => {
    try { T.assert(false, '故意失败'); }
    finally { cleaned = true; }
  }, /故意失败/);
  assert.equal(cleaned, true);
});

test('withChrome 失败时等待异步清理，关闭自己启动的进程并删除临时 profile', () => {
  // 使用 Node 代替 Chrome：它会拒绝 Chrome 参数，不会启动任何浏览器。
  const script = `const T=require(${JSON.stringify(path.join(__dirname, 'test-helpers.js'))});
    T.withChrome({chromePath:process.execPath}, async child => {
      console.log(child.spawnargs.find(x=>x.startsWith('--user-data-dir=')));
      T.assert(false, 'deliberate lifecycle failure');
    }, async () => { await T.sleep(60); console.log('ASYNC_CLEANUP_FINISHED'); });`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 8000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /ASYNC_CLEANUP_FINISHED/);
  assert.match(result.stderr, /deliberate lifecycle failure/);
  const profile = result.stdout.match(/--user-data-dir=(.+)/)[1];
  assert.equal(fs.existsSync(profile), false, '失败测试不能留下 profile');
});

test('CDP 无响应命令超时；关闭连接立即拒绝在途命令', async () => {
  const ws = { send() {} };
  const drv = T.createDriver(ws, { commandTimeout: 20 });
  await assert.rejects(drv.send('No.response'), /命令超时/);
  const pending = drv.send('Pending');
  ws.onclose();
  await assert.rejects(pending, /连接已关闭/);
});

test('被拒绝的浏览器代理隧道重置连接时不崩溃，仍可清理测试进程', async () => {
  const http = require('http');
  const { EventEmitter } = require('events');
  const original = http.createServer;
  let proxy, child;
  http.createServer = function (...args) { proxy = original.apply(this, args); return proxy; };
  try {
    child = await T.launchChrome({ chromePath: process.execPath });
    const socket = new EventEmitter();
    socket.end = () => {};
    socket.destroy = () => { socket.destroyed = true; };
    proxy.emit('connect', {}, socket);
    assert.doesNotThrow(() => socket.emit('error', new Error('read ECONNRESET')));
    assert.equal(socket.destroyed, true);
  } finally {
    http.createServer = original;
    if (child) await T.stopChrome(child);
  }
});

test('CDP 默认拒绝外网和其他本地端口，只放行自己的 mock origin', async () => {
  const sent = [];
  const ws = {
    testAllowedOrigins: ['http://127.0.0.1:45678'],
    send(raw) {
      const message = JSON.parse(raw);
      sent.push(message);
      queueMicrotask(() => ws.onmessage({ data: JSON.stringify({ id: message.id, result: {} }) }));
    }
  };
  T.createDriver(ws);
  for (const [url, allowed] of [
    ['https://wms.invalid.example/outbound/parcel', false],
    ['http://127.0.0.1:8000/api/jobs', false],
    ['http://127.0.0.1:45678/api/jobs', true],
    ['file:///isolated/index.html', true]
  ]) {
    ws.onmessage({ data: JSON.stringify({ method: 'Fetch.requestPaused', params: { requestId: url, request: { url } } }) });
    assert.equal(sent.at(-1).method, allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest');
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('模拟服务使用各自随机回环端口，关闭后不保留任务定时器', async () => {
  const opts = { htmlSource: __filename, samplePath: __filename };
  const first = createMockServer(opts), second = createMockServer(opts);
  try {
    const a = await first.listen(), b = await second.listen();
    assert.notEqual(a, b);
    assert.equal(new URL(a).hostname, '127.0.0.1');
    const result = await fetch(a + '/api/jobs', { method: 'POST', body: JSON.stringify({ mode: 'export', confirm_production: true }), signal: AbortSignal.timeout(1000) });
    assert.equal(result.status, 202);
    assert.equal(first.jobs.size, 1);
    assert.equal(second.jobs.size, 0);
    await first.close();
    await T.sleep(350);
    assert.equal([...first.jobs.values()][0].status, 'queued', '关闭后的模拟任务不得继续运行');
  } finally { await first.close(); await second.close(); }
});

test('渠道局部数量错配必须报错，即使全局总数和订单并集完全一致', () => {
  const mismatch = T.allocationInfo({ channels: [
    { name: 'A', total: 1, segments: [{ orderNos: ['O1', 'O2'] }] },
    { name: 'B', total: 2, segments: [{ orderNos: ['O3'] }] }
  ] }, 3);
  assert.equal(mismatch.err, 'channel-mismatch');
  assert.throws(() => T.assert(!mismatch.err, '渠道订单错分'), /渠道订单错分/);
  const correct = T.allocationInfo({ channels: [
    { name: 'A', total: 2, segments: [{ orderNos: ['O1', 'O2'] }] },
    { name: 'B', total: 1, segments: [{ orderNos: ['O3'] }] }
  ] }, 3);
  assert.deepEqual(correct, { total: 3, chTotal: 3, union: 3, dup: 0, empty: 0, segCount: 2 });
});
