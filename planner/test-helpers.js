/* 测试与工具脚本共享基建：路径工厂、Chrome/CDP 驱动、断言、样本导入、截图。
 * 所有脚本保持 __dirname 相对路径约定：paths(__dirname) 解析 sample/vendor/tmp。
 * 端口与临时目录仍由各调用方指定，保证可并行运行。 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const CHROME = process.env.CHROME_PATH
  || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* 路径工厂：调用方传 __dirname */
function paths(baseDir) {
  return {
    html: pathToFileURL(path.join(baseDir, '..', '波次规划工具.html')).href,
    sample: path.join(baseDir, '..', 'sample', 'ParcelOutbound_20260815193913.xlsx'),
    vendorXlsx: path.join(baseDir, 'vendor', 'xlsx.full.min.js'),
    core: path.join(baseDir, 'core.js'),
    tmp: (...p) => path.join(baseDir, 'tmp', ...p)
  };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const rmDir = d => fs.rmSync(d, { recursive: true, force: true });
const ensureDir = d => fs.mkdirSync(d, { recursive: true });

/* 启动 headless Chrome（清空并重建 profile 目录） */
function launchChrome({ port, userDataDir, chromePath = CHROME, extraArgs = ['about:blank'] }) {
  rmDir(userDataDir);
  ensureDir(userDataDir);
  return spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--disable-gpu', '--disable-extensions', '--no-sandbox',
    ...extraArgs
  ], { stdio: 'ignore' });
}

/* 轮询 CDP 端点并建立 WebSocket；失败时给出明确错误 */
async function connectCdp({ port, tries = 60, interval = 300 }) {
  let url = null;
  for (let i = 0; i < tries && !url; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find(t => t.type === 'page');
      if (page) url = page.webSocketDebuggerUrl;
    } catch (e) { /* 继续重试 */ }
    if (!url) await sleep(interval);
  }
  if (!url) throw new Error(`CDP 端点未就绪: http://127.0.0.1:${port}/json/list`);
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  return ws;
}

/* CDP 驱动器：send / evalJs / poll / enablePage */
function createDriver(ws, { pollTries = 100, pollInterval = 150 } = {}) {
  let idc = 0;
  const pending = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
  };
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++idc;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
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
  }
  return { send, evalJs, poll, enablePage };
}

/* 硬断言：保持既有 process.exit(1) 语义 */
function assert(cond, msg) {
  if (!cond) { console.error('✘ 断言失败: ' + msg); process.exit(1); }
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
async function withChrome(chrome, fn, cleanup = () => {}) {
  try {
    await fn();
  } catch (e) {
    console.error('✘ 测试失败:', e.message);
    try { cleanup(); } catch (err) { /* 忽略清理异常 */ }
    try { chrome.kill(); } catch (err) { /* 已退出 */ }
    process.exit(1);
  }
  try { cleanup(); } catch (err) { /* 忽略清理异常 */ }
  chrome.kill();
  process.exit(0);
}

module.exports = {
  CHROME, paths, sleep, rmDir, ensureDir, launchChrome,
  connectCdp, createDriver, assert, createChecker,
  importFileExpr, captureShot, withChrome
};
