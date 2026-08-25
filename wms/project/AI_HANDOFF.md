# WMS 自动化控制台：项目详述与 AI 接手指南

> 文档快照日期：2026-08-15  
> 适用代码：随本文档一起打包的当前版本  
> 主要技术：Python 3.11+、FastAPI、Playwright、Vue 3、Vite、qpdf、pypdf、pdfplumber  
> 运行平台：当前正式部署方案为 macOS 本地服务

## 1. 阅读目的

本文档面向准备理解、维护、扩展或部署本项目的人类开发者与 AI。它回答以下问题：

- 项目目前能做什么，不能做什么；
- 前端、API、任务管理和浏览器自动化如何协作；
- 哪些代码会对生产 WMS 产生真实影响；
- 页面变化、功能扩展和故障诊断应从哪里开始；
- 如何在不携带 Cookie、账号或生产数据的情况下部署到另一台 Mac；
- AI 在接手时必须遵守哪些安全边界。

建议新接手者按以下顺序阅读：

1. 本文件 `AI_HANDOFF.md`；
2. `README.md`；
3. `PROJECT_STRUCTURE.txt`；
4. `config/automation.json`；
5. `backend/app/services/job_manager.py`；
6. 与目标功能同名的 `backend/app/automation/*.py`；
7. 对应的 `tests/test_*.py`；
8. `frontend/src/App.vue`。

## 2. 项目定位

这是一个运行在用户本机的 WMS 网页自动化控制台。FastAPI 提供任务 API 并托管波次规划工具单文件版页面；Playwright 使用独立、持久化的 Chrome profile 打开 `wms.xlwms.com`，复用该设备上由用户本人完成的登录会话。

当前有三个工作流：

| 模式 | 控制台名称 | API `mode` | 生产影响 |
| --- | --- | --- | --- |
| 订单导出 | 全量分析 | `export` | 提交一次正式导出并下载结果 |
| 生成波次 | 生成波次 | `generate_waves` | 按分段搜索出库单号并提交生成波次（订单移出待处理） |
| 波次打印 | 打印选中波次 | `print_waves` | 为明确输入的波次生成拣货单 PDF |
| 波次拣货 | 所有波次拣货 | `pick_waves` | 对目标波次全选 SKU 并确认拣货 |

项目不是多租户 SaaS，也不是无后端静态网页。每台设备应单独安装服务，并使用自己的浏览器 profile 和 WMS 账号。不要在不同用户之间复制 profile 或 Cookie。

## 3. 当前功能的精确定义

### 3.1 导出所有订单

目标页：`https://wms.xlwms.com/outbound/parcel`

流程：

1. 打开出库订单页并等待登录、页面数据及加载遮罩稳定；
2. 在点击正式导出前读取右上角任务中心，保存历史快照；
3. 打开导出弹窗；
4. 确认模板值为“渠道拆分”；如果不是，则通过模板选择控件切换；
5. 等待模板字段连续两次稳定，并确认至少 11 个字段，且包含“订单品种类型”和“物流承运商”；
6. 点击弹窗中唯一且可用的最终“导出”按钮；
7. 对比任务中心前后列表，只识别本次新增且名称以 `ParcelOutbound_` 开头的任务；
8. 最长等待 10 分钟，直到下载按钮可用；
9. 下载保存到项目下载目录（`downloads/`）；不再复制副本到用户下载目录。

关键安全性质：不会直接选择旧的任务中心记录；模板名正确但关键字段未实际加载完整时也不会提交导出。

### 3.2 打印选中波次

目标页：`https://wms.xlwms.com/outbound/wave`，使用“全部”子页签。

输入规则：

- 每行一个波次号；
- 忽略空行，按首次出现顺序去重；
- 只允许字母、数字、下划线和连字符；
- 至少 1 个，最多 100 个。

单波次流程：

