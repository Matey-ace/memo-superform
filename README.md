# Memo Superform

> 把墨墨背单词的学习数据，变成一块块好看的磁贴。

Memo Superform 是一个本地运行的**墨墨背单词数据可视化仪表盘**。它通过墨墨官方开放 API 拉取你的学习记录和云词本，把枯燥的数字变成直观的图表，让你一眼看清自己的背词状态。v0.30 起内置**智能复习推荐引擎**（基于 SQL Server），并支持以**原生桌面窗口**运行。

## 特性

- **磁贴卡片交互**：每张图表是一块圆角磁贴，支持拖拽互换位置、分屏对比（单格 / 左右 / 三分 / 田字格）、点击全屏放大
- **七种图表**：打卡热力图、学习趋势、记忆曲线、AI 单词分类、词书进度、词汇量增长、智能复习推荐
- **智能复习推荐**：基于 SQL Server 每日快照，按遗忘风险（逾期 + 回应状态 + 复习间隔）自动生成 TOP-30 推荐词，分级展示并可标记已复习
- **两种运行模式**：浏览器模式（`python server.py`）与桌面原生窗口模式（`python app.py`，基于 pywebview）
- **自动刷新**：定时拉取墨墨 API 获取最新数据并重算图表，默认 10 分钟，支持 5/10/15/30/60 分钟手动调节；拖拽时暂停、拖拽后自动补刷
- **热力图自定义配色**：6 套配色预设，亮色与暗色模式各一套，状态栏一键切换
- **隐私安全**：Token 和 AI Key 只存在本地，代理服务器与数据库仅运行在你自己的电脑上
- **本地缓存**：API 数据本地缓存，减少请求、打开更快

## 技术栈

原生 HTML / CSS / JavaScript + [ECharts](https://echarts.apache.org/) + Python 本地代理 + SQL Server（智能推荐）。桌面窗口基于 [pywebview](https://pywebview.flowrl.com/)。

## Quick Start

### 方式一：浏览器模式
```bash
cd memo-superform
python server.py
```
服务器启动后会显示访问地址（默认 http://localhost:8888），并自动打开浏览器。

### 方式二：桌面原生窗口
```bash
python app.py
```
以原生窗口运行（无需浏览器），窗口关闭即退出。

### 配置 Token
- 点击右上角 设置 按钮
- 填入墨墨 API Token（App: 我的 -> 更多设置 -> 实验功能 -> 开放 API）
- 点击「测试连接」验证，保存后自动加载数据

> 智能复习推荐需要本地 SQL Server（Express 即可）。首次加载当日数据时会自动建库、保存快照并生成推荐；若数据库不可用，其余图表照常工作。

## 图表

| 图表 | 说明 |
|------|------|
| 打卡热力图 | 月度学习日历，格子直接显示每天学习的单词数，支持翻月与 6 套配色 |
| 学习趋势图 | 新学/复习/总计趋势，支持 7/30/90/全部天切换 |
| 记忆曲线 | 按距上次学习的天数分桶，展示保持率与熟知/认识/模糊/忘记分布 |
| AI 单词分类 | 调用 AI 将云词本或指定时间段的单词按主题分类统计 |
| 词书进度 | 云词本单词的掌握状态进度 |
| 词汇量增长 | 累计词汇量与当月新增 |
| 智能复习推荐 | 每日 TOP-30 遗忘风险推荐词，分级卡片，可标记已复习 |

### 交互功能
- 分屏布局：单格 / 左右分屏 / 三分屏 / 田字格
- 拖拽互换：拖拽磁贴即可交换两个图表的位置（FLIP 平滑动画）
- 全屏放大：点击卡片右上角按钮
- 图表切换：每个磁贴可独立切换图表类型

### AI 分类配置
支持 OpenAI 兼容接口（DeepSeek、智谱、通义千问等）：
- API Endpoint：默认 https://api.deepseek.com/v1
- 数据源：云词本全部单词，或按自定义时间区间筛选学习记录中的单词

## 智能复习推荐原理

每日首次加载时，会把当日全部学习记录保存为快照（`study_records`），并按以下权重计算每个单词的遗忘风险分（0-100）：

- **逾期 50%**：`next_study_date` 早于今天越多分越高，今天到期给 25 基础分
- **回应状态 30%**：忘记 30 / 模糊 20 / 熟悉 10 / 熟知 5
- **复习间隔 20%**：距上次复习天数越久分越高，超过 20 天封顶

取风险分最高的 30 个词作为当日推荐，≥60 为紧急复习、30-59 为建议复习、<30 为状态稳定。

## 文件结构
```
memo-superform/
├── server.py          # 本地代理服务器（浏览器模式入口）
├── app.py             # 桌面原生窗口入口（pywebview）
├── db.py              # SQL Server 数据库访问层
├── recommender.py     # 智能复习推荐引擎
├── schema.sql         # T-SQL 建表脚本
├── index.html         # 主页面
├── css/style.css      # 样式
├── js/
│   ├── api.js         # API 封装（墨墨 / AI / 推荐）
│   ├── charts.js      # ECharts 图表
│   ├── layout.js      # 分屏/全屏/拖拽布局
│   └── app.js         # 应用入口
├── vendor/echarts.min.js
└── README.md
```

## API 说明
基于墨墨开放 API (https://open.maimemo.com/) 开发：
- POST /api/v1/memo/study/query_study_records - 查询学习记录
- GET /api/v1/memo/notepads - 查询云词本列表
- GET /api/v1/memo/notepads/{id} - 获取云词本详情
- POST /api/v1/memo/study/get_study_progress - 获取今日进度

本地推荐 API（由 server.py 提供）：
- GET /api/recommendations/today - 获取当日推荐
- POST /api/recommendations/{id}/review - 标记已复习
- POST /api/snapshot - 保存快照并生成推荐
- GET /api/stats/history?days=30 - 历史统计

## 打包
双击 `dist/MemoSuperform.exe` 即可运行。exe 内已内置 ECharts，离线也能查看图表（拉取数据、AI 分类与推荐仍需联网 / SQL Server）。

## License

本项目基于 [MIT License](LICENSE) 开源，可自由使用、修改和分发，只需保留版权声明。
