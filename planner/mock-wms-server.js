/* 模拟 WMS 本地服务（8000）：供 test-wms-ui.js 与集成验证复用。
 * 行为：health/jobs 增删查/取消/导出文件下载 + 测试控制面（/api/__test/*）。
 * 独立于共享基建 test-helpers.js，便于单独维护。 */
'use strict';
const fs = require('fs');
const http = require('http');

function createMockServer({ samplePath, htmlSource, site = 'http://127.0.0.1:8000', waveRecords = [] }) {
  let jobSeq = 0;
  const jobs = new Map();
  const requests = [];
  const exports = new Map();  // 文件名 -> 字节

  function now() { return new Date().toISOString(); }
  function mkJob(mode, browserMode, waveNos) {
    const id = 'job-' + (++jobSeq);
    const job = {
      id, mode, browser_mode: browserMode, status: 'queued',
      created_at: now(), updated_at: now(),
      events: [{ stage: 'queued', message: '任务已进入队列。', at: now() }],
      wave_nos: waveNos, result: null, error: null
    };
    jobs.set(id, job);
    return job;
  }
  function pushEvent(job, stage, message) {
    job.status = 'running';
    job.updated_at = now();
    job.events.push({ stage, message, at: now() });
  }
  function json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }
  function readBody(req) {
    return new Promise(resolve => {
      let data = '';
      req.on('data', c => { data += c; });
      req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve({}); } });
    });
  }
  function readBodyRaw(req) {
    return new Promise(resolve => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, site);
    const p = url.pathname;
    try {
      /* 测试控制面 */
      if (p === '/api/__test/requests') return json(res, 200, requests);
      if (p === '/api/__test/clear') { requests.length = 0; return json(res, 200, { ok: true }); }

      if (p === '/api/health') return json(res, 200, { status: 'ok' });

      if (p === '/api/wave-records' && req.method === 'GET') {
        return json(res, 200, waveRecords);
      }
      if (p === '/api/wave-records/clear' && req.method === 'POST') {
        waveRecords.length = 0;
        return json(res, 200, { status: 'ok' });
      }
      if (p === '/api/__test/wave-records' && req.method === 'POST') {
        const body = await readBody(req);
        waveRecords.length = 0;
        (body.records || []).forEach(r => waveRecords.push(r));
        return json(res, 200, { ok: true });
      }

      if (p === '/api/exports' && req.method === 'GET') {
        const items = [...exports.entries()].reverse().map(([file, data]) => ({
          file, url: '/api/exports/' + encodeURIComponent(file),
          size: data.length, modified_at: 0
        }));
        return json(res, 200, items);
      }
      if (p === '/api/exports' && req.method === 'POST') {
        const body = await readBodyRaw(req);
        if (!body || body.length < 4) return json(res, 400, { detail: '导出文件内容无效。' });
        let name = decodeURIComponent(url.searchParams.get('filename') || '波次规划.xlsx');
        exports.set(name, body);
        return json(res, 200, { file: name, url: '/api/exports/' + encodeURIComponent(name) });
      }
      const me = p.match(/^\/api\/exports\/([^/]+)$/);
      if (me && req.method === 'GET') {
        const data = exports.get(decodeURIComponent(me[1]));
        if (!data) return json(res, 404, { detail: '导出文件不存在。' });
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Length': data.length
        });
        return res.end(data);
      }

      if (p === '/api/jobs' && req.method === 'GET') {
        return json(res, 200, [...jobs.values()].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)));
      }
      if (p === '/api/jobs' && req.method === 'POST') {
        const body = await readBody(req);
        requests.push({ mode: body.mode, confirm_production: body.confirm_production, wave_nos: body.wave_nos, browser_mode: body.browser_mode, segments: body.segments });
        const active = [...jobs.values()].find(j => j.status === 'queued' || j.status === 'running');
        if (active) return json(res, 409, { detail: '已有任务正在排队或执行，请等待当前任务结束后再提交。' });
        if (body.confirm_production !== true) return json(res, 422, { detail: '必须显式确认生产操作。' });
        let waves = [];
        if (body.mode !== 'export') {
          waves = (body.wave_nos || []).map(w => String(w).trim()).filter(w => w && /^[A-Za-z0-9_-]+$/.test(w));
          if (body.mode === 'print_waves' && !waves.length) return json(res, 422, { detail: '打印选中波次时必须至少提供一个波次号。' });
        }
        const job = mkJob(body.mode, body.browser_mode || 'headed', waves);
        if (body.mode === 'export') {
          setTimeout(() => {
            pushEvent(job, 'opened', '已打开出库订单页，等待数据加载。');
            pushEvent(job, 'template', '模板「渠道拆分」校验通过，关键字段齐全。');
            setTimeout(() => {
              job.status = 'succeeded';
              job.updated_at = now();
              job.result = {
                mode: 'export', message: '订单导出完成，文件已保存。',
                template: '渠道拆分', task_filename: 'ParcelOutbound_mock.xlsx',
                downloaded_file: samplePath,
                completed_at: now()
              };
              job.events.push({ stage: 'completed', message: '订单导出完成，文件已保存。', at: now() });
            }, 900);
          }, 300);
        } else if (body.mode === 'print_waves') {
          setTimeout(() => {
            pushEvent(job, 'printing', '开始打印波次 ' + waves.join('、'));
            setTimeout(() => {
              job.status = 'succeeded';
              job.updated_at = now();
              job.result = {
                mode: 'print_waves', message: '打印完成，已合并 Paper合并_2026-08-15.pdf',
                wave_nos: waves, failed_wave_nos: [], warnings: [],
                printed_files: waves.map(w => `outputs/${w}.pdf`),
                merged_file: 'outputs/Paper合并_2026-08-15.pdf', completed_at: now()
              };
              job.events.push({ stage: 'completed', message: '打印完成，已合并 Paper合并_2026-08-15.pdf', at: now() });
            }, 800);
          }, 200);
        } else if (body.mode === 'generate_waves') {
          const segs = (body.segments || []).map((sg, i) => ({
            channel: sg.channel, seg_name: sg.seg_name,
            order_count: (sg.order_nos || []).length,
            wave_no: 'W' + String(2026081700001 + i).padStart(13, '0')
          }));
          setTimeout(() => {
            pushEvent(job, 'searching', `将为 ${segs.length} 个分段生成波次（模拟）。`);
            /* 逐段上报波次号：模拟“生成一个记录一个变绿一个” */
            segs.forEach((sg, i) => {
              setTimeout(() => {
                if (job.status !== 'running') return;
                pushEvent(job, 'segment_wave', JSON.stringify({
                  channel: sg.channel, seg_name: sg.seg_name, wave_no: sg.wave_no
                }));
              }, 400 + i * 250);
            });
            setTimeout(() => {
              if (job.status !== 'running') return;
              job.status = 'succeeded';
              job.updated_at = now();
              job.result = {
                mode: 'generate_waves',
                message: `生成波次完成：${segs.length}/${segs.length} 个分段成功。`,
                segments: segs, generated_count: segs.length, failed_count: 0,
                completed_at: now()
              };
              job.events.push({ stage: 'completed', message: `生成波次完成：${segs.length} 个分段成功。`, at: now() });
            }, 400 + segs.length * 250 + 250);
          }, 200);
        } else { /* pick_waves：保持运行，供取消流程测试 */
          setTimeout(() => {
            pushEvent(job, 'snapshot', '已锁定待拣货波次快照（' + (waves.length || 3) + ' 个）。');
          }, 200);
        }
        return json(res, 202, job);
      }

      const mm = p.match(/^\/api\/jobs\/([^/]+)\/merged$/);
      if (mm && req.method === 'GET') {
        const job = jobs.get(mm[1]);
        if (!job || !job.result || !job.result.merged_file) return json(res, 404, { detail: '该任务没有合并文档。' });
        const data = Buffer.from('%PDF-1.4 mock merged');
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': data.length });
        return res.end(data);
      }
      const mc = p.match(/^\/api\/jobs\/([^/]+)\/cancel$/);
      if (mc && req.method === 'POST') {
        const job = jobs.get(mc[1]);
        if (!job) return json(res, 404, { detail: '任务不存在。' });
        job.status = 'cancelled';
        job.updated_at = now();
        job.events.push({ stage: 'cancelled', message: '任务已取消。', at: now() });
        return json(res, 200, job);
      }
      const mf = p.match(/^\/api\/jobs\/([^/]+)\/file$/);
      if (mf && req.method === 'GET') {
        const job = jobs.get(mf[1]);
        if (!job || !job.result || !job.result.downloaded_file) return json(res, 404, { detail: '该任务没有可下载的导出文件。' });
        const data = fs.readFileSync(samplePath);
        res.writeHead(200, {
          'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Length': data.length
        });
        return res.end(data);
      }
      const mj = p.match(/^\/api\/jobs\/([^/]+)$/);
      if (mj && req.method === 'GET') {
        const job = jobs.get(mj[1]);
        if (!job) return json(res, 404, { detail: '任务不存在。' });
        return json(res, 200, job);
      }
      if (p === '/' || p === '/index.html') {
        const data = fs.readFileSync(htmlSource);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(data);
      }
      return json(res, 404, { detail: 'not found: ' + p });
    } catch (e) {
      return json(res, 500, { detail: String(e && e.message || e) });
    }
  });

  return {
    server,
    requests,
    jobs,
    listen: (port, host) => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => { server.removeListener('error', reject); resolve(); });
    }),
    close: () => new Promise(r => {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(r);
    })
  };
}

module.exports = { createMockServer };
