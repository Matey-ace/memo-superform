# SA-9 独立审稿

## 结论

**不通过。** 产品保持 freeze，不发布、不标记整体验收完成。本结论基于硬验收尚未闭合，而不是把测试时序无效或旧版本已修缺陷冒充当前产品故障。阶段0、SA1、SA2+3、SA4+6、SA8轮1、SA5+7、SA8轮2+3及轮3后获准 safe 修复已依序完成；独立 SA9 审稿现已完成，但审稿完成不等于验收通过。

已读[总报告](<report.md>)、[工作日志尾](<worklog.md#L290>)、[设计系统](<design-system.md>)、[轮1](<round1.md>)、[轮2](<round2.md>)、[轮3](<round3.md>)、[禁区测绘](<forbidden-zones.md>)与[源码基准清单](<source-before/assets-sha256.json>)。同级[性能与词汇任务书](<../performance-vocabulary-multi-agent-prompt.md>)属于前一任务，不冒充本次完整重设计 prompt；原 prompt 未完整保存，用户批准九节报告组织不代表放宽 acceptance。本次差异基准为 source-before，保留既有72项 dirty，不使用 git HEAD 代替任务前源码。

## P1 验收阻断

1. **动态整幅零像素未满足，归因仍未闭合。** [轮3冻结结果](<../../round3/aggregate.json#L125>)18/18动态对照严格RGB非零33–42036，computed/pseudo/rect为0。这是已发生的验收失败，不能全归GIF，也不能直接推导当前CSS污染。新尺寸检查没有动态图证据，不能覆盖历史失败。最窄后续是针对既有失败对明确动态时间/帧有效性与归因，在独立新证据中按原严格门证明；不得mask/crop、阈值放宽或以静态帧替代动态。
2. **最终三link静态矩阵没有有效完整通过证据。** [轮3静态说明](<round3.md#L32>)24个notebook case在计算/rect门出现41项变化，6个standard companion虽RGB0/computed0但countdown不等，30/30 invalid。natural无link也变化，支持测试clock污染，不能标作产品CSS bug。[一次定向复验](<../../round3/clock-recheck-01/REPORT.md>)整体exit1，仅dashboard1280 natural有效0；settings在字体loading preclock拒绝，未形成pair。自然缺link不等于强制三link负例。最窄后续是先在新输出中闭合既有settings初始化和同epoch时序，再经授权补原有强制/自然矩阵；原30不回填，不擅自开新browser。
3. **真实Live2D禁区验收缺实际模型。** [真实模型证据](<baseline/real-model/REPORT.md#L13>)公开76文件hash一致，但binding ready=false，fallback可见，canvas存在不代表actual model。属于前置配置/证据缺口，未证明模型资产或重设计实现有bug。仅用户提供合法完整绑定后按既有门补验，不复制私人语音、不伪造角色或绕过binding。
4. **人工视觉及本人真实业务未验收。** 当前模型本次实际尝试read_image仍返回无image input，未获得截图图像；不能声称美学、字形、文字重叠已目视通过。[学习交互范围](<report.md#L37>)的原生说明实点及fixture只证明相应局部，用户真实答题、切词判断和云端保存仍未本人验收。最窄后续是由具备图像能力的审阅者检查已有截图并由用户本人按既有流程确认，不要求助手侵入真实业务。

以上P1是验收阻断级别，不是四项已确认当前实现P1 bug。本次有限独立审稿**没有新增已证实的当前实现bug**；没有足够证据时不虚构file行号和复现逻辑。

## P2 问题

- **性能无回退证据无效。** [性能报告](<performance.md#L19>)首baseline context有3次pageerror，DOM574而其他baseline625；SA9独立只读validate仍exit1，零新context、原结果未改。不能定位产品回退，更不能称无回退。29965B旧版本仅可作当时footprint；当前30520B预算通过不等于运行成本通过。最窄后续是先保证错误可记录且两组状态同构，再经授权以相同有效门采有限干净对照，不删异常样本或泛化扩大真实业务。
- **有限状态覆盖不能外推全域。** [轮3限制](<round3.md#L64>)toast、真实loading瞬态、更多native fullscreen未覆盖；[最终尺寸报告](<sa4/fixes-round3/REPORT.md#L51>)未测hover/focus/disabled及elementFromPoint命中。正面积/isVisible、水平裁切0不是无遮挡或所有状态可操作证明。只需补既有要求中的缺口，不扩大真实账号操作权限。
- **阶段文档存在时序性措辞，须按后文判读。** [修复报告开头](<sa4/fixes-round3/REPORT.md#L3>)仍称NOT merged/无豁免，[后段授权与实测](<sa4/fixes-round3/REPORT.md#L43>)已明确正式合入及唯一豁免；前者是历史诊断checkpoint，不可单独当current。[设计系统开头](<design-system.md#L5>)称不接线，[加载状态](<design-system.md#L190>)已说明后续接线。父级已在SA9期间更新[当前总报告](<report.md#L55>)和[验收索引](<acceptance-status.md>)，不再把已纠正的“修复中/SA9未开始”当现状。最窄补救是当前入口引用明确的最终章节，历史段不重写；不能截取历史标题制造“未合入”或截取局部PASS制造“整体通过”。

## 证据表

| 门 | 独立审稿结果 | 来源与边界 |
|---|---|---|
| 现产品hash/预算 | 通过该门 | [离线断言](<sa9/assertions.json>)：components20564B，SHA256 3ad830841b35e3df402094b47d5031b1e498c5036acee44545042f1952befe2d；旧20009B前缀保留；shell30520<40000B，native追加8721<30000B |
| 实际服务版本 | 前序证据通过 | [最终provenance](<sa4/fixes-round3/product-final-provenance.json>)三CSS GET==disk、无route candidate；SA9未重新发网络请求 |
| safe修复/唯一豁免 | 通过该有限门 | [integration](<sa4/fixes-round3/integration.json>)及[真实产品summary](<sa4/fixes-round3/product-main-controls01/summary.json>)：candidate:null，六ctx完成，30完整保护pair0；132尺寸=120次≥32+12次toggle恰28×28；480非保护topbar字段变化如实保留；auto/combined未合入 |
| 保护集合 | 通过该有限门 | normal245/companion323，包含根/子孙、隐藏节点、非custom computed、::before/after及完整rect；entryChanges为空，不缩为215集合 |
| 公共资源/共享片段 | SA9复核exit0 | [守卫实现](<../../tests/redesign/asset_guard.py>)核1063公共资产、16片段一致、范围外变化0；不是私人数据全量hash证明 |
| 现修复后完整业务回归 | 前序exit0 | [原始日志](<round3-fixes-regression-pass.log#L837>)551 tests、五browser/JS/release/diff，REGRESSION_SUITE_PASS；另tokens23/native78通过；不替代视觉/业务本人验收 |
| 轮3原始证据 | 冻结不通过 | [原始summary](<../../round3/run01/summary.json>)144态/228PNG、12保护0/6AI专项通过，1065起止equal；[完整性](<../../round3/integrity.json>)1910项1856PASS/54FAIL、exit1，不是产品通过率 |
| 动态/静态/真实模型/人工业务/性能 | 未通过或未验收 | 上述P1/P2分别列明；新target PASS不覆盖这些门 |

历史尺寸P1不再列作现产品失败：新增规则见[组件末段](<../../css/theme-constructivist-components.css#L164>)，仅显式main/noncompanion及目标not#companion guard，min32；仅autoRefreshToggle获准28×28，不把132写成全部≥32。不以旧AI专项通过外推全部控件。

## Scope 与退出

SA9仅新增本文及[只读检查证据目录中的记录](<sa9/checks.md>)、[聚合断言脚本](<sa9/assertions.cjs>)和结果；未改产品、tests、其他docs或旧证据。未启动浏览器、服务器、大矩阵，未连接9337、读取账号/DB、答题或save。guard只读取声明公共资产及源码，不接触私有voice/数据库内容。父级并行文档更新不冒领为SA9编辑。

[执行记录](<sa9/checks.md>)明确：assetguard exit0、聚合断言exit0、syntaxcheck exit0、performance validate exit1；apply_patch不可用探测exit1、初次内联Node引号错误exit1后用独立脚本exit0，无产品副作用。job_list确认本代理无后台job。一致性检查exit0不等于acceptance通过。

## 未验收与最小后续

1. 保留产品freeze、历史原始失败与唯一尺寸豁免；不得为达成“通过”重标历史或放松门。
2. 经单独授权后，仅补动态归因/严格整幅零像素及现产品有效三link静态矩阵；先解决既有字体/时钟有效性，不以natural空link替代forced。
3. 由合法完整模型绑定提供实际模型证据；有图像能力的审阅者检查美学、字体与重叠。禁止伪造binding或声称当前模型看过图。
4. 用户本人确认真实学习与保存；其余toast/loading/native fullscreen和目标状态只补已约定缺口，不额外侵入账号。
5. 性能先修证据有效性门，再经授权有限同构对照。所有新增证据保持版本hash与独立输出；完成后独立复审，不预许通过。

在上述门未闭合前，最终结论维持 **不通过**。
