# 总负责人独立核查记录（禁区边界）

本文件是我（总负责人）在等待 SA-1 期间**亲自读代码/读数据库**确认的事实。
SA-1 的报告是权威清单，但本文件用于交叉验证——**任何一处与 SA-1 结论相反，以证据行号为准，并回到第 17 节向用户提问。**

所有结论标注证据来源：`实测` / `静态证据` / `假设`。

---

## 1. 主题机制（静态证据，`js/ui-style.js` 全文 93 行）

| 事实 | 证据 |
|---|---|
| 只有两个主题标识：`standard` / `notebook` | `ui-style.js:9,12,15` |
| 存储键 `localStorage['memo_ui_style']` | `ui-style.js:6` |
| 默认主题 = `standard` | `ui-style.js:9` `var value = 'standard'` |
| 主题标识写在 **`<html>`** 上，data 属性名 **`data-ui-style`** | `ui-style.js:16` |
| body 上另有 `standard-mode` / `notebook-mode` 类 | `ui-style.js:51-52` |
| notebook 模式强制移除 `dark` 类 | `ui-style.js:55` |
| `data-notebook-src` 惰性填装只在 notebook 分支 | `ui-style.js:68-71` |
| 自动向 `.chart-selector` 追加 `diary` 选项只在 notebook 分支 | `ui-style.js:72-78` |

### 1.1 MAIN_SCOPE

**外壳：`html[data-ui-style="standard"]`**
**墨墨 iframe 内：`html.memo-standard`**

风险：若 `ui-style.js` 未执行（脚本失败、被拦截），`data-ui-style` 属性不存在，则 `html[data-ui-style="standard"]` **不命中任何元素**——这会导致主主题样式全部失效。这是"失败即失效"而非"失败即泄漏"，方向安全，但需在 SA-8 中验证脚本正常加载时样式确实生效。

### 1.2 两套分支的加载清单（静态证据，`ui-style.js:23-47`）

**notebook 分支（`:23-34`）**：
```
css/ai-toolbar.css, css/drag.css, css/study-web.css, css/diary.css,
css/fonts.css, css/style-anon.css, css/study-web-notebook.css,
css/live2d-companion.css, css/companion-progress.css,
css/companion-settlement.css, css/article-vocab.css
```

**standard 分支（`:35-47`）**：
```
css/style.css, css/ai-toolbar.css, css/drag.css, css/study-web.css,
css/study-web-standard.css, css/live2d-companion.css,
css/companion-progress.css, css/companion-settlement.css,
css/article-vocab.css
```

**两分支共享（7 个）**：`ai-toolbar.css`、`drag.css`、`study-web.css`、`live2d-companion.css`、`companion-progress.css`、`companion-settlement.css`、`article-vocab.css`
**仅 notebook**：`diary.css`、`fonts.css`、`style-anon.css`、`study-web-notebook.css`
**仅 standard**：`style.css`、`study-web-standard.css`

---

## 2. `:root` 变量交叉污染分析（实测，脚本对比两个 `:root` 块）

`css/style.css:2` 的 `:root` 定义 14 个变量；`css/style-anon.css:6` 的 `:root` 定义 28 个。

**两者重叠的 6 个变量（严禁修改，改一个就会同时影响两套主题）：**
```
--accent-blue  --radius  --radius-sm  --shadow-lg  --shadow-md  --shadow-sm
```
注：`style-anon.css:26` 明确注释 `--accent-blue: #1890ff;   /* drag.css 依赖 */` —— 证明共享变量是刻意为之。

**结论：主主题新变量绝不能放进 `:root`，也不能复用上述 6 个名字。必须全部放在 `html[data-ui-style="standard"]` 作用域下，并使用不冲突的新前缀。**

---

## 3. Live2D 陪伴模式 = 整个禁区（实测，只读查询真实库）

`data/memo-superform.db`（`?mode=ro` 只读打开）：

```
live2d_models（仅 1 条）:
  model_id      bestdori-037_birthday_2024_ssr-fb4e0843b7ac
  source        bestdori-jp
  character_id  037
  display_name  千早 愛音 · birthday_2024_ssr
  catalog_name  037_birthday_2024_ssr
  model_format  cubism2
  byte_size     2527781

live2d_preferences（2 条，profile 1 / 19）:
  active_model_id 均 = bestdori-037_birthday_2024_ssr-fb4e0843b7ac
  companion_enabled = 1
```