1. 逐页精确查找与波次号匹配的 `rowid`；
2. 点击该行唯一可见的“更多”；
3. 点击“打印汇总拣货单”；
4. 如果出现“已打印过拣货单”提示，只有提示中波次号与当前目标完全一致时才确认；
5. 进入打印中心，确认模板为“一件代发汇总拣货单”；
6. 点击模板区域右侧唯一可用的“打印”按钮；
7. 拦截网页打印请求，捕获静态 Pick List 预览；
8. 清理脚本、导航和预览阴影，按 US Letter 渲染 PDF；
9. 使用 PDF 中真实文字、表格线和条码对象的边界进行逐页居中；
10. 以临时文件完整生成并校验后，原子保存到项目内部 `outputs/<波次号>.pdf`。

所有可生成的单波次 PDF 完成后，使用 `qpdf` 按输入顺序合并为项目内部 `outputs/Paper合并_YYYY-MM-DD.pdf`，并通过 `GET /api/jobs/{id}/merged` 供控制台日志提供下载链接。

输入波次不在“全部”列表时会被跳过并进入 `failed_wave_nos`；只要至少有一个单文件成功，仍会生成合并文件并把任务标记为 `partial`。页面歧义、模板异常或捕获不到可信打印内容时会安全停止。

### 3.3 所有波次拣货

目标页：`https://wms.xlwms.com/outbound/wave`，使用“待拣货”子页签。

该功能有两种范围模式：

- 输入框有波次号：最多 500 个；遍历当前全部待拣货分页后，只处理输入列表中仍处于待拣货状态的波次；
- 输入框为空：锁定任务启动时全部分页中的所有待拣货波次。

输入同样会去空行、去重并校验安全字符。指定但不在任务启动快照中的波次不会触发任何拣货点击，会记录为不可用和未完成。

执行方式：

1. 一次性读取待拣货列表全部分页，冻结本次范围；
2. 指定模式按用户输入顺序筛选快照；全量模式保留快照顺序；
3. 每批最多启动 5 个独立页面并发处理；
4. 每个页面定位一个波次，点击“拣货”，等待 SKU 表格；
5. 点击 SKU 左侧唯一全选框；
6. 等待唯一可用的“确认/Confirm”按钮并点击；
7. 只确认可识别的截单提醒；
8. 等待明确的成功、完成或失败消息；
9. 所有常规批次结束后，只读取一次完整待拣货列表，检查本次锁定的目标是否仍在其中。

并发数在配置和 Python 中双重限制为 5。可识别的网络错误会被记录并忽略，不中断后续批次、不重试，也不对异常波次做定向复查；最终只依靠统一列表检查判断目标是否消失。非网络错误会停止后续批次，以免在页面结构异常时扩大生产影响。

## 4. 总体架构

```text
浏览器中的波次规划工具控制台
        │ HTTP / JSON，1 秒轮询
        ▼
FastAPI 路由层 (api/routes.py)
        │ 校验 mode、浏览器模式、波次号、confirm_production
        ▼
JobManager (services/job_manager.py)
        │ 内存任务、事件日志、单任务保护、取消
        ├──────── export ────────► WmsExportAutomation
        ├──────── print_waves ───► WmsWavePrintAutomation
        └──────── pick_waves ────► WmsWavePickAutomation
                                      │
                                      ▼
                            Playwright 持久化 Chrome 上下文
                                      │
                                      ▼
                               生产 WMS 网页
```

依赖方向应保持为：

```text
API → 服务层 → 工作流编排 → 页面组件/共享基础设施
```

自动化底层模块不应反向导入 API 或服务层。

## 5. 关键目录与职责

