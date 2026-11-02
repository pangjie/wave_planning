# 单件分段「库位优先」策略 · 设计稿 v3（状态变更测试后）

状态：**已实现并部署到 8000（2026-10-30）**；真实 20,265 单页面验收通过。
测试文件：原始 `ParcelOutbound_20261031022801.xlsx`（20,265 单）。
范围：仅 `planner/` 单件（`paper`）分段；不改爆品/多件/混件，不改后端 WMS 自动化。

## 0. 结论

1. 20,265 单全链路（后端合并 → 渠道 → A/B → 9 表导出）已跑通；策略 B
   无丢单、无重单、无库位/SKU 拆分。
2. 单件池：20,265 单中按渠道爆品线拆分后，真正参与单件的是 **5,130 单**；
   其余是爆品/多件/混件，不受本策略影响。
3. 策略 B 把各渠道最大段 SKU 数之和从 **1,218 降到 672（−45%）**，最差渠道
   306 → 159；最大段订单数与 A 相差 **0–2 单**。
4. 状态变更矩阵（分析/导出层）已反复验证：
   - 19 组定向参数/模式组合；
   - 60 组随机参数（hotLine/capacity/paperSegs/multi/mix/absorb/merge/USPS/渠道覆盖）；
   - 40 组随机渠道/分段开关与导出选择；
   - **零漏单、零重单、零“订单性质与分段性质矛盾”**。
5. 页面显示与分段实际内容的一致性（DOM ↔ analysis ↔ 9 表）必须在实现后用
   浏览器矩阵验证；这是**发布阻塞项**，未通过不发布。现有分析层矩阵不能替代它。
6. 你的三点确认已并入：
   - 离线单文件只支持策略 A；
   - 700 只按“分段池 size”判断，不做单库位单独规则；
   - 分段内部订单顺序不重要，只保证分段池内容，不要求 `单件SKU序列` 重排。
7. 库位表不公开：本地 JSON，不嵌入 HTML、不进 Git；页面同源加载；公开克隆/离线
   只支持 A。

## 1. 策略与算法

### 1.1 A：SKU 均衡（现状）

按 SKU 聚组 → 订单数降序 / SKU 字典序 → `linearPartition` 连续切 K 段；
同一 SKU 不拆。保持不变。

### 1.2 B：库位优先

1. 每渠道取单件订单（爆品线以下）。
2. 并查集合并 `SKU` 与 `库位`；同一订单异常多库位也合并；形成分量。
3. 分量按库位优先级**降序**排序；多库位分量取最大优先级；同值按库位编码。
4. `linearPartition` 按分量订单数连续切 K 段，最小化最大段订单数。
5. 无效分量（库位缺失/无优先级/XN 无需拣货）不参与排序；整体并入最后一组；
   warning 列出库位；不阻断、不丢单。
6. 生成 `单件paper-1..n`；同库位/同 SKU 不拆。
7. **段内订单顺序不做要求**；WMS 决定实际拣货顺序。只保证分段订单池内容。
8. `absorb=4` 时单件已被全部吸收进混件，不存在单件分段；策略 B 不创建单件段。

### 1.3 均衡与类型

- 主目标仅“最大段订单数最小”；SKU 均衡是自然结果，只观测。
- 库位分量比 SKU 组粗，最大段可能比 A 多 1–2 单；测试在 0–2 内。
- 兜底按“分量”整体进最后一段，保持原子性；不丢单。
- 类型约束（运行期与测试都校验）：
  - hot：订单类型必须 `单品单件`，且该渠道该 SKU 单件订单数 ≥ hotLine；
  - paper：`单品单件`，且 < hotLine；
  - multi：`单品多件`；
  - mix：`多品混合`，或按吸收档位被吸收的 paper/multi；
    - absorb=1：mix 只能有 `多品混合`；
    - absorb=2/3：mix 可以有多件（被吸收），不能有单件；
    - absorb=4：单件/多件都可进 mix，且不再有 paper/multi 分段；
    - 任何档位 hot 订单不得进 mix。
- 任何不满足的类型组合视为内部错误；`analyzeChannel` 在既有守恒检查后增加
  类型断言，测试和运行时都拒绝矛盾结果。

## 2. 库位表：本地存储，不公开

### 2.1 数据事实

`Locationexport_20261030035813.xlsx`：

- 16,393 行；编码唯一；8 库区（B/F/C/D/A/Y/E/XN）。
- `Area Type` 全部「拣选区」；类型「货架」16,289、「地堆」104。
- 需要 `Location Code/库位编码` 与
  `Picking recommendation priority/拣货推荐优先级`。
- 优先级 1–100,001；16,380 个不同值，13 个重复；重复按库位编码稳定排序。
- 展示优先级与推荐优先级逐行相同；使用推荐优先级。
- XN 虚拟库区（13 行）视为无需拣货：不进序列；若订单引用，按兜底处理。
- 表内未被订单引用的空库位天然不进序列。

### 2.2 本地文件与加载

```
planner/location-source/                 # 原始 xlsx（gitignore）
planner/location-priority.local.json     # 生成物（gitignore）
planner/build_locations.py               # 生成脚本
wms/project/frontend/dist/location-priority.json   # 运行时副本（gitignore）
```

- JSON：`version`、`source`、`count`、`nonPicking`、`priority`。
- `build.py` 只把 JSON 复制到 `frontend/dist/location-priority.json`，
  **不嵌入 HTML**。
- 页面启动 `fetch('/location-priority.json')`：
  - 成功：启用策略 B；版本用于 planIdentity；
  - 失败（公开克隆/离线）：B 禁用，A 正常；若记住 B，回退 A 并提示。
- 服务端无需改：现有静态路由可返回该文件。
- `.gitignore`：

```
/planner/location-source/
/planner/location-priority.local.json
/wms/project/frontend/dist/location-priority.json
```

- 离线单文件 HTML 无法 fetch，只支持 A（已确认）。
- 公开仓库不含库位数据；运行时 Console 才支持 B。

### 2.3 更新流程

```bash
cd "$HOME/Documents/WavePlaning@DSH"
mkdir -p planner/location-source
cp ~/Downloads/Locationexport_YYYYMMDDHHMMSS.xlsx planner/location-source/
wms/project/.venv/bin/python planner/build_locations.py \
  planner/location-source/Locationexport_YYYYMMDDHHMMSS.xlsx
python3 planner/build.py
cd planner && node test-core.js && node test-consistency.js
cd .. && ./deploy/update-frontend.sh
```

- JSON 变化 → 版本变化 → 策略 B 的 plan_id 变化；旧波次号不会复用。
- 只更新 JSON 不重建/部署不会生效。

## 3. 700 规则（仅分段池 size）

- 前端常量 `PAPER_SEGMENT_LIMIT = 700`（WMS 强制设定，不读配置文件）。
- 仅在「生成波次」、无运行/重试任务时，遍历**激活**单件分段
  （含兜底最后一段），任一段 `orderCount > 700` → 提交前禁用「开始任务」，
  提示分段名与单数。
- **不做单库位独立规则**：单个库位 >700 时，它所在分段必然 >700，分段检查已覆盖。
- 取消该分段/渠道后，若不再超限，按钮恢复；运行中/重试不受当前规划影响。
- 后端 `validate_generation_segments` 仍是最终防线；不自动拆库位。
- 真实 20k 文件按渠道无 >700；实现时用 701 单合成夹具覆盖按钮禁用。

## 4. 全流程测试结果

### 4.1 固定参数（20,265 单）

| 项目 | 结果 |
| --- | --- |
| 合并订单 | 20,265 |
| 渠道 | 13（11 个有单件） |
| 原始单品单件 | 18,244 |
| 爆品线后参与单件 | **5,130** |
| A / B 各渠道最大段 SKU 数之和 | 1,218 → **672（−45%）** |
| 单渠道最差 SKU 数 | 306 → **159** |
| 最大段订单数差 | 0–2 单 |
| 9 表 | 全部生成，104 个波次引用，9.17MB |
| 解析/分析/B/导出 | 724ms / 24ms / 23ms / 41ms |

示例（A → B 最大段 SKU）：CBT 99→49、Gofo 306→159、USPS-G 233→118、
SpeedX 220→119、SwiftX 162→99、UPS 94→60。

异常：1 单引用 `XN-TH`（USPS-G），B 并入最后一段，warning，无丢单。

### 4.2 状态变更矩阵（分析/导出层）

| 测试 | 组数 | 失败 |
| --- | --- | --- |
| 定向参数/模式组合 | 19 | 0 |
| 随机参数 fuzz | 60 | 0 |
| 随机渠道/分段开关 + 导出选择 | 40 | 0 |

覆盖：

- hotLine 1/3/5/10/15/20/30；capacity 100–1000；
- paperSegs 1–8；multiSegs/mixSegs 1–4；
- absorb 1/2/3/4；normal/merged；USPS 开/关；CBT 按渠道覆盖；
- absorb=4 时 B 不创建 paper；paper/multi 全进 mix；
- 每个组合检查：渠道订单守恒（无漏/重）、hot/paper/multi/mix 类型规则、
  B 的 paper 集合等于 A 的 paper 集合、同库位/同 SKU 原子；
- 选择开关：随机选渠道/分段后导出，选中段订单集合无重复/遗漏。

**已补浏览器验收**：8000 页面导入 20,265 单后，B 策略、参数/吸收/归并/USPS 变化、
DOM↔analysis↔9 表、700 前置禁用、计划身份均通过。

## 5. 状态变更一致性（发布阻塞门槛）

### 5.1 要防的问题

操作中会频繁：开关渠道/分段、调整爆品线、容量、paperSegs、multiSegs、mixSegs、
吸收档位、拆分/归并、USPS、策略 A/B、导入新文件、刷新。每次变化后必须：

1. 每个渠道的全部订单恰好出现一次（无漏/重）；
2. 每个订单的原始类型与所在分段 kind 符合第 1.3 节规则；
3. 页面显示的每个分段（名称、订单数、SKU 数、开关状态）与 `curAnalysis()` 一致；
4. 9 表导出只含当前选中渠道/分段，订单集合与 analysis 完全一致；
5. 重新分段后旧波次号清空；plan_id 变化；不把旧波次套到新分段；
6. 策略 A 的导出保持原样。

### 5.2 浏览器测试矩阵（已执行；含 8000 真实 20k 文件）

- 合成夹具：多渠道、hot/paper/multi/mix、USPS-H/G、共享库位、XN、缺失优先级、
  701 单分量；不提交真实订单。
- 每个动作后：
  - 读 `window.__dshTest.state.analysis` 与 DOM `.seg-line`
    （`data-seg`、`名称·订单数·SKU数`、`on/off`）逐项比对；
  - 调 `buildExport` 读回 9 表，按选中段比对订单集合；
  - 检查 plan_id、waveNos、按钮 700 状态。
- 定向动作：
  - 每个渠道/分段开关；全选/全否；随机勾选；
  - hotLine 边界（SKU 数 = hotLine-1 / hotLine / hotLine+1）；
  - capacity、paperSegs、multiSegs、mixSegs、absorb 1–4；
  - 统一参数与按渠道覆盖混合；参数变更只影响目标渠道；
  - 拆分/归并；USPS 开/关；普通进/退化；
  - 策略 A/B 切换；导入新文件；刷新恢复。
- 随机 fuzz：200 组动作序列（固定种子，可复现），每步执行 5.1 全部断言；
  失败输出种子与动作序列。
- 稳定性：完整浏览器套件连续跑 3 次，无 flake；不允许 skip/xfail。
- 700：701 单合成段，提交前按钮禁用；取消该段后恢复；后端零请求。
- 离线：file:// 页面 B 禁用、A 正常；Console + 本地 JSON  B 正常。

### 5.3 运行期保护

- `analyzeChannel` 在现有“订单守恒”检查后再做类型断言；发现矛盾直接抛错，
  不渲染错误计划。
- 前端在每次 reanalysis 后统一走 `render()`；不做局部猜测更新。
- `planIdentity` 包含策略与库位表版本；切换/重分段清波次历史。

## 6. UI / warning / 身份

- 「单件」表头 → button；CSS `::after` 显示 `·SKU` / `·库位`；不触发表头全选。
- 策略记忆 localStorage；无表/离线回退 A。
- 切换后清波次、失效分析、重选单件段、重绘。
- warning：异常库位列表，规划概览常驻 + 日志 `warn`；不阻断。
- planIdentity 加策略 + 表版本；不写入工作簿。
- 700 只按分段池 size 判断（第 3 节）。

## 7. 代码改动清单（仅前端）

| 文件 | 改动 |
| --- | --- |
| `.gitignore` | 忽略本地库位表/源/dist JSON |
| `planner/build_locations.py` | 新增 |
| `planner/location-priority.local.json` | 本地生成，不进 Git |
| `planner/location-source/` | 原始 xlsx，不进 Git |
| `planner/build.py` | 复制 JSON 到 dist；不嵌入 HTML |
| `planner/core.js` | 库位列识别/记录；B 分量/排序/切分/兜底；类型断言；absorb=4 跳过 B |
| `planner/app.js` | 表头按钮、fetch 本地表、策略记忆、700 常量/前置禁用、warning、planIdentity |
| `planner/part0-head.html` | 按钮/标记/警告样式 |
| `planner/part1-body.html` | warning 容器（如需要） |
| `planner/test-*.js` | 合成夹具、单元、状态矩阵、浏览器 fuzz、700、离线 |
| `README.md` / `docs/CODE_GUIDE.md` / `docs/DEPLOYMENT.md` | 策略、库位表位置/更新、不公开、离线限制 |

**不改**：`wms/project` 后端、WMS 选择器、任务协议、9 表结构、爆品/多件/混件算法。

## 8. 测试与验收

### 8.1 分析/导出

- 第 4.2 矩阵：0 失败（已跑）。
- 新增实现后重跑：同一矩阵 + 200 组动作 fuzz。
- A 9 表 golden；B 9 表读回；订单守恒/类型/原子性。
- absorb=4：无 paper/multi 段；B 不创建；无漏单。
- 700 只按段大小；701 夹具。

### 8.2 浏览器

- 第 5.2 矩阵；DOM/analysis/export 三重一致；连续 3 次无 flake。
- 真实 20k 文件只做数据/导出 dry-run，不进浏览器测试。

### 8.3 性能/构建

- 20k 单解析/分析/B/导出在现有量级；
- 两份 HTML 一致；dist JSON 可选；离线 A。

## 9. 实施顺序

1. 本地库位表生成/加载 + `.gitignore` + 构建复制 + 离线回退。
2. 数据层：库位列/记录；A 输出不变。
3. 算法层：B 分量/排序/切分/兜底/类型断言；absorb=4 跳过 B。
4. 700 常量/前置禁用 + warning + planIdentity。
5. 表头切换/策略记忆/本地 fetch；浏览器矩阵。
6. A golden、全套回归、20k dry-run。
7. `update-frontend.sh` 发布（不重启后端），发布前必须通过第 5.2 浏览器矩阵。

## 10. 风险

| 风险 | 对策 |
| --- | --- |
| 公开泄露库位 | 本地 JSON + gitignore；HTML 不嵌入；公开克隆 A-only |
| 库位表过期 | 缺失/异常→最后一段 + warning；固定更新流程 |
| 状态变化漏/重/类型矛盾 | 运行期守恒+类型断言；200 组动作 fuzz；DOM/export 三重比对 |
| 页面与 analysis 不一致 | 统一 `render()`；每次动作后 DOM 比对；发布阻塞 |
| 700 误判 | 只按激活分段池 size；取消分段恢复；后端最终校验 |
| absorb=4 B 误建段 | 无 paper 段时 B 不执行；矩阵已覆盖 |
| 计划身份 | 策略+表版本进签名；WMS UI 测试 |
| 离线 B | 明确仅 A；Console 支持 B |
| A 回归 | 9 表 golden + 全套测试 |

## 11. 状态

- 三份确认已并入；实现完成并于 2026-10-30 发布到 8000（前端热更新，后端未重启）。
- 分析/导出层矩阵通过；浏览器 DOM/analysis/9 表、700、离线 A-only 均通过。
- 真实 20,265 单页面验收通过；未提交任何 WMS 任务。
- 代码改动尚未 commit/push；库位表相关文件保持 gitignore。
