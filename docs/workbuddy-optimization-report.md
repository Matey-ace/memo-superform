# Memo Superform 优化执行报告（WorkBuddy）

日期：2026-10-08。工作目录：`C:\Users\Matey\Documents\MeMo`。
执行依据：[workbuddy-optimization-plan.md](workbuddy-optimization-plan.md)。
原始证据：`_verification/workbuddy-optimization/`。

本文把结论分成三类：**已测量**（有原始样本）、**已修改并验证**（有前后对照与回归）、
**待真实环境验收**（本轮未执行或无法在本机证明）。

---

## 1. 目标与边界（复述）

建立可重复的性能与稳定性基线，只对**测量确认的瓶颈**做小步局部优化，交付修改前后证据。

- 重点：大词库仪表盘性能、重复切换后的资源释放、首屏加载、必要的 SQLite 热查询。
- 保留：学习、统计、账号隔离、内容编辑、Live2D、TTS、更新的既有行为。
- 不做：模块重写、数据库格式迁移、新依赖、批量清理、真实云端写入、发布与推送。
- 测试约束：独立 `MEMO_DATA_DIR`、合成数据（固定种子）、随机本机端口、只绑定 127.0.0.1。

## 2. 起点与环境

| 项 | 值 |
|---|---|
| 分支 | `codex/full-quality-hardening` |
| HEAD | `59f671117bde16f0f8d45bcc10e21c57f3bd5cd2` |
| 起始工作区 | 仅有未跟踪的 `docs/workbuddy-optimization-plan.md`，其余干净 |
| 系统 | Windows 11，`10.0.26200` |
| Python | 3.13.14（托管版本） |
| Node | v22.22.2 |
| Playwright | 1.62.1（按既有 `package-lock.json` 用 `npm ci` 安装） |
| 浏览器 | Edge（Chromium），`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`，headless |
| 本机真实词库 | `data/memo-superform.db` 3148 条记录（仅只读读取字段形状用于造合成数据，未写入） |

### 2.1 环境缺项与处置（已登记，未改生产行为）

1. **当前会话的 Node 同步派生不可用**：`child_process.spawnSync/execFileSync` 一律返回
   `EBUSY`（已验证同步派生 `cmd.exe`、`python`、`node` 自身均失败；异步 `spawn` 正常）。
   `tests/run.ps1` 的第一项 `tests/study-keyboard-regression.js`（第 42 行）依赖
   `execFileSync` 读取 `memo_injection.MEMO_STUDY_KEYS_JS`，因此既有入口在本会话无法直接跑通。
   处置：新增 `_verification/workbuddy-optimization/sync-spawn-shim.js`（只对包含
   `memo_injection` 的调用返回**预先用真实 python 执行同一条命令得到**的输出），通过
   `NODE_OPTIONS=--require` 注入。**未改动任何被测试文件或断言**；其他同步派生仍按原样抛错，
   避免掩盖真实问题。该 shim 位于被忽略目录，不属于交付物。
2. **`playwright` 模块缺失**：按既有锁文件执行 `npm ci`（新增 2 个包）后解决。
3. **偶发 `attempt to write a readonly database`**：首个 `/api/study-records` 请求在并发创建
   WAL 的 `-wal`/`-shm` 时偶发失败（`03-*.log`、`05-*.log` 可见）。基准侧已加入串行预热与
   一次重载重试；这是**观测到的现象**，本轮未定位到根因，列入待验收。

## 3. 可复现基线（已测量）

### 3.1 既有回归基线

`./tests/run.ps1 -Browser`（带上述 shim）：**EXIT=0**，181 项 Python 测试、
16 组 JavaScript 检查、三组 Edge 浏览器场景、发布保护与编译/差异检查全部通过，
约 3m13s。原始输出：`01-baseline-runps1.txt`。

### 3.2 基准工具（新增，可重跑）

| 文件 | 用途 |
|---|---|
| `tests/perf/synthetic_dataset.py` | 固定种子 20261008 的确定性合成记录；字段形状参照本机真实库的**结构统计**，拼写为伪造音节词，与用户词汇无关 |
| `tests/perf/bench_server.py` | 独立数据目录 + 随机端口 + 桩账号身份（不读本机凭据、不触云端、不碰 `data/`） |
| `tests/perf/dashboard_benchmark.js` | 仪表盘基准：启动、逐图渲染、布局/范围切换、长任务、图表实例、DOM、堆 |
| `tests/perf/sqlite_benchmark.py` | SQLite 热查询：请求链路、查询计划、连接开销 |
| `tests/perf/first_paint_experiment.js` | 首屏静态资源 A/B 与多磁贴聚合对照 |
| `tests/perf/lifecycle_stress.js` | 重复进入退出/切换的资源稳定性（可区分“已回收节点”与“长期增长”） |
| `tests/perf/stability_run.js` | 短时负载稳定性（周期采样，比较前后半段） |

