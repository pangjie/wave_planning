# 本机部署说明（127.0.0.1:8000）

部署日期：2026-10-30。代码基线：`main` / `78e954a`。
本文只描述本机实际部署；通用安装/使用说明见仓库根目录 `README.md`，源码导览见 `docs/CODE_GUIDE.md`。

## 1. 当前状态

| 项目 | 值 |
| --- | --- |
| 访问地址 | <http://127.0.0.1:8000/> |
| 监听 | `127.0.0.1:8000`（仅本机） |
| 运行目录 | `~/Library/Application Support/WavePlanning` |
| launchd 标签 | `com.jp.waveplanning` |
| plist | `~/Library/LaunchAgents/com.jp.waveplanning.plist` |
| 日志 | `~/Library/Application Support/WavePlanning/wms/project/logs/launchd.{out,err}.log` |
| Python | 运行目录内 `.venv`，基础解释器 `/opt/miniconda3/bin/python3.12`（3.12.11） |
| 运行数据 | `~/Library/Application Support/WavePlanning/wms/project/{data,downloads,outputs}` |
| WMS 登录态 | 已建立（2026-10-30 12:36 首次导出成功，917 单） |
| 单件策略 | SKU 均衡 / 库位优先已上线；本地库位表 16,393 个库位；离线 HTML 仅 A |
| 源码工作区 | `$HOME/Documents/WavePlaning@DSH`（唯一编辑位置） |

服务由 launchd 直接托管（进程父 PID 为 1），登录自启、崩溃后约 10 秒自动重启，
**不依赖终端、Codex 或 DeepSeek Harness 会话**。已实测 `SIGKILL` 后自动恢复。

## 2. 为什么运行目录不在工作区

macOS 隐私保护（TCC）禁止 launchd 登录代理读取 `~/Documents`。实测 launchd
启动的进程访问工作区会得到 `Operation not permitted`，而访问
`~/Library/Application Support` 正常。因此：

- 工作区 = 源码、测试、文档（可编辑、可 git 管理）；
- 运行目录 = 代码副本 + 独立 `.venv` + 生产数据（由 launchd 运行）；
- 两者通过 `deploy/sync-to-runtime.sh` 单向同步。**不要直接修改运行目录的代码**，
  下一次同步会覆盖。

## 3. 日常命令

在任意目录执行工作区脚本：

```bash
cd "$HOME/Documents/WavePlaning@DSH"
./deploy/waveplanning-service status    # launchd 状态 + HTTP 健康检查
./deploy/waveplanning-service restart   # 优雅重启（会中断运行中的任务）
./deploy/waveplanning-service logs      # 最近 60 行 stdout/stderr
./deploy/waveplanning-service stop      # 卸载，直到下次登录或手动 start
./deploy/waveplanning-service start
```

注意：

- 重启/停止会中断正在执行的 WMS 任务；任务记录会标为中断并保留已确认结果，
  不会自动重放生产操作。更新代码前先确认没有活动任务。
- 不要再用 `wms/project/scripts/start.sh` 启动 8000；它会与 launchd 实例争端口。
  该脚本仍适合在其它端口做临时调试。

## 4. 更新代码

1. 在工作区修改代码；
2. 跑回归（后端测试使用临时目录，不碰生产数据）：

   ```bash
   cd "$HOME/Documents/WavePlaning@DSH/wms/project"
   PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=backend .venv/bin/python -m pytest -p no:cacheprovider -q
   ```

3. 纯前端/计算测试（`test-wms-ui.js` 会占用 8000，需先 `stop` 服务，测完再 `start`）：

   ```bash
   cd "$HOME/Documents/WavePlaning@DSH/planner"
   node test-core.js && node test-consistency.js && node test-e2e.js
   node test-web-chain.js && node test-invariants.js
   node test-paper-location.js && node test-paper-location-ui.js
   ```

4. 发布：

   ```bash
   cd "$HOME/Documents/WavePlaning@DSH"

   # 只改前端（planner/）：同步并重建页面，不重启后端，刷新浏览器生效
   ./deploy/update-frontend.sh

   # 改后端、config/automation.json 或依赖：同步 + 重建 + 重启
   ./deploy/update-service.sh
   ```

   `update-service.sh` 在检测到排队/运行中任务时会拒绝重启；确需中断时用
   `--force`，任务会按既有规则标为中断待核对。同步会保留运行目录的
   `data/`、`downloads/`、`outputs/`、`logs/`、`.venv/`，`--delete` 只清理
   未排除的旧代码。

   服务运行的是运行目录副本，**不会**因为修改工作区文件而自动变化；每次发布
   必须执行上述命令。没有文件监听器：launchd 受 TCC 限制无法读取工作区。

### 4.1 单件库位策略与本地库位表

