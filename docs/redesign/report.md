# 主界面重设计报告

状态：**执行中，未最终验收，不得据此发布**。用户已允许按证据组织本九节报告。以下缺口显式列出，SA-9未通过前不标记整体完成。

## 1. 任务与阶段

目标为 Memo Superform 主主题的构成主义 × 古典雕版排版，保留全部学习与设置业务。阶段顺序固定为0、SA-1、SA-2/3、SA-4/6、SA-8轮1及修复、SA-5/7、SA-8轮2/3、SA-9。

当前已完成SA-5/7交付、接线与父级独立复核；SA-8轮2已冻结不通过，两项P1已修复并正式联合复测通过。SA-8轮3已完成冻结，真实exit1，144状态/12保护/30静态完成，原始结论不通过；小控件非冲突修复及六context定向复核已完成，SA-9独立审稿已完成，结论不通过。[工作日志](worklog.md)保留阶段和失败记录。

## 2. 改动范围

已接入主主题专属令牌与组件CSS。原生网页皮肤在既有 `memo-study-skin` 通道内追加双守卫规则；注入同步只新增一行视觉类条件，不新增观察器、计时器或学习事件。[布局](sa5-layout.md)已仅在standard加载器接入并通过八context独立复跑；[图表配色](sa7-charts.md)通过父级19932项独立复跑。

保留所有既有未提交改动，不reset/clean/stash。当前产品变化限定于三份主题CSS（tokens在阶段快照清单已存在，不称三份都原先不存在）、原生主皮肤追加、standard加载器三行、纯视觉注入同步一行和charts纯paint。组件v4修复已纳入现产品，轮3其他非AI小尺寸控件尚待判定修复；[源码快照清单](source-before/assets-sha256.json)是本次边界基准，不以HEAD冒充任务前源码。

## 3. 设计系统

沿用批准的纸墨朱令牌、系统衬线/utility字体，不新增字体或图片。主操作暗色使用既有vermilion-2配paper，避免低对比原朱底；派生暗色边线与阴影在同一html节点求值。[设计系统](design-system.md)与[令牌永久测试](../../tests/redesign/tokens-isolation.js)记录规范和23项检查。

轮2修复时组件20009B、shell29965B；轮3后非冲突32px修复正式追加555B，现组件20564B（SHA256 `3ad830841b35e3df402094b47d5031b1e498c5036acee44545042f1952befe2d`）、令牌6692B、布局3264B，shell合计30520B，低于40000B；iframe累计追加8721B，低于30000B。[AI工具条修后真实产品检查](sa4/fixes-round2/product-ai-toolbar01/result.json)明暗各10控件均≥32px、圆角0、纸墨配色严格通过且canvas正面积。主图表硬palette顺序不变，六套热力图通过仅颜色混合映射保留原选择、阈值与存储；[父级独立图表结果](sa7/lead-review/result.json)19932项通过，旧范围options与函数深相等，主范围业务数据不变。

## 4. 禁区证明

[素材守卫](../../tests/redesign/asset_guard.py)最近检查1063公共资产，声明范围外变化为空，16个受保护共享片段一致。SA-7交付后父级再次运行通过，七个变化文件均在声明范围内，五段图表业务核心逐字保留。

[组件独立复核](sa4/lead-round1-review/result.json)：六context，215受保护元素、每例102985非自定义属性及矩形差异0，但比较基准为组件轮1修复前后，不等于所有新样式关闭时的原页面。**SA-8轮2联合三link负例已发现P1：保护子树样式值0差异但位置受前置设置区高度间接影响，入口亦半像素移动；当时未满足禁区矩形零差异。**轮2保留原始证据，不改写失败。随后v4正式产品[联合隔离](sa4/fixes-round2/product-v4-joint01/summary.json)明暗三档六context/12对，normal245与companion323全部noncustom computed、伪元素及rect差异0，额外topbar全部控件rect0；此为修复后独立新证据，非回填轮2。

