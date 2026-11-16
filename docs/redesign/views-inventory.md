# 可截图视图清单（实测）

记录时间：2026-11-16
方法：`tests/redesign/probe_controls.js`、`tests/redesign/probe_views.js`（Edge + Playwright，1440×900，standard 主题）
**全部条目均为实测，非推测。**

---

## 1. 顶栏控件（全部可见可点击）

| 选择器 | title | 用途 |
|---|---|---|
| `.layout-btn` ×4（index 0 带 `active`） | 单格 / 左右分屏 / 三分屏 / 田字格 | 布局切换 |
| `#themeBtn.icon-btn` | 切换明暗主题 | 暗色模式 |
| `#refreshBtn.icon-btn` | 刷新数据 | — |
| `#settingsBtn.icon-btn` | 设置 | 设置面板 |
| `#companionModeBtn.companion-mode-btn` | 左侧背词、右侧 Live2D 陪伴 | **禁区**（千早爱音模型） |
| `#autoRefreshToggle.active` | 自动刷新开关 | — |
| `#autoRefreshInterval` (SELECT) | 刷新间隔 | — |
| `#articleVocabBtn.article-vocab-btn` | 粘贴文章自动精选词汇 | 上一任务功能 |

---

## 2. 图表选项渲染实测（`.chart-selector`）

驱动方式：`selectOption(value)` + `dispatchEvent('change')` —— 真实用户路径。

| value | 渲染结果 | ECharts 实例 | 新错误 |
|---|---|---|---|
| `heatmap` | canvas 1408×710 | 有 | 0 |
| `trend` | canvas 1408×714 | 有 | 0 |
| `memory` | canvas 1408×755 | 有 | 0 |
| `aiclass` | canvas 1408×642 | 有 | 0 |
| `notepad` | canvas 1408×755 | 有 | 0 |
| `growth` | canvas 1408×755 | 有 | 0 |
| `recommend` | **无 canvas**，文本 45 字符 | 无 | 0 |
| `study-web` | iframe（见第 4 节） | — | 0 |

`recommend` 渲染为文本列表而非图表，**属正常**（推荐列表不是 ECharts 图）。
**累计页面错误：0。**

---

## 3. 浮层 / 面板实测

| 选择器 | 尺寸 | 定位 | 文本长度 | 备注 |
|---|---|---|---|---|
| `#settingsPanel.settings-panel.show` | 1440×900 | fixed | 1467 | 设置面板开启态 |
| `.settings-overlay` | 1440×900 | absolute | 0 | 遮罩 |
| `.settings-content` | 480×765 | absolute | 1467 | 设置内容区 |
| `#welcomeOverlay.welcome-overlay` | 1440×844 | fixed | 103 | **欢迎浮层，需单独取证** |

`#welcomeOverlay` 是首次使用引导，会遮挡界面 —— 基线必须在"已关闭欢迎层"和"欢迎层展开"两种状态下都取证，否则会把引导层误当成主界面的样子。

---

## 4. 墨墨学习界面（iframe）

进入路径：磁贴 `.chart-selector` 选 `study-web` → iframe 加载。

| 主题 | iframe `html` class | 注入 link | 停留状态 |
|---|---|---|---|
| standard | `memo-standard` | `memo-study-skin` → `css/maimemo-standard.css` | **登录页** |
| notebook | `memo-notebook` | `memo-study-skin` → `css/maimemo-notebook.css`；`memo-notebook-fonts` → `css/fonts.css` | **登录页** |

登录页文本样本：「墨墨账号中心 登录 学习服务 请求访问你的墨墨账号 密码登录 验证码登录 手机号或邮箱 密码 登录并授权」

**未登录可达**：登录页。
**未登录不可达**：学习开始页、单词正面/反面、认识/模糊/不认识、切换单词、项目编辑器、完成页。
→ 这些状态需要**真实墨墨账号授权**，按 §17c 必须停下来问用户。

---

## 5. 水平溢出基准（硬性验收项）

| 分辨率 | standard | notebook |
|---|---|---|
| 1440×900 | scrollWidth 1440 = clientWidth 1440 → **PASS** | 待 SA-2 补齐 |
| 1280×800 | 待 SA-2 补齐 | 待 SA-2 补齐 |
| 1920×1080 | 待 SA-2 补齐 | 待 SA-2 补齐 |

---

## 6. 对设计决策的意义（重要）

- 主界面是**单一 dashboard + 4 个磁贴 + 顶栏 + 浮层**的结构，**没有多页面路由**。
  → §9 的版心式侧边导航（第一个选项）会**新增一个顶级布局容器**，风险高且要动 `index.html` 结构。
  → **应选 §9 的第二个选项：顶栏式导航**（56px 高、2px 墨线下边框、应用名用 `--f-display`、当前项 4px 朱色下划线）。
- 天头/地脚靠 `#dashboard` 的内边距实现，不改 DOM。
- 版框/界行加在**磁贴**上（`.tile` 是天然的"版框"容器），正好对应"书页"隐喻。
- 设置面板（`#settingsPanel`）是天然的"填空线"输入框应用场景。
- `.chart-selector` 是 `<select>`，重设计成"填空线 + 实心三角"即可，不动其 value。