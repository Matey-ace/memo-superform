# 文章自动精选词汇 → 加入墨墨学习列表

本文档描述已实现的功能、边界、以及**尚未验证**的部分。所有数字都标注了来源类型：
**实测**（有原始数据）、**静态证据**（读代码/读规范得出）、**假设**（未验证）。

---

## 1. 用户可见流程

1. 工具栏「从文章选词」按钮 → 打开浮层（`js/article-vocab-wire.js` 创建，默认不打开就不创建任何 DOM，也不发任何请求）。
2. 粘贴文章 → 可选填标题 / 目标水平 / 用途 / 期望词数（默认 20）。
3. 点「开始挑选」→ 本地抽取英文 → 构造提示词 → 调 AI → 用原文校验 AI 输出 → 显示**候选预览**。
4. 预览里每个词显示：词形、词性、中文释义、**原文中的实际上下文**、推荐理由。可逐个勾选/取消（默认全选）。
5. 点「加入墨墨学习列表」→ 查官方词 ID → 按批提交 → 显示真实结果（提交数 / 实际加入数 / 差额说明）。
6. 可选：打开「自动添加」开关（记住授权）。开启后挑选完成会直接提交，**不再弹二次确认**。默认关闭。

**关键语义**：步骤 3 与 5 之间有明确的预览+确认，默认不会在用户点确认前写云端。自动添加是**独立选择加入**（opt-in），且授权在切换账号时被撤销。

---

## 2. 云端写入的唯一入口（静态证据 + 审计脚本）

`_verification/perfvocab/G/audit_write_paths.py` 的输出：

```
/api/article-vocab/select        add_words=False query=False
/api/article-vocab/parse         add_words=False query=False
/api/article-vocab/query-ids     add_words=False query=True
/api/article-vocab/add           add_words=True  query=True
```

全仓 `add_words` 的实际调用点只有一个：`app_api.py:336`。

这意味着：
- 打开面板不写云端。
- 粘贴文章、选词、预览都不写云端。
- 只有 `/api/article-vocab/add` 会写，且它要求 `confirm is True`。

---

## 3. 写保护的层次（每层都可独立拒绝）

| 层 | 位置 | 作用 |
|---|---|---|
| 1. 全局意图 | `app_api.py` `/add` 入口 | `confirm is True` 才继续；否则 400 |
| 2. 等级参数 | `/add` 入口 | `advance` 只接受 `None`/`False`，其它值直接拒 |
| 3. 账号代次 | `/add` 入口 | `account_epoch` 与当前不一致 → 409 `stale` |
| 4. 账号代次（写入前） | `app_api.py:330` 每批之前 | **再次**核对；账号切了就停，已提交部分如实报告 |
| 5. 幂等 | `_article_vocab_operations` | 相同 `operationId` 不重复提交，直接回放上次结果 |
| 6. 代理层 | `server.py:706` | `retryable=False` → 写请求 429 **不自动重试** |
| 7. 白名单 | `server.py:896` | 只放行确切路径 `study/add_words` 且不得带 query 参数 |

第 4 层是**本轮修的真实缺陷**：原来只在查询前校验账号，若用户在"查 ID 之后、写入之前"切换账号，会把上一个账号的选词写进新账号。现在每批写入前都重新核对，且有测试锁住（`test_account_switch_during_write_stops_before_cloud_write`，断言 `add_words` 一次都没被调用）。

---

## 4. API 结果真实性

官方 `study/add_words` 只返回一个 `added_count`，**没有逐词结果**（依据：`api_bundle.yaml` 该操作的 200 响应 schema 只有 `added_count`，见 `_verification/perfvocab/E/api_bundle_excerpt.txt`）。

因此本功能：
- **不推断**任何词的单独成功/失败。
- `added_count < submitted` 时显示**差额说明**，而不是编造"哪些词失败了"。
- 查不到官方 ID 的词归为 `missing`，明确显示"未在墨墨词库中查到，未提交"——**这不是失败**，属于正常结果。
- 一个词都没提交时返回 `status: "none"` 并说明原因，绝不显示"已添加"。
- 浏览器测试有一条断言专门守着这点：候选区不得出现 `已添加|添加成功|已成功加入`（`tests/browser/article-vocab-ui.js`）。