[确定性独立对照](deterministic-prep/lead-verified-1280/summary.json)：1280×800手账dashboard与主主题companion，各0/1024000 RGB差异，22 GIF按原尺寸首帧呈现。仅测试、仅现有两份CSS；手账links自然不存在，不是强制加载负例；companion为fallback，非真实模型。[轮2](round2.md)新增三尺寸/三links自然及强制加载矩阵：30例中24例严格RGB0，6例手账设置因字体loading有效性门拒绝，未伪报零差异。轮3预热已解决字体门，但晚安装05Z时钟与初始化真实epoch截止点混用，又导致countdown不等和部分41项computed变化，不能形成有效静态proof。仅只读根因分析完成，[同epoch固定Date定向复验](../../round3/clock-recheck-01/REPORT.md)已仅两case一次运行，整体exit1：dashboard1280自然无links，644元素含隐藏/伪元素computed及rect0、严格RGB0/1024000，Date/倒计时/字体稳定；settings字体仍loading，尚未安装clock和形成pair，仍invalid。随后[第二次定向复验](../../round3/clock-recheck-02/REPORT.md)采用最多3次完整隐藏/伪元素字体预热，两个case均有效通过：dashboard第1次loaded、settings第2次loaded，每例644元素computed/pseudo/rect0和严格RGB0/1024000，原1065文件与22GIF/manifest起止一致，exit0。仍仅两点natural无links，不替换原30invalid或强制加载矩阵。基于同一有效字体/时钟方法，原5状态×三档×natural/forced共30case的新静态矩阵一次采集已结束，原始exit1/provenance起止一致，29例computed/RGB0、1例真正状态失配非零；[独立阶段化校验](../../round3/static-recheck-01/offline-validation.json)实际exit1，311检查305通过/6失败（拒绝请求非零、总错误不能全归sheet门、该文章case计算/状态/错误及全RGB门）；原run11通过/19失败，不能将29个局部零差异扩大为矩阵通过，失败不补跑；采集中发现禁用态错误复用启用态loaded/非空检查，而disabled后link.sheet可为null，故原始run将保留失败事实，采后仅独立按启用/禁用两阶段正确门复核原证据，不中途修改脚本或重写raw。第15个新case（手账文章1440natural）另出现真正严格RGB2641/1296000、max194非零，不能归于该sheet检查错误，已保持失败并仅离线定位。[该例离线诊断](dynamic-analysis/static-article-1440/REPORT.md)实际computed/rect48非零：countdown9:34→“更新失败”、刷新组宽129→139使顶栏右区左移10px，差异全在顶栏非IMG/canvas/textarea；三新link自然不存在且字体loaded。此对跨主机挂起/恢复，Date固定但performance与真实窗口跨约141分钟，支持时序/业务状态失配，不当作CSS污染或通过证明；图表JS仍以直接options检查证明，不以CSS开关冒充。

## 5. 截图与视觉验收

[基线索引](baseline/index.md)含153组合及6个明暗例外，不能统称完整暗色基线。[轮1报告](round1.md)冻结为不通过：18对原始动态图均非零，原始证据完整保留；确定性静态帧对照不替换这些结果。

当前模型不支持图像输入，截图成功不等于目视检查通过。SA-8轮2已冻结144状态、240张原始PNG；144状态页面错误/横溢/水平裁切均0，原始禁区动态18对RGB仍全非零（1081–42999像素），不能据静态24例通过改写。[轮3](round3.md)已冻结144态、228原始PNG，12保护对照均0、六AI专项通过；原始动态18/18 RGB非零33–42036，静态30/30 invalid（24例computed41非零；6例虽computed/RGB0但倒计时不同）。[原始动态离线定位](dynamic-analysis/REPORT.md)对18对一次严格重算一致：共293768差异，289707位于IMG矩形并集、1801位于倒计时矩形、2260为settings候选矩形外残余；最小33全在倒计时，不得全归GIF。空间相交不等于像素源因果证明或真实canvas。人工美学/字形与重叠审查仍未完成。轮3已确认非AI主域小控件P1：layout按钮高30、自动刷新28×28与间隔高20、图表选择高26/全屏28、趋势范围高24、文章关闭28及一按钮高31.796875。不能将AI专项扩大为全域32px。独立route诊断已确认其余候选32px可保持保护0；自动刷新按钮宽28→32则使保护入口左移2px。用户随后明确批准唯一`autoRefreshToggle`保留28×28、入口零位移，其余控件仍修32px。轮3已释放产品采集冻结，非冲突候选已正式合入，[真实产品六context复测](sa4/fixes-round3/REPORT.md)已exit0：30组完整保护对照及入口位移0，132次具名尺寸测量通过（120次≥32，12次刷新28×28按唯一豁免），480项非保护顶栏矩形字段变化保留；三份CSS独立HTTP GET与磁盘hash一致，产品再次冻结；不额外豁免其他控件。

## 6. 学习交互与原生图层

用户优先要求的重复判断栏遮挡原生说明已修复：[专项报告](native-answer-fix.md)。真实登录主主题原生说明确认中心父页命中IFRAME、子页命中原生确认；实点关闭成功。原按钮position、z-index、尺寸、事件顺序保留，持久注入已真实生效。

78项独立层级fixture覆盖三尺寸明暗与原节点移至全屏；193项独立原生皮肤测试覆盖四态。真实答题/切词/云端保存仍由用户本人操作，助手没有代提交，不能以fixture虚报真实业务验收。第6轮用户明确选择「尚未检查，全部保留未验收」，因此视觉目视及本人真实业务都尚未确认，不将回答当验收豁免。

## 7. 工程与性能

