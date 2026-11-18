# Memo Superform 主主题设计系统

修订版 SA-3-R2。产品方向：构成主义 × 古典雕版排版。
令牌文件：[theme-constructivist-tokens.css](../../css/theme-constructivist-tokens.css)。
本次只交付独立 CSS 与本文，不加载到产品页面；没有改动主题加载入口、字体、素材或既有共享变量。

## 1. 方向与边界

目标是“一本用现代几何结构重新刻印的宋版书”。构成主义提供严格网格、非对称组织、矩形、粗细线与字号对比；雕版提供版框、界行、鱼尾、书耳和朱墨层次。不要以纸张噪点、做旧污渍、水墨、卷轴或贴纸制造古意，不使用政治符号、人物拼贴、满屏斜线、渐变、毛玻璃或柔和阴影。

这是数据工具而非营销页。纸/墨/朱/其他面积目标约为60/25/10/5，靛蓝不超过3%。颜色比例是后续截图验收目标，不是本文件已经达到的测量结论。主操作朱色集中，功能色只做小面积装饰并配墨色文字和文字标签，不依赖颜色独立表达状态。

### 1.1 作用域与陪伴隔离

MAIN_SCOPE 固定为 `html[data-ui-style="standard"]`，所有 CSS 选择器均以它开头。
在此基础上，令牌与工具类全部追加 `:has(> body:not(.companion-mode))`。进入陪伴模式时，根令牌和暗色覆盖都停止匹配；退出后恢复。此处不是仅隐藏界面，而是让整套新增规则不参与层叠。

每个工具类的目标元素另带 `:not(#companionStudy, #companionStudy *)`，明确排除陪伴根及其全部子孙。界行工具的实际子元素目标也重复此排除，防止通过父容器选择器命中禁区。

**不提供**通用 body、h1–h4、p、focus-visible、selection 样式。这些通用规则会命中或影响陪伴内容，已删除。焦点、正文与标题需由 SA-4/SA-5 在具体组件边界内实现，不能重新加入全局规则。

注意：正常 dashboard 下，根上的自定义属性仍会按 CSS 规则继承到子树；不存在任何新增规则消费陪伴子树中的这些变量。进入 `.companion-mode` 时这些变量不再由本文件定义。最终“零视觉差异”仍需真实陪伴截图和计算样式回归，不应把选择器静态检查冒充完整零差异证明。

## 2. 令牌表

所有原始颜色保持不变，不新增替代颜色。暗色功能色沿用亮色定义，禁止将其低对比组合用作文字。

| 令牌 | 亮色 | 暗色 |
|---|---|---|
| --c-paper | #EFE7D6 | #16130F |
| --c-paper-2 | #E5DBC6 | #211D18 |
| --c-paper-3 | #D8CCB2 | #2E2922 |
| --c-ink | #1A1714 | #ECE3CF |
| --c-ink-2 | #3D3731 | #C9BFAA |
| --c-ink-3 | #6B6258 | #968C7A |
| --c-vermilion | #B8321F | #D2452E |
| --c-vermilion-2 | #8E2416 | #E8634B |
| --c-vermilion-bg | #F3D9CF | #3A1A13 |
| --c-indigo | #1F3A4D | 继承亮色 |
| --c-ochre | #9C6B30 | 继承亮色 |
| --c-success | #2F5D3A | 继承亮色 |
| --c-rule | #1A1714 | #ECE3CF |
| --c-rule-soft | rgba(26,23,20,0.22) | rgba(236,227,207,0.20) |

### 2.1 字体

```css
--f-display: "Noto Serif SC", SimSun, "Source Han Serif SC", serif;
--f-serif: "Noto Serif SC", SimSun, serif;
--f-body: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
--f-num: "Bahnschrift", "DIN Alternate", "Segoe UI", sans-serif;
```

只使用系统字体，不加载或修改 [fonts.css](../../css/fonts.css)，不新增字体文件。字体名称与禁区声明中的家族同名，不代表加载了该声明文件。
数字工具类配 `font-variant-numeric: tabular-nums` 与 `font-feature-settings: "tnum" 1`；是否实际具备相应字体特性仍需检查真实渲染。

### 2.2 字号与排版

| 令牌 | 值 |
|---|---|
| --fs-xs / sm / md / lg | 12 / 14 / 16 / 20px |
| --fs-xl / 2xl / 3xl / 4xl | 28 / 40 / 56 / 80px |
| --lh-body / head / num | 1.65 / 1.2 / 1 |
| --ls-cjk-head / latin-cap / body | 0.08em / 0.12em / 0 |

80px 数字每屏最多一处。CJK 标题0.08em仅按任务规范用于标题，不应用于正文。拉丁大写标签0.12em，不自动将中文或混排正文转大写。这些是令牌与用法约定，不是通用元素规则。

### 2.3 间距与结构

| 令牌 | 值 |
|---|---|
| --sp-1 … --sp-9 | 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96px |
| --sky-top | var(--sp-8)，64px |
| --floor-bottom | var(--sp-7)，48px；满足≥2/3×64px |
| --content-max | 1440px |
| --tap-min | 32px |
| --r-none / --r-tap | 0 / 2px |
| --rule-heavy | 2px solid var(--c-rule) |
| --rule-light | 1px solid var(--c-rule) |
| --rule-hair | 1px solid var(--c-rule-soft) |
| --shadow-hard | 4px 4px 0 var(--c-ink) |
| --shadow-hard-sm | 2px 2px 0 var(--c-ink) |

布局由 SA-5 落地：12列、24px沟槽、48px页边距，≥1440px时页边距64px，最大内容1440px。不要把本文件的最大宽度变量误当成已经应用的布局。

四周双边唯一实现：

```css
border: 2px solid var(--c-ink);
box-shadow: inset 0 0 0 3px var(--c-paper), inset 0 0 0 4px var(--c-ink);
```

硬阴影仅用于主按钮或窗口，同屏最多3处；没有模糊。按钮样式由 SA-4 完整实现，本文件移除不合规格的 `.memo-action`，不保留半套按钮实现。

### 2.4 动效

`--ease: cubic-bezier(0.2,0,0,1)`；`--dur-fast/base/slow: 120ms/180ms/260ms`。
只允许过渡 color、background-color、border-color、transform、opacity。
`prefers-reduced-motion: reduce` 下将三个时长归零是明确要求，不是擅自改变令牌；仍受标准主题与非陪伴模式条件约束。组件里存在固定时长或动画时，SA-4必须分别覆盖，不能假定三个变量能取消任意既有动画。本文件没有常驻动画。

## 3. 对比度：原始组合与修正用法

### 3.1 方法

采用 WCAG 相对亮度公式，全部数值由 Python 实际计算：通道先除255，若c≤0.03928则c/12.92，否则((c+0.055)/1.055)^2.4；L=0.2126R+0.7152G+0.0722B；比值=(L亮+0.05)/(L暗+0.05)。表中四舍五入到两位，阈值按未舍入值判断。
正文≥4.5:1；≥24px或≥18.66px粗体的大字≥3:1。下表默认按普通文字4.5评估；实际禁用控件文字可能豁免，但不以豁免替代本设计的可读性目标。

### 3.2 原始13组，逐组列明亮暗两套

| 前景 / 背景 | 亮色 | 暗色 | 普通文字结论（亮/暗） |
|---|---:|---:|---|
| ink / paper | 14.51 | 14.51 | 通过 / 通过 |
| ink-2 / paper | 9.54 | 10.15 | 通过 / 通过 |
| ink-3 / paper | 4.86 | 5.58 | 通过 / 通过 |
| vermilion / paper | 4.86 | 4.08 | 通过 / 不通过 |
| paper / vermilion | 4.86 | 4.08 | 通过 / 不通过 |
| ink / paper-2 | 12.99 | 13.13 | 通过 / 通过 |
| ink / paper-3 | 11.22 | 11.30 | 通过 / 通过 |
| ink-3 / paper-3 | 3.76 | 4.35 | 不通过 / 不通过 |
| vermilion / vermilion-bg | 4.45 | 3.46 | 不通过 / 不通过 |
| ink / vermilion-bg | 13.29 | 12.31 | 通过 / 通过 |
| indigo / paper | 9.64 | 1.56 | 通过 / 不通过 |
| ochre / paper | 3.74 | 4.02 | 不通过 / 不通过 |
| success / paper | 6.21 | 2.42 | 通过 / 不通过 |

原组合共有亮色3组、暗色7组不满足4.5。以下改用法，不改任何颜色令牌，不保留此前建议的新颜色。

### 3.3 最终可用搭配

| 用途 | 使用现有令牌 | 亮色 | 暗色 |
|---|---|---:|---:|
| 朱色小文字 | vermilion-2 / paper | 7.07 | 5.57 |
| 印章/选中行文字 | vermilion-2 / vermilion-bg | 6.48 | 4.72 |
| 禁用/弱化底文字 | ink / paper-3 | 11.22 | 11.30 |
| 成功/警告/信息标签文字 | ink / paper-2 | 12.99 | 13.13 |
| 亮色主按钮 | paper / vermilion | 4.86 | 不使用此搭配 |
| 暗色主按钮 | paper / vermilion-2 | 亮色亦7.07 | 5.57 |
| 按钮 hover | paper / ink | 14.51 | 14.51 |

暗色原朱底+ink文字实际只有 **3.55:1**；原朱底+paper文字 **4.08:1**。所以“暗色朱底改墨字即可达标”是错误建议。已报告总负责人并获其确认不采用；暗色主按钮改用**已有 vermilion-2 底 + paper 字**，满足§13。这是配色用途差异，不是更改令牌，也不表示用户放宽了规范。hover用ink底+paper字，朱边保留；不能在hover时重新落回低对比文字搭配。

靛蓝、赭石、成功绿仅做装饰边线/色块，并配上表的墨色文字与明确文本。低对比装饰不得独自承担控件边界、焦点提示或唯一状态识别；必要的图形识别依靠高对比墨框和文字。成功印章文字已改ink，边框保留success。原朱色仍可作装饰和大字，但不是普通小文字通用色。

### 3.4 焦点与触控

令牌文件不再提供通用焦点规则，以免污染陪伴内容。SA-4必须为具体交互组件补 `:focus-visible`，可用墨色2px轮廓、3px偏移，实际背景下核验可见性。32×32目标要求须对最终组件矩形逐项量测；仅有 `--tap-min` 不构成已达标证明。

## 4. 字体证据的限度

此前探针观察到系统文件名与canvas文字度量差异。这些只是**有限证据**：

- CJK字形通常全角等宽，宽度一致不能证明字体相同或缺失。
- 与fallback宽度不同，最多说明所测字符串的渲染度量不同，不能证明每个中文字形、每个字重来自指定字体。
- 与fallback相同不能断言字体不存在，也不能证明泛型serif必定映射到SimSun。
- `document.fonts.check`对不存在字体名也可能返回true；不得作为本地字体安装或命中证明。
- 文件名存在不等于浏览器按某个CSS家族名实际采用该字体；合成粗体与真实可变字重也未在此证实。

因此，保留规定的系统字体栈，但**不再声称已证明Noto Serif SC/SimSun等命中，也不声称Source Han Serif SC、Songti SC等一定不存在**。实际字体、缺字回退、字重与中文大字的字形质量仍需字体解析工具和可目视截图核验。

不加载共享字体声明是禁区与性能要求，不是因为它“只有1MB字体”。此前954KB指CSS元数据，并非全部字体二进制；不据此虚报网络成本。

## 5. 雕版组件约定

| 术语 | 工具类或归属 | 落地约束 |
|---|---|---|
| 版框 | .memo-double-frame | 2px外边+规定inset双边，24px内距 |
| 界行 | .memo-jiehang | 相邻子项发丝分隔；最终目标也排除陪伴子树 |
| 版心 | .memo-banxin | 衬线20px、细墨线、标题字距0.08em |
| 鱼尾 | .memo-fish-tail | 墨色10×14px；polygon(0 0,100% 0,100% 100%,50% 70%,0 100%) |
| 象鼻 | 交SA-5 | 导航两端2×24px，不保留旧版32×2实现 |
| 书耳 | .memo-book-ear | 直角墨底纸字、数字tabular-nums，最小32×32 |
| 印章 | .memo-seal | 2px朱框、衬线12px、vermilion-2字；success/muted用ink文字 |
| 天头/地脚 | .memo-sky / .memo-floor | 64/48px，天头大于地脚 |
| 数字 | .memo-num / .memo-num-hero | 等宽数字；hero仅80px，每屏最多一个 |
| 主按钮 | 交SA-4 | 本文件没有memo-action或不完整按钮状态 |
| 导航/标签/牌记 | 交SA-4/SA-5 | 不以令牌文件代替组件实现 |

鱼尾黑色在暗色里使用语义墨色（亮墨），以维持对比，不写死新增黑色。纹理选无纹理；无需任何新图片、字体或JS文件。

## 6. 工程交接与验收

所有新增外壳规则以MAIN_SCOPE开头，并遵循非陪伴guard与目标排除。不得更改原有root变量、禁区文件、notebook分支、现有id或业务使用的class名。禁止通用字体/颜色/焦点规则再次影响陪伴模式。

### 6.1 特异性纠正

旧文档“html[attr] body.dark可能与body.dark同分”是误报。无guard时前者为(0,2,2)，后者为(0,1,1)，前者明确更高。当前guard还加入`:has`条件，仍更高。更重要的是本文件定义`--c-*`，既有body.dark定义`--bg-color`等不同名称，**它们不是同名声明竞争**。不能为了修不存在的冲突添加重复属性选择器或!important。

SA-4实测进一步发现派生变量问题：在html定义的`--rule-*`和`--shadow-hard`已用亮色求值，子级body重定义`--c-*`不会重算它们。父级已把暗色声明改为同一根节点的`html[data-ui-style="standard"]:has(> body.dark:not(.companion-mode))`，令牌值均不改，暗色条件仍来自既有body.dark。这样基础色与派生变量在html一起求值后继承，亮暗边框/阴影均正确。永久浏览器回归`tests/redesign/tokens-isolation.js`实测23项通过，包含真实暗色边框/阴影颜色、陪伴进入退出、notebook、缺属性和减少动效。

### 6.2 加载状态

SA-3交付当时尚未加载，原阶段禁止SA-3自行接线。后续SA-4/6交付评审后，总负责人已仅在standard分支加入 `memo-constructivist-tokens` 与 `memo-constructivist-components` 两个全新id，notebook加载分支与Live2D时机保持原样。SA-8轮1已确认真实加载；仍不能把局部测试当作整体视觉验收。SA-5已交付3264B布局，总负责人随后仅在standard分支追加 `memo-constructivist-layout`；三份新shell CSS初始合计30163B。独立布局复跑通过；SA-8轮2冻结不通过，联合负例发现组件间接移动保护设置组。轮2修复将设置/顶栏降为不改几何的paint-only并补AI工具条，shell当时29965B，正式联合六context/12保护对照通过。轮3冻结后追加仅主域小target32px规则，现组件20564B/shell30520B，保留原20009B前缀逐字一致；用户因实证入口-2px冲突唯一批准autoRefreshToggle维持28×28，其他具名控件仍32。现版本定向六context已exit0，30保护pair0、132具名尺寸通过（120≥32/12toggle获准28），served==disk三CSS哈希相同；不据局部通过宣称最终验收。
iframe内是`html.memo-standard`，本CSS不匹配；SA-6须用既有注入机制与主主题分支另行落地，不能假设外壳令牌穿透iframe。

### 6.3 本轮验证边界

验证限定独立浏览器测试页，不访问或改写产品DOM、不加载到产品页面、不使用真实数据库。测试检查CSSOM可解析、standard light/dark变量、companion切换前后、notebook零匹配、工具类不命中陪伴根及子孙、reduced-motion时长归零。

这些检查不能代替真实产品的三档分辨率截图、陪伴像素零差异证明、点击区域与字体目视审查。此前声称令牌“合格”或“零泄漏完整证明”应降为局部证据。本轮未完成产品视觉验收，也不声称视觉正常。
