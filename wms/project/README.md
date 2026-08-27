# WMS 自动化控制台

一个基于 FastAPI、Playwright 的本地网页自动化控制台（控制台页面由波次规划工具单文件版提供），包含“导出所有订单”“生成波次”“打印选中波次”和“所有波次拣货”四个生产工作流。

## 导出所有订单

- 目标页面：`https://wms.xlwms.com/outbound/parcel`；
- 导出模板：`渠道拆分`；
- 保存位置：项目目录下的 `downloads/`（不再另存副本到用户下载目录）；
- 正式流程：

1. 打开 `https://wms.xlwms.com/outbound/parcel`；
2. 等待页面与数据加载完成；
3. 点击页面操作区的“导出”；
4. 将弹窗右上角模板校验为“渠道拆分”；
5. 点击弹窗中的最终“导出”；
6. 对比导出前后的“任务中心”，识别新出现的 `ParcelOutbound_` 任务；
7. 等待该任务的下载按钮可用，再将文件保存到本地 `downloads/`。

## 生成波次

- 由波次规划工具控制台按分段提交：每个分段含渠道、分段名与出库单号清单；
- 后端逐段执行：强制并复核“1000条/页” → 多项精确搜索 → 核对搜索结果总数（以“共 X 条”为准，页签数字仅在“待处理数 == 共 X 条”后可信，支持部分订单已取消的降级判定；总数疑似残留上一次查询时自动重查一次）→ 全选 → 核对“已选 X 条 == 待处理数” → 按勾选数据生成波次 → 提取波次号；
- 每个分段只允许点击一次“确定”提交生成；某段失败则安全停止该段、恢复页面后继续后续分段，绝不遗漏或错分订单；
- 已生成波次的分段结果实时回报控制台（分段变绿），并持久化到 `data/wave-records.json` 供页面刷新后回填。

## 打印选中波次

- 在控制台中每行输入一个波次号；空行和重复波次会自动忽略，一次最多处理 100 个不同波次（`wave_printing.max_selected_waves`）；
- 在波次管理的“全部”列表中逐页精确查找每个波次，只操作匹配 `rowid` 的右侧操作区；
- 依次点击唯一的“更多”与“打印汇总拣货单”；若出现“当前波次已打印过拣货单，是否确认打印”，只在提示中的波次号与当前波次完全一致时点击“确定”，其它提示会被取消并停止流程；
- 进入打印中心后将模板校验为“一件代发汇总拣货单”，等待模板右侧唯一的“打印”按钮可用后再点击；
- 为避免自动化依赖 macOS 原生打印框坐标，程序会在本次任务的专用浏览器上下文中预先拦截 `window.print`，并在点击打印前再次确认；任务结束即关闭该上下文。随后提取唯一的静态 Pick List 预览（保留条码、移除脚本、导航与页面预览阴影），按逻辑页数与 US Letter 宽高渲染等效 PDF，不操作 Destination、Save 或文件保存弹窗；
- 每个波次 PDF 保存在项目内部 `outputs/` 目录；全部生成后使用 `qpdf` 按输入顺序合并；
- 合并结果固定命名为 `Paper合并_YYYY-MM-DD.pdf`（项目内部 `outputs/` 目录）；任务完成后控制台日志提供合并文档下载链接，同名同日旧文件会由本次完整结果替换。
- 每张逻辑拣货单会按实际宽高等比缩放到 US Letter；浏览器生成单页 PDF 后，程序再读取该页实际绘制的文字、黑色表格线和条码边界，逐页执行最终居中校正，避免网页隐藏容器或空白区域干扰定位。
- 某个输入波次在“全部”列表中不可见时，会记录并跳过该波次，继续处理其余输入；只要至少生成一个 PDF 就会合并，并将任务标记为“部分完成”。其它定位歧义或页面结构异常仍会立即停止。

该功能要求系统能够执行 `qpdf`。当前 macOS 可通过 `brew install qpdf` 安装；程序也会自动识别 Homebrew 的常用安装路径。浏览器直接生成 PDF 若在某个有头 Chrome 版本中不可用，任务会安全停止并提示改用无头模式，不会转而盲点系统打印窗口。

## 所有波次拣货

