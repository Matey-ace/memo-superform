# MeMo 陪伴升级：接口与状态契约 v1

日期：2026-11-16。状态：规划稿，供执行主代理 P0 核对后冻结；**以下新增接口、表和函数均尚未实施**。需求权威为 companion-upgrade-ai-execution-prompt.md，阶段与所有权在 companion-upgrade-blueprint.md。

## 1. 公共约定

- 所有路径基于实际 DATA_DIR，不硬编码生产库；测试显式设置 D 盘临时 MEMO_DATA_DIR。
- HTTP 沿用现有 GET/POST/DELETE。新增 `/api/*` 写请求按现有 `X-Requested-With: XMLHttpRequest` 及 Host/同源/正文上限接线；`/proxy/ai` 的头约定不同，不照抄。
- `_memo_identity()` 返回稳定账号键；经既有 `db.ensure_sync_profile()` 得到数据库 `profiles.profile_id`。内部称 `profile_pk`，外部稳定键称 `account_key`，避免把二者混用。身份由服务端解析，不接受客户端指定可信账号。
- 返回统一错误对象 `error={code,message,retryable,details}`；未知字段、超限与版本冲突返回明确错误。沿用既有 handler 的发送方式，M 负责新路由映射；不全局改写旧接口错误形状。
- ID 为服务端/受控适配器生成的不透明值；所有来源、角色、会话、结算引用检查归属。并发提交使用事务/持久唯一约束；前端取消只作辅助。
- 账号前端代次沿用 MaimemoAPI.getSessionEpoch()；数据库 data_epoch、memory account_epoch/role_epoch 为持久删除屏障，与前端代次分开命名。

新增 `companion_account_state(profile_pk PRIMARY KEY, data_epoch, updated_at)`，该控制行随 profiles 保留。session、片段、快照、事件、结算、奖励、outbox 和后台票据均带创建时 data_epoch；所有读写/回调比较当前值，旧代次拒绝或标废弃，不容客户端指定新代次覆盖所属关系。

## 2. 身份和证据：先查证再冻结字段

`identity_binding = {status: matched|mismatch|unknown, binding_revision, verified_at, source}`。

稳定用户标识必须来自受核验的上游身份语义，不用昵称或前端传入 profile_id 证明。P0 列出网页身份与 OAuth 身份的映射方法及脱敏夹具；拿不到映射时保留 unknown，官方当前账号今日进度仍可展示，但不把网页观察归到该账号的共同经历。

证据等级：

| 级别 | 允许用途 |
| --- | --- |
| intent | 点击/按键即时反馈；不增加确认完成量 |
| observed_ack | 已核验的请求响应/WS成功回执；matched 后可关联本轮词条/真实轮次，标本机观察 |
| official_snapshot | 服务端以当前档案授权取得并严格校验的快照；核验完成及奖励的依据 |

首选服务端官方快照＋小型页面观察桥；只有确认需要且有实际协议证据时适配 WS，不先重写整个代理。`getStudyProgress` 的目标字段仍待真实响应确认；`today_items` 已知 voc_id/is_new/is_finished 不能自动证明完整分母。

拟议快照：`snapshot_id/profile_pk/study_day/task_key/plan_version/plan_fingerprint/fetch_seq/requested_at/observed_at/completeness/total/items/source/binding_revision`。items 保留严格类型的 voc_id、is_new、is_finished 及真实可得关联字段。缺字段与 False 区别保存；截断/目标未知时 completeness != complete。

plan_fingerprint 只包含已核验的计划身份/成员/任务类型与学习日，不包含会随答题变化的 is_finished。旧 fetch_seq/旧计划响应不覆盖新快照；计划增删/跨日/重置走显式对账。官方请求共用 OFFICIAL_API_LIMITER，按账号去重并合并同步和多窗口触发，不每按键拉全量。

## 3. 持久会话、事件与计时

建议新增表：`companion_plan_snapshots`、`companion_sessions`、`companion_role_segments`、`companion_events`、`companion_settlements`、`companion_rewards`、`companion_outbox`，以及前述账号代次控制表。由 M 按现有迁移方式落库；C 提供字段/索引/事务建议与测试。

会话状态：`idle → active ↔ paused → completed|abandoned`；completed/abandoned 为终态。首次创建可直接 active，恢复重启后的会话先 paused 再对账。结算展示状态独立，不回写学习完成状态。

目标：`goal_kind=session_goal|today_plan`，保存 target_count、goal_revision、初始完成基线、完整快照引用和参与片段。session_goal 是明确设置的本轮新增目标；today_plan 仅在完整已知计划下可用。已有完成项只进今日视图。