```text
project/
├── backend/
│   ├── requirements.txt
│   └── app/
│       ├── main.py                       # FastAPI 组装、lifespan、静态前端托管
│       ├── api/routes.py                 # 请求校验和任务 API
│       ├── core/config.py                # 环境变量、Pydantic 配置模型
│       ├── services/job_manager.py       # 任务状态机和全局单任务保护
│       └── automation/
│           ├── common.py                 # 持久化 Chrome 上下文、公共异常和进度回调
│           ├── wms_export.py             # 订单导出编排
│           ├── export_task_center.py      # 任务中心快照、轮询、下载和复制
│           ├── wave_pending.py            # 波次分页读取、精确定位、结束对账
│           ├── wms_wave_pick.py           # 指定/全量波次拣货及五并发批次
│           ├── wms_wave_print.py          # 波次打印、预览捕获、PDF 保存与合并
│           └── pdf_centering.py           # PDF 可见对象边界计算与逐页居中
├── frontend/
│   ├── src/App.vue                       # 工作流输入、任务恢复、轮询、日志和结果
│   ├── src/api.js                        # fetch 封装
│   ├── src/style.css                     # 控制台样式
│   ├── public/favicon.svg
│   └── dist/                             # FastAPI 实际提供的构建产物
├── config/automation.json                # URL、模板、选择器、超时、并发与纸张配置
├── tests/                                # 纯本地自动化单元/API 测试
├── scripts/                              # 源码环境安装、开发、启动和应用构建
├── desktop/                              # PyInstaller macOS 测试应用入口与 spec
├── README.md
├── PROJECT_STRUCTURE.txt
└── AI_HANDOFF.md
```

运行时生成且不属于源码的目录：

- `.venv/`：Python 虚拟环境；
- `frontend/node_modules/`、`.pnpm-store/`：前端依赖缓存；
- `data/browser-profile/`：Chrome 登录会话，敏感；
- `downloads/`：订单导出文件；
- `tmp/`、`work/`、`outputs/`：调试或临时产物；
- `.pytest_cache/`、`__pycache__/`；
- `dist/`：旧桌面应用构建产物，不等同于 `frontend/dist/`。

## 6. 后端应用生命周期

`backend/app/main.py` 在 FastAPI lifespan 中：

1. 调用 `get_settings()` 解析环境；
2. 读取并校验 `config/automation.json`；
3. 创建三个工作流实例；
4. 将它们注入同一个 `JobManager`；
5. 把配置和任务管理器保存到 `app.state`。

API 路由注册在静态前端 catch-all 之前。若 `frontend/dist/index.html` 存在（由 planner/build.py 部署），其它非 API 路径返回该页面。

## 7. API 合约

### 7.1 创建任务

`POST /api/jobs`

通用请求：

```json
{
  "mode": "export | print_waves | pick_waves",
  "browser_mode": "headed | headless",
  "confirm_production": true,
  "wave_nos": []
}
```

规则：

- `confirm_production` 必须为 `true`；前端没有额外复选框，而是在点击按钮时固定发送该值；
- `export` 会清空 `wave_nos`；
- `print_waves` 要求 1–100 个合法波次号；
- `pick_waves` 允许 0–500 个；空数组代表处理全部待拣货波次；
- 同一时刻已有 `queued` 或 `running` 任务时返回 HTTP 409；
- 成功创建返回 HTTP 202。

示例：

```json
{"mode":"export","browser_mode":"headed","confirm_production":true}
```

```json
{"mode":"print_waves","browser_mode":"headless","confirm_production":true,"wave_nos":["W001","W002"]}
```

```json
{"mode":"pick_waves","browser_mode":"headed","confirm_production":true,"wave_nos":["W003","W001"]}
```

### 7.2 查询与取消

- `GET /api/health` → `{"status":"ok"}`；
- `GET /api/config` → 非敏感公共配置摘要；
- `GET /api/jobs` → 最近 50 条内存任务；
- `GET /api/jobs/{id}` → 单任务状态；
- `POST /api/jobs/{id}/cancel` → 取消活动任务。

### 7.3 任务状态

```text
queued → running → succeeded
                 ├→ partial
                 ├→ failed
                 └→ cancelled
```

- `succeeded`：结果没有失败波次；
- `partial`：工作流返回了非空 `failed_wave_nos`；
- `failed`：抛出异常；
- `cancelled`：用户取消或任务协程收到取消。

