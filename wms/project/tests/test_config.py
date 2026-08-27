from app.core.config import Settings


def test_automation_config_loads() -> None:
    settings = Settings.from_environment()
    config = settings.load_automation()

    assert config.target_url == "https://wms.xlwms.com/outbound/parcel"
    assert config.template_name == "渠道拆分"
    assert config.required_template_fields == ["订单品种类型", "物流承运商"]
    assert config.minimum_template_fields == 11
    assert config.wave_picking.target_url == "https://wms.xlwms.com/outbound/wave"
    assert config.wave_picking.max_concurrent_waves == 5
    assert config.wave_printing.template_name == "一件代发汇总拣货单"
    assert config.wave_printing.wave_tab_text == "全部"
    assert config.wave_printing.max_concurrent_waves == 5
    assert config.wave_printing.max_selected_waves == 100
    assert config.wave_printing.pdf_format == "Letter"
    assert "ak-dropdown-item" in config.wave_printing.selectors.print_summary_item
    assert "btn-next" in config.wave_picking.selectors.pager_next_button
    assert "rowid" not in config.wave_picking.selectors.wave_rows
    assert config.task_filename_prefix == "ParcelOutbound_"
    assert "dialog" in config.selectors.export_dialog
    assert "task-popover" in config.selectors.task_center_item
