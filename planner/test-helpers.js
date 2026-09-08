/* 离线测试基建：只启动自己的临时 Chrome；默认阻断所有网络。
 * 本地模拟服务须显式加入 allowedOrigins，不能连接已有 Chrome/profile。
 * 产物位于本进程创建的系统临时目录，withChrome 无论成功失败均等待清理。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { pathToFileURL } = require('url');

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const ownedDirs = new Set();
const browsers = new Map();
function tempDir(label = 'run') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wave-planner-test-' + label + '-'));
  ownedDirs.add(fs.realpathSync(dir));
  return fs.realpathSync(dir);
}

/* 路径工厂：调用方传 __dirname */
function paths(baseDir) {
  let workDir;
  return {
    html: pathToFileURL(path.join(baseDir, '..', '波次规划工具.html')).href,
    sample: path.join(baseDir, '..', 'sample', 'ParcelOutbound_20260815193913.xlsx'),
    vendorXlsx: path.join(baseDir, 'vendor', 'xlsx.full.min.js'),
    core: path.join(baseDir, 'core.js'),
    tmp: (...p) => {
      if (!workDir) workDir = tempDir('artifacts');
      const target = path.resolve(workDir, ...p);
      if (target !== workDir && !target.startsWith(workDir + path.sep)) throw new Error('测试路径越界');
      return target;
    }
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function rmDir(d) {
  const target = path.resolve(d);
  const root = [...ownedDirs].find(r => target === r || target.startsWith(r + path.sep));
  if (!root) throw new Error('拒绝删除非本测试创建的目录: ' + target);
  // 不沿符号链接清理指向其他目录的祖先。
  let probe = target;
  while (!fs.existsSync(probe) && probe !== root) probe = path.dirname(probe);
  const real = fs.realpathSync(probe);
  if (real !== root && !real.startsWith(root + path.sep)) throw new Error('拒绝越界符号链接: ' + target);
  fs.rmSync(target, { recursive: true, force: true });
  if (target === root) ownedDirs.delete(root);
}
const ensureDir = d => fs.mkdirSync(d, { recursive: true });

function localOrigins(origins) {
  return origins.map(value => {
    const u = new URL(value);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port || u.origin !== value) {
      throw new Error('测试只允许显式的 127.0.0.1 模拟服务 origin: ' + value);
    }
    return u.origin;
  });
}

/* deny proxy 从启动瞬间约束页面、弹窗和浏览器后台请求，不转发任何请求。 */
async function launchChrome(options = {}) {
  const { chromePath = CHROME, allowedOrigins = [] } = options;
  if (Object.keys(options).some(k => !['chromePath', 'allowedOrigins'].includes(k))) {
    throw new Error('Chrome 测试不接受已有 profile、调试端口或额外启动参数');
  }
  const origins = localOrigins(allowedOrigins);
  const proxy = http.createServer((_req, res) => { res.writeHead(403); res.end('offline test'); });
  proxy.on('connect', (_req, socket) => {
    // Chrome can reset a rejected tunnel before the denial is flushed. This
    // socket is never forwarded; close it without crashing the test runner.
    socket.on('error', () => socket.destroy());
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', resolve);
  });
  const userDataDir = tempDir('chrome');
  const chrome = spawn(chromePath, [
    '--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--no-sandbox',
    '--disable-background-networking', '--disable-component-update', '--disable-sync',
    '--no-default-browser-check', '--disable-quic', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    `--proxy-server=http://127.0.0.1:${proxy.address().port}`,
    '--proxy-bypass-list=<-loopback>' + origins.map(o => ';' + new URL(o).host).join(''),
    'about:blank'
  ], { stdio: 'ignore' });
  const info = { userDataDir, origins, proxy, sockets: new Set(), error: null, exited: false };
  browsers.set(chrome, info);
  chrome.on('error', error => { info.error = error; });
  chrome.on('exit', () => { info.exited = true; });
  return chrome;
}

/* 轮询 CDP 端点并建立 WebSocket；失败时给出明确错误 */
async function connectCdp({ chrome, tries = 60, interval = 100, requestTimeout = 1000 }) {
  const info = browsers.get(chrome);
  if (!info) throw new Error('只能连接本测试启动的 Chrome');
  let url = null;
  let port;
  for (let i = 0; i < tries && !url; i++) {
    if (info.error || info.exited) throw info.error || new Error('测试 Chrome 在连接前退出');
    try {
      port = Number(fs.readFileSync(path.join(info.userDataDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('无效 CDP 端口');
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(requestTimeout) })).json();
      const page = list.find(t => t.type === 'page');
      if (page) url = page.webSocketDebuggerUrl;
    } catch (e) { /* 继续重试 */ }
    if (!url) await sleep(interval);
  }
  if (!url) throw new Error(`CDP 端点未就绪: http://127.0.0.1:${port}/json/list`);
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' || Number(endpoint.port) !== port) throw new Error('CDP 返回非本测试端点');
  const ws = new WebSocket(url);
  info.sockets.add(ws);
  ws.testAllowedOrigins = info.origins;
  await new Promise((res, rej) => {
    const timer = setTimeout(() => { ws.close(); rej(new Error('CDP WebSocket 连接超时')); }, 5000);
    ws.onopen = () => { clearTimeout(timer); res(); };
    ws.onerror = () => { clearTimeout(timer); rej(new Error('CDP WebSocket 连接失败')); };
  });
  return ws;
}

/* CDP 驱动器：send / evalJs / poll / enablePage */
function createDriver(ws, { pollTries = 100, pollInterval = 150, commandTimeout = 15000 } = {}) {
  let idc = 0;
  const pending = new Map();
  function rejectPending(message) {
    pending.forEach(({ reject, timer }) => { clearTimeout(timer); reject(new Error(message)); });
    pending.clear();
  }
  ws.onclose = () => rejectPending('CDP 连接已关闭');
  ws.onerror = () => rejectPending('CDP 连接错误');
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject, timer } = pending.get(m.id);
      clearTimeout(timer);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
    if (m.method === 'Fetch.requestPaused') {
      const { requestId, request } = m.params;
      const u = new URL(request.url);
      const allowed = ['file:', 'data:', 'blob:', 'about:'].includes(u.protocol)
        || (ws.testAllowedOrigins || []).includes(u.origin);
      send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
        allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }
  };
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++idc;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP 命令超时: ' + method)); }, commandTimeout);
      pending.set(id, { resolve, reject, timer });
      try { ws.send(JSON.stringify({ id, method, params })); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }
  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      throw new Error('页面异常: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || JSON.stringify(r.exceptionDetails)));
    }
    return r.result.value;
  }
  async function poll(expr, expect, tries = pollTries, interval = pollInterval) {
    for (let i = 0; i < tries; i++) {
      try {
        const v = await evalJs(expr);
        if (v === expect) return v;
      } catch (e) { /* 继续重试 */ }
      await sleep(interval);
    }
    const v = await evalJs(expr).catch(() => '(eval error)');
    throw new Error(`轮询超时: ${expr} 期望 ${expect}，实际 ${v}`);
  }
  async function enablePage() {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  }
  return { send, evalJs, poll, enablePage };
}

