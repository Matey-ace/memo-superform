# SA5 主界面布局交付

## 状态与所有权

有限实施与验证完成，所有权释放给父级。仅新增布局 CSS、永久测试、本文及根 sa5/** 证据；没有改共享 CSS/JS、加载器、DOM、事件、数据、字体、图片或依赖。由父级决定在 ui-style.js 的 standard 分支接入，当前未接入。未进入 SA8 轮2 或 SA9。

- [布局CSS](../../css/theme-constructivist-layout.css)：**3,264B / 16 条样式规则**，低于 8KB 倾向及 13,101B 上限。
- 当前 tokens 6,692B + components 20,207B + layout 3,264B = **30,163B**，小于 40,000B。
- [永久测试](../../tests/redesign/layout-theme-isolation.js)、[写前检查](../../sa5/prewrite.md)、[最终结果](../../sa5/run02-final/result.json)、[完整测量](../../sa5/run02-final/metrics.json)。

## 实施

桌面 dashboard 最大1440px、12列、24px沟槽；1280侧距48px、1440起侧距64px，1920因最大宽度形成240px居中侧距。天头64px、地脚48px，均使用已有令牌。single跨12列、split2跨6列、split3跨4列、grid4跨6列两行。没有改tile display，实际tile数仍完全由原布局按钮和JS控制。

1100px以下多格纵排、每块至少320px并在dashboard内滚动；768px以下侧距16px、天32地24，header允许换行。420px亮暗全部4模式document无横溢。保留所有控件与原事件，不重新实现导航或图表。

body仅改不继承的background，不添加font/color/line-height；topbar仅改纸底、墨边和清旧softshadow。主H1清旧gradient及transparent text fill，letter-spacing:0。最终保留H1原font/size，不用硬编码brand宽度。系统衬线栈应用在tile标题，字距0。

设置祖先外框、字体、边框和全部设置DOM完全不命中。没有针对study-web-actions或iframe的声明，原`:where(#dashboard,#fullscreenModal) .study-web-actions {display:none}`去重规则不反转。原生iframe内部布局、按钮顺序/位置均未改变；dashboard重设计会自然改变父iframe可用viewport，不冒充原生viewport零变化。

每条样式规则严格以`html[data-ui-style="standard"]:has(> body:not(.companion-mode))`开头，最终目标带`:not(#companionStudy, #companionStudy *)`。未新增鱼尾或象鼻：顶部几何保留优先，不声称已实现这些装饰。

## 验证

命令：`node tests/redesign/layout-theme-isolation.js --out sa5/<new-directory>`。必须显式提供全新目录，拒绝覆盖，仅允许根sa5内输出。已对存在的run02-final执行拒覆盖负测，预期exit1，未覆盖旧证据。测试使用独立headless Edge及55395，未连接9337/CDP，未操作用户登录浏览器，没有答题/保存或DB访问。仅在独立测试页面临时注入自己的CSS，并在before/after切换disabled；设置、布局、主题、陪伴通过已有按钮进入。

| 检查 | 结果 |
|---|---|
| 1280×800、1440×900、1920×1080、420×900 × standard/notebook | 8 context，pageerror0 |
| standard亮/暗 × 4尺寸 × single/split2/split3/grid4 | 32原始截图，tile数1/2/3/4、12列、gap24、宽≤1440、document无横溢 |
| 三桌面 × 亮暗 × 4布局核心几何 | 24组通过：所有tile面积正、边界内；split2/split3等宽同y且按x横排；grid4两行、相邻≥24px，无重叠 |
| 标准普通设置、亮/暗设置、companion设置 | 每次全部实际215元素，≥209；每次102,985项非custom computed及全部DOMRect，before/after差异0，哈希相同 |
| notebook设置 | 强制临时注入layout后新规则命中0；同215元素computed/rect差异0 |
| 缺data-ui-style / companion-mode | 所有新增规则命中0；去除伪元素后检查主体（当前无伪元素规则） |
| strict prefix / target companion exclusion / 保护元素直接命中 | 均错误0 |
| CSS预算 | 3264 / 总30163B，通过 |

[最终运行目录](../../sa5/run02-final/metrics.json)保留44张未经处理的原始PNG及逐次保护集合完整before/after JSON。没有冻结GIF、mask或修改截图。截图读取工具报告当前模型不支持image input，因此**未目视检查，不声称美学、文字重叠或完整像素零差异通过**，也没有用canvas存在冒充真实Live2D。

[独立几何断言](../../sa5/geometry-check.cjs)读取最终原始metrics，输出[geometry-final.json](../../sa5/geometry-final.json)，`SA5_GEOMETRY_PASS 24` exit0。永久测试已补入相同断言；最终主矩阵开始后补入，因此最终主进程本身运行的是此前计数/列数断言版本，新增几何断言由独立脚本对同一原始结果实际执行，不混淆。

## 修订与限制

初版通过主矩阵，但独立CSS zoom压力夹具发现：固定145.171875px品牌槽依赖当前Windows/Edge原字体测量，200% CSS zoom下额外移动陪伴入口；18px衬线H1也在槽中换行。失败[zoom01](../../sa5/zoom01/metrics.json)、[zoom02](../../sa5/zoom02/metrics.json)原样保留。最终已删除固定槽与H1字体/尺寸修改，仅保留paint清理，衬线移至tile标题。不得引用初版为跨字体/zoom兼容证据。

补充[可用CSS宽度模拟](../../sa5/zoom03-effective-viewport/metrics.json)覆盖1280/1440/1920分别除以100%/125%/200%的九种layout viewport，入口rect0、标题无水平裁切，通过。**这不是原生浏览器zoom测试**，不声称跨字体/原生200%缩放验收；原页面200% CSS zoom本身topbar已溢出，未扩大范围修旧行为。

两次CSS zoom stress exit1均已调查并促成上述范围收敛。写前Get-Command确认apply_patch不可用（exit1）；使用提供的write/edit工具。一次内联Node转义失败未改文件，换独立脚本成功。read_image不支持当前模型，未隐瞒或伪造目视。所有独立浏览器在finally关闭，所有后台job已收取，既有55395服务未停止。
