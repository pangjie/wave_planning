# 波次规划系统 · 正式 Audit

审计完成日：2026-09-06。审计对象：本地 `main`，提交 `d54f44b`。本报告是 PHASE 2，不是已完成整改的声明。

## 结论与边界

执行范围更新（2026-09-06）：用户已取消后续数据与网络安全相关重构，仅继续工具功能、可靠性与维护整改。A01/A02/A18/A24 及 A25 的纯安全升级不纳入实施；本报告保留原始审计事实，不把范围外项目标为已修复。当前执行依据为同目录 `PLAN.md`。

当前系统的主要风险不是界面或代码风格，而是：**计划、任务、波次结果之间缺少可靠的身份绑定；生产操作前的部分检查只能验证数量或文案；故障恢复与持久化不能完整表达“操作已经发生，但后续处理失败”。**

共记录 28 项整改事项：P0 0 项、P1 9 项、P2 15 项、P3 4 项。未发现足够证据认定 P0；不代表已经证明系统不存在严重漏洞。P1 不等于每次都会发生，具体前提见各项。

- P0：正在发生或几乎无前提的灾难性风险。
- P1：可能造成生产操作对象错误、关键数据错误，或有明确可达路径的高风险安全问题。
- P2：可靠性、部署、输入边界、测试保护存在明确缺陷，需要安排整改。
- P3：低概率边界、维护与资源管理问题，不应抢在安全和数据正确性之前重构。

证据标记：**复现**＝执行现有代码、用内存/模拟外部接口观察到错误；**静态**＝代码路径明确，但未在真实环境制造触发条件；**公告**＝版本与维护者公告核对。模拟复现不等于真实 WMS 当前一定会出现对应弹窗或页面状态。

本阶段没有修改业务源码、升级依赖、启动或重启服务、提交真实 WMS 操作、commit 或 push；只新增本审计报告。审计开始时已有 `outputs/` 未跟踪内容，未覆盖。

## 问题索引

| ID | 级别 | 问题 | 分类 | 证据 |
|---|---|---|---|---|
| A01 | P1 | 生产操作和文件接口没有访问控制 | Security | 复现＋静态 |
| A02 | P1 | 文件响应组件存在已知 Range 拒绝服务漏洞 | Security / Performance | 公告＋可达代码 |
| A03 | P1 | 旧任务波次号套到修改后的计划，自动导出错误 | Bug Risk / Architecture | 复现 |
| A04 | P1 | 迟到的旧轮询响应停止新任务跟踪、重复导出 | Bug Risk / Reliability | 复现 |
| A05 | P1 | 新批次统一调整悄悄重置其他规划参数 | Bug Risk | 复现 |
| A06 | P1 | 相同数量的旧搜索结果可通过提交前检查 | Bug Risk / Reliability | 复现＋现场条件 |
| A07 | P1 | 生成确认按钮存在歧义时仍提交首个候选 | Security / Bug Risk | 复现＋现场条件 |
| A08 | P1 | 普通“提醒/confirm”也被当成截单提示自动确认 | Security / Bug Risk | 复现＋现场条件 |
| A09 | P1 | 同账号同期导出时可能下载另一个任务的文件 | Bug Risk / Reliability | 复现＋现场条件 |
| A10 | P2 | 重启恢复出无人执行的“运行中”任务，阻塞新任务 | Reliability | 复现 |
| A11 | P2 | 业务已成功，清理失败仍会丢失成功结果 | Reliability | 复现＋静态 |
| A12 | P2 | 关键持久化失败静默，损坏记录可被当空表覆盖 | Reliability / AI Code Rot | 复现＋静态 |
| A13 | P2 | 单任务保护不跨进程，浏览器修复操作缺少独占边界 | Reliability / Architecture | 静态 |
| A14 | P2 | 分段输入类型校验可把订单字符串拆成字符 | Bug Risk / Security | 复现 |
| A15 | P2 | 超过 700 单的单 SKU 拆段后，序列表统计错误 | Bug Risk | 复现 |
| A16 | P2 | 清理成功后旧读取仍恢复历史波次；清理范围全局化 | Reliability / Architecture | 复现＋静态 |
| A17 | P2 | 页面操作超时被误判网络故障，继续后续拣货 | Reliability / AI Code Rot | 复现 |
| A18 | P2 | 保存 Excel 的接口不限制体积，且未真正验证工作簿 | Security / Performance | 复现＋静态 |
| A19 | P2 | 停止脚本可能接受其他项目或前缀相同端口的 PID | Reliability | 复现 |
| A20 | P2 | 桌面版输出目录错误地落到应用资源内 | Reliability | 复现 |
| A21 | P2 | 浏览器诊断与实际配置不一致 | Reliability / Duplication | 复现＋静态 |
| A22 | P2 | 启动测试继承生产目录并监听所有网卡 | Security / Reliability | 复现＋静态 |
| A23 | P2 | 全流程驱动与现有 UI 脱节，部分测试断言失效 | Maintainability / AI Code Rot | 静态 |
| A24 | P2 | 固定 PDF 依赖包含已知解析缺陷 | Security / Reliability | 公告＋输入边界核对 |
| A25 | P3 | 安装/测试工具链的安全版本与依赖约束未统一 | Security / Maintainability | 公告＋环境核对 |
| A26 | P3 | 特殊订单号会碰到对象原型键，污染数量计算 | Bug Risk | 复现 |
| A27 | P3 | 存在已失效的配置写入和布局计算 | Dead Code / AI Code Rot | 引用核对 |
| A28 | P3 | 长期运行的任务与文件没有明确保留边界 | Performance / Maintainability | 静态 |

## P1：优先处理

### A01 · 生产操作和文件接口没有访问控制

