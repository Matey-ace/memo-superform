# 有限性能与结构证据补充

性质：独立、有限、只读产品证据；不是 SA-9，不作最终审稿或性能无回退结论。对应 [report 第7节](report.md#7-工程与性能) 的浏览器加载/节点/实例缺口。本补充不修改该报告、round3 或 worklog。

## 结果与边界

- 采集完成：独立 headless Edge 156.0.4314.58，1280×800、standard/light，3 个新 context/组，总计 6 个，无额外浏览器试跑。每个 context 首次导航后再作一次同条件禁用 HTTP cache 的 reload；reload 不是新增独立冷样本。
- 产品资产在采集前后哈希不变；组件冻结 SHA256 为 `69bb103297aed39edc301dea23222402363b2ee29a76210100348db9013870ae`。asset guard 核对 1063 资产，范围外变化 0，16 个受保护片段一致。
- 字节预算符合既定静态上限：三份 shell CSS 合计 29965 B < 40000 B；native CSS 精确追加 8721 B < 30000 B。字节不是解析、重排或 paint 成本测量。
- **时间结果不可作为干净的启动性能对照**：baseline 首个 context 的局部稳定 DOM 为 574，另两个 baseline 为 625；该 context 记录 page error 3 次，其余 context 为 0。错误文本没有采集，不能定位原因或归因本次产品变化。没有剔除异常、补跑、伪装为通过阈值。
- 全部样本 ECharts instance 为 0、canvas 为 1。仅证明此无账号、无真实数据主界面状态下的数量；没有真实图表数据 paint 性能或真实 Live2D 证明。canvas 1 不能等同于真实模型已渲染。

完整原始数值、公开静态请求路径、逐资源 timing、文档 timing、哈希和方法见 [result.json](performance/sa8-limited-20261116-01/result.json)。唯一运行命令：

```powershell
node tests/redesign/performance-proof.js --out docs/redesign/performance/sa8-limited-20261116-01
```

[采样脚本](../../tests/redesign/performance-proof.js) 要求 `--out` 为 performance 下不存在的新子目录，拒绝覆盖。该目录已存在，不能原路径重跑。本次六 context 额度已用完，不再运行浏览器。首次真实运行 exit 0，但自审发现 page error 未纳入错误门，是测试脚本漏检，不能视为证据有效性通过；`nPerGroup=3` 是完成采集数量，不是三份有效同构性能样本。随后仅修脚本，令任何 context 的 `pageErrorCount>0` 标记 sample failure 并最终 exit 1；修后浏览器未复跑。原始结果文件不改写，内含 scriptSHA256 对应首次运行版本，不冒充修复后的脚本哈希。

只读校验既有结果的命令实际返回 **exit 1 / evidenceValidationPassed=false**，无新 context、无文件写入，明确列出 baseline 1 的 pageErrorCount=3。这是证据有效性失败，不定位错误原因，也不证明产品性能回退：

```powershell
node tests/redesign/performance-proof.js --validate docs/redesign/performance/sa8-limited-20261116-01
```

修后脚本 `node --check` 通过。性能缺口因此未闭合，静态 footprint 与采集原始值仍可独立引用。

## 对照方法

既有 55395 服务是唯一网络目的地。使用独立新 Edge，无 CDP/9337、持久浏览器 profile、账号 cookies 读取/导出或 storage-state 导出。只允许 manifest 中本地公开静态资源及根文档的 GET/HEAD 到服务端；API、非静态、外域、非 GET/HEAD 在 route 层全部阻断，不记录 URL、请求头、payload 或响应。阻断请求只计数。没有真实 DB、学习 iframe、答题或 save。

current 使用现有真实公开静态 HTTP 响应，导航文档响应哈希与磁盘及 source-before 相同（`a1daa506a7b8e035044a323bee8b64822c45bfc65e48c3b5b523a732db9797b5`）。baseline 在浏览器 route 中原样返回 [source-before index](source-before/index.html)、[原 ui-style](source-before/js/ui-style.js)、[原 charts](source-before/js/charts.js)，从而撤回新 main paint 函数而不是只切 CSS；三新增 CSS 如被请求则响应空内容，实际 baseline 原加载器自然不请求。没有修改源文件。其余既有 preexisting dirty 产品资产在两组共同保留。

七原文件都验证 source-before 哈希等于 [原资产清单](source-before/assets-sha256.json)；原 native CSS、style CSS、study-web-standard CSS、注入文件也纳入 provenance。公开资产当前哈希全集、脚本运行时哈希与 asset guard 原始返回一并保存。原样 route 的基线不是独立部署的旧产品，内存 fulfill 与当前网络传输机制不同，因此不能把文档/脚本 timing 差异当成纯产品成本。

两组相同：routing 禁用 HTTP cache，service worker 阻断；不清服务器/OS cache，不使用 CDP；原始时钟、动画保留。按 baseline/current/current/baseline/baseline/current 顺序串行运行。仅经 `welcomeSettingsBtn` 再 `closeSettings` 非 learning UI dismiss，未进入学习。此短暂 settings 打开是共同准备步骤，不是纯 dashboard-only 的资源触发范围。

每次 load 后 UI dismiss，等 700 ms、`document.fonts.ready`、当前图片 decode 完成，再以 200 ms 间隔检查连续三次相等 DOM（最多十次）。采样时 fonts 均 loaded、图片 pending/failed 均 0。但首个 baseline 的 574/574/574 表明短窗口稳定不能保证异步初始化完全，不能外推跨样本相同状态。没有 computed-style 全树扫描、截图或强制字体加载；本次公开字体请求全 0，不证明其他路径或隐藏控件永不请求字体。

## 原始摘要

毫秒，展示保留到 0.1 ms 仅为可读性，JSON 保留浏览器原始浮点数。DCL 为 `domContentLoadedEventEnd`，load 为 `loadEventEnd`。每行是 1 个 context 的首次导航及后续 reload，不做显著性或改善百分比计算。

| 组/编号 | 首次 DCL / load | reload DCL / load | 首次 / reload DOM | 首次 / reload 静态资源条数 | context page errors |
| --- | ---: | ---: | ---: | ---: | ---: |
| baseline 1 | 209.1 / 211.1 | 76.6 / 80.6 | 574 / 625 | 34 / 35 | 3 |
| baseline 2 | 170.9 / 175.8 | 83.6 / 85.6 | 625 / 625 | 35 / 35 | 0 |
| baseline 3 | 174.6 / 179.8 | 77.9 / 79.6 | 625 / 625 | 35 / 35 | 0 |
| current 1 | 191.6 / 197.1 | 82.3 / 84.7 | 628 / 628 | 38 / 38 | 0 |
| current 2 | 182.7 / 187.7 | 84.9 / 87.4 | 628 / 628 | 38 / 38 | 0 |
| current 3 | 206.2 / 211.4 | 95.2 / 97.8 | 628 / 628 | 38 / 38 | 0 |

page error 是整个 context 聚合，未按首次/reload 分桶，不能说错误只发生在首次导航。baseline 1 相比其余 baseline 首次少的公开静态路径为 `/index.html`（既有服务探测 HEAD）；非静态阻断次数为 7，其余 context 均 14；全部非 GET/HEAD 阻断次数 0。没有记录敏感路径来进一步诊断。current 相比正常 baseline 多的公开路径精确为三份新增 CSS；current 有 3 个已加载启用的主题 link，baseline 为 0，节点 +3 与这些 link 数相符，但没有全面 tag census 来证明唯一因果。请求数是 Resource Timing 条目数，不是全部浏览器内部网络开销或 dependency 数。

## 静态结构

| 文件或范围 | 原字节 | 当前字节 | 增量 |
| --- | ---: | ---: | ---: |
| tokens CSS | 不作整个新层基线预算扣减 | 6692 | 新层预算计全部当前字节 |
| components CSS | 原无此文件 | 20009 | 20009 |
| layout CSS | 原无此文件 | 3264 | 3264 |
| native CSS | 4558 | 13279 | 精确尾追加 8721 |
| ui-style JS | 4120 | 4377 | 257 |
| charts JS | 57958 | 65145 | 7187 |
| memo_injection Python | 10230 | 10568 | 338 |

原清单已经有一份 tokens CSS；这里不把它假称为原先不存在，而是按三份完整当前 CSS 的交付预算核算。native 原 4558 B 前缀逐字一致，追加哈希为 `d232379cc255636d278eeeb7da0ebd1dafac6724d2c563f8ac939c55ed1e1347`。

原清单 JS/vendor JS 为 26 份，asset guard 未发现新增生产 JS 文件、字体、图片或其他越界依赖资源。ui-style 差异为三 CSS 引用；charts 差异包含新 main paint 转换和调用，不等于零 JS 工作。三个受改动的 JS/注入源码对 timer/observer/import/require 词法调用筛查前后相同：ui-style、charts 各项为 0；注入 setTimeout 2、setInterval 2、MutationObserver 3，其余筛查项为 0。配合共享生命周期受保护片段一致及差异检查，支持“本轮未新增 timer/observer 或生产 JS 依赖”的静态结构判断；不是 runtime 分配/调度器成本测量，也不是用字节数替代运行成本。

## 未覆盖

n=3/组、其中启动基线首样本异常，不能证明无性能回退、精准性能改善或满足未定义的性能阈值。未测 GPU、内存、CPU profile、长任务、真实数据图表 paint、真实 Live2D、登录态、真实云端、答题/save、其他视口、暗色、手账或学习 iframe。机器同期其他进程/服务负载、服务器及 OS cache 未控制。仅本次有限 footprint 与只读采集完成；最终验收仍未通过本补充作出。
