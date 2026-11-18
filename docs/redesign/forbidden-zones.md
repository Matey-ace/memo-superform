# 禁区测绘报告（SA-1）

- 项目：Memo Superform 前端重设计
- 工作目录：`D:\MeMo1`（Windows / PowerShell）
- 角色：SA-1 禁区测绘员（**只读，未修改任何代码文件**）
- 产出：本文件
- 测绘时间：2026-11-16

> 本报告所有行号均来自实际 `read` / `grep` 结果，不按文件名猜测。
> 凡与总负责人先前结论不一致处，均在正文中显式标注 **【复核修正】** 并给出行号证据。

---

## 0. 先说结论（TL;DR）

| 项 | 结论 |
|---|---|
| 主主题代码标识 | **`standard`**（`js/ui-style.js:9`） |
| 存储键 | `localStorage['memo_ui_style']`（`js/ui-style.js:6`） |
| 主题挂载位置 | `document.documentElement` 的 **`data-ui-style`** 属性（`js/ui-style.js:16`），**不是** `data-theme` |
| MAIN_SCOPE（外壳） | **`html[data-ui-style="standard"]`** ✅ 可用，且**失败时闭嘴（fails closed）** |
| MAIN_SCOPE（墨墨 iframe 内） | **`html.memo-standard`**（`memo_injection.py:59`） |
| 禁区整文件数 | **17 项**（含 3 个素材目录、1 个校验文件、1 个 vendor 目录） |
| 疑似禁区数 | **15 项** |
| 必须停下来问用户的冲突 | **有 1 条硬冲突 + 2 条需拍板**，见 H 节 |

---

## A. 禁区文件清单（整文件禁止编辑）

判定依据编号对应任务书"识别规则"：
`R1` 角色名（中/日/罗马字）、`R2` 角色立绘/Logo/语音/Live2D/配色、`R3` 手账/笔记本/日记专属 CSS 与 GIF/纸张/手写字体、`R4` `index-anon.html` 与 `ui-style.js` 的 notebook 分支、`R5` Live2D 陪伴模式整体、`R6` 无法 100% 确认→按禁区处理。

| # | 文件路径 | 行数/大小 | 判定依据 | 置信度 |
|---|---|---|---|---|
| 1 | `index-anon.html` | 16 行 | R4：`localStorage.setItem('memo_ui_style','notebook')` 后跳转 `index.html`（第 11-12 行） | 确认 |
| 2 | `css/style-anon.css` | 536 行 | R3/R2：文件头第 2 行 `Memo Superform · Anon的笔记本`；`:root` 定义 `--rose/--paper/--ink/--serif` 手账色板（第 6-38 行）；`--round:'M PLUS Rounded 1c'`（第 37 行） | 确认 |
| 3 | `css/diary.css` | 166 行 | R3：第 2 行 `Anon的笔记本 · Memory Diary`；第 90/93/99/112/148 行用 `'M PLUS Rounded 1c'` | 确认 |
| 4 | `css/study-web-notebook.css` | 99 行 | R3：第 1 行 `仅用于 Anon 笔记本主题`；全文件 40+ 条规则一律 `body.notebook-mode` 前缀 | 确认 |
| 5 | `css/maimemo-notebook.css` | 718 行 | R3：第 1-2 行 `墨墨背词学习页Anon的笔记本皮肤`；全文件 `html.memo-notebook` 前缀，含 `--memo-paper` 纸张变量（第 12 行） | 确认 |
| 6 | `css/fonts.css` | 954,155 B | R3 + 规则 5：仅手账分支加载（`js/ui-style.js:28`）；`@font-face` 声明 `Noto Serif SC`/`Noto Sans SC`/`M PLUS Rounded 1c` | 确认 |
| 7 | `js/diary.js` | 209 行 | R3：第 1-2 行 `Anon的笔记本 · Memory Diary`；第 107 行硬编码 `img/gifs/rana-sleep.gif` | 确认 |
| 8 | `js/gif-icons.js` | 41 行 | R2：MAP 全部指向角色 GIF——`soyo-bighead`(3)、`taki-daze`(4)、`soyo-shy`(5)、`nyamu-shout`(6)、`umiri-happy`(7)、`anon-think`(8) | 确认 |
| 9 | `js/live2d-companion.js` | 1,286 行 | R5：`isAnonBirthday()` 判 `character_id === '037'` 且 9/6（第 1214-1216 行）；生日文案含"愛音/爱音"（第 1234、1238-1239 行）；备用图 `img/gifs/anon-think.gif`（第 883-892 行） | 确认 |
| 10 | `css/live2d-companion.css` | 119 行 | R5：第 3-37 行陪伴模式布局/气泡/触摸/生日卡；第 88-100 行 `.notebook-mode` 手账覆盖 | 确认（**新判定**，见 H） |
| 11 | `fonts/**` | 985 文件 / 20.98 MB | R3 + 规则 5/10：被 `tests/font-gif-manifest.sha256` 逐字节校验 | 确认 |
| 12 | `img/gifs/**` | 22 文件 / 27.8 MB | R2/R3：文件名即角色——`anon-*`(5)、`soyo-*`(4)、`sakiko-*`(3)、`tomori-*`(3)、`rana-sleep`、`taki-daze`、`umiri-*`(2)、`nyamu-shout`、`mutsumi-cucumber`、`uika-tea` | 确认 |
| 13 | `data/live2d/models/**` | 76 文件 / 2.41 MB | R2/R5：唯一模型目录 `bestdori-037_birthday_2024_ssr-fb4e0843b7ac`；`memo-live2d.json` 第 2 行 `"id": "bestdori-037_birthday_2024_ssr-fb4e0843b7ac"` | 确认 |
| 14 | `data/tts_pack/roles/anon/**` | `gpt.ckpt` 155,312,438 B；`sovits.pth` 87,084,285 B；`reference.wav` 266,924 B；`persona.json` 424 B | R2：角色语音模型；`tts.py:920` 定义 `{"role_id":"anon","name":"千早爱音"}` | 确认 |
| 15 | `tests/font-gif-manifest.sha256` | 1,006 行 | 规则 10：`tests/test_regression.py:15-21` 逐行断言 SHA-1 且断言行数恰为 1006 | 确认 |
| 16 | `vendor/live2d/**` | 926,433 B | R5 + 第三方只读：`live2d-2.1.min.js`、`live2dcubismcore.min.js`、`pixi-6.5.10.min.js`、`pixi-live2d-display-0.4.0.min.js` | 确认 |
| 17 | `_archive/legacy/easter-egg.{js,css}` | — | R3：`easter-egg.css:1` `停用的手账彩蛋样式`；`test_regression.py:136-142` 断言其必须存在且不得被加载 | 确认 |

### A-补. 明确不遍历的大目录（仅记录存在）

`data/`、`dist/`、`MemoSuperform-v0.75-portable/`、`node_modules/`、`_archive/`、`MCLDownload/`、`build/`、`_release/`、`_verification/`、`output/`、`.workbuddy/`
→ 均不属于前端源码，未逐层遍历（`_archive/legacy/` 因含手账归档，仅做定点核对）。

**另注**：`_verification/**` 与 `output/**` 下有 30+ 份 `index.html` / `index-anon.html` 历史快照副本。这些是回滚夹具，**不是运行时代码**，但含手账内容，默认按禁区对待。

---

## B. 共享文件中的禁区片段清单

> 这些文件**可以整体编辑**，但下列行段是禁区，不得改动一个字符。

| # | 文件 | 起止行号 | 片段性质 | 内容摘录 |
|---|---|---|---|---|
| 1 | `js/ui-style.js` | 12 | 分支（notebook 判定） | `if (saved === 'notebook') value = 'notebook';` |
| 2 | `js/ui-style.js` | 15-17 | 变量/条件分支 | `var notebook = value === 'notebook';` / `setAttribute('data-ui-style', value)` / `document.title = notebook ? 'Memo Superform · Anon的笔记本' : ...` |
| 3 | `js/ui-style.js` | 23-34 | **notebook CSS 加载分支** | `css('css/diary.css','memo-diary'); css('css/fonts.css','memo-notebook-fonts'); css('css/style-anon.css','memo-dashboard-theme'); css('css/study-web-notebook.css','memo-study-theme');` |
| 4 | `js/ui-style.js` | 51-55 | 类名 + 暗色互斥 | `body.classList.toggle('notebook-mode', notebook); body.classList.toggle('standard-mode', !notebook); if (notebook) body.classList.remove('dark');` |
| 5 | `js/ui-style.js` | 60-78 | DOM 填装/选项注入 | `[data-notebook-only]` hidden 切换；`[data-notebook-src]` 填 src；追加 `option.value='diary'`、`textContent='Anon的笔记本'` |
| 6 | `index.html` | 19 | 素材引用 | `<img hidden data-notebook-only data-notebook-src="img/gifs/anon-think.gif">` |
| 7 | `index.html` | 23 | 文案 | `<span class="topbar-sub" hidden data-notebook-only>Anon的笔记本 · 数据磁贴</span>` |
| 8 | `index.html` | 70, 76, 102, 136, 162 | DOM 占位 | `class="topbar-tape" hidden data-notebook-only` / `class="tile-tape" hidden data-notebook-only`（手账胶带） |
| 9 | `index.html` | 194-215 | **Live2D 陪伴模式整段 DOM** | `<section id="companionStudy" class="companion-study">` 含 `#companionLive2DHost`(199)、`#companionBirthdayBadge`(201)、`#companionLive2DCanvas`(202)、`#companionGifFallback`(203，`anon-think.gif`)、`#companionBirthdayCard`(212，`aria-label="Anon 生日纪念卡"`) |
| 10 | `index.html` | 42 | 陪伴入口按钮 | `<button id="companionModeBtn" ...>✦ 陪伴学习</button>` |
| 11 | `index.html` | 556 | 素材引用 | `<img hidden data-notebook-only data-notebook-src="img/gifs/tomori-c.gif" class="welcome-gif">` |
| 12 | `index.html` | 591-594 | **notebook 脚本分支** | `if (window.MemoUIStyle.isNotebook) { document.write('<script src="js/diary.js?..."><\/script><script src="js/gif-icons.js?..."><\/script>'); }` |
| 13 | `memo_injection.py` | 20-36 | **`MEMO_DARK_CSS` 暗色覆盖**（`<style id="memo-dark-theme">`） | `html.memo-dark,html.memo-dark body{--text-color-primary:#DBDBDB;...}` —— 见 E 节疑似禁区 |
| 14 | `memo_injection.py` | 40 | 父页 notebook 探测 | `function parentNotebook(){try{return window.parent!==window&&window.parent.document.body.classList.contains("notebook-mode")}catch(e){return false}}` |
| 15 | `memo_injection.py` | 55 | 主题分流依据 | `function parentStyle(){...parent.document.body.classList.contains("notebook-mode")?"notebook":"standard"...}` |
| 16 | `memo_injection.py` | 61-62 | **notebook 字体加载** | `var fonts=document.getElementById("memo-notebook-fonts"); if(mode==="notebook"){addCss("memo-notebook-fonts","/css/fonts.css?v="+VERSION)}else if(fonts){fonts.remove()}` |
| 17 | `js/dashboard-core.js` | 13 | 图表配置（手账日记图表） | `diary: { icon: '📔', title: 'Anon的笔记本', color: '#d4576b', toolbar: null }` |
| 18 | `js/dashboard-core.js` | 52-56, 60 | 主题/暗色逻辑 | `const notebook = !!(window.MemoUIStyle && window.MemoUIStyle.isNotebook); ... button.hidden = notebook;` / `if (window.MemoUIStyle && window.MemoUIStyle.isNotebook) { document.body.classList.remove('dark'); ... return; }` |
| 19 | `js/charts.js` | 1083-1085 | `diary` 渲染分支 | `case 'diary': chart = (window.DiaryChart ? DiaryChart.render(containerId, options) : null); break;` |
| 20 | `js/study-web.js` | 225-227 | iframe 暗色同步（notebook 判定） | `var notebook = !!(window.MemoUIStyle && window.MemoUIStyle.isNotebook) \|\| document.body.classList.contains('notebook-mode'); idoc.documentElement.classList.toggle('memo-dark', !notebook && ...)` |
| 21 | `js/app.js` | 190-191 | 风格下拉初始化 | `const uiStyleSelect = document.getElementById('uiStyleSelect'); if (uiStyleSelect) uiStyleSelect.value = window.MemoUIStyle.name;` |
| 22 | `js/app.js` | 451, 462-466 | **主题切换跳转分支** | `const nextStyle = uiStyleSelect ? uiStyleSelect.value : window.MemoUIStyle.name;` … `window.MemoUIStyle.save(nextStyle); location.replace('index.html'); return;` |
| 23 | `js/app.js` | 42-43, 480 | 陪伴模式生命周期 | `if (typeof Live2DCompanion !== 'undefined' && Live2DCompanion.isOpen()) Live2DCompanion.exit();` / `document.getElementById('companionStudy'),` |
| 24 | `css/live2d-companion.css` | 88-100 | `.notebook-mode` 手账覆盖 | `.notebook-mode .companion-study { background:#fffdf8; background-image: linear-gradient(...22px 22px); }` |
| 25 | `css/companion-progress.css` | 150-228 | `.notebook` 主题覆盖段 | `.notebook-theme .companion-progress, body[data-ui-style="notebook"] .companion-progress, .notebook-mode .companion-progress, [data-ui-style="notebook"] .companion-progress { ... }` |
| 26 | `css/companion-settlement.css` | 237-348 | `.notebook` 主题覆盖段 | `.notebook-theme .companion-settlement__panel, body[data-ui-style="notebook"] ... { background: var(--memo-paper, #fffdf9); }` |
| 27 | `css/article-vocab.css` | 319-348 | `.notebook` 主题覆盖段 | `.notebook-theme .article-vocab, body[data-ui-style="notebook"] .article-vocab { ... font-family: var(--notebook-font, inherit); }` |
| 28 | `css/style.css` | 2-17 | **`:root` 变量值（受限）** | 见 D-2：`--accent-blue`/`--radius`/`--radius-sm`/`--shadow-sm/md/lg` 与 `style-anon.css` **重叠 6 个**，被禁区 CSS 读取 |
| 29 | `css/style.css` | 1121-1130 | `body.dark` 变量块 | `body.dark { --bg-color:#0f172a; --card-bg:#1e293b; ... }` —— 变量名与禁区 CSS 读取的同一组，**不得改值** |

### B-附. Git 状态提醒

`git status --short` 显示 `index.html`、`js/ui-style.js`、`js/live2d-companion.js`、`js/study-web.js`、`js/app.js`、`js/dashboard-core.js`、`js/charts.js`、`server.py` **均已处于 modified 状态**（前一任务遗留，`docs/redesign/git-before.txt` 已留存基线）。
→ 后续子智能体改动这些文件时，**不可用 `git checkout` / `git restore` 回滚**，会连带丢弃前一任务成果。

---

## C. 禁区素材清单

| # | 路径 | 类型 | 大小 | 判定依据 |
|---|---|---|---|---|
| 1 | `img/gifs/anon-b.gif` | GIF | 1,504,349 B | R2 千早爱音 |
| 2 | `img/gifs/anon-cry.gif` | GIF | 1,353,940 B | R2 千早爱音 |
| 3 | `img/gifs/anon-cry2.gif` | GIF | 1,641,529 B | R2 千早爱音 |
| 4 | `img/gifs/anon-surrender.gif` | GIF | 1,212,200 B | R2 千早爱音 |
| 5 | `img/gifs/anon-think.gif` | GIF | 1,808,573 B | R2 千早爱音（**同时被禁区外的 `index.html:203` 陪伴备用图引用**） |
| 6 | `img/gifs/soyo-bighead.gif` | GIF | 1,465,503 B | R2 长崎爽世 |
| 7 | `img/gifs/soyo-mad.gif` | GIF | 1,368,294 B | R2 长崎爽世 |
| 8 | `img/gifs/soyo-scene.gif` | GIF | 1,780,980 B | R2 长崎爽世 |
| 9 | `img/gifs/soyo-shy.gif` | GIF | 1,446,608 B | R2 长崎爽世 |
| 10 | `img/gifs/taki-daze.gif` | GIF | 1,255,152 B | R2 椎名立希 |
| 11 | `img/gifs/tomori-c.gif` | GIF | 1,192,323 B | R2 高松灯 |
| 12 | `img/gifs/tomori-pat.gif` | GIF | 1,116,880 B | R2 高松灯 |
| 13 | `img/gifs/tomori-sleep.gif` | GIF | 762,287 B | R2 高松灯 |
| 14 | `img/gifs/rana-sleep.gif` | GIF | 743,465 B | R2 要乐奈 |
| 15 | `img/gifs/sakiko-pinch.gif` | GIF | 1,285,836 B | R2 丰川祥子 |
| 16 | `img/gifs/sakiko-shout.gif` | GIF | 1,373,969 B | R2 丰川祥子 |
| 17 | `img/gifs/sakiko-work.gif` | GIF | 1,153,001 B | R2 丰川祥子 |
| 18 | `img/gifs/umiri-e.gif` | GIF | 1,244,246 B | R2 三角初华（Ave Mujica） |
| 19 | `img/gifs/umiri-happy.gif` | GIF | 1,353,934 B | R2 三角初华 |
| 20 | `img/gifs/nyamu-shout.gif` | GIF | 1,196,315 B | R2 若叶睦（Ave Mujica） |
| 21 | `img/gifs/mutsumi-cucumber.gif` | GIF | 1,454,290 B | R2 若叶睦 |
| 22 | `img/gifs/uika-tea.gif` | GIF | 1,441,062 B | R2 三角初华 |
| | **小计** | | **22 文件 / 27.8 MB** | |
| 23 | `fonts/*.woff2`（985 文件） | 字体 | 20.98 MB | R3 手写/圆体字体；规则 5；manifest 校验 |
| 24 | `data/live2d/models/bestdori-037_birthday_2024_ssr-fb4e0843b7ac/**` | Live2D 模型 + 配置 | 76 文件 / 2.41 MB | R2/R5：`character_id=037`=千早愛音 |
| 25 | `data/tts_pack/roles/anon/gpt.ckpt` | GPT-SoVITS 模型 | 155,312,438 B | R2 角色语音 |
| 26 | `data/tts_pack/roles/anon/sovits.pth` | SoVITS 模型 | 87,084,285 B | R2 角色语音 |
| 27 | `data/tts_pack/roles/anon/reference.wav` | 参考音频 | 266,924 B | R2 角色语音 |
| 28 | `data/tts_pack/roles/anon/persona.json` | 人设 | 424 B | R2 角色人设 |
| 29 | `data/tts_pack/roles/sakiko/**` | 角色语音包 | 见目录 | R2 丰川祥子（`tts.py:916` `{"role_id":"sakiko","name":"丰川祥子"}`） |
| 30 | `vendor/live2d/*.js` | 渲染库 | 926,433 B | R5 陪伴模式依赖；第三方只读 |
| 31 | `img/icon.png` / `icon.ico` / `icon-32.png` / `icon-180.png` | 应用图标 | 2,130,678 / 213,515 / 3,217 / 77,350 B | **R6 疑似**：内容未逐一验证是否为角色立绘，见 E 节 |

---

## D. 可编辑白名单

> "可以编辑"= 改动**不会**影响爱音系主题。凡涉及共享变量/选择器仍需遵守 B 节。

| # | 文件或片段 | 为什么可以编辑（证据） |
|---|---|---|
| 1 | `css/maimemo-standard.css`（全文 52 行） | **仅主主题加载**：`memo_injection.py:60` 只在 `mode==="standard"` 时 `addCss(...,"/css/maimemo-standard.css")`；文件内 25 条选择器**全部** `html.memo-standard` 前缀（实测"非 `html.memo-standard` 开头选择器"命中数 = **0**）。`html.memo-standard` 与 `html.memo-notebook` 互斥（`memo_injection.py:59` 两个 class 各自 toggle） → 天然不命中手账 |
| 2 | `css/study-web-standard.css`（全文 75 行） | 全部规则以 `body.standard-mode` / `body.dark.standard-mode` 开头；`grep notebook\|anon\|愛音\|爱音\|diary\|data-notebook` **零命中**。`standard-mode` 仅在非 notebook 时添加（`ui-style.js:52`） |
| 3 | `css/style.css` **布局与组件样式**（第 19-1119 行、第 1131-1463 行） | `grep notebook\|data-notebook\|anon\|Anon\|standard-mode\|data-ui-style\|memo-` **零命中**；该文件只在 standard 分支加载（`ui-style.js:36`）。**但第 2-17 行 `:root` 与第 1121-1130 行 `body.dark` 变量块受限**（见 B-28/29） |
| 4 | `css/ai-toolbar.css`（144 行） | `grep notebook\|standard\|:root` **零命中**；纯布局 + `font-family:inherit` |
| 5 | `css/drag.css`（68 行） | 仅读 `var(--accent-blue)`/`var(--shadow-sm)`/`var(--shadow-md)`（第 34/36/67 行）——**读变量但不定义**，改选择器安全，改这两个变量值不安全 |
| 6 | `css/study-web.css`（194 行） | 第 1 行自述"公共结构（不包含普通版或 Anon 的笔记本版视觉素材）"；无 notebook 选择器 |
| 7 | `js/ui-style.js` **standard 分支（第 35-47 行）** | 规则 7 只禁止改 notebook 分支；standard 分支是主主题专属加载点，**新增主主题 CSS 只能加在这里** |
| 8 | `index.html` **主主题 DOM**（`.topbar`、`#dashboard` 四个 `.tile`、`#settingsPanel`、`#fullscreenModal`、`#appUpdateModal`、`#welcomeOverlay` 的非手账部分） | 均无 `data-notebook-only` / 陪伴前缀。注意第 18/41/59 行的 `data-standard-only` 元素**属于主主题**，但它们是 `ui-style.js:63-65` 的显隐钩子，删改会破坏 notebook 的隐藏逻辑 |
| 9 | `js/charts.js` 配色分支（第 24-31 行 `heatmapPalettes`、第 240-300 行主题色） | 纯数据结构，无角色名；`localStorage['heatmap_palette']`（第 32 行）两套主题共用但值与手账配色无耦合 |
| 10 | `js/layout.js`（725 行） | `grep notebook\|standard\|Anon` 仅 2 处**注释**（第 52、468 行），无行为分支 |
| 11 | 新增的主主题专属 CSS 文件（建议 `css/style-standard-*.css`） | 需在 `ui-style.js:47` 之前插入 `css(...)` 调用，且 **link id 必须全新**（见 H-2） |
| 12 | 主主题图表注入配色 | 规则允许"图表可新增主主题配色分支"，`charts.js` 的 `case` 分发（第 1050-1086 行）除 `diary`(1083) 外均可扩展 |

---

## E. 疑似禁区清单（宁可多写，不可漏写）

| # | 文件/片段 | 不确定的原因 | 建议如何处理 |
|---|---|---|---|
| 1 | `css/companion-progress.css`（266 行） | 组件本身是通用进度条（无角色名），但第 150-228 行是 `.notebook` 覆盖段；且第 7-11 行 `:root` 定义了新变量（违反"新变量只定义在 MAIN_SCOPE 下"的既有先例）。实际消费方是陪伴会话（禁区） | **整文件按禁区处理**。若主主题确需进度条，新建独立文件+独立类名 |
| 2 | `css/companion-settlement.css`（383 行） | 同上；第 237-348 行 `.notebook` 段；第 6-22 行 `:root` | 同上，整文件禁区 |
| 3 | `js/companion-progress.js`（453 行） | 通篇无角色名/无 notebook 分支（`grep anon\|Anon\|gif\|千早` **零命中**），是纯 UMD 渲染器。**但**它唯一的消费场景是陪伴模式 | 证据上"不属禁区"，但按 R6（无法 100% 确认无关）→ **按禁区处理** |
| 4 | `js/companion-settlement.js`（601 行） | 第 156-157 行硬编码 `src="img/gifs/anon-think.gif"` → **确定属禁区** | 至少第 156-157 行禁区；整文件建议一并禁改 |
| 5 | `css/article-vocab.css`（423 行） | 第 319-348 行 `.notebook` 覆盖段；第 7-10 行 `:root` 新变量 | 第 319-348 行**确定禁区**；其余可编辑 |
| 6 | `memo_injection.py` 的 `MEMO_DARK_CSS`（第 20-36 行） | `<style id="memo-dark-theme">` 用 `html.memo-dark` 前缀，**不带 `memo-standard`/`memo-notebook` 限定**，理论上是两主题共享。**但** `MEMO_DARK_JS:41` `dark=!parentNotebook()&&...` + `ui-style.js:55` notebook 强制去 dark → 当前 notebook 永不为 dark，故实际只影响主主题 | 判定为**主主题可扩展但需验证**：改前必须确认 `parentNotebook()` 分支不被破坏。建议**不改**，主主题暗色另开 `<style id="memo-standard-dark">` 由 standard 分支加载 |
| 7 | `css/style.css` 第 2-17 行 `:root` | 6 个变量与 `style-anon.css` 重叠（实测 `Compare-Object` 交集：`--accent-blue`、`--radius`、`--radius-sm`、`--shadow-sm`、`--shadow-md`、`--shadow-lg`）；且禁区 CSS 大量读取 `--bg-color`/`--card-bg`/`--text-primary`/`--border-color`（`live2d-companion.css` 38 处 `var(--…)`） | **值一律不改**（规则 6）。主主题新变量另定义在 `html[data-ui-style="standard"]` 下 |
| 8 | `css/style.css` 第 1121-1130 行 `body.dark` | 同组变量名的暗色值，同被禁区 CSS 读取 | 不改值 |
| 9 | `img/icon.png`（2.13 MB）、`icon.ico`、`icon-32.png`、`icon-180.png` | 内容未做图像识别。`index.html:4-5` favicon 引用两套主题共用 | 按 R6 **按禁区处理**；主主题需要新图标请**新增**文件 |
| 10 | `vendor/echarts.min.js` + 3 个 LICENSE/NOTICE | 第三方只读；`test_regression.py:64-68` 断言许可文件存在 | 只读，不碰 |
| 11 | `tests/font-gif-manifest.sha256`、`tests/quality_coverage.csv`、`docs/quality-coverage.csv` | 规则 10 明令禁改。注意 `tests/test_regression.py:17` 硬断言 `assertEqual(1006, len(lines))` → **不能向 manifest 追加行**（追加即失败） | 只读。若主主题新增字体，**不注册进 manifest**（新增文件不受校验，但也不受保护） |
| 12 | `js/study-event-bridge.js`（15 KB） | `grep Companion\|progress\|settlement` 零命中，看似无关；但名为事件桥，可能承载陪伴事件 | 先读后判；暂按**可编辑但需复核** |
| 13 | `js/study-content-editor.js` 第 380-386 行、`js/study-shortcuts.js` 第 111-141 行 | 直接操作 `iframe.contentDocument` / `contentWindow`。功能上属主主题，但若主主题改墨墨注入时机，这两处 MutationObserver（`attributeFilter:['class','style']`）会受影响 | 可编辑，但**改注入必须先评估这两处观察者** |
| 14 | `server.py` 第 106-108 行 import、第 302-317 行注入装配、第 328-329 行 `Clear-Site-Data` | 注入入口本身是共享的；`MEMO_DARK_CSS` 也在同一行拼接串里 | 第 312-316 行**改则四主题全受影响**。若要新增主主题注入常量，应**追加**常量并在同一行拼接，但需用户批准（见 H） |
| 15 | `data/live2d/catalog-cache.json`（Bestdori 全角色目录，含 `千早 愛音`） | 是下载目录缓存，含全部 BanG Dream 角色；`live2d_service.py:510-532` 写入 | 只读。若主主题要换非爱音模型，属产品决策，不在重设计范围 |

**合计：15 项。**

---

## F. MAIN_SCOPE（主主题作用域选择器）

### F-1 外壳（仪表盘页面）

```css
html[data-ui-style="standard"]
```

**证据链**：
- `js/ui-style.js:9` → `var value = 'standard';`（默认值，**主主题是默认主题**）
- `js/ui-style.js:12` → 仅当 `localStorage['memo_ui_style'] === 'notebook'` 时改为 `'notebook'`
- `js/ui-style.js:16` → `document.documentElement.setAttribute('data-ui-style', value);`
- 全仓库 `grep data-theme` → **零命中**（`js/`、`css/`、`index.html`、`pages/` 均无）
  → **【复核修正】任务书假设的 `data-theme` 属性不存在，必须改用 `data-ui-style`。**

**是否命中爱音系主题？不会，且是"失败时闭嘴"的安全方向：**

| 情形 | `data-ui-style` 值 | `html[data-ui-style="standard"]` | 结果 |
|---|---|---|---|
| 默认启动 | `"standard"` | ✅ 命中 | 主主题生效 |
| 手账模式 | `"notebook"` | ❌ 不命中 | 手账零污染 |
| `ui-style.js` 未加载/JS 报错 | 属性**不存在** | ❌ 不命中 | **样式不生效，但绝不泄漏到手账** |

→ 缺失属性时"两边都不命中"，因此 `html[data-ui-style="standard"]` **不可能**串到爱音系主题。这是安全的。

**⚠️ 必须禁止的反面写法**：
```css
html:not([data-ui-style="notebook"]) .btn {}   /* ❌ 危险 */
```
属性缺失时 `:not()` 为真 → 会命中手账模式 → **泄漏**。**绝对禁止**。

### F-2 body 级辅助钩子

`js/ui-style.js:51-52` 同时给 `body` 加类：
```css
body.standard-mode    /* 主主题 */
body.notebook-mode    /* 手账（禁区） */
```
`body.standard-mode` 与 `html[data-ui-style="standard"]` 等价安全，可作简写；但**推荐统一用 `html[data-ui-style="standard"]`**，因为它在 `<head>` 内即已就绪（`ui-style.js` 在 `<head>` 执行），早于 `body` 渲染，无 FOUC。

### F-3 墨墨学习界面（iframe 内）

```css
html.memo-standard
```
**证据链**：`memo_injection.py:59` → `root.classList.toggle("memo-standard",mode==="standard");`，与 `memo-notebook` 互斥。

**组合（暗色）**：`html.memo-standard.memo-dark`（已有先例，`css/maimemo-standard.css:23-26、43-44`）

### F-4 MAIN_SCOPE 汇总

| 作用域 | 选择器 | 覆盖范围 |
|---|---|---|
| 外壳主作用域 | `html[data-ui-style="standard"]` | 仪表盘全部 DOM |
| 外壳 body 简写 | `body.standard-mode` | 同上（安全性相同） |
| 墨墨 iframe | `html.memo-standard` | 学习页 SPA |
| 墨墨 iframe 暗色 | `html.memo-standard.memo-dark` | 同上 |
| **禁区根容器（必须排除）** | `#companionStudy.companion-study`、`body.companion-mode` | 陪伴模式整体 |

---

## G. 墨墨注入机制说明

### G-1 注入入口与完整调用链

**不是 JS 运行时注入，是 Python 侧字符串拼接。**

```
浏览器 GET /memo-tc/webstudy/app
  └─ server.py:571  resolve_web_route(path, query, method)        # memo_proxy.py:27-44
       └─ memo_proxy.py:39-42  判定 inject=True
            （prefix '/memo-tc/' 且 sub 以 'webstudy/app' 开头 且末段不含 '.'）
  └─ server.py:577/582  self._web_proxy_request(target, method, inject_interceptor=True)
       └─ server.py:302   if inject_interceptor and 'text/html' in content_type
            └─ server.py:304   html = resp_body.decode('utf-8','replace')
            └─ server.py:309-310  给 script[src] / link[href] 附加 ?v=<时间戳> 破缓存
            └─ server.py:311-316  **把 6 个常量拼进 <head>**
                 html.replace('<head>', '<head>' + INTERCEPTOR_JS + MEMO_DARK_CSS
                            + MEMO_DARK_JS + MEMO_STUDY_THEME + MEMO_NAV_GUARD_JS
                            + MEMO_STUDY_KEYS_JS, 1)
            └─ server.py:317   resp_body = html.encode('utf-8')
       └─ server.py:328-329  Clear-Site-Data: "cache"
```

**注**：`server.py:311-316` 用的是 `str.replace`（字符串替换），**不是** `insertAdjacentHTML`，也**不是** `createElement('style')`。
实测 `grep insertAdjacentHTML|createElement\(['"]style` 在 `js/**` 中命中数 = **0**（唯一命中在 `tests/browser/quality-hardening.js:109` 的测试夹具）。

### G-2 六个注入常量（`memo_injection.py`）

| 常量 | 行号 | 产物 | 性质 | 是否禁区 |
|---|---|---|---|---|
| `INTERCEPTOR_JS` | 4-14 | `<script>` 改写 fetch/XHR/open/location 为代理前缀 | **功能必需** | 否，但**不该动** |
| `MEMO_DARK_CSS` | 20-36 | `<style id="memo-dark-theme">` | 样式（暗色变量覆盖） | **疑似**（E-6） |
| `MEMO_DARK_JS` | 38-48 | `<script>` toggle `html.memo-dark` | 功能 + 依赖 `parentNotebook()` | notebook 判定行（40）→ 禁区片段 |
| `MEMO_STUDY_THEME` | 50-67 | `<script>` 建 `<link>` 注入皮肤 | **主题分流核心** | 第 55、61-62 行禁区 |
| `MEMO_NAV_GUARD_JS` | 69-107 | `<script>` TTS 页返回按钮 | 功能 | 否 |
| `MEMO_STUDY_KEYS_JS` | 109-126 | `<script>` 快捷键默认值 | 功能 | 否 |

### G-3 按主题区分注入内容的位置

**唯一的主题分流点：`memo_injection.py:52-67` 的 `MEMO_STUDY_THEME`**

```js
// memo_injection.py:55
function parentStyle(){try{return window.parent!==window &&
  window.parent.document.body.classList.contains("notebook-mode")?"notebook":"standard"}
  catch(e){return "standard"}}
// :58-60
var mode=parentStyle(), root=document.documentElement;
root.classList.toggle("memo-notebook", mode==="notebook");
root.classList.toggle("memo-standard",  mode==="standard");
var skin = mode==="notebook"
  ? "/css/maimemo-notebook.css?v="+VERSION
  : "/css/maimemo-standard.css?v="+VERSION;
addCss("memo-study-skin", skin);
// :61-62
var fonts=document.getElementById("memo-notebook-fonts");
if(mode==="notebook"){addCss("memo-notebook-fonts","/css/fonts.css?v="+VERSION)}
else if(fonts){fonts.remove()}
```

**分流依据是 `parent.document.body.classList.contains("notebook-mode")`，不是 `data-ui-style`。**（`memo_injection.py:55`）

### G-4 注入元素 id 列表

| id | 元素类型 | 由谁创建 | 归属主题 |
|---|---|---|---|
| `memo-dark-theme` | `<style>` | `MEMO_DARK_CSS`（`memo_injection.py:21`） | 共享/主主题（疑似） |
| **`memo-study-skin`** | `<link rel=stylesheet>` | `addCss()`（`memo_injection.py:57`） | **按 mode 二选一** |
| `memo-notebook-fonts` | `<link rel=stylesheet>` | `addCss()`（`memo_injection.py:62`） | **手账专属（禁区）** |
| `memo-tts-exit` | `<button>` | `MEMO_NAV_GUARD_JS`（`memo_injection.py:74,92-94`） | 功能（无关主题） |

**【复核修正】任务书假设的 `memo-theme-main-inject` 在仓库中不存在**（全量 grep 零命中）。现有机制是 `memo-study-skin`。

### G-5 清理机制

**无独立清理函数，清理内嵌在 `addCss()` 里**（`memo_injection.py:56-57`）：

```js
function addCss(id,href){
  var link=document.getElementById(id);
  if(link&&link.getAttribute("href")===href)return;
  if(link)link.remove();                 // ← 唯一清理点：href 变化时先删旧
  link=document.createElement("link");
  link.id=id; link.rel="stylesheet"; link.href=href;
  document.head.appendChild(link)
}
```
- 清理粒度：**按 id**（`memo-study-skin` / `memo-notebook-fonts`）
- 触发时机：`syncMemoStudyTheme()` 调用时（页面加载一次 + `pageshow` + 父页 `class`/`data-ui-style` 变化的 `MutationObserver`，`memo_injection.py:63-65`）
- 幂等：`href` 相同则直接 return，不重复插

**`css/fonts.css` 的移除是显式的**：`memo_injection.py:62` `else if(fonts){fonts.remove()}`
→ **【复核确认】主主题墨墨界面不加载 `fonts.css`。** 这一点总负责人的判断正确，且是本报告中最有价值的证据之一：主主题在墨墨界面**不能**使用手账字体（`Noto Serif SC`/`M PLUS Rounded 1c`），因为字体文件根本没请求。若雕版风格需要衬线体，**必须新增独立字体文件并由新 link 加载**。

### G-6 iframe 相关（关键问答）

| 问题 | 答案 | 证据 |
|---|---|---|
| 注入是往 `contentDocument` 插 `<style>` 吗？ | **不是**。注入发生在**服务端响应阶段**，拼进 HTML 字符串 | `server.py:302-317` |
| 用 `insertAdjacentHTML` 还是 `createElement('style')`？ | 都不是。用 `str.replace('<head>', ...)`；客户端侧用 `createElement('link')` | `server.py:312`；`memo_injection.py:57` |
| iframe 的 `src`？ | 已登录：`/memo-tc/webstudy/app`；未登录：`/memo-tc/study/api/v1/users/auth/login?return_url=…` | `js/study-web.js:40`、`44-45` |
| 是否同源？能直接访问 `contentDocument` 吗？ | **是，同源（同 origin 代理）**，可访问。代码大量直接读写 `iframe.contentDocument` / `contentWindow` | `js/study-web.js:95,109,137,181,223,255,385,390`；`js/study-shortcuts.js:113-115`；`js/study-content-editor.js:380`；`js/study-lifecycle.js:17-19` |
| iframe sandbox | `allow-scripts allow-same-origin allow-forms allow-popups` | `js/study-web.js:51` |

### G-7 现有墨墨页面选择器清单（供后续复用，勿新造）

**结构/根节点**：
- `.taro_page.taro_page_show`、`.taro_page`、`.taro_page_shade`（`js/study-web.js:134-140`；`memo_injection.py:74-78`）
- `.rev-root`、`.rev-top`、`.rev-scroller`、`.rev-bottom`、`.rev-resp-btns`（`js/study-web.js:189-190`；`memo_injection.py:27`）
- `#taro-navigation-bar`、`.taro-navigation-bar-show`、`.taro-navigation-bar-no-icon`、`.taro-navigation-bar-back-icon`、`.taro-navigation-bar-home-icon`、`.taro-navigation-bar-back`、`.taro-navigation-bar-home`（`css/maimemo-standard.css:2-26`）
- `#taro-navigation-bar > .taro-navigation-bar-back`（`memo_injection.py:86`）

**单词/释义**：
`.phrase-spelling`、`.phrase-word`、`.rev-word`、`[data-word]`、`.phrase-title`、`.rev-root .spelling`、`.word-popup .spelling`、`.word-popup [data-spelling]`、`.memo-word-popup .spelling`、`.memo-word-popup [data-spelling]`、`.word-detail .spelling`、`.word-detail [data-word]`（`js/study-web.js:99-102`）

**弹层**：
`.memo-word-popup`、`.taro-modal__content`、`.taro-modal__inner`、`.taro-model__bd`、`.taroify-dialog`、`.taroify-popup--center`、`.taro-modal__mask`、`.taroify-dialog__header/__content/__message/__footer/__confirm`（`js/study-web.js:157-171`；`css/maimemo-standard.css`；`css/maimemo-notebook.css:369-405`）

**手账皮肤已覆盖的学习页选择器**（禁区，仅供理解，勿改）：
`.rev-top-stats`、`#rev-top-menu`、`.rev-search`、`.rev-shortcut`、`.back`、`.rev-top .spelling`、`.rev-top > .phonetic`、`.phonetic .accent`、`.interp-ctn`、`.spelling-hint`、`.rev-content-blank`、`.rev-content-header`、`.rev-content-container`、`.phrase-root`、`.phrase-phrase`、`.phrase-interpretation`、`.phrase-hl`、`.phrase-play-btn`、`.rev-recall-mask`、`.rev-recall-mask-partial`、`.verify-input`、`.ask-spelling`、`.rev-resp-btns`（`css/maimemo-notebook.css:109-356`）

**其他**：`.tts-settings`（`memo_injection.py:79`）、`.shortcut-settings`、`.word-search`、`.gp`（`memo_injection.py:97`）、`.memo-navigation-back-fallback`（`memo_injection.py:98`）

### G-8 哪些属爱音系、哪些可被主主题复用

| 项 | 归属 | 主主题可否复用 |
|---|---|---|
| `MEMO_STUDY_THEME` 的 `mode==="notebook"` 分支 + `/css/maimemo-notebook.css`（`:60`） | **爱音系禁区** | ❌ 不可改 |
| `memo-notebook-fonts` 加载/移除（`:61-62`） | **爱音系禁区** | ❌ 不可改 |
| `MEMO_STUDY_THEME` 的 `mode==="standard"` 分支 + `/css/maimemo-standard.css`（`:60`） | **主主题** | ✅ **推荐在此扩展**（改 CSS 文件本身，不改 Python） |
| `root.classList.toggle("memo-standard", …)`（`:59`） | 主主题作用域 | ✅ 复用（它就是 MAIN_SCOPE） |
| `addCss()` / `memo-study-skin`（`:56-57`） | 共享机制 | ✅ 复用（勿新造 id） |
| `INTERCEPTOR_JS` / `MEMO_NAV_GUARD_JS` / `MEMO_STUDY_KEYS_JS` | 功能，无关主题 | ⚠️ 只读，勿动 |
| `MEMO_DARK_CSS` | 疑似共享 | ⚠️ 建议不改（E-6） |

---

## H. 结论与风险

### H-1 主主题重设计能否不触碰禁区完成？

**结论：可以。但有一条硬冲突必须先解决（H-3-①），另有 2 项需用户拍板。**

理由是 MAIN_SCOPE 已天然隔离：`html[data-ui-style="standard"]` 与 `html.memo-notebook` / `html.memo-standard` 三者互斥，且外壳作用域在属性缺失时**不命中**（fails closed），不存在"改主主题污染手账"的路径。

### H-2 逐条回应总负责人的 7 点核实

| # | 总负责人结论 | 我的复核 | 证据 |
|---|---|---|---|
| 1 | `ui-style.js:16` 写在 `html` 的 `data-ui-style`，默认 `standard` | ✅ **成立**。补充：全仓库 `data-theme` 零命中 | `js/ui-style.js:9,12,16` |
| 2 | Live2D = 千早爱音 → 陪伴模式整体禁区；`live2d-companion.js`/`.css`/`companion-*` 整文件禁改 | ✅ **成立**，但需细化：`js/companion-progress.js` **无**任何角色名/notebook 痕迹（grep 零命中），纯从证据看"不属禁区"；按 R6 才归为禁区。`js/companion-settlement.js:156-157` 有硬编码 `anon-think.gif`，属**确证**。`css/companion-*.css` 含 `.notebook` 段（`progress:150-228`、`settlement:237-348`） | 见 B-24/25/26、E-1~4 |
| 3 | 注入是 Python 侧拼接；分流在 `MEMO_STUDY_THEME`；id 是 `memo-study-skin`；正确做法是改 `css/maimemo-standard.css` 而非新造 id | ✅ **完全成立**。`memo-theme-main-inject` 全量 grep 零命中 | `server.py:312-316`；`memo_injection.py:52-67` |
| 4 | `style.css` 与 `style-anon.css` 的 `:root` 重叠 6 变量 | ✅ **成立**。实测 `Compare-Object` 交集正是这 6 个：`--accent-blue`、`--radius`、`--radius-sm`、`--shadow-sm`、`--shadow-md`、`--shadow-lg` | `css/style.css:2-17` ↔ `css/style-anon.css:6-38` |
| 5 | `memo-dashboard-theme` / `memo-study-theme` 是共用 link id → 新增主主题 CSS 必须用全新 id | ✅ **成立**。`ui-style.js:29`（notebook→`style-anon.css`）与 `:36`（standard→`style.css`）同为 `'memo-dashboard-theme'`；`:30` 与 `:40` 同为 `'memo-study-theme'` | `js/ui-style.js:29,30,36,40` |
| 6 | `style.css` 与 `study-web-standard.css` grep 零命中 | ✅ **成立**（我自己重跑，pattern 含 `notebook\|data-notebook\|anon\|Anon\|standard-mode\|data-ui-style\|memo-` → 均 0） | 见 D-2、D-3 |
| 7 | `gif-icons.js` 全指角色 GIF；`diary.js` 文件头是 Anon的笔记本 → 均禁区 | ✅ **成立** | `js/gif-icons.js:3-8`；`js/diary.js:1-2,107` |

**无一条被推翻。** 仅第 2 点需要"确证 vs 按 R6 推定"的置信度区分。

### H-3 停止条件（总负责人必须停下来问用户）

#### ① 硬冲突：`css/fonts.css` 禁令 vs 雕版风格需要衬线字体

- 规则 5：**不得修改 `css/fonts.css` 及其引用的字体文件**。
- 规则 10：不得删除/改写 `tests/font-gif-manifest.sha256`。而 `tests/test_regression.py:17` **硬断言 `assertEqual(1006, len(lines))`** → manifest **不能新增行**。
- 同时 `memo_injection.py:61-62` 证明**主主题墨墨界面根本不加载 `fonts.css`**。
- 结论：`fonts.css` 里那 985 个字体（`Noto Serif SC` / `Noto Sans SC` / `M PLUS Rounded 1c`）在**主主题下既不能用（墨墨侧未加载）、也不能改（规则 5）、也不能登记（规则 10）**。
- **"构成主义 × 古典雕版排版"若依赖衬线/雕版字体，必须由用户选择下列之一：**
  - (a) 主主题只用系统字体栈（`Georgia`/`Times New Roman`/`Songti SC`）——零新增、零风险，但排版表现受限；
  - (b) 新增独立字体文件（不计入 manifest）——可行，但字体文件将不受 `font-gif-manifest` 保护，且需确认 `static_security.py:16` 允许 `fonts/{.woff2}`（已允许）；
  - (c) 放宽规则 5。

  → **这是 ①「规则 5/10」与「用户要雕版排版」之间的实质冲突，必须由用户拍板。**

#### ② 需拍板：墨墨注入是否允许改 `memo_injection.py`

- 我的推荐（与总负责人一致）：**不改 Python**，把雕版皮肤直接写进 `css/maimemo-standard.css`（该文件 52 行、25 条选择器全部 `html.memo-standard` 前缀、仅 standard 分支加载 → 整文件主主题专属）。
- 但若雕版皮肤体量超出 52 行承载能力（很可能），需决定：
  - (a) 扩写 `maimemo-standard.css`（零新增通道，但单文件膨胀）；
  - (b) 在 `MEMO_STUDY_THEME` 的 standard 分支 `addCss` 加**第二个** link（如 `memo-study-skin-standard`）——需改 `memo_injection.py:58-60`，而该文件被 `static_security.py:7`、`tests/quality_coverage.py:18`、`tests/test_regression.py:75` 引用，且 `tests/test_regression.py:83-84` 断言其特定字符串，改动有回归风险。
- → **需用户确认走 (a) 还是 (b)。** 我倾向 (a)。

#### ③ 需拍板：`js/companion-progress.js`（453 行）是否整文件禁改

- 证据上它与爱音无关（纯 UMD 进度条渲染，零角色名、零 notebook 分支）。
- 但按 R6「无法 100% 确认无关 → 按禁区处理」+ 它只服务陪伴模式。
- → **需用户确认**：若判禁区，主主题将来若需同类进度条必须另写；若判可编辑，可省一份重复实现。

### H-4 其他风险（非停止条件，但需记录）

| 风险 | 说明 | 缓解 |
|---|---|---|
| R-a 共用 link id | `memo-dashboard-theme`、`memo-study-theme` 被两主题共用（`ui-style.js:29/36`、`:30/40`）。新增主主题 CSS 若复用这两个 id，`addCss` 式去重会误删另一个主题的样式 | 新增 id 一律全新，如 `memo-standard-engraving` |
| R-b `:root` 共享变量 | 6 个变量重叠，且 `live2d-companion.css` 有 38 处 `var(--…)` 读取主主题 `:root` | 新变量只写 `html[data-ui-style="standard"]` 下；旧值不改 |
| R-c git 脏工作区 | 8 个前端文件已 modified | 禁 `git checkout/restore`；基线在 `docs/redesign/git-before.txt` |
| R-d manifest 行数硬断言 | 追加 manifest 行 → `test_regression.py:17` 失败 | 新增字体不登记 |
| R-e `data-standard-only` 是双向钩子 | `index.html:18,41,59,555` 的 `data-standard-only` 由 `ui-style.js:63-65` 控制 `hidden` | 主主题可改其样式，**不可删属性** |
| R-f `Clear-Site-Data: "cache"` | `server.py:329` 每次注入响应都清浏览器缓存 | 改动注入后需整页重载验证，缓存不可信 |
| R-g 墨墨注入 VERSION | `memo_injection.py:54` `var VERSION="20260825-unified-ui"`，用于 link 的 `?v=` | 改 CSS 内容后**必须**同步 bump，否则浏览器可能复用旧样式 |
| R-h `_verification/**` 30+ 快照 | 含 `index-anon.html` 历史副本 | 不遍历、不改 |

---

## 附录：本次测绘使用的检索命令与结果摘要

| 检索 | 范围 | 结果 |
|---|---|---|
| `anon\|chihaya\|mujica\|roselia\|poppin\|tomori\|soyo\|rana\|taki\|sakiko\|mygo\|bang` | `js/**` | 8 处命中：`gif-icons.js:3-8`、`diary.js:107`、`ui-style.js:29`、`companion-settlement.js:157`、`live2d-companion.js:1226` |
| `notebook\|diary\|journal\|handbook\|gif-icons\|data-notebook-src\|data-ui-style` | `js/**` | 41 处，分布：`ui-style.js`(19)、`companion-*.css 引用`、`dashboard-core.js`(5)、`study-web.js`(3)、`gif-icons.js`、`diary.js`(8)、`charts.js`(1) |
| `data-theme` | `js/**`、`css/**`、`index.html`、`pages/**` | **0 命中** |
| `insertAdjacentHTML\|createElement('style')\|executeScript\|ExecuteScript` | `js/**` | **0 命中**（唯一 1 处在 `tests/browser/quality-hardening.js:109`） |
| `notebook\|data-notebook\|anon\|Anon\|standard-mode\|data-ui-style\|memo-` | `css/style.css` | **0 命中** |
| `notebook\|data-notebook\|anon\|Anon\|:root\|^body \{` | `css/study-web-standard.css` | **0 命中** |
| 非 `html.memo-standard` 开头的选择器 | `css/maimemo-standard.css` | **0 行**（25/25 全部带前缀） |
| `img/gifs` | 全仓库 | 175 处；运行时代码引用仅 5 处：`index.html:19,203,556`、`gif-icons.js:3-8`、`diary.js:107`、`companion-settlement.js:157` |
| `:root` | `csv/` 共享文件 | `article-vocab.css:7`、`companion-progress.css:7`、`companion-settlement.css:6`、`style.css:2`、`style-anon.css:6` |

**Live2D 数据库侧实锤**（`data/live2d/catalog-cache.json`，`ConvertFrom-Json` 后筛选 `character_id -eq '037'`）：

```
catalog_name   : 037_birthday_2024_ssr
character_id   : 037
character_name : 千早 愛音
display_name   : 千早 愛音 · birthday_2024_ssr
```

`data/live2d/models/` 下**唯一**已安装模型即 `bestdori-037_birthday_2024_ssr-fb4e0843b7ac`（`memo-live2d.json:2` 的 `"id"` 一致）。
→ **陪伴模式唯一可见角色 = 千早愛音 → 整个陪伴模式按 R5 属禁区。**

**禁区根容器（供后续用 `:not()` 排除）**：
```css
#companionStudy.companion-study   /* index.html:194，唯一根容器 */
body.companion-mode               /* live2d-companion.js:1175 进入时添加 */
#companionLive2DHost              /* index.html:199 */
#companionBirthdayCard            /* index.html:212 */
```
