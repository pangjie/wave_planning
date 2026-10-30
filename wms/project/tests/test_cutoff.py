# 回归范围：截单日历、阶段恢复、文件合并与边界重叠去重。
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock
import asyncio
import json

from fastapi.testclient import TestClient
from openpyxl import Workbook, load_workbook
import pytest

from app.services.cutoff_merge import merge_orders, read_orders
from app.services.cutoff_schedule import CutoffConfig, CutoffScheduler, occurrence
from app.services.job_manager import JobManager
from app.automation.wms_export import ExportResult


@pytest.mark.asyncio
async def test_date_filter_commits_with_enter_and_checks_readback(isolated_runtime, monkeypatch):
    from app.automation import wms_export as mod
    automation=mod.WmsExportAutomation(isolated_runtime,isolated_runtime.load_automation())
    monkeypatch.setattr(mod,'wait_for_loading',AsyncMock())
    page=MagicMock()
    control=MagicMock()
    control.click=AsyncMock()
    page.get_by_role.return_value=control
    field=MagicMock(count=AsyncMock(return_value=1),input_value=AsyncMock(return_value='创建时间'))
    first=MagicMock(fill=AsyncMock(),input_value=AsyncMock(return_value='2026-10-20 07:00:00'))
    last=MagicMock(fill=AsyncMock(),press=AsyncMock(),input_value=AsyncMock(return_value='2026-10-27 06:30:00'))
    page.locator.side_effect=[field,first,last]
    page.wait_for_function=AsyncMock()
    bounds={'start':'2026-10-20 07:00:00','end':'2026-10-27 06:30:00'}
    await automation._apply_created_range(page,bounds,AsyncMock())
    first.fill.assert_awaited_once_with(bounds['start'])
    last.fill.assert_awaited_once_with(bounds['end'])
    last.press.assert_awaited_once_with('Enter')
    page.locator.side_effect=[field,first,last]
    first.input_value=AsyncMock(return_value='2026-10-25 00:00:00')
    with pytest.raises(mod.AutomationError,match='改写'):
        await automation._apply_created_range(page,bounds,AsyncMock())


@pytest.mark.asyncio
async def test_resume_known_export_never_resubmits(isolated_runtime,monkeypatch):
    from contextlib import asynccontextmanager
    from app.automation import wms_export as mod
    normalize = MagicMock(return_value=1)
    monkeypatch.setattr(mod, 'normalize_order_file', normalize)
    from app.automation.export_task_center import TaskCenterItem
    page=MagicMock(goto=AsyncMock(),url='https://example.invalid')
    context=SimpleNamespace(pages=[page])
    @asynccontextmanager
    async def browser(*args,**kwargs): yield context
    monkeypatch.setattr(mod,'open_browser_context',browser)
    automation=mod.WmsExportAutomation(isolated_runtime,isolated_runtime.load_automation())
    automation._prepare_and_submit=AsyncMock()
    item=TaskCenterItem('ParcelOutbound_test.xlsx','now','ready','',True)
    automation.task_center.wait_until_downloadable=AsyncMock(return_value=item)
    automation.task_center.download=AsyncMock(return_value=isolated_runtime.downloads_dir/'test.xlsx')
    await automation.run(AsyncMock(),headless=True,checkpoint={'submitted':True,'task_key':item.key})
    automation._prepare_and_submit.assert_not_called()
    normalize.assert_called_once_with(isolated_runtime.downloads_dir/'test.xlsx')
    assert automation.task_center.wait_until_downloadable.call_args.kwargs['detected_key']==item.key


@pytest.mark.asyncio
async def test_scheduled_task_identity_checkpoint_and_ambiguity(isolated_runtime):
    from app.automation.export_task_center import ExportTaskCenter,TaskCenterItem
    from app.automation.common import AutomationError
    center=ExportTaskCenter(isolated_runtime,isolated_runtime.load_automation())
    center._open=AsyncMock()
    item=TaskCenterItem('ParcelOutbound_test.xlsx','now','ready','',True)
    center._read_items=AsyncMock(return_value=[item])
    progress=AsyncMock()
    assert await center.wait_until_downloadable(MagicMock(),set(),progress,checkpoint=True)==item
    events=[call.args for call in progress.await_args_list]
    assert json.loads(next(message for stage,message in events if stage=='export_checkpoint'))['task_key']==item.key
    center._read_items=AsyncMock(return_value=[item,TaskCenterItem('ParcelOutbound_other.xlsx','now','ready','',True)])
    with pytest.raises(AutomationError,match='多个'):
        await center.wait_until_downloadable(MagicMock(),set(),progress,checkpoint=True)

HEAD = ['Outbound Order No/出库单号', 'Shipping Carrier/物流承运商', 'Type of order variety/订单品种类型',
        'Package 1\nTracking No./物流跟踪号', 'SKU 1\nSKU', 'Total Qty of SKU/总数量', 'Client/客户']