重跑命令（示例）：

```bash
node tests/perf/dashboard_benchmark.js --scales 1000,10000,50000 --repeat 5 \
  --startup-repeat 5 --tag <tag> --out _verification/workbuddy-optimization/<file>.json
python tests/perf/sqlite_benchmark.py --scales 1000,10000,50000 \
  --out _verification/workbuddy-optimization/<file>.json
node tests/perf/lifecycle_stress.js --rounds 60 --count 10000 --tag <tag>
node tests/perf/first_paint_experiment.js --count 50000 --repeat 5
node tests/perf/stability_run.js --minutes 20 --count 10000
```

### 3.3 基线测量结果（修改前）

**SQLite（`04-sqlite-benchmark-baseline.json`，中位数，n=7）**

| 规模 | 新连接首次查询 | 请求链路（新建连接） | `get_records` | 无排序读取 |
|---|---|---|---|---|
| 1 000 | 62.9 ms | 348 ms | 141 ms | 7.4 ms |
| 10 000 | 64.1 ms | 404 ms | 187 ms | 122 ms |
| 50 000 | 62.7 ms | 731 ms | 490 ms | 385 ms |

- 新连接首次查询的开销与记录数**无关**（约 63 ms 固定成本），一次 `/api/study-records`
  会依次打开写连接（`ensure_sync_profile`）与两条读连接，把该成本重复支付多次。
- 查询计划：`SEARCH study_records USING INDEX idx_records_due (profile_id=? AND is_active=?)`
  + `USE TEMP B-TREE FOR ORDER BY`。索引已在用；排序是次要成本（50k 下约 100 ms 量级）。

**根因定位（已并入 `sqlite_benchmark.py` 的 `new_connection_first_query_delete_mode` 场景，
可重跑）**：把同一份库复制为 `journal_mode=DELETE` 后，新连接首次查询降到
**0.68–0.73 ms**（WAL 下为 62–64 ms）。即成本来自 WAL —— 最后一个连接关闭时 SQLite 会删除
`-wal`/`-shm`，下一次新建连接的首次查询需要重建它们。同目录下 1000 行小库仅 0.5 ms，
说明与库体积和目录无关。

保持一条长驻连接后（交错顺序验证，已排除“仅首次冷启动”的假象）：

| 阶段 | 中位数 |
|---|---|
| 无保活（冷） | 61.6 ms |
| 无保活（再测） | 65.4 ms |
| 保活连接打开 | **2.0 ms** |
| 关闭保活后 | 62.9 ms |
| 再次打开保活 | **1.9 ms** |
| 最后关闭 | 62.7 ms |

**仪表盘（修改前，`03-dashboard-benchmark-baseline.json`，n=5）**

| 规模 | recordsReady | `/api/study-records` | renderVisible | 热力图 | 趋势30 | 增长 | 最长长任务 |
|---|---|---|---|---|---|---|---|
| 1 000 | 733 ms | 474 ms | 4.9 ms | 4.5 ms | 8.8 ms | 4.6 ms | 0 |
| 10 000 | 921 ms | 568 ms | 11.4 ms | 10.0 ms | 20.5 ms | 10.3 ms | 0 |
| 50 000 | 1975 ms | 970 ms | 39.0 ms | 39.2 ms | 69.0 ms | 36.3 ms | 216 ms（24 个） |

首屏静态资源（默认标准仪表盘）：27 个请求 / 6.10 MB，其中
`img/icon.png` 2.13 MB（用作 favicon）、`img/gifs/anon-think.gif` 1.81 MB、
`vendor/echarts.min.js` 1.03 MB、Live2D/PixiJS 合计约 0.92 MB。
`css/fonts.css`（954 KB）经核对**仅在笔记本模式由 `js/ui-style.js` 注入**，
标准仪表盘首屏不加载，因此未作为首屏问题处理。

---

## 4. 已修改并验证（2 项）

> 计划上限 3 项。第 3 类（首屏静态资源）测量后未达到可确认收益，未改动，见第 5 节。

### 4.1 SQLite WAL 保活连接 —— 消除每次新建连接的固定开销

- **触发场景**：每次仪表盘读取 / 自动刷新调用 `/api/study-records`。
- **证据**：见 3.3；固定成本约 63 ms/连接，与记录数无关；请求链路可复现地由
  348/404/731 ms 降到 12/61/356 ms（保活后同一条链路，1k/10k/50k）。
- **原因**：WAL 的 `-wal`/`-shm` 在最后一个连接关闭时被删除，重建昂贵（Windows 上尤其明显）。
- **现有行为合同**：WAL、事务、在线备份、`profile_id` 隔离、读写语义全部不变。
- **最小改动**：`db.py` 新增 `keep_warm()/close_warm()`（默认关闭，仅长驻服务调用），
  `init_db()` 切换数据目录时释放；`server.py` 的 `start_server()` 在 `DB_READY` 时启用。
  保活连接只做一次 `SELECT 1` 读探针，自身不写入。
- **为什么默认关闭**：实测打开的连接会让 Windows 无法删除临时数据目录
  （`PermissionError WinError 32`），会影响既有单元测试的清理；因此只由长驻服务开启。
- **验收**：见第 6 节前后对照；新增 3 项行为测试（`WarmConnectionTests`）覆盖
  读取结果一致、切换目录释放句柄、保活下备份与写入仍成功。

### 4.2 北京时间换算记忆化 —— 消除大词库重绘中的重复换算

- **触发场景**：热力图/趋势/记忆曲线/词汇增长/词书进度每次重绘，以及日期筛选、布局内多磁贴。
- **证据**：5 万条记录下，`MemoDashboard.toBeijingDate` 单次遍历 `last_study_date` **32.3 ms**，
  加上 `add_date` 共 **54.8 ms**，改 Map 查表后 **1.3 ms**。
  该成本约占热力图“数据处理”耗时（35.6 ms）的九成；多磁贴场景下单次全量重绘
  单格 42 ms / 两分屏 107 ms / 田字格 124 ms，主要都来自这里。
- **原因**：每条记录在每个图表里都独立做一次 `new Date()` + `toISOString()` + `slice()`，
  同一批记录在一次刷新中被重复换算；且该换算只依赖输入值。
- **现有行为合同**：换算结果、日期边界、跨北京时间午夜、词本成员关系、拖拽后刷新、账号与数据代次均不变。
- **最小改动**：`js/dashboard-core.js` 的 `toBeijingDate` 按值缓存（上限 200000 条后清空，
  避免长期累积）。函数签名与返回值不变；`charts.js` 对它的引用方式不变。
- **验收**：见第 6 节；新增 `tests/dashboard-date-cache-regression.js`，逐项比对空值/非法值/
  时间戳/900 天批量取值与参考实现的结果，并保留 `shiftDate`/`dateRange`/`escapeHtml`/布局契约。

### 4.3 生产改动清单

| 文件 | 改动 | 行数 |
|---|---|---|
| `db.py` | `keep_warm()` / `close_warm()` / `_close_warm()`，`init_db()` 释放句柄 | +52 |
| `js/dashboard-core.js` | `toBeijingDate` 按值缓存 | +12 / -1 |
| `server.py` | `start_server()` 在 `DB_READY` 时启用保活（失败仅打印，不影响启动） | +7 |
| `tests/test_sqlite_core.py` | 保活连接 3 项行为测试 | +55 |
| `tests/dashboard-date-cache-regression.js` | 换算记忆化行为回归（新增） | 新文件 |
| `tests/run.ps1` | 接入上述回归 | +1 |
| `tests/perf/**` | 基准与压力工具（基准单独计数） | 新文件 |

`git diff --check` 通过，无空白错误。生产逻辑改动集中在 2 个文件，约 64 行（`server.py`
为 7 行装配）。

---

## 5. 已测量但未实施（候选）

### 5.1 首屏大图（`img/icon.png` 2.13 MB、`img/gifs/anon-think.gif` 1.81 MB）

A/B（5 万条记录，n=5）：拦截两张图后静态体积 6.10 MB → 2.34 MB，
`recordsReady` 1756 ms → 1650 ms（约 -106 ms，-6%），但 **FCP 不变（376 ms → 376 ms）**，
DCL 195 → 188 ms。

结论：收益集中在“与 15.9 MB 学习记录并发下载时的带宽竞争”，在接近真实的 3 千条词库下
会更小；FCP 没有改善，且替换 favicon 涉及视觉/素材取舍。**未改动生产代码**，保留为候选，
建议由用户在真实素材决策后单独处理。

### 5.2 重复切换后的监听残留

60 轮（进入/退出陪伴 + 布局切换 + 图表类型切换，含背单词磁贴）后：
图表实例 1（创建 180 / 销毁 179）、DOM 619 恒定、canvas 2、iframe 0、
堆 44.3 MB → 37.3 MB（无增长趋势）、长任务 1 个（53 ms）、无页面错误。

计数上“净监听”增长来自**被重建后又回收**的 DOM 节点（已回收节点 5966 个）；
按“目标 + 事件类型”统计的真实残留只有 `#document [keydown]` 在 12 轮后 +3，
来源是 `js/study-web.js` 的 `render()`（第 336–339 行注册，第 341–350 行已有对应的
`dispose` 移除逻辑），即个别路径下旧实例未被销毁。

结论：图表、DOM、堆均有可解释上限且无劣化趋势，未观察到功能或性能损害，
因此**未做推测性修补**（涉及 C16/C26/C27 的学习区所有者与销毁契约，风险大于已证收益）。
列为候选：若在真实环境长期运行中出现残留扩大，再针对 `study-web` 的销毁路径单独立项。

### 5.3 `ORDER BY voc_spelling COLLATE NOCASE`

50k 下排序约占 `get_records` 的 100 ms 量级（550 ms vs 无排序 385 ms，均含连接开销）。
排序结果是既有输出契约的一部分，改动会影响输出顺序，本轮未动。列为候选。

---

## 6. 前后对照（同一环境、相同数据与操作）

`03-dashboard-benchmark-baseline.json` → `06-dashboard-benchmark-optimized.json`，均为 n=5：

| 记录数 | 场景 | 前 中位 | 后 中位 | 改善 | 前 P95 | 后 P95 |
|---|---|---|---|---|---|---|
| 1 000 | `/api/study-records` | 474.0 ms | 17.9 ms | **-96.2%** | 474.0 | 17.9 |
| 1 000 | recordsReady | 732.7 ms | 243.9 ms | **-66.7%** | 749.5 | 245.3 |
| 1 000 | 全量重绘 | 4.9 ms | 3.4 ms | -30.6% | 5.4 | 4.4 |
| 10 000 | `/api/study-records` | 568.4 ms | 69.7 ms | **-87.7%** | 568.4 | 69.7 |
| 10 000 | recordsReady | 920.7 ms | 420.2 ms | **-54.4%** | 925.7 | 420.6 |
| 10 000 | 全量重绘 | 11.4 ms | 4.6 ms | **-59.6%** | 11.8 | 4.8 |
| 10 000 | 趋势 30 天 | 20.5 ms | 6.4 ms | **-68.8%** | 20.8 | 7.5 |
| 50 000 | `/api/study-records` | 969.5 ms | 454.7 ms | **-53.1%** | 969.5 | 454.7 |
| 50 000 | recordsReady | 1975.4 ms | 1431.2 ms | **-27.5%** | 2457.1 | 1519.7 |
| 50 000 | 全量重绘 | 39.0 ms | 7.8 ms | **-80.0%** | 39.7 | 8.2 |
| 50 000 | 热力图 | 39.2 ms | 7.3 ms | **-81.4%** | 40.2 | 7.4 |
| 50 000 | 趋势 30 天 | 69.0 ms | 10.6 ms | **-84.6%** | 70.2 | 11.1 |
| 50 000 | 词汇增长 | 36.3 ms | 9.3 ms | **-74.4%** | 37.3 | 11.1 |
| 50 000 | 范围切换（7 天） | 65.4 ms | 7.7 ms | **-88.2%** | 65.7 | 8.4 |
| 50 000 | 范围切换（全部） | 77.0 ms | 19.5 ms | **-74.7%** | 77.1 | 19.5 |
| 50 000 | 长任务数量 / 最长 | 24 / 216 ms | 2 / 192 ms | 显著减少 | — | — |
| 全部 | 页面错误 | 无 | 无 | — | — | — |

- 两项改动均**超过计划要求的“热点中位耗时改善至少 20%”**，且 P95 同步改善。
- 个别项存在噪声级回摆（1 000 条下的记忆曲线 5.9 → 5.6 ms、趋势全部 16.0 → 15.2 ms
  分别在另一规模上有 ±5% 波动；1 000 条趋势全部 P95 16.0 → 16.6），幅度在重复采样噪声内。