无新增生产依赖、框架、字体文件、图片或注入通道。原学习逻辑、观察器、生命周期、图表数据函数受字节及行为测试保护。当前轮3后修复CSS预算30520B（性能样本采集时v4为29965B，不能将旧性能原始hash冒充现版本）已核验；隔离未认证六context（每组三次）补充测量已采集，API阻断、无真实学习数据。首个baseline样本有3次pageerror且DOM574与其他baseline625不同，不能以原采集脚本exit0冒充有效性能对照；修正后的[性能证据只读校验](performance.md)由父级独立运行确认exit1/evidenceValidationPassed=false，0新context，原样本不删不改；首采集exit0仅是旧脚本漏门事实。当前仅确认字节预算与无新增静态JS依赖，不能闭合加载性能无回退，更不外推到云端或真实模型。不得仅据无新依赖声称性能无回退。后续[单次有效性pilot](performance/pilot-01/REPORT.md)首错即停exit1：仅1个baseline context，HEAD已命中route但requestfinished完成标志未成立，初始化门超时；pageerror0、初始DOM625/body606和具名控件正确不等于稳定或跨组通过，current未创建，起止资产/source一致，未补跑，仍无性能结论。第7轮[HEAD观察契约离线澄清](performance/head-contract-round7.md)确认routehit在fulfill之前记录、旧结果未保存HEAD状态或serverStatus，无法唯一归因；新候选纯门35项离线正反例通过，但未接入采集器、未运行浏览器，不追认旧pilot有效，也不当作性能证明。第8轮[候选事件观察层](performance/head-observer-round8.md)实现提交后请求身份绑定、allHeaders凭据检查、导航失效及异步竞态拒绝，合计68离线unit通过；独立审查发现并针对闭合候选代码缺陷，未接入collector、无真实DOM读取或浏览器验证，不改变性能与SA9未验收状态。

## 8. 测试与限制

[完整回归实录](round1/followup-full-regression-pass.log)：551项Python、五组浏览器脚本、JS契约、发布守卫及diff检查通过。此前quality-hardening测试依赖圆角角落获得父焦点而失败，改为显式父容器focus，原业务断言保留并完整重跑通过。

比较器8项自测、矩阵验证器24项自测通过；原生层级78项、皮肤193项通过。[接线后完整回归](integrated-regression-pass.log)再次通过551项Python及全部浏览器脚本；此前文章面板可见性即时断言抢在异步账号状态返回之前，产品未改，仅测试显式等待输入框visible并保留原断言。[轮2修复后完整回归](round2-fixes-regression-pass.log)再次通过551项Python与全部浏览器脚本，父级另独立tokens23/native78通过；1063资产/16片段再次通过。[轮3后修复完整回归](round3-fixes-regression-pass.log)由父级运行，551项Python、全部五组浏览器、JS契约、发布及diff检查真实exit0/REGRESSION_SUITE_PASS，另tokens23/native78真实exit0，1063资产/16片段范围外变化0；正式联合位置隔离证据已列第4节，父级另[真实产品quick独立复跑](sa4/fixes-round2/lead-product-v4-review/summary.json)1280明亮normal245/companion323及topbar均0。业务回归不能替代第三轮完整矩阵、动态像素或人工视觉。

[真实模型证据](baseline/real-model/REPORT.md)显示公开素材76文件哈希一致，但缺完整角色绑定，fallback不能当作真实canvas；未复制私人语音或伪造角色绕过门禁。真实完整角色展示、真实云端操作、图像能力审查和最终禁区矩阵仍未完成。第6轮明确询问合法完整角色绑定前置条件后，用户选择「暂不提供，保留真实模型未验收」；这不是验收豁免，不伪造资料或绕过binding，fallback仍不能当真实模型证明。

## 9. 独立审稿与结论

[SA-9独立审稿](sa9-review.md)已完成，结论为**不通过**；本次没有新增已证实的当前实现bug，但硬验收证据仍未闭合，不得发布或标记持久目标完成。轮2两项P1和轮3非冲突小控件P1已修复，唯一toggle28获用户豁免，六context真实产品30保护对照和132具名尺寸通过。原始动态、静态矩阵、真实模型、人工视觉、真实学习与性能有效性缺口仍保留，不以局部回归替代最终证明。[第6轮独立补证复审](sa9-followup-round6.md)再次明确不通过：新29局部零差异不覆盖1例状态失配与网络有效性门失败，性能pilot也未形成有效比较；没有新增已确证产品bug，不能据测试缺口臆造修复或发布。第9轮再次核对，完整合法模型绑定与人工视觉/本人学习保存仍按用户选择未提供或未确认，已连续第6–9轮存在；[验收交接](acceptance-handoff.md)明确停止以新增离线工具替代验收，技术静态/动态/性能缺口亦不豁免。源码资产守卫本轮复核1063项、16保护片段通过，不能据此完成目标。