`JobManager` 当前只在内存中保存状态；后端重启后任务历史丢失，中断的生产任务不会自动重放。

### 7.4 结果结构

三类结果都包含 `mode`、`current_url`、`message`、`completed_at`。此外：

- 导出结果：`template`、`task_filename`、`downloaded_file`、`downloaded_copy`；
- 打印结果：`wave_nos`、`failed_wave_nos`、`warnings`、`printed_files`、`merged_file`；
- 拣货结果：`wave_nos`、`failed_wave_nos`、`warnings`、`wave_count`、`sku_rows`。

## 8. 前端行为

`frontend/src/App.vue` 是单页控制台：

- 三个工作流共用一个任务提交区；
- 打印和拣货共用多行波次输入；
- 打印输入不能为空，拣货输入可为空；
- 输入会在前端先去空、去重和校验，后端会再次独立校验；
- 有头/无头模式按任务传递，不修改全局浏览器设置；
- 页面加载时读取最近任务；活动任务会恢复轮询；
- 活动任务默认每秒刷新一次，连接错误时 2.5 秒后重试；
- 执行日志自动滚动到最新一条；
- 一个任务活动时禁用工作流、输入和浏览器模式切换。

后端变更后必须重启服务；页面变更后运行 planner/build.py 重新构建并刷新页面。

## 9. 配置边界

`config/automation.json` 使用 Pydantic 模型启动时校验，主要包含：

- 订单页 URL、模板名、关键字段、任务文件名前缀；
- 导出页、弹窗、任务中心的选择器；
- 导航、登录、操作、任务轮询和下载超时；
- 波次页 URL、子页签名称、并发数；
- 拣货表格、按钮、分页、提醒和结果消息选择器；
- 打印模板、最大波次数、纸张格式、打印中心选择器。

页面 CSS 结构或文案小幅变化时，优先修改 JSON 选择器和配置。交互顺序、错误策略、结果结构或任务类型变化时修改 Python。不要为了让自动化“继续跑”而把选择器改成过宽的全局匹配。

当前关键配置值：

| 项目 | 当前值 |
| --- | --- |
| 导出模板 | 渠道拆分 |
| 导出关键字段 | 订单品种类型、物流承运商 |
| 导出最少字段数 | 11 |
| 导出任务最长等待 | 600000 ms |
| 波次拣货并发 | 5 |
| 指定拣货最大波次数 | 500（API/前端限制） |
| 打印最大波次数 | 100 |
| 打印模板 | 一件代发汇总拣货单 |
| PDF 纸张 | Letter |

注意：`wms_wave_pick.py` 还要求并发值严格等于 5；仅改 JSON 为其它数字会触发安全错误。

## 10. 环境变量与文件位置

源码直接运行时支持：

| 变量 | 含义 | 默认值 |
| --- | --- | --- |
| `WMS_PROJECT_ROOT` | 项目根目录 | 根据 `config.py` 推导 |
| `WMS_AUTOMATION_CONFIG` | 自动化 JSON | `<root>/config/automation.json` |
| `WMS_BROWSER_PROFILE` | 持久化 Chrome profile | `<root>/data/browser-profile` |
| `WMS_DOWNLOADS_DIR` | 项目下载目录 | `<root>/downloads` |
| `WMS_SECONDARY_DOWNLOADS_DIR` | 用户可见副本目录（历史兼容，已停用） | 源码默认 `$HOME/Downloads` |
| `WMS_HEADLESS` | 环境默认无头模式 | `false` |
| `WMS_BROWSER_CHANNEL` | Playwright 浏览器通道 | `chrome` |
| `WMS_FRONTEND_DIST` | FastAPI 静态前端目录 | `<root>/frontend/dist` |

源码默认 `$HOME/Downloads`。换用户直接从源码运行时可显式设置 `WMS_SECONDARY_DOWNLOADS_DIR="$HOME/Downloads"`。正式 macOS 部署脚本已经自动使用 `$HOME/Downloads`。

