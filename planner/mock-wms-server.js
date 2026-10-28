/* 独立随机回环端口的模拟 WMS：供 test-wms-ui.js 与集成验证复用。
 * 行为：health/jobs 增删查/取消/导出文件下载 + 测试控制面（/api/__test/*）。
 * 独立于共享基建 test-helpers.js，便于单独维护。 */
'use strict';
const fs = require('fs');
const http = require('http');

function createMockServer({ samplePath, htmlSource, waveRecords = [], retryHandler = null, schedule = null }) {
  const timers = new Set();
  const later = (fn, ms) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
    timers.add(timer);
    return timer;
  };
  let jobSeq = 0;
  const jobs = new Map();
  const requests = [];
  const exports = new Map();  // 文件名 -> 字节
  const plans = new Map();
  let failSegment = null;    // 测试注入：{channel, seg_name} 命中即该分段生成失败
  let failClear = false;

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
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    try {
      /* 测试控制面 */
      if (p === '/api/__test/requests') return json(res, 200, requests);
      if (p === '/api/__test/clear') { requests.length = 0; return json(res, 200, { ok: true }); }
      if (p === '/api/__test/fail-history-clear' && req.method === 'POST') {
        failClear = !!(await readBody(req)).enabled;
        return json(res, 200, { ok: true });
      }
      if (p === '/api/__test/fail-segment' && req.method === 'POST') {
        const body = await readBody(req);
        failSegment = (body && body.channel && body.seg_name)
          ? { channel: String(body.channel), seg_name: String(body.seg_name) }
          : null;
        return json(res, 200, { ok: true });
      }

      if (p === '/api/health') return json(res, 200, { status: 'ok' });
      if (schedule && p === '/api/schedule') {
        if(req.method === 'PUT') {schedule.config = await readBody(req);requests.push({mode:'schedule',...schedule.config});}
        return json(res,200,schedule);
      }
      if(schedule && /^\/api\/schedule\/runs\/[^/]+\/file$/.test(p)) {
        requests.push({mode:'cutoff_file'});
        res.writeHead(200,{'Content-Type':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
        return res.end(fs.readFileSync(samplePath));
      }
      const retryRoute = p.match(/^\/api\/jobs\/([^/]+)\/retry$/);
      if (retryRoute && req.method === 'POST' && retryHandler) {
        const body = await readBody(req);
        const result = await retryHandler(jobs.get(retryRoute[1]), body);
        jobs.set(result.id, result);
        return json(res, 202, result);
      }

      if (p === '/api/wave-records' && req.method === 'GET') {
        return json(res, 200, url.searchParams.has('batch_id') ? waveRecords.filter(r =>
          r.batch_id === url.searchParams.get('batch_id') && r.plan_id === url.searchParams.get('plan_id')) : waveRecords);
      }
      if (p === '/api/wave-records/clear' && req.method === 'POST') {
        if (failClear) return json(res, 503, { detail: '模拟历史保存失败' });
        const keep = waveRecords.filter(r => (r.batch_id || null) !== url.searchParams.get('batch_id') ||
          (r.plan_id || null) !== url.searchParams.get('plan_id'));
        waveRecords.splice(0, waveRecords.length, ...keep);
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
      const planRoute = p.match(/^\/api\/jobs\/([^/]+)\/plan$/);
      if (planRoute && req.method === 'GET') {
        const plan = plans.get(planRoute[1]);
        return json(res, plan ? 200 : 404, plan || { detail: '没有快照' });
      }
      const savePlanRoute = p.match(/^\/api\/jobs\/([^/]+)\/planning-export$/);
      if (savePlanRoute && req.method === 'POST') {
        const job = jobs.get(savePlanRoute[1]);
        if (!job || !job.has_plan_snapshot) return json(res, 404, { detail: '没有快照' });
        const bytes = await readBodyRaw(req);
        const name = '波次规划-' + job.id + '.xlsx';
        if (!exports.has(name)) exports.set(name, bytes);
        job.planning_export_file = name;
        if(job.follow_print && job.status==='succeeded' && !job.follow_print_job_id){
          const refs=plans.get(job.id).snapshot.workbook.sheets.find(s=>s.name==='波次表').waveRefs;
          const waves=refs.filter(r=>['paper','mix'].includes(r.kind)).sort((a,b)=>a.row-b.row).map(r=>job.result.segments.find(s=>s.channel===r.channel&&s.seg_name===r.seg_name).wave_no);
          const child=mkJob('print_waves',job.browser_mode,waves);
          child.generation_job_id=job.id;job.follow_print_job_id=child.id;job.follow_print_state='started';
          later(()=>{child.status='succeeded';child.result={wave_nos:waves,merged_file:'outputs/follow.pdf'};},500);
        }
        return json(res, 200, { file: name, url: '/api/exports/' + encodeURIComponent(name) });
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
        job.segments = body.segments || [];
        job.follow_print=!!body.follow_print;
        job.follow_print_state=job.follow_print?'waiting_generation':'off';
        job.batch_id = body.batch_id;
        job.plan_id = body.plan_id;
        job.has_plan_snapshot = !!body.plan_snapshot;
        if (body.plan_snapshot) plans.set(job.id, { batch_id: body.batch_id, plan_id: body.plan_id, snapshot: body.plan_snapshot });
        if (body.mode === 'export') {
          later(() => {
            pushEvent(job, 'opened', '已打开出库订单页，等待数据加载。');
            pushEvent(job, 'template', '模板「渠道拆分」校验通过，关键字段齐全。');
            later(() => {
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
          later(() => {
            pushEvent(job, 'printing', '开始打印波次 ' + waves.join('、'));
            later(() => {
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
          const segs = (body.segments || []).map((sg, i) => {
            const fail = failSegment
              && sg.seg_name === failSegment.seg_name
              && sg.channel === failSegment.channel;
            return {
              channel: sg.channel, seg_name: sg.seg_name,
              order_count: (sg.order_nos || []).length,
              wave_no: fail ? null : 'W' + String(2026081700001 + i).padStart(13, '0'),
              note: fail ? '搜索结果总数与目标不一致（模拟数量核对失败），已停止。' : null
            };
          });
          later(() => {
            pushEvent(job, 'searching', `将为 ${segs.length} 个分段生成波次（模拟）。`);
            /* 逐段上报波次号：模拟“生成一个记录一个变绿一个”；失败段上报 segment_failed */
            segs.forEach((sg, i) => {
              later(() => {
                if (job.status !== 'running') return;
                if (sg.wave_no) {
                  waveRecords.push({ ...sg, batch_id: job.batch_id, plan_id: job.plan_id, job_id: job.id,
                    order_nos: job.segments[i].order_nos });
                  pushEvent(job, 'segment_wave', JSON.stringify({
                    channel: sg.channel, seg_name: sg.seg_name, wave_no: sg.wave_no
                  }));
                } else {
                  pushEvent(job, 'segment_failed', `分段 ${sg.channel} ${sg.seg_name} 失败：${sg.note}不重试该分段，恢复页面后继续下一分段。`);
                }
              }, 400 + i * 250);
            });
            later(() => {
              if (job.status !== 'running') return;
              const failed = segs.filter(s => !s.wave_no).length;
              job.status = failed ? 'partial' : 'succeeded';
              job.updated_at = now();
              job.result = {
                mode: 'generate_waves',
                message: `生成波次完成：${segs.length - failed}/${segs.length} 个分段成功。`,
                segments: segs, generated_count: segs.length - failed, failed_count: failed,
                completed_at: now()
              };
              job.events.push({
                stage: failed ? 'completed_with_warnings' : 'completed',
                message: `生成波次完成：${segs.length - failed}/${segs.length} 个分段成功。`,
                at: now()
              });
            }, 400 + segs.length * 250 + 250);
          }, 200);
        } else { /* pick_waves：保持运行，供取消流程测试 */
          later(() => {
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
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve('http://127.0.0.1:' + server.address().port);
      });
    }),
    close: () => new Promise(r => {
      timers.forEach(clearTimeout);
      timers.clear();
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(r);
    })
  };
}

module.exports = { createMockServer };
