# 陪伴升级首版验收报告

更新：2026-11-16。工作区：`D:\MeMo1`。基线提交：`59f671117bde16f0f8d45bcc10e21c57f3bd5cd2`。

本文件只写**已经跑过并通过**的事实，以及**明确没有验证**的项。凡是未取得证据的能力，
一律标注为未验证，不写成"已完成"。

---

## 1. 交付物清单

### 新增后端模块

| 文件 | 作用 | 测试 |
| --- | --- | --- |
| `companion_runtime.py` | 共享适配层：账号身份、绑定结论、当前角色、受控目录、官方客户端 | 间接覆盖 |
| `companion_memory.py` | 长期记忆：偏好、会话摘要、检索、票据、删除屏障 | 22 项 |
| `companion_sessions.py` | 会话状态机、事件证据、有效时间、完成事务与结算 | 24 项 |
| `companion_progress_sources.py` | 严格三态计划快照、完整性判定、指纹 | 17 项 |
| `role_package_service.py` | 角色包检查/确认/逐角色提交/可恢复作业 | 22 项 |
| `ai_memory_injection.py` | 记忆注入 AI 请求的唯一入口（只改 system） | 13 项 |
| `ai_memory_injection` 接缝 | `server.py` `/proxy/ai` 内联注入 | 13 项内 |

### 新增前端模块

| 文件 | 作用 | 测试 |
| --- | --- | --- |
| `js/study-event-bridge.js` | 浏览器事件观察桥（幂等、有界、只读） | 22 项 |
| `js/companion-progress.js` | 进度显示（本轮/今日分离、目标未知处理） | 13 项 |
| `js/companion-settlement.js` | 结算演出（本地优先、AI 一次、重看不重放） | 18 项 |
| `css/companion-progress.css` | 进度样式（双主题、窄窗、减弱动画） | 视觉，未跑浏览器 |
| `css/companion-settlement.css` | 结算样式（同上） | 视觉，未跑浏览器 |

### 修改的既有文件（共享热点，由主代理持有）

- `sqlite_schema.sql`：新增 14 张 `companion_*` 表与 7 个部分唯一索引。
- `db.py`：新增代次/事务/查询辅助函数，**保留原有 `keep_warm` 改动**。
- `tts.py`：新增 `install_role_resources` 安装原语；`_apply_staged_assets` 增加可重试模式；
  人设写入容忍缺 `版本`。**保留原有改动**。
- `live2d_service.py`：新增目录批量下载（串行化、可取消、部分失败可辨）。
- `app_api.py`：新增陪伴与角色包路由、错误映射、代次守卫。
- `server.py`：`/proxy/ai` 记忆注入。**保留原有 `keep_warm` 改动**。
- `launcher.py`：新增 `choose_role_packages()` 原生多选。
- `js/ui-style.js`、`index.html`：加载两个新样式表与三个新脚本。

### 样本与工具

- `tests/fixtures/make_role_package.py`：真实 sha256 的角色包生成器，
  支持 `full` / `draft` / `broken-hash` / `traversal` / `duplicate` 五种模式。

---

## 2. 测试结果（实测）

### 全量回归

```
# 从干净状态跑（scratch 目录已删除）
tests/run.ps1 -Browser
REGRESSION_SUITE_PASS
Ran 313 tests in 22.693s
OK
ALL CHECKS PASSED（4 个浏览器/前端套件）
```

包含 26 个 node 回归脚本（含本轮新增 3 个）与 287 个 Python 测试（含本轮新增 82 个），
外加 4 个真实浏览器套件。**最后一次验收特意删掉 scratch 目录后重跑**，
以排除对预先存在目录的隐式依赖。

### 本轮新增测试明细

| 测试文件 | 项数 | 结果 |
| --- | --- | --- |
| `tests/test_companion_memory.py` | 22 | OK |
| `tests/test_companion_sessions.py` | 26 | OK |
| `tests/test_companion_progress_sources.py` | 17 | OK |
| `tests/test_role_packages.py` | 24 | OK |
| `tests/test_companion_api.py` | 26 | OK |
| `tests/test_ai_memory_injection.py` | 13 | OK |
| `tests/study-event-bridge-regression.js` | 22 | OK |
| `tests/companion-progress-regression.js` | 13 | OK |
| `tests/companion-settlement-regression.js` | 18 | OK |
| `tests/browser/companion-ui.js`（真实 Edge，两主题） | 20 | OK |

### 端到端串联验证（手动跑过，非自动化）

