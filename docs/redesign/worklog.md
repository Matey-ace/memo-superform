# 重设计工作日志

任务：Memo Superform 主界面视觉重设计（构成主义 × 古典雕版排版）
工作目录：`D:\MeMo1`
开始时间：2026-11-16

---

## 阶段 0：准备

### 0.1 工作目录确认
- `pwd` = `D:\MeMo1` ✅

### 0.2 动手前状态留存
- `git status` + `git diff --stat` + `git diff` 全部输出已保存到 `docs/redesign/git-before.txt`（233,088 字节）。
- 分支：`codex/full-quality-hardening`，HEAD `59f6711`。
- 未提交条目：72 项（含前一任务的文章选词功能改动，全部保留，不做任何 reset/clean/stash）。

### 0.3 项目指引
- 根目录**没有** `AGENTS.md`（已确认不存在）。
- `README.md` 39,741 字节，已检索关键条目：
  - 开发验收入口：`./tests/run.ps1 -Browser`（Windows）。
  - 启动方式：`MemoSuperform.exe` / `python launcher.py --mode web` / `python app.py`；
    **直接运行 `server.py` 时设置页会禁用一键授权**，因此截图应走 `app.py` 或 `launcher.py`。
  - 内置墨墨网页版 SPA，暗色主题跟随仪表盘（→ 主主题若有暗色模式，需两套都截图）。
- `docs/` 下既有文档 16 个，与本任务相关的是 `performance-vocabulary-multi-agent-prompt.md`（前一任务）与 `quality-hardening.md`。

### 0.4 并行任务规避
- 前一任务的性能优化已由子智能体 D 收尾并明确"停手"（`js/live2d-companion.js` 不再变动）。
- 每次写入前仍按第 12 节清单重新读取最新内容。

---

## 阶段 1：SA-1 禁区测绘（只读）

### 1.1 SA-1 已交付
- 产出 `docs/redesign/forbidden-zones.md`（43,734 字节，409 行，A–H 八节齐备）。
- 结论：主主题 `standard`；MAIN_SCOPE 外壳 `html[data-ui-style="standard"]`、墨墨 iframe 内 `html.memo-standard`；**禁区整文件 17 项**，**疑似禁区 15 项**。
- SA-1 独立复核了我给出的 7 点事实，**全部成立，无一条被推翻**。

### 1.2 我的独立核查记录
- `docs/redesign/main-scope-verification.md` —— 记录我在等待期间亲自核对的事实与证据行号。

### 1.3 真实浏览器验证（关键，实测）

**外壳作用域双向验证**（Edge + Playwright 1280×800）：

| | standard | notebook |
|---|---|---|
| `html[data-ui-style]` | `standard` | `notebook` |
| 命中 `html[data-ui-style="standard"]` | **1** | **0** |
| 命中 `html[data-ui-style="notebook"]` | **0** | **1** |
| `body` class | `standard-mode` | `notebook-mode` |

→ MAIN_SCOPE 隔离性成立。属性缺失时双向不命中（fails closed），安全方向正确。
→ **严禁** `html:not([data-ui-style="notebook"])`：属性缺失时会命中手账。

**墨墨 iframe 作用域双向验证**：

| | standard | notebook |
|---|---|---|
| iframe `html` class | `memo-standard` | `memo-notebook` |
| 注入 link | `memo-study-skin` → `css/maimemo-standard.css` | `memo-study-skin` → `css/maimemo-notebook.css`、`memo-notebook-fonts` → `css/fonts.css` |
| 是否含 `memo-notebook` | **否** | 是 |
| 是否含 `memo-standard` | 是 | **否** |
| `memo-theme-main-inject` | **不存在** | **不存在** |

→ 注入机制复用成立，跨主题零泄漏。

### 1.4 SA-1 提出的"硬冲突"：经实测**不成立**

SA-1 担忧：雕版排版要衬线字体，但 `css/fonts.css` 禁改、manifest 锁死 1006 行、且主主题墨墨界面不加载 fonts.css → 无字体可用。

**实测推翻这一担忧**（`tests/redesign/probe_font_metrics.js`，canvas measureText 量宽 + 阴性对照）：

| 字体 | CJK 粗体 | 拉丁 | 数字 | 判读 |
|---|---|---|---|---|
| `serif` 基准 | 244.69 | 440 | 200 | 本机 serif 泛型 **= SimSun** |
| `Noto Serif SC` | 240 | 439.8 | 219.32 | **生效**（真宋体） |
| `SimSun` | 244.69 | 440 | 200 | 生效（与 serif 基准同值，证明确为 system serif） |
| `STSong` | 240 | 352.96 | 187.6 | 生效 |
| `Georgia` | 244.69 | 407.11 | 219.1 | 生效 |
| `Bahnschrift` | 240 | 411.43 | 205.41 | 生效（窄数字，适合作 `--f-num`） |
| `"NoSuchFontXYZ123"` | 244.69 | 440 | 200 | 阴性对照 = 回退值 |

**结论：用系统字体栈即可，不新增字体文件。**
决定：`--f-display` / `--f-serif` = `"Noto Serif SC", "SimSun", "Source Han Serif SC", serif`
（`Source Han Serif SC` 实测不存在，作为无害的中间回退保留；`Songti SC`/`MingLiU` 实测不存在，不写入栈）。

这同时满足 §14「不得新增字体文件」与 §6.3「不得为主主题新增对 fonts.css 的加载」。
**SA-1 的三选一 → 选 (a) 只用系统衬线栈。**

### 1.5 SA-1 另两项待拍板决定

- **②墨墨雕版皮肤超出 52 行怎么办** → 选 **(a) 扩写 `css/maimemo-standard.css`**。
  理由：该文件 25 条选择器全部带 `html.memo-standard` 前缀（SA-1 实测无前缀命中数 = 0），整文件主主题专属；
  且不触碰被 `tests/test_regression.py:83-84` 断言的共享文件 `memo_injection.py`。
- **③`js/companion-progress.js` 判禁区还是可编辑** → 维持 **禁区**。
  理由：它虽无角色痕迹，但两套主题共享加载；改它无法给出"手账主题零差异"的证明，风险大于收益。列入报告的"疑似禁区未改动"清单。

### 1.6 SA-1 报告的三条重要补充（已采纳）

- **缓存令牌**：`memo_injection.py:54` 的 `VERSION` 是注入 link 的 `?v=`。改 CSS 内容必须同步 bump，否则旧样式被复用。
- **`data-standard-only` 是显隐钩子**（`index.html:18,41,59,555` ↔ `ui-style.js:63-65`）：可改样式，**绝不能删属性**。
- **`drag.css` 读 `--accent-blue`**（与 `style-anon.css` 重叠变量）：改选择器安全，改变量值不安全。

### 1.7 截图与比对基础设施（已建成并自证）

| 工具 | 作用 | 自证结果 |
|---|---|---|
| `tests/redesign/serve.py` | 常驻本地服务，指定固定数据目录 | 实测 READY，稳定服务 |
| `tests/redesign/capture.js` | 外壳截图（2 主题 × 3 分辨率） | 已产出 6 张基线，**零页面错误** |
| `tests/redesign/capture_study.js` | 墨墨 iframe 截图 + 注入状态取证 | 已产出 2 主题报告，作用域验证通过 |
| `tests/redesign/compare.py` | 像素比对（identical / changed 两种语义） | 见下 |
| `tests/redesign/selftest_compare.py` | **证明比对工具本身有效** | **5/5 PASS** |

比对工具自证覆盖：未篡改应通过、**单像素篡改必须被检出**、恢复后应再次通过、changed 模式对未改动应失败、尺寸不同应被检出。
→ 这一步很重要：一个只会说"IDENTICAL"的比对工具会让禁区证明变成空话。

### 1.8 重要限制：我无法目视查看截图

当前模型不支持图像输入（读取 PNG 返回 `model does not declare image input`）。
因此：
- 截图**已真实产出并落盘**，可供用户与后续审稿人查看；
- 但**我本人无法用眼睛判断美观**，视觉判断改为**程序化度量**（像素差异率、计算样式、对比度计算、几何量测）。
- 报告中必须如实标注这一点，不得写"视觉正常"作为我亲眼确认的结论。

### 1.9 基线截图现状

`docs/redesign/baseline/`：
- `baseline-dashboard@standard@{1280x800,1440x900,1920x1080}.png`
- `baseline-dashboard@notebook@{1280x800,1440x900,1920x1080}.png`
- `study/shell@standard.png`、`study/shell@notebook.png`
- `study/study-login@standard.png`、`study/study-login@notebook.png`
- `study/study-report@{standard,notebook}.json`
- `index.json`（每张图的主题、分辨率、加载 CSS、页面错误）

**未取得的基线：墨墨学习界面的正/反面、认识/模糊/不认识、切换单词、项目编辑器、完成页** ——
因为当前停在墨墨**登录页**（`stage=login`）。按 §17c，这需要用户明确授权真实墨墨登录才能继续。
**这一项在最终报告中必须列为"未完成"，不得写成已完成。**

---

## 阶段 2：SA-2 基线摄影 ∥ SA-3 设计令牌

### 2.1 SA-3 已交付 `css/theme-constructivist-tokens.css`

- 字节数 **10,188**（约束 ≤10KB，**达标**）。
- 42 条规则，全部以 `html[data-ui-style="standard"]` 开头（我写了脚本逐个 prelude 校验）。
  - 自动检查报出的 3 条 `h2`/`h3`/`h4)` **是我校验器的误报**：它把 `:is(h1,h2,h3,h4)` 里的逗号当成了选择器列表分隔符，实际该规则带完整作用域前缀，合规。
- 自检结果：`transition: all` **0** 次、`:root` **0** 次、`gradient` **0** 次、`blur` **0** 次、`border-radius` 全为 `var(--r-none)` 或 `var(--r-tap)`（0 或 2px）。
- 有 `@media (prefers-reduced-motion: reduce)` 分支把三个时长归零。

### 2.2 令牌文件"真的生效 + 不泄漏"双重证明（实测，关键证据）

方法：在真实浏览器里**运行时追加** `<link>` 指向令牌文件（只改运行时 DOM，不改源码），
然后读 `getComputedStyle`。**故意在手账主题下也强制加载它**，验证作用域是否真的能挡住。

| 观测项 | standard | notebook（强制加载令牌） |
|---|---|---|
| 解析出的变量数 | **10 / 10** | **0 / 10** |
| `--c-paper` | `#EFE7D6` | *（空字符串，未定义）* |
| `--c-ink` | `#1A1714` | *（空）* |
| `--c-vermilion` | `#B8321F` | *（空）* |
| `--f-display` | `"Noto Serif SC", SimSun, ...` | *（空）* |
| 探针元素 `color` | `rgb(184, 50, 31)` 朱色 ✅ | `rgb(74, 55, 40)` 手账墨色（**未被影响**） |
| 探针 `font-size` | `40px`（`--fs-2xl`）✅ | `16px`（**未被影响**） |
| body 背景 | `rgb(239, 231, 214)` = `#EFE7D6` ✅ | `rgb(246, 239, 233)` 手账纸色（**未被影响**） |

**结论：`html[data-ui-style="standard"]` 作用域隔离性经实战验证成立。**
即使令牌文件被强行加载到手账页面，它也**一个变量都不生效、一个探针元素都不受影响**。
这比"我只写在 standard 分支里加载"强得多——即使加载逻辑写错，视觉上也不会污染禁区。

### 2.3 SA-3 发现的一处规格缺口（需我裁决）

规格只给了亮色的 `--c-indigo` / `--c-ochre` / `--c-success`，**没给暗色值**。
SA-3 的处理：暗色下继承亮色值，并在文件注释与 `design-system.md` 中**如实标注"实测不达标，修正候选待批准"**，未擅自改规格。

**我的裁决**：接受 SA-3 的处理。理由：
- 这三个是"功能性状态色"，面积 ≤3%，用于成功/警告等语义，不是正文文字；
- 擅自发明规格外的颜色值会破坏"令牌值必须一字不差"的可审计性；
- 正确做法是把实测数据交给用户决定，而不是我替他决定。

### 2.4 SA-2 仍在采集

已见基线文件 13 个（625KB）。待其交付 `index.md`。

---

## 阶段 1 补充：可截图视图清单

见 `docs/redesign/views-inventory.md`（实测，非推测）。要点：
- 顶栏 8 个控件全部真实可点击（布局 ×4、明暗、刷新、设置、陪伴、自动刷新 ×2、文章选词）。
- 8 个图表选项中 6 个渲染 canvas、`recommend` 渲染文本列表、`study-web` 渲染 iframe，**零页面错误**。
- 浮层：`#settingsPanel`、`.settings-overlay`、`.settings-content`、`#welcomeOverlay`。
- **主界面是单一 dashboard 结构，没有多页面路由** → §9 应选**顶栏式导航**而非版心侧边导航（后者要新增顶级容器，风险高）。
- 墨墨学习界面停在**登录页**，登录后的 7 个状态需用户授权。

---

## 变更记录

| 时间 | 文件 | 子智能体 | 说明 |
|---|---|---|---|
| — | `docs/redesign/forbidden-zones.md` | SA-1 | 新建，禁区终审清单 |
| — | `docs/redesign/main-scope-verification.md` | 总负责人 | 新建，独立核查记录 |
| — | `docs/redesign/views-inventory.md` | 总负责人 | 新建，实测视图清单 |
| — | `tests/redesign/*` | 总负责人 | 新建截图/比对/探针基础设施（非产品代码） |
| — | `docs/redesign/baseline/**` | 总负责人 + SA-2 | 新建基线截图 |
| — | **`css/theme-constructivist-tokens.css`** | **SA-3** | **新建，10,188 B —— 第一个产品代码改动** |

**产品代码改动清单（截至目前，仅 1 项）：**
1. `css/theme-constructivist-tokens.css`（新增文件，未被任何分支加载 —— 尚无视觉影响）

## Round 2 复核与修正（优先于上文阶段性判断）

- 用户已明确授权：本人配合手动登录墨墨；采用系统字体栈，不新增字体文件。
- SA-2 原执行失败，无完整报告；已启动恢复执行，不将此前零散截图视为完整基线。
- SA-3 的通用 body/标题/p/焦点选择器会命中主主题下的爱音陪伴区域。此前称其“完全隔离合格”不成立；该文件尚未接入页面，无持久页面影响。要求修订后再验收。
- 比对器 `delta.convert('L')` 计数可能把单个蓝通道的 1 级差异舍入为零；空文件集也会错误 PASS。必须改为 RGB 任一通道非零的严格计数，空集/缺目录失败，并补自动化测试。此前 5 项自检不足以证明正确性。
- 字体宽度相等不能证明具体字形来源；document.fonts.check 对不存在的系统字体也可返回 true。只保留系统文件存在与有限量测证据，撤回具体字体已被严格证明的说法。
- 两套独立加载的 CSS 中同名变量不意味着修改其中一套会直接影响另一套；它们仍按用户要求保持原值，不能用错误层叠解释作证。
- 当前仍无法图像输入；不以计算样式或截图存在代替目视验收。
- `apply_patch` 命令不存在（Get-Command 已实测失败），本轮用可用的 read + edit/write 工具精确修改，并记录此限制。

### 本轮写前检查：比对器修复

目标仅 tests/redesign/compare.py、selftest_compare.py（本任务新增的验证工具，不是既有禁区测试），已读取最新版。只改像素计数、空集拒绝和测试，不改任何产品 DOM/逻辑/字体/共享变量/注入分支；无需截图，验证由合成像素及实际基线自比完成。git status 已检查，不回退既有修改。

### 本轮写前检查：人工登录辅助

新增 tests/redesign/manual-login.js，仅测试工具。复用已运行隔离服务 :55395，Edge 使用独立 _verification/redesign/manual-login-profile。只打开既有登录流程，不输入或读取凭据、不记录页面正文/表单/带查询参数URL，不导出认证状态，不新增产品JS或注入通道。用户已授权本人手动登录，工具等待用户操作。调试端口仅本机回环，使用后关闭。随后需真实截图；登录期间不截图密码框。

### 用户明确批准的规范例外（Round 2）

1. 保留既有 `<link id="memo-study-skin">` 和主题皮肤路径；放宽原固定 `<style id="memo-theme-main-inject">` 要求，其他隔离/清理验收不放宽。
2. 允许在既有 `syncMemoStudyTheme` 内添加一个纯视觉 class `memo-main-redesign` 的同步。仅当父页面显式 standard、body 非 companion-mode、iframe 不在 #companionStudy 内时添加；其余条件不添加。新 CSS 必须同时匹配 memo-standard 和此 class。保留原 link/id、两套路径、字体分支和观察器，不新增观察器/定时器，不改学习数据或交互逻辑。此项是禁止JS/DOM变更的窄例外，不是共享代码全面开放。

### 阶段二交付复核

- 接替 SA-2（665d2df9）已落盘153张真实截图及逐图指标，基线索引见 baseline/index.md。三分辨率、明暗与notebook；全为空数据、6张实际亮色例外、文章状态401、无真实角色和登录后流程均已明确标注，不能算完整验收。
- 接替 SA-3（8799ac2a）修订令牌为6609B，移除通用排版规则，增加非陪伴条件及目标排除。辅助尺寸与鱼尾已按规格修正，全部原色保留。
- 暗色ink字在原朱底仅3.55:1；撤回之前建议。采用已有vermilion-2底配paper字5.57:1，不新增色值。
- 进入组件/注入前，保存实际当前源码副本及资源SHA256，后续以此检查本任务差异，不用HEAD覆盖已有未提交工作。

### 阶段三执行与独立复核

- SA-4（67b9712b）独占新components CSS；SA-6（bc53ff51）独占memo_injection.py/maimemo-standard.css，二者并行实际执行。
- SA-6已落盘：Python仅+1行纯视觉守卫，旧CSS全量前缀不变，只追加6975B。父级独立重跑永久测试50项通过；这不是登录后流程通过。
- 父级asset_guard初次解析器不支持显式字符串加法而失败，已用只支持字符串常量及Add的AST递归修正，不执行被解析模块。复跑1063资产及11项原片段检查均通过，无白名单外变化。此时components仍未加载。
- SA-2自带--verify原先只打印后exit0，不能证明通过；恢复执行者已落实严格退出码、153完整组合/PNG/sidecar/明暗/错误允许清单，并24项自测通过。父级后续复跑，不沿用旧弱验证器结论。
- 用户已明确允许只读复制现有公开千早爱音Live2D素材到隔离环境并仅在测试库登记；禁止复制/读写真实DB、聊天、账号或语音模型。SA-2负责此补充基线，原素材做前后全量SHA256。
- 现有人工登录窗口欢迎层已通过真实按钮关闭，iframe存在；不读取用户输入框或导出认证状态。用户登录完成反馈仍待取得。

### 写前检查：暗色派生令牌修复

SA-4实测发现根节点定义的--rule-*和--shadow-hard已在html处以亮色求值，body.dark仅重定义颜色不会重算继承过来的派生值。父级已重新读取令牌最新版（SA-3已交回所有权），将暗色声明移至相同html节点，以`:has(> body.dark:not(.companion-mode))`检测已有暗色类；不改任何令牌值、模式行为或禁区文件。新增测试验证真实CSSOM的亮/暗边框和阴影颜色、缺属性/陪伴关闭、恢复与reduced-motion。此修复只涉及新令牌CSS和新增测试。

### 真实登录与操作授权

用户确认已登录。父级通过独立CDP客户端只读确认iframe为memo-standard、真实rev-root及回忆遮罩可见，释义未显示；已拍三档当前状态基线（authenticated-home目录名是初始命名，不据此认定页面仅为主页）。未点击任何答案或保存。用户随后选择“由我本人操作答题和保存，你只负责观察截图”，因此不代替用户做真实学习判断或内容写入。

### 写前检查：阶段三主主题CSS接入

SA-4/SA-6均已落盘并释放所有权；SA-4最终17935B，SA-6追加6975B。已重新read js/ui-style.js、查看原git diff并与source-before对照。仅在standard分支现有加载语句末尾追加tokens/components两条css调用，全新id；不更改VERSION、notebook分支、旧加载路径、applyBody/activate、DOM或资源。需要由SA-8轮1复核三分辨率/亮暗/手账/陪伴及实际加载；用户窗口不主动刷新，旧注入服务暂不重启。角色组保护使设置外框保持旧样式，作为明确范围收缩。

### 用户优先变更：原生答题层与快捷键说明遮挡

用户明确指出父壳后来添加的熟悉/模糊等悬浮按钮完全遮盖了网页原生快捷键说明的关闭入口，要求首先停止覆盖，直接注入样式覆盖原本按钮，让按钮回到原生层级。此要求优先于后续布局阶段，并窄幅放宽原“不改显隐”限制：仅主主题非陪伴dashboard内隐藏重复.study-web-actions，使用iframe内原.rev-resp-btns的原按钮/事件；不修改答题事件、顺序、原生position/z-index/布局，不用提高跨文档z-index补丁。notebook/陪伴及其悬浮控件维持原样。已重读主学习脚本、shortcuts和两份共享CSS，确认未隐藏原生按钮；共享文件保持不动。

SA-8轮1已冻结交付“不通过”快照，不将修复前结果冒充通过。用户本人操作真实学习答案和保存的限制继续有效。为使已批准新纯视觉同步从真实代理生效，仅测试serve.py新增固定--port选项，在同一55395原点重启同一隔离data-main服务；用户浏览器/资料目录不更换，不导出会话，不启动替代DSH GUI。

### 原生图层修复实际验证与轮1修复

父级完成真实同一说明确认点的前后命中对照：修前父页命中重复DIV，修后命中原IFRAME。先取消独立闲置连接提示，再实点原生确认关闭；刷新后新视觉类真实生效。协议勾选未选时助手中止进入，由用户本人完成确认并进入单词页。持久注入后再次通过原生更多菜单打开说明，原生确认中心父页命中IFRAME、子页命中taroify-dialog__confirm，实点再次关闭成功。真实按钮仍259×63、position:relative、z-index:auto。全程未点击真实答案或保存。详见[原生图层报告](native-answer-fix.md)。

首个刷新等待20s超时已调查：稍后正确视觉类已存在，页面停在有协议的开始入口而不是学习词条；并非通过放宽作用域修复。原生菜单getByText点击失败因命中文本层，改定位真实taroify-button父级成功，无force/DOM改动。上述过程不等于所有真实答题/保存业务验收。

同一修复的全屏补查发现layout.openFullscreen会把学习原节点移入fullscreenModal，故SA-4将唯一去重显隐例外扩至dashboard和fullscreenModal两个主主题宿主；父级扩展[永久层级测试](../../tests/redesign/native-answer-layer.js)覆盖此移动路径，待运行确认，原54项结果不冒充扩展后结果。

SA-6轮1修复只append1746B清TTS blur/transition/位移、修导航hover/dark和焦点，累计新CSS8721B；永久脚本加入--out并193项通过，不覆盖旧50项证据。所有权已交回，父级随后独立复跑。SA-4的32px目标/三短条loading/有限fullscreen补测仍在进行。

### 完整回归故障定位与复跑

第一次完整回归在quality-hardening父页面快捷键断言失败（0而非1）。只读诊断确认容器可见但document.activeElement是iframe：旧测试依赖点击(1,1)处的圆角透明像素取得父焦点，新方角已把它交给真实iframe。未改快捷键产品逻辑，保留全部断言，仅让测试dashboard可程序聚焦并显式focus，再测父快捷键路由。单文件复跑通过；完整[回归实录](round1/followup-full-regression-pass.log)再次执行退出0：全部既有JS检查、五组浏览器脚本、发布守卫、551项Python测试和git diff --check通过。此为隔离fixture回归，不是替用户真实云端保存。

### 用户授权：仅测试确定性禁区对照

父级报告第一轮18对原始截图均非零，说明GIF帧/倒计时与尚未稳态加载的影响，没有称像素零差异。用户明确选择“允许仅测试确定性对照”：可新增一组仅测试截图，使原GIF保持相同原始帧、时间固定；原文件/产品代码不改，原始动态截图完整保留。结果必须标为静态帧样式隔离证据，不冒充真实动态/Live2D渲染验收；不扩大为修改素材、生产动画或真实用户浏览器的授权。

### 轮1修复独立复核与下一阶段启动

父级独立复跑native-answer-layer得到78项通过（含dashboard原节点迁入fullscreenModal），study-theme-isolation在独立lead-round1-review目录193项通过。SA-4已交回组件20207B/56规则；父级用新review-components.js复用其完整断言但输出新目录，6个context全部通过：215保护元素、每例102985非自定义属性及全部矩形字段差异0，陪伴规则命中0。此为计算样式隔离，不声称原始动态像素或人工目视通过。内联调用首次PowerShell引号解析失败且无文件执行，改用独立脚本后退出0。用户窗口当前为notebook companion，父级只读截图确认后不改变模式；名为persistent-native-guide-closed的目录实际记录此状态，不能据目录名当主主题说明关闭证据。

新增图表五段共享核心片段锁定（共16保护片段），涵盖原palette数组/数据函数、状态生命周期、推荐异步渲染/事件、持久化与导出；asset_guard独立验证1063资产、16片段通过。SA-5/7按原顺序并行启动。初始子代理多次启动失败未返回交付，已确认inactive后换执行者：SA5 c518ceeb、SA7 feb5f44d；确定性测试工具接替e54c301e。各自文件所有权互斥，禁止连接用户9337、替答题保存或扩展禁区。阶段尚在执行，不提前SA-8轮2/3或SA-9。

### 确定性准备复核与最终模板确认

接替工具完成精确manifest的22 GIF首帧提取，无原文件修改；父级在全新lead-verified-1280输出目录独立复跑两case退出0：notebook dashboard与standard companion各0/1024000 RGB差异，原始PNG对哈希相等。手账没有新links是自然加载隔离，不是强制加载负例；陪伴两links实际切换，75规则match0。仅tokens/components，不含尚未加载layout；fallbackVisible=true、realCanvasProven=false。严格matrix验证器24项自测及像素比较器8项自测独立复跑通过。原18对非零动态截图全部保留。

当前模型再次read_image返回不支持图像输入；不能因此假称视觉审美/字形通过。用户另明确允许按现有证据组织最终九节报告，因为仓库并未保存本次完整原任务书及九标题；不是允许放宽禁区、改阶段顺序或将未完成写成通过。最终仍需如实列出限制与SA-9结论。

### SA-5/7交付与布局接线

SA5最终3264B/16规则，累计shell30163B。为保护入口几何，撤销初版当前字体测量的145.171875px硬槽与H1字体/字号变更，最终仅清旧渐变/spacing；衬线置于tile-title。八context、215保护集合computed+rect0、四布局/三档明暗及420窄屏完成；geometry-final基于既有最终metrics24桌面组正面积/边界/等宽/不重叠通过。200%CSSzoom原始失败保留，最终无硬槽，九种有效CSSviewport模拟入口rect0；不冒充原生zoom通过。未新增鱼尾/象鼻，保守限制记于sa5-layout.md。

SA7严格standard非companion纯paint映射交回；父级在docs/redesign/sa7/lead-review独立执行19932断言通过，包含旧范围options/function/formatter深相等、main业务数据不变及实际六canvas非空。六热力图选择保留、数值标签对比补测；暗色硬palette依赖亮墨描边/1px无blur线下衬，不称每个填充背景对比均达标。asset_guard再次1063/16片段通过，无范围外变化。

父级重新读取ui-style.js，仅在standard现新components行之后追加layout新id加载；notebook与生命周期不变。独立layout永久测试在sa5/lead-final-review执行中。已依顺序启动SA8轮2独立执行者193bf2e9，仅新round2工具/证据/报告所有权，禁止产品写入、真实账号操作或提前轮3/SA9。最终九节report.md已建立执行中草稿，全部未完成项明确，不将目标标记完成。

### 接线后回归与轮2联合隔离P1

父级layout永久测试在sa5/lead-final-review完成八context退出0，最终3264/累计30163B。接线后完整回归初次在文章输入框即时可见性断言失败，源码核查确认外层先show、账号状态异步返回后才mount；单测重跑通过，随后仅给测试添加visible等待，保留原断言，不改产品。再次完整551项Python和五组浏览器等检查通过，输出已保存integrated-regression-pass.log。

SA8轮2三新CSS联合enabled/disabled首次发现normal设置间接禁区位移P1：245元素（含额外role根/pseudo），noncustom style值0差异但369矩形字段非零；入口x变化0.5px，角色组y变化117.890625px。之前SA4修前/修后0及单独layout0不能作为整体原base0证明，报告已明确更正。轮2仍冻结采集，产品暂不写；新修复执行者d78c3d75仅在独立context候选route诊断，禁止动禁区本体/硬补偿偏移。待轮2交付后撤回影响前置设置与入口几何的非禁区新规则，保留paint和原生按钮去重，再联合复测。未提前轮3/SA9，不用551业务通过掩盖此隔离失败。

### 轮2冻结、v4正式修复与轮3开始

轮2有限采集144状态/240PNG后冻结不通过，六normal位置P1及AI工具条30px旧圆角P1确认，30静态24严格RGB0、6手账settings字体loading拒绝proof。原始18动态RGB非零均保留，不能全归GIF。修复候选v3经父级逐行审阅发现CSSOM重序列丢无关spinner背景/notice border及media，被拒绝；未进产品。v4严格原文本仅撤回20settings/topbar目标block非paint声明，36非目标与reducedmotion逐字相等，保留原生判断栏去重。轮2释放后才合入v4+已真实候选验证AI片段，产品20009B/SHA69bb103297aed39edc301dea23222402363b2ee29a76210100348db9013870ae，shell29965B。

正式product-v4-joint01六context12对245/323全noncustom+pseudo+rect/topbar矩形0；真实产品AI明暗各10控件尺寸>=32/radius0/严格纸墨配色/canvas正面积通过。父级修后另tokens23/native78/asset1063与16片段/全551Python五browser通过，全日志round2-fixes-regression-pass.log。候选错误和原失败未删除，修复报告REPORT-v4明确取代v3推荐。

顺序门满足后才启动新独立SA8轮3执行者2f0d7cc3，只写新round3脚本/报告/证据；产品冻结，不接用户9337、不真实答题保存。轮3预热computed字体再await稳态后二次loaded门，保持轮2六invalid不回填；按原有限144/30矩阵新目录复测，动态与静态证据继续分列。SA9未启动，未称整体完成。

### 有限性能补充与轮3未满足项

性能代理fa96限定六独立context（每组三，另同contextreload）采集完成，API全部阻断，current基线route比较。首baseline context pageerror3、DOM574而其他baseline625，原脚本漏pageerror门所以真实exit0不代表有效；保留raw，不删异常、不加context。修脚本门后只读--validate由代理和父级分别实际exit1，0新context/raw未修改。performance.md明示timing不可作干净比较、实例全0/canvas1不是模型，性能无回退缺口未闭合；静态CSS29965/native追加8721和26JS/vendor无新增依赖可单独引用。

轮3初步新P1：v4保守撤共同rule导致非AI主域仍有小target，layout42x30/autoRefresh28x28/interval46x20/chartselector110x26/fullscreen28x28/trendrange高24/articleclose28与一按钮31.796875。它们不是全属业务或companion禁区，不能以既有就豁免。产品冻结不修，等轮3完整清单冻结。后续可拆独立非保护selector恢复32，但topbar任何改动不得推移受保护入口；若两条硬约束真实冲突须带证据问用户，不以transform/补偿固定width伪造0。SA9仍未开始。

### 顶栏尺寸硬冲突与用户唯一豁免

独立5e068在1280/1440两context四variant实证：safe候选normal245/companion323/article245均属性+伪元素+rect0，auto-only/combined在normal/article恰好入口x/left/right各-2px，8失败pair，非CSS直接命中。源20009B前缀逐字保留，没有负margin/transform/父width等补偿。用户在明确二选一问题中选择「保留入口零位移，允许该按钮28×28」；因此仅autoRefreshToggle获最小尺寸豁免，其余小target仍需32。safe候选待轮3采集冻结后合入，auto/combined不合入。

轮3字体预热修正有效，但固定clock后倒计时发生9:29→114:23等不一致，natural无links亦41computed/rect变化，故静态case有效性失败不能称CSS污染或像素0。保留现有限矩阵，不中途改脚本、不补跑覆盖。父级另仅只读委托时钟根因分析，不启动额外浏览器或改产品，待轮3冻结后作有限定向验证。用户“继续”后检查目标仍active/armed；resume请求返回already active/armed，不更改目标状态。

只读根因进一步核对：app.js2005先保存真实Date截止点，2054直接减Date.now；Playwright晚install后不迁移旧原生interval到新timer Map，runFor不直接驱动旧interval。enabled文本陈旧/disabled真实tick更新与现指标吻合，但不声称每次tick序列都已复现。后续最窄候选是正常稳态后取页面当前epoch再setFixedTime、保持timer自然运行，不显式install/pause/runFor；底层仍可能注入wrappers，不能声称完全不替换API。已仅授权新clock-static-recheck脚本准备notebook dashboard/settings1280自然两case，暂不browser，必须轮3冻结后放行，不覆盖原30。

### 轮3冻结后修复与有限复验

SA8采集终于freeze/release，144states/228PNG/12保护对照/30静态，原run真实exit1，provenance起止1065文件一致。12保护245/323与六AI专项0；18动态RGB非零33–42036，30静态全invalid，完整验证1910项1856PASS/54FAIL（6小target+18动态+30静态）。原证据不改写。

随后明确授权5e068仅向components追加非冲突32规则，原20009B前缀逐字保留，555B正式注释+规则追加，现20564B/SHA3ad830841b35e3df402094b47d5031b1e498c5036acee44545042f1952befe2d，shell30520B；唯一toggle仍28。新永久main-control-targets真实产品明暗三档六context进行中，完整保护和entry硬门0，非保护topbar正常geometry变化记录但不冒充禁区。父级full job pwsh-46b3ae3410ff45c5已收exit0：551Python/五browser/JS/release/diff完整PASS；tokens job pwsh-fb0911bb7b32419a23PASS/native job pwsh-a9698768291a4c1578PASS均收齐。asset1063/16范围外0，gitdiffcheckexit0。

唯一时钟复验两个原失败点已按明确放行运行一次，新root round3/clock-recheck-01，整体exit1无补跑：dashboard1280natural644元素computed/pseudo/rect0、RGB0/1024000，页面sampled epoch7:09:37.644Z、countdown9:40及font跨两真实tick稳定；settings在字体loading初始化门拒，尚无clock/pair/RGB，不称通过。产品provenance前后一致3ad830...。这证明仅该dashboard点，不能覆盖30invalid/强制加载/动态18failed。SA9等六context正式尺寸回归交付后启动，不强迫通过。

