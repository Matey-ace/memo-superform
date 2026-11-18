# SA7 图表 Paint 交付

完成范围：仅 `js/charts.js`、永久测试 `tests/redesign/chart-theme-isolation.js`、本文和 `sa7/` 证据。未进入 SA8 轮2或 SA9，未修改并行 SA5 文件。所有权已交回父级。

## 实现

- 严格条件为 `document.documentElement.getAttribute('data-ui-style') === 'standard' && !document.body.classList.contains('companion-mode')`。缺属性、notebook、standard+companion 均直接返回原 option，不注册全局 ECharts theme。
- `getThemeColors` 新增主分支，复用设计系统纸、墨及分隔线原令牌色值；纯 paint helper 在原六类绘图 `setOption` 前应用。AI/词书空态也覆盖系统字体。
- 硬系列数组保持 `['#B8321F','#1A1714','#6B6258','#9C6B30','#1F3A4D','#D8CCB2']` 原顺序；非热力图显式系列色同步，饼图使用原顺序全局 option.color。暗色保留硬填充，用亮墨描边及无模糊1px线下衬保证暗墨线可辨，不替换硬色。
- 主分支移除渐变、圆角、模糊阴影；tooltip 纸底墨字、直角无阴影无毛玻璃。记忆 tooltip 只包装旧 formatter 输出中的四个 color 声明，内容、数字、标签及转义不变，不重写原 formatter。
- 保留全部热力图阈值、count、日期、名称、索引、存储和六套选择。仅主主题将原色阶映射为每套对应硬palette色与纸色的四级混色；暗色第二套以已有亮墨形成可见色阶。测试验证六套输出互不相同。getHeatmapPalettes 仅主分支返回匹配预览，其他分支仍原数组。
- 热力图数字采用语义墨字加纸色2px文字描边，避免深浅色块下标签消失。推荐卡仅增加主分支 color 赋值，未改HTML、元数据、转义及事件。
- 未新增依赖、生产JS、全局theme、事件、观察器或计时器；未改业务、数据、排序、生命周期和持久化。

## 永久验证

命令：`node tests/redesign/chart-theme-isolation.js --out sa7/<new-directory>`。`--out` 必填，现存目录在启动浏览器前拒绝覆盖；对 `sa7/run-03` 的再次调用已实测预期退出1。

最终有效证据：`sa7/run-05/result.json`、`sa7/run-05/options-evidence.json` 和同目录四张合成截图。

结果：**CHART_THEME_ISOLATION_PASS 19932**。

- VM 与全新无认证 headless Edge 同时执行 source-before 和当前源码，通过真正 ChartManager.render 路由捕获六类实际 setOption 输入。
- notebook亮暗、缺属性亮暗、standard+companion亮暗完整深相等，包括全部 function.toString 源码和 formatter实际调用结果。每种条件均覆盖6个palette选择及AI/词书空态。
- 主主题亮暗使用48条固定日期合成记录、五种反馈、六个记忆间隔、三个月新增记录、非空分类及50条双词书fixture。除paint字段路径白名单外递归相等；独立深比较全部series.data（热力图为value）、分类排序、轴、标题统计、日期、函数、缓存记录和formatter去颜色后的完整输出。
- 断言硬palette顺序、显式系列色、系统字体、tooltip平面属性、主分支无gradient colorStops、零圆角/模糊及暗色描边。六套热力图各有不同输出。
- VM/浏览器当前源码捕获结果再次完整深相等。
- 额外加载现有vendor/echarts.min.js，在1280和390宽度、主主题亮暗四组独立页面实际绘制六张canvas，均非空、无pageerror，保存完整截图。测试用route仅允许55395的合成路径并本地fulfill，不向产品服务器读取数据。

原始尝试全部保留：run-01因测试比较器未接受新增textStyle容器失败，修正仅允许textStyle/itemStyle容器后run-02通过20064；run-03增加真实ECharts非空验证通过20004；run-04在移除非paint的tooltip.confine后通过19860；最终run-05修正inside标签按硬填充亮度选纸/深墨、pie标签使用语义墨，并添加显示词书标签>=4.5断言，通过19932。检查数变化来自paint差异与断言数量，不代表覆盖条件减少。暗色1px sharp线段下衬无blur，不是soft shadow；硬palette本身部分色在暗背景仍低对比，依赖亮墨边框/线段下衬辅助识别，不声称每个原始色/背景组合都达标。热力图文字依靠纸色2px halo分离，未把halo当作填充对比达标证明。

## 资产保护与边界

`python tests/redesign/asset_guard.py verify`：1063资产、16个fragment均通过；无白名单外变化，五块charts受保护区域逐字未变。证据 `sa7/asset-guard-final.json`。`node --check js/charts.js`、永久测试语法及 scoped `git diff --check` 通过。

本轮没有连接9337、没有读取账号/真实DB/角色语音，没有代替真实答题或保存，没有操作真实用户浏览器。截图是合成数据渲染，不是人工目视合格证明，不是true model，不是完整产品三档截图验收。无真实学习、云端保存或陪伴动态像素零差异声明；后续综合验收归父级既定阶段处理。