本轮确认量需同账号匹配、会话参与证据和对应官方完成转变；仅有官方日增量而缺本轮关联时只更新今日视图，不假称当前角色共同学习。目标为 0、未知、无剩余、快照不完整时不新发完成奖励。调整目标后需重新对账及后续新确认事件，降低目标本身不结算。

P0应核对并冻结以下完成公式：令 P 为完整当前计划、D 为其中官方 is_finished=true 的条目集合、S 为进入基线后发生 false→true 且有 matched 本轮参与证据的完成集合。S 按规范任务/词条/完成周期去重，同词多轮判断仍保留事件但不重复增加词量。

- `session_goal`：本轮目标 N>0，且 |S|≥N，证据/目标/data_epoch仍有效，才可完成。
- `today_plan`：|P|>0 且 D=P，并且本轮存在新增完成及 matched 参与证据（|S|>0），才可完成。今日条形图用 |D|/|P|，本轮条形图用 |S|/本轮目标，二者不混用。起点已全部完成不产生新的本轮结算。

服务端规范会话基键为 `(profile_pk, data_epoch, study_day, canonical_task_key)`；同基键 active/paused 只允许一条，使用数据库部分唯一索引或等价事务约束。goal_kind/目标数不另建并行活动会话，改目标推进 goal_revision。基键事务下先恢复活动会话；终态后用户明确开始新轮才由服务端分配 run_generation，并用请求 operation_id 幂等。未知上游任务键先使用服务端当前学习入口的稳定命名空间，不采用每个窗口各造的随机任务键；unknown身份仍不得奖励。

拟议事件示例（不是现有上游格式）：

```json
{
  "schema_version": 1,
  "event_id": "opaque-event-id",
  "session_id": "server-session-id",
  "source_instance_id": "window-instance-id",
  "seq": 7,
  "frame_generation": 2,
  "binding_revision": 3,
  "goal_revision": 1,
  "type": "answer_ack",
  "source": "observed_ack",
  "task_key": "verified-task-key",
  "item_key": "verified-voc-id",
  "round_key": "verified-round-id",
  "action": "FAMILIAR",
  "observed_at": "2026-11-16T02:00:00Z"
}
```

seq 仅在每 source_instance 内排序；event_id 网络幂等，业务去重另用任务/条目/轮次。没有稳定轮次时保留证据限制，不用重试制造新轮。桥校验 event.source、origin、iframe实例、代次、结构与上限；UI观察永远不升级为官方证据。

计时用服务端可校验的活动租约/区间并集，前端心跳间隔初值 15 秒、失联暂停阈值初值 45 秒、长闲置阈值初值 120 秒，均为 P0 可调整的提案。时间统计排除暂停/隐藏/失联/闲置，不信任任意客户端累计秒数；多窗口不重复累加。学习日使用 study_sync.beijing_today()。

会话接口（拟议）：

| 方法与路径 | 输入与结果 |
| --- | --- |
| POST /api/companion/sessions | 创建/恢复目标会话；服务端确定账号、角色和 ID；返回 session/revision/binding/progress |
| GET /api/companion/sessions/{id} | 本人会话快照与已存结果 |
| POST /api/companion/sessions/{id}/state | pause/resume/abandon/set_goal，加 expected_revision；冲突 409 |
| POST /api/companion/sessions/{id}/events | 有界批次 ≤100，建议正文 ≤256 KiB；返回 accepted/duplicate/rejected/revision |
| POST /api/companion/sessions/{id}/reconcile | 合并限流核验；返回真实证据级别、目标版本、身份及进度 |
| POST /api/companion/sessions/{id}/complete | 只提交 evidence_refs 与 expected_revision；服务端重新核验，不接收任意完成数 |
| GET /api/companion/sessions/{id}/settlement | 读唯一结算；重看不新生成奖励/AI/TTS |

换角色时由 M 基于服务端 active_role_id 封存旧角色片段并创建新片段；换服装不换角色身份。完成事务固定 completion_role_id、persona/表现快照，避免完成后切角色改变旧结算。

## 4. 结算、奖励与记忆派生

同一事务：核验当前目标与证据 → 会话 completed → 唯一结算 → 唯一纪念卡/首次完成徽章 → 唯一记忆 outbox。

唯一约束建议：结算 `(profile_pk,data_epoch,session_id)`；纪念卡 `(profile_pk,data_epoch,session_id,reward_type)`；首次完成徽章 `(profile_pk,data_epoch,reward_type,period_key)`；outbox `(profile_pk,data_epoch,session_id,segment_id,event_type)`。记忆消费和奖励分离幂等；仅清记忆不重发奖励，明确清学习数据后按新data_epoch重新积累。