超时分两类，都如实传到界面：
- **读超时**（查询词 ID）→ 502 `timeout`，`retryable=true`，可以安全重试。
- **写超时**（提交）→ 502 `uncertain`，`retryable=false`，**不可自动重试**。因为服务端可能已经写成功，重试会造成重复提交。界面必须告诉用户"结果未知，请到墨墨里核对"。

---

## 5. 选词质量约束

- 只分析英文：`extract_english` 会真的剔除非英文（实测 `'Hello 世界 this is 中文 mixed text.'` → `'Hello this is mixed text'`）。
- 每个候选词必须有**原文中真实存在的上下文**：`parse_selection` 会拿原文校验 AI 给出的 `context`，伪造的条目进 `rejected` 而不是 `items`。这是防"模型编造证据"的唯一关卡。
- 稀有 ≠ 值得学：提示词里明确要求优先高频/可复用/与目标水平匹配，而不是越生僻越好。
- 词数是**上限**，不是指标：原文里没有足够好的词就不凑数（界面有此说明）。
- 文章长度上限 `MAX_ARTICLE_CHARS = 200_000`，超出会截断并如实标记 `truncated`。

---

## 6. AI 配置与角色记忆隔离

- 复用项目既有 AI 配置（`localStorage` 的 `ai_endpoint`/`ai_key`/`ai_model`/`ai_provider`），不另建一套设置。
- 文章选词是结构化任务，陪伴角色的人设会改变模型语气并污染 JSON 形状。因此 `js/article-vocab-wire.js` 的每次 AI 调用都带 `noMemory: true`，`server.py` 的 `/proxy/ai` 在该标志为 true 时跳过记忆注入（`server.py` 新增分支；**默认路径不带该标志时行为不变**）。
- 浏览器测试断言所有 AI 请求都带了 `noMemory === true`。

---

## 7. 已实现的性能改动（与本功能相邻，但独立）

1. **`records_count` 改为 COUNT**（`app_api.py:613`）：原来 `len(db.get_records(profile_id))` 会把全部行读成 dict 只为取长度。改为 `db.get_record_count()`。
   - **实测收益**（M 的原始数据）：10k 行约 53ms、50k 行约 409ms。
   - **1k 规模下的 1.3× 处于噪声内**，已从文档降级，不作为收益声称。
2. **图表隐藏时不再对 0x0 容器 `echarts.init`**（`js/charts.js`）：B 实测陪伴模式下 12 次 init 落在 `0x0` 容器，3 次入口合计中位 124.9ms。修复后热图与趋势线**逐点一致**（`CHART_VALUE_PASS`），3 主题 × 3 宽度 × 4 缩放均正常（`DASHBOARD_SMOKE_PASS`）。
3. **首屏字节**：
   - favicon 从 `img/icon.png`（2081 KB）换成 `img/icon-32.png`（3 KB）+ `apple-touch-icon` 180px（77 KB）。
   - 陪伴备用图 `anon-think.gif`（1766 KB）改为 `data-deferred-src`，首屏不下载，仅在真要显示备用图时才加载（D 的 3 处惰性恢复 + Playwright 实测：首屏 GIF 请求数 **0**）。
   - 合计把标准静态字节的最大两项移出首屏。

**未做**（有依据地拒绝）：
- 字体裁剪：D 核实「954 KB」是 `css/fonts.css` 的元数据，字体实体是 **20.97 MB / 984 个 woff2**，且**无任何未引用证据**；违反"不得裁中文覆盖"。另：标准主题本来就不加载这些字体。
- Live2D 库懒加载：901.8 KiB 收益真实，但要把库就绪改成异步状态机，回归面覆盖整个渲染器，建议另行排期。
- `visibilitychange` 暂停 ticker：D 实测最小化后 rAF 已降到 1.06 fps、GPU 归 0、CPU 2.392%→0.059%，收益边际；且存在两个不同 ticker 易误伤。
- TTS 音频缓存：失效键需覆盖角色包/参考音频/文本/语速等，换角色包会配音色，正确性风险高于性能收益。

---

## 8. 另一处真实缺陷修复（与本功能无关，但本轮发现）

`tts.py` 的 `_read_loop` 只按 `request_id` 分发，**不看 `type`**。worker 会无条件推送 `type: "progress"` 且共用同一 `request_id`，于是第一个进度帧会被当成命令结果 → `output_wav_path` 缺失 → 抛"语音合成没有输出音频"。

已修：只投递非 `progress` 帧；无 `type` 字段的旧格式帧按结果处理（向后兼容）。测试 `tests/test_tts_worker_frames.py` 7 项覆盖：进度帧不被当结果、只有进度帧时不投递伪成功、无 type 的旧帧仍可用、大小写不敏感、非 JSON 行跳过、其它 request_id 忽略。

**未验证**：真实合成未跑（需 11 GB 外置包）。该修复只保证了帧分发逻辑正确，真实 progress 帧的到达时序仍可能受缓冲影响。

---

## 8. 已被独立复核推翻的问题（原本被 543 项全绿掩盖）

独立复核子智能体指出并实测了三类此前未发现的问题。**当时 543 项测试全绿，但它们验证的是替身。**

### 8.1 `account_epoch` 这个键在真实路径里根本不存在（最严重）

`companion_runtime.account_context()` 只返回
`{account_key, profile_pk, data_epoch, has_token}` —— **没有 `account_epoch`**。
而 `app_api.py` 有 7 处直接读 `context["account_epoch"]`。

实测后果：
- `GET /api/article-vocab/status` → `KeyError` → 连接直接断开，客户端收到 `RemoteDisconnected`，**一个字节都没返回**；
- `POST /api/article-vocab/add` → 一律 500。**这个功能在真实环境里当时不可能写入云端。**

为什么测试没抓到：`tests/test_article_vocab_routes.py` 的 `RouteHarness` 把
`_companion_context()` 换成 `{"account_epoch": 7, ...}` 替身，**没有一个测试调用过真实的 `account_context()`**。

已修：`account_context()` 返回值补 `"account_epoch": int(state["account_epoch"])`
（该列本来就在 `companion_account_state` 的查询里，只是没往外传）。
新增 `tests/test_article_vocab_real_context.py`（5 项）**不替换 `_companion_context`**，
直接走真实 `account_context()`，并断言 `data_epoch` 与 `account_epoch` 保持独立。

### 8.2 真实前端请求头被 403 全拦

`_handle_api_post` 的 CSRF 校验只接受 `X-Requested-With: XMLHttpRequest`，
而 `js/article-vocab-wire.js` 发的是 `MemoSuperform` → **所有 `/api/article-vocab/*` POST 一律 403**。
全仓其他 `/api/*` POST 都用 `XMLHttpRequest`，只有我这个新文件写错。

已修。真实 socket 实测现在返回：`confirm` 缺失 → 400 `confirm_required`；
body 完整但未连账号 → 502 `timeout`（`retryable:true`，符合预期）。

### 8.3 双重响应（客户端解析必炸）

`_companion_context()` 失败时**自己已经 `_send_json(401)`**，然后返回 `None`。
原代码 `if current is None or ...: 发 409`，于是第二个响应的状态行被塞进第一个响应的 body：

```
{"error": "请先连接墨墨账号"}HTTP/1.0 409 Conflict\r\n...
```

后果：浏览器 `response.json()` → `JSONDecodeError: Extra data`；
wire 的 `.catch(() => ({}))` 把它吞成 `{}`；用户只看到兜底文案 `请求失败：401`，
精心构造的"已提交多少词"**全部丢失**。触发条件很现实：提交过程中 token 过期。

同一类问题还有第二处：`/status` 分支自己发响应并返回 `None`，
而分发器用 `if result is not None` 判断 → `None` 被误判成"不属于本模块"→ 再发 404。
真实 socket 实测确实出现过 200 后面跟一个 404。

已修：`current is None` 时直接 `return`（401 已发过）；分发器改为按路径前缀判断归属，
不再依赖返回值是否为 `None`。实测：`/status` 响应 76 字节、单一响应，无第二个状态行。

### 8.4 幂等表 `clear()` 会丢弃已写云端的记录

原实现 `if len(...) > 512: clear()`。实测插入 600 条后早期记录消失，
重放同一个 `operationId` **真的又发了一次 `add_words`** —— 一次真实的重复云端写入。

