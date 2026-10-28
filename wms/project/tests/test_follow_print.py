"""Follow printing never repeats generation and requires its saved workbook."""
import asyncio
import json
from types import SimpleNamespace

import pytest
from openpyxl import Workbook
from app.services.job_manager import JobManager
from test_job_retry import inputs, Result, finish


async def completed(settings, monkeypatch):
    async def run(progress, *, segments, **kwargs):
        results = []
        for i, segment in enumerate(segments):
            await progress('segment_start', json.dumps(segment))
            result = dict(segment, wave_no=f'W{i}', order_count=1)
            await progress('segment_wave', json.dumps(result))
            results.append(result)
        return Result(results)
    manager = JobManager(SimpleNamespace(), wave_generate_automation=SimpleNamespace(run=run), settings=settings)
    segments, plan = inputs()
    for ref, kind in zip(plan['workbook']['sheets'][0]['waveRefs'], ['mix', 'multi', 'paper']):
        ref['kind'] = kind
    job = manager.create('generate_waves', 'headless', segments=segments, batch_id='B', plan_id='P', plan_snapshot=plan, follow_print=True)
    await finish(manager, job)
    assert job.status == 'succeeded'
    assert job.follow_print_state == 'waiting_file'
    # Hold the actual print executor; tests never contact WMS.
    async def hold(child):
        await asyncio.Event().wait()
    monkeypatch.setattr(manager, '_execute', hold)
    return manager, job, plan


def save(manager, job, plan, corrupt=False):
    book = Workbook()
    sheet = book.active
    sheet.title = '波次表'
    for row in plan['workbook']['sheets'][0]['aoa']:
        sheet.append(row)
    for i in range(3):
        sheet.cell(i+2, 3, 'WRONG' if corrupt else f'W{i}')
    job.planning_export_file = 'plan.xlsx'
    book.save(manager.outputs_dir / job.planning_export_file)
    book.close()


async def stop(manager):
    manager.closing = True
    tasks = list(manager.tasks.values())
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.asyncio
async def test_saved_order_unique_child_and_restart(isolated_runtime, monkeypatch):
    manager, job, plan = await completed(isolated_runtime, monkeypatch)
    manager.arm_follow_print(job.id)
    assert job.follow_print_job_id is None
    save(manager, job, plan)
    manager.arm_follow_print(job.id)
    child = manager.get(job.follow_print_job_id)
    assert child.wave_nos == ['W0', 'W2']
    assert child.generation_job_id == job.id
    manager.arm_follow_print(job.id)
    assert len(manager.jobs) == 2
    await stop(manager)
    restored = JobManager(SimpleNamespace(), settings=isolated_runtime)
    restored.dispatch_follow_print()
    assert len(restored.jobs) == 2
    assert restored.get(job.id).follow_print_job_id == child.id


@pytest.mark.asyncio
@pytest.mark.parametrize('status', ['failed', 'partial', 'cancelled'])
async def test_incomplete_never_prints(isolated_runtime, monkeypatch, status):
    manager, job, plan = await completed(isolated_runtime, monkeypatch)
    save(manager, job, plan)
    job.status = status
    manager.arm_follow_print(job.id)
    manager.dispatch_follow_print()
    assert job.follow_print_job_id is None


@pytest.mark.asyncio
async def test_cancel_pending_and_bad_file(isolated_runtime, monkeypatch):
    manager, job, plan = await completed(isolated_runtime, monkeypatch)
    save(manager, job, plan, corrupt=True)
    manager.arm_follow_print(job.id)
    assert job.follow_print_state == 'blocked'
    assert job.follow_print_job_id is None
    job.follow_print_state = 'waiting_file'
    manager.cancel_follow_print(job.id)
    save(manager, job, plan)
    manager.arm_follow_print(job.id)
    assert job.follow_print_state == 'cancelled'
    assert job.follow_print_job_id is None


@pytest.mark.asyncio
async def test_waits_for_browser_cleanup(isolated_runtime, monkeypatch):
    manager, job, plan = await completed(isolated_runtime, monkeypatch)
    save(manager, job, plan)
    async with manager._run_lock:
        manager.arm_follow_print(job.id)
        assert job.follow_print_state == 'pending'
        assert job.follow_print_job_id is None
    manager.dispatch_follow_print()
    assert manager.get(job.follow_print_job_id).wave_nos == ['W0', 'W2']
    await stop(manager)


@pytest.mark.asyncio
async def test_empty_selection_skips_and_uncertain_result_blocks(isolated_runtime, monkeypatch):
    from app.services.job_plans import save_plan
    manager, job, plan = await completed(isolated_runtime, monkeypatch)
    save(manager, job, plan)
    job.node_states[manager.segment_key(job.segments[0])] = 'uncertain'
    manager.arm_follow_print(job.id)
    assert job.follow_print_state == 'blocked'
    assert job.follow_print_job_id is None
    job.node_states[manager.segment_key(job.segments[0])] = 'done'
    for ref in plan['workbook']['sheets'][0]['waveRefs']:
        ref['kind'] = 'multi'
    save_plan(manager.wave_records_dir, job.id, plan)
    job.follow_print_state = 'waiting_file'
    manager.arm_follow_print(job.id)
    assert job.follow_print_state == 'skipped'
    assert job.follow_print_job_id is None


def test_follow_requires_typed_snapshot():
    from pydantic import ValidationError
    from app.api.routes import CreateJobRequest
    segments, plan = inputs()
    with pytest.raises(ValidationError):
        CreateJobRequest(mode='generate_waves', follow_print=True, confirm_production=True, segments=segments)
    with pytest.raises(ValidationError):
        CreateJobRequest(mode='generate_waves', follow_print=True, confirm_production=True, segments=segments, batch_id='B', plan_id='P', plan_snapshot=plan)