结算字段：settlement_id/session_id/profile_pk/completion_role_id/confirmed_new/confirmed_review/active_seconds/verified_weak_words/evidence_refs/goal_snapshot/local_message/reward_ids/created_at/ai_state。数值与结算一经提交不可被后续计划改写。错误率缺依据时不展示。

AI 仅润色短台词，ai_state 持久化 idle/pending/done/failed，采用条件更新保证一次；不重看重调。演出票据包含 settlement_id、role_id、账号前端代次、data_epoch、memory epochs、presentation_generation；任一变化废弃旧结果。TTS 沿用来源停止机制；新增来源须同步退出/换角清理。

最后证据延迟时进度保持待确认；用户离开后仍可存唯一结算，下次提示“上次学习已确认，查看结算”，不自动重播演出。暂停/放弃可读本轮小结，与完成奖励分开。

## 5. 长期记忆

新增建议表：companion_memories、companion_memory_settings、摘要来源关系；复用 outbox，不另建学习计数库。

记忆至少带 `id/profile_pk/data_epoch/role_id/kind/source_session_id/source_segment_id/source_revision/revision/fact_json/local_text/occurred_at/valid/account_epoch/role_epoch/created_at/updated_at`；revision 为单条编辑的条件更新版本。用户主动偏好与学习派生事实分类型；来源唯一键含账号、角色、session、segment、kind。无 matched 参与证据的官方今日统计不转成角色共同经历。

清空/删来源在事务中推进持久 epochs、记录来源删除界线/tombstone，废弃旧 outbox/缓存/润色；提交时比较 epochs。清空时活跃角色片段封存，新学习使用新版本片段，目标与进度保留。暂停/恢复记忆、改出站授权推进 settings_revision 及相应账号/角色memory epoch；编辑偏好推进 item revision 及所影响的memory epoch，废弃所有引用旧偏好的上下文票据。

“删除本机学习数据”由M扩展现有固定删除白名单和同步屏障：同一事务先递增并保留 companion_account_state.data_epoch，取消/废弃旧派生任务，再删除或使旧代次的 sessions、role_segments、events、plan_snapshots、settlements、rewards、outbox、派生记忆失效。旧session事件与后台结果检查创建时data_epoch后拒绝。保留哪些主动偏好由清理UI明确表达；保留项重绑定新代次，旧来源不再重扫生成。单纯“清空记忆”保留学习进度/结算并用memory删除界线阻断重放。

记忆增强请求新增受控 context_ref 及data_epoch/account_epoch/role_epoch/settings_revision元数据。前端不把返回的历史文本直接复制进messages；M在现有 `/proxy/ai` 转发前验证引用归属、稳定角色、当前授权和版本，再从本地组装记忆，内部元数据不发给提供商。过期/关闭时返回明确过期错误，UI至多重试一次不带历史的反馈。普通非记忆AI请求保持既有协议。出站开关约束之后的新发送/尚未转发请求，关闭前已在途请求的返回停止展示/保存，界面说明时间边界；不声称已发出的历史可以撤回。

检索 ≤5 条且 ≤1,200 Unicode 字符（含来源时间）；单片段摘要建议 ≤400 字符；薄弱词建议 ≤10。详细事件默认 90 天，长期摘要保留最小事实源；用户主动删除与自然清理语义分开。可选 AI 润色每片段最多一次，超时保留本地摘要。

接口（拟议）：

| 方法与路径 | 语义 |
| --- | --- |
| GET/POST /api/companion/memory/settings | 使用开关、独立出站授权（默认 false）、保留策略与 expected epochs |
| GET /api/companion/memory/context | 本人当前角色的有界上下文；出站授权关闭时不加入实际 AI 请求 |
| GET/POST /api/companion/memories | 列表/仅白名单主动偏好创建；不允许客户端伪造官方事实 |
| POST /api/companion/memories/{id}/edit | 改主动偏好或明确可编辑字段，加 expected_revision |
| DELETE /api/companion/memories/{id} | 来源关联摘要失效并推进版本 |
| POST /api/companion/memory/clear | scope=role/account、本人合法角色及 expected epochs；不接收可信 profile_id |

前端记忆获取建议 500ms 软超时，不阻塞学习。10,000 条合成记忆下热检索 p95≤200ms 为测量目标，不作未测性能保证。无 AI 时检索与事实模板仍工作；对外发送授权关闭要抓取实际网络正文验证。

## 6. 角色包格式与示例生成

包内必有 role-pack.json。除 live2d.entry_file 相对其 live2d.root 外，清单中的文件/目录引用均相对包根；entry_file与root组合规范化后再命中files[]。模型描述文件内部引用相对描述文件目录，仍须验证留在其模型根内并命中文件清单。以下是结构示意，省略的权重/模型文件须由小夹具生成器自动列全并计算真实摘要；不可把占位摘要当成可安装包发布。

```json
{
  "schema_version": 1,
  "package_id": "example.study-companions",
  "version": "1.0.0",
  "name": "学习伙伴组合",
  "roles": [{
    "package_role_id": "role_a",
    "persona_file": "roles/role_a/persona.json",
    "voice": {
      "gpt_file": "roles/role_a/gpt.ckpt",
      "sovits_file": "roles/role_a/sovits.pth",
      "reference_audio": "roles/role_a/reference.wav",
      "reference_text": "与参考音频对应的文本",
      "reference_language": "中文"
    },
    "live2d": {"root": "roles/role_a/live2d", "entry_file": "model.model3.json"},
    "performance_file": "roles/role_a/performance.json"
  }],
  "files": [{"path": "roles/role_a/persona.json", "size": 128, "sha256": "GENERATOR_COMPUTES_REAL_SHA256"}]
}
```

persona.json 沿现有“版本/角色/语气/背景/禁忌/示例”格式；TTS 提交映射现有规范文件名。包不带解释器/虚拟环境/安装脚本。动作映射只引用实际模型中存在的动作/表情；缺少不是硬造成功演出。

来源 registry 位于 `<DATA_DIR>/role_packages/registry.json`，存包身份/版本与稳定本机 role_id 映射、文件摘要、人设基线、模型关联、演出映射和来源。它只管安装来源，不成为第二套人设来源。不要把这些字段塞进会被白名单过滤的 roles.json。

目录：role_packages/{incoming,staging,jobs,journals}；正式语音资料进 tts_pack/roles/<local_role_id>，模型进 live2d/models/<model_id>。所有目录由实际 data_dir 派生。

## 7. 安装服务、事务与上限

| 拟议方法/接口 | 契约 |
| --- | --- |
| POST /api/role-packages/uploads | 浏览器受限上传，返回受控 source_ref；桌面原生多选桥也返回受控引用 |
| POST /api/role-packages/inspect | source_refs → inspection_id、来源摘要、角色/冲突/缺项、峰值磁盘估算 |
| POST /api/role-packages/install | inspection_id、所选角色/冲突策略 → job_id；提交前重新核对包身份 |
| GET /api/role-packages/jobs/{job_id} | 批次阶段、真实字节/逐角色结果、错误与恢复状态 |
| POST /api/role-packages/jobs/{job_id}/cancel | 提交前取消，提交边界安全完成或回滚后停 |
| POST /api/role-packages/catalog-batches | 支持目录 IDs 与可选合法目标绑定 → 队列；不收任意下载 URL |

任务：queued/inspecting/staging/validating/committing → completed/partial_failed/failed/cancelled/interrupted；逐项 success/failed/skipped/incomplete/cancelled。未知下载长度用不确定进度，不造百分比。

M 新增并验证内部新角色安装原语（名称可冻结为 install_role_resources）；B 经注入适配器调用。现有更新事务只用于已注册角色升级。角色提交、Live2D 注册与 registry 使用一层协调日志、明确锁序和故障补偿；不在多个服务内部锁之间反向重入。启动先恢复未结束日志再接新任务；整包环境挂载与角色安装互斥。

模型升级先以新revision的model_id注册，不复用会在底层成功后立即清旧备份的同model_id覆盖流程；角色与registry全部提交后，才按引用检查回收旧资源。外层失败只撤销本次新revision，旧模型/旧绑定仍可回滚。

预处理并发≤2，正式提交串行；现有 Live2D 下载器队列串行。只回收本事务创建且无引用资源，不清用户原包/其他任务。源包 TOCTOU、磁盘中途不足和提交失败分别测。

已有相关上限核查值：桌面 ZIP 20 GiB、解包 28 GiB/50,000成员、浏览器上传256 MiB、单语音资料8 GiB；Live2D每模型500 MiB、单文件64 MiB、10,000文件。新角色包独立配置并在P0复核，不把500 MiB套到全部语音权重。提案新增：每批16个ZIP/32个角色、保留1 GiB空间；根据上传＋暂存＋必要复制估算峰值，每阶段重查空间。

## 8. 提案接口协作协议

M 向 A/C 提供基于现有 db 连接、事务和身份的 repository 适配器；A 只消费 C 已提交的角色片段/outbox。B 经 M 提供的 TTS/Live2D/原生文件引用适配器安装，不自行改共享热点。D/E 只读写上表服务接口，使用可控夹具并行开发。

每个代理返回：实际实现文件、API版本、迁移/共享插入点建议、测试命令与结果、故障与未验项、已停止写入声明。任何契约变更由 M 统一更新版本并通知受影响代理；用户可见文案不展示内部 revision/outbox 等实现名词。
