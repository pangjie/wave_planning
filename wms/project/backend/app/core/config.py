from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


PROJECT_ROOT = Path(
    os.getenv("WMS_PROJECT_ROOT", Path(__file__).resolve().parents[3])
).expanduser().resolve()


class SelectorConfig(BaseModel):
    page_export_button: str
    loading_mask: str
    export_dialog: str
    template_input: str
    template_dropdown: str
    template_option: str
    final_export_button: str
    toast: str
    task_center_trigger: str
    task_center_popover: str
    task_center_item: str
    task_center_download_button: str


class TimeoutConfig(BaseModel):
    navigation: int = Field(gt=0)
    login: int = Field(gt=0)
    dialog: int = Field(gt=0)
    action: int = Field(gt=0)
    result: int = Field(gt=0)
    task_completion: int = Field(gt=0)
    task_poll_interval: int = Field(gt=0)
    download: int = Field(gt=0)


class WaveSelectorConfig(BaseModel):
    pending_tabs: str
    wave_rows: str
    wave_pick_button: str
    picking_headers: str
    select_all_checkbox: str
    picking_rows: str
    confirm_buttons: str
    cutoff_dialog: str
    cutoff_confirm_buttons: str
    result_messages: str
    loading_mask: str
    pager_next_button: str
    pager_active_page: str


class WaveTimeoutConfig(BaseModel):
    navigation: int = Field(gt=0)
    login: int = Field(gt=0)
    action: int = Field(gt=0)
    picking_page: int = Field(gt=0)
    completion: int = Field(gt=0)


class WavePickingConfig(BaseModel):
    target_url: str
    pending_tab_text: str
    max_concurrent_waves: int = Field(ge=5, le=5)  # 生产安全要求固定为 5（代码另有运行时守卫）
    selectors: WaveSelectorConfig
    timeouts_ms: WaveTimeoutConfig


class WavePrintSelectorConfig(BaseModel):
    more_button: str
    print_summary_item: str
    reprint_dialog: str
    reprint_confirm_buttons: str
    print_template_container: str
    print_template_input: str
    template_dropdown: str
    template_option: str
    print_button: str
    loading_mask: str


class WavePrintTimeoutConfig(BaseModel):
    action: int = Field(gt=0)
    print_center: int = Field(gt=0)
    render: int = Field(gt=0)


class WavePrintingConfig(BaseModel):
    wave_tab_text: str
    template_name: str
    max_selected_waves: int = Field(gt=0, le=500)
    pdf_format: Literal["A4", "Letter"] = "Letter"
    selectors: WavePrintSelectorConfig
    timeouts_ms: WavePrintTimeoutConfig


class WaveGenerationSelectorConfig(BaseModel):
    outbound_search_component: str
    search_input: str
    advanced_filter_icon: str
    multi_search_textarea: str
    multi_search_button: str
    pagination_total: str
    select_all_checkbox: str
    generate_wave_button: str
    generate_by_selection_item: str
    wave_dialog: str
    sort_rule_rows: str
    sort_rule_label: str
    sort_rule_select: str
    sort_rule_add_btn: str
    wave_confirm_button: str
    result_text: str
    loading_mask: str


class WaveGenerationTimeoutConfig(BaseModel):
    navigation: int = Field(gt=0)
    login: int = Field(gt=0)
    action: int = Field(gt=0)
    search_result: int = Field(gt=0)
    dialog: int = Field(gt=0)
    wave_generation: int = Field(gt=0)


class WaveGenerationConfig(BaseModel):
    target_url: str
    pending_tab_text: str
    page_size_option: str
    multi_search_max_lines: int = Field(ge=1, le=700)
    wave_no_pattern: str
    search_verify_wait_ms: int = Field(default=4000, ge=0, le=60000)
    selectors: WaveGenerationSelectorConfig
    timeouts_ms: WaveGenerationTimeoutConfig


class AutomationConfig(BaseModel):
    target_url: str
    template_name: str
    required_template_fields: list[str]
    minimum_template_fields: int = Field(gt=0)
    task_filename_prefix: str
    selectors: SelectorConfig
    timeouts_ms: TimeoutConfig
    wave_picking: WavePickingConfig
    wave_printing: WavePrintingConfig
    wave_generation: WaveGenerationConfig


class Settings(BaseModel):
    automation_config_path: Path
    browser_profile_dir: Path
    downloads_dir: Path
    outputs_dir: Path
    headless: bool = False
    browser_channel: str | None = None

    @classmethod
    def from_environment(cls) -> "Settings":
        root = PROJECT_ROOT
        channel = os.getenv("WMS_BROWSER_CHANNEL", "chrome") or None
        return cls(
            automation_config_path=Path(
                os.getenv("WMS_AUTOMATION_CONFIG", root / "config" / "automation.json")
            ),
            browser_profile_dir=Path(
                os.getenv("WMS_BROWSER_PROFILE", root / "data" / "browser-profile")
            ),
            downloads_dir=Path(os.getenv("WMS_DOWNLOADS_DIR", root / "downloads")),
            outputs_dir=Path(os.getenv("WMS_OUTPUTS_DIR", root / "outputs")),
            headless=os.getenv("WMS_HEADLESS", "false").lower() in {"1", "true", "yes"},
            browser_channel=channel,
        )

    def load_automation(self) -> AutomationConfig:
        raw: dict[str, Any] = json.loads(self.automation_config_path.read_text("utf-8"))
        return AutomationConfig.model_validate(raw)


@lru_cache
def get_settings() -> Settings:
    return Settings.from_environment()