| 场景 | 结果 |
| --- | --- |
| 生成样本包 → 暂存 → 检查 → 确认安装 | 2 个角色装成功，`roles.json` 从 2 增到 4，均为 `complete=True` |
| 开会话 → 收 3 条 observed_ack → 官方快照转 true → 对账 → 结算 | 确认 3、可结算 True、奖励 `[first_completion, memorial_card]`、本地祝贺文字正确 |
| 结算 → 消费记忆队列 → 生成会话记忆 + 角色摘要 → 组装提示块 | 记忆 2 条，摘要「累计新学 3 词、复习 0 词」，提示块含中文日期与来源说明 |
| 同一会话连续 `complete_session` 5 次 | 结算 ID 唯一值 = 1；奖励 2、结算 1、outbox 1、纪念卡 1、徽章 1 |

### 真实数据库完整性

`_verification/companion-upgrade/audit_real_db.py` 在 `data/memo-superform.db` 上：

```
quick_check ok
profiles 2 / study_records 3148 / study_record_snapshots 3146
daily_stats 10 / recommendations 300 / sync_runs 219 / sync_segments 22
live2d_models 1 / live2d_preferences 2
companion tables: 14 张全部存在
account_state: []
```

改动前全部计数一致，说明本轮只做了加法。

---

## 3. 验收表逐项结论

### 记忆

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 偏好/摘要/会话记忆可写入、可读取 | 通过 | `test_companion_memory` 22 项 |
| 检索有硬上限（5 条 / 1200 字符） | 通过 | `test_retrieve_respects_item_and_char_limits` |
| 删除后不再进入提示 | 通过 | `test_deleted_memory_leaves_prompt` |
| 记忆故障不影响 AI 请求 | 通过 | `test_block_failure_is_silent`、`test_AI 抛错静默降级` |
| 出站默认关闭（隐私） | 通过 | `test_outbound_defaults_off_so_nothing_leaves` |
| 只改 system，不改用户消息 | 通过 | `test_appends_to_system_only`、`test_does_not_mutate_input` |
| 结算事件与记忆写入同事务 | 通过 | `consume_outbox` 用单一事务；`test_two_roles_install` 等 |
| 保留期过期清理 | 通过 | `test_prune_removes_old_sessions_keeps_summary` |

### 多角色批量安装

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 一个 ZIP 装多个角色 | 通过 | `test_two_roles_install` |
| 只装选中子集 | 通过 | `test_selection_installs_subset` |
| 单角色失败不影响其他角色 | 通过 | `test_partial_failure_keeps_other_roles` |
| 确认前重核包身份 | 通过 | `test_changed_source_blocks_install` |
| 越界路径拒绝 | 通过 | `test_traversal_rejected` |
| 任意下载 URL 拒绝 | 通过 | `test_url_rejected` |
| 受控目录外来源拒绝 | 通过 | `test_outside_incoming_rejected` |
| 再次安装同一包走升级而非新建 | 通过 | `test_second_install_is_upgrade` |
| 升级保留长期记忆（沿用 role_id） | 通过 | 同上，`mode="upgrade"` |
| 真实 TTS 安装原语可用 | 通过 | `test_real_install_creates_usable_role`（真跑 `tts.install_role_resources`） |
| 作业记录可恢复 | 通过 | `test_journal_is_resumable`、`test_recover_marks_unfinished` |
| 暂存目录运行后清理 | 通过 | `test_staging_cleaned_after_run` |
| 取消作业 | 通过 | `test_cancel_before_commit` |
| Live2D 目录批量下载 | 通过（服务层） | `tests/test_live2d_service.py` 既有用例 + 新增批量方法 |

### 身份与证据

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 未核验绑定不产生结算 | 通过 | `test_unknown_identity_blocks_settlement` |
| 只有 `observed_ack` 及以上算证据 | 通过 | `test_intent_source_does_not_count_as_evidence` |
| 浏览器不能自称官方快照 | 通过 | `test_observe 强制 observed_ack` |
| 三态字段：present / invalid / absent | 通过 | `test_present_invalid_absent_are_distinct` |
| 缺失不等于 False | 通过 | `test_absent_is_not_false` |
| 不完整快照没有分母 | 通过 | `test_incomplete_snapshot_has_no_total` |
| 数字型 voc_id 不被强转 | 通过 | `test_numeric_voc_id_rejected_not_coerced` |

