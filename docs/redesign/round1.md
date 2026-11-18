# SA-8 第 1 轮独立回归

## 结论

**不通过，不能作为最终视觉验收。** 本轮已停止扩展并释放所有权。父级最新通知紧急修复“父壳认识/模糊/忘记悬浮按钮遮挡原生快捷键说明关闭入口”，优先由父级实施；本轮证据是该修复前的快照，不代表后续产品状态。未进入轮2、轮3或SA9，未修改任何产品文件。

## 范围与证据

- [写前检查](round1/prewrite.md)。已读[SA4](sa4-components.md)、[SA6](sa6-study.md)、[设计系统](design-system.md)、[禁区](forbidden-zones.md)及[source-before加载器](source-before/js/ui-style.js)、[原iframe皮肤](source-before/css/maimemo-standard.css)。
- [独占脚本](../../tests/redesign/round1-audit.js)、[结构化原始结果](round1/summary.json)、[截图日志快照](round1/capture-progress.txt)、[严格像素差异](round1/strict-pixels.json)。原始PNG未修图、未mask、未暂停GIF。
- Edge独立headless无持久化context；仅55395，未连接/刷新/读取9337，未登录、答题、保存或访问用户数据库。旧服务未重启，不能宣称新Python注入常量已上线。
- 3尺寸1280×800、1440×900、1920×1080 × standard-light/standard-dark/notebook；每组welcome/dashboard/settings/article，共36个必需状态，另6个主主题tile fullscreen。共42状态，66张PNG（含12手账disabled及12陪伴对照截图）。
- 3组启动存储原样为 memo_ui_style=standard/theme=light、standard/dark、notebook/light。所有暗色welcome实际body带dark，没有借用历史6个暗色例外。欢迎通过#welcomeSettingsBtn与#closeSettings真实关闭。
- 产品页面唯一测试变更是现有两份新link.disabled切换；notebook没有添加强制link。fixture是另起随机本地HTTP的独立HTML，不是产品DOM/真实登录页。

## 逐项结果

| 项目 | 结果 | 证据与限制 |
|---|---|---|
| 最新CSS实际加载 | passed | standard两份新link loaded=true，末尾tokens/components；notebook无两份新link。JSON逐状态记录 |
| 3尺寸三主题4必需视图 | passed | 42状态完成，页面pageerror为0；真实dark welcome三例齐备 |
| 页面横向溢出 | passed | 42状态document scrollWidth不大于clientWidth |
| 所测控件水平裁切 | passed | 所有状态clipped=[]；仅几何筛查，不等于文字/垂直裁切目视通过 |
| shell新增CSSOM | passed（有限） | 真实CSSOM 69规则，守卫前缀与陪伴排除见rules；永久token测试23项通过。未完成逐项自动断言汇总，不冒充全静态规范通过 |
| companion-mode新选择器 | passed | 六例所有新规则总命中0 |
| companion全非custom computed | failed/未获零差异 | 六例每例716元素，236项差异，含205矩形差异；动态study-web-loading由block转none、opacity/transform等。尚未建立稳态因果，不能断言是CSS污染，也不能称零差异 |
| 正常设置保护子树及角色组 | unverified | 首轮脚本误用.settings-group，实际是.setting-group，故只覆盖31元素，不含要求的角色组。所测每例computed属性差异0但1矩形差异。脚本已更正拼写但父级要求停止，未重跑；不可引用成209元素完整验证 |
| notebook全页面非custom computed | passed（自然加载） | 12例每例完整document及::before/after，所有非自定义属性+矩形差异0。两份新link本来不加载，disabled是空操作；不是强制加载压力测试，永久token测试承担该负例 |
| 原始PNG严格零像素 | failed | 18对全部非零；手账176–4742像素，陪伴50367–63793像素。不mask，不使用stable region替换全图结果 |
| 真Live2D模型 | unverified | 隔离库素材不等于complete角色绑定，当前fallback；未用canvas存在冒充真实模型 |
| >=32px点击目标 | failed | 主壳heatmap nav26×26、today高26、palette-swatch高22，六个主主题配置一致；禁区角色/语音控件更小但不得擅自改 |
| 圆角/渐变/柔影整页 | failed/待SA5 | 主壳H1仍gradient、topbar旧shadow；设置外框保留原rounded/soft shadow保护角色组，不应为了统一污染禁区 |
| blur/transform残留 | failed | CSS fixture实测TTS blur8，hover translateY(-1)，active translateY(1)，虽然新radius/shadow已覆盖 |
| native导航hover | failed | CSS fixture真实hover back：背景rgb(234,242,255)、文字rgb(37,99,235)，旧蓝色胜出 |
| native导航暗色/旧focus | unverified（源码风险确认） | 原CSS暗色direct-child与旧TTS focus规则仍在，独立fixture未运行到dark/focus完整证据；应以更具体新守卫覆盖，保留旧禁区代码 |
| 焦点 | unverified/需复测 | article后一次Tab落到被保留的#companionModeBtn，auto1px outline；这是禁区入口，不据此要求改它。未测到目标新按钮的focus，不能拿该结果证明设计焦点通过 |
| contrast | unverified（规范数据已知） | SA4所报主按钮亮4.858/暗5.570不是本轮独立复算；SA3已知10组组合风险仍需实际用法检查，不能把令牌值存在当对比度通过 |
| loading三短条 | failed | SA4明确未实现；源码仍旧spinner，不能靠停止旋转算达标 |
| fullscreenModal | unverified/覆盖缺口 | 本轮tile-fullscreen是tile全屏，不等于#fullscreenModal实际弹窗；SA4未覆盖，仍须定向验收 |
| 空数据 | passed（状态可达） | 所有图表基于隔离库空数据，真实dashboard可渲染；未伪造真实学习统计/完整空态视觉通过 |
| shadow数量上限 | passed（已测状态有限） | 1440主主题可见非inset shadow分别dashboard1、welcome2、settings3、article2；其中旧软影仍不合风格，数量达标不代表样式达标 |
| shell新CSS预算 | passed | tokens6692+components17935=24627B，小于40KiB；SA5布局尚未交付，后续需累计 |
| iframe新增CSS预算 | passed | 新增6975B，小于30KiB；全文件11533B |
| 新字体/图片/依赖 | passed | 素材守卫未发现范围外改动，本轮无新增产品资源或依赖 |
| 真实学习流程与最新浮层交互 | unverified | 用户只本人操作，本代理不替答题/保存；新紧急修复需父级后续验证原生按钮/快捷键关闭入口 |
| 人工美学/文字重叠 | unverified | 当前模型无image input，未目视，不编造视觉正常或美学通过 |

## 原始像素结果

完整18对见[严格差异JSON](round1/strict-pixels.json)。示例：

| 原始截图对 | 非零像素 |
|---|---:|
| notebook dashboard1280 | 1840 |
| notebook dashboard1440 | 1857 |
| notebook dashboard1920 | 1860 |
| notebook settings1440 | 3306 |
| notebook article1440 | 1797 |
| companion standard-light1440 | 63526 |
| companion standard-dark1440 | 59135 |

方法：Pillow RGB读取 + numpy any(channel != 0)，未灰度化、不设阈值、不mask。零computed与非零PNG并不矛盾：GIF与加载时序仍会改变像素。本轮**没有证明禁区零像素差异**。

## 修复优先级与阶段门

1. **P1 当前用户明确优先项**：主主题重复父壳认识/模糊/忘记悬浮层回归原生按钮皮肤，避免遮挡原生快捷键关闭入口。不得替用户答题；保持原生事件、顺序、命中与禁区。此项由父级执行，本轮不动产品。
2. **P1 SA6**：在新增双守卫范围内覆盖TTS backdrop-filter/transform/焦点与导航hover、dark特异性；不要删改旧规则污染companion。fixture已独立证明light blur/transform/back-hover。
3. **P1 SA4/后续SA7**：heatmap nav/today、palette-swatch>=32；loading三短条；fullscreenModal需判定安全边界后覆盖。禁止把角色组旧小控件纳入修复。
4. **P1 隔离验收补证**：修正.setting-group后重测完整保护组+入口+子树；等待真实过渡结束但不暂停动画素材，保留每次原始非零PNG。当前full computed差异不得包装成passed。
5. **P2 SA5既定范围**：主壳H1渐变、topbar柔影、整体网格/留白；设置祖先框不能为统一而破坏受保护角色组。图表调色交SA7，不动数据/生命周期。

**进入SA5/SA7建议**：可把P2作为既定下一阶段任务交接，但不能称轮1通过；须先处理当前用户P1浮层交互及SA6已证实残留，明确记录保护组/真实学习/像素证明仍待后续回归。不得提前轮2/轮3/SA9，不得以缺账号为理由自动全部通过。

## 永久测试与素材守卫

- [tokens永久测试](round1/tokens-isolation.log)：TOKENS_ISOLATION_PASS 23，exit0。
- [study永久测试](round1/study-theme-isolation.log)：PASS 50，exit0。
- [asset_guard](round1/asset-guard.json)：checked1063，outside_declared_editable_scope=[]，全部11个保护片段一致，exit0。相对source-before只有五个声明可改文件变化（tokens/components/ui-style/maimemo-standard/memo_injection）。
- matrix自检未重跑；本轮不是baseline-matrix输出格式，不能套用其历史dark welcome例外通过。

## 测试故障、边界与停止记录

- 主采集完成42状态后，独立fixture将back/home放在同一导航容器并重叠，hover home被back拦截，最终进程exit1。保留summary.failures原文；这是fixture构造失误，不报告为产品home不可点击。已获得TTS/light back真实computed证据；dark/home/focus未执行完，不伪造通过。
- 原脚本设置组拼写已修，但补测尚未运行；--supplement仅跳过42状态入口，尚无稳态补测实现，不应把它当完成命令。脚本当前复跑仍会遇到fixture重叠，需下次在独立fixture中按语义分别展示back/home，不更改产品DOM。
- 运行study-theme-isolation原永久测试时，它内部自动重写了他人sa6/isolation-results.json和injection-addition.txt；当时尚未发现无--out。这是输出范围越界，已立即通知父级；没有改产品或既有测试，不反向回滚他人证据。之后不再执行该测试。
- PowerShell重定向默认UTF16，已机械转码本轮测试log/asset-guard为UTF8。两次内联Node汇总因Windows引号失败，后用简单表达式成功；没有产品写入。
- 依父级最新停止扩展通知，本轮立即落盘释放。所有本代理后台作业已收取（主采集exit1、tokens/study exit0），fixture/server及浏览器在finally关闭；父级55395服务未关闭。无另起常驻服务。
