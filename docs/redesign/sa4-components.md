# SA-4 组件样式交付报告

第1至8节保留阶段初次交付的历史记录；**当前SA8轮1结果见第9、10节**。有限验证已完成、exit0，组件CSS及本文所有权已释放；不是最终视觉验收。

## 1. 文件与范围

- 产品交付：[theme-constructivist-components.css](../../css/theme-constructivist-components.css)，**17,935字节**，低于建议18,000字节，50条CSSOM样式规则。
- 文档：本文。
- 证据：[浏览器测量](sa4/metrics.json)、[摘要](sa4/summary.json)、[最终CSSOM契约](sa4/final-cssom.json)、[学习父壳尺寸](sa4/study-metrics.json)。证据脚本和截图仅放在本文同级sa4目录，不是产品JS。
- 没有编辑主题加载器、HTML、令牌、布局文件、共享CSS/JS、字体、图片或依赖；没有连接9337真实登录窗口。
- 未加载到产品源码；全部评估通过55395隔离服务、独立Edge headless context与运行时link完成。现有服务由父级持有，本代理未启动新服务。

## 2. 逐轮写前自检

| 轮次 | 写前检查及实际修订 |
|---|---|
| 01 | 查git diff/status，确认新交付文件不存在；读取最新令牌R2、设计系统、禁区报告、实际HTML及style/article-vocab/study-web/study-web-standard原样式；核对动态文章DOM。只写独占新文件，不改原逻辑/资源。 |
| 02 | 复核新增CSS边界；证据脚本仅存sa4；修正loading目标、active hover与硬阴影限定；不改display/hidden/inert/iframe原生布局。 |
| 03 | 首轮六context运行后发现:is混合ID抬高特异性，导致主按钮与focus未生效；机械改:where保持目标集合不变。撤除设置祖先字体/文字色/行高，减少角色组继承。父级确认父壳工具关闭按钮26/28→32px允许，墨墨原生区域不动。 |
| 04 | 第二轮发现设置新border2令角色组宽432→428，撤销settings-content新外框/背景整条目标覆盖；保留普通组子组件。暗色派生root变量问题在消费者直接使用规定数值+原始色token规避；父级随后已修令牌根暗色作用域，本代理未改令牌。 |
| 05 | 仅机械删除注释、缩进、分号后空格以压缩；无选择器/声明/值语义变化。压缩后独立CSSOM契约exit0，规则数仍50，所有作用域/排除完整，字节17,935。最终报告依据实测，不冒充目视或完整像素验收。 |

每轮手工更改均局限交付CSS/本文及sa4证据。中间一次证据脚本edit匹配失败未改文件，重新按精确文本编辑；一次PowerShell内联Node转义失败未改产品，改为证据脚本执行；HTTP Head探针因PowerShell交互提示失败，真实Playwright访问成功。未忽略这些非零退出。

## 3. 实现清单

| 组件 | 实现与边界 |
|---|---|
| Button | 真实topbar图标/布局/文章入口、dashboard工具、普通设置按钮、欢迎/更新/文章主操作；primary/secondary/hover/active/disabled。陪伴入口不在目标内。 |
| Input / Select | 普通设置和文章输入下划线墨线；保留原生select箭头与表单功能，不改共享accent变量。 |
| Checkbox / Range | 真实文章控件及允许的普通设置控件只改accent；文章checkbox标签/range最小32px。预览checkbox尚未进入真实结果状态，不能声称动态验收。 |
| Modal | 欢迎、文章、应用更新外框使用唯一2px外边+3px/4px inset。设置外壳保守保留旧框，见缺口。 |
| Card Frame | dashboard现有tile双框；文章仅最外层弹窗双框，内部article不再套框，重复词条仅界行。未改dashboard网格与topbar整体布局。 |
| Empty / Loading | 真实rec/study-content/文章notice和empty文字色；既有spinner停止常驻旋转并方角化。尚未实现规格三短条loading，交SA8复核修正，不隐瞒。 |
| 文章选词 | 输入、标题、状态章、条目界行、选择朱线、notice装饰色+ink文字、真实主操作；未点击抽取/提交，未造云端结果。 |
| 主学习磁贴工具 | 仅#dashboard内父壳工具视觉；保留hidden/display/pointer-events和既有定位；关闭按钮最小32px，原26/28px。未进入iframe改任何原生元素。 |
| Toast / Table / Progress / Tooltip | 未发现主主题独立toast/table DOM；progress真实组件属于角色/语音禁区；tooltip由ECharts生成交SA7。不造不存在的DOM或类名，不碰陪伴进度。 |

## 4. 作用域与禁区实测

每条规则均以 `html[data-ui-style="standard"]:has(> body:not(.companion-mode))` 开头。目标均明确排除 `#companionStudy`及子孙。没有bare body/button/p/h1规则，没有!important，没有display/visibility/position/pointer-events/z-index/grid/overflow声明。

普通设置组通过`:not(:has(#companionLanguageSelect,#ttsStatusText,#live2dCatalogSearch))`排除陪伴、语音、Live2D组。reduced-motion也排除这些组与陪伴入口。设置外层不再新增字体、字号、文字色、背景或边框，避免宽度和透明底间接污染。

最终三档1280×800、1440×900、1920×1080的结果：

- notebook强制追加两份link：新组件规则匹配0，所测before/after计算样式及矩形完全相同。
- standard正常模式：组件新规则没有命中陪伴根/子孙。
- 对陪伴入口、角色/语音/Live2D设置组及后代共**209元素**，在同一真实设置状态切换临时样式，全部**非自定义CSS计算属性差异0**。自定义属性不纳入此比较；根新变量本就继承，不将其冒充零变量差异。
- 通过真实入口进入companion-mode：组件allMatches=0；再打开设置，启用/禁用临时样式的完整所测结果完全一致。
- 六组context均pageerror0，所测页面document横向无溢出。
- 此处不是手账/Live2D完整像素零差异证明；动态GIF、真实模型和受保护登录态仍由父级SA8验收。

## 5. 对比度、焦点与阴影

实际article主按钮getComputedStyle颜色按WCAG相对亮度计算：

| 模式 | 字 / 底 | 实测 |
|---|---|---:|
| 亮色 | #EFE7D6 / #B8321F | **4.858011:1** |
| 暗色 | #16130F / #E8634B | **5.570192:1** |

暗色未将原#D2452E作小字主按钮底；没有修改原始颜色token。状态弱色仅装饰，文字使用ink/ink-2。键盘Shift+Tab/Tab真实导航后，focus-visible为**2px solid ink，offset3px**。实测主按钮123.6875×47.1875px；文章关闭与父壳关闭工具CSS最小32px。学习工具在未登录状态隐藏，因此未声称其可见状态实测尺寸通过。

硬阴影只用于欢迎主按钮、设置保存及一枚文章主按钮；文章出现提交按钮时取消挑选按钮阴影；更新主按钮不加硬阴影。实测文章状态可见硬阴影1处。其余版框只有规定inset，无模糊。没有新渐变；对原欢迎标题/按钮渐变进行background覆盖。

## 6. 学习iframe的父壳自然重排

1440×900未登录真实iframe测量：

| 项 | before | after |
|---|---:|---:|
| x | 16 | 18 |
| y | 128.998 | 140 |
| width | 1408 | 1404 |
| height | 755 | 740 |

上述由父壳tile2px边框与header组件排版自然重排引起，**不是iframe内部人为移动原生答题区域**。父级明确保留规定双框，接受父壳重设计改变可用viewport；不放宽原生答题DOM/顺序/点击行为限制。此次学习工具原hidden/display/visibility/pointer-events保持相同。y观测含原页面短暂布局过渡，不能解释成精确稳定差值。未访问任何用户登录窗口。

## 7. 证据与运行结果

- [独立浏览器主探针](sa4/probe.cjs)：最终六context运行exit0，24张主探针PNG；欢迎before/after两主题三尺寸，设置light/文章light+dark/陪伴设置standard三尺寸。
- [结构化摘要计算](sa4/analyze.cjs)：exit0，记录对比度和209元素差异。
- [学习父壳探针](sa4/study-probe.cjs)：exit0，另1张未登录真实学习截图。
- [最终CSSOM断言](sa4/verify-css.cjs)：`SA4_FINAL_CSSOM_PASS`，exit0，50规则、badPrefix0、missingCompanionExclusion0、forbiddenProperties0、important0、17,935字节。
- 示例：[文章亮色1440](sa4/article-light-1440.png)、[文章暗色1440](sa4/article-dark-1440.png)、[设置亮色1440](sa4/settings-light-1440.png)、[陪伴设置1440](sa4/companion-settings-1440.png)、[学习父壳1440](sa4/study-shell-1440.png)。
- 四个本代理后台浏览器job均已收取，exit0，无仍运行自测job。父级现有HTTP服务未关闭。

## 8. 明确缺口与SA8交接

1. 设置content外框/背景维持原样，属于为角色组禁区收缩白名单；不能声称设置整面视觉统一。普通设置子组件已覆盖，角色相关组完整保留旧样式。
2. 当前模型`read_image`明确报不支持图像输入，**没有目视检查截图**；不声称文字无重叠或审美通过。
3. 未完成全部布局/图表状态、更新弹窗可见状态、文章预览/部分结果/不确定/提交状态、真实登录学习状态的动态验收；SA8应独立检查。当前主探针仅single布局。
4. 加载视觉只消除旧spinner常驻转动并方角化，规格三短条尚欠；真实toast/table/progress不存在或属禁区，不新造假组件。ECharts tooltip交SA7。
5. 没有改fullscreenModal外壳和close，仍需SA8指出是否纳入后续安全覆盖。
6. 字体只使用系统栈，计算font-family不等于证明实际字形命中。标题中文大字/字重与三尺寸排版需目视。
7. 父级修令牌暗色根作用域后，其派生token已修；SA4消费者直接使用规定边框/硬阴影数值仍合法，可保留。



## 9. SA8 轮1修复写前自检

- 已重读当前组件CSS、本文、真实layout全屏调用链和热力图工具DOM、原热力图/全屏样式、最新根暗色token，并检查最新git diff/stat。
- 父级新增且用户明确授权的主dashboard判断栏display:none完整保留；这是唯一display声明例外，不误判或回滚。没有改业务JS、原生iframe、token、loader、shared文件。
- 只修>=32px热力图按钮、无动画/渐变/阴影三短条loading；全屏实际也容纳study-web与notebook日记，不宣称纯图表。仅在standard/noncompanion且全屏含canvas且无study-web时覆盖外壳与close。

- 本轮验证期间发现当前保护集合已从209增为215（动态设置内容），断言改为至少209且比较全部实际元素，未缩减集合。CSSOM会规范化逗号空格，唯一display例外校验只归一化空格，不放宽选择器/值。
- 实测热力图旧transition:all会补间focus轮廓，写前复核原样式后仅在新规则覆盖为规范允许的color/background-color/border-color；键盘导航后等待自然过渡完成，不冻结动画。


## 10. SA8 轮1最终交付与释放

**本轮修复完成，文件所有权现已释放；不是全项目最终验收。**

- 当前产品CSS：**20,207字节 / 56条CSSOM规则**。相对最初建议18KB超出2,207字节，明确报告，不伪称仍低于18KB；与当前令牌6,692字节合计**26,899字节**，按总40,000字节预算还余**13,101字节**给后续layout等新增样式。没有新产品JS/字体/图片/依赖。
- 热力图真实nav各32×32，today46×32，palette各68×32或96×32。亮色ink/paper实测**14.509413:1**；暗色**14.508698:1**。真实键盘焦点2px solid、offset3px；旧transition:all已覆盖为颜色属性过渡。
- 两个既有loader使用32×20px盒模型：上下边各4px、上下透明padding各4px、content高4px，background-clip:content-box形成三条等厚横线，无新增DOM、渐变、阴影、动画。实际验证在既有chart节点临时加loading类，明确属于状态夹具；study spinner采用同声明，未登录学习可见态未验。
- 原授权判断栏隐藏规则未删，按父级urgent扩为`:where(#dashboard,#fullscreenModal) .study-web-actions`，保留严格standard/noncompanion与陪伴子树排除。**唯一display声明值仍为none**。不改iframe原生布局、事件、层级或答题行为。
- 全屏调用链不是仅图表：会移入study-web原节点，也可容纳notebook日记。因此本次只在严格主主题且非陪伴、modal含canvas且不含study-web时paint外壳及关闭按钮，未加祖先font/lineheight。学习全屏外框仍旧式，只有授权判断栏隐藏例外覆盖它。未配置隔离库实际缺图表实例，全屏样式验证明确记录`fullscreenFixture:true`，使用临时canvas/show，不冒充真实图表数据交互验收。夹具关闭按钮40×40、方角；颜色快照含旧过渡初始帧，未据此声称全屏颜色实测通过。

### 10.1 永久验证与证据

- [轮1永久验证脚本](sa4/fixes-round1/verify.cjs)
- [轮1结果](sa4/fixes-round1/result.json)
- [轮1逐项摘要及哈希](sa4/fixes-round1/metrics.json)
- [轮1修复前CSS快照](sa4/fixes-round1/components-before.css)
- [1280热力图与loading夹具](sa4/fixes-round1/heatmap-loader-1280.png)
- [1440全屏样式夹具](sa4/fixes-round1/fullscreen-1440.png)
- [1440陪伴设置](sa4/fixes-round1/companion-settings-1440.png)

运行`node docs/redesign/sa4/fixes-round1/verify.cjs`，最终输出`SA4_ROUND1_PASS 20207`，**exit0**。

六context覆盖standard/notebook与1280×800、1440×900、1920×1080，没有冻结GIF/动画；等待既有过渡自然结束，没有连接9337/CDP，没有代答题或保存操作。旧证据未覆盖。

实际保护集合当前为**215元素**，包含原209范围及新增动态设置内容，使用单数`.setting-group`。每次比较**102,985项非custom计算属性及全部DOMRect字段**，并存before/after SHA-256：

| 场景 | 比较范围 | 结果 |
|---|---|---|
| standard普通设置，亮/暗×三尺寸 | 本轮前CSS快照 vs 本轮后CSS，全部215元素computed+rect | 差异0、哈希一致 |
| standard陪伴模式打开设置×三尺寸 | 本轮前 vs 后，全部215元素computed+rect | 差异0、哈希一致 |
| standard陪伴模式打开设置×三尺寸 | 当前CSS vs 禁用本组件，全部215元素computed+rect | 差异0、哈希一致 |
| notebook设置×三尺寸 | 本轮前 vs 后，全部215元素computed+rect | 差异0、新规则匹配0 |
| companion-mode | 包含伪元素主体在内的全部56条规则 | 匹配0 |

全部context pageerror0，选择器前缀/目标陪伴排除错误0，唯一display例外的目标和值断言通过。当前结果不等于全部禁区完整像素验收。

### 10.2 真实失败与剩余边界

本轮5次先前验证退出1均已读取原因并处理，未忽略：旧209固定计数与实际215不符、CSSOM逗号空格序列化误报、旧transition:all补间焦点、未登录无canvas实例、未登录图表入口未打开show状态。前两项只修测试契约精确性，第三项修组件过渡，后两项使用明确标注的样式夹具，不把未登录环境缺口藏成真实验收。最终所有6context断言通过；本代理本轮所有后台job已收取，无仍运行的自测。

仍未目视：当前模型不支持image input。真实有数据全屏图表、已登录学习状态、完整布局与更多交互状态交父级后续SA8；不再在本轮自行扩展。初版第8节中loading缺口本轮已修；fullscreen仅按上文保守条件覆盖，不宣称所有全屏状态统一。设置旧框/角色组原样保留。

## 11. SA8 轮2联合隔离修复与实际合入

父级冻结轮2采集后明确授权，仅修改产品 components CSS。写前重新读取并严格核对原SHA256 `907e0aada271a733472311ca55a0d29f261757011cb457d5a9ff5160e4093dae` 后才合入。当前 **20,009字节**，SHA256 `69bb103297aed39edc301dea23222402363b2ee29a76210100348db9013870ae`。合入为源文本保留型V4 + 已实测主dashboard AI工具栏片段，不是V3；不改tokens/layout/shared/DOM/事件/SA8报告。

- 原始联合开关失败保留于[原始失败控制](sa4/fixes-round2/original-failure01/summary.json)：normal245元素computed0、rect369；证明此前单份CSS或旧CSS前后0不能代表原base0。
- 普通settings和topbar含目标的规则撤回字体、行高、padding、边框宽、min尺寸、transform等几何/排版影响，仅保留paint；禁止对陪伴入口和保护组加补偿。逐条49项记录及36个非目标块逐字一致审计见[源保留审计](sa4/fixes-round2/source-preservation-v4.json)。reduced-motion整块、spinner、article非目标规则及授权nativehide逐字保留。
- V1/V2/V3因CSSOM回吐破坏非目标shorthand和media均不可合入；旧通过记录不作为其完整正确证明，修正详见[轮2 V4报告](sa4/fixes-round2/REPORT-v4.md)。
- [正式产品联合测试](../../tests/redesign/joint-theme-isolation.js)：[六context结果](sa4/fixes-round2/product-v4-joint01/summary.json)，主明暗 × 1280×800/1440×900/1920×1080，normal及companion共12对全部styles0、rect0、topbarRectChanges空，exit0。保护集合完整含companionStudy根与所有后代、companionModeBtn、含三ids设置组全后代；normal245/companion323，全部非custom computed及before/after和8字段rect。三links全新建立后同时enabled/disabled；topbar所有button/select另有完整rect gate。
- [正式产品AI测试](../../tests/redesign/ai-toolbar-theme.js)默认不route CSS，要求--out新目录拒覆盖；[真实产品明暗结果](sa4/fixes-round2/product-ai-toolbar01/result.json)各10控件全>=32px、radius0、实际paper/ink或反色，canvas可见区域非零。只加严格standard/noncompanion的#dashboard .ai-toolbar局部规则；未改AI逻辑。

所有浏览器只读55395独立Edge context、GET/HEAD过滤，无9337/CDP/真实DB/答题/保存。所有本代理后台job已结束并收齐。此处不声称AI业务正确、完整焦点交互、真实登录态或最终视觉通过；native/tokens/full业务和轮3验收由父级独立执行。有限集结束，文件所有权释放。