位置：[routes.py:121](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:121)、[routes.py:111](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:111)、[main.py:39](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/main.py:39)。

- 触发：其他进程或用户能够访问服务；尤其是按 `--ip 0.0.0.0` 开放到网络后。默认回环地址缩小暴露面，但不是身份验证。
- 证据：仅挂载真实路由、替换任务执行器的隔离客户端，无认证提交 `confirm_production=true` 得到 202。带外站 Origin 的纯文本 POST 清理历史得到 200，清理函数调用一次。没有执行真实任务或清理真实数据。
- 影响：可使用服务保存的 WMS 会话发起任务、取消任务、清除共享记录，读取任务与订单文件。确认字段是请求者自己填写的，不构成授权。
- 根因：把“本地工具”和“用户已点击确认”当成服务端访问边界；所有业务数据属于同一全局空间。
- 最小整改：明确单用户本地与局域网部署的支持边界；对敏感 API 加统一访问控制，并校验允许的 Host/Origin。单用户不必引入复杂 RBAC；网络共享必须明确谁能操作和读取哪些数据。
- 验收：未授权创建、取消、清理、列表、下载均拒绝；合法页面保持现有流程。这里的 Origin 验证只证明服务端接受请求，**未声称已绕过 Safari/Chrome 的本地网络访问限制完成浏览器 CSRF 利用**。

### A02 · FileResponse 已知拒绝服务漏洞在当前代码中可达

位置：[requirements.txt:1](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/requirements.txt:1)、[main.py:55](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/main.py:55)、[routes.py:214](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:214)。

