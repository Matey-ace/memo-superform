# Memo Superform 全项目验收报告（WorkBuddy）

> 状态：**已完成（2026-10-09）**。代码与文档审查全部覆盖；真实环境验收项逐条保留于 §5。
> 任务书：`docs/workbuddy-full-acceptance-task.md`；优化阶段输入：`docs/workbuddy-optimization-report.md`；逐文件覆盖：`docs/workbuddy-acceptance-coverage.csv`；原始证据：`_verification/workbuddy-acceptance/`。

---

## 0. 基线与范围

| 项 | 值 |
| --- | --- |
| 分支 | `codex/full-quality-hardening` |
| HEAD | `59f671117bde16f0f8d45bcc10e21c57f3bd5cd2` |
| 跟踪文件 | 1148（`git ls-files`） |
| 未跟踪新增 | 16（含本轮新增测试、两份报告、覆盖表、两份工作记忆；见 §3） |
| 覆盖表统计（最终） | `docs/workbuddy-acceptance-coverage.csv`：1161 行 —— **完整审查（reviewed）64 / 部分审查（partial）67 / 排除（excluded）1030 / 未审查（unread）0** |
| 本次改动 | 6 个文件，+190 / −3（见 §3） |

**关于覆盖等级的如实说明**（生成脚本：`_verification/workbuddy-acceptance/gen_coverage.py`）：

- **reviewed（64）**：全文通读并有独立证据，或属本轮直接改动并复验的文件。
- **partial（67）**：有明确、可核验的检查范围但**不是逐行通读**，包括三类 —— ① 47 个测试文件全部随 `tests/run.ps1 -Browser` 执行通过（执行通过 ≠ 逐行审查）；② 12 个声明式 CSS 的模式扫描（无 `@import`/`expression()`/外部 URL）；③ `js/app.js`、`js/charts.js`、`js/live2d-companion.js`、`maimemo_auth.py`、`codex_auth.py`、`app_update.py` 的风险点与关键路径审查（innerHTML/凭据/下载校验等已逐一核对，其余未通读）。
- **excluded（1030）**：二进制资源（woff2 字体 985、GIF、图标）、`vendor/` 第三方库、`_archive/` 归档、许可文本、`package-lock.json` 等生成物，逐项附排除原因。
- "unread 归零"指**每个文件都有了明确的状态与检查范围记录**，不等于全部逐行通读。

边界（沿用优化阶段，未放宽）：

- 不做安装、云端写入、推送、公开发布；不覆盖既有 EXE。
- 保留真实数据、凭据、模型/语音包。
- 测试一律使用独立数据目录、合成数据、随机端口。

---

## 1. 已完成检查（含证据）

### 1.1 专项一：WAL 保活连接（退出 / 切目录 / 备份 / 并发 / Windows 句柄）

| 检查点 | 方法 | 结果 |
| --- | --- | --- |
| 解释器退出释放 | `atexit.register(_close_warm)` | 已加入并验证 `close_warm()` 后句柄释放 |
| 切换数据目录 | `init_db()` 中先 `_close_warm()` | `test_switching_data_dir_releases_the_warm_connection` 通过 |
| 备份 / 写入仍成功 | 保活连接存在时执行备份与写事务 | `test_backup_and_write_still_succeed_with_warm_connection` 通过 |
| 读一致性 | 保活连接与普通连接读取同一批记录 | `test_keep_warm_reads_identical_records_and_releases_the_handle` 通过 |
| 并发 | 8 线程 × 15 次写，`threading.Barrier` | `test_warm_connection_removes_readonly_failures_under_concurrency` 通过 |
| WAL 体积 | 保活下持续写入观察 `-wal` 增长 | **未失控**：自动检查点使 WAL 在约 4MB 处收敛；手动 `wal_checkpoint(TRUNCATE)` 仍有效；保活连接关闭后 WAL 归零 |

并发用例耗时从初版 135s 优化到 **2.838s**（`WarmConnectionTests` 4 项），手段是把 `db._profile_pk` 提到循环外解析、并把 `THREADS` 由 10 降到 8、`WRITES_PER_THREAD` 由 25 降到 15。

**用例有效性交叉验证**（交替运行，排除偶发）：

```
keep_warm=False -> errors={'attempt to write a readonly database': 6}
keep_warm=True  -> errors=none
keep_warm=False -> errors={'attempt to write a readonly database': 7}
keep_warm=True  -> errors=none
```

证据：`_verification/workbuddy-acceptance/sqlite-core-run1.txt`（11 项 OK）、`tests/test_sqlite_core.py::WarmConnectionTests`。

### 1.2 专项二：`readonly database` 根因