def workbook(path, rows, header=None):
    w = Workbook()
    s = w.active
    s.title = '出库单'
    s.append(header or HEAD)
    for row in rows:
        s.append(row)
    w.save(path)
    w.close()
    return path


def row(order, sku='SKU1'):
    return [order, 'USPS', '单品单件', '001234567890123456789012', sku, 1, '客户(CODE)']


@pytest.mark.asyncio
@pytest.mark.parametrize('scheduled',[False,True])
async def test_export_prepares_correct_filter_before_submission(isolated_runtime,monkeypatch,scheduled):
    from app.automation import wms_export as mod
    automation=mod.WmsExportAutomation(isolated_runtime,isolated_runtime.load_automation())
    monkeypatch.setattr(mod,'wait_for_loading',AsyncMock())
    button=MagicMock(count=AsyncMock(return_value=1),is_enabled=AsyncMock(return_value=True),
                     click=AsyncMock(),wait_for=AsyncMock())
    button.filter.return_value=button
    button.locator.return_value=button
    page=MagicMock(goto=AsyncMock())
    page.locator.return_value=button
    automation._reset_order_filters=AsyncMock()
    automation._apply_created_range=AsyncMock()
    automation._ensure_template=AsyncMock(return_value='渠道拆分')
    automation._wait_for_required_template_fields=AsyncMock(return_value=HEAD)
    automation._read_result_message=AsyncMock(return_value='ok')
    automation.task_center.snapshot=AsyncMock(return_value=[])
    automation.task_center.wait_until_downloadable=AsyncMock(return_value=SimpleNamespace(filename='test.xlsx'))
    bounds={'start':'2026-10-20 07:00:00','end':'2026-10-27 06:30:00'} if scheduled else None
    await automation._prepare_and_submit(page,AsyncMock(),created_range=bounds)
    if scheduled:
        automation._apply_created_range.assert_awaited_once()
        automation._reset_order_filters.assert_not_called()
    else:
        automation._reset_order_filters.assert_awaited_once_with(page)
        automation._apply_created_range.assert_not_called()


def test_merge_replaces_whole_row_preserves_ids_dynamic_columns(tmp_path):
    base = workbook(tmp_path/'base.xlsx', [row('A'), row('B')])
    delta = workbook(tmp_path/'delta.xlsx', [row('B','NEW')+['SKU2'], row('C')+[None]], HEAD+['SKU 2\nSKU'])
    target = tmp_path/'final.xlsx'
    assert merge_orders(base, delta, target) == dict(base=2, delta=2, overlap=1, total=3)
    header, rows = read_orders(target)
    assert list(rows) == ['A','B','C']
    assert rows['B'][4] == 'NEW' and rows['B'][-1] == 'SKU2'
    assert rows['A'][3] == '001234567890123456789012' and rows['A'][-1] is None


@pytest.mark.parametrize('rows', [[row('A'),row('A')],[row(None)],[row(123)],[row('A','=1+2')]])
def test_merge_rejects_invalid_rows_without_publication(tmp_path, rows):
    base=workbook(tmp_path/'base.xlsx',rows)
    delta=workbook(tmp_path/'delta.xlsx',[])
    target=tmp_path/'final.xlsx'
    with pytest.raises(ValueError): merge_orders(base,delta,target)
    assert not target.exists()


def test_empty_delta_and_empty_result(tmp_path):
    base=workbook(tmp_path/'base.xlsx',[])
    delta=workbook(tmp_path/'delta.xlsx',[])
    assert merge_orders(base,delta,tmp_path/'final.xlsx')['total']==0
    workbook(base,[row('A')])
    assert merge_orders(base,delta,tmp_path/'second.xlsx')['total']==1


def test_template_mismatch(tmp_path):
    base=workbook(tmp_path/'base.xlsx',[row('A')])
    delta=workbook(tmp_path/'delta.xlsx',[],HEAD+['Other'])
    with pytest.raises(ValueError,match='模板'): merge_orders(base,delta,tmp_path/'final.xlsx')


def test_occurrence_timezone_dst_and_first_save():
    config=CutoffConfig(enabled=True,cutoff_time='07:00')
    assert occurrence(config,datetime(2026,10,27,10,0,tzinfo=timezone.utc))==datetime(2026,10,27,11,0,tzinfo=timezone.utc)
    # Already past pre-export => next full cycle, never an immediate surprise export.
    assert occurrence(config,datetime(2026,10,27,10,31,tzinfo=timezone.utc)).day==28
    gap=CutoffConfig(enabled=True,cutoff_time='02:30')
    assert occurrence(gap,datetime(2026,3,8,5,0,tzinfo=timezone.utc)).day==9
    fold=CutoffConfig(enabled=True,cutoff_time='01:30')
    assert occurrence(fold,datetime(2026,11,1,4,0,tzinfo=timezone.utc)).hour==5


def setup(manager, settings):
    scheduler=CutoffScheduler(manager,settings.downloads_dir)
    scheduler.config=CutoffConfig(enabled=True)
    scheduler.next_cutoff='2026-10-27T11:00:00+00:00'
    return scheduler