- 本地安装 `Starlette 0.46.2`，落入 CVE-2025-62727 / GHSA-7f5h-v6xp-fcq8 的受影响范围 `>=0.39.0, <=0.49.0`；该项修复版本是 0.49.1。恶意 Range 头可使文件响应的处理耗费大量 CPU。[维护者公告](https://github.com/Kludex/starlette/security/advisories/GHSA-7f5h-v6xp-fcq8)
- 项目首页、静态文件与下载接口直接返回 FileResponse，满足公告所述调用条件；没有对线上服务发送攻击请求或进行压力测试。
- 当前固定 `FastAPI 0.115.12` 的已安装元数据要求 `Starlette>=0.40.0,<0.47.0`，因此不能只强行替换 Starlette 并忽略兼容性。
- 最小整改：联合选择兼容且修复已知问题的 FastAPI/Starlette 版本，固定经过验证的解析结果；必要时临时在边界限制 Range。0.49.1 仅是这项漏洞的修复下限，不是本次所有公告的“安全最新版”。
- 验收：正常首页、Excel/PDF 下载、合法 Range/无效 Range 回归通过；受控隔离环境检查异常请求有界，重新扫描依赖。

### A03 · 任务结果没有绑定提交时的计划

位置：[app.js:1077](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1077)、[app.js:1345](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1345)、[app.js:1366](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1366)。

- 复现：拆分 CBT 三段，每段 60 单，提交后切换归并；旧任务完成后，自动导出成为一行 `W100001 / 3 SKU / 180 单`，但该波次实际只属于原第一段 60 单，另两段不再有对应导出行。
- 根因：忙状态没有锁住规划操作；回填只按 `channel|seg_name`，自动导出读取实时页面计划。分段名称不是跨计划稳定身份。
- 影响：Excel 看似成功导出，却包含错误的波次—订单对应关系。
- 最小整改：保存任务的不可变计划及导出快照，结果绑定计划版本和订单集合指纹；锁定运行时规划操作可辅助，但不能替代身份校验。
- 验收：运行中改参数、导入、切模式、关闭分段、普通进退化，都不能把结果写入另一订单集合。任务完成导出始终来自提交快照。

### A04 · 异步轮询没有隔离新旧任务

位置：[app.js:1194](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1194)、[app.js:1232](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1232)。

- 复现：旧任务两个轮询重叠；第一个完成后启动新拣货任务，第二个旧响应才到达。新任务原为 `jobId=new, active=true`，随后变成 `jobId=null, active=false`，新计时器被清掉，旧任务 Excel 上传从一次变两次。
- 根因：异步 setInterval 可重入；响应不校验请求时的任务 ID/代次；完成处理不幂等，却操作全局当前状态。
- 影响：后台仍在运行，前端失去正常跟踪和取消入口，且可能重复自动导出/导入。
- 最小整改：单一在途轮询链，返回时校验 ID 与代次，终态每任务只消费一次，停止自己的计时器；增加请求超时。非 404 的 HTTP 错误目前直接返回、不累计失败，也应纳入有限失败处理。
- 验收：乱序、重复、取消后迟到、新任务开始后旧响应均不得改变新任务状态；每任务完成副作用至多一次。

### A05 · 统一参数显示值与实际渠道参数可能不一致

位置：[app.js:114](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:114)、[app.js:212](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:212)。

- 复现：统一容量设为 800 → 导入新批次 → 只将统一爆品线改为 20。统一行仍为容量 800，实际渠道参数却变成容量 400、爆品线 20。
- 根因：导入保留 unified、清空 per；之后首次建立 per 却复制 DEFAULT_UNIFIED，不复制当前 unified。
- 影响：操作者看到的容量与计算分段采用的容量不同，影响整批规划。
- 最小整改：首次覆盖参数从当前统一值建立，或仅保存稀疏覆盖；无需重写参数系统。
- 验收：设置全部统一参数后导入第二批，只改其中一个，其余参数在每个渠道均保持一致。

### A06 · 数量一致不能证明搜索结果属于本次查询

位置：[wms_wave_generate.py:453](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_generate.py:453)、[wms_wave_generate.py:500](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_generate.py:500)。

- 复现：目标 2 单、前段 2 单、表格仍是前段 2 单，实际校验只读一次总数即通过。模拟证明该保护缺口；未证明当前 WMS 每次会残留旧数据。
- 根因：加载遮罩当前为 hidden，不代表本次请求已经完成；总数相等被当成查询正确应用，随后勾选数量相等也无法识别订单身份错误。
- 影响：页面延迟或查询未应用且数量碰巧相同时，有按旧订单集合建立波次的风险。
- 最小整改：绑定本次搜索完成的可靠证据，并核验当前待处理订单属于目标集合；不能只增加 sleep，也不应以扫描虚拟表格所有 DOM 行作为唯一方案。
- 验收：不同订单、相同数量的连续查询，旧数据或延迟刷新时不得提交；正确新结果可提交。保留取消订单口径：已选数应等于当前待处理数，不强求等于计划总数。

### A07 · `.first` 使提交前唯一性检查失效

位置：[wms_wave_generate.py:348](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_generate.py:348)、[wms_wave_generate.py:368](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_generate.py:368)。

- 复现：两个匹配“确定”按钮，原集合 count 从未调用，首个按钮仍被点击一次；全选框先 `.first` 再 count 也不能发现多个候选。
- 触发前提：WMS 页面存在多个符合配置的候选，例如重叠弹窗或 DOM 结构变化；未在生产现场制造。
- 根因：选择第一个候选替代了“当前业务对话框中的唯一目标”。
- 最小整改：先唯一识别当前生成配置框，再限制作用域核对提交按钮；取 first 之前检查集合。固定列克隆结构应明确识别，不应误伤正常表格。
- 验收：零个/多个业务候选时提交次数为零，唯一且启用时一次；保留原单次提交、不重试规则。

### A08 · 自动确认的业务允许范围过宽

位置：[wms_wave_pick.py:602](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_pick.py:602)、[wms_wave_pick.py:583](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_pick.py:583)。

- 复现：模拟提示“提醒：是否删除全部订单？”，实际处理函数点击确认一次；英文一般 confirm 文案同样被接受。这是隔离样例，**不表示真实 WMS 已出现删除全部订单的提示**。
- 根因：任意“提醒”“confirm”“截取”关键词即可授予自动确认许可，与唯一按钮检查无关。
- 影响：生产提示变化时可能确认本不应自动处理的动作。
- 最小整改：限定已确认的截单文案/结构，必要时匹配当前波次；未知提示停下并保留脱敏诊断。
- 验收：合法截单仍可自动确认；删除、取消、一般提醒及含 confirm 的其他提示均零点击；多弹窗拒绝规则保留。

### A09 · 新导出任务归属依赖列表顺序

位置：[export_task_center.py:203](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/export_task_center.py:203)。

- 复现：两个同前缀新任务 `[other, ours]` 选中 other；颠倒列表才选中 ours。
- 触发：同账号其他页面/操作者在本次导出窗口内发起同类型导出。仅在另一浏览器查看页面，本身不等同于触发该问题。
- 根因：只有导出前快照差分和文件名前缀，未绑定本次提交的唯一任务标识。
- 影响：可能导入不属于本次筛选条件的订单文件。
- 最小整改：优先从本次提交响应/页面取得唯一任务 ID 并跟踪；不能可靠关联时安全停止。时间窗口只能辅助；不能靠再次提交导出来“重试归属”。
- 验收：同期同前缀任务、列表重排、他人任务先出现时，均不能下载他人文件；锁定后始终跟踪同一 ID。

## P2：可靠性、边界与交付

### A10 · 重启恢复了状态，却没有恢复执行者

位置：[job_manager.py:97](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:97)、[job_manager.py:144](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:144)、[job_manager.py:176](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:176)。

- 复现：当天持久化的 running 任务在重启后仍是 running，执行任务数量为 0，新建任务被拒绝。取消这个孤儿任务时 `_persist` 调用为 0，再次重启仍可能读回旧状态。
- 根因：直接恢复运行状态，未区分进程中断与实际执行；取消路径依赖活任务的异常处理持久化，漏掉无执行者情况。
- 影响：服务看似健康，却无法接新任务；操作者也无法据状态确定生产动作是否发生。
- 最小整改：启动时把未完成任务转为明确的中断/待核对状态并持久化，保留已完成分段；孤儿取消也必须落盘。**禁止自动重放生成或拣货操作**。
- 验收：排队中、执行中、已部分生成时中断后恢复；新任务可按安全策略提交，原执行不重复，取消后再次重启不复活。

### A11 · 成功结果被清理异常遮蔽

位置：[wms_wave_generate.py:381](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_generate.py:381)、[export_task_center.py:130](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/export_task_center.py:130)、[common.py:166](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/common.py:166)。

- 复现：确认已点击、波次号已提取，再模拟清理异常，生成方法抛错且号码未返回给逐段持久化。真实清理函数仍存在未捕获的控件计数、等待调用；浏览器断开可影响这些步骤。
- 静态证据：下载 save_as 成功后关闭任务中心失败仍阻止返回文件；正常退出上下文的 close 异常也能覆盖原本成功的 return。
- 根因：业务提交/结果确认与界面清理共用同一成功失败边界。
- 最小整改：先可靠记录已确认的结果，再把清理问题作为附带警告或独立结果状态；业务本身失败时保留原异常，不能把所有 close 异常一概吞掉。
- 验收：成功＋清理失败仍保留唯一波次/完整文件且不重提交；失败＋清理失败保留原始业务原因。

### A12 · 关键记录的写入失败没有可靠告警

位置：[job_manager.py:112](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:112)、[job_manager.py:203](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:203)、[wave_records.py:18](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/wave_records.py:18)、[wave_records.py:69](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/wave_records.py:69)。

- 复现：模拟磁盘写入 OSError，任务持久化不向调用者报告；模拟损坏的记录 JSON，读取返回空列表，下一次 upsert 按“空历史”只写入新记录。
- 根因：广泛 catch 后 pass/空列表混淆“没有数据”和“数据不可读取”。波次记录直接覆盖写入，没有与 jobs.json 同样的临时文件替换保护。
- 影响：操作者以为已保存的任务/波次记录可能在重启后丢失；损坏痕迹可能被后续写入覆盖。任务失败通常只留 `str(exc)`，缺少可定位原因的后端异常上下文。
- 最小整改：波次记录采用原子替换；损坏文件保留并告警，不当空库继续覆盖；持久化故障明确标记并记录脱敏异常上下文。不要因为落盘失败重新执行生产动作。
- 验收：磁盘满、无权限、半截 JSON、替换失败都有可见诊断；旧完整记录可恢复；成功业务结果与持久化状态分开。

### A13 · 多实例没有共同的生产会话保护

位置：[job_manager.py:88](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:88)、[config.py:179](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/core/config.py:179)、[wms_export.py:55](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_export.py:55)、[common.py:101](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/common.py:101)。

- 条件：同一项目在不同端口/多个进程运行，仍使用默认同一 profile 和 data。启动脚本按端口维护 PID；JobManager 的锁和 active 检查仅属于当前进程。
- 静态风险：两个实例可各自接单；导出在浏览器启动前清理 profile 数据，因此不能把 Chrome 后续的 profile 占用拒绝当成全部保护。文件锁也只有进程内线程锁。
- 修复代码范围问题：注释描述清理 `021_download`，实际删除整个 `shared_proto_db`，且所有系统、版本、有头/无头导出均执行。未证明造成登录丢失，不能把历史下载修复直接认定为无用代码。
- 最小整改：对同一生产 profile 建立跨进程独占，范围覆盖预处理、浏览器和关键写入；已有占用时拒绝第二实例。另为历史下载修复明确适用条件、可观测性和退出条件，验证后才收窄。
- 验收：两个隔离实例竞争同一临时 profile，第二个在任何浏览器资料修改前被拒绝；不同独立 profile 可分别运行。真实生产 profile 未用于测试。

### A14 · 分段输入不是强类型契约

位置：[routes.py:29](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:29)、[routes.py:48](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:48)。

- 复现：`order_nos: "ABC"` 被接受并归一化为 `["A","B","C"]`；`order_nos: 123` 抛 TypeError，经真实路由得到 500，而不是请求校验错误。
- 根因：分段为任意字典，校验直接迭代未知值；只有段内去重，没有跨分段重复订单保护或整体数量边界。
- 影响：畸形客户端输入可能形成错误搜索条件或无意义服务端错误；接口不能依赖当前前端始终发送正确形状。
- 最小整改：定义最小 Segment 请求模型，订单号必须为字符串列表；校验重复段标识、跨段重复订单和合理请求上限。每段超过 700 的既有“跳过”契约要明确保留或经业务确认后调整，不能悄悄改为自动多次生成。
- 验收：字符串、数字、对象、空列表、重复订单、超限输入在任何生产浏览器启动前得到明确结果；合法旧请求保持兼容。

### A15 · 单 SKU 多子段的导出模型仍按单段映射

位置：[core.js:383](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/core.js:383)、[core.js:470](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/core.js:470)、[core.js:1125](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/core.js:1125)。

- 复现：800 单同 SKU 拆为两个 400 单段，两段 SKU 池的数量都为 800。只选爆品 1 导出时“单件 SKU 序列”无数据；只选爆品 2 则显示出现 800 次、所属段 400 单。
- 根因：子段沿用原 SKU 池；SKU→分段为单值 Map，前一个子段被后一个覆盖。
- 影响：部分选中导出错误；不能以分段订单总数正确就判断各工作表正确。
- 最小整改：按子段订单集合重新统计 SKU 池；从选中分段聚合序列，或支持同 SKU 的多段关系并明确统计口径。
- 验收：701、800、1401 单，逐段选中和全部选中，序列计数与对应订单集合一致。

### A16 · 历史清理与读取缺少代次和批次边界

位置：[app.js:1031](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1031)、[app.js:1313](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1313)、[wave_records.py:36](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/wave_records.py:36)。

- 复现：旧 GET 发出 → clear 成功，clearPending=false → 旧 GET 返回，已清理的 `CBT|爆品1→WSTALE` 被重新写回页面。
- 根因：布尔 clearPending 不表达请求属于哪一代计划；后端又按全局渠道/段名记录并全量清理。
- 影响：旧波次在新计划“复活”；一个页面导入/改参会影响其他页面的共享历史。这与 A03 的任务快照问题有关，但清理/读取竞态必须另设测试。
- 最小整改：计划变动递增同步代次，旧响应不得应用；清理按批次隔离，串行化并显示失败。计划、任务和历史记录使用同一身份约定，不再新增一套相似状态体系。
- 验收：旧 GET 迟到、两次 clear 乱序、新旧批次同名段、多页面并发，均不恢复或误清其他批次记录。

### A17 · UI 超时被当成可忽略网络错误

位置：[wms_wave_pick.py:224](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_pick.py:224)、[wms_wave_pick.py:353](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_pick.py:353)。

- 复现：模拟 `Locator.click` 因另一元素遮挡而超时，被 `_is_network_error` 判为 true。
- 根因：所有 Playwright/内建 TimeoutError，以及任意包含 timeout 的文本，都归为网络错误。
- 影响：页面控件失效这种应停止后续批次的问题，被记录成网络错误并继续扩大操作范围。
- 最小整改：依据失败阶段与实际网络证据分类；未知 UI/动作超时按非网络或结果未确认处理。
- 验收：网络中断仍遵守既定“不重试、最后统一核查一次”；遮挡、缺失控件、等待可见超时停止后续批次，不影响当前批次已完成结果。

### A18 · 文件保存入口缺少资源与内容边界

位置：[routes.py:158](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:158)。

- 复现：只有 ZIP 文件头加填充字节、并非工作簿的 1024 字节内容，仍返回 200 并调用写入。文件写入已 mock，没有保存垃圾文件到输出目录。
- 静态证据：整个请求一次性读入内存，无体积上限；同步磁盘写入位于异步路由；没有输出容量/保留边界。
- 影响：网络可达时可消耗内存与磁盘；即使只有合法用户，超大导出也可能阻塞请求处理。没有据此声称任意文件执行或路径穿越。
- 最小整改：按实际最大订单规模制定请求上限，分块限量接收；在资源受限条件下验证必要的 XLSX 包结构，不能为了校验引入无界 ZIP 解压；保存失败提供明确反馈。鉴权见 A01。
- 验收：合法大工作簿可保存；超限、伪 ZIP、异常 ZIP 条目、磁盘满均安全拒绝；不残留半文件、不使其他 API 长时间停顿。

### A19 · PID 校验不足以安全终止服务

位置：[start.sh:134](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/scripts/start.sh:134)、[start.sh:245](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/scripts/start.sh:245)。

- 复现：纯字符串执行原判断式，另一项目的 `uvicorn app.main:app` 通过；配置端口 800、实际参数 `--port 8001` 也通过。未调用 kill。
- 条件：过期/错误 PID 文件或 PID 复用。正常 PID 通常正确，不是每次停止都会误杀。
- 根因：两个无参数边界的子串替代进程身份。
- 最小整改：验证完整端口参数、实际项目解释器/进程身份，必要时记录创建时间；无法可靠确认时拒绝停止。
- 验收：其他项目、800/8001、失效 PID、复用 PID 均不得终止；隔离正确实例的 stop/restart 正常。

### A20 · 桌面输出路径漏迁移

位置：[macos_launcher.py:48](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/desktop/macos_launcher.py:48)、[config.py:183](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/core/config.py:183)。

- 复现：mock bundle/support 路径并禁止实际 mkdir，真实配置结果为 `/Applications/Audit.app/Contents/Frameworks/outputs`；未配置 WMS_OUTPUTS_DIR。
- 根因：资源目录被设为项目根目录；profile/downloads 已迁往用户目录，outputs 遗漏。
- 影响：只读安装位置可能导出失败；可写时也可能随应用替换而丢失文件。路径错误已确认，实际签名应用的权限失败未实机测试。
- 最小整改：显式设为用户 Application Support 下的 outputs，并同步保存位置说明。jobs/wave-records 已随 profile.parent 到用户目录，不应重复修复。
- 验收：资源目录只读时 Excel/PDF 仍可保存；应用升级后用户产物保留。

### A21 · 诊断和运行不是同一份配置语义

位置：[browser_smoke.py:14](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/scripts/browser_smoke.py:14)、[config.py:174](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/core/config.py:174)。

- 复现：WMS_BROWSER_CHANNEL 为空时实际 Settings 使用默认 Chromium 通道，smoke 却仍请求系统 chrome。浏览器启动和页面均为模拟，未访问 WMS。
- 根因：smoke 硬编码配置，不能证明用户实际选择的浏览器可运行。
- 另一个静态漂移点：[routes.py:78](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:78) 在请求时重读自动化配置，而 [main.py:24](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/main.py:24) 的执行器使用启动快照；运行中修改配置可能使校验与执行采用不同限制。
- 最小整改：复用通道解析/启动参数，smoke 保留独立临时 profile 和离线页面；自动化配置选择统一的启动快照或明确的更新机制，不引入两套隐式热更新。
- 验收：chrome、空通道、自定义通道均检查实际配置；配置的浏览器不可用不能因另一浏览器可用而显示通过。

### A22 · 测试没有隔离生产数据和权限

位置：[test_start_script.py:13](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/tests/test_start_script.py:13)、[test_start_script.py:45](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/tests/test_start_script.py:45)。

- 复现：mock 子进程捕获启动环境，注入的虚构生产 profile 被原样继承，且没有隔离 outputs；只有 PID/日志位于临时目录。
- 静态证据：测试以 0.0.0.0 和随机端口启动真实后端。当前测试没有提交业务任务，不能声称它已修改生产订单。
- 影响：普通测试可短暂开放具有生产会话能力、无认证的服务，并读取真实任务；后续扩展测试很容易越过生产边界。
- 最小整改：显式临时 profile/downloads/outputs/config，默认回环地址，业务执行禁用或 stub；全网卡参数解析单独模拟。
- 验收：所有可写路径位于临时目录，真实目录前后不变，不能启动生产浏览器，结束无残留进程。

### A23 · 全流程脚本与测试契约没有随 UI 更新

位置：[run_full_auto.py:51](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/scripts/run_full_auto.py:51)、[app.js:860](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:860)、[test-e2e.js:78](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/test-e2e.js:78)、[test-invariants.js:52](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/test-invariants.js:52)。

- 静态确认：全流程脚本只点击选择“生成”模式的按钮，未点击真正提交的 wmsRun；之后等待任意 job 终态，可能等 90 分钟或误用旧任务。
- 测试漂移：布局断言仍要求旧 200px 操作栏/1160px 页面；主题断言仍要求旧背景色。渠道不变量检查在 forEach 内 return 错误，不能返回到外层，相关错误标志不会按设计生效。
- 根因：测试与真实用户行为脱节，部分断言仅验证旧实现细节；大量模拟没有覆盖任务竞态及独立 Excel 统计口径。
- 最小整改：集成驱动与普通离线测试分离，默认不能触发生产；锁定本次新建 job ID；更新真正业务断言，并给测试本身注入错误样本验证能失败。
- 验收：模拟服务中只能提交一次新任务，旧任务不被认作本次；错误分配和统计样本必失败。不要直接补点击后就在生产上运行旧脚本。

### A24 · PDF 库需要有针对性的安全更新

位置：[requirements.txt:8](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/requirements.txt:8)、[pdf_centering.py:43](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/pdf_centering.py:43)、[wms_wave_print.py:867](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/automation/wms_wave_print.py:867)。

- 固定 pypdf 6.10.0。维护者公告 GHSA-fc8x-2rww-xw9m / CVE-2026-82398 涉及异常 PDF 对象解析的长时间运行，影响 `<6.15.0`，6.15.0 修复。项目使用的 PdfReader 低层解析路径涉及该函数。[官方公告](https://github.com/py-pdf/pypdf/security/advisories/GHSA-fc8x-2rww-xw9m)
- 边界：本项目 PDF 来自本机 Chrome 渲染 WMS 预览，不是一个任意 PDF 上传接口；**尚未确认可从网页远程提交恶意 PDF 字节利用该缺陷**。没有执行恶意 PDF。
- 其他匹配：outline 遍历问题 `<6.16.1`、TreeObject.insert_child 问题 `<6.16.0`、XForm 文本提取问题 `<6.16.1`。本项目未调用对应 outline/insert_child/pypdf.extract_text，不能因用了 PdfWriter 或 pdfplumber 就认定这些路径可达。[outline 公告](https://github.com/py-pdf/pypdf/security/advisories/GHSA-23w6-3w8w-8484)、[TreeObject 公告](https://github.com/py-pdf/pypdf/security/advisories/GHSA-jp53-mhqp-8xcg)、[XForm 公告](https://github.com/py-pdf/pypdf/security/advisories/GHSA-763m-79hh-57f2)
- 最小整改：选择兼容版本并定向回归；6.16.1 是上述四项的共同修复下限，不是全部已知漏洞的最终结论。若将来支持任意 PDF 输入，必须重新评估 CPU/内存隔离，线程超时不能终止已卡住的解析。
- 验收：单/多页、条码、图片、波次号、页数、居中位置和输入顺序合并保持一致，再次扫描依赖。

## P3：低优先级加固与清理

### A25 · 安装和测试工具链缺少统一的安全基线

位置：[setup.sh:8](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/scripts/setup.sh:8)、[requirements.txt:5](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/requirements.txt:5)。

- 本机 pip 为 25.0.1；安装脚本未规定其版本，其他机器取决于创建虚拟环境的 Python。命中的 pip 公告属于安装/下载恶意包或恶意索引阶段，不是运行时 API 漏洞。
- 版本核对：CVE-2025-8869 修复于 25.3，CVE-2026-1703 于 26.0，CVE-2026-3219 / 6357 于 26.1，CVE-2026-8643 于 26.1.2，CVE-2026-13346 于 26.2；这些数字仅针对已核查的公告。[pip 官方发布记录](https://pip.pypa.io/en/stable/news/)、[pip 维护者对 26.1 安全修复的说明](https://sichard.ca/blog/2026/04/whats-new-in-pip-26.1/#security-fixes)
- 排除/限制：本机 Python 3.12.14 有 tarfile.data_filter，不进入 CVE-2025-8869 的旧 fallback；CVE-2026-13346 要求恶意索引，关键新增风险为 `pip download --only-binary`，仓库脚本没有此用法。[Python tar 安全公告](https://mail.python.org/archives/list/security-announce@python.org/thread/IF5A3GCJY3VH7BVHJKOWOJFKTW7VFQEN/)、[Python 索引安全公告](https://mail.python.org/archives/list/security-announce@python.org/thread/L2BNQGGVQCEV7DROOORQ7WFKKFF2OOQX/)
- pytest 8.4.0 命中本地共享临时目录的符号链接问题，9.0.3 修复；当前系统临时目录权限 0700 降低跨用户攻击面。本机 pytest-asyncio 1.0.0 要求 pytest `<9,>=8.2`，不能只改单包版本。[pytest 原始报告](https://github.com/pytest-dev/pytest/issues/13669)、[pytest 9.0.3 发布说明](https://github.com/pytest-dev/pytest/releases/tag/9.0.3)
- 最小整改：明确 bootstrap 安装工具版本，区分运行/测试/构建依赖，固定已验证的传递依赖；联合选择 pytest 兼容组合。无需“所有包一律升最新版”。
- 验收：干净环境安装、依赖兼容检查、隔离测试、复扫通过。桌面打包已经排除 pytest/httpx 等，不能把开发依赖混装问题照搬为所有发布物都包含。

### A26 · 数量字典混入继承属性

位置：[core.js:136](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/core.js:136)、[core.js:153](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/core.js:153)。

- 复现：订单号为 constructor、toString、__proto__ 时，`in` 命中对象原型已有键，数量未正确写入，后续求和可能变成函数/对象字符串而非数字。
- 前提：异常导入文件具有这类订单号，真实 WMS 常规订单号不一定允许出现；低概率，不应夸大为已确认的原型污染漏洞。
- 最小整改：使用无原型字典或 Map，并在输入边界确认订单号/数量合法。
- 验收：普通订单和上述键均得到稳定数值，重复订单合并契约不变。

### A27 · 可确认的遗留配置与失效计算

位置：[macos_launcher.py:54](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/desktop/macos_launcher.py:54)、[app.js:1005](/Users/jp/Documents/ChatGPT/波次规划系统改造/planner/app.js:1005)。

- 引用核对：WMS_SECONDARY_DOWNLOADS_DIR 只在桌面启动器设置，后端已无消费者；`--shellmax` 仍按 920＋200 的旧布局写入，但当前生产 CSS 无读取，只有旧测试关注它。`--gutter` 自定义属性也只有声明/写入，没有消费位置。
- 影响：注释/配置让接手者以为存在额外下载副本和动态最大宽度规则，实际上没有对应行为。
- 最小整改：确认外部集成没有额外约定后，删除无效环境变量写入和失效属性计算/过期注释；是否移除整个 syncGutter 要连同调用点验证。CSS 原生 scrollbar-gutter 布局规则不依赖这些变量，保持不变。
- 验收：生成页面的实际布局和文件保存路径无变化，旧测试随契约校正；同步重新构建 HTML，不删除其他仍生效的桌面运行配置。

### A28 · 长期保留规则未形成闭环

位置：[job_manager.py:85](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:85)、[job_manager.py:168](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/services/job_manager.py:168)、[routes.py:190](/Users/jp/Documents/ChatGPT/波次规划系统改造/wms/project/backend/app/api/routes.py:190)。

- 静态证据：list 只显示当天最多 50 个任务，但内存 jobs/tasks 没有相应裁剪；当天日志按事件持续增长并重复整体序列化。输出列表每次扫描目录全部 Excel 后排序取前 50；历史文件并不会因此删除。
- 影响：长期不重启、大量任务/导出时内存、扫描成本和磁盘占用持续增长。未做生产规模压测，不声称当前已经存在可感知卡顿。
- 最小整改：先明确用户需要的保留周期和数量，终态任务释放执行句柄，任务/文件按可恢复策略保留或归档；避免每次轮询反复读取无关历史。
- 验收：隔离生成大量任务元数据，终态内存有界、当天查询仍正确；文件清理必须可预览并保留正在使用的产物。审计阶段未删除任何订单或输出文件。

## 验证记录

### 基线

Discovery 已在同一源码提交完成以下安全检查；本轮源码未变化，未把旧基线重复包装成新的现场验证：

- 后端 API、任务管理、波次记录：27 项隔离测试通过。
- 自动化 common/export/generate/pick/print/PDF：57 项通过；浏览器/页面均为模拟，PDF 为本地测试样例。
- 前端纯计算一致性：14 个场景、24 个选择组合通过。
- 依赖兼容检查通过；这只说明声明依赖不冲突，不等于安全扫描通过。
- 内存重新组装 HTML 后与两份现有生成文件一致，没有运行覆盖式构建。

### 本轮新增证据

| 检查方式 | 样例与结果 |
|---|---|
| 执行真实前端函数，关闭初始化/DOM 重绘，网络 stub | 三段 60 单的旧任务被导出为 180 单；乱序轮询清除新任务并重复上传；统一 800 变实际 400；800 单 SKU 两个子段计数仍为 800；clear 后旧 GET 恢复 WSTALE |
| 执行真实自动化方法，模拟页面 | 非截单提醒被确认；两个确定候选仍点 first；相同总数旧结果通过；UI 遮挡超时被归网络；两个新导出按顺序选；已提取号码后清理异常丢结果 |
| 隔离 FastAPI 路由，执行器及文件写入 mock | 无认证创建 202；外站 Origin 清理 200/调用 1 次；字符串订单拆成字符；数字订单返回 500；伪工作簿内容保存 200 |
| 模拟持久化与恢复 | running 恢复后 tasks=0、拒绝新任务；孤儿取消落盘调用 0；磁盘写错不报告；损坏记录当空表后被新记录覆盖 |
| 模拟进程命令和桌面路径 | 800 匹配 8001、其他项目也匹配；桌面 outputs 落资源目录；配置空通道但 smoke 用 chrome；测试继承虚构生产 profile |
| 在线依赖版本核查 | 40 个本地已安装 Python 包，加声明 PyInstaller 与内置 SheetJS，共 42 个版本查询；按调用路径和维护者公告人工复核，不把别名或误报累加成漏洞数量 |

没有执行：真实 WMS 导出/生成/打印/拣货、带生产 profile 的测试、实际 stop/restart、浏览器压力测试、恶意 PDF/包执行、GUI E2E 全套、另一台 Mac 的实际安装。Chrome/qpdf 等外部二进制及 OS 不在本次 Python/JS 依赖版本扫描覆盖范围内。

## 安全复核：已排除与不适用项

- **SheetJS 两项扫描匹配排除。** 0.20.3 高于 CVE-2023-30533 的修复下限 0.19.3，也高于 CVE-2024-22363 的修复下限 0.20.2。[发布方原型污染公告](https://cdn.sheetjs.com/advisories/CVE-2023-30533)、[发布方 ReDoS 公告](https://cdn.sheetjs.com/advisories/CVE-2024-22363)。本地 951,904 字节文件与官方 CDN 同版脚本 SHA-256 一致：`cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41`。npm 已停留旧发行版，不能用其“无 patched npm 版本”推导 CDN 0.20.3 未修复。[官方分发说明](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
- **Starlette 的其他命中不自动算本项目可利用。** 未使用 request.form/multipart，未定义 HTTPEndpoint 方法分派，也未基于 request.url 做路径/主机授权；Windows StaticFiles UNC 公告不适用于本次 Mac 环境和当前静态文件路由。对应原始公告：[表单限制](https://github.com/Kludex/starlette/security/advisories/GHSA-82w8-qh3p-5jfq)、[multipart](https://github.com/encode/starlette/security/advisories/GHSA-2c2j-9gv5-cj73)、[HTTPEndpoint](https://github.com/Kludex/starlette/security/advisories/GHSA-x746-7m8f-x49c)、[URL 主机](https://github.com/Kludex/starlette/security/advisories/GHSA-jp82-jpqv-5vv3)、[Host 路径](https://github.com/Kludex/starlette/security/advisories/GHSA-86qp-5c8j-p5mr)、[Windows UNC](https://github.com/Kludex/starlette/security/advisories/GHSA-wqp7-x3pw-xc5r)。版本更新仍应重新核查，不因当前调用不到而永久忽略。
- **没有确认路径穿越/命令注入。** 现有下载路由 resolve 后检查允许目录；波次号限制字符，qpdf 使用参数数组而非 shell 拼接。没有把“使用 subprocess”本身列为漏洞。
- **没有业务 SQL/ORM、迁移系统、JWT、密码数据库或 RBAC 实现。** 所以不存在可审计的业务 SQL 索引、N+1 ORM、JWT 签名算法等；不是建议为此新建数据库或权限框架。SQLite 只用于浏览器下载历史修复，表名来自固定白名单。
- **未确认可利用的 XSS、反序列化或用户参数 SSRF。** 当前审阅未形成足够证据；不能将此表述为全面渗透测试通过。WMS 预览 HTML 在专用浏览器中重新渲染是外部内容信任边界，后续扩展来源时需重审。
- **会话权限在专用浏览器 profile 内。** 本轮没有导出 cookies、订单、凭据或上传私有源码。公开漏洞查询只发送公共包名/版本。`.gitignore` 排除运行数据只是一层防误提交，不等于对本机其他用户、备份及网络 API 的访问控制。
- **无 AWS、云资源、容器、CI/CD 配置可审计。** 不建议为完成清单而增加它们。仓库未建立自动回归门禁是交付现状，先解决 A22/A23 的测试可信度再决定最小 CI。

## 撤回的误判与待确认区域

以下不计入上述 28 项确定整改事项，避免把模拟器制造的异常或未知业务当成真实故障：

1. **撤回“普通磁盘错误导致一段同时计成功和失败”的已确认结论。** 任意抛错 progress 回调确实能暴露 append 两次的结构问题；但当前 JobManager 回调内部已吞普通持久化异常，没有证明该模拟 OSError 的真实传播路径。真正已确认的问题是 A12 的静默持久化失败。后续调整错误策略时要补每输入段仅一个 outcome 的回归，不能用这个假设去扩大本轮故障清单。
2. **POTENTIALLY DEAD CODE：生成流程的多块累计路径。** 主入口超过 700 直接跳过，而内部仍保留分块循环及“累计”注释。正常路径最多一块，但 helper/测试仍可能引用；应查清契约后简化，不直接删除保护。
3. **历史下载修复不是已确认死代码。** `shared_proto_db` 修复与过去已解决的故障有关。A13 要求独占与适用范围，不授权删除修复或恢复 10 秒落盘等待方案。
4. **打印 iframe 分支、qpdf 取消后的子进程回收、排序规则第三项残留**存在需要专门隔离验证的边界，但本轮未取得足够现场/回归证据作为独立确定缺陷。不应凭静态怀疑改动用户已经确认的打印入口和排序行为。
5. **失败导入保留旧计划、同一天合并 PDF 的文件命名与覆盖口径**涉及产品选择。不能未经确认改变现有外部行为；也不能声称所有产物已按任务永久不可变保存。

## 必须保留的业务契约

后续整改不能借“去腐败”改变这些已明确的业务行为：

- 建立波次前分页设为 1000；已选数量与搜索结果的待处理数量一致，并考虑取消订单。
- 生成/拣货生产提交不自动重试；中断恢复不得自动重放。
- 打印/拣货并行度保持 5；打印最终按输入顺序合并，不能按完成时间排序。
- 打印仍从目标行“更多”菜单进入，不直接采用页面顶部快捷打印按钮；仅波次未找到按既定规则跳过，其他错误停止后续批次。
- 无头任务全程无头，不引入有头绕过、重复导出提交、独立下载会话、轮询 crdownload 或用户已经放弃的 10 秒落盘等待方案。
- “普通”进化后的吸收仅针对允许渠道关闭的分段，CBT/CBS 不被吸收；退化可还原来源。
- 客户统计按参与导出的订单计算；未识别订单保留客户总量、分类和 SKU 统计，但不纳入渠道构成的数量/占比分母。
- 分类 SKU 工作表与渠道统计中的部分原始总量沿用当前既定口径，不擅自把所有表都改成勾选后口径。A15 是明确的跨子段映射错误，不是笼统改变工作表统计定义。
- 前端源码组装与两个生成 HTML 产物保持一致；它们是构建输出，不是应手工分别维护的第二套实现。

## 进入 PLAN 的输入

本阶段停在 Audit。下一阶段应制定可逐批验证、可回退的整改计划，不一次性重写系统。

建议顺序：

1. 明确服务访问边界、修复已可达依赖问题，同时隔离测试的生产权限（A01/A02/A22）。
2. 统一计划—任务—波次身份和异步代次，再修规划计算（A03/A04/A05/A15/A16）。
3. 收紧生产提交目标与任务归属证据（A06/A07/A08/A09/A17）。
4. 完成中断恢复、结果保留、持久化与进程独占（A10/A11/A12/A13）。
5. 补输入边界和可靠交付，最后做小范围代码删除、依赖与资源治理。

优先统一的是**身份、状态生命周期、配置读取和结果/清理边界**，不是增加 Repository、事件总线、微服务或大规模组件拆分。每批先补能够复现该错误的测试，再改最小范围，并对照以上业务契约验收。