/* 抛错让 finally 有机会关闭浏览器/服务，禁止在断言内直接退出。 */
function assert(cond, msg) {
  if (!cond) throw new Error('断言失败: ' + msg);
}

/* 累积式校验（test-consistency 的 check 风格） */
function createChecker() {
  let failures = 0;
  const check = (cond, msg) => {
    if (!cond) { failures++; console.error('  ✘ ' + msg); }
  };
  const result = () => failures;
  return { check, result };
}

/* 可序列化到页面执行的不变量采集器；渠道错误必须返回外层，不能被 forEach 吞掉。 */
function allocationInfo(analysis, total) {
  var segCount = 0, chTotal = 0, seen = new Set(), dup = 0, empty = 0;
  for (var ch of analysis.channels) {
    chTotal += ch.total;
    var chSeen = new Set();
    for (var seg of ch.segments) {
      segCount++;
      if (!seg.orderNos.length) empty++;
      for (var no of seg.orderNos) {
        if (seen.has(no)) dup++;
        seen.add(no);
        chSeen.add(no);
      }
    }
    if (chSeen.size !== ch.total) return { err: 'channel-mismatch', ch: ch.name, union: chSeen.size, total: ch.total };
  }
  return { total: total, chTotal: chTotal, union: seen.size, dup: dup, empty: empty, segCount: segCount };
}

/* 样本导入表达式：读取 sample 后生成可交给 evalJs 的自执行字符串 */
function importFileExpr(samplePath) {
  const b64 = fs.readFileSync(samplePath).toString('base64');
  return `(function(){var bin=atob('${b64}');var bytes=new Uint8Array(bin.length);` +
    `for(var i=0;i<bin.length;i++)bytes[i]=bin.charCodeAt(i);` +
    `window.__dshTest.handleFile(new File([bytes],'sample.xlsx'));return 'ok';})()`;
}

/* 截图到 shotsDir（自动建目录） */
async function captureShot(send, name, shotsDir, { full = false } = {}) {
  ensureDir(shotsDir);
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full });
  fs.writeFileSync(path.join(shotsDir, `${name}.png`), Buffer.from(r.data, 'base64'));
  console.log('saved', name + '.png');
}

/* Chrome 生命周期包装：统一清理与退出 */
async function stopChrome(chrome) {
  const info = browsers.get(chrome);
  if (!info) throw new Error('拒绝清理非本测试启动的 Chrome');
  for (const ws of info.sockets) ws.close();
  if (!info.exited && !info.error) {
    chrome.kill('SIGTERM');
    for (let n = 0; n < 30 && !info.exited; n++) await sleep(100);
    if (!info.exited) {
      chrome.kill('SIGKILL');
      for (let n = 0; n < 30 && !info.exited; n++) await sleep(100);
    }
    if (!info.exited) throw new Error('测试 Chrome 未退出；保留临时 profile 以免删除在用文件');
  }
  if (info.proxy.closeAllConnections) info.proxy.closeAllConnections();
  await new Promise(resolve => info.proxy.close(resolve));
  rmDir(info.userDataDir);
  browsers.delete(chrome);
}

async function withChrome(options, fn, cleanup = () => {}) {
  let chrome;
  try {
    chrome = await launchChrome(options);
    await fn(chrome);
  } catch (e) {
    console.error('✘ 测试失败:', e.message);
    process.exitCode = 1;
  } finally {
    try { if (chrome) await stopChrome(chrome); }
    catch (e) { console.error('✘ 浏览器清理失败:', e.message); process.exitCode = 1; }
    try { await cleanup(); }
    catch (e) { console.error('✘ 服务清理失败:', e.message); process.exitCode = 1; }
    // 仍在运行的浏览器目录不得删除。
    const activeDirs = new Set([...browsers.values()].map(info => info.userDataDir));
    for (const dir of [...ownedDirs]) if (!activeDirs.has(dir)) rmDir(dir);
  }
}

module.exports = {
  CHROME, paths, sleep, rmDir, ensureDir, tempDir, launchChrome, stopChrome,
  connectCdp, createDriver, assert, createChecker, allocationInfo,
  importFileExpr, captureShot, withChrome
};
