# SA8 轮2独立综合回归

## 结论

**不通过，有限采集已完成并冻结，所有权释放。** 普通设置三份新CSS联合禁用负例出现受保护组及陪伴入口矩形变化；AI分类工具条仍有9个30px控件及旧配色/圆角，两项P1已交父级。代理未修改产品。轮1报告及18对原始动态非零截图保持冻结；本轮不进入轮3或SA9。

## 范围和复现

只写新[审计脚本](../../tests/redesign/round2-audit.js)、本文和根[round2证据](../../round2/provenance.json)。已读worklog尾部、acceptance-status、SA4/5/6/7、轮1报告、轮1脚本与确定性准备脚本。现有55395服务不重启；独立无认证headless Edge，仅现有UI入口，未连接9337、真实账号或真实DB，未答题/保存。父级独立layout永久测试不重复。

```powershell
node tests/redesign/round2-audit.js --out round2/run01 --mode all --python C:/Users/Matey/miniconda3/python.exe
node tests/redesign/round2-audit.js --out round2/diagnostic01 --mode diagnostic
```

`--out`必填，限根round2的新子目录；已对存在的run01执行拒覆盖负测，浏览器启动前exit1，旧证据未覆盖。语法检查exit0。apply_patch命令不可用（探测exit1），手工新增/精确编辑使用提供的write/edit工具。产品当前SHA256与字节记录在[provenance](../../round2/provenance.json)。

有限矩阵：1280×800、1440×900、1920×1080 × standard-light / standard-dark / notebook，每context welcome、四种dashboard布局、settings、article、六图表、实际全屏、companion及companion-settings共16状态，目标144状态。dark在init storage即为dark，不复用亮色截图。每态记录实际theme/body/三link/CSSOM selector主体（移除伪元素）/overflow/control rect/小target/渐变/blur/shadow/水平裁切/pageerror。原始PNG不mask/crop/freeze；动态禁区前后同一tab保持原clock。

静态矩阵：notebook dashboard/settings/article、standard companion、notebook companion ×三档×自然加载/强制加载三link，共30个独立context。仅测试route精确替换既有22GIF manifest首帧，先正常初始化、字体图片加载、自然过渡结束，再固定Date/timers；不修改原GIF或产品DOM。强制link只添加在独立测试页。静态零差异不是动态、真实Live2D或人工审美证明。

## 已确认P1

[普通设置1280完整对照](../../round2/run01/normal-settings@standard-light@1280x800-protection.json)：245元素，每次352065项非custom computed（主体及::before/after）和全部DOMRect字段。computed值差异0，但369个rect字段变化：入口x643.1875→643.6875，角色组首根y1095.890625→978，122元素的y/top/bottom发生变化。主明暗三档均复现。不是稳态加载噪声：页面自然等待后通过[单link诊断](../../round2/diagnostic01/summary.json)复现。

| 单独disabled | 保护差异 | 定位 |
|---|---:|---|
| layout | 0 | 入口和所有保护组不变；H1宽145.171875、letterSpacing normal不变，排除layout/brand归因 |
| components | 369 rect字段 | 入口+0.5px；前三非保护普通组高度145.890625→128.5、227.5625→205、475.84375→407.5，前置重排推动保护组 |
| tokens | 369 rect字段 | 入口+3px、角色组y→886；消费者仍开而token缺失的依赖压力，不当作独立正常基线 |

根选择：`#companionStudy`及后代、`#companionModeBtn`、含`#companionLanguageSelect/#ttsStatusText/#live2dCatalogSearch`的三个单数`.setting-group`及后代。旧215集合=入口1+三个组17/165/32；本轮额外完整companionStudy30，因此245。进入companion后子树自然增加，集合323，不裁剪为215；每次都全量比较且≥209。[诊断根id与各组rect](../../round2/diagnostic01/summary.json)已落盘。

## 其他发现与边界

- **P1 / failed：AI分类工具条**九个select/date/range控件高30px，低于32px，仍radius6和旧灰/橙配色，非角色禁区；见[1280实际状态](../../round2/run01/chart-aiclass@standard-light@1280x800.json)。主明暗三档均复现，父级已接收修复，不在本轮改产品。
- **unverified：toast、真实loading瞬态、更多全屏路径**未在本有限矩阵覆盖；不重复专项fixture，不将前序通过冒充本轮独立通过。实际growth图表全屏可由原按钮到达并记录modal.show/canvas，但无真实学习数据，更不等于真实原生学习全屏或保存流程通过。
- 设置祖先旧softshadow/圆角是既有保护收缩，不为统一风格修改角色区域；companion/notebook渐变或blur不是主主题污染结论。
- 六图表是隔离库空数据实际状态；canvas存在/尺寸不是非空真实业务证明。SA7[父级19932项](sa7/lead-review/result.json)及直接options/function/formatter数值相等证据联合用于JS禁区。禁用CSS不能撤回已执行chart paint；main enabled/disabled截图仅shell CSS变化证据。
- `realCanvasProven:false`：companion缺完整角色绑定、显示fallback，不宣称true model。真实原生说明此前父级实点验证属于前序证据，本轮不代替用户答题/保存。
- 当前模型无image input；没有人工图像审美、具体字形或目视重叠通过声明。水平裁切仅几何筛查，不能代替目视。

## 逐项判定

| 项目 | 当前判定 | 精确条件或边界 |
|---|---|---|
| 三份shell CSS预算 | passed | tokens6692+components20207+layout3264=30163B<40000B；采集开始SHA256落盘 |
| iframe新增CSS预算 | passed（前序源码） | 累计8721B<30KiB，沿用SA6报告，不称本轮重新运行其专项测试 |
| 实际三link加载 | passed（主主题） | link存在、sheet loaded、非disabled、rules非空；notebook自然不加载 |
| dark welcome | passed | 三档均初始化storage dark，实际body含dark |
| 普通设置保护computed+rect | failed / P1 | 六组每例245元素；非custom主体/伪元素值0，rect369字段变化 |
| companion设置保护computed+rect | passed | 六组每次完整323元素、464151非custom主体/伪元素属性及全部rect，三link联合disabled差异0 |
| 页面错误/横溢/水平裁切 | passed（有限） | 144状态pageerror0、document横溢0、控件水平裁切0、所测文字水平裁切0；几何筛查不代替人工视觉 |
| ≥32px主域点击目标 | failed / P1 | AI分类九控件height30，主明暗三档；禁区旧小控件单列不修 |
| 原始动态PNG严格RGB0 | failed | 已采禁区对照非零，保留全部未修图PNG；不因computed0称像素0 |
| 静态帧样式隔离 | 部分passed / 部分unverified | 仅授权22GIF frame0 route、正常初始化后固定时钟；notebook settings六例字体loading，拒绝形成像素proof，不归CSS污染、不补跑 |
| 图表禁区JS options | passed（联合前序证据） | SA7父级19932项直接before/after options/function/value；本轮CSS toggle不证明JS回退 |
| 图表可达/实际全屏 | passed（空数据有限） | 六种选择、growth fullscreen原按钮；无真实统计数据 |
| 全主域圆角/softshadow风格 | 未整体通过 | AI工具条旧radius6；设置祖先softshadow属于保护收缩，不要求污染禁区 |
| toast/loading瞬态/原生学习全屏 | unverified | 不扩展本轮有限矩阵，不冒充专项fixture |
| true model/真实答题保存 | unverified | fallback、realCanvasProven:false；用户本人控制真实业务 |
| 人工美学/字形/目视重叠 | unverified | 当前模型无image input |

## 有效性与工具失败

静态notebook settings六例在正常加载、自然等待、`document.fonts.ready`与图片decode后，实际computed遍历又触发字体加载，`beforeClock.fontStatus=loading`。目标settings可见、UI623元素、可见图片完整加载，但脚本在固定clock/截图/像素比较前拒绝该case。因此这六例是**invalid/unverified，非CSS像素污染**；未生成假的零proof，也未补跑或覆盖。动态settings notebook三张原始PNG仍保留，其metrics同样记录fontStatus loading，不能称字体稳态通过。后续可在新轮次先预采computed再等待fonts.ready并二次确认，不回填本轮证据。

## 最终统计

- 主采集自然结束，**exit1**：144状态、12保护对照、30静态case，12条运行失败=六个普通设置P1+六个静态字体有效性拒绝。AI工具条P1来自实测指标人工汇总，并非另加自动退出条数。[原始summary](../../round2/run01/summary.json)、[聚合结果](../../round2/aggregate.json)、[240张原始PNG索引及SHA256](../../round2/evidence-index.json)。采集期间三CSS起止哈希一致。
- 动态18对全部computed/pseudo/rect差异0，但严格RGB非零**1081–42999像素，18/18非零**。例如notebook dashboard1280=1700、settings1280=3714、article1280=1498、standard-light companion1440=36323、notebook companion1440=42999。新截图不抹去旧轮1的18对非零。
- 静态30例：**24 passed RGB0，6 invalid/unverified**。dashboard、article、standard companion、notebook companion各6例（自然/强制×三档）全部0；settings六例因fontStatus loading拒绝形成proof。有效例目标可见、字体图片loaded、UI非空、GIF精确route命中、时刻和倒计时一致；需要有新link的case三sheet非空19/56/16条、主体match0（包含layout）。自然notebook无三link是自然加载隔离，强制例才是三link非空负例。所有有效例原GIF哈希未变。
- 24静态零proof仅是**静态帧样式隔离**，不证明真实动态图、true model、人工审美或原始动态RGB0。standard companion自然和强制均使用真实已有三links；notebook强制仅独立页临时添加，不修改用户窗口。
- 6组main shell CSS enabled/disabled原始PNG亦非零（1016661–2067179像素），仅说明shell CSS变化；既有chart JS paint未撤回，不作JS隔离proof。
- 独立[完整性验证器](../../round2/verify.cjs)检查680项，**exit1**，六个无有效enabled/disabled的settings case产生51项缺失/不满足条件；未把它们静默跳过。其余629项通过，包括24有效静态例的非空、rule主体、clock、link开关、严格RGB和原文件保护，以及144动态原始PNG存在及起止CSS哈希。[完整性结果](../../round2/integrity.json)。这不是产品通过率。
- [单link诊断](../../round2/diagnostic01/summary.json)exit0；脚本语法和定向diff --check exit0；拒覆盖负测按设计exit1。两个后台job均已收取，独立浏览器finally关闭，55395原服务未停止，无仍运行采集任务。

**释放与阶段门：** 本轮工具、报告及证据冻结，父级可按已收到的两个P1修产品；不回写本轮为通过，不自行进入轮3/SA9。其他业务、字体稳态和人工视觉缺口仍明确unverified。
