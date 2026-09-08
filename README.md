# 波次自动化工具

本地运行、可整体拷贝部署的 WMS 工具集，由两个深度整合的部分组成：

1. **波次规划工具**（单文件 HTML）：订单 Excel 导入 → 渠道/分段规划 → 含波次号的 Excel 导出；
2. **WMS 自动化后端**（FastAPI + Playwright）：在浏览器中自动完成「订单导出（全量分析）」「生成波次」「打印波次」「批量拣货」四类生产工作流。

两者合并在同一个控制台页面（`http://127.0.0.1:8000/`）中使用：规划页提交任务，后端用持久化 Chrome 会话操作 WMS，结果自动回填到规划页并给出下载链接。

---

## 目录结构

```text
波次自动化工具/
├── 波次规划工具.html    # 单文件规划页
├── README.md                # 本文档
├── sample/                  # 测试样本订单
├── planner/                 # 规划页源码、构建与测试
│   ├── build.py             # 构建并部署页面
│   ├── part0-head.html      # 样式
│   ├── part1-body.html      # 结构
│   ├── part2-fonts.html     # 内嵌字体
│   ├── core.js              # 分段与导出核心逻辑
│   ├── app.js               # 页面交互（含 WMS 联动）
│   ├── vendor/              # SheetJS 库
│   ├── fonts/               # 字体源文件
│   └── test-*.js            # 规划页测试套件
└── wms/
    └── project/             # WMS 自动化服务根目录
        ├── backend/         # FastAPI + Playwright
        ├── frontend/dist/   # 托管页面
        ├── config/          # WMS 页面配置
        ├── scripts/         # 安装/启动/测试脚本
        ├── tests/           # 后端 pytest 测试
        ├── data/            # 登录会话、波次记录
        ├── downloads/       # WMS 下载文件
        ├── outputs/         # Excel/PDF 产物
        └── .venv/           # Python 虚拟环境
```

目录说明：

| 路径 | 作用 |
| --- | --- |
| `波次规划工具.html` | `planner/build.py` 的构建产物，双击可离线规划；也是服务托管页的来源 |
| `sample/` | 测试专用订单样本，所有规划页测试与自动化驱动共用 |
| `planner/` | 页面源码。改页面只改这里，然后跑 `build.py` 重新生成产物 |
| `wms/project/` | 后端服务根目录。`start.sh`/`setup.sh` 均以它为准，可整体拷贝 |
| `data/browser-profile/` | Chrome 持久化会话（含 WMS 登录态），**严禁打包外发** |

---

## 功能一览

### 规划页

- **导入 / 导出**：通过顶部操作区选择订单 Excel（「出库单」工作表），导出含 9 个工作表的波次规划 Excel；其中「客户统计」按实际导出的订单汇总客户订单量、拣货件数、激活 SKU、单件/多件/混件数量，以及各已识别渠道的订单数和占比；
- **实时概览**：总订单、已选择订单、有效波次与活跃渠道在规划过程中同步更新；
- **渠道模式**：在左侧编排控制台切换拆分（按物流渠道）与归并（CBT / CBS / 普通）；
- **浏览器模式**：在左侧编排控制台切换有头 / 无头，决定后端任务用哪种浏览器；
- **主题**：光耀紫府（默认）/ 黄天当立 / 蟠青丛翠 / 万丈红尘 / 海晏河清，点击即换、不重载、不影响任务；
- **分段勾选与参数**：渠道/分段逐项勾选（否掉），分组参数统一或按渠道调整。

### WMS 联动区（四个工作流 + 一个执行按钮）

1. **全量分析**：WMS 导出全部订单并自动导入规划页；
2. **生成波次**：按勾选分段顺序逐段执行——粘贴出库单号精确搜索 → 核对「待处理+已取消」数量 → 全选 → 生成波次（排序规则：库位、SKU*数量）→ 提取波次号，逐段回填并变绿，最后自动导出含波次号的 Excel；
3. **打印波次**：按波次号生成拣货单 PDF 并合并；
4. **批量拣货**：对待拣货波次批量执行拣货。

操作方式：点选一个功能（高亮）→ 点「开始任务」；运行中按钮变为「取消任务」；任务结束恢复「开始任务」。未选功能时按钮不可用。

---

## 快速开始

### 方式一：完整控制台（推荐）

```bash
cd wms/project
./scripts/setup.sh     # 首次：创建 .venv 并安装后端依赖
./scripts/start.sh     # 启动服务（默认监听 127.0.0.1:8000）
```

浏览器打开 <http://127.0.0.1:8000/>。首次使用建议把「浏览器模式」切到有头，在自动弹出的 Chrome 中登录 WMS，之后切回无头即可复用会话。

### 方式二：纯离线规划

直接双击 `波次规划工具.html`，导入订单 Excel 即可完成规划与导出；WMS 联动区自动隐藏。

---

## 部署

### 部署准备

| 项目 | 要求 | 说明 |
| --- | --- | --- |
| 操作系统 | macOS（推荐）/ Linux | 脚本按 POSIX 编写；Windows 需自备等价环境 |
| Python | 3.11+（推荐 3.12） | `setup.sh` 用它创建虚拟环境 |
| Google Chrome | 已安装 | Playwright 使用系统 Chrome（`channel: chrome`） |
| qpdf | 可选 | 仅「打印波次」合并 PDF 需要：`brew install qpdf` |
| Node.js | 可选（仅构建/测试） | 修改页面后构建、运行规划页测试时需要 |
| 网络 | 可访问 `wms.xlwms.com` | 生产操作依赖 |
| WMS 账号 | 可登录 | 首次有头模式登录一次，会话保存在浏览器 profile 中 |

### 依赖安装

```bash
# 后端依赖（自动创建 .venv）
cd wms/project && ./scripts/setup.sh

# 打印波次需要 qpdf（macOS）
brew install qpdf
```

`setup.sh` 若检测不到 qpdf 会给出提示；不影响除打印外的其它功能。

默认只安装 `backend/requirements.txt` 中的运行依赖；开发测试使用
`./scripts/setup.sh --dev`（读取 `requirements-dev.txt`，复用同一份运行依赖）。
桌面打包使用 `desktop/requirements-build.txt`，也复用运行依赖，不另设版本副本。
所有现有固定包版本保持不变，不会自动卸载旧环境里已有的测试包。

脚本在安装前检查 Python 3.11+，安装后执行依赖兼容性检查，失败不会提示安装完成。
本轮实际回归环境为 Python 3.12.14；其他 Python 版本及另一台 Mac 的全新安装未实机验收。
首次创建可用 `PYTHON_BIN=python3.12 ./scripts/setup.sh` 指定解释器；已有 `.venv`
会直接复用其解释器，不会被 `PYTHON_BIN` 覆盖或自动重建。环境损坏/版本过旧会停止并提示。
更新已有环境前请先正常停止服务；不要复制其他机器的 `.venv`，也不要在服务运行中安装依赖。

### 部署过程

1. **整体拷贝**：把本文件夹完整拷贝到目标机器（所有脚本均用相对路径，无开发机绝对路径引用）；
2. **构建/部署页面**（若拷贝后缺失或改过页面）：

   ```bash
   cd planner && python3 build.py
   ```

   该命令同时生成顶层 `波次规划工具.html` 并部署到 `wms/project/frontend/dist/index.html`；
3. **安装依赖**：`cd wms/project && ./scripts/setup.sh`；
4. **检查配置**：`wms/project/config/automation.json` 中的 WMS 页面选择器、超时、每页条数（1000条/页）等，一般无需修改；
5. **启动服务**：`./scripts/start.sh`（可带端口参数：`./scripts/start.sh 9000`）；
6. **验证**：`curl http://127.0.0.1:8000/api/health` 返回 `{"status":"ok"}`；
7. **登录 WMS**：浏览器模式切「有头」→ 在页面发起一次「全量分析」→ 弹出的 Chrome 中登录 → 登录完成后任务继续，之后可切回「无头」。

### 部署注意事项

- **监听地址**：默认 `127.0.0.1`；可用 `--ip` / `HOST` 改地址，`--port` / `PORT` 改端口，命令行参数优先。本项目主要在本机使用，默认值即可；
- **运行中不要重启服务**：任务记录会保存到本地；重启会把未完成任务标为中断，保留已确认结果，不自动重跑 WMS 操作。执行结束后会释放后台执行对象，但不会因此删除任务结果、波次记录或导出文件；
- **浏览器会话安全**：`data/browser-profile/` 含生产登录态，不要打包分发，迁移机器时建议重新登录；
- **生产操作确认**：所有生产工作流都要求前端显式确认（`confirm_production: true`），同一时刻只允许一个活动任务；
- **下载目录**：WMS 下载文件默认落在 `downloads/`，规划 Excel/PDF 默认在 `outputs/`；点击网页下载时，另存位置由 Safari/Chrome 自身下载设置决定，后端不再复制到第二个目录；
- **生成波次容错**：若某分段部分订单被临时取消（待处理+已取消=分段订单数），不会跳过该分段，而是黄字提示后继续；订单回滚后可重新导入订单文件并重新生成；
- **1000条/页**：自动化会先检查当前每页条数，已是 1000条/页 则不再重选；
- **开机自启（可选）**：用 LaunchAgent/plist 把 `start.sh` 注册为登录项即可，服务进程不依赖终端会话。
- **启停身份核对**：`start.sh` 与 `scripts/service_identity.py` 配套使用，数字 PID 文件旁会保存本次启动身份。停止/重启只接受项目、完整端口、命令和启动时间均匹配的进程；旧版缺少身份记录的活跃服务不会自动接管，升级前需按原启动方式正常停止，不能只删除 PID 文件。

---

## 页面更新

修改 `planner/` 源码后：

```bash
cd planner
python3 build.py   # 重新生成顶层 HTML，并部署到 wms/project/frontend/dist/
```

服务静态页面按请求实时读取，**改页面无需重启服务**；改后端代码才需要重启。

---

## 测试

```bash
# 从仓库根目录运行：纯计算测试，不启动浏览器
cd planner
node test-core.js
node test-consistency.js

# 测试基建自检，以及隔离的无头 Chrome 页面测试
node --test test-harness-safety.js
node test-browser-safety.js
node test-e2e.js
node test-web-chain.js
node test-invariants.js
node test-order-sticky.js
node test-visual-effects.js
node test-wms-ui.js

# 审计回归：覆盖已复现问题；通过不代表真实 WMS 的待验项目已完成
node --test test-audit-regressions.js

# 后端完整测试（包含审计回归，不连接生产 WMS）
cd ../wms/project
./scripts/setup.sh --dev  # 测试准备；已有服务应先正常停止再安装依赖
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend .venv/bin/python -m pytest -p no:cacheprovider
```

页面测试仅使用自己创建的临时 Chrome profile、随机回环端口和模拟服务；不需要停止
8000/8001 上的现有服务，也不使用已有登录态。浏览器默认阻断外网及未显式放行的本地服务。
后端测试将配置、任务记录、下载、输出和 PID 隔离到临时目录，默认拦截网络与真实 Playwright
启动；启动脚本测试只运行临时健康检查应用。运行这些测试需要系统允许随机回环监听。

`wms/project/scripts/run_full_auto.py` 现在仅是 `test-wms-ui.js` 的兼容入口，不接受目标 URL，
不再连接现有服务或执行真实 WMS 流程。它需要完整仓库及 Node.js、Chrome。
页面测试的临时截图、下载及 profile 会在结束时清理；核心 Excel 导出测试在内存中读回校验。

审计回归未使用 skip/xfail：在相应修复完成前，全套测试返回非零是仍有缺陷的真实结果，
不能仅运行旧用例就宣称验收通过。以上测试不代替另行授权的真实 WMS 验收。

---

## 配置与环境变量

### `config/automation.json`

- `target_url` / `template_name`：导出工作流的订单页地址与模板校验；
- `wave_picking` / `wave_printing`：拣货与打印工作流的页面选择器、并发数、超时；
- `wave_generation`：生成波次工作流——搜索栏选择器、每页条数、多项搜索单次上限（700 行）、波次号格式、超时；`search_verify_wait_ms`（搜索数量核对短窗等待，默认 4000ms）。

配置在服务启动时读取；任务提交限制与实际执行共用这一份配置。修改 JSON 后需重启
服务生效，不会在运行中只更新提交校验而留下旧执行配置。

### 环境变量（均可选，默认值见 `backend/app/core/config.py`）

| 变量 | 作用 | 默认 |
| --- | --- | --- |
| `HOST` | 源码启动监听地址 | `127.0.0.1` |
| `PORT` | 服务端口 | 8000 |
| `WMS_AUTOMATION_CONFIG` | 配置文件路径 | `config/automation.json` |
| `WMS_BROWSER_PROFILE` | Chrome 会话目录 | `data/browser-profile` |
| `WMS_BROWSER_CHANNEL` | 浏览器通道 | `chrome` |
| `WMS_HEADLESS` | 默认是否无头 | `false` |
| `WMS_DOWNLOADS_DIR` | WMS 下载目录 | `downloads` |
| `WMS_OUTPUTS_DIR` | 导出/打印产物目录 | `outputs` |
| `WMS_FRONTEND_DIST` | 托管页面目录 | `frontend/dist` |

以上目录默认值针对源码启动。macOS `.app` 默认将下载放在
`~/Library/Application Support/WMS自动化控制台/downloads/`，规划 Excel/PDF 放在同级
`outputs/`，不写入应用包；显式环境变量仍可覆盖。旧文件不会被自动迁移或删除。

---

## 安全说明

- 生产操作需显式确认；同一时刻仅允许一个活动任务；
- 波次号/出库单号仅允许字母、数字、下划线、连字符，防止注入与歧义匹配；
- 导出与打印文件只能从项目 `outputs/`、`downloads/` 目录读取，接口带目录白名单校验；
- 服务默认监听 127.0.0.1；当前主要在本机运行，无需调整监听地址；
- 浏览器 profile、下载文件、波次记录均属敏感数据，备份或迁移时注意保管。
