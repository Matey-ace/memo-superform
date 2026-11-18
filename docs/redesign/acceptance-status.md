# 验收状态索引

本索引供后续SA-8/SA-9读取，不是最终九节报告，也不替代用户规定的报告模板。

## 已验证

| 项目 | 证据 | 结论边界 |
|---|---|---|
| 原生说明被重复判断栏遮挡修复 | [专项报告](native-answer-fix.md) | 真实登录主主题已实点原生确认关闭；78项独立fixture包含全屏原节点移动；未替用户答题或保存 |
| 原生新皮肤隔离与四态 | [父级独立193项结果](sa6/lead-round1-review/isolation-results.json) | 三类导航与TTS亮暗/四态；不等于云端学习流程全部通过 |
| 组件局部修复对照 | [父级独立复跑](sa4/lead-round1-review/result.json) | 六context的组件轮1修复前后0差异；**不是所有新CSS关闭的基线**。轮2联合负例已有位置变化P1，不得把本行引用成整体禁区通过 |
| 完整既有回归 | [接线后完整日志](integrated-regression-pass.log) | 551项Python、五组浏览器及其他JS/发布守卫通过；使用隔离测试库与合成fixture；不能替代轮2禁区位置检查 |
| 公共资源与共享片段 | [永久守卫](../../tests/redesign/asset_guard.py) | 最近复跑1063资产、16共享保护片段通过；SA7完成后必须再测 |
| 历史基线矩阵 | [基线索引](baseline/index.md) | 153组合严格验证，含6张明暗例外，不是每态真实暗色或完整登录流程 |

## 当前未通过或待验证

- [SA-8轮1](round1.md)原始结果仍为不通过，原始18对动态截图全部非零，不能因后续修复改写原始结论。
- SA-5/7已交付、布局已接入；父级分别八context/19932检查独立通过。SA-8轮2联合三link失败已冻结，新v4修复正式联合12对属性及rect0，但不能改写原始动态RGB非零；第三轮已冻结不通过，144态/228PNG/12保护对照0，18动态非零、30静态invalid。
- [轮2](round2.md)确定性三links自然/强制三档已24例RGB0，6手账设置因字体loading拒绝proof；轮3字体预热有效但late05Z与既有真实Date截止点坐标混用产生countdown失配，当前静态有效性未闭合；不替代真实动态Live2D或历史原始PNG。
- 轮3小控件P1已在冻结后[正式修复并有限复核](sa4/fixes-round3/REPORT.md)：实际产品明暗三档六context、30完整保护pair0，120次具名目标≥32、12次autoRefreshToggle按用户唯一豁免保持28×28。未穷举所有状态、hover/focus/命中，不外推完整交互验收；保护入口仍0。现组件20564B/shell30520B，HTTP与磁盘hash一致。
- [时钟定向复验](../../round3/clock-recheck-01/REPORT.md)一次两个case整体exit1：dashboard1280natural644元素computed+rect0/RGB0有效；settings字体loading初始化拒无pair。随后[02定向复验](../../round3/clock-recheck-02/REPORT.md)最多3次全量字体预热后两点有效computed/rect0及RGB0，exit0；仍仅1280natural，随后原30位置新矩阵已一次采完：29对computed/RGB0，文章1440natural因状态改变48字段/2641像素非零。原runexit1、独立phase-aware311门305通过6失败exit1，起止资源一致，整体未通过；不回填30静态原invalid。
- [性能有限证据](performance.md)首baseline pageerror3、DOM异构，有效性只读校验exit1。静态字节预算符合，但加载性能无回退缺口未闭合。[单次validity pilot](performance/pilot-01/REPORT.md)也因HEAD完成观察门超时exit1，只有baseline1ctx、pageerror0，HEAD实际已命中route，不能断言未发出；current未创建、初始结构正确不等于跨组有效。未补跑，资源起止一致。
- 真实公开模型已隔离复制并核验哈希，但[实际绑定结果](baseline/real-model/REPORT.md)仍缺完整角色，fallback不是成功canvas渲染；未复制私人语音、角色数据或绕过绑定。用户第6轮明确选择暂不提供完整角色绑定，保留真实模型未验收；不是豁免。
- 当前模型没有图像输入能力。数值检查和截图存在不等于人工美学、字形、视觉层次及重叠目视验收通过。
- 真实答题/切词判断/云端词条保存均继续由用户本人控制，未替用户提交，不能以合成fixture结果冒充。第6轮用户明确尚未检查视觉与真实学习保存，全部保留未验收；不是验收豁免。
- SA-8轮2已冻结不通过；两项P1修复后正式三link联合六context/12对245/323保护属性及rect0，AI工具条产品明暗各10控件规范通过。轮3已冻结，修复后父级完整551/五浏览器/JS发布diff再次exit0，tokens23/native78和asset1063/16通过；[SA-9独立审稿](sa9-review.md)已完成，结论不通过，未新增已证当前实现bug；阻断是动态/最终静态/真实模型/人工视觉与本人业务/性能等验收证据缺口。目标保持active，不标完成。

## 接续要求

SA-8轮2已冻结，两项P1修复与定向复测完成；第三轮及SA-9不通过结论均冻结；第6轮原30case受控静态补证独立一次采集已结束，原始run保留禁用态测试门错误及一例真实状态失配，独立阶段化validator已exit1（311门305通过6失败），[第6轮独立补证复审](sa9-followup-round6.md)再次不通过，产品不改；两处定向通过和29局部零差异均不能替代整体验收。所有报告区分源码字节、computed、确定性静态帧、原始动态像素、真实学习交互和人工美学这六类证据，不互相替代。禁区结论必须有正负例与非空保护集合，不以空命中或fallback代替实际证明。