### 当前冻结交接SA9

六context正式产品测试已真实exit0并全部job收齐：30完整guard0，132目标=120≥32+12唯一toggle28，480非保护topbar字段变化全记录；55395 GET三CSS==disk，最终freeze hash3ad830...不变。父级完整fulljob输出从实际tool spill逐字复制为round3-fixes-regression-pass.log，未新编写结果或重跑。随后独立SA9 d36cedae启动，仅读源码和证据/只读离线检查，产品不动，无browser/server；明确不预设通过，不把历史已修P1再当新bug。人工视觉/真实模型/真实本人学习/性能与最终像素缺口仍明示，待独立审稿落盘。

### SA9正式不通过

独立SA9已交付sa9-review.md与sa9只读证据：asset1063/16、10项聚合断言、永久测试syntax、35相对链接均exit0；performance只读有效性校验exit1。审稿没有新增已证当前实现bug，明确小控件已修、132不是全≥32。结论不通过，阻断为18动态非零、最终静态30invalid与定向settings仍invalid、真实模型fallback/绑定不完整、人工图像与本人真实业务未验收，以及性能有效性缺口。未预许通过、不改旧证据，无browser/server/job。九节report及acceptance已同步正式结论，产品30520B版本继续freeze，目标保持active未完成；后续按审稿最窄清单处理，不能用文档填写完成冒充目标完成。

### 目标第6轮有限补证开始

重新实读SA9/产品冻结hash仍3ad830...。仅授权两项独立有限工作：021a8c仅新clock-static-recheck-v2测试，补preclock最多3次隐藏/pseudo全量字体预热+loaded确认，仍仅原notebook dashboard/settings1280natural两ctx一次新root02，原RGB/computed/倒计时门全保留；46faef仅离线对既有动态图PNG差异bbox/已记录rect关联，不browser、不改原图或阈值，优先33最小差异及notebookdashboard大差两点。没有新增生产修改/真实模型绕过/真实答题保存，原SA9不通过不重标。

第6轮定向v2唯一job pwsh-f000401cba5346cd收齐exit0，两case有效：dashboard attempt1loaded，settings attempt1 realizedloading/inspectloaded不接受、attempt2三段loaded才采epoch；每例644全元素computed/pseudo/rect0、RGB0/1024000/max0，两自然tick同Date/countdown/fontstable，1065provenance/22GIF/manifest起止一致。原01和30invalid不回填。随后明确授权仅原30case矩阵一次新rootstatic-recheck-01，不扩state、不修改产品或原脚本，所有旧严格门保留，forced必须真实三link非空+主体selector0；脚本准备中。

独立离线dynamic18pair分析一次job pwsh-9e395f65e96641a6由代理收齐exit0，293768像素重算与原一致。289707落IMG并集/1801倒计时/2260settings候选rect外；最小33全countdown，最大42036是notebookcompanion而非dashboard。IMG与canvas重叠不能证明canvas像素；blur/fontloading只是settings外残余相关假说。原动态failed/SA9不通过保持，现无真实动态同步帧因果proof。

第6轮明确询问真实模型完整绑定前置条件，用户选择「暂不提供，保留真实模型未验收」；这不是豁免或要求改角色门。后续companion仍fallback如实记录realCanvasProvenfalse，不进入私人资源/角色注册/真实答题save。当前继续的30case只证明受控静态CSS隔离，不可改名dynamic或真实模型证明。

只读performance诊断：旧6ctx实际headless串行，不是并行/async脚本；原index阻塞顺序相同，无法从ResourceTiming结束顺序推断JS执行错误。首baseline574稳定并不能证明625正常结构，旧脚本pageerror仅context聚合3未记录文本/phase，缺/index.html HEAD与初始化未完相容但因果未知。imagesFailed有记录无失败门，连续3次count间隔200ms最短400ms不是同构证明。后续只可新测试记录公开脚本脱敏错误/按phase/结构fingerprint+tagcensus/已知三link差别白名单及imagefailed门，不能篡改历史69bb版本锁或删首异常。目前不额外开性能browser，与现30静态限定不混跑。

30static唯一job pwsh-3435901d996849dc，完整fullhidden/pseudo耗时每case约60–100秒，不扩case。首5全形成computed/RGB0 pair但raw3pass/2fail，代理发现禁用态validate(after)复用启用态loadednonempty门，link.disabled后sheet可能null导致误拒。运行中不改script/不补跑；rawexit须保留失败。采后新增独立phase-aware validator只要求enabled三link真实loaded非空且disabledfalse/主体selector0，disabled三linkpresent+disabledtrue，配合完整computed/RGB/date/font/provenance严格门；无独立验证前不能宣布30通过，独立pass亦不能篡改rawexit。性能pilot仅准备新script/design不browser，待该job收齐后才另行决定。父级本轮也实际read_image新02settingsPNG，工具再次明确gpt-6.1-sol无image input未交付图像，故不能声称目视/字形/美学审查。

performancepilot准备13e910完成，唯一syntaxcheckexit0，无browser/job/network：新script+pilot-design.md，最多baseline/current各1startup，首错停、safeerrorlocation、真实HEAD生命周期+toolbarshape、全DOM去仅3link的结构hash/tagcensus、图片pending/failed0、两组同构门。仅有效性pilot，不能由n1宣布性能无回退；尚未授权运行。SA9执行者另获只读method预审新静态validator，不改原SA9或写root，不重跑旧assertion（其工具会覆盖既有输出），不预判未完成矩阵。

SA9只读method预审认可受控静态方法及phase-aware sheet状态门，但要求offline显式分类summary.failures拒fatal/未知，不能只row.errors；已交代理在未运行validator前加门。两个自然≥1100ms稳定窗口不等于instrumented两个callback执行证明，报告用稳定窗口措辞。用户再次明确尚未检查视觉/本人真实学习保存，全部未验收；不构成豁免。

主机时间从15:44跨至18:14（约2h29）期间，原capture job仍running、node进程与证据更新存在，疑似挂起恢复，未kill/补跑/新browserinvocation。保留真实Date/elapsed观察，不人为改计时。第14pair后等待原任务继续，运行未完不宣称30通过。

15阈值raw7pass/8fail，第15 notebookarticle1440natural新增真实RGB2641/1296000/max194，后16forced与17/18像素0。未知真像素不能被phase-aware sheet门解释或忽略，offline总门必须拒；明确完整矩阵整体仍未通过。另只授权46faef读取这个已落盘pair离线bbox/连通块/rect与日期字体稳定定位，新dynamic-analysis子目录一次，不浏览器不改root/原图不补跑，产品仍冻结。

单pair分析确认不是computed0：48字段非零、675元素，2641全topbar（4连通块1886/571/164/20），Date同/字体loaded/三link自然不存在，但countdown9:34→更新失败，刷新组宽+10与right区x-10。稳定窗口2elapsed8466323ms而perf只10525→19180，enabled至disabledperf19180→8488366；与约141分钟主机挂起时序背景相关，不能宣称精确callback因果。支持状态失配invalid，不能当CSS应用变化或通过，亦非GIF/caret。只读新analysis冻结，job由代理收齐。

父级独立02summary只读校验：初Node inline受Windows引号丢失SyntaxErrorexit1无读写副作用，换PowerShell ConvertFromJson检查2case/process0/provenance/Datecountdown相同/computed0/RGB0成功exit0，无新browser/文件写。当前30到20阈值raw8pass12fail，余case继续，所有旧证据不改。

30采集最终ownerjobcollectexit1，30pairs/60PNG/11rawpass19rawfail，18为禁用sheet误门、1文章真正状态失配。独立validator一次exit1/311门305pass6fail，29局部computed/RGB0；blocked49全被守卫主动拒绝未放行（不能据此宣称资源完全加载或安全凭据未触发），总体blocked0严格门仍fail。1065起止provenance/currentdisk一致、22GIF/manifest一致，组件20564/shell30520未变。父级WaitProcess观察jobdff已collectexit0，无重复capture；原browserclose完成。

矩阵浏览器关闭后另明确授权唯一performance-pilot01，不重叠采集。jobb27已ownercollectexit1，仅baseline1ctx，INITIALIZATION_HEAD_TIMEOUT，pageerror0、安全位置空。HEAD已有routehit但requestfinishedflagfalse，不是没发请求/不能据此断言bootstrap中断。初始DOM625/body606及4组控件符合，但未dismiss、无final稳定/无current，validfalse不能性能结论。assets/source起止一致，script/raw不改无重试，REPORT已落盘。

独立SA9新round6followup已交付不通过（原sa9-review不改），待专项已知路径补读后封存。未发现新增已确证产品bug，实际缺口和用户前置继续公开保留，不强迫通过。

## 目标第7轮：HEAD契约离线澄清

仅核对已有pilot/source与独立只读审查，未browser/HTTP/新采集。routeHits在fulfill前写，bytes是原HTML长度不是HEAD体积；旧result没HEADresponse状态也没serverStatus，requestfinished缺失不能唯一归因。应用只awaitfetch读取resp.ok，观察契约需与应用语义对应而不能只换一个必过条件。

新增head-readiness-contract.cjs纯候选门及其.test.cjs：要求真实同page/navigation非跳转无凭据同源HEAD成功response和随后唯一online/nonchecking/nonoffline节点+shape/welcome，显式拒requestfailed/pageerror及缺失安全观测。35离线unit均PASS/exit0（最初33PASS后补2requestfailed反例）。未接入任何collector；人工合成测试输入不是真browser证据。新performance/head-contract-round7.md写明旧原因未知、adapter未实现/未验证、下一步需先审真实观察与身份门、不授权新run。report第7节已接入口，原pilot/raw/script/产品/SA9不改，目标active。

## 目标第8轮：候选事件适配层与竞态回归

新增head-readiness-observer.cjs及.test.cjs，不被collectorimport，未browser/HTTP采集。初版56unit通过后独立审查发现headers省略Cookie、旧HEAD响应错绑startup、same-document导航失效缺失。已用allHeaders/请求WeakMap+首次commit绑定/framenavigated后续永久失败修正，并加入真正延迟Promise期间的错误/导航/dispose反例。

第二审又复现异步第二HEAD头未读完可沿用旧response，改为同步headResponses计数在await前拒第二响应；两个最窄反例及其他头延迟反例合计68unit通过exit0。独立最终只读确认具体竞态闭合，但不整体宣称代码或runtime正确。新head-observer-round8.md已记录候选缺陷不是产品安全漏洞、DOM真实reader和collector集成及真实event ordering未实现/未验证、timeout依未来collector保留。产品/旧pilot/原SA9不改，目标仍active。

## 目标第9轮：持续前置条件核对与交接

再次读acceptance-status与round8方法，确认第6轮起用户暂不提供合法完整binding、视觉与本人真实学习保存尚未检查状态连续第6–9轮未变。不能伪造或替用户提交，也无imageinput。最终SA9PASS必需前置无法由继续堆离线候选测试满足，技术矩阵/动态/性能缺口亦仍保留。停扩候选代码，不重问用户、不browser/重采。

本轮asset_guard verify实际exit0：1063资产、16保护片段、范围外变化0，仅7声明可改路径变化。修acceptance-status过时「采集中」为已结束，新增acceptance-handoff.md明确当前未完成/未发布/后续恢复边界。总报告接入交接，不重写历史失败。基于同一具体外部前置连续超过3轮存在，目标申请blocked而非complete；未来新的人类指示可resume但泛化继续不等价已提供绑定或本人确认。


