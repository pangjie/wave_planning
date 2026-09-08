/* 实际 Chrome 隔离边界：仅使用本测试自建 canary 服务，不触碰已有服务或外网。 */
'use strict';
const http = require('http');
const T = require('./test-helpers');

(async () => {
  let requests = 0;
  const canary = http.createServer((_req, res) => { requests++; res.end('must not reach'); });
  await new Promise((resolve, reject) => {
    canary.once('error', reject);
    canary.listen(0, '127.0.0.1', resolve);
  });
  const target = 'http://127.0.0.1:' + canary.address().port;
  await T.withChrome({}, async chrome => {
    const ws = await T.connectCdp({ chrome });
    const driver = T.createDriver(ws);
    await driver.enablePage();
    const tryFetch = `fetch(${JSON.stringify(target)}, {mode:'no-cors', signal:AbortSignal.timeout(2000)}).then(()=>true,()=>false)`;
    T.assert(await driver.evalJs(tryFetch) === false, 'CDP 必须阻止未获准的本地请求');
    T.assert(requests === 0, '未获准的 canary 不应收到请求');
    // 关闭页面级拦截，仍应被启动时配置的 deny proxy 挡住。
    await driver.send('Fetch.disable');
    await driver.evalJs(tryFetch);
    T.assert(requests === 0, '即使关闭 CDP 拦截，启动级代理也不得放行未获准端口');
    console.log('✔ 页面拦截与启动级 deny proxy 均阻断未获准回环端口（canary 收到 0 请求）');
  }, async () => {
    if (canary.closeAllConnections) canary.closeAllConnections();
    await new Promise(resolve => canary.close(resolve));
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
