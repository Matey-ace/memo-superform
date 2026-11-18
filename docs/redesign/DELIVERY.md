# MeMo Superform 0.90 交付说明

构建：`dist\MemoSuperform-0.90-standard-redesign\MemoSuperform.exe`
版本 0.90（frozen=true），21 项资产自检通过，SHA256 `FEA66DE6BEBF788E7EA37E915F576A41DF15357449F88B8375806978E8709FB4`
提交：`8e4f50f`，分支 `codex/companion-redesign-test-build`（草稿 PR #7，未合入 main、未打 Release）

---

## 1. 墨墨一键授权按钮

**根因（两层，都已实测确认）**

1. **能力字段在调用方快照里丢失。** `js/api.js` 的初始连接状态只有
   connected/mode/profile_id，缺 `configured`/`callback_ready`。`refreshConnection()`
   提交共享状态后返回的是另一份对象，调用方读 `status.configured` 恒为 undefined，
   被当成"未配置"——于是按钮在"已配置但未连接"时被判为不可用而隐藏。
2. **内联 display 盖住 hidden 属性。** 账号区那几个按钮的标记（与笔记本主题共用，
   不能改）自带 `style="display:none"`。新的普通版渲染器只切 `hidden` 属性，
   而内联声明的优先级高于任何样式表规则，撤销不掉——已连接后"重新授权 / 断开连接 /
   删除本机学习数据"三个按钮永远 0×0 不可见。

**修法**

- `js/api.js`：初始 `configured:null` 表示"未知"，不再当 false；`SERVER_CAPABILITY_KEYS`
  在 commit 时合并进共享状态；`refreshConnection()` 始终把完整快照交给调用方；
  `connectionGeneration`/`statusSequence`/`statusInFlight` 三重守卫，迟到的旧响应
  不覆盖保存 Token / 断开 / 切换账号的结果。
- `js/app.js`：单一渲染入口 `renderMaimemoState()`，`maimemoStateOf()` 归一为七种状态
  （loading / error / unconfigured / callback-missing / pending / ready / connected），
  每种都有可读原因 + 恢复入口。`showMaimemo()` 同时写 `hidden` 和内联
  `style.display`，两层都撤掉。
- 授权中（pending）保留可点的"重新授权"：服务端占位保留 10 分钟，只留"重新检测"
  会让入口消失整整十分钟。
- 状态轮询只在"这次授权仍然有效且确实打开了授权页"时启动。
- 凭据在面板之外变化（bootstrap 迁移旧 Token、OAuth 回调完成）也会重绘账号区。
- 未使用固定延时、无常驻轮询、不伪造 `configured:true`、不无条件显示按钮。
- PKCE / DPAPI / 回调校验 / 手动 Token 全部保留；不记录 Token、授权码或 PKCE verifier。

**证据**

| 检查 | 结果 |
|---|---|
| `_verification/probe-auth/verify.js`（18 项，含真实服务器状态分支） | 18/18 |
| `_verification/probe-auth/connected-buttons.js`（已连接时三个按钮真实可见可点） | 5/5 |
| `tests/auth-state-regression.js`（并发/乱序/陈旧/失败/恢复） | PASS |
| `tests/auth-button-visibility-regression.js`（内联 display 冲突） | PASS |

> 真实 OAuth 登录需要外部身份，未做；上述为本地隔离与合成状态验证。外部链路
> （浏览器授权页 → 回调 → 换 token）的端到端未在真实账号上跑过。

---

## 2. 标准版视觉重做

设计说明见 `docs/redesign/standard-design-spec.md`。新增三个纯普通版样式表
（`standard-tokens.css` / `standard-shell.css` / `standard-settings.css`），
全部规则限定 `html[data-ui-style="standard"]`，笔记本主题不加载。

方向：安静的陪伴式个人学习桌面，而不是构成主义 × 古典雕版。

- 去掉纸黄底、黑硬边、硬阴影、满屏直角、密集分隔线；改用留白、字号层级、分组。
- 收敛按钮 / 输入 / 弹层 / 圆角 / 间距 / 反馈为统一体系。
- 正文改为可读的 CJK 字族；标题不再用渐变文字。
- 首屏强调"今天学什么、完成多少、继续学习"；统计与设置退到次要位置。
- 角色区留出完整展示空间；低频工具折叠。
- 明暗分别调色；对比度按 WCAG AA 校验（`--sd-accent` 由 #4b6bfb 调深到 #3f5ce0，
  `--sd-warning` 由 #b8791a 调深到 #8a5a10，均达到 4.5:1）。
- 尊重 reduced motion；结算强调学习结果与角色反馈。

**证据**：`_verification/ui-shots/visual-qa.js` 16 组（4 种尺寸 × 明暗）全部
`failures: 0`——检查元素可见性、遮挡、文本截断、横向溢出、严格 AA 对比度。
前后对比图见 `_verification/ui-shots/before/` 与 `after/`。

> 说明：本模型无法直接"看图"，视觉验收是通过几何、对比度、溢出、密度、遮挡的
> 程序化测量完成的，不是人眼观感确认。这是本次交付的真实限制。

---

## 3. 背单词退出入口

| 功能 | 入口 | 退出行为 | 清理动作 |
|---|---|---|---|
| 学习磁贴（study-web） | 右上角"← 退出背单词" | 回到进入前的仪表盘图表 | 关浮层、取消在途读取、停屏幕监听、摘监听 |
| 单词内容编辑 | 面板内"×" / Escape | 先关编辑面板，再按需退出磁贴 | 清轮询、焦点归位、重置表单 |
| 快捷键面板 | 面板内关闭 / Escape | 退最内层 | 复位打开态 |
| 全屏弹层 | `#closeFullscreen` | 先退子层（编辑器/快捷键）再关弹层 | 恢复 inert、焦点、滚动、图表备份 |
| 陪伴模式 | `MemoCompanionGuard` 的 exit | 先关全屏再进陪伴（互斥） | 清心跳定时器、隐藏生日徽章 |
| 文章选词浮层 | 面板关闭 | 关面板 | 提交中弹确认，提示可能已写云端 |
| 软件更新弹窗 | 关闭按钮 / Escape | 关弹窗 | 停轮询 |

语义边界：退出只回到进入前的位置，**不是**断开墨墨账号、删数据、退出应用或
云端登出。有真实丢失风险时才确认（未保存草稿、提交在途）。Escape 可用但不
替代可见按钮。嵌套状态先退最内层。

**证据**：`tests/study-exit-regression.js`（11 节，含禁用语义断言：不含
`MaimemoAPI.disconnect`、`deleteLocalData`、`localStorage.clear`）；
`_verification/ui-shots/behaviour-qa.js` 39/39（含退出按钮可见、可点、有标签、
未被遮挡，退出后磁贴归还图表，无残留监听/轮询/音频）。

---

## 4. 设置：分类目录 → 分类详情

7 个分类，原有 9 个设置组逐一映射，不新增、不遗漏、默认值不变：

| 分类 | 原有设置组 |
|---|---|
| 账号与连接 | 墨墨账号 |
| 学习与进度 | 数据更新 |
| 角色与陪伴 | 陪伴模式、Live2D 模型库 |
| 语音与音频 | 语音功能（GPT-SoVITS 资源包） |
| AI 与记忆 | AI API 配置（可选） |
| 外观与窗口 | 界面风格、运行模式 |
| 数据与维护 | 软件更新 |

- 分类由 `js/standard-settings-nav.js` 在运行时构建并**搬运**原节点（不是克隆），
  面板 DOM 与笔记本主题共用的部分与 HEAD 字节一致。
- 宽窗口左导航 + 右内容；窄窗口先显示目录页，详情页有"← 全部设置"返回。
- 未保存守卫覆盖 app.js 实际写入的全部字段（含 `aiProviderSelect`——它之前漏了，
  切服务商后不保存直接关会静默丢改动）。只有用户 input/change 才算脏，程序回填不算；
  保存与"保存为默认模式"之后基线同步前移，不会误报。
- 打开设置一律回到目录（含程序化打开，如"去配置 AI"）；窄窗口进详情后焦点移到页面标题。
- 切换分类不发请求、不重建语音包/模型库/角色编辑器、不重复绑定。
- 危险操作（删除本机学习数据、清缓存）在"数据与维护"与账号区分开，说明影响。

**证据**：`tests/standard-settings-nav-regression.js`（17 节，含面板与 HEAD 字节
比对、9 组全部有归属、未保存字段一一对应、不允许 removeChild）；
`_verification/ui-shots/settings-save-close.js` 9/9（真实浏览器跑"填值 → 保存 →
关闭"：保存后不再误报未保存、真改动仍会拦、重开回到目录、摘要接真实状态）。

---

## 5. 笔记本主题保护

**范围**：17 个整文件（`index-anon.html`、`css/style-anon.css`、`css/diary.css`、
`css/study-web-notebook.css`、`css/maimemo-notebook.css`、`css/fonts.css`、
`css/live2d-companion.css`、`css/companion-progress.css`、`css/companion-settlement.css`、
`js/diary.js`、`js/gif-icons.js`、`js/live2d-companion.js`、`js/companion-progress.js`、
`js/companion-settlement.js`、`tests/font-gif-manifest.sha256`、
`data/tts_pack/roles/anon/persona.json`）＋ 36 个行区间，共 1118 个整文件 hash。

**关键事实**：两个主题共用同一份 `index.html`，所以设置面板标记的任何改动都是
笔记本改动。分类结构因此**没有**写进 HTML，而是运行时构建 + 主题早退。

**验证**

- `_verification/notebook-guard/verify-guard.py`：1118 文件 + 36 区间 → `NOTEBOOK_GUARD_PASS`
  （仅部分区间因上方插入代码而移位，内容逐字一致）。