### 6.1 回归

- 完整入口 `./tests/run.ps1 -Browser`：**EXIT=0**，**184 项 Python 测试**（原 181 + 新增 3）、
  17 组 JavaScript 检查（含新增换算回归）、三组 Edge 浏览器场景、发布保护与编译/差异检查
  全部通过（`08-regression-after.txt`）。
- `git diff --check`：通过。

---

## 7. 稳定性（短时验证）

- **60 轮重复切换**（`07-lifecycle-stress-optimized.json`，1 万条）：图表实例、DOM 节点、
  canvas、iframe 均有可解释上限，堆无增长趋势，长任务 1 个（53 ms），无页面错误。
- **20 分钟负载连续操作**（`09-stability-run-optimized.json`，1 万条，2825 次操作，39 次采样）：

| 指标 | 前半段中位 | 后半段中位 | 全程范围 |
|---|---|---|---|
| 堆 | 49.10 MB | 49.35 MB（+0.5%） | 39.5 – 62.5 MB（随 GC 波动，无上升基线） |
| DOM 节点 | 625 | 625（+0%） | 592 – 667（随布局档位变化） |
| 存活图表实例 | — | — | 2 – 3（创建 8239 / 销毁 8237） |
| 长任务 | — | — | 累计 2 个，最长 58 ms |
| 页面错误 | — | — | 无 |

以上均称为**短时验证**；长期运行（数小时至数天）仍属待验收。

---

## 8. 待真实环境验收 / 本轮未覆盖

1. 真实墨墨账号与云端读写、OAuth 全流程 —— 本轮全部使用桩身份与合成数据。
2. 用户真实词库（3148 条）上的端到端体验 —— 本轮未读取/写入该库，结论由合成库外推。
3. **本机特异的 WAL 成本**：约 60 ms/连接 是本机的实测值（已在项目目录与系统临时目录分别验证，
   且与沙箱开关无关；同规模小库仅 0.5 ms，说明与库大小/目录无关而与 WAL 模式相关）。
   其他机器/磁盘上数值可能不同；该改动在数值小的地方收益相应变小，但不会引入退化。
   建议在目标机器上用第 3.2 节命令复核。
4. 长时间运行（>20 分钟）、多账号长期切换、真实自动刷新周期。
5. 打包 EXE / 冻结包、`--verify-build`、原位升级与回滚。
6. 真实 GPU 环境下的完整 Cubism 模型渲染、真实 GPT-SoVITS 合成与播放。
7. 偶发的 `attempt to write a readonly database`（见 2.1）根因未定位。
8. 首屏大图（5.1）、`study-web` 监听残留（5.2）、`ORDER BY`（5.3）三个候选。

## 9. 剩余风险与下一步

- 保活连接只在长驻服务开启；若将来新增“长期运行但走 `init_db` 切换目录”的路径，
  需要确认释放逻辑仍被覆盖（已由 `WarmConnectionTests` 中“切换目录释放句柄”一项守护）。
- 换算缓存上限 200000 条，超过后整体清空；若将来单批记录远超该量级，可按代次再细化。
- 下一步建议：先按第 8 节第 1–6 项做真实环境验收，再回头处理 5.1/5.2 两个候选。

## 10. 证据索引

| 文件 | 内容 |
|---|---|
| `_verification/workbuddy-optimization/01-baseline-runps1.txt` | 改动前完整回归（EXIT=0） |
| `.../03-dashboard-benchmark-baseline.{json,log}` | 仪表盘基线（修改前） |
| `.../04-sqlite-benchmark-baseline.json` | SQLite 基线 + 保活对照 + 查询计划 |
| `.../05-first-paint-experiment-baseline.{json,log}` | 首屏 A/B 与多磁贴聚合 |
| `.../06-dashboard-benchmark-optimized.{json,log}` | 仪表盘基准（修改后） |
| `.../07-lifecycle-stress-optimized.json` | 60 轮资源稳定性 |
| `.../08-regression-after.txt` | 改动后完整回归（EXIT=0，184 项） |
| `.../09-stability-run-optimized.json` | 20 分钟负载稳定性 |
| `.../sync-spawn-shim.js`、`.../memo-study-keys-js.txt` | 会话环境限制处置（非交付物） |