async def finish(manager):
    await asyncio.gather(*list(manager.tasks.values()))
    await asyncio.sleep(0)


@pytest.mark.asyncio
async def test_full_schedule_week_bounds_overlap_and_restart(isolated_runtime):
    calls=[]
    async def export(progress,**kwargs):
        calls.append(kwargs)
        await progress('created_range_verified','range verified')
        await progress('export_checkpoint',json.dumps({'submitted':True,'task_key':'one'}))
        path=workbook(isolated_runtime.downloads_dir/f'export{len(calls)}.xlsx', [row('A')] if len(calls)==1 else [row('B')])
        return ExportResult(mode='export',template='渠道拆分',current_url='',message='ok',completed_at='',downloaded_file=str(path))
    manager=JobManager(SimpleNamespace(run=export),settings=isolated_runtime)
    schedule=setup(manager,isolated_runtime)
    base=datetime(2026,10,27,10,30,tzinfo=timezone.utc)
    await schedule.tick(base)
    await finish(manager)
    await schedule.tick(base)
    assert schedule.runs[0]['status']=='waiting'
    assert calls[0]['created_range']=={'start':'2026-10-20 07:00:00','end':'2026-10-27 06:30:00'}
    restored=CutoffScheduler(manager,isolated_runtime.downloads_dir)
    await restored.tick(base+timedelta(minutes=29))
    assert len(calls)==1
    await restored.tick(base+timedelta(minutes=30))
    await finish(manager)
    await restored.tick(base+timedelta(minutes=31))
    await restored.tick(base+timedelta(minutes=31))
    assert calls[1]['created_range']=={'start':'2026-10-27 06:29:30','end':'2026-10-27 07:00:00'}
    assert restored.runs[0]['status']=='succeeded'
    assert restored.runs[0]['counts']['total']==2
    assert restored.file(restored.runs[0]['id']).is_file()


@pytest.mark.asyncio
async def test_missed_does_not_export(isolated_runtime):
    export=AsyncMock()
    manager=JobManager(SimpleNamespace(run=export),settings=isolated_runtime)
    schedule=setup(manager,isolated_runtime)
    await schedule.tick(datetime(2026,10,27,11,1,tzinfo=timezone.utc))
    assert schedule.runs[0]['status']=='missed'
    export.assert_not_called()


@pytest.mark.asyncio
async def test_busy_wait_and_pre_submission_retry(isolated_runtime):
    attempts=[]
    async def export(progress,**kwargs):
        attempts.append(kwargs)
        raise ValueError('failed before submitting')
    manager=JobManager(SimpleNamespace(run=export),settings=isolated_runtime)
    schedule=setup(manager,isolated_runtime)
    base=datetime(2026,10,27,10,30,tzinfo=timezone.utc)
    await manager._run_lock.acquire()
    await schedule.tick(base)
    assert not attempts and schedule.runs[0]['busy_notice']
    manager._run_lock.release()
    await schedule.tick(base)
    await finish(manager)
    await schedule.tick(base)
    assert schedule.runs[0]['status']=='failed'
    schedule.retry(schedule.runs[0]['id'])
    await schedule.tick(base)
    await finish(manager)
    assert len(attempts)==2


@pytest.mark.asyncio
async def test_uncertain_submit_blocks_retry(isolated_runtime):
    async def export(progress,**kwargs):
        await progress('export_checkpoint',json.dumps({'submitted':True}))
        raise ValueError('disconnected')
    manager=JobManager(SimpleNamespace(run=export),settings=isolated_runtime)
    schedule=setup(manager,isolated_runtime)
    base=datetime(2026,10,27,10,30,tzinfo=timezone.utc)
    await schedule.tick(base)
    await finish(manager)
    await schedule.tick(base)
    with pytest.raises(ValueError,match='身份未确认'): schedule.retry(schedule.runs[0]['id'])


def test_api_disabled_by_default_invalid_config_and_file(isolated_runtime):
    from app.main import app
    with TestClient(app) as client:
        assert client.get('/api/schedule').json()['config']['enabled'] is False
        assert client.put('/api/schedule',json={'cutoff_time':'25:00'}).status_code==422
        assert client.put('/api/schedule',json={'timezone':'not/a/zone'}).status_code==422
        assert client.get('/api/schedule/runs/missing/file').status_code==404
        assert client.put('/api/schedule',json={'enabled':False,'cutoff_time':'08:00'}).status_code==200
    with TestClient(app) as client:
        assert client.get('/api/schedule').json()['config']['cutoff_time']=='08:00'


def test_corrupt_schedule_is_not_overwritten(isolated_runtime):
    manager=JobManager(SimpleNamespace(),settings=isolated_runtime)
    path=manager.wave_records_dir/'cutoff-schedule.json'
    path.write_text('{broken')
    schedule=CutoffScheduler(manager,isolated_runtime.downloads_dir)
    assert schedule.error
    with pytest.raises(ValueError): schedule.configure(CutoffConfig())
    assert path.read_text()=='{broken'