## 11. 浏览器会话与账号模型

`common.open_browser_context()` 使用 Playwright `launch_persistent_context`：

- profile 是专用目录，不使用用户日常 Chrome 的默认 profile；
- 首次建议有头运行，在自动打开的 Chrome 中由用户手动登录；
- 之后有头和无头任务复用同一 profile；
- 每个任务结束会关闭其浏览器上下文；
- `JobManager` 的全局任务限制也避免两个任务争用同一 profile。

部署到多人、多设备环境时的正确模型是“一台设备/一个 macOS 用户/一份服务实例/一个独立 profile”。如果同一主机上要运行多个 WMS 账号，必须为每个实例配置不同端口、service home 和 browser profile，并额外评估资源与生产风险；当前安装器没有提供一键多实例功能。

## 12. 启动、开发与测试

### 12.1 源码环境

```bash
./scripts/setup.sh
./scripts/dev.sh
```



单端口运行：

```bash
./scripts/start.sh
```

默认地址：`http://127.0.0.1:8000/`。

### 12.2 纯本地验证

```bash
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend \
  .venv/bin/python -m pytest -p no:cacheprovider

cd planner
python3 build.py
```

当前快照共有 48 项后端测试。它们使用 mock、临时目录和 FastAPI TestClient，不应连接生产 WMS。

### 12.3 不应自动执行的测试

`scripts/browser_smoke.py` 和任何真实网页操作都可能使用生产登录会话。除非用户明确给出目标、波次号和允许的动作，否则 AI 不得为了“验证”而运行真实导出、打印或拣货任务。

## 13. macOS 部署包

部署包包含已构建前端、Python 后端、运行依赖清单、配置、安装/管理/卸载脚本和本文档。安装器会：

1. 检查 macOS 与 Python 3.11+；
2. 安装版本到 `~/Library/Application Support/WMSAutomationService/releases/<VERSION>/`；
3. 将 `current` 符号链接指向新版本；
4. 创建或复用独立虚拟环境；
5. 安装 Python 运行依赖；
6. 注册用户级 LaunchAgent `com.jp.wms-automation`；
7. 只监听 `127.0.0.1:8000`；
8. 等待健康检查成功后打开控制台。

登录资料和下载数据位于 release 之外，因此安装新版会保留它们。服务异常退出后由 launchd 恢复，但不会自动重放任务。

外部依赖：

- Python 3.11+，推荐 3.12；
- Google Chrome；
- `qpdf`（打印合并必需）；
- 首次安装 Python 包时可访问网络。

在源码接手包中，可从 `deployment-tools/` 直接重建发布物；脚本会自动识别相邻的
`project/`，无需保留原开发机路径：

```bash
cd deployment-tools
./scripts/build_deployment_package.sh
./scripts/build_handoff_package.sh
```

也可设置 `WMS_SOURCE_PROJECT=/absolute/path/to/project` 指向其它源码副本。

## 14. 测试应用与正式部署的区别

`desktop/` 和 `scripts/build_macos_app.sh` 用于 PyInstaller `.app` 测试版本。它不是“无后端应用”：FastAPI 和 Playwright 被打进应用，但仍在本机启动后端服务。当前更适合跨机器交付的是 LaunchAgent 部署包，因为它有清晰的安装、升级、日志和保活机制。

## 15. 安全不变量

维护时不得无意破坏以下约束：