- 目标页面：`https://wms.xlwms.com/outbound/wave`；
- 可在控制台输入指定波次号，每行一个，最多 500 个；输入框有内容时，只处理输入波次中当前仍处于“待拣货”的波次；不在待拣货列表中的输入会被跳过并列入未完成结果；
- 输入框留空时，启动任务后遍历全部分页，锁定当时所有“待拣货”波次；
- 并发规则：每批最多 5 个独立页面错峰并发，分批处理直至快照中的波次完成；
- 每个波次会打开拣货页、全选 SKU、点击确认，并处理可识别的截单提醒；
- 可识别的网络错误会被直接忽略，不中断主流程、不触发重试，也不会针对异常波次单独复查。常规流程结束后只重新读取一次完整待拣货列表：指定模式只核对本次匹配并锁定的波次，留空模式核对任务启动时的全部波次快照；仍在列表中的目标波次会被标记为“部分完成”并报告波次号。

## 安全设计

- 网页不提供额外确认复选框；点击主操作按钮即会启动对应生产任务。API 仍要求请求中包含 `confirm_production: true`。
- 同一时间只允许运行一个浏览器任务；网页刷新会恢复当前任务，后端也会拒绝重复提交，避免同一生产操作被排队执行多次。
- 只下载导出前快照中不存在的新出库任务，不会误下历史文件。
- 导出未完成时持续轮询任务中心，默认最多等待 10 分钟。
- 每次任务可选择“有头模式”或“无头模式”；首次登录建议使用有头模式。
- 自动化只操作 `config/automation.json` 中声明的页面和控件。
- 任何关键按钮或模板选项不唯一时立即停止，不猜测、不按位置盲点。
- 打印工作流只接受字母、数字、下划线和连字符组成的波次号，阻止波次号被当作文件路径使用；打印预览必须能唯一定位，PDF 至少通过文件头、最小体积和 `qpdf` 合并检查；单个 PDF 通过临时文件完整生成后再原子替换正式文件。
- 任务历史（含失败终态）按天持久化到 `data/jobs.json`（原子写入），服务重启后页面可恢复当天任务日志与可下载链接。

## 控制台体验

- 页面启动时读取后端最近任务；若任务仍在运行，刷新网页后会自动恢复日志轮询。
- 临时状态连接中断时自动重试，不会因为一次请求失败而让执行记录停在旧位置。
- 执行记录始终跟随最新日志，同时保留完整滚动记录与最终结果。
- 中文标题使用 Safari 可稳定渲染的系统字体和标准字重；页面支持键盘焦点、减少动态效果偏好以及窄屏布局。
- 登录说明默认收起，任务设置区只保留操作所需信息。

本项目依赖本机 Chrome 登录会话、Playwright 和本地下载目录，不适合把前端单独发布为公网静态站点；部署时应将 FastAPI、前端静态文件和浏览器运行环境作为同一套受控服务交付。

## 控制台页面（波次规划工具）

本服务托管的控制台页面已由「波次规划工具」单文件版接管（`frontend/dist/index.html`）。
波次规划工具内置 WMS 联动区：「导出订单」「生成波次」「打印波次」「批量拣货」四个
工作流直接在规划工具左侧操作栏发起，任务状态与日志显示在页面底部面板；导出订单成功
后会自动把 `ParcelOutbound_*.xlsx` 导入规划分析。以 `file://` 双击打开同一 HTML 时
联动区自动隐藏，仅保留离线规划功能。

页面部署方式：在规划工具工程目录 `planner/` 运行 `python3 build.py`，会自动把页面
同步写入本项目的 `frontend/dist/index.html`。

## 启动

```bash
./scripts/setup.sh
./scripts/start.sh
```

访问 [http://127.0.0.1:8000](http://127.0.0.1:8000)。
如需临时使用其他端口，可运行 `./scripts/start.sh 8001`。
后端开发模式（--reload）：

```bash
./scripts/dev.sh
```

## macOS 测试应用

Apple Silicon Mac 可构建一个可双击运行的本机测试应用。该应用包含前端、后端、
Python 依赖与 Playwright 驱动，仍调用本机已安装的 Google Chrome 和 `qpdf`：

```bash
.venv/bin/python -m pip install -r desktop/requirements-build.txt
./scripts/build_macos_app.sh
open "dist/WMS自动化控制台.app"
```

构建脚本会直接打包 `frontend/dist/index.html`（即波次规划工具控制台页面），构建前请先
在 `planner/` 运行 `python3 build.py` 完成页面部署。

应用会在后台监听 `http://127.0.0.1:8000` 并自动打开默认浏览器。再次双击会复用现有
服务。运行数据位于 `~/Library/Application Support/WMS自动化控制台/`，服务日志位于
`~/Library/Logs/WMS自动化控制台/service.log`，最终文件仍写入 `~/Downloads/`。

当前产物为本机临时签名的 arm64 测试版；分发给其他 Mac 前仍需开发者签名、公证和
独立机器兼容性验证。

## 登录会话

应用使用 `data/browser-profile/` 下的独立 Chrome 持久化配置。首次运行会打开可见浏览器；如出现登录页，请在该窗口中登录，后续任务会复用此会话。默认使用本机 Chrome，因此无需另行下载浏览器。

Codex 内置浏览器的登录状态由 Codex 管理，不能安全地直接复制给独立的 Python 进程。本项目因此不读取或复制该浏览器的 Cookie，也不会在代码中保存账号密码。

## 结构

```text
backend/app/
  api/routes.py              # HTTP 接口与生产确认校验
  automation/common.py       # 浏览器会话与公共自动化辅助（加载等待/输入轮询/波次号清洗）
  automation/wms_export.py   # 订单导出主流程
  automation/export_task_center.py # 任务中心识别、下载与复制
  automation/wms_wave_generate.py  # 生成波次：搜索核对、全选、按勾选数据生成
  automation/wms_wave_pick.py # 波次并发、提交和最终统一对账
  automation/wave_pending.py # 待拣货列表分页、定位和全量读取
  automation/pdf_centering.py  # 按 PDF 实际绘制对象逐页执行最终居中校正
  automation/wms_wave_print.py # 选中波次打印、单文件保存与 qpdf 合并
  core/config.py             # 路径、环境变量、JSON 配置
  services/job_manager.py    # 任务队列、状态、取消、并发保护与当天持久化
  services/wave_records.py   # 分段波次号持久记录（data/wave-records.json）
config/automation.json       # URL、模板、选择器、超时集中配置
tests/                       # API、配置、任务状态与各工作流测试
```

完整的架构说明与调用关系见仓库根目录的 `代码架构说明.md`。

页面结构变化时，通常只需调整 `config/automation.json`。增加新自动化任务时，可在 `backend/app/automation/` 新建工作流，并在任务服务/API 中注册，现有任务状态模型可继续复用。

## 常用配置

环境变量：

- `WMS_BROWSER_PROFILE`：浏览器会话目录；
- `WMS_DOWNLOADS_DIR`：浏览器下载目录；
- `WMS_HEADLESS=true`：无头运行（仅建议已稳定登录后使用）；
- `WMS_BROWSER_CHANNEL=chrome`：浏览器通道，默认使用本机 Chrome；设为空字符串时使用 Playwright Chromium；
- `WMS_AUTOMATION_CONFIG`：自定义自动化 JSON 路径；
- `WMS_OUTPUTS_DIR`：波次 PDF 与波次规划导出目录。

## API

- `POST /api/jobs`：创建任务，`mode` 取 `export` / `generate_waves` / `print_waves` / `pick_waves`，均需 `confirm_production: true`；`generate_waves` 需附 `segments`（渠道/分段名/出库单号清单）；
- `GET /api/jobs`：当天任务列表（最新在前）；
- `GET /api/jobs/{id}`：查询任务状态与事件；
- `POST /api/jobs/{id}/cancel`：取消任务；
- `GET /api/jobs/{id}/file`：下载导出任务的 `ParcelOutbound_*.xlsx`（仅限项目下载目录内文件，供规划工具自动导入）；
- `GET /api/jobs/{id}/merged`：下载打印任务合并后的 `Paper合并_*.pdf`；
- `GET /api/exports` / `POST /api/exports` / `GET /api/exports/{name}`：当天波次规划导出文件的清单、保存与下载；
- `GET /api/wave-records` / `POST /api/wave-records/clear`：分段波次记录的读取与清空；
- `GET /docs`：FastAPI 交互文档。

## 测试

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend .venv/bin/python -m pytest -p no:cacheprovider -q
```

规划工具前端测试（Node + Chrome，`test-wms-ui` 需要 8000 端口空闲）见仓库根目录 `README.md`。