**按第 1 节识别规则："如果 Live2D 陪伴模式展示的是千早爱音或 BanG Dream 成员，陪伴模式的进入、退出、渲染、布局、对话气泡、口型、触摸、提示文本等全部代码和样式都属于禁区。"**

→ **陪伴模式整体禁改**，包括：
- `js/live2d-companion.js`（80,020 B）
- `css/live2d-companion.css`（13,564 B）
- `js/companion-progress.js`（20,273 B）、`js/companion-settlement.js`（27,612 B）
- `css/companion-progress.css`（8,281 B）、`css/companion-settlement.css`（11,708 B）
- `vendor/live2d/` 全部库文件与许可证
- 模型资源本身

且**主主题下的陪伴模式截图必须零差异**。

---

## 4. 墨墨学习界面注入机制（静态证据，`memo_injection.py` 全文 126 行）

### 4.1 注入方式（关键：不是 JS 运行时注入）

**Python 侧字符串拼接**。`server.py:312-316`：
```python
html = html.replace('<head>', '<head>' + INTERCEPTOR_JS + MEMO_DARK_CSS
                    + MEMO_DARK_JS + MEMO_STUDY_THEME + MEMO_NAV_GUARD_JS
                    + MEMO_STUDY_KEYS_JS, 1)
```
即把 5 个常量串接进墨墨页面 HTML 的 `<head>`。**没有 `contentDocument` 操作，没有 `createElement('style')`，没有 MutationObserver 之外的通道。**

### 4.2 五个常量的职责

| 常量 | 性质 | 可否改动 |
|---|---|---|
| `INTERCEPTOR_JS` | 改写 fetch/XHR/open/location 的 URL 前缀 → 走本地反向代理 | **功能必需，禁改** |
| `MEMO_DARK_CSS` | `<style id="memo-dark-theme">`，前缀 `html.memo-dark`，两套主题共用 | 共用，禁改 |
| `MEMO_DARK_JS` | 切 `html.memo-dark` 类 | 功能，禁改 |
| `MEMO_STUDY_THEME` | **主题分流点** | **主主题样式在此分支内扩展** |
| `MEMO_NAV_GUARD_JS` | TTS 页返回按钮 | 功能，禁改 |
| `MEMO_STUDY_KEYS_JS` | 快捷键 | 功能，禁改 |

### 4.3 主题分流的确切实现（`memo_injection.py:52-67`）

```js
function parentStyle(){
  return window.parent!==window &&
         window.parent.document.body.classList.contains("notebook-mode")
         ? "notebook" : "standard"
}
function syncMemoStudyTheme(){
  var mode = parentStyle(), root = document.documentElement;
  root.classList.toggle("memo-notebook", mode==="notebook");
  root.classList.toggle("memo-standard",  mode==="standard");
  var skin = mode==="notebook" ? "/css/maimemo-notebook.css?v="+VERSION
                               : "/css/maimemo-standard.css?v="+VERSION;
  addCss("memo-study-skin", skin);
  var fonts = document.getElementById("memo-notebook-fonts");
  if(mode==="notebook"){ addCss("memo-notebook-fonts","/css/fonts.css?v="+VERSION) }
  else if(fonts){ fonts.remove() }
}
```

**核实到的关键事实：**
1. 分流依据是 **`parent.document.body.classList.contains("notebook-mode")`**，**不是** `data-ui-style`。
2. iframe 内的主题类名是 **`html.memo-standard` / `html.memo-notebook`**。
3. 注入样式表的元素 id 是 **`memo-study-skin`**（**不是**任务书 §10 假设的 `memo-theme-main-inject`）。
4. `addCss()` 自身实现"同 id 先删后建"，**天然幂等，不会重复注入**。
5. **主主题分支不加载 `css/fonts.css`**（`else if(fonts){fonts.remove()}`），因此主主题的墨墨界面**不能用笔记本字体**。
6. 有 `MutationObserver` 监听父页 body 的 `class` 与 `data-ui-style` 变化 → 切换主题会自动重新分流。
7. 有 `pageshow` 监听。

### 4.4 由 4.3 得出的实现结论