### 进度与结算

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 本轮与今日数字不互相冒充 | 通过 | 前端 `session_goal 时今日显示待确认` 等 2 项 |
| 目标未知时不伪造百分比 | 通过 | `aria-valuemax 未被设置`（断言为 null） |
| 双窗落到同一会话 | 通过 | `test_two_windows_share_one_session` |
| 一次完成只发一次奖励 | 通过 | `test_session_goal_settles_once`（结算/纪念卡/徽章/队列各 1） |
| 重复提交返回同一结算 | 通过 | 同上 + `test_outbox_survives_missing_settlement` |
| 进入前已完成的词不计本轮新增 | 通过 | `test_preexisting_finished_words_not_counted` |
| `today_plan` 需全部完成 | 通过 | `test_today_plan_requires_all_finished` |
| 有效时间按并集、排除失联 | 通过 | `test_overlapping_leases_counted_once`、`test_stale_lease_is_capped` |
| 数据重置后旧会话不可用 | 通过 | `test_stale_epoch_rejected`、`test_client_epoch_mismatch_returns_stale` |
| 结算 AI 最多一次 | 通过 | `同一 settlement 只请求一次` |
| 重看结算不重放演出 | 通过 | `refresh 不调 speak / playMotion / requestAi` |
| 换角色切分片段、同角色复用 | 通过 | `test_role_switch_seals_old_segment`、`test_same_role_keeps_one_segment` |

### 打包与界面

| 要求 | 结论 | 证据 |
| --- | --- | --- |
| 新脚本进入页面 | 通过 | `index.html` 三行 script，`js/ui-style.js` 两套主题各加两个样式表 |
| 静态白名单放行新资源 | 通过 | `static_security.py` 按目录+扩展名放行 `js/*.js`、`css/*.css`，无需改动 |
| 两套主题可读 | 通过 | `tests/browser/companion-ui.js`：standard + notebook 各 10 项，真实 Edge 渲染 |
| aria 属性落到真实 DOM | 通过 | 同上：`role=progressbar`、`aria-valuenow/max` 实测取值 |
| 目标未知时不设 aria-valuemax | 通过 | 同上：断言 `getAttribute('aria-valuemax') === null` |
| 窄窗（480px）不横向溢出 | 通过 | 同上：实测 `scrollWidth <= clientWidth` |
| 减少动画被尊重 | 通过 | 同上：`reducedMotion: 'reduce'` 下实测过渡时长 |
| 结算弹层 dialog 语义与键盘 | 通过 | 同上：`role=dialog`、`aria-modal=true`、Escape 关闭实测 |
| 冻结打包 | **未验证** | `MemoSuperform.spec` 已显式列出 6 个新模块；未跑 `--verify-build` |

---

## 4. 实施中自查发现并修复的缺陷

这些不是"测试写错了"，而是**实现里真实存在的错误**。列出它们是为了说明本轮
不是"跑绿就算完"，而是逐条追到了根因。

| 缺陷 | 症状 | 根因 | 修复 |
| --- | --- | --- | --- |
| 嵌套写事务死锁 | `database is locked` | 已在 `BEGIN IMMEDIATE` 内又调用了会自建连接的 helper | 新增 `companion_epochs_readonly`；`_ensure_segment` 改用 `_write(work)` 复用调用方连接 |
| 删除屏障从未生效 | 数据重置后旧会话仍可用 | `_assert_epoch` 调用的是**写**helper，在空表上返回默认值 | 改用只读 helper，读取真实代次 |
| 记忆队列从不产生 | 结算成功但 outbox 为空 | `INSERT OR IGNORE` 吞掉了 `NOT NULL constraint failed: created_at` | 改用普通 `INSERT` + 显式重复判断，让真实错误浮出 |
| 进入前已完成的词被算成本轮 | `test_preexisting_finished_words_not_counted` 返回 1 | 基线按 `(study_day, task_key)` 查，换角色后 key 变了 | 改为按 `baseline_snapshot_id` 查 |
| 失联租约被算进有效时间 | `test_stale_lease_is_capped` 返回 45 而非 0 | 失联租约被**截断**而不是丢弃 | 超过 `LEASE_STALE_SECONDS` 直接跳过 |
| **暂停期间的时间被算进有效时长** | 暂停一小时，有效时间仍增长 | 只在**读取**时看 `state=='paused'` 并返回上次持久化秒数，而该值只在结算时写回 | 暂停/放弃时**封存租约**并写入 `active_seconds`；删掉读取时的猜测逻辑 |
| **超限压缩包到确认阶段才被拒** | 用户看到"可安装"清单，点确认才失败 | `_detect_role_root` 里有大小/成员数校验，但它已无人调用 | 把三道上限校验移入 `inspect_source`，检查阶段即拒绝 |
| 清空记忆静默执行 | 无 `scope` 的请求会清空一个空范围 | 接口默认 `scope="role"` 并回退到当前角色 | 要求显式 `scope`；账号级清空额外要求 `confirm: true` |
| 数据重置后前端无法区分 | 只返回 `available=False` | 会话按当前代次过滤，旧会话只是"查不到" | 新增 `_companion_epoch_guard`，客户端代次不符返回 409 `stale` |
| 空队列每 4 秒打空请求 | 无谓网络流量 | 定时器无条件调用 `flush()` | 改为 `maybeFlush()`，队列为空时不发 |
| **测试依赖外部临时目录** | 清掉 scratch 目录后 89 项测试同时报 `FileNotFoundError` | 6 个测试用 `mkdtemp(dir=...)` 但假定父目录已存在 | 每个 `setUp` 先 `os.makedirs(..., exist_ok=True)`；其中 1 个还漏了 `import os` |