已修：改为 FIFO 淘汰最旧一条，上限对齐 `>= 512`。
测试 `test_store_evicts_oldest_instead_of_clearing`、`test_recall_ignores_account_epoch` 锁住行为。

### 8.5 代次不符时的回放语义

原实现：`operationId` 命中但代次不符 → 回 409「不会重复提交」。
复核指出：`operationId` 是前端每次 submit 新生成的（`article-vocab.js:831`，全仓唯一生成点、不持久化），
所以这条路径现实中只可能是"同一次提交被打断后的重放"，409 与 200 回放的唯一区别就是信息量。
已改为 **200 回放完整结果 + `account_switched: true`**，安全性不变（都不写云端）。

### 8.6 浏览器测试的真实盲点

原 `tests/browser/article-vocab-ui.js` 把 `/api/article-vocab/add` 整个 `route.fulfill` 掉，
**完全不看请求体**，所以上面 8.2 的字段错位它测不到。
现已新增：真实点击提交按钮 → 捕获 `postData` → 断言 `operationId` 非空、
`lemmas` 非空字符串数组、`confirm === true`、`advance === false`。

### 8.7 顺带修掉的死代码

`server.py` 的 `retry_error` 兜底分支不可达（`threading.Event().wait()` 恒返回 `False`，
`break` 永不执行），且一旦可达会 `return 429, {"error": ...}, None` —— 返回 **dict 而非 bytes**，
`_send_upstream_json` 会立刻 `AttributeError: 'dict' object has no attribute 'decode'`。
已删除该分支。

---

## 9. 测试与验证入口

```
# 全量（含浏览器）
$env:MEMO_DATA_DIR = "D:\MeMo1\_verification\perfvocab\M\run1"   # 必须隔离
powershell -NoProfile -ExecutionPolicy Bypass -File tests/run.ps1 -Browser

# 只跑文章选词相关
python -m unittest tests.test_article_vocab tests.test_article_vocab_routes tests.test_official_vocab_api
node tests/article-vocab-regression.js
node tests/browser/article-vocab-ui.js
```

最后一次全量结果（实测）：**551 项 Python + 5 个浏览器脚本全绿**，`REGRESSION_SUITE_PASS`。

---

## 10. 未验证 / 残余风险

1. **真实云端写入未验证**。所有 `/add` 测试都是 mock 或路由级拦截。真实 `study/add_words` 需要用户明确授权某个账号 + 少量指定词。**未经此授权，功能在真实账号上的写入结果属未验证。**
   已确认的仅是：真实 socket 下请求能走到上游（未连账号时返回 502 `timeout`、`retryable:true`），之前那个"一律 500 / 401 断连"的硬故障已经修掉。
2. **真实 AI 调用未验证**。测试全部拦截 `/proxy/ai`。真实模型的 JSON 合规率、`context` 是否总能命中原文，依赖模型行为。
3. **官方规范未声明错误码**。`api_bundle.yaml` 36 个操作只声明 `'200'`，`429`/`Retry-After` 的出现次数为 0。因此 429/限流/权限失败的处理是**HTTP 常规 + 仓库经验**，不是官方契约。
4. **`official_vocab_api` 与 `article_vocab` 各有一份 `map_voc_ids`**。契约要求路由层使用 `article_vocab` 的，但两份实现仍并存，存在漂移风险（未统一）。
5. **冻结包未构建**。本轮改了 `index.html`（favicon、deferred gif、新 script 标签）与新增静态资源，若要发布需重新构建并跑 `--verify-build`。未执行。
6. **`_article_vocab_operations` 是进程内内存、上限 512 条、超出全清**。进程重启后幂等表丢失；极端情况下（超 512 次不同 operationId 后回放旧操作）可能重复提交。已按"重复提交预防"取舍，但该上限策略未做压力验证。
7. **`tests/perf/` 下的历史测试模块**在无 `MEMO_DATA_DIR` 时导入 `server` 会在模块 import 期触发 `db.init_db()` 写库。本轮已为新增/相关模块加了模块级隔离与硬断言，但 `test_companion_api.py` 等既有模块仍依赖 `run.ps1` 提供隔离（**既有问题，未修**）。详见 `_verification/perfvocab/INCIDENT-test-isolation.md`。