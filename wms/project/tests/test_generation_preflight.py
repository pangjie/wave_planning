# 回归范围：整批生成前拒绝超限和重复订单，验证时不得先执行任何分段。
from unittest.mock import Mock
import pytest
from fastapi.testclient import TestClient
from app.services.job_plans import validate_generation_segments


@pytest.mark.parametrize('count', [700, 701])
def test_api_whole_batch_limit_before_create(app, monkeypatch, count):
    with TestClient(app) as client:
        manager=app.state.job_manager
        create=Mock(side_effect=AssertionError('must not start'))
        if count == 701:
            monkeypatch.setattr(manager,'create',create)
            response=client.post('/api/jobs',json={'mode':'generate_waves','confirm_production':True,'segments':[
                {'channel':'CBT','seg_name':'爆品1','order_nos':['SMALL']},
                {'channel':'USPS-H','seg_name':'单件paper-1','order_nos':[f'O{i}' for i in range(count)]}]})
            assert response.status_code==422
            assert '701' in response.json()['detail'] and 'USPS-H' in response.json()['detail']
            create.assert_not_called()
        else:
            validate_generation_segments([{'channel':'USPS-H','seg_name':'单件paper-1','order_nos':[f'O{i}' for i in range(count)]}],700)


def test_duplicate_order_across_segments_rejected(app, monkeypatch):
    with TestClient(app) as client:
        create=Mock(side_effect=AssertionError('must not start'))
        monkeypatch.setattr(app.state.job_manager,'create',create)
        response=client.post('/api/jobs',json={'mode':'generate_waves','confirm_production':True,'segments':[
            {'channel':channel,'seg_name':'单件paper-1','order_nos':['SAME']} for channel in ['USPS-H','普通']]})
        assert response.status_code==422
        assert '重复分配' in response.json()['detail']
        create.assert_not_called()