任务书 §10 要求"注入 style 元素使用固定 id `memo-theme-main-inject`"。**这与现有机制冲突**：现有机制已有一个幂等、且已被清理逻辑管理的 id（`memo-study-skin`）。

按第 3 节「必须复用项目已有注入机制，不得新增新的脚本注入通道」与「不应新增 MutationObserver/定时器/轮询」，**正确做法是改写 `css/maimemo-standard.css` 本身**（它是主主题专属、作用域 `html.memo-standard` 天然不命中 notebook），而不是新造一个注入 id。

这样：
- 零新增注入通道
- 零新增清理逻辑
- 切换主题时 `addCss()` 自动换皮肤，notebook 永远看不到主主题样式
- 完全满足"不得泄漏到爱音系主题"

**待与 SA-1 交叉确认后定稿。**

---

## 5. 禁区文件清单（我的独立判定）

### 5.1 整文件禁改（确认）

| 文件 | 依据 |
|---|---|
| `index-anon.html` | 全文仅用于设 `memo_ui_style=notebook` 并跳转（实测 16 行；`:11` `localStorage.setItem('memo_ui_style','notebook')`） |
| `css/style-anon.css` | 手账主题主样式（30,926 B），`:root` 含 `--rose/--paper` 等专属量 |
| `css/diary.css` | 手账专属（8,157 B） |
| `css/study-web-notebook.css` | 手账 iframe 皮肤（8,742 B） |
| `css/maimemo-notebook.css` | 手账墨墨注入样式（24,741 B） |
| `css/fonts.css` | 984 个 `@font-face`，954,155 B，受 `tests/font-gif-manifest.sha256` 校验 |
| `css/live2d-companion.css` | 陪伴模式 = 千早爱音（见第 3 节） |
| `css/companion-progress.css` | 陪伴模式 |
| `css/companion-settlement.css` | 陪伴模式 |
| `js/live2d-companion.js` | 陪伴模式 |
| `js/companion-progress.js` | 陪伴模式 |
| `js/companion-settlement.js` | 陪伴模式 |
| `js/diary.js` | 手账图表（实测文件头注释即"Anon的笔记本 · Memory Diary"） |
| `js/gif-icons.js` | 实测 `MAP` 全部指向 `img/gifs/<角色>.gif`（anon/soyo/taki/nyamu/umiri） |
| `img/gifs/**` | 22 个 GIF，全部 BanG Dream 角色，全部在 manifest 中 |
| `fonts/**` | 984 个 woff2，受 manifest 校验 |
| `vendor/live2d/**` | Live2D 库（陪伴模式依赖） |
| `tests/font-gif-manifest.sha256` | 禁区素材校验文件（1,006 行） |

### 5.2 共享文件（需按片段判断）

| 文件 | 判定 |
|---|---|
| `js/ui-style.js` | 共享；**只允许在 `:35-47` standard 分支内新增加载行**，`:23-34` notebook 分支逐字不动 |
| `memo_injection.py` | 共享；`MEMO_STUDY_THEME` 内 `notebook` 路径不得改动 |
| `js/study-web.js` | 共享；`syncIframeTheme()`（`:221-230`）有 notebook 判断 |
| `css/ai-toolbar.css` `css/drag.css` `css/study-web.css` | 两分支共享，需逐行核查 |
| `css/article-vocab.css` | 两分支共享，且 `:root` 定义 `--article-vocab-gap/radius`（`:7-9`）——**上一轮任务新建，属共享** |

### 5.3 可改写（主主题专属，零跨主题引用 — 实测无命中）

| 文件 | 核查结果 |
|---|---|
| `css/style.css`（32,995 B） | grep `notebook|anon|Anon|愛音|爱音|diary|data-notebook` → **零命中** |
| `css/study-web-standard.css`（5,297 B） | 同上 → **零命中**；且无 `font-family` 声明 |
| `css/maimemo-standard.css`（4,558 B） | 全文前缀 `html.memo-standard`，局部 `html.memo-standard.memo-dark` |

### 5.4 `img/` 根目录（共享，非角色素材）

`img/icon.png`（2,130,678 B）、`img/icon.ico`、`img/icon-32.png`、`img/icon-180.png` —— 应用图标/favicon，服务两套主题，**只读**。

---

## 6. 主主题字体现状（实测）

- `css/style.css:28` 用系统栈：`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif`
- `css/style.css:1050` 用 `'Consolas','Monaco',monospace`
- `css/study-web-standard.css` 无任何 `font-family`
- **主主题完全不引用 `css/fonts.css` 声明的家族**

→ 按第 6.3 节「如果某个已声明家族只被爱音系主题使用，且主主题当前没有加载它，不得为主主题新增对它的加载，改用系统字体」，**主主题的衬线字体只能用系统自带**（如 `SimSun`/`Songti SC`/`Noto Serif SC` 若系统有），不新增字体文件、不新增加载。

---

## 7. 真实浏览器验证（实测，Edge + Playwright，1280×800）

只改 `localStorage['memo_ui_style']` 即可切换主题，两套主题可完全自动化截图对比。

| 观测项 | standard | notebook |
|---|---|---|
| `html[data-ui-style]` | `standard` | `notebook` |
| `html` class | `""`（空） | `""`（空） |
| `body` class | `standard-mode` | `notebook-mode` |
| `title` | `Memo Superform - 墨墨数据磁贴` | `Memo Superform · Anon的笔记本` |
| `html[data-ui-style="standard"]` 命中数 | **1** | **0** |
| `html[data-ui-style="notebook"]` 命中数 | **0** | **1** |
| body 背景色 | `rgb(240,242,245)` | `rgb(246,239,233)` |
| 磁贴数 | 4 | 4 |
| topbar 存在 | 是 | 是 |

**→ MAIN_SCOPE = `html[data-ui-style="standard"]` 隔离性成立（双向验证）。**

### 7.1 一个必须注意的陷阱：`memo-dashboard-theme` 这个 id 被两套主题共用

从实测的 link 列表可见，`css()` 的 id 参数在两套分支间**复用**：

| link id | standard 分支指向 | notebook 分支指向 |
|---|---|---|
| `memo-dashboard-theme` | `css/style.css` | **`css/style-anon.css`** |
| `memo-study-theme` | `css/study-web-standard.css` | **`css/study-web-notebook.css`** |

**含义：** 不能用 "link id" 来判断当前主题，也不能假设一个 id 只对应一个文件。
但反过来说——**这正好是我需要的行为**：新增的主主题 CSS 若用 `css(path, 'memo-dashboard-theme')` 会**覆盖**加载顺序，风险极大。
**正确做法：新增主主题 CSS 必须用全新的 link id**（例如 `memo-constructivist-tokens`），
且只写在 `:35-47` 的 standard 分支内，notebook 分支一个字符都不加。

### 7.2 主主题暗色模式（实测 + 静态证据）

- `js/dashboard-core.js:55`：`document.body.classList.toggle('dark', !notebook && saved === 'dark')`
  → **notebook 分支永远不会带 `dark` 类**，`ui-style.js:55` 还会主动 `remove('dark')`。
- `css/style.css` 有 44 条 `body.dark` 规则，`:1121` 处 `body.dark` 重定义变量。
- `css/charts.js:240` `getThemeColors()` 依赖 `body.classList.contains('dark')`。

**结论：主主题确有暗色模式 → 按第 6.2 节，必须实现暗色令牌。**
暗色令牌作用域应为 `html[data-ui-style="standard"] body.dark`，与现有 `body.dark` 机制叠加而非替代。

**风险点：** `css/style.css:1127-1129` 的 `body.dark` 重定义了 `--shadow-sm/md/lg`，
而这 3 个变量**与 `style-anon.css` 共享**。虽然 notebook 不会带 `dark` 类所以实际不会泄漏，
但**我仍然不得改动这三行**，只能新增自己的变量。

---

## 8. 给后续子智能体的约束摘要

1. 所有新增外壳 CSS 规则前缀必须是 `html[data-ui-style="standard"]`。
2. 所有新增墨墨注入样式前缀必须是 `html.memo-standard`，写进 `css/maimemo-standard.css`。
3. 不得新增 `:root` 变量；不得碰那 6 个共享变量。
4. 不得写裸选择器（`button{}`、`body{}`、`*{}`、`:root{}`）。
5. 陪伴模式相关文件一律不碰，且其截图必须零差异。
6. 不得动 `css/fonts.css`、`fonts/**`、`img/gifs/**`、`tests/font-gif-manifest.sha256`。
7. `js/ui-style.js` 只允许在 standard 分支内新增加载行。