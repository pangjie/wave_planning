# WMS 自动化控制台

一个基于 FastAPI、Playwright 的本地网页自动化控制台（控制台页面由波次规划工具单文件版提供），包含“导出所有订单”“生成波次”“打印选中波次”和“所有波次拣货”四个生产工作流。

## 导出所有订单

- 目标页面：`https://wms.xlwms.com/outbound/parcel`；
- 导出模板：`渠道拆分`，校验至少 12 个已选项目，并确认包含“订单品种类型”“物流承运商”“客户”；
- 保存位置：项目目录下的 `downloads/`（不再另存副本到用户下载目录）；
- 正式流程：

1. 打开 `https://wms.xlwms.com/outbound/parcel`；
2. 等待页面与数据加载完成；
3. 点击页面操作区的“导出”；
4. 将弹窗右上角模板校验为“渠道拆分”，等待 12 个已选项目（含新增“客户”）稳定加载；
5. 点击弹窗中的最终“导出”；
6. 对比导出前后的“任务中心”，识别新出现的 `ParcelOutbound_` 任务；
7. 等待该任务的下载按钮可用，再将文件保存到本地 `downloads/`。

## 生成波次

- 由波次规划工具控制台按分段提交：每个分段含渠道、分段名与出库单号清单；
- 后端逐段执行：强制并复核“1000条/页” → 多项精确搜索 → 核对搜索结果总数（以“共 X 条”为准，页签数字仅在“待处理数 == 共 X 条”后可信，支持部分订单已取消的降级判定；总数疑似残留上一次查询时自动重查一次）→ 全选 → 核对“已选 X 条 == 待处理数” → 按勾选数据生成波次 → 提取波次号；
- 每个分段只允许点击一次“确定”提交生成；某段失败则安全停止该段、恢复页面后继续后续分段，绝不遗漏或错分订单；
- 已生成波次的分段结果实时回报控制台（分段变绿），并持久化到 `data/wave-records.json`。回填必须同时匹配导入批次、计划版本与原提交订单集合；修改参数、勾选、排序或重新导入形成新计划时，不继承旧完成标记。
- 生成任务提交前保存九个工作表的完整快照到 `data/plans/<job-id>.json`；任务完成后从该快照填入已确认波次号，后续调整页面不改变旧任务导出。刷新后可恢复成功/部分完成任务的导出，无需重新建立波次。页面本身不会自动恢复上次导入的订单与勾选。
- 自动规划导出按任务只保存一份，保存重试不会增加副本；右上角手动导出仍按当前页面计划生成。旧版任务没有快照时仅保留日志及既有下载链接，不猜测回填或用当前计划代替导出。

## 打印选中波次

- 在控制台中每行输入一个波次号；空行和重复波次会自动忽略，一次最多处理 100 个不同波次（`wave_printing.max_selected_waves`）；
- 在波次管理的“全部”列表中逐页精确查找每个波次，只操作匹配 `rowid` 的右侧操作区；
- 单个登录会话内使用 5 个独立页面分批并行打印（`wave_printing.max_concurrent_waves` 固定为 5）；每路只监听自己打开的打印中心，避免页面串扰；
- 每路点击唯一的“更多”与“打印汇总拣货单”；若出现“当前波次已打印过拣货单，是否确认打印”，只在提示中的波次号与当前波次完全一致时点击“确定”，其它提示会被取消并停止流程；
- 进入打印中心后将模板校验为“一件代发汇总拣货单”，等待模板右侧唯一的“打印”按钮可用后再点击；
- 为避免自动化依赖 macOS 原生打印框坐标，程序会在本次任务的专用浏览器上下文中预先拦截 `window.print`，并在点击打印前再次确认；任务结束即关闭该上下文。随后提取唯一的静态 Pick List 预览（保留条码、移除脚本、导航与页面预览阴影），按逻辑页数与 US Letter 宽高渲染等效 PDF，不操作 Destination、Save 或文件保存弹窗；
- 每个波次 PDF 保存在项目内部 `outputs/` 目录；完成先后不影响结果，全部生成后使用 `qpdf` 严格按输入顺序合并；
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
- 点击被遮挡、等待控件可见超时、一般操作超时不视为已确认的网络错误；这类错误停止后续批次，保留当前批次完成日志，不自动重试。

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

需要 Python 3.11+（推荐 3.12；本轮回归使用 3.12.14）及本机 Google Chrome。
首次可用 `PYTHON_BIN=python3.12 ./scripts/setup.sh` 指定解释器。已有 `.venv` 会复用，
不会原地替换解释器；损坏或版本过旧时会报错，不会自动删除/重建。更新依赖前先正常停止服务。
安装脚本先检查解释器版本，安装后检查包依赖冲突；任一步失败都不报告安装成功。

```bash
./scripts/setup.sh
./scripts/start.sh start
```

默认只安装运行依赖。测试用 `./scripts/setup.sh --dev`；桌面构建清单见下节。
测试和构建清单引用同一份 `backend/requirements.txt`，不复制运行包版本。
不升级现有固定版本，也不自动卸载已经安装的测试包。另一台 Mac 的全新安装和桌面打包
仍需实机验收，当前机器测试通过不代表所有 Python/系统组合均已验证。

服务默认在后台运行，访问 [http://127.0.0.1:8000](http://127.0.0.1:8000)。启动脚本会自动
保存 PID、追加日志、检查端口占用并等待 `/api/health` 就绪，因此不需要再在命令外层添加
`nohup` 或 `&`。常用命令：

```bash
./scripts/start.sh start --ip 0.0.0.0 --port 8080
./scripts/start.sh status --port 8080
./scripts/start.sh restart --ip 0.0.0.0 --port 8080
./scripts/start.sh stop --port 8080
```

支持的选项为 `--ip`、`--port`、`--log` 和 `--pid-file`；相对日志及 PID 路径以项目根目录
为基准。默认日志为 `logs/service-PORT.log`，默认 PID 文件为 `data/service-PORT.pid`。
同目录还会生成 `service-PORT.pid.identity.json`，记录本次进程的完整启动命令、启动时间、
项目和端口。请将 `scripts/service_identity.py` 与启动脚本一起保留；停止和重启会核对
这些信息，等待退出后需要强制终止时还会再核对一次。身份缺失、损坏或不匹配时拒绝
自动停止，不会仅凭 `uvicorn app.main:app` 或端口子串判断。

**旧版升级注意：** 只有数字 PID、没有身份文件的旧服务不会被自动接管。请在更新前用
原启动方式正常停止旧服务，或先核对该进程再处理；不要删除活跃服务的 PID 文件来
强行启动。新版本成功停止后会清理本次 PID 和身份记录，不删除业务数据。

命令行参数优先于环境变量 `HOST` / `PORT`。旧式调用 `./scripts/start.sh 8001` 仍然可用，
等同于 `start --port 8001`。

绑定 `0.0.0.0` 会允许局域网设备访问当前没有登录认证的任务接口；只应在可信网络或已配置
防火墙访问限制时使用。仅本机使用时请保持默认的 `127.0.0.1`。

后端开发模式（--reload）：

```bash
./scripts/dev.sh
```

### 单机重复启动与退出

同一数据目录或同一专用浏览器配置只能由一个本项目服务占用，即使改用另一个端口也不能重复启动。服务会先取得本机文件锁，再读取和恢复任务；退出时先取消任务、等待浏览器收尾和结果保存，再释放占用。不同实例只有数据目录和浏览器配置均独立时才能同时运行。

锁由 macOS/Linux 操作系统维护。正常退出或进程结束后会释放；留下的 `.wms-service.lock`、`.wms-profile.lock` 文件不代表服务仍在运行，**不要删除锁文件来强行启动**。升级到包含该机制的版本时，应先正常停止旧服务再启动新服务；旧版本和手动指定同一 `--user-data-dir` 启动的 Chrome 不会遵守本项目的锁。

已确认生成的波次、已保存的订单文件或 PDF，不会因为普通关闭异常被改成未完成；日志会显示收尾警告。若生成波次后结果弹窗无法关闭，已确认波次保留，剩余分段明确标记为未执行并停止，不自动重跑。原本的操作失败和取消仍保持原状态。

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
`~/Library/Logs/WMS自动化控制台/service.log`。WMS 订单下载保存在上述 Application Support
目录的 `downloads/`，规划 Excel 与波次 PDF 保存在 `outputs/`；不会默认写入应用包或
`~/Downloads/`。已有 `WMS_DOWNLOADS_DIR`、`WMS_OUTPUTS_DIR` 环境变量可覆盖这些位置。
升级应用不会自动迁移或删除旧应用包中已有的文件，旧产物需自行核对和保留。

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

自动化 JSON 在服务启动时读取；请求数量限制与执行器使用同一份启动配置。修改文件后
需要重启服务才生效，运行中的任务不隐式切换配置。

可单独检查当前浏览器配置是否能启动（不打开 WMS、不使用登录会话）：

```bash
WMS_HEADLESS=true .venv/bin/python scripts/browser_smoke.py
```

诊断遵循 `WMS_BROWSER_CHANNEL` 和 `WMS_HEADLESS`，使用与自动化相同的启动参数，
但 profile、下载目录均为一次性的临时目录；成功显示 `browser-ok`。通道为空时测试
Playwright Chromium，自定义通道失败时不会换测 Chrome 来报告成功。默认未设置
`WMS_HEADLESS` 时遵循配置的有头模式；此检查只验证启动、离线页面与收尾，不证明 WMS
登录、导出或真实业务操作正常。

## API

- `POST /api/jobs`：创建任务，`mode` 取 `export` / `generate_waves` / `print_waves` / `pick_waves`，均需 `confirm_production: true`；`generate_waves` 需附 `segments`（渠道/分段名/出库单号清单）；
- `GET /api/jobs`：当天任务列表（最新在前）；
- `GET /api/jobs/{id}`：查询任务状态与事件；
- `POST /api/jobs/{id}/cancel`：取消任务；
- `GET /api/jobs/{id}/file`：下载导出任务的 `ParcelOutbound_*.xlsx`（仅限项目下载目录内文件，供规划工具自动导入）；
- `GET /api/jobs/{id}/merged`：下载打印任务合并后的 `Paper合并_*.pdf`；
- `GET /api/exports` / `POST /api/exports` / `GET /api/exports/{name}`：当天波次规划导出文件的清单、保存与下载；
- `GET /api/wave-records?batch_id=...&plan_id=...` / `POST /api/wave-records/clear?batch_id=...&plan_id=...`：仅读取/清理指定批次的指定计划。无参数读取仍可查看全部历史；无参数清理只清理旧版无身份记录，不删除新计划记录；
- `GET /api/jobs/{job_id}/plan`：读取提交时的计划快照（快照不放入每秒查询的任务响应）；
- `POST /api/jobs/{job_id}/planning-export`：保存该任务的规划 Excel，同任务重试返回同一文件；
- `GET /docs`：FastAPI 交互文档。

## 测试

先在停止服务的环境中运行 `./scripts/setup.sh --dev` 安装测试依赖；已有依赖无需重复安装。

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend .venv/bin/python -m pytest -p no:cacheprovider -q
```

测试自动隔离配置、任务记录、profile、下载、输出和 PID；默认禁止外部网络、现有本地服务和
真实 Playwright。启动脚本测试仅在随机回环端口启动临时健康检查应用，不启用业务接口，
无需停止当前服务。请用项目虚拟环境运行；系统须允许随机回环监听。

完整测试包含 `tests/test_audit_regressions.py`。在审计缺陷修复之前，其中的失败会使命令返回
非零；不使用 skip/xfail 掩盖，不代表已完成业务整改。

后台执行对象在任务真正结束后释放，包括失败和取消；取消期间的浏览器清理仍会等待完成。
这一收尾不会裁剪任务结果/事件或删除订单、Excel、PDF、计划快照和波次历史。
任务列表仍按既有规则显示最多 50 条，不能把列表上限理解成文件或内存记录的自动清理上限。

规划工具前端测试（Node + 临时无头 Chrome）见仓库根目录 `README.md`。
`scripts/run_full_auto.py` 仅转调完整仓库中的隔离模拟测试 `planner/test-wms-ui.js`，
不接受目标 URL、不连接现有服务、不执行真实 WMS 操作；缺少完整仓库或 Node.js 会明确退出。
