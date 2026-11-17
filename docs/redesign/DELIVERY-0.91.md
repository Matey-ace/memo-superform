# MeMo Superform 0.91 交付说明 · 笔记本设置分类目录 + 普通版模块配色

构建：`dist\MemoSuperform-0.91-notebook-settings-and-palette\MemoSuperform.exe`
版本 0.91（frozen=true），23 项资产自检通过，SHA256 `71801F24243CB287AA3E3E8418454A2DE3B3DC788F50B6B2913AD9FBFB3C9923`
基线提交 `8255874`，分支 `codex/companion-redesign-test-build`（草稿 PR #7；未合入 main、未打 Release、未改写历史验收记录）

本轮只做两件事：给 Anon 的笔记本加设置分类目录；恢复普通版模块配色选择。普通版上一轮的版式已由你核验通过，本轮没有重新设计。

---

## 1. 笔记本设置：分类目录

**改了什么**

原来笔记本的设置是**一张长页**（9 个 `<h3>` 分组一路排下去，页面里要滚 3000+ px）。现在打开先看到 **7 个分类的目录**，进入分类看详情，可明确返回目录。

| 分类 | 归入的原设置组 |
|---|---|
| 账号与连接 | 墨墨账号 |
| 学习与进度 | 数据更新 |
| 角色与陪伴 | 陪伴模式、Live2D 模型库 |
| 语音与音频 | 语音功能（GPT-SoVITS 资源包） |
| AI 与记忆 | AI API 配置（可选） |
| 外观与窗口 | 界面风格、运行模式 |
| 数据与维护 | 软件更新 |

9 个原组**恰好各归一处**，没有空分类，也没有发明新设置。若将来有组对不上任何分类，模块会放弃拆分、保持长页并 console.warn——宁可不变，也不丢设置。

**关键做法**

- 分类结构**不写进 `index.html`**。两版共用同一份设置 DOM，写进 HTML 会把笔记本以外的路径一并改掉（上一轮就是这样把笔记本弄坏的）。改为运行时在 `js/notebook-settings-nav.js` 里构建，且该模块在非笔记本主题下第一行就 `return`。
- **只搬运节点，不复制**：用 `appendChild` 移动原 `setting-group`。每个设置仍只有一份，实测无重复 id（180 个 id 全unique）。特别注意 `appendChild` 之后 `group.parentNode` 已变成分类页，**不能再 removeChild"清理"一遍**，否则设置会被删空。
- 分类页一次建好，切换只改可见性：不重建 DOM、不重挂语音包/模型库/角色编辑器、不发请求。
- 未保存保护覆盖 `app.js` 真正保存的 6 个字段；只有用户 `input`/`change` 才置脏，程序回填不算。切换分类/返回/关闭前会提示。
- 浏览状态用**笔记本自己的键** `memo_notebook_settings_last_category`，与普通版 `memo_settings_last_category` 完全隔离（实测互不写入）。
- 生命周期接口与普通版同名（`window.MemoSettingsNav`），两版主题互斥、各自早退，所以 `app.js` 一行都不用改。

**视觉**：延续笔记本既有设计——纸面卡片、玫瑰粉/天空蓝点缀、虚线分隔、柔和圆角、轻投影、Noto Serif SC 标题。样式表 46 条规则**全部**以 `html[data-ui-style="notebook"]` 开头并限定在 `.settings-panel` 内，未限定作用域的顶层规则数为 0，不会泄漏到首页/图表/学习页。

**可读性问题（已修）**：程序化对比度审计发现新增的 11px 说明文字沿用 `--ink-light`(#a89880) 只有 **2.78:1**，不达可见标准。已在本文件内覆盖为 `--ink-mid` 系列（5.39:1），三档状态色改为 ok #2f7d55(4.95:1) / warn #7d5f14(5.89:1) / error #a84460(5.66:1)。**没有改动 `css/style-anon.css` 里的 token 定义本身**，避免波及笔记本其他区域。

---

## 2. 普通版模块配色：恢复选择功能

**根因（两个缺陷叠加，均已实测复现）**

1. **名称与颜色脱钩。** `js/charts.js` 里正确的六套预设 `heatmapPalettes` 被 `mainHeatmapPalettes()` 用构成主义固定色 `mainChartPalette()` 按索引重新混合。结果"GitHub绿"的第 4 级渲染成陶土色 `#B8321F`、"樱粉"渲染成近黑 `#1A1714`、"靛蓝"渲染成米色。修复前实测六颗色点：GitHub绿 rgb(199,101,82)、樱粉 rgb(86,81,74)、紫韵 rgb(144,135,123)、暖橙 rgb(179,142,94)、玫红 rgb(89,106,115)、靛蓝 rgb(222,212,188)——基本全是莫兰迪陶土色系，与名字无关。
2. **偏好是全局单值，重绘只及当前模块。** `setPaletteIndex()` 只写全局 `heatmap_palette`，点击只重绘当前磁贴。实测：点磁贴0的"樱粉"后 `heatmap_palette` 变 `"1"`，磁贴1的选中态仍停在"GitHub绿"——两个模块**显示的配色与选中态不一致**，正是你说的"模块选择与实际显示不一致"。

此外 `paintMainChart()` 在 `isMainChartTheme()` 时把每个 series 的颜色、圆角、边框再改写一遍，并把零值格强制成米色，进一步盖掉用户选择。

**修法**

- 六套预设恢复本来语义：所选即所绘。修复后实测（浅色）GitHub绿 `#c6e48b/#7bc96f/#239a3b/#216e39`、樱粉 `#ffe0e6/#ffb3c4/#ff8899/#d63d5a`、紫韵 `#e1bee7/#ba68c8/#8e24aa/#4a148c`、暖橙 `#ffe0b2/#ffa726/#ef6c00/#e65100`、玫红 `#f8bbd0/#f06292/#c2185b/#880e4f`、靛蓝 `#c5cae9/#5c6bc0/#283593/#1a237e`。深色走各自 `darkColors`，同样正确。
- **拆分职责而非删除**：`paintMainChart` 保留字体/背景/边框/圆角/tooltip 等通用绘制，不再覆盖数据色板。
- **逐模块作用域**：新增普通版专属键 `standard_heatmap_palette_by_tile`（JSON，形如 `{"0":4}`）。`render()` 把 tileIndex 透传给热力图渲染，取"该磁贴的有效色板"而不是全局变量。旧 `heatmap_palette` 仅作首次默认值读取，**写入不再只依赖它**，且它的读语义对笔记本保持不变。
- 零值格保持中性色（浅 #ebedf0 / 深 #2a2a3a），与非零四级明显区分，不会与某一等级混淆。
- 色点预览、选中态、实际 ECharts 配置三者取同一份有效色板（`.swatch-dot` 直接取 `p.colors[2]/[3]`）。

**逐模块实测**：两个热力图磁贴，点磁贴0的"樱粉"→ 磁贴0 active=1、磁贴1 active 仍为 0；存储只有 `standard_heatmap_palette_by_tile`=`{"0":1}`，共享键 `heatmap_palette` 保持 `null` 未被写坏。

**持久化实测**：选第 5 套（玫红）后刷新，`{"0":4}` 保留，重开仍是 active=4，颜色仍是 `#f06292/#c2185b/#880e4f/#f8bbd0`。切月份、切图表类型再切回，颜色与选中态均不残留旧值。

---

## 3. 隔离检查结果

用真实浏览器（Edge + Playwright）对**打包后的 EXE**（http://localhost:8888）执行，非仅读 localStorage 或 active 类：

```
WIRING_PASS          （28 项：两版设置面板、9 组保留、7 分类、无重复 id、
                      关闭重开回目录、存储键互不写入）
ISOLATION_PASS 26    （两版六套配色各自正确 + 本体不被污染）
```

隔离的 26 项断言包括：

- 笔记本：顶栏 h1 仍是 `"Noto Serif SC"` + rgb(74,55,40)；磁贴底色 rgb(255,253,254)；日历 `borderColor #fff / borderRadius 6`；标题色 `#1a1a2e`；图表字体未被普通版字体栈接管；六套调色板渲染的仍是原来的 `#c6e48b…` 等。
- 普通版：日历仍 `borderColor #1A1714 / borderRadius 0`（构成主义风格未被配色修复带跑）；标题 `#1A1714`；字体仍是 `-apple-system, …` 那套；六套配色现在名称与颜色相符。
- 两版设置偏好键互不写入（notebook→仅 `memo_notebook_settings_last_category`；standard→仅 `memo_settings_last_category`）。
- 两版均无 JS 错误 / console error。

---

## 4. 测试

`tests/run.ps1` 全绿：**`REGRESSION_SUITE_PASS`**，551 项 Python 测试 `OK`，31 个 node 回归脚本全部通过（含本轮新增 2 个）。

本轮新增测试：

- `tests/notebook-settings-nav-regression.js`（10 组约束）：两版导航互斥且早退在任何 DOM 访问之前、分类结构不进 `index.html`、只搬运不克隆、禁止 appendChild 后 removeChild、9 组恰好各归一处、独立存储键、未保存字段覆盖、`AIAPI` 必须用 `typeof` 取（`window.AIAPI` 恒假会导致保存成功后仍被拦）、CSS 无越界规则、样式表只在笔记本分支加载。
- `tests/chart-palette-regression.js`：六套预设名称与色系相符（用 HSL 色相判定，不锁死具体色号）、`paintMainChart` 不得重映射用户色板、逐模块键与旧键兼容、三者同源、零值格独立处理、数据与统计函数未变。

**关于旧合同**：`tests/redesign/chart-theme-isolation.js` 曾把"主图表统一使用构成主义固定调色"写成断言（断言 palette = `['#B8321F', …]`）。那个合同已被本次需求取代。该文件**保留原处不动**作为当时验收记录，没有为了让测试变绿而删除断言；新需求由上述正向测试覆盖，合同变更在此明确记录。

---

## 5. 独立审查

上一轮抓到笔记本泄漏的对抗式审查在本轮继续执行，仍未发现新的生产问题。本轮由我复核并修复的问题：

1. 新增说明文字对比度 2.78:1 不达标 → 已改为 5.39:1 等（见 §1）。
2. 我自己测试脚本的三处**测试侧**错误（不是产品缺陷）：`vm` 跨 realm 数组原型不同导致 `deepStrictEqual` 误报、注释里出现 `window.AIAPI` 字样被正则误判、把 HTML 的 `class="swatch-dot"` 当 CSS 的 `.swatch-dot` 匹配。均已改正断言而非放宽标准。
3. 一次"刷新后配色丢失"的告警经复验是**测试伪影**（当时该磁贴不在 heatmap 状态，没有色点可点），真实场景下 `{"0":4}` 与 active=4 均正确保留。

---

## 6. 包与启动

- 绝对路径：`D:\MeMo1\dist\MemoSuperform-0.91-notebook-settings-and-palette\MemoSuperform.exe`
- 大小 98,223,525 字节；SHA256 `71801F24243CB287AA3E3E8418454A2DE3B3DC788F50B6B2913AD9FBFB3C9923`
- 启动：双击 exe（默认网页模式，自动开 http://localhost:8888）；或 `MemoSuperform.exe --mode web`
- 构建身份：`--verify-build` 报告 `version=0.91 frozen=true passed=true`，**23 项**资产自检通过。本轮把 `/css/notebook-settings.css` 与 `/js/notebook-settings-nav.js` 加入 `launcher.py` 的 `verify_build` 清单——否则缺文件时分类页会悄悄退回长页而自检仍通过。
- 包内不含真实学习数据：`data/` 为打包时的空库，运行时数据目录用 `MEMO_DATA_DIR` 指向临时目录。

---

## 7. 真实的能力边界（未验证项）

1. **无法目视复核截图。** 当前模型不支持图像输入（`read_image` 报 "does not declare image input"）。视觉结论全部来自程序化测量：几何（是否超出视口、导航与详情是否重叠、7 项导航尺寸）、文本溢出（scrollWidth/clientWidth）、对比度（WCAG 相对亮度）、以及真实 ECharts `getOption()` 的最终颜色。这能证明"没有溢出/没有重叠/对比度达标/颜色确实是所选那套"，但**无法证明"看起来好看"**。该项如实标注为限制。
2. **真实 OAuth 端到端未跑通。** 需要真实墨墨账号与开放平台凭据，本轮未做，也没有伪造登录。账号相关 UI 的连通性只在隔离环境验证。
3. **真实学习数据下的配色未验证。** 真实库 `data/memo-superform.db` 按约束未改动，`/api/study-records` 无账号返回 401。分级着色的证据来自注入固定非零记录后走**真实渲染路径**（`ChartManager.setRecords` + `render`），可证明着色逻辑正确，但不是真实学习记录的证据。
4. 未验证 Live2D 模型库、TTS 资源包在分类切换下的实际重载表现（代码层面确认不重建、不发请求，但未做长时间交互压测）。
5. 三个并行子智能体在收尾阶段异常终止（未留收尾消息）。它们产出的文件均未损坏（语法与全部测试通过），但**它们声称的验证我全部重跑复核过**，未采信其自述结论。

---

## 8. 改动清单

修改：
- `index.html` — 加 1 行 `<script src="js/notebook-settings-nav.js">`
- `js/ui-style.js` — 笔记本分支加 1 行 `css('css/notebook-settings.css', …)`
- `js/charts.js` — 六套配色恢复语义 + 逐模块色板 + `paintMainChart` 职责拆分
- `js/layout.js` — 工具栏/点击链路接逐模块状态
- `launcher.py` — `verify_build` 增加 2 项新资源断言
- `build_info.py` — `BUILD_VERSION` 0.90 → 0.91
- `tests/run.ps1` — 注册 2 个新测试

新增：
- `js/notebook-settings-nav.js`、`css/notebook-settings.css`
- `tests/notebook-settings-nav-regression.js`、`tests/chart-palette-regression.js`

未改动（受保护）：`index-anon.html`、`css/style-anon.css`、`css/diary.css`、`css/study-web-notebook.css`、`css/maimemo-notebook.css`、`css/fonts.css`、`css/live2d-companion.css`、`css/companion-progress.css`、`css/companion-settlement.css`、`js/diary.js`、`js/gif-icons.js`、`js/live2d-companion.js`、`js/companion-progress.js`、`js/companion-settlement.js`、`tests/font-gif-manifest.sha256`、`data/tts_pack/roles/anon/persona.json` —— 逐文件哈希比对一致。

---

## 9. 真实剩余项

1. 分类目录的**视觉美感**需你亲眼确认（我无法目视，只能证明没溢出/没重叠/对比度达标）。
2. 窄窗口（≤900px）目录↔详情的切换逻辑与无障碍焦点已实现并测过几何，但真机小屏手感建议你亲自点一遍。
3. 真实账号登录后的设置面板状态摘要（"已连接 · 昵称"）未在真实授权下验证。
4. 普通版配色在**7 天/90 天等更长区间**与更多磁贴组合下未逐一截图核对（已覆盖切月份、切类型、刷新、明暗、双磁贴隔离）。