- 参数列表头「单件」可在「SKU 均衡 / 库位优先」间切换；库位优先需要本地库位表。
- 库位表不公开、不嵌入 HTML、不进 Git：
  - 原始导出：`planner/location-source/Locationexport_*.xlsx`（gitignore）；
  - 生成物：`planner/location-priority.local.json`（gitignore）；
  - 运行时：`wms/project/frontend/dist/location-priority.json`（gitignore，
    由 `build.py` 从生成物复制）。
- Console 页面同源 fetch 该 JSON；成功才启用 B。**离线单文件 HTML 只支持 A**。
- 更新库位表：

  ```bash
  cd "$HOME/Documents/WavePlaning@DSH"
  mkdir -p planner/location-source
  cp ~/Downloads/Locationexport_YYYYMMDDHHMMSS.xlsx planner/location-source/
  wms/project/.venv/bin/python planner/build_locations.py     planner/location-source/Locationexport_YYYYMMDDHHMMSS.xlsx
  python3 planner/build.py
  ./deploy/update-frontend.sh
  ```

- 表版本进入策略 B 的 plan_id；更新表后旧波次号不会套到新分段。
- 700：生成模式下任一激活单件分段池 >700，页面提交前禁用「开始任务」；
  不做单库位单独规则；后端仍会整批校验。
- 缺库位/无需拣货库位的订单整体并入最后一段，页面/日志 warning，不阻断、不丢单。
- 相关回归：`planner/test-paper-location.js`、`planner/test-paper-location-ui.js`。

## 5. WMS 登录态（已建立，附重登步骤）

2026-10-30 12:36 已在 8000 实例完成首次登录并成功导出 917 单。登录态保存在
运行目录 `data/browser-profile/`（约 9MB）。

若登录失效或迁移机器，重新登录：

1. 打开 <http://127.0.0.1:8000/>；
2. 点击顶栏「波次规划工具」切换为 **有头**；
3. 选择「全量分析」→「开始任务」；
4. 自动弹出的 Chrome 中登录 WMS；登录后保持窗口开启，任务会继续；
5. 成功后可切回「无头」。

登录态属于敏感数据，不要复制外发或提交到 Git。

## 6. 定时截单

新实例初始为停用；部署当天页面已把定时截单配置为
**启用 / 07:00 / 提前 15 分钟 / America/New_York**（保存于运行目录
`data/cutoff-schedule.json`）。旧 8001 实例目前已停止，因此当前没有重复调度。

若恢复 8001 实例，它自身也配置了 07:00 截单；两个实例会各跑一次导出。
启用/恢复前先确认只保留一个调度实例。

## 7. 数据与备份

| 路径（相对运行目录） | 内容 |
| --- | --- |
| `wms/project/data/browser-profile/` | Chrome 持久会话（WMS 登录态，最敏感） |
| `wms/project/data/jobs.json` | 任务记录、检查点、重试入口 |
| `wms/project/data/wave-records.json` | 已确认波次索引 |
| `wms/project/data/cutoff-schedule.json` | 定时截单配置与最近执行 |
| `wms/project/data/plans/` | 任务提交时的计划快照 |
| `wms/project/downloads/` | WMS 下载订单文件 |
| `wms/project/outputs/` | 规划 Excel、合并 PDF、打印副本 |

备份时建议先 `stop`，复制上述目录，再 `start`。不要用备份重放真实 WMS 操作。

## 8. 与旧实例（8001）的关系

- 旧实例 `$HOME/Documents/ChatGPT/波次规划系统改造` 使用独立数据目录，
  含历史任务、登录态和已启用的定时截单；本次没有复制或删除它的数据。
- 部署期间观察到旧实例在约 12:25 正常停止（uvicorn `Shutting down`，PID 文件被移除）。
  **本次操作没有向 8001 发送停止命令**，其数据完整保留。
- 如需恢复旧实例：

  ```bash
  cd "$HOME/Documents/ChatGPT/波次规划系统改造/wms/project"
  ./scripts/start.sh start --port 8001
  ```

- 两个控制台使用同一 WMS 账号但不同浏览器 profile，可以同时运行；这意味着
  可能重复导出或重复生成波次。生产操作请只使用一个控制台，或确保同一时间只有
  一个控制台在执行任务。

## 9. 本次审核与测试基线

已通过：

- 后端 pytest：**441 passed**（运行目录与工作区使用同一份源码/依赖）；
- 前端全部套件：core、consistency、browser-safety、e2e、web-chain、invariants、
  order-sticky、ordinary-refresh、USPS、USPS-UI、retry、auto-print、cutoff、
  visual-effects、wms-ui、paper-location、paper-location-ui，以及
  harness-safety、audit-regressions；
- 真实 20,265 单原始导出（后端合并后）在 8000 页面验收：
  - A/B 单件 5,130 单，订单守恒/DOM=analysis/无重复；
  - B 策略、hotLine 5/10/20、capacity 200/400、absorb 1–4、归并、USPS 开关、
    渠道/分段开关全部通过；
  - absorb=4 无单件段；700 前置禁用命中 Gofo 1,292 单段；
  - 9 表导出成功，计划身份切换清空波次历史；未提交任何 WMS 任务；
- 两份发布 HTML 由 `planner/build.py` 重建后 SHA256 与源码产物一致：
  `5105d77e19b099321d4eb65fa79c778afc429318d58b245fa693c361364f38f8`；
- launchd 环境下有头/无头 Chrome 均可启动，qpdf 12.4.2 可调用；
- `SIGKILL` 后 launchd 在约 10 秒内自动恢复。

本次修正的是测试与后续提交不一致的 5 处（不改业务逻辑）：

1. `test-consistency.js`：渠道统计行已由「波次容量」改名为「爆品容量」；
2. `test-e2e.js`：CSS 行高调整后，参数格上边距断言 20px → 16px；
3. `test-e2e.js`：类型统计不再写死「16波」，改为按当前选择从分析结果重算；
4. `test-visual-effects.js`：USPS 默认细分后不再有 `data-ch="USPS"` 行，改为
   任选一个可被普通吸收的非 CBT/CBS 渠道；
5. `test-wms-ui.js`：事件日志已移入「日志详情」面板；partial 自动导出链接与
   打印合并链接改为等待本任务新增链接，消除轮询竞态。

这些修改尚未 commit/push。

## 10. 已知残余风险（未在本次修改）

来自 `outputs/audit-2026-09-06/AUDIT.md`，本轮确认仍存在：

- **A06**：生成波次搜索后仍以「待处理+已取消=目标数」核对数量，没有订单集合身份；
  页面延迟但数量碰巧相同时仍有按旧结果生成的风险。
- **A08**：批量拣货的截单弹窗识别仍接受「提醒」「confirm」等宽泛关键词，未知弹窗
  可能被自动确认（有唯一按钮检查）。
- **A09**：普通导出通过“导出前快照 + 文件名前缀”取第一个新任务；同账号并发导出
  时仍可能归属错误（截单检查点模式会拒绝多个新候选）。
- 用户此前已明确排除的安全项（A01 无鉴权、A02/A24 依赖公告、A18 上传边界）未改动；
  服务仅监听回环地址，仍不是身份认证。

建议下一步收集真实 WMS 的查询响应、截单提示文字和导出任务中心样例后，再最小修复
A06/A08/A09；不要在没有现场证据时改选择器或匹配规则。

## 11. 回退

- 代码回退：在工作区 `git checkout <旧提交>`，再执行 `./deploy/update-service.sh`；
  代码回退不能撤销已经发生的 WMS 操作。
- 服务回退：`./deploy/waveplanning-service stop`，改用旧 8001 实例。
- 运行数据不会被同步/回退删除；如需还原数据，先停服务再按第 7 节备份恢复。

## 12. Git 提交与推送

2026-10-30 实测：

- `origin` = `https://github.com/pangjie/wave_planning.git`，默认分支 `main`；
- 本机 `gh` 已登录账号 `pangjie`，GitHub 写入凭据可用（已用 dry-run 新分支探测通过）；
- 仓库为公开仓库，`main` 未设分支保护，账号具备 push/admin 权限；
- 本机原先缺少 git 提交身份，已在本仓库设置：
  `user.name=Jie Pang`、`user.email=jp@m3.local`（与既有提交作者一致）。
  如需改用 GitHub 账号邮箱：

  ```bash
  git config user.email "你的邮箱"
  ```

提交与推送：

```bash
cd "$HOME/Documents/WavePlaning@DSH"
git status
git add <要提交的文件>
git commit -m "说明这次修改"
git push origin main
```

注意事项：

- 这是**公开仓库**。提交前用 `git status` 核对；运行数据（浏览器登录态、
  任务记录、波次记录、下载/输出、定时截单配置）已在 `.gitignore` 中排除，
  不要用 `git add -f` 强制加入。
- 库位表相关文件已在 `.gitignore`：`planner/location-source/`、
  `planner/location-priority.local.json`、`wms/project/frontend/dist/location-priority.json`。
  公开 HTML 不含库位数据；离线 HTML 只支持 SKU 均衡。
- 本次维护改动（测试文件、单件策略源码、`deploy/`、`docs/`、`.gitignore`）
  仍未提交，是否与你的业务改动一起提交自行决定。
- `deploy/` 与本文包含本机路径和运行方式，不含凭据；如不想公开可只提交业务代码。