- `_verification/ui-shots/notebook-isolation.js` 17/17：笔记本不加载任何 standard 样式、
  保留 notebook-mode、无分类导航、9 组设置照旧长页、无标准退出条、
  标准专用按钮与提示节点不可见、状态文案 class 仍为 `hint`、无 JS 错误。
- `_verification/ui-shots/notebook-auth-leak.js` 7/7：强制授权失败，确认标准专用的
  "重新检测"与原因提示不会在笔记本里被点亮，且错误文案仍是改动前那句。
- `tests/notebook-shared-path-regression.js`：把"共享文件里笔记本必须走旧代码路径"
  固化成断言（含 `layout.js` inert 必须仍是三节点、`study-web` 退出条、
  `article-vocab`/`content-editor` 不新增取消与焦点行为）。

**隔离**：所有浏览器验证使用独立 `MEMO_DATA_DIR`（`%TEMP%\memo-final-092`），
不写笔记本真实数据与偏好。真实学习库 `data/memo-superform.db` 保持 3,366,912 字节、
mtime 2026-11-16 03:45:43 未变。

> 已如实记录：1118 个受保护文件中 84 个（`data/tts_pack/**`、`data/live2d/models/**`）
> 不受 git 跟踪，其"未变"只由基线自身佐证，无法用版本库交叉验证。

---

## 6. 改动文件、测试与评审

**改动**（24 个文件，提交 `8e4f50f`）

修改：`index.html` `js/api.js` `js/app.js` `js/app-update.js` `js/article-vocab-wire.js`
`js/charts.js` `js/layout.js` `js/study-content-editor.js` `js/study-web.js`
`js/ui-style.js` `launcher.py` `build_info.py` `tests/run.ps1`

新增：`css/standard-tokens.css` `css/standard-shell.css` `css/standard-settings.css`
`js/standard-settings-nav.js` `js/standard-companion-guard.js`
`tests/auth-state-regression.js` `tests/auth-button-visibility-regression.js`
`tests/standard-settings-nav-regression.js` `tests/study-exit-regression.js`
`tests/notebook-shared-path-regression.js` `docs/redesign/standard-design-spec.md`

**测试**：`tests/run.ps1` → `REGRESSION_SUITE_PASS`（node --check 全部 js、29 个
node 回归、release-guards、551 个 python unittest、47 项 article-vocab、
`git diff --check`）。浏览器：study-keyboard / quality-hardening / dashboard-smoke /
companion-ui / article-vocab-ui 全 PASS。

**独立评审**：三个只读评审分别针对授权、设置重构、笔记本保护，共提出 3 类真实缺陷
并全部修掉——包括"已连接后三个按钮不可见"、"保存成功却拦住关面板"（`window.AIAPI`
恒假）、"标准专用节点在笔记本被点亮"、"inert 回退比 HEAD 窄"、
"AI 服务商未纳入未保存守卫"。修复后复验通过。

---

## 7. 交付物

- 程序：`D:\MeMo1\dist\MemoSuperform-0.90-standard-redesign\MemoSuperform.exe`
- 启动：直接双击，或 `MemoSuperform.exe --mode web`（默认桌面模式）
- SHA256：`FEA66DE6BEBF788E7EA37E915F576A41DF15357449F88B8375806978E8709FB4`（98,211,001 字节）
- 构建标识：`version=0.90 frozen=true passed=true`，21 项资产自检
- 文档：本文件、`docs/redesign/standard-design-spec.md`
- PR：https://github.com/Matey-ace/memo-superform/pull/7 （草稿，未合并、未发 Release）

最终 EXE 上实测：授权 18/18、已连接按钮 5/5、行为 39/39、笔记本隔离 17/17、
笔记本泄漏 7/7、保存关闭 9/9、视觉 16/16 无失败。

---

## 8. 剩余问题与限制

1. **真实 OAuth 端到端未跑。** 需要真实墨墨账号与浏览器授权页，本次用本地隔离与
   合成状态覆盖了可验证部分，外部链路（授权页 → 回调 → 换 token）未在真实账号上走通。
2. **视觉验收是程序化的。** 本模型不能直接看图，靠几何/对比度/溢出/密度/遮挡测量，
   没有人类观感确认。
3. **84 个受保护数据文件不受版本控制**，其未被修改只能由基线自证。
4. **`docs/redesign/` 下多轮历史快照目录**（`round2/`、`round3/`、`sa5/`、`sa7/`、
   `MCLDownload/` 等，合计约 14 GB）为既有生成产物，未纳入基线，也未纳入本次提交。
5. **旧样式表 `css/theme-constructivist-*.css` 仍在磁盘上**，已不被 `ui-style.js`
   引用；删不删留给后续决定。
6. **`index.html:393` 的 `aria-controls` 塞了两个 id** —— HEAD 就有的旧问题，本次未动。