用 `_verification` 目录下的临时探针复现：8–16 线程并发写时稳定复现，且**与 PRAGMA 无关**（加不加 `journal_mode=WAL` / `busy_timeout` 都会出现）。

结论：对照结果支持 **WAL 的 `-wal` / `-shm` 在最后一个连接关闭时删除、下一个连接重建期间存在竞争窗口** 的解释；尚未独立追踪到每次失败的底层文件操作。保活连接在该探针中消除了错误（0 次 vs 6–7 次）。

即：这是一个**既有缺陷**，本次优化顺带消除；已在报告中作为修复项记录，并在 `test_sqlite_core.py` 中固化为回归用例。

### 1.3 专项三：日期缓存正确性与上限

`tests/dashboard-date-cache-regression.js` 已扩展并全部通过：

| 用例 | 内容 | 结果 |
| --- | --- | --- |
| 基础 | 空值 / 非法值 / 常见形态 | 与参考实现一致 |
| 2b | 午夜边界 `15:59:59Z→2026-08-30`、`16:00:00Z→2026-08-31` | 一致 |
| 2c | 时间戳（数值）输入 | 一致 |
| 2d | 紧凑格式与畸形串 | 一致（畸形返回 `null`） |
| 2e | `Date` 对象输入 | 一致 |
| **2e-F6** | 同一 `Date` 对象 `setTime` 跨日、变 `Invalid Date`、两个同值对象互不影响 | **实时换算，全部正确** |
| 批量 | 900 天连续日期 | 一致 |
| **4b-F7** | **200500 个有效且唯一**的 ISO 输入逐项比对，仪表化 Map 观测：`sets=201417 / maxSize=200000 / clears=1` | **上限路径真实触发**；淘汰后重查与参考一致；上限后对象修改仍按新值换算 |
| 4c | 不同输入互不串扰 | 一致 |

#### F6 复现与修复（Codex 复核确认，验收遗漏）

**缺陷**：`toBeijingDate` 按 `Map` 键缓存所有输入，`Date` 对象以对象身份作键；对象被 `setTime` 原地修改后命中过期缓存。实际源文件 VM 运行复现（`_verification/workbuddy-acceptance/f6f7-repro-before.log`）：

```
d = new Date('2026-08-29T17:00:00Z')
首次调用        -> 2026-08-30 ✓
d.setTime('2026-09-01T17:00:00Z') 后
实际返回        -> 2026-08-30   （参考 2026-09-02）   stale=true
d.setTime(NaN) 后
实际返回        -> 2026-08-30   （参考 null）          更严重
```

**修复**（`js/dashboard-core.js` 最小改动）：只有不可变原始值（`string`/`number`）才读写缓存；`Date` 及其他可变对象一律实时换算、绝不入缓存。字符串热路径不变。

**复验**：`f6f7-repro-after.log` 中 `stale=false`、Invalid 返回 `null`；定向回归 `DASHBOARD_DATE_CACHE_REGRESSION_PASS`。

#### F7 复现与修复（4b 从未真正压测上限）

**缺陷**：4b 生成的输入形如 `'2020-01-01T00:00:00Z-0'`，无法解析 → 200500 次全部返回 `null`，**缓存 set 0 次**（仪表化 Map 观测 `mapSetsDuringLegacyLoop=0`），上限与清空路径从未执行，测试形同虚设。

**修复**（仅测试文件）：改用 200500 个有效且唯一的 ISO 时间戳逐项与参考比对；在测试沙箱注入仪表化 `Map`（只改测试上下文全局，不改生产公共接口）观测真实写入量、峰值与清空次数；上限触发后重查最早键（已淘汰，须重算且一致）并复核对象修改行为。

**复验**：`sets=201417 / maxSize=200000 / clears=1` —— 恰好 200500 次插入、峰值精确达上限、清空一次。

#### 图表数值与性能复核（修复后重跑）

- 图表数值对照（20000 条）：热力图 `compared=31, mismatchCount=0`；趋势 30 天 `compared=30, mismatchCount=0`（`chart-value-after-f6f7.log`）。
- 性能（50k 中位，优化后基线 → 修复后）：热力图 7.3→8.6 ms、趋势 30 天 10.6→11.9 ms、记忆曲线 11.8→14.3 ms、增长 9.3→11.3 ms；range_90 12.7→**10.6**、range_all 19.5→**17.5**；1k/10k 持平（`dashboard-benchmark-run.json` vs `06-dashboard-benchmark-optimized.json`）。本次测量中部分图表增加约 1~2.5 ms，原因未单独隔离；热力图、趋势与增长仍明显低于缓存引入前的 39.2/69/36.3 ms。