1. 创建生产任务必须有 `confirm_production: true`；
2. 同时只能有一个活动任务；
3. 导出前必须确认模板名、最少字段数和两个关键字段；
4. 导出只下载快照后新出现且前缀匹配的任务；
5. 页面关键目标必须唯一且可见/可用；歧义时停止，不按坐标猜测；
6. 波次号必须通过安全字符校验；
7. 指定拣货只可操作输入列表与待拣货快照的交集；
8. 全量拣货只可操作任务启动快照，不能在执行中不断吸收新波次；
9. 拣货最大并发保持 5；
10. 网络错误不重试生产提交；
11. 只自动确认明确识别的截单或当前波次重打提示；
12. 生成波次必须在搜索结果与目标出库单号完全一致后才会全选提交；每个分段只提交一次；波次号回填「波次表」对应分段行；
13. PDF 必须先完整生成、校验，再替换正式文件；
13. Cookie、账号、browser profile、下载文件和日志不得进入源码包；
14. 服务重启不得自动恢复或重放未完成生产任务。

## 16. 常见修改入口

### WMS 页面选择器变化

1. 只读检查目标页面 DOM；
2. 优先更新 `config/automation.json`；
3. 保持选择器尽可能限定到目标弹窗、表格或模板区域；
4. 更新 `tests/test_config.py` 或工作流测试；
5. 跑完整测试和前端 build；
6. 真实生产验证必须获得明确授权，且使用最小范围。

### 增加新工作流

1. 在 `backend/app/automation/` 建立独立编排文件和结果 dataclass；
2. 在 `automation/__init__.py` 导出公开类型；
3. 扩展 `RunMode`、`CreateJobRequest` 与 `JobManager._execute()`；
4. 在 `main.py` 注入实例；
5. 在 `App.vue` 增加输入与状态展示；
6. 添加 API、任务管理器和工作流单元测试；
7. 更新 README、PROJECT_STRUCTURE 和本文档。

### 修改任务结果

结果必须保持 dataclass 可由 `asdict()` 转换，字段类型需兼容 `JobRecord.result`。若增加嵌套对象，应同步放宽 Pydantic 类型与前端展示逻辑。

### 修改并发或错误策略

先阅读 `wms_wave_pick.py` 的批次、`asyncio.gather(return_exceptions=True)`、网络错误识别和最终统一检查。此处直接影响生产重复提交风险，不能只改数字或删除异常分支。

## 17. 已知限制与技术债

- 任务与日志仅在内存中，服务重启后历史消失；
- 没有本地控制台账号体系，安全边界依赖仅监听 loopback 和操作系统用户会话；
- 自动化与生产 DOM、中文文案和 Element/VXE Table 结构耦合；
- 没有 WMS 测试环境，真实验证必须谨慎且人工授权；
- 一个服务实例只支持一个共享 Chrome profile 和一个活动任务；
- 无头模式要求 profile 已登录，登录失效时仍需有头模式人工处理；
- 有头模式要求当前 macOS 用户具有可用图形会话；
- `qpdf` 是系统级依赖，Python requirements 不会安装它；
- 源码环境的二级下载默认路径包含当前开发用户名，跨机器直接运行需覆盖环境变量；
- FastAPI 中的 `version="0.1.0"` 是应用元数据，不是部署包发布号；部署包以 `VERSION` 文件为准；
- 当前源码目录本身没有 Git 历史。接手包使用文件清单和 SHA-256 保证快照完整性，但不能替代后续正式建立版本控制。

## 18. 故障定位

### 8000 端口占用

```bash
lsof -nP -iTCP:8000 -sTCP:LISTEN
```

不要重复运行多个 `start.sh`。部署版应使用随包提供的管理脚本重启。

### 服务启动但页面打不开

- 检查 `/api/health`；
- 确认 `frontend/dist/index.html` 存在且当前用户可读；
- 查看 launchd 日志；
- 前端源码修改后重新 build。

### WMS 登录失效

- 选择有头模式；
- 在自动打开的专用 Chrome 中登录；
- 不要把日常 Chrome Cookie 复制到 profile；
- 不要在任务运行时手动改动自动化页面。

### 模板正确但导出缺列

- 查看日志是否出现“关键字段齐全”；
- 检查 `required_template_fields` 与 `minimum_template_fields`；
- 确认页面字段读取选择器仍对应已勾选字段；
- 不要只依赖模板输入框文字。

