# SA8 轮3独立综合回归

## 状态

**不通过，有限采集与证据校验已完成并冻结，采集所有权已释放父级。** 当前仅新增轮3脚本、本文和根round3证据，未修改产品。轮2、report、acceptance与其他tests不改写；SA9由独立执行者另行进行。新未满足为主域小点击目标（后续唯一刷新开关豁免）；原始动态18/18严格RGB非零；静态30/30因完整计算或倒计时有效性门invalid，不能声称闭合。

## 范围与方法

实际产品基线：components20009B SHA256 `69bb103297aed39edc301dea23222402363b2ee29a76210100348db9013870ae`，tokens6692B、layout3264B，合计29965B。只使用独立无认证headless Edge与既有55395服务；不连接CDP9337，不读取用户浏览器、凭证、cookies或storage，不访问真实账号数据库，不答题、不保存。init只写测试主题localStorage。测试context拦截并拒绝非55395来源或非GET/HEAD请求，不重启服务。

```powershell
node tests/redesign/round3-audit.js --out round3/run01 --mode all --python C:/Users/Matey/miniconda3/python.exe
node round3/verify.cjs
```

[轮3脚本](../../tests/redesign/round3-audit.js)沿用轮2实际UI语义，不以fixture冒充实际状态。9contexts为三档1280×800、1440×900、1920×1080 × standard-light/dark/notebook；各16态为welcome、dashboard四布局、settings、article、六图表、growth fullscreen、companion、companion-settings，共144态。主明暗普通设置245与companion设置323受保护元素全量比较非custom computed及::before/after、全部DOMRect，并额外比较全部topbar button/select矩形。

主AItoolbar检查实际select/input/range/button共10控件：宽高至少32、radius0、纸墨或反转严格RGB；可见canvas尺寸positive不等于业务数据正确或真实模型。

动态18pair保留原clock和原始整幅PNG，严格RGB逐像素比较，不mask/crop、不替换GIF，不未经定位将非零全归GIF。静态30case=notebook dashboard/settings/article、standard companion、notebook companion ×三档×natural/forced三links。只精确route既有22GIF manifest frame0，不改原资源、不复制私有资源。

静态preclock门在目标实际进入后先inspect并遍历全部DOM与隐藏保护子树的主体/伪元素computed，再等待document.fonts.ready、image.decode与自然过渡，再完整computed及inspect确认loaded；最多3次，逐次原始证据落盘。仍loading拒绝形成proof。只有初始化/目标/非空/字体图片稳态通过才安装固定clock；不在安装clock后等字体、不强制font、不删元素。natural notebook缺link只证明自然加载隔离；forced必须三link实际loaded且规则非空，所有主体selector（含移除pseudo后主体）match0。静态亦完整比较computed/pseudo/rect与严格RGB。

## 有效性边界

动态144态页面错误0、document横溢0、控件及文字水平裁切0，但自然截图的notebook settings三档仍记录fontStatus=loading，因此这三张只能作为原始动态状态证据，不称字体稳态有效图。后续静态预热门是独立30case的新证据，不回填这些截图。welcome指标检查的是目标元素可见与几何，并不通过遮挡命中测试证明背后控件实际可点击。六图表与全屏canvas的正尺寸也不证明内容语义正确。

## 最终证据

本轮主明暗三档六context的12个联合保护pair已完成，普通设置每例245元素、352065项非custom computed，companion设置每例323元素、464151项（[完整summary](../../round3/run01/summary.json)）；主体/::before/::after、完整rect与topbarRectChanges均0。六个实际AItoolbar各10控件，宽高>=32、radius0、纸墨严格palette及canvas positive均通过。这仅是具体门的结果，不是整体通过。

## 静态有效性失败

本轮新增full computed门发现clock固定后倒计时并不同步：例如[notebook dashboard1280 natural](../../round3/run01/static-notebook-dashboard@1280x800@natural.json) enabled/disabled Date同为05:00:00Z，但countdown由9:29变114:23；autoRefreshGroup宽129→133.109，topbar-right连带x变化，全页computed/rect共41字段非零。natural无三link仍出现相同变化，不能把这归因CSS污染。[settings1280 natural](../../round3/run01/static-notebook-settings@1280x800@natural.json)预热initial loading→after loaded，固定clock后countdown9:30→119:07，亦41字段非零。说明轮2字体门修正采样有效，但新的完整计算稳态门未满足。脚本在computed非零时停止该case，不产生disabled PNG或RGB0 proof；已生成enabled原图与前后computed/metrics保留。standard companion六例computed0且严格RGB0，但随后Date/countdown门不等，仍invalid，不能计入有效静态通过。最终24个notebook case（dashboard/settings/article/companion各6）computed/rect非零而未形成disabled PNG/RGBproof；standard companion6个case均RGB0/computed0但倒计时不等，最终30/30 invalid、0有效静态通过。不回填、不补跑、不声称已闭合。父级只读分析另指出真实初始化保存的nextRefreshTime与后装05:00Z固定clock混用epoch，随后interval重算倒计时，支持测试时序污染而非CSS污染；这是父级分析，不是本轮重跑或精确tick定位证明。

