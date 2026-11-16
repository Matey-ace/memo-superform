# SA-9 第六轮有限补证复审

## 结论

**不通过。** 本文是新增证据的独立有限复审，不修改或追溯替代[原SA9审稿](<sa9-review.md>)的时点结论，不改历史失败、产品、测试或旧证据。现产品保持freeze，不能将持续目标标记完成。

新增证据足以支持若干明确的局部结论，但未形成完整静态矩阵通过、动态整幅零像素或有效性能对照。本轮没有新增已确证的产品实现bug；测试阶段门缺陷、受控状态失配与业务前置缺失分别列明，不混作产品CSS污染。

## 证据与边界

| 新证据 | 实际结果 | 可闭合与不可闭合 |
|---|---|---|
| [Clock02报告](<../../round3/clock-recheck-02/REPORT.md>) | 一次两context，exit0；notebook dashboard/settings各1280 natural，全644节点computed/pseudo/rect0、RGB0 | 支持这两个位置的有界字体realization、同页面epoch固定Date及稳定观察方法；三link自然不存在，不是forced负例，不回填原30invalid |
| [静态矩阵最终报告](<../../round3/static-recheck-01/REPORT.md>) | 一次30context/30完整pair/60PNG，raw exit1，11PASS/19FAIL；1065provenance相等 | 30原位置已采齐；18个FAIL源于禁用后sheet阶段误门，另1个为真实pair状态失配。采齐不是验收通过 |
| [离线校验](<../../round3/static-recheck-01/offline-validation.json#L1472>) | exit1，311项305PASS/6FAIL；29对computed/RGB0，一对非零 | phase-aware门恢复了18个误门pair的局部证据解释，但raw失败不改；29局部零差异不覆盖全局blocked0失败和文章状态失配 |
| [文章1440自然点像素](<../../round3/static-recheck-01/static-notebook-article@1440x900@natural-pixels.json>) | RGB2641/1296000，max delta194；computed/rect48 | Date相同/font loaded不够，countdown从9:34变更新失败；三link均不存在，不能归因强制CSS加载 |
| [原18动态离线分析](<dynamic-analysis/REPORT.md>) | 一次离线分析exit0，原18/18非零保持，合计293768像素 | 支持空间定位，不是动态验收或唯一因果证明；历史版本20009B，不冒充现20564B的新动态测试 |
| [性能pilot报告](<performance/pilot-01/REPORT.md>) | 唯一1context baseline，exit1/INVALID，current未创建；public assets/sources unchanged | 初始625节点/body606、控件正确、字体图片loaded、pageerror0是初始观测；HEAD完成观察门失败，没有有效baseline/current性能比较 |

现freeze components仍20564B，SHA256 `3ad830841b35e3df402094b47d5031b1e498c5036acee44545042f1952befe2d`，shell30520B。以上证据记录版本与来源一致，不以旧版29965B性能样本证明现版本无回退。

## P1 未闭合

1. **受控静态矩阵仍失败。** [最终静态报告](<../../round3/static-recheck-01/REPORT.md#L51>)的文章1440 natural保存了真实pair失配。第二稳定窗口墙钟耗时8466323ms，随后倒计时/刷新状态改变；[单pair只读诊断](<dynamic-analysis/static-article-1440/REPORT.md>)进一步核对675节点与48项变化，全部2641差异像素位于顶栏、与IMG/canvas/textarea及文章控件矩形无交集，刷新组宽129→139、相邻位置移动10px。enabled到disabled的performanceNow相差8469186ms，显示观察时间断裂；固定Date仍可能因同步状态文字而改变countdown。上述记录支持状态/时间失配，但不唯一证明来源callback或完整根因。其pair不满足同状态零差异，不以29对PASS或Date固定遮盖。此次没有实证三link直接导致该失配，也没有实证新的产品业务bug。
2. **网络有效性全局门未通过。** [网络记录说明](<../../round3/static-recheck-01/REPORT.md#L65>)49个不允许请求均在route层拒绝，含7个API POST尝试及42个credential-present公共资源GET；未放行、未记录凭据值。阻断成功不是已经发生账号安全泄漏，但blocked0严格门确实失败，不能静默豁免。资源被拒也限制伴随资源环境的外推；不能将局部页面可见当作不受限真实产品证明。
3. **动态整幅零像素仍未证明。** [动态定位结果](<dynamic-analysis/REPORT.md#L9>)最小33像素均在倒计时区域，多数其他差异与IMG矩形相交；settings仍有2260像素位于指定候选并集外。矩形相交不是GIF/canvas因果，低max delta不是阈值豁免。原18动态failed不变，新frame0静态pair不能改名为动态通过。
4. **真实模型、人工视觉与本人真实业务仍未验收。** 用户明确暂不提供完整binding，并明确尚未检查视觉、本人学习/保存；这些均不是豁免或默认通过。fallback不等于actual model，模型无image input不等于美学/字形/重叠正常；fixture和受控静态证据不等于用户本人答题、学习与云端保存通过。

这些是验收阻断，不把缺失证据臆造为当前实现缺陷，也不重新指控原先已经safe修复且有唯一toggle豁免的小尺寸历史P1。

## P2 方法与性能

**已知测试缺陷解释有效，但不能吞其他错误。** 采集脚本将初始化的loaded/nonempty sheet门用于disabled阶段，导致18个phase guard错误。离线验证保留enabled三link存在、loaded、disabled=false、规则非空、主体match0；disabled要求元素存在且disabled=true，不要求浏览器继续暴露sheet对象，科学上合理，不是松动隔离门。完整computed实际payload/哈希、两伪元素/rect、字体/目标、Date/countdown、严格全尺寸PNG重解码及provenance仍被检查。新加的summary.failures精确分类门因文章真实失败而明确FAIL，说明未知类型失败没有被当作phase guard吞掉。整体exit1必须保留。

**稳定窗口不是精确回调证明。** [Clock02](<../../round3/clock-recheck-02/REPORT.md#L34>)与[最终矩阵说明](<../../round3/static-recheck-01/REPORT.md#L59>)以正常初始化后的页面epoch调用setFixedTime，承认Playwright可能包裹timer/performance，无改业务deadline闭包。两段≥1100ms自然时间与完整快照同态是有用的稳定观察，但不是instrumented证明恰好执行两次interval callback。Clock02表头“tick”应按此边界解读，不应外推精确序列或无限时间稳定。

**性能缺口未闭合。** [Pilot初始化失败说明](<performance/pilot-01/REPORT.md#L13>)明确HEAD `/index.html` routehit已存在，但request-finished观察flag=false，故INITIALIZATION_HEAD_TIMEOUT；pageerror0并不推翻生命周期门。不得声称HEAD未发出、bootstrap必然未完成或产品性能回退。welcome尚未dismiss，稳定/最终状态未采，current未建立，因此既无同构比较，也无无回退结论。前一组异常baseline证据亦不因该pilot自动修复。

## 最窄后续

1. 先书面定义受控静态证明、原始动态证明和网络有效性门各自承担的验收要求，保持严格阈值和失败分列；不以“29/30”强行通过或重标原失败。
2. 在现存文章pair与请求元数据允许范围内，先澄清刷新状态变化/异常墙钟窗口及credential-present资源阻断的测试有效性问题。不得检查凭据内容、放行未授权请求或为blocked0清空日志。未明确原因与可验证门前不盲目重跑。
3. 性能先澄清HEAD已route fulfill而requestfinished未被观察到的harness完成契约，给出最小方法论修正及退出条件，再另行申请有限采集；不复用初始625观测冒充完成门。
4. 完整模型绑定需用户自愿提供合法前置；人工视觉与本人真实学习/保存需用户完成后明确反馈。在此前保持未验收，不要求额外侵入真实账号或伪造binding。
5. 只有在明确授权、明确有效性改进后才考虑新独立输出与复审。此次不启动新browser、服务器、矩阵或补跑，亦不预先承诺后续通过。

## Scope 与退出

本轮仅新增本文。已只读读取最终报告、离线失败清单及文章原始像素结果，未执行采集器、验证器、旧assertions或其他会覆盖输出的脚本；没有新增或运行后台job，无需收取本代理任务。不改产品、tests、原SA9或其他旧证据，不连接9337，不访问账号/DB、答题或save。前序所有采集与离线作业已由各owner收齐，本文引用的是其真实exit而非本轮重跑。

本次审稿仍无图像输入，未伪造目视；不触碰用户已明确保留的业务权限。最终结论：**不通过**。
