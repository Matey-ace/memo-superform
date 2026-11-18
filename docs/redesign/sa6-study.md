# SA-6 墨墨注入样式交付

## 范围与授权

阶段 3，仅负责主主题墨墨 iframe 的视觉层。采用用户批准的两项窄例外：

1. 保留既有 `link#memo-study-skin` 与两个原皮肤路径，不创建 `memo-theme-main-inject`。
2. 仅在既有 `MEMO_STUDY_THEME.syncMemoStudyTheme` 内新增 `memo-main-redesign` 类同步。

本子任务只修改 `memo_injection.py`、`css/maimemo-standard.css`，另新建本报告、`sa6/` 证据和永久测试 `tests/redesign/study-theme-isolation.js`。未改其他产品文件、数据、API、事件或注入常量。

## 写前检查记录

- 已读取当前两个文件及 `docs/redesign/source-before` 两份副本。
- 写前执行 `git diff` 和两个 `git diff --no-index`，无内容差异（只有 Git 的 LF/CRLF 警告）。
- 当前 CSS 原有 52 行，未删除、修改、移动；所有新规则都以 `html.memo-standard.memo-main-redesign` 开始。
- iframe 暗色令牌以 `html.memo-standard.memo-main-redesign.memo-dark` 开始；不读取父壳令牌。
- 未改 `:root`、字体声明文件、素材、原 `mode`、原主题类切换、路径、字体分支、MutationObserver 或 pageshow。
- 已核对 `study-web.js`、`study-shortcuts.js`、`study-content-editor.js` 与旧注入皮肤的选择器；不变更学习检测依赖的 display/visibility/opacity、尺寸、布局、按钮顺序、指针命中或 DOM。
- 手账、爱音以及陪伴模式仅作为隔离测试负例，不调整其代码与样式。

## 首次交付实现（历史记录）

### 唯一新增同步片段

位置：`memo_injection.py`，在 `syncMemoStudyTheme` 创建 `mode/root` 后、两条原主题 class 切换前，只新增一行 Python 字符串：

```js
var mainRedesign=false;
try {
  mainRedesign=!!(
    window.frameElement &&
    window.parent.document.documentElement.getAttribute("data-ui-style")==="standard" &&
    !window.parent.document.body.classList.contains("companion-mode") &&
    !window.frameElement.closest("#companionStudy")
  );
} catch(e) {}
root.classList.toggle("memo-main-redesign",mainRedesign);
```

跨源父窗口无法访问或 frameElement 不可用时保持 false。无新监听器、timer、observer、通道或学习行为。

原函数其他语句逐字保留：

- `parentStyle()` 与 `mode` 判定；
- `memo-notebook` / `memo-standard` 两个 class；
- `memo-study-skin` 与 `/css/maimemo-{notebook,standard}.css?v=20260825-unified-ui`；
- notebook 字体加载、standard 字体移除；
- 原 MutationObserver 及其观察目标/选项；
- 原 pageshow。

### CSS 策略

保留前 52 行原样，后追加 130 行。追加量 **6,975 B**，小于 30 KiB；全文件 **11,533 B**。

- 纸/墨/朱与暗色令牌在 iframe 自身作用域定义，零字体/图片资源请求。
- 单词使用 Georgia + 系统衬线，不设置单词字号、行高、间距或位置。
- 词卡双边通过 inset shadow 绘制，不新增改变盒模型的 border 宽度。
- 发音、释义、例句、原生模态框、输入、原生导航只改配色、字体、边框颜色和圆角等视觉属性。
- 每一条新增 `!important` 声明行均附覆盖理由，限覆盖上游或既有暗色样式。
- 暗色强调使用原规格已有 `--c-vermilion-2:#E8634B`，未修改规格色值。低对比弱色不作文字颜色。
- 未新增动画、过渡、filter、图片、字体、远程 url 或 import。

## 选择器证据与覆盖边界

没有捏造 `.word`、`.definition`、`.know`、`.vague`、`.forget`、`.done` 等 iframe 类。

| 已用选择器 | 源码证据 | 本次处理 |
|---|---|---|
| `.rev-root` / `.rev-top` / `.rev-scroller` / `.rev-bottom` / `.rev-resp-btns` | `js/study-web.js:189`、`:190`；`css/maimemo-notebook.css:55`、`:74`、`:209`、`:340`、`:356` | 调色，不改检测、布局或命中区 |
| `.rev-top .spelling` / `.phonetic` / `.interp-ctn` | `css/maimemo-notebook.css:159`、`:170`、`:187` | 单词系统衬线；音标/释义清晰层级 |
| `.phrase-spelling` / `.phrase-word` / `.rev-word` | `js/study-web.js:100` | 单词衬线，不设字号 |
| `.rev-content-header` / `.rev-content-container` | `css/maimemo-notebook.css:220`、`:239` | 标题衬线和原分隔线改色 |
| `.phrase-root` / `.phrase-phrase` / `.phrase-interpretation` / `.phrase-hl` / `.phrase-play-btn` | `css/maimemo-notebook.css:255`、`:264`、`:265`、`:275`、`:280` | 例句界行颜色、正文和强调色 |
| `.verify-input` / `.ask-spelling > *` | `css/maimemo-notebook.css:308`、`:345` | 原尺寸输入/按钮视觉 |
| `.memo-word-popup` / `.taro-modal__content` / `.taro-modal__inner` / `.taro-model__bd` / `.taroify-dialog` / `.taroify-popup--center` | `css/maimemo-notebook.css:369`–`:374` | 原生模态框颜色/内描双边 |
| `.taro-modal__mask` | `memo_injection.py:33` | 仅遮罩颜色 |
| `#taro-navigation-bar`、back/home、`#memo-tts-exit` | 当前文件原有规则 | 改色、不改功能显示与尺寸 |
| `:focus-visible` | `css/maimemo-notebook.css:425`–`:427` | 非布局焦点轮廓 |

### 明确不作虚假覆盖声明

- 认识/模糊/忘记类 `know/vague/forget` 在 `js/study-web.js:57`–`:61` 的**父壳**按钮上，不是本子任务 iframe CSS 的作用对象。交由父壳组件样式工程师处理。
- native 三按钮仅通过已证实 `.rev-resp-btns > *` 统一作墨/纸次按钮，不靠 nth-child 猜“认识”按钮的位置。主动作的原生语义选择器需要登录 DOM 证据后才能特化。
- 项目编辑器 `.study-content-editor` 由 `study-web.js:67` 建在**父壳**，本子任务不伪造 iframe editor 选择器。其打开/保存流程仍须真实验收。
- 完成页没有已证实专用 selector，只能继承根令牌；不能声称已完成专用排版。
- 登录表单没有新增未取证的 selector，不声称已完成填空线/主按钮视觉；真实登录 DOM 取得后再按授权补充。

## 自动化证据

命令：

```powershell
node tests/redesign/study-theme-isolation.js
```

首次交付实测结果：**PASS，50 项断言**。后续轮1状态缺陷及193项修复验证见本文末尾；50项本身不代表四态视觉通过。

测试通过 Python `runpy.run_path` 只导出当前和 source-before 中纯 JS/CSS 常量，不 import server，不读数据库，无凭据；随后启动随机端口的独立 HTTP fixture 与独立无持久化 Edge。没有连接 `:55395`、`:9337`，没有触碰人工登录上下文。

证据文件：

- `docs/redesign/sa6/isolation-results.json`：逐项 50 条结果、CSS 实测字节、真实登录状态声明。
- `docs/redesign/sa6/injection-addition.txt`：唯一新增源代码行。

验证包含：

1. `INTERCEPTOR_JS`、`MEMO_DARK_CSS`、`MEMO_DARK_JS`、`MEMO_NAV_GUARD_JS`、`MEMO_STUDY_KEYS_JS` 与快照常量全部一致。
2. 当前 Python 源只移除新增一行后，**整个文件与 source-before 逐字一致**。
3. 当前 CSS 以整个旧 CSS 为精确前缀，旧代码无一字节修改。
4. 新增 CSS 选择器全部双守卫，新增声明没有布局/尺寸/显示/命中属性，没有远程资源或 filter。
5. 显式 standard 启用；陪伴 body 禁用；退出陪伴恢复。
6. 即使 body 不带 companion-mode，iframe 在 `#companionStudy` 内仍禁用，且无新增令牌。
7. 属性缺失时 fail-closed；notebook 切换清类、清新增令牌；切回 standard 恢复。
8. 保留原皮肤/字体路径；skin link 始终一个；notebook 字体加载/移除行为不变。
9. 原 observer 只有一个且复用，无新增 timer；standalone 无 frameElement 禁用。
10. 固定大小 fixture 三按钮的尺寸/文本顺序未变；暗色根纸色正确；零 pageerror。

**fixture 是隔离逻辑验证，不是真实墨墨页面的视觉/行为验收。** 没有把50项断言冒充登录后流程通过。

## 风险与未验证

- 真实墨墨登录后七个状态仍**未验证**：开始学习、正/反面、三个判断动作、切换单词、项目编辑器打开保存、完成页。尚无这些页面的真实截图或 DOM 片段。
- 旧 MutationObserver 只观察父 body 的 class/data-ui-style。为遵守“原 observer 完全不改”，**父 html 属性若单独变化而 body 不变，视觉类到下一次既有 body mutation/pageshow 才重新同步**。生产主题切换同步 body 类；独立测试也显式触发此既有同步点。不得称为 html 属性实时监听。
- 不重启原 `:55395` 服务：其已 import 的旧常量不会凭磁盘改动更新。当前人工登录不会因此自动加入新 class；在获准重启/新服务前不得宣称生产页面已加载新设计。
- 保留 CSS 中所有旧规则意味着旧版样式里已有 blur/transform 等仍在源文件中；本次没有新增这些行为，也未为清理旧代码而影响陪伴模式。
- 本次不给零像素差异的最终证明；SA-8 必须在真实图像/DOM可得时完成禁区前后验证。

## 文件统计

| 文件 | 改动 |
|---|---|
| `memo_injection.py` | +1 / -0；其余所有源字节与快照一致 |
| `css/maimemo-standard.css` | +130 / -0；追加 6,975 B；总 11,533 B |
| `tests/redesign/study-theme-isolation.js` | 永久隔离测试，新建 |
| `docs/redesign/sa6-study.md` | 本报告，新建 |
| `docs/redesign/sa6/*` | 自动化证据，新建 |

没有 commit/push、没有打包、没有修改真实数据。

## SA-8 轮1修复：写前清单

- 本轮重新读取当前 CSS、永久测试、本报告；只重获这三文件与 sa6/ 证据目录所有权，不修改 memo_injection.py 或其他产品文件。
- 已审阅当前 CSS 对 source-before 的 diff：原52行仍逐字前缀，只有主主题追加规则；`git diff --no-index` 返回1表示确有已知追加差异，不是执行故障。
- 本轮只追加主主题双守卫下的 TTS 滤镜/过渡/位移清除、id级焦点，以及导航原三模式的配色层叠修复；不改布局、尺寸、顺序、z-index 或功能显示。
- 永久测试放宽的仅是 transform/filter/backdrop-filter/transition 的字面值 none；其他布局禁令保留。新增 --out 目录选项，默认路径保持兼容，本轮使用新子目录避免覆盖初版证据。
- 测试为独立随机端口夹具，不连接9337、不点击真实答案或保存。父级告知55395已重启、新注入生效、原生确认已关闭；本子任务不重复操作真实会话。
- 上文“55395未重启”和“父壳答题栏待样式”是首次交付时的历史状态，不作为当前状态结论；父级已按新授权隐藏主主题重复父壳答题栏，本轮不触碰该文件。

## SA-8 轮1修复交付

### 已确认问题与修复

原轮1不通过记录保持冻结，本节不将其改写为通过。

| 项目 | 原因与本次追加修复 |
|---|---|
| TTS 毛玻璃 | 原 backdrop-filter:blur(8px) 无任何新覆盖；仅双守卫 id 规则新增 backdrop-filter:none |
| TTS 位移与过渡 | 原 hover/active transform 与 transition 留存；追加 transition:none 及双守卫 hover/active transform:none |
| TTS 蓝色焦点 | 原 id 焦点 (1,2,1) 压过 generic 新焦点 (0,3,1)；追加双守卫 id 焦点 (1,3,1)，使用2px朱色轮廓 |
| 导航暗色旧配色 | 旧暗色模式 (1,4,1) 压过此前新常态 (1,3,1)；沿原3mode追加守卫常态 (1,4,1)，靠后获胜 |
| 导航浅色蓝hover | 旧hover (1,4,1) 压过此前新常态；新增带原mode的hover (1,5,1)，纸字朱底 |

没有修改旧规则，也没有增加尺寸、布局、z-index、按钮顺序或学习行为。本轮没有动 memo_injection.py。

TTS 的旧模糊阴影原本已被新常态相同特异性、靠后规则清除；本轮继续以四态实测确认 box-shadow:none，不将旧阴影误记为本轮新修缺陷。

### 永久测试调整

- `--out DIRECTORY` 指定证据目录，省略时仍写原默认 `docs/redesign/sa6`；参数验证在创建目录前进行。
- 静态校验禁止新增布局、尺寸、z-index和远程资产；transform/filter/backdrop-filter/transition/mix-blend-mode 若出现，只允许字面值 none，以容许安全清除，不再错误地把合法清除当新效果。
- 独立页面分别放 TTS、fallback back、back-icon、home-icon，导航每页仅一个按钮，不存在back/home重叠导致的hover超时。
- 两种明暗 × 四个控件变体 × 四态，共32个 computed-style 快照，断言背景/文字/边框、box-shadow/filter/backdrop-filter/transform、焦点样式及矩形不变；TTS同时断言 transition:none/0s。
- hover、active、focus分别验证相应伪类实际命中。active使用真实mouse down，finally释放；focus从body重置遍历起点后真实Tab进入，验证 :focus-visible。
- 新增去除守卫后的负例，确认旧TTS blur仍保留，清除仅限主主题新激活区域，不蔓延禁区。
- 全部原注入常量、CSS旧前缀、主题切换、字体路径、陪伴排除等断言仍保留。

### 实测命令与结果

第一次执行扩展测试停在 `light tts keyboard focus visible`：旧测试步骤点击后仅blur，Tab起点仍在按钮之后，没有聚焦目标。已调查为夹具键盘遍历起点问题；仅将测试起点显式设到body再Tab，未修改产品来迎合断言。修正后完整重跑：

```powershell
node tests/redesign/study-theme-isolation.js --out docs/redesign/sa6/sa8-round1-fix
```

stdout：

```json
{"result":"PASS","checks":193,"cssAddedBytes":8721}
```

后续检查：

```powershell
node --check tests/redesign/study-theme-isolation.js
git diff --check -- css/maimemo-standard.css tests/redesign/study-theme-isolation.js
Get-Item css/maimemo-standard.css,tests/redesign/study-theme-isolation.js,docs/redesign/sa6/sa8-round1-fix/isolation-results.json | Select-Object Name,Length
```

语法/差异检查通过，只有Git既有LF/CRLF提示。最终文件统计：

| 文件 | 字节与证据 |
|---|---|
| `css/maimemo-standard.css` | 13,279 B；相比首次交付再追加1,746 B；相比原52行累计追加8,721 B <30 KiB |
| `tests/redesign/study-theme-isolation.js` | 14,660 B |
| `docs/redesign/sa6/sa8-round1-fix/isolation-results.json` | 37,856 B；193条断言、32份状态快照 |
| `docs/redesign/sa6/sa8-round1-fix/injection-addition.txt` | 测试输出的原有单行同步证明，本轮未改注入 |

本轮使用--out新目录，初版sa6/isolation-results.json的50项证据和原轮1不通过记录均未覆盖。

### 边界

这些为独立夹具回归结果，不是原生真实学习全流程通过。本子任务没有连接9337，没有操作真实答案或保存，也没有重启55395；父级告知的人工状态作为任务上下文，不冒充本子任务独立验收。

待SA-8下一轮从真实可达页面验证，并继续负责整套禁区零差异证明。此轮修复仅消除已确定的TTS/导航状态问题，不扩大选择器或功能覆盖。