## 新未满足：主域点击目标

**P1已报父级，审计不修产品。** AItoolbar单项达标不能扩大成全主域控件达标。原始[1280主亮dashboard指标](../../round3/run01/dashboard-single@standard-light@1280x800.json)记录四个layout按钮42×30、autoRefreshToggle28×28、autoRefreshInterval46×20、chart-selector110×26、tile-fullscreen28×28；[趋势指标](../../round3/run01/chart-trend@standard-light@1280x800.json)另四个range按钮高24（宽42.6875/49.359375/49.359375/48）；[文章指标](../../round3/run01/article@standard-light@1280x800.json)关闭按钮28×28，另一个按钮74×31.796875。dashboard-single上述八个小控件在主明暗×三档六context尺寸完全相同。上述具名控件不是companion/语音/角色目录保护子树，不能因既有或本轮未改豁免。指标同时保留保护子树原有小控件，不混为全域修复授权。最终按已采矩阵列明范围，交父级及SA9判定。

## 后续授权事实

采集期间父级转达用户新授权：**唯一autoRefreshToggle可保留28×28，以保证入口零位移；其余小控件仍要求32。** 此事实只影响后续修复范围，不回填历史截图或将其他小目标豁免。审计脚本仍冻结运行，未因授权中途改门、重跑或修改产品。历史八小控件清单中的刷新开关现有明确例外，其余七个及range/article问题仍未满足。

## 结果与退出码

| 门 | 判定 | 证据边界 |
|---|---|---|
| 144态矩阵 | 完成 | 9context×16态唯一覆盖；目标UI非空可见；几何筛查0，不代表目视验收 |
| 三link联合保护 | passed | 12pair，normal245/companion323，noncustom主体及before/after、rect、topbar全部0 |
| 主AItoolbar | passed | 六context，各10实际控件>=32、radius0、严格paper/ink palette、canvas positive |
| 主域其他点击目标 | failed / P1 | layout/interval/chart select/fullscreen/range/article未达32；刷新开关仅后续授权例外 |
| 原clock动态图 | failed | 18/18严格RGB非零33–42036；computed/pseudo/rect均0，不称动态图闭合 |
| 静态preclock字体/图片 | passed（准备门） | 30/30一次预热loaded；settings六例loading→loaded，未装clock后等字体 |
| 三link静态selector | passed（源码作用域门） | forced三sheet非空19/60/16规则，主体含pseudo移除后match0；natural notebook无link单列 |
| 静态完整proof | invalid / unverified | 24notebook计算/rect非零、6standard companion RGB0但countdown不等；0有效通过 |
| 起止provenance | passed | 1065文件起止SHA256一致；含公共资源、三CSS和关键接线文件，不以HEAD冒充 |

[原始summary](../../round3/run01/summary.json)、[聚合结果](../../round3/aggregate.json)、[小控件状态清单](../../round3/small-controls.json)、[原始证据索引](../../round3/evidence-index.json)保留523个run文件、228张原PNG及全部SHA256。228=144状态+36动态保护对+12主域CSS对照+30静态enabled+6静态disabled；缺失的24张静态disabled是门拒绝，不伪造补齐。主域CSS开关六对仅说明shell变化，不撤回已执行chart JS paint，不当作JS禁区证明。

采集真实**exit1**，30条failure为24完整计算门失败+6倒计时门失败；此外末尾dynamicStrictRGBPassed=false参与auditPassed=false和exit1。小目标P1由实测metrics独立报告，不伪称采集脚本已单列其failure。独立[完整性检查](../../round3/integrity.json)1910项、1856通过、54失败，真实**exit1**：6主域小目标门+18动态严格RGB门+30静态有效门；没有静默跳过invalid。此非产品通过率。独立[PNG数值复核](../../round3/pixels-recheck.json)30个已存在完整pair（18dynamic+6mainCSS+6static）全部与原像素记录相同，**exit0**，不是30个pair全部RGB0。

脚本语法检查exit0、拒覆盖负测在浏览器启动前按设计exit1；apply_patch探测不可用、HEAD初次非交互解析失败后UseBasicParsing重试200、一次内联汇总语法错误后修正重试，均不影响冻结证据。工具检查见[记录](../../round3/tool-checks.json)。未对既有轮2/产品写入。现有55395未重启，15个非GET请求被route拒绝。唯一后台job已完成收取，独立Edge finally关闭；采集结束时间2026-11-16T07:06:56.106Z（15:06:56 UTC+8），起止哈希已先完成才释放。父级此后授权产品修复不回写本轮结果，验证器只核对冻结起止清单，不把后续产品当本轮采样版本。

## 限制

当前模型无image input，截图仅数值验证，不宣称人工美学、字形或目视重叠通过。真实完整Live2D缺绑定仍fallback，realCanvasProven:false，不绕过角色/音色门。toast、真实loading瞬态、更多原生学习全屏本轮未覆盖，明确unverified。六图表为空数据实际UI，可达性/canvas positive不能替代真实学习、答题、云端保存或完整业务验收。静态0/计算0不能替代dynamic0、美学或真实学习。