### 1.4 专项四：图表数值未被缓存改动影响（含 F9 加固）

`tests/perf/chart_value_verification.js` 把 ECharts 实际渲染的数据与独立复算的参考值逐点比对。**F9 加固后**，参考值在 Node 侧按 `charts.js aggregateDailyData` 的真实业务规则独立计算（不再依赖页面内计算），并强制完整性判定：

- 热力图：数据长度必须等于当月天数（31）、逐点等于 `last_study_date` 落日计数、当月有记录的日期不得缺失、渲染总和与参考总和一致、渲染月份必须为当前月。
- 趋势 30 天：**三条序列（新学/复习/总计）必须齐全**、每条长度等于 30、逐日逐序列与参考一致；复习口径与业务一致（last 落日且 `study_count>1` 且北京日期 `add_date !== last_study_date`）。
- 任何差异、缺失、截断、缺序列 → 非零退出码并把失败明细写入报告 JSON；启动失败/超时/断言失败时浏览器与测试服务都会被释放。

真实数据端到端结果（`chart-value-verification-after-hardening.json`，20000 条，EXIT=0）：

- 热力图：`dataLength=31`（= 当月天数）、`compared=31, mismatchCount=0, missing=0`
- 趋势 30 天：`seriesNames=["新学","复习","总计"]`、`compared=30`、三序列逐日一致

故障注入（`chart-value-fault-injection.log`，11 项场景全部按预期）：空图表 / 截断 / 错值 / 缺日 / 错月 / 缺序列 / 序列截断 / 趋势错值 / 复习口径清零 → 全部判**失败**；正确热力图与趋势图 → 通过。

### 1.5 专项五：study-web / 陪伴模式监听生命周期

用 `_probe_companion_listener.js` 区分"等待不足的竞态"与"稳定残留"。进入/退出陪伴模式 8 轮，等待档位 30 / 300 / 800 ms，**三档净增长完全相同**：

```
click: 80（10/轮）  keydown: 120（15/轮）
submit: 8  compositionstart: 8  compositionend: 8  load: 8（各 1/轮）
```

→ 判定为**稳定残留，非竞态**。

逐一定位残留来源：

| 残留 | 位置 | 目标是否长生命周期 |
| --- | --- | --- |
| `iframe` `load` | `js/study-web.js:251` | iframe 随 `container.innerHTML` 重建被替换 —— **但销毁路径未摘除，已修复** |
| `.study-web-btn` click ×4 | `js/study-web.js:271` | 随容器重建被替换 |
| 快捷键面板 click ×3 | `js/study-web.js:302/303/325` | 同上 |
| `[data-shortcut]` keydown ×~14 | `js/study-web.js:305` | 同上 |
| 编辑面板 click/keydown/submit/compositionstart/compositionend | `js/study-content-editor.js:322/337/344/357/358` | `body = panel.querySelector('[data-editor-body]')`，随容器重建被替换 |

**F3 复验**（`_verification/workbuddy-acceptance/companion-listener-probe-after.log`，8 轮 × 三档等待）：

```
修复前：click 80 / keydown 120 / submit 8 / compositionstart 8 / compositionend 8 / load 8
修复后：click 80 / keydown 120 / submit 8 / compositionstart 8 / compositionend 8 / load 0
```

`load` 残留已消除，其余挂载在随容器重建被丢弃的元素上，保持不变。

**已确认卸载干净的**（真正长生命周期目标）：

- `js/study-web.js:342` `document.removeEventListener('keydown', handleShortcutKeydown)`
- `js/study-web.js:346` `window.removeEventListener('message', handleStudyNavigationMessage)`
- `js/study-web.js:343/344` `container` 的 `pointerdown` / `focusin`
- `js/study-content-editor.js:402` `window.removeEventListener('memo-account-changed', ...)`、403 `clearInterval`、404 `observer.disconnect()`、405 `iframe.removeEventListener('load', startObserver)`

结论：残留**全部挂在随容器重建而被丢弃的元素上**，属于可回收垃圾，不构成功能或性能泄漏；`document` / `window` 级监听均已成对移除。

---

## 2. 已确认问题与修复

| # | 问题 | 严重度 | 处置 |
| --- | --- | --- | --- |
| F1 | 并发写偶发 `attempt to write a readonly database` | P1 | 由 WAL 保活连接消除（优化阶段），本轮补并发回归用例 |
| F2 | 解释器退出时保活连接未显式释放 | P2 | `db.py` 增加 `import atexit` + `atexit.register(_close_warm)` |
| F3 | `study-web` 销毁路径遗漏 `iframe` `load` 监听 | P2 | `js/study-web.js` 改为具名 `handleIframeLoad`，dispose 中 `removeEventListener`；**已复验**：每轮残留 `load` 由 +8 降为 0，其余项不变 |
| F4 | 并发回归用例耗时 135s | P3 | 主键解析出循环 + 降低并发规模 → 2.838s |
| F5 | 图表数值校验"缺失日期"误报 | P3 | 只统计当月，已修正 |
| F6 | `toBeijingDate` 按 `Date` 对象身份缓存，`setTime` 后返回过期日期（含变 `Invalid Date` 后仍返回旧值） | **P1**（公开共享契约的正确性） | 只缓存不可变原始值（string/number），对象一律实时换算；新增 2e-F6 行为回归（跨日修改 / Invalid / 双对象互不影响）；复验 `stale=false` |
| F7 | 日期缓存回归 4b 用非法输入（`…Z-0`）压测上限，缓存实际从未被填充，上限/清空路径未验证 | **P2**（测试有效性缺陷） | 改为 200500 个有效唯一输入逐项比对 + 测试沙箱仪表化 Map 观测；复验 `sets=201417 / maxSize=200000 / clears=1` |
| F8 | 并发用例只过滤 readonly 错误：全部写入抛 `database is locked` 时仍假通过（Codex 复现） | **P2**（测试有效性缺陷） | `tests/test_sqlite_core.py`：改为断言**零写入异常**（任何类型）+ 线程全部正常结束 + 落库行数等于 `THREADS×WRITES_PER_THREAD`；故障注入证明全失败/半失败均被判失败、恢复后通过（`test-sqlite-core-fault-injection.log`） |
| F9 | 图表数值校验只保存结果不判失败：0 点比较、缺失日期也以退出码 0 结束；趋势图只核对总计序列；浏览器/服务在启动失败路径会泄漏（Codex 复现） | **P2**（测试有效性缺陷） | `tests/perf/chart_value_verification.js`：按真实业务口径判定——三序列（新学/复习/总计）逐日核对，参考值由 Node 侧按 `aggregateDailyData` 规则独立计算；热力图数据长度必须等于当月天数；任何差异/缺失/截断/缺序列以非零退出码结束并写入失败证据；所有失败路径均释放浏览器与服务；11 项注入场景全部按预期判定（`chart-value-fault-injection.log`） |

**重大改动**：无。F1–F9 均为局部改动。

---

## 3. 本次改动清单

```
 db.py                     |  58 ++++++++++++++++++++++++
 js/dashboard-core.js      |  19 +++++++-
 js/study-web.js           |   8 +++-
 server.py                 |   7 ++++
 tests/run.ps1             |   1 +
 tests/test_sqlite_core.py | 112 ++++++++++++++++++++++++++++++++++++
 6 files changed, 202 insertions(+), 3 deletions(-)
```

（F6 使 `js/dashboard-core.js` 增至 +19，F8 使 `tests/test_sqlite_core.py` 增至 +112；`tests/dashboard-date-cache-regression.js` 与 `tests/perf/*` 为新增未跟踪文件，不计入 diff。）

新增未跟踪文件（16 个，`git status --porcelain --untracked-files=all`）：

```
docs/workbuddy-optimization-plan.md          优化任务书（用户提供）
docs/workbuddy-optimization-report.md        优化阶段报告
docs/workbuddy-full-acceptance-task.md       验收任务书（用户提供）
docs/workbuddy-full-acceptance-report.md     本验收报告
docs/workbuddy-acceptance-coverage.csv       逐文件覆盖表（1161 行）
tests/dashboard-date-cache-regression.js     日期缓存行为回归（含 F6/F7 用例）
tests/perf/bench_server.py                   独立数据目录 + 随机端口 + 桩身份
tests/perf/synthetic_dataset.py              seed 20261008 确定性合成数据
tests/perf/dashboard_benchmark.js            仪表盘重绘/切换基准
tests/perf/sqlite_benchmark.py               SQLite 连接与查询基准
tests/perf/first_paint_experiment.js         首屏加载对照实验
tests/perf/lifecycle_stress.js               60 轮进入/退出压力
tests/perf/stability_run.js                  20 分钟稳定性运行
tests/perf/chart_value_verification.js       图表数值独立复算校验
.workbuddy/memory/2026-10-08.md              工作记忆（优化+验收首轮）
.workbuddy/memory/2026-10-09.md              工作记忆（收尾与 F6/F7）
```

（构建与验收的原始证据在 `_verification/` 下，已被 `.gitignore` 排除，不计入未跟踪清单。）

---

### 1.6 全量回归

`tests/run.ps1 -Browser`（含 shim，F6–F9 修复后最终复验），证据 `_verification/workbuddy-acceptance/full-regression-after-hardening.utf8.txt`：

```
Ran 185 tests in 178.762s
OK
REGRESSION_SUITE_PASS
EXIT=0
```

基线为 181 项，本轮 185 项（+4 = `WarmConnectionTests`）。浏览器套件 `STUDY_BROWSER_PASS`、发布守卫 `RELEASE_GUARDS_PASS` 均通过。

### 1.7 原生测试入口（shim 与原生必须分开记录）

| 项 | 结果 |
| --- | --- |
| `spawnSync(node)` 同步派生 | **仍然失败**：`EBUSY`，`status=null` |
| `spawn(node)` 异步派生 | 正常，返回 `2\n` |

即本会话 Node 运行时的同步派生能力缺失，**不是被测代码的问题**。`tests/study-keyboard-regression.js` 依赖同步派生，只能通过 `_verification/workbuddy-optimization/sync-spawn-shim.js` 补齐（该 shim 只拦截含 `memo_injection` 的调用，输出由真实 python 预生成，未改动任何断言）。

**结论**：`STUDY_KEYBOARD_PASS` 记为 **shim 通过**；原生入口在本会话环境**无法执行**，列为待验收，不能等同于通过。
（补充佐证：Codex 复核方已在沙箱外以原生入口跑通完整浏览器套件与 185 项 Python 测试、未启用兼容补丁——原生路径本身可用，缺项仅限本会话运行时。）

### 1.8 凭据与代理（静态审查）

| 文件 | 结论 |
| --- | --- |
| `maimemo_auth.py` | `DPAPIProtector` 用 Windows `CryptProtectData` 绑定当前用户；`CredentialStore.save()` 走临时文件 + `os.replace` 原子替换 + `chmod 600`；`clear()` 直接删除文件；PKCE 用 `secrets.token_bytes(64)` |
| `codex_auth.py` | 复用同一 `CredentialStore`（`codex_auth.bin`），`disconnect()` 先 `clear()` 再尝试 revoke；refresh 提前 300s |
| `memo_proxy.py` | 声明式路由表，5 条固定前缀；无用户可控拼接的目标主机 |
| `static_security.py` | 拒绝 NUL / 反斜杠 / `.` 与 `_` 开头的段；根级白名单；子目录按扩展名白名单 |
| `diagnostics.py` | 日志写入前统一 `redact_sensitive_text`，正则覆盖 token/code/code_verifier/Authorization，且 2MB 轮转 |

### 1.9 更新与发布链路（静态审查，未执行发布）

| 文件 | 结论 |
| --- | --- |
| `release.ps1` | 7 步流程：校验版本与 `build_info.BUILD_VERSION` 一致 → 校验墨墨 OAuth `client_id` 与 5 个获批 scope（`openid`/`profile`/`offline_access`/`open.memo.study`/`open.memo.content`）→ 拒绝脏工作区（明确不执行 `git add -A`）→ 禁止覆盖本地/远端 Tag → 跑 `tests/run.ps1 -Browser` → PyInstaller 打包并 `--verify-build` 冻结包验收 → 草稿上传后远端核验单一资产的名称/大小/sha256 才转正 |
| `release-guards.ps1` | `Get-ExistingRelease` 处理 404 与"同版本多草稿"歧义；`Publish-VerifiedRelease` 在公开前校验草稿态、资产数量、名称、大小、SHA256 |
| `MemoSuperform.spec` | 单入口 `launcher.py`；`hiddenimports` 显式保留 webview 各平台后端与 `webview.dom`（避免 EXE 首次载入设置页报缺模块）；排除 `pyodbc` |
| `app_update.py` | `urlopen` 均带超时；`_is_expected_release_url` / `_is_expected_asset_url` 校验下载来源；缓存与下载都走临时文件 + `os.replace`；`_target_is_writable` 预检目标可写 |
| `js/app-update.js` | 版本号、Release 说明全部 `textContent` 渲染 |

**未执行**：真实发布、真实原位升级。冻结包构建与 `--verify-build` 已在本机以独立目录完成（见 §1.13），但真实发布上传与对既有安装的替换仍未执行。

### 1.10 前端注入面抽查

- `js/app.js`：`innerHTML` 仅 2 处。`loadRoleLive2DOptions` 对 `value` 转义引号、对显示名转义 `<`；`renderRoles` 用 `textContent`。
- `js/charts.js`：`recCardHtml` 对 `word` / meta / `level_label` / `id` 全部 `escapeHtml`，`level_color` 走 `/^#[a-f0-9]{3}(?:[a-f0-9]{3})?$/i` 白名单；错误提示同样 `escapeHtml`。
- `js/diary.js`：仅插值由记录派生的数值与 `YYYY-MM-DD` 日期，无自由文本。
- `js/study-sync-ui.js`、`js/app-update.js`：无 `innerHTML`。
- `js/api.js`：浏览器侧不再持有 token（`getToken()` 返回空串），连接竞态用 session epoch 守卫。

未发现可控的外部输入直接进入 DOM 的路径。

### 1.11 后端大文件全文审查（第二轮）

| 文件 | 结论 |
| --- | --- |
| `live2d_service.py`（763 行，全文） | 模型事务完整：`_write_journal`（fsync + 原子替换）→ 启动 `_recover_transactions` 恢复/回滚；`_safe_relative` 拒绝 NUL 与 `.`/`..` 段，`asset_path`/`validate_model` 要求 `root in target.parents`；导入树逐项拒绝符号链接与重解析点；500MB/64MB/10000 文件 + 32MB 磁盘预留限额在检查与复制两阶段都生效；下载仅用固定 Bestdori 主机并 `quote` 路径段，可取消、按块校验磁盘；`delete_model` 删除前保守核验角色绑定，注册表不可读时拒绝删除 |
| `tts.py`（3461 行，全文） | ZIP 视为不可信输入：拒绝绝对路径/`..`/链接/特殊文件/重复路径/文件目录冲突，压缩比异常（≥128MB 且 200 倍压缩）判为炸弹；换包走"写切换日志 → 原子交换 → 失败回滚旧包与状态"，`recover_stale_staging` 只清理本模块严格前缀的产物；角色库 v1→v2 迁移先写 persona 快照、失败整体回滚；跨进程 `.tts.lock`/`.roles.lock`/`.tts-pack-install.lock` 分层；worker 用 JSON 行协议，超时强杀重置，读线程退出时唤醒全部等待者；`_resolve_role` 只信任清单规范文件名，绝不扫描目录；旧 `import_model_file` 是显式哨兵 |
| `launcher.py`（1588 行，全文） | 单实例 socket 锁（`SO_EXCLUSIVEADDRUSE` + 按版本派生端口）兼任激活与 OAuth 回调通道，消息格式严格校验；更新链路：复制 EXE 为 helper → 等父进程退出（Windows 用 SYNCHRONIZE 句柄，避免 `os.kill(pid,0)` 误杀）→ SHA256 双重校验 → 原子替换 → 就绪令牌 + 2 秒稳定窗 → 失败回滚旧 EXE 并重启；协议注册只写 HKCU；`verify_build` 用临时目录 + 随机端口 |
| `windows_tray.py`（758 行，全文） | 纯 ctypes Win32：argtypes/restype 完整声明；WndProc 内 Python 异常不越出回调；回调派发到独立线程；`stop()` 幂等且不从消息线程自等；共享 `IDI_APPLICATION` 不销毁；非 Windows 为 no-op |
| `study_sync.py`（1338 行，全文） | 绝不依据局部响应删除/停用记录；bootstrap 与 reconcile 均以远端 count 核验收尾（不一致抛 `DataIncompleteError`）；日期二分拆分深度上限 32，单日满 1000 条显式失败；限流器三个窗口可取消；profile 用 SHA256 派生键隔离；`delete_profile_data` 阻止新任务并等待旧任务退出后才提交删除 |
| `app_api.py`（859 行，全文） | POST/DELETE 一律要求 `X-Requested-With`（CSRF）；角色与 Live2D 的耦合变更由 `_role_live2d_lock` 串行化，`after_commit` 失败随清单与资产一并回滚；上传走流式 + 大小上限；旧 `/api/tts/import-model` 显式 410 |
| `app.py` | 18 行薄入口，转发 `launcher.main(["--mode","desktop"])`，不绕过协议注册 |

**本轮审查未发现新的确认缺陷**；`_write_json`（tts.py）未 `fsync` 而 live2d 的日志写入有，属 P3 观察项（Windows 上 `os.replace` 原子、恢复路径保守），不做投机性改动。

### 1.12 前端页面 / CSS / CI / 文档（第三轮）

- `js/layout.js`（725 行，全文）：全屏有 generation 守卫、焦点陷阱与 inert 背景；study-web 全屏移动原节点而非克隆（不重开背词会话）；FLIP 交换的 `transitionend` 监听自摘除并带兜底定时器；拖拽使用 pointer capture，结束路径完整复位。
- `index.html`（591 行，全文）：静态标记，脚本加载顺序正确，全部 id 与 JS 引用一致，无内联事件处理器；本地静态资源由 `server.py` 发送 `no-store, no-cache`（171/326 行），`?v=` 是双保险 —— 本轮 F3 修复能到达用户。
- `index-anon.html`（16 行跳板）、`pages/index.html`、`pages/privacy.html`：静态，`no-referrer`，隐私说明与实现一致。
- `pages/oauth/start.html` / `callback.html`：跳转前校验 issuer/redirect_uri/S256，仅转发白名单参数，`history.replaceState` 清理查询串；回调页不接触令牌明文 —— 与 `docs/maimemo-open-platform-submission.md` 的承诺一致。
- 12 个 CSS（11511 行）：扫描无 `@import`/`expression()`/外部 URL（`css/fonts.css` 为内嵌字体数据，已排除）。CSS 为声明式样式，未逐行通读，如实记为 `partial`。
- `.github/workflows/regression.yml`：Windows CI 跑 `run.ps1 -Browser` + PyInstaller 冻结包 + `--verify-build` 隔离验收；`pages.yml` 仅部署 `pages/**`，权限最小化。
- `README.md`/`CHANGELOG.md`/`docs/*`：与实现一致；CHANGELOG"未发布"段的快捷键修复与 `study-shortcuts.js` 现状吻合。
- 剩余 47 个测试文件：全部随 `tests/run.ps1 -Browser` 执行通过（185 项 OK），如实记为 `partial`（执行通过 ≠ 逐行审查）；`tests/quality_coverage.py` 与 `tests/release-guards.ps1` 已通读。

### 1.13 冻结包隔离构建与 `--verify-build` 验收

任务书 §5.2 允许在现有构建环境可用时向独立目录构建。**探测结果：本机 `C:\Users\Matey\miniconda3\python.exe`（3.13.12）与 `requirements-build.lock` 全部 15 项锁定依赖精确匹配**（含 `pyinstaller 6.20.0`、`pywebview 6.2.1`、`pythonnet 3.1.0`、`pyinstaller-hooks-contrib 2026.5`），未安装或更新任何包。

执行（产物全部位于 gitignored 的 `_verification/workbuddy-acceptance/frozen-build/`，未触碰既有 EXE、`dist/` 或 `build/`）。

**F6/F7 修复后已重建并复验**（最终产物含全部 7 项补丁）：

```
python -m PyInstaller --noconfirm --clean \
  --distpath _verification/workbuddy-acceptance/frozen-build/dist \
  --workpath _verification/workbuddy-acceptance/frozen-build/work \
  MemoSuperform.spec
BUILD_EXIT=0，产物 MemoSuperform.exe 93.27 MB
sha256: d8654cf313b98bbc2b095da4000ab6fd08a186e1aaed353f6b4ce5ce4b3659e5   （F6/F7 前：5ef1c170…）
```

`--verify-build` 验收（数据目录为一次性临时目录 `frozen-build\memo-build-*\`，随机端口，无窗口）：

```
{"version": "0.89", "frozen": true, "passed": true}   EXIT=0
checks: 16 项全通过（sqlite-initialization / webview×4 / windows_tray /
        http:/ ×9 / sqlite-online-backup）
```

证据：`_verification/workbuddy-acceptance/frozen-build/{build-log.txt, verify-build-report.json, dist/MemoSuperform.exe}`。

**F8/F9 无需重建冻结包**：这两项修复只改动测试（`tests/test_sqlite_core.py`、`tests/perf/chart_value_verification.js`），`MemoSuperform.spec` 的 datas 与 Analysis 均不包含 tests/，生产代码与 sha256 `d8654cf3…` 的冻结产物不受影响。
（该 EXE 仅为本轮验收产物，保留在 `_verification` 下；未替换任何既有安装，未发布。）

### 1.14 高危模式扫描

- 生产 Python **无** `eval` / `exec` / `os.system` / `shell=True`。`subprocess` 仅出现在 `tts.py`（4 处）与 `launcher.py`（3 处），均为列表参数形式。
- 生产 JS 无 `eval` / `new Function`；`innerHTML` 插值集中在磁贴图标、快捷键面板等**本地常量**场景，云端返回的释义/助记经 `escapeHtml` 转义后渲染。
- `recommender.py` / `db.py` 全部 SQL 使用参数绑定，未发现字符串拼接。

---

## 4. 待办（未完成）

代码与文档审查已全部覆盖：覆盖表 **1161 行，无未审查项**（完整审查 64 / 部分审查 67 / 排除 1030）。
`partial` 均如实标注实际范围：执行通过但未逐行通读的测试（47 个）、声明式 CSS 扫描（12 个）、
`js/app.js`/`js/charts.js`/`js/live2d-companion.js` 的风险点+关键路径审查、`maimemo_auth.py`/`codex_auth.py`/`app_update.py` 的核心段审查。

剩余事项均属**本机无法完成的真实环境验收**（见 §5），另有一项环境相关：

1. **原生测试入口**：`spawnSync` 在本会话 Node 运行时返回 EBUSY（异步正常），属环境限制而非代码缺陷。需在正常 Windows 环境（或 GitHub CI）用 `./tests/run.ps1 -Browser` 原生入口复跑一次 `STUDY_KEYBOARD_PASS`。
2. 若后续修改 `tts.py`，可顺手为 `_write_json` 补 `os.fsync`（P3 观察项，本轮未改动）。

---

## 5. 环境缺项（明确列为待真实环境验收，不以静态检查冒充运行）

| 项 | 状态 |
| --- | --- |
| 真实云端（墨墨账号 OAuth、云端同步、内容增删改） | **未执行**，测试全程打桩 |
| GPU / Live2D WebGL 渲染 | 无头 Edge 无 GPU；仅验证非渲染路径与降级分支 |
| TTS 语音包真实推理（含本地语音包挂载） | **未执行** |
| 原位升级（覆盖既有 EXE 的真实升级流程） | **未执行** |
| 冻结打包（`--verify-build`） | **本机已完成最新补丁隔离验收**（§1.13，16 项检查通过，产物在 `_verification` 独立目录，sha256 `d8654cf3…3659e5`）；**原位升级与真实安装替换仍未执行** |
| 真实大词库（用户真实 5 万条以上数据） | 未使用真实数据，改以 seed 20261008 合成数据替代 |
| Windows 托盘 / 启动器真实交互 | 未执行交互验证 |

---

## 6. 最终结论

- **优化改动经最终补丁复验未发现残留回归**：并发对照中的 `readonly database` 从 6–7 次降至 0 次；日期缓存经过 F6 修复后，图表数值零差异（热力图 31 点、趋势 30 点全比对通过），日期换算在午夜/时间戳/畸形/上限各边界均正确。
- **Codex 复核发现的 F6–F9 已按既有授权修复并复验**：F6（`Date` 对象按身份缓存导致 `setTime` 后返回过期日期，P1）改为"仅不可变原始值入缓存、对象实时换算"；F7（4b 用非法输入压测上限，缓存从未填充，P2）改为 200500 个有效唯一输入 + 测试沙箱仪表化 Map 证明上限路径真实触发（`sets=201417 / maxSize=200000 / clears=1`）。图表数值零差异；50k 性能代价为每图表 +1~2.5 ms（仍远优于优化前 39.2/69/36.3 ms），range_90/range_all 反而更快，1k/10k 持平。
- **本轮 9 项局部修复（F1–F9）全部完成并复验**，其中 F3/F6/F7 为验收或复核中新发现，F8/F9 为 Codex 复核发现的测试有效性漏洞（并发用例只查 readonly、图表校验不判失败）。无重大架构或破坏性改动；最终 diff 6 文件 +202/−3。
- **最终全量回归 185 项 OK / 179.4s / REGRESSION_SUITE_PASS / EXIT=0**（F8/F9 加固后复验），`git diff --check` 干净，浏览器套件与发布守卫通过。图表数值校验已按 F9 加固：正确数据通过，空/截断/错值/缺日/缺序列 11 项注入场景全部判失败。
- **冻结产物已按最新补丁独立重建并复验**（任务书 §5.2）：锁定依赖 15/15 精确匹配 → PyInstaller 独立目录构建 → `--verify-build` 16 项检查通过（`frozen: true, passed: true`，EXIT=0），sha256 `d8654cf3…3659e5`。未触碰既有 EXE、`dist/`、`build/`，未安装或更新依赖，未发布。
- **全项目审查已完成**：1161 个文件全部覆盖（完整审查 64 / 部分审查 67 / 排除 1030；partial 的实际范围逐条记录，见 §0）。后端六个大文件全文通读，未发现其他确认缺陷；凭据存储、ZIP/路径安全、事务恢复、单实例与更新链路、发布守卫、OAuth 页面、CSRF 边界、前端注入面均核对通过。
- **不能宣称"全项目通过"的保留项**（均为真实环境验收，非代码问题）：真实云端 OAuth/同步/内容写入、GPU 与完整 Live2D 渲染、TTS 语音包真实推理、原位升级（真实替换既有安装）、真实大词库、托盘真实交互、原生测试入口（本会话 `spawnSync` EBUSY）。这些项在本报告中逐条列出（§5），不以静态检查或合成数据冒充运行证据。