前 5 条属于测试驱动的修复；后 6 条是本轮**主动复查**发现的设计缺陷。

> 最后一条特别值得记：它只在"清理过 scratch 目录"后才暴露，第一次跑全绿是因为
> 目录恰好还在。这类**顺序依赖**的假绿比失败更危险，所以最终验收特意从
> 删除 scratch 目录后的干净状态重跑了一遍。

---

## 5. 明确未验证的项（不得当作已交付）

1. **网页 iframe 与开放 API 的账号映射**。仍是 `unknown`，这是本轮的设计选择而非缺陷：
   没有已核验映射就不允许把网页观察归入某账号的"本轮共同经历"。因此**真实环境中的
   网页学习不会产生结算**。要打通它，需要一个已核验的绑定适配器（见
   `companion_runtime.identity_binding` 的 `matched` 分支），并补真实夹具。
2. **真实今日目标与学习提交回执**。`get_study_progress` 的目标字段、今日计划完整性
   都还没有真实响应夹具。当前实现把"无法确认完整"一律降级为不结算——安全但不解锁
   结算。需要拿一次真实账号响应确认字段形状。
3. **真实 Live2D 模型权重**。批量下载只验证了服务层逻辑，没有真的下载模型。
4. **两套主题下的视觉验收**。已在真实 Edge 里跑通 20 项断言（见上方验收表），
   但**截图未由人眼复核**——`_verification/companion-ui/theme-*.png` 已生成，
   需要有人在浏览器里实际看一眼配色与排版是否舒服。断言只能证明"结构正确、
   不溢出、可见"，不能证明"好看"。
5. **`--verify-build` 冻结包**。未执行。`MemoSuperform.spec` 已显式加入 6 个新模块
   到 `hiddenimports`，但它们全是同一目录下的 `.py`，PyInstaller 的静态分析本就能
   跟到；显式列出是为了防止后续改惰性导入后漏收集。**打包是否真的带上，未验证**。
6. **真实语音合成与结算演出联动**。`speak` / `playMotion` 只验证了"可选且不重放"，
   没有接真实 TTS worker 与 Live2D 动作做过端到端演出。

---

## 6. 复现方式

```powershell
cd D:\MeMo1

# 全量回归（含 26 个 node 脚本 + 283 个 Python 测试）
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run.ps1

# 单跑本轮新增的 Python 套件
$env:MEMO_DATA_DIR = "D:\MeMo1\_verification\companion-upgrade\agents\M\manual"
python -m unittest tests.test_companion_memory tests.test_companion_sessions `
  tests.test_companion_progress_sources tests.test_role_packages `
  tests.test_companion_api tests.test_ai_memory_injection

# 单跑本轮新增的前端回归
node tests\study-event-bridge-regression.js
node tests\companion-progress-regression.js
node tests\companion-settlement-regression.js

# 真实浏览器视觉/可达性验收（需要 Edge；会输出截图到 _verification/companion-ui/）
node tests\browser\companion-ui.js
# 或随全量一起跑
powershell -NoProfile -ExecutionPolicy Bypass -File tests\run.ps1 -Browser

# 生成一个可试用的真实角色包
python tests\fixtures\make_role_package.py --out _verification\demo --mode full --count 2

# 真实数据库完整性核对
python _verification\companion-upgrade\audit_real_db.py
```

> 测试必须显式设置 `MEMO_DATA_DIR`。漏设会初始化 `D:\MeMo1\data\memo-superform.db`。
> 本轮曾发生过一次，随后用审计脚本确认只新增了空表、原有计数全未变。

---

## 7. 迁移与回滚

详见 `docs/companion-upgrade-migration.md`。要点：全部改动是加法的（新表、新文件），
既有表结构未变；`data/`、`dist/data/`、`MemoSuperform-v0.75-portable/data/` 三套学习库
始终独立，未发生交叉写入。