# 源码阅读与维护导览

本文说明模块边界，具体分支和例外以相邻源码注释与回归测试为准。第三方 SheetJS、内联字体和构建产物不手工逐行维护。

## 从哪里开始

| 关注点 | 源码入口 | 职责 |
| --- | --- | --- |
| 订单识别、分段、统计、Excel | `planner/core.js` | 业务计算与工作簿规格/文件写出 |
| 勾选、参数、普通进退化、任务展示 | `planner/app.js` | 页面状态、缓存失效、API 交互 |
| 页面结构与样式 | `planner/part1-body.html`、`planner/part0-head.html` | DOM 契约、主题、布局、滚动 |
| 单文件页面构建 | `planner/build.py` | 同步根目录 HTML 和服务静态页面 |
| 后端启动和关闭 | `wms/project/backend/app/main.py` | 本机互斥、服务对象、清理生命周期 |
| HTTP 请求 | `wms/project/backend/app/api/routes.py` | 请求校验、任务入口、文件响应 |
| 任务和重试 | `wms/project/backend/app/services/job_manager.py` | 状态、检查点、结果留存、联程打印 |
| 提交快照和波次索引 | `services/job_plans.py`、`services/wave_records.py` | 恢复导出、按规划回填；路径相对后端 app |
| 截单 | `services/cutoff_schedule.py`、`services/cutoff_merge.py` | 时间边界、阶段推进、订单文件合并 |
| WMS 页面操作 | `wms/project/backend/app/automation/` | 导出、生成、拣货、打印及公共页面适配 |
| 启动和部署 | `wms/project/scripts/`、`wms/project/desktop/` | 环境安装、服务管理、桌面包 |
| 回归测试 | `planner/test-*.js`、`wms/project/tests/` | 计算守恒、UI、故障恢复及持久化契约 |

## 订单与选择的口径

- `orderNo` 是订单身份；订单数与商品件数是不同指标。
- `records` 是导入底稿；分析结果和普通吸收结果是派生数据。参数改变或来源勾选改变时必须使相应缓存失效。
- `hot/paper/multi/mix` 是业务分类。显示文字不能替代分类判断，尤其波次表中的爆品也可能显示为“单件”。
- 渠道与分段都打开才参与激活统计及导出。普通吸收来源的关闭分段仍保留在原始分析中，不能再作为激活分段重复导出。
- 爆品容量只作用于爆品。单件按段数连续均衡，同 SKU 不拆；生成前的 WMS 搜索上限另由后端整批校验。
- 混件共享 SKU 的关系具有传递性，连通组件应整体分配。单渠道最终分段必须无重单、漏单和外来订单。
- USPS-H/G 内部独立处理；波次表显示 USPS，回填仍依赖内部身份。

## 任务与文件的边界

生成请求提交后，订单清单、计划身份和工作簿快照属于该任务。页面后来调整的分段不能替换原输入。任务失败或取消后，导出仍基于完整提交快照，只填写已确认的波次号。

生成节点的状态依次为 `pending`、`searching`、`uncertain`、`done`。`uncertain` 在生产提交前持久化；若未取得可靠结果，不能自动重提。重试会创建关联的新轮次，保留 `done`，仅续跑可靠的未完成节点。

任务终态与执行协程结束不同：浏览器可能仍在关闭。并发限制还要检查执行句柄，不能只检查 `status`。清理异常不撤销已确认业务结果。

打印节点文件必须通过结构、页数和哈希检查才能复用。并发完成顺序不影响合并顺序，缺少任一目标波次不能发布完整成功结果。跟随打印要求生成成功、规划文件已保存并验证、前一任务清理完成。

规划 Excel 由前端根据提交快照生成，再上传保存。关闭页面期间完成的任务在恢复历史时补做导出；保存失败的重试只保存文件，不重新生成波次。

## 截单的边界

每次运行固定自己的时间范围：预导出覆盖截单前一周至预导出边界，增量从边界前 30 秒至截单时刻。重复范围按文本订单号去重，增量整行覆盖同号旧记录。动态 SKU 列按列名对齐，最终回读校验后发布文件。

这不是订单状态同步：预导出后取消、且未出现在增量中的订单仍可保留。调度依赖后端进程运行，不负责唤醒休眠电脑。后台产出文件，用户点击后才在页面加载分析。

## 修改后验证

注释应解释输入输出、单位、状态边界和处理原因，避免复述每行语法。规则变化时同步修改相邻注释与测试，不把旧设计意图写成当前已实现的保证。

前端修改后运行 `wms/project/.venv/bin/python planner/build.py`。纯计算回归可从 `node planner/test-core.js` 与 `node --test planner/test-audit-regressions.js planner/test-paper-segments.js` 开始。后端在 `wms/project` 下运行 `.venv/bin/python -m pytest`。

浏览器测试使用 `planner/test-helpers.js` 创建独立 Chrome 和模拟服务；后端公共夹具隔离运行目录和生产入口。不要用真实 WMS 任务来验证纯注释或页面样式修改。