### 打印捕获不到请求或 PDF 偏移

- 优先阅读 `wms_wave_print.py` 的打印请求捕获与预览提取；
- 再检查 `pdf_centering.py` 的可见对象边界；
- 使用无生产影响的已保存 HTML/PDF fixture 做测试；
- 不要恢复基于 macOS 打印对话框屏幕坐标的方案。

### 波次拣货出现网络错误

当前策略是继续后续波次、零重试、最后一次统一读取待拣货列表。不要单独重提异常波次，除非用户明确改变了业务规则并接受重复提交风险。

## 19. AI 接手操作准则

AI 在修改本项目时应遵守：

1. 默认只读检查生产页面；没有明确授权时不点击导出、打印、确认拣货等按钮；
2. 用户提供波次号不等于授权执行所有可能操作，仍应以当前任务说明限定动作；
3. 优先使用 mock、单元测试、静态构建和本地 API 校验；
4. 不读取、展示、打包或传输 browser profile、Cookie、账号、下载内容和日志中的敏感信息；
5. 不通过放宽选择器、跳过唯一性检查或吞掉非网络异常来“提高成功率”；
6. 修改前查看工作区是否有用户未提交改动，并保留无关更改；
7. 修改后至少运行相关测试，风险较高时运行全部测试；
8. 页面修改后运行 planner/build.py 重新构建；Python 修改必须重启后端；
9. 重启服务后检查 `/api/health`，但不要自动创建生产任务作为健康测试；
10. 更新功能行为时同步更新 README、PROJECT_STRUCTURE、AI_HANDOFF 和打包产物。

## 20. 当前快照验证记录

截至 2026-08-15，当前源代码已确认：

- 控制台页面已切换为波次规划工具单文件版（`frontend/dist/index.html`，由规划工具工程 `planner/build.py` 部署）；Vue 控制台源码保留但不再部署；
- 新增 `GET /api/jobs/{id}/file`：仅允许读取项目下载目录内的导出文件，供规划工具自动导入；
- `scripts/start.sh` / `scripts/dev.sh` 不再执行 Vite 构建，改为校验页面文件存在后直接启动后端；

- 三个工作流均已注册到同一 `JobManager`；
- 波次拣货支持“输入则指定、留空则全部”；
- 指定拣货输入上限 500，打印输入上限 100；
- 波次拣货最大并发为 5；
- 前端生产构建可成功完成；
- 后端测试共 48 项并全部通过；
- 本地服务健康接口为 `http://127.0.0.1:8000/api/health`；
- 未通过本次文档与打包工作执行任何生产 WMS 操作。

## 21. 接手后的首轮建议

1. 将源码包导入正式 Git 仓库，先提交未改动基线；
2. 在新机器运行完整测试与 Vite build；
3. 检查 `config/automation.json` 与生产 DOM 是否仍一致，但保持只读；
4. 根据实际操作系统用户覆盖二级下载路径；
5. 安装 Chrome 与 qpdf；
6. 使用有头模式完成该设备自己的 WMS 登录；
7. 在获得明确授权后，以单个低风险目标做首次生产验证；
8. 每次发布生成新版本部署包并保留 ZIP 的 `.sha256` 文件。

## 22. 打包内容与隐私

源码接手包采用白名单，包含业务源码、前端源码与构建产物、配置、测试、脚本、部署工具和文档。部署包只包含运行所需代码、构建产物、安装工具和文档。

两个包均不包含：

- WMS 账号或密码；
- Cookie 或 Chrome profile；
- 用户下载的 Excel/PDF；
- `.venv`、`node_modules` 或包管理缓存；
- launchd 运行日志；
- 调试截图、临时 PDF、烟雾测试输出；
- 当前机器的 `.git` 元数据。

每个包内都有 `SHA256SUMS.txt`，ZIP 旁有整体 `.sha256` 文件。接手者应先验证压缩包哈希，再解压并核对内部清单。
