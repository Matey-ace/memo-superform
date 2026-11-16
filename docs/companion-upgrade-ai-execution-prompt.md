# MeMo 陪伴学习升级：交给执行 AI 的总提示词

版本：2026-11-16 v2。主工作区：`D:\MeMo1`。

本文是需求总设计与可复制的执行提示词。本文、契约和蓝图中的新增模块/API/表均为规划，尚未实施。把下方“总控指令”及后续完整内容交给负责实施的 AI；它应按本项目现有能力交付运行结果。

## 总控指令

你是 Memo Superform（MeMo）的主开发和集成负责人。当前工程已经迁至 `D:\MeMo1`，在现有 Python + SQLite + 原生 HTML/CSS/JavaScript + pywebview + Live2D + GPT-SoVITS 上，完成以下全部需求：

1. 学习陪伴人物具备本地长期记忆，跨会话、刷新和重启，仍能回顾真实学习经历和用户明确提供的偏好。
2. 一次操作安装其他角色的完整资料：支持一个多角色包、多个包多选导入，以及受支持模型目录的角色/服装多选下载。追加角色时保留已有角色和共享运行环境。
3. 背单词时显示真实进度。确认完成后出现结算界面，由本轮人物祝贺，生成可回顾的学习纪念卡和一次性奖励；无 AI/语音/动作时仍有完整本地体验。

主动使用子智能体并行实施。你负责冻结接口、划分工作区、修改共享热点、持续集成和独立验收。不要把主要工作转交用户逐文件操作，不要只提交计划或演示数据。常规实现选择按本文执行；外部模型/账号/工具受限时完成独立可验证部分，在交付中明确实际未验项。

开工先读 `D:\MeMo1\NEXT.md`、本文、`docs/companion-upgrade-contracts.md`、`docs/companion-upgrade-blueprint.md` 和当前 Git 状态。契约 v1 是待实施方案：先按 P0 核对实际接口与夹具再冻结，子代理按同一版本工作。发现真实阻塞时做一层必要问题支线，处理后回原阶段；新想法进入暂存区，不递归扩建蓝图。

## 0. 已有状态与工程边界

- 实际工程是 `D:\MeMo1`。版本标记 0.89；核查时 HEAD 为 `59f671117bde16f0f8d45bcc10e21c57f3bd5cd2`。以执行时实际工作文件为准。
- 迁移核对已完成，记录在 `_verification/migration-audit-20261116/migration-report.md`。已核验 217,539 个文件、三份 SQLite、185 项 Python 回归、浏览器三组、源码和 EXE 启动自检，以及三套语音环境导入。上述是旧版本基线，不是本次新功能完成证据。
- C 盘原始完整对照缺失、旧测试目录访问受限已单独记录。开发以 D 盘现状继续；本次任务不重跑迁移、不清理 C 盘、不改目录所有权。
- 源码版默认数据为 `D:\MeMo1\data`；打包版为 `D:\MeMo1\dist\data`；旧便携版有自己的 `data`。三套库分别保存，不合并、不互相覆盖。开发和测试使用明确设置的临时 `MEMO_DATA_DIR`。
- 原有未提交修改：`db.py`、`js/dashboard-core.js`、`js/study-web.js`、`server.py`、`tests/run.ps1`、`tests/test_sqlite_core.py`；还有 WorkBuddy 文档和新测试等未跟踪内容。先保存差异摘要，保留全部已有改动。现有 `MCLDownload` 等无关资料保持原样。
- 继续使用现有界面、主题、网页/桌面入口、账号体系、语音开关、快捷键和角色编辑。使用 VS Code 可用工作区；工具不具备 VS Code 操作能力时，使用当前工作区文件工具并记录，勿假称已操作编辑器。
- 本地模型和资料留在现有目录；缓存、测试、报告和代理临时产物放 D 盘。复用既有环境，按差异检查选测试；不重训模型，不自动下载多 GB 资源，不更新整套 torch/CUDA，不提交/推送/发布。

## 1. 核心体验与完整首版

核心循环：安装/选择角色 → 进入背词 → 查看可信进度 → 真正完成 → 人物祝贺与奖励 → 重启 → 同一人物回顾真实经历。

首版必须打通全部三项需求：

| 入口 | 首版可验收行为 |
| --- | --- |
| 设置 → 陪伴记忆 | 查看、暂停、删除，显式填写称呼/目标/鼓励方式；重启后保留；不同账号/角色隔离 |
| 设置 → 安装角色包 | 一次导入至少两个完整测试角色，预览缺项/冲突，后台追加安装，已有角色继续可用 |
| 模型目录 → 多选下载 | 选择多个角色/服装，真实排队并分别显示结果；模型下载与完整角色安装明确区分 |
| 学习陪伴区 | 本轮已确认完成/目标、今日进度（仅有可靠目标时）、有效时间；未知目标显示待同步 |
| 完成 → 结算 | 当前人物形象/字幕/可用动作与可选语音、真实统计、纪念卡、首次完成徽章、关闭/继续/回顾 |
| 再次进入 | 恢复已确认进度；当前人物可回顾有来源的共同经历；查看旧结算不重复领奖或自动重播 |

UI 保持现有原生页面：设置面板、陪伴区小进度条、可关闭的结算弹层。减少动画模式与键盘操作同样可用。首版不增加完整聊天客户端、向量服务、商城/抽卡/充值、独立桌宠、手机 WebUI或新的前端框架。

## 2. 参考项目及复用规则

参考 [MacchaPafe/D_sakiko](https://github.com/MacchaPafe/D_sakiko)，本轮线上核对固定在提交 `e5f2a5a625b540f0a6b01bdab095c9fb28119085`（2026-11-13 提交；2026-11-16 读取）。

| 已读取的上游文件 | 提取的设计经验 | 在 MeMo 的用法 |
| --- | --- | --- |
| [rolling_summary.py](https://github.com/MacchaPafe/D_sakiko/blob/e5f2a5a625b540f0a6b01bdab095c9fb28119085/GPT_SoVITS/chat/rolling_summary.py) | 累计摘要、覆盖边界、保留近期上下文、失败冷却 | 作为有来源的压缩策略参考；额外实现跨会话持久存储与检索 |
| [conversation_storage.py](https://github.com/MacchaPafe/D_sakiko/blob/e5f2a5a625b540f0a6b01bdab095c9fb28119085/GPT_SoVITS/runtime/conversation_storage.py) | 共同锁、原子存档、迁移前备份 | 沿用 MeMo SQLite 事务，不另造聊天 JSON 作为学习事实源 |
| [character_creation.py](https://github.com/MacchaPafe/D_sakiko/blob/e5f2a5a625b540f0a6b01bdab095c9fb28119085/GPT_SoVITS/character_creation.py) | 稳定角色 ID、资源隔离、暂存发布、失败补偿 | 参考安装事务；空语音目录不等于完整语音角色 |
| [hosted/installer.py](https://github.com/MacchaPafe/D_sakiko/blob/e5f2a5a625b540f0a6b01bdab095c9fb28119085/GPT_SoVITS/live2d_download/hosted/installer.py) | 隔离解包、Windows 路径校验、模型资源引用校验 | 适配当前 Live2D 服务，不直接搬入 PyQt/UI/运行环境 |

上游模型下载和角色创建不自动提供全部语音权重与参考资料。完整角色需采用本文 role-pack 契约；对可识别的上游资源目录提供导入适配/缺项说明，不承诺任意上游存档直接兼容。若复制源码，保留适用 GPL-3.0 来源及声明，更新 THIRD_PARTY_NOTICES；模型/音频单独记录来源。这里只读参考代码，不执行上游程序或下载模型。

## 3. 当前源码的真实接入点和缺口

下表是核查时已存在行为；新增能力均需实施，执行时按符号重新定位。

| 当前符号/模块 | 已有行为与本次必要改动 |
| --- | --- |
| `CompanionSession.create()`、`screen(false)` | 记录只在内存，画面结束会发 finish；退出/刷新不等于学习全部完成 |
| `askAI()`、`askTouchAI()`、`beginReply()` | 两个 AI 入口，已有账号/生命周期防竞态；加共享记忆上下文和稳定角色/删除版本校验 |
| `study-web.js`、`StudyShortcuts.sendKey()` | 上报 answer 只证明发出按键；原生 iframe 输入也要覆盖，点击不直接增加完成量 |
| `study_sync.normalise_today_item()`、`MaimemoStudyClient.today_items()` | 已有 voc_id/is_new/is_finished；严格验证完整性，缺失字段不得默认当可信 False |
| `sync_today_items` | 只保存增量同步哈希与观察时间，未保存完整计划；新增独立完整快照层，不破坏旧表语义 |
| `MaimemoAPI.getStudyProgress()` | 仅透传上游响应；目标字段缺真实夹具，先查证，别预设 total/completed |
| iframe 网页登录与 `_memo_identity()` | 两套登录来源尚未核验一致；新增 matched/mismatch/unknown 身份绑定，防网页账号 A 的学习写入 API 账号 B |
| `app_api._memo_identity()` / `maimemo_auth.py` | 学习账号身份来源；OAuth 刷新保持档案。`codex_auth.py` 管 AI 登录，不用作学习身份 |
| `app_api._active_role_live2d_binding()` | 从当前已启用角色得到 role_id/persona/model；服务端确定角色归属 |
| `tts.begin_role_update()/commit_role_update()` | 要求角色已注册；新角色完整安装需新增内部暂存提交原语，不先暴露半成品 |
| `tts._ROLE_MANIFEST_FIELDS` | 会过滤包版本、动作映射等额外字段；包来源元数据存独立 registry，persona.json 仍唯一人设来源 |
| `Live2DService.start_download()` | 目前只有一个活动任务，忙时返回原 job；批量服务须真正排队并核对每个任务身份 |
| `launcher.py` 的原生整包导入 | 单选并替换整个 tts_pack；新增多选追加入口，保留原完整环境挂载入口 |
| `server.py` / `LocalApiMixin` | 当前没有 PATCH 路由；本文新接口沿用 GET/POST/DELETE 及既有同源/正文上限保护 |

## 4. 需求一：长期记忆

### 用户可见行为

- “陪伴记忆”显示记住了什么、何时发生、来自哪次学习；支持本人账号下按角色查看、删除单条、清空当前角色、清空当前账号。
- 可主动编辑称呼、学习目标、鼓励方式；只把用户明确表达的内容当偏好。学习事实从已提交的会话/角色片段派生，不把 AI 台词、触摸日志或猜测当事实。
- 记忆总开关控制新增与使用，暂停时保留旧记录；“发送历史记忆给 AI”单独开关，默认关闭。关闭出站时本地仍可检索和用事实模板反馈，后续 AI 请求不携带历史记忆。暂停、编辑偏好或更改出站授权推进持久版本；记忆增强请求只传受控上下文引用，由服务端转发前核验授权/版本再组装记忆，避免先取上下文再关开关仍继续发送。
- 账号按稳定档案隔离，共同经历按稳定 role_id 隔离；换服装保留，同名角色不串。账号级用户目标可共享，角色 A 不冒称参与 B 的经历。

### 实现与限制

- 由 C 的持久会话事实派生，A 不另记学习计数。使用 SQLite；首版规则/关键词/最近记录检索，最多 5 条且总计 1,200 个 Unicode 字符，时间和来源计入预算。
- 摘要先本地确定性生成；累计摘要保存来源及覆盖边界，失败保留旧版本。AI 润色属于可选派生文本，每来源片段最多一次后台任务；数值由本地事实渲染。
- `askAI` 和 `askTouchAI` 共用上下文层；人设/输出规则优先，历史是有来源的数据块。短超时后继续反馈，不阻塞学习；无 AI/TTS/模型时仍可管理和显示记忆。
- 原始详细事件默认保留 90 天；长期摘要保留最小可追溯来源记录。正常事件清理不误删长期依据；用户主动删除来源会使关联摘要失效/重建。
- 清空采用持久账号/角色代次、删除界线和 outbox 版本比较；清空后旧响应、旧会话重扫、晚到润色不复活。活跃会话继续学习时建立新代次角色片段，进度保留。删除账号学习数据另推进持久 data_epoch，并清理新增的会话/片段/事件/快照/结算/奖励/outbox 事实源；旧 session 请求被拒绝。仅清记忆与清学习数据的影响在界面分清。

## 5. 需求二：多角色完整安装与模型多选

### 安装流程

“安装角色包” → 原生一次多选多个 ZIP/一个多角色 ZIP，或受支持本地资源目录 → 扫描 → 按角色勾选 → 预览完整/草稿/冲突/体积 → 确认 → 后台安装 → 逐角色结果与失败重试。安装后不自动切换当前角色。

role-pack.json 包含版本、包身份、稳定 package_role_id、人设、可选语音资料和 Live2D、完整文件清单与 SHA-256。完整角色包括人设、GPT/SoVITS 权重、参考音频/文本/语言、可用 Live2D；缺资料允许保留为草稿，按现有完整性规则补齐后启用。上游目录适配仅识别已核对结构中的 name.txt、character_description.txt、Live2D入口及引用、GPT-SoVITS_models候选权重，以及用户选定的参考音频/文本/语言配置。多候选、未知语言或缺字段均在预览中让用户选择/补齐，不猜文件、不伪造参考文本，不宣称任意目录自动兼容。

- 新角色安装采用私有暂存 → 校验 → 模型注册 → 角色/人设提交 → 来源 registry 提交的一层协调日志。不能用旧角色更新 API 假装新角色事务已具备。
- 包 registry 存 `(package_id, package_role_id) → local_role_id`、版本、来源、人设基线和演出映射；不重复存可编辑人设。版本升级保持 role_id，以保留长期记忆。
- 同包同版本重复安装跳过；同名异包可并存；升级默认保留手改人设，预览时明确选择替换。模型升级先注册新 revision 的 model_id，角色与 registry 全部提交后才回收无引用旧模型；外层失败仍可保留旧版本。已有角色、活跃状态、共享环境不变。
- 每角色独立事务；一个失败只回滚该角色，其他成功项保留。日志持久化支持重启恢复；仅删除本事务创建、尚无引用的资源。提交前取消，提交中完成安全提交/回滚再停。
- 模型目录提供角色/服装复选、搜索、已选数、已安装状态及队列。现有下载器一项一项调度，不把同一个 job 当多项成功；Live2D 下载结果标明“模型已安装/待绑定”，不冒充完整角色。
- 桌面由原生桥处理 GB 级包，网页只拿受控 source_ref；浏览器提供有明确体积限制的上传后备。HTTP 不接受任意绝对路径，不执行包内脚本，不自动 pip 或扫描时加载权重。
- 验证越界、UNC/ADS/设备名、尾点空格、大小写冲突、链接、哈希、引用、解包上限和磁盘不足。来源限受支持目录 ID，安装前复核扫描时摘要。

## 6. 需求三：真实进度、结算与奖励

### 先明确可信数据

P0/P1 取得脱敏接口/协议夹具，记录字段实际语义。严格区分 `intent`（发出操作）、`observed_ack`（核验过的提交回执）和 `official_snapshot`（服务端当前账号官方快照）。前两者不冒充官方完成数据。

先核验 iframe 与本机 API 账号相同；未匹配时显示待同步，并隔离临时观察。当前 API 账号的“今日进度”与“本轮陪伴共同经历”分开：官方今日增加量不自动归于本轮，其他设备学习也不凭空算作当前角色参与。

完整今日快照新增持久化目标/计划、is_new/is_finished、抓取次序、完整性和来源。today_items 长度是否代表完整目标需验证；达到现有 1,000 条上限、字段缺失/类型错、分页/计划未知时保留不确定状态。不能从旧哈希表反推目标。

### 进度与会话

- 学习区显示“本轮已确认 X / 目标 Y”、可得的今日进度和有效时间；分母未知时只显示计数/同步状态，不造百分比。
- 状态为 idle/active/paused/completed/abandoned；结算为独立持久记录。刷新、关闭、切页、隐藏、断网只是暂停/小结；AI、DOM 消失、finish 事件都不决定完成。
- 服务端按账号/学习日/规范任务键事务创建或恢复唯一活动 session，多窗口共享；目标调整保留 session 并推进目标版本，终态后明确开始新轮才增加服务端 run_generation。事件有事件 ID、实例内 seq、iframe 代次、任务/词条/真实轮次。网络重试幂等，同词合法多轮日志不丢；最终完成词量按对应任务/词条完成周期去重，不把每轮判断都加一词。
- 进入时保存完成基线；进入前完成的词计入今日，不计本轮新增。目标未知、为 0、快照不完整时不领奖；调整/减少目标本身不触发完成，需新确认事件与对账。
- 换角色创建角色片段，不清进度；完成时冻结 completion_role_id。记忆按参与片段归属，演出始终匹配结算角色，晚到旧回复不串角色。
- 有效时间排除暂停/隐藏/长期无活动；多窗采用租约或区间并集；重启先恢复暂停，不累计失联墙钟时间。学习日沿用北京时间口径，跨日对账。

### 结算与人物演出

完成核验、session completed、唯一结算、唯一奖励和记忆 outbox 放在同一 SQLite 事务。重复提交、刷新、双窗口返回同一结果；记忆失败只重试 outbox，不重复领奖。

结算包含当前人物、已确认完成量/新学复习/有效时间/有依据的需巩固词、祝贺字幕、可用动作/表情和可选语音，以及可回顾的纪念卡、首次完成徽章。保留“查看需巩固词 / 继续学习 / 返回仪表盘 / 关闭”。不把熟悉程度自评比例称为客观正确率，不展示无依据的掌握率或提升百分比。

先显示本地完整祝贺，AI 最多润色一次并持久保存状态；它不决定奖励或统计。动作映射须来自实际模型；缺动作轻动画，缺 WebGL 备用图，缺 TTS 保留文字。复用现有语音队列，不另起 worker。退出/切账号/换角废弃旧演出与对应来源语音。

弹层具备 dialog 语义、焦点圈定与恢复、Escape、屏幕阅读器进度、窄窗口适配和减少动画。重看纪念卡不自动调用 AI、不自动朗读；待核验的最后一词显示确认中，后续补确认仍仅生成一个结算。

## 7. 工作区与并行执行

主工作区是 `D:\MeMo1`，代理工作区按文件所有权划分，默认共享这一个目录。代理临时产物放 `D:\MeMo1\_verification\companion-upgrade\agents\<agent-id>`，不是复制完整工程或模型。

| 代理/逻辑工作区 | 独占新增文件（主工程下） | 必须交付 |
| --- | --- | --- |
| M 主集成 | 共享热点与现有文件 | 身份绑定、迁移、路由、桥、UI挂载、资源打包、端到端接线 |
| A 记忆 | companion_memory.py；tests/test_companion_memory.py | 来源检索、摘要、偏好管理、删除屏障及测试 |
| B 安装 | role_package_service.py；tests/test_role_packages.py；tests/fixtures/make_role_package.py | 包预览/事务/登记/恢复/目录队列及小夹具 |
| C 会话证据 | companion_sessions.py；companion_progress_sources.py；js/study-event-bridge.js；tests/test_companion_sessions.py；tests/test_companion_progress_sources.py；tests/study-event-bridge-regression.js | 严格快照、进度/会话/计时/完成事务及事件桥 |
| D 设置界面 | js/companion-memory.js；js/role-packages.js；css/companion-settings.css；tests/companion-memory-ui-regression.js；tests/role-packages-ui-regression.js | 记忆管理、批量包预览/任务与目录多选 |
| E 进度结算 | js/companion-progress.js；js/companion-settlement.js；css/companion-progress.css；css/companion-settlement.css；tests/companion-progress-regression.js；tests/companion-settlement-regression.js | 进度条、结算/纪念卡/人物演出 |
| F 独立验收 | tests/test_companion_upgrade_integration.py；tests/browser/companion-upgrade.js；docs/companion-upgrade-acceptance.md | 失败夹具、交叉审查、真实与模拟证据分列 |

共享热点仅 M 修改：`app_api.py`、`server.py`、`db.py`、`sqlite_schema.sql`、`study_sync.py`、`tts.py`、`live2d_service.py`、`launcher.py`、`memo_injection.py`、`js/api.js`、`js/live2d-companion.js`、`js/study-web.js`、`js/study-lifecycle.js`、`js/tts.js`、`js/app.js`、`index.html`、`index-anon.html`、`static_security.py`、`MemoSuperform.spec`、`tests/run.ps1`、`package.json`、`README.md`、`CHANGELOG.md`、`THIRD_PARTY_NOTICES.md`。

先检查实际并发上限 S（含主代理），活动代理总数 ≤ S。S=4 时：第一波 A/B/C，主代理做共享接线；交接释放槽位后第二波 D/E/F。S≥7 时可让 A—F 按契约与夹具并行。禁止虚报已启动的代理数量。代理完成后停止写入并交接，主代理再集成其独占文件。

如确需 worktree，先保全当前未提交/未跟踪源码基线并验证一致；不从纯 HEAD 漏掉已有修复，不复制大模型，不自动提交。常规情况下按所有权共享目录更快。

## 8. 验收与交付

实施顺序、退出条件和子代理完整派发提示词见 `docs/companion-upgrade-blueprint.md`；精确事件、API、状态和清单示例见 `docs/companion-upgrade-contracts.md`。所有新函数名/API均须由实施者真正实现并验证，不作为现有能力直接调用。

| 必验域 | 通过标准 |
| --- | --- |
| 记忆 | 重启保留；账号/角色隔离、换衣保留；清空与晚到 outbox/AI 竞态不复活；出站关闭时实际请求无记忆 |
| 角色 | 双角色完整安装、多 ZIP 部分失败、幂等、同名异包、升级保留 ID/手改人设；已有角色/环境/活跃状态保留 |
| 安装故障 | 坏路径/链接/哈希/引用/源包变化、超限、磁盘满、提交边界取消、中断恢复；目录队列逐项正确 |
| 身份/证据 | 网页 A/API B、unknown、快照缺字段/1,000 条截断/乱序；今日进度与本轮参与严格区分 |
| 进度 | 原生 iframe 与宿主键鼠、WS 路径、重试/连点、同词多轮、重载、双窗、跨日、目标变更/归零/未知 |
| 结算 | 最后可信证据才结算；事务中断可恢复；纪念卡/徽章/outbox分别幂等；退出/换角/删数据不回放旧结果 |
| 界面 | 两现有主题、网页/桌面、窄窗口、键盘与减少动画；AI/TTS/动作/WebGL缺失仍完整可用 |
| 打包 | 新资源接入真实入口、静态白名单及冻结包；源码通过不代替 EXE 验收 |

先跑各模块必要测试，集成后跑 `tests/run.ps1 -Browser` 和适用的 `--verify-build`。所有自动化用 D 盘临时 `MEMO_DATA_DIR`、合成角色/脱敏协议夹具；真实账号/模型验收另列，不用日常资料做故障测试。

交付运行代码、兼容迁移与备份/恢复说明、真实摘要的示例角色包生成器、用户使用说明、测试日志、`docs/companion-upgrade-acceptance.md` 和更新后的 NEXT。新功能证据与旧迁移基线分开。完成核心闭环后停止，交用户试用；新需求另开后续阶段。

后续可提案：连续 3/7 天徽章、更多模型目录适配、向量检索。它们不替代本次三项完整首版，也不自动扩入本次执行。
