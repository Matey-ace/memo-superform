<div align="center">
  <a href="#memo-superform">
    <img src="https://img.shields.io/badge/简体中文-中文-blue?style=for-the-badge" alt="简体中文">
  </a>
  &nbsp;&nbsp;
  <a href="#memo-superform-english">
    <img src="https://img.shields.io/badge/English-EN-red?style=for-the-badge" alt="English">
  </a>
</div>

<br>
<h1 id="memo-superform">MEMO SUPERFORM</h1>

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
- **背单词自测模式**：在电脑上复习今日单词，AI 批量翻译释义，翻卡片自测记忆，支持认识/模糊/忘记三级标记，结果本地保存

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

本项目基于 [AGPL v3](LICENSE) 开源。可自由使用、修改和分发，但任何衍生作品（包括通过网络提供的服务）必须以相同协议开源。

---

<div align="right">
  <a href="#memo-superform-english">
    <img src="https://img.shields.io/badge/Switch_to_English-EN-red?style=flat-square" alt="Switch to English">
  </a>
  &nbsp;
  <a href="#memo-superform">
    <img src="https://img.shields.io/badge/Back_to_top-⬆-lightgrey?style=flat-square" alt="Back to top">
  </a>
</div>

<br>

---

<br>

# Memo Superform (English)

> Turn your Maimemo (墨墨背单词) study data into beautiful little tiles.

Memo Superform is a locally-run **data-visualization dashboard for Maimemo**. It pulls your study records and cloud wordbooks through Maimemo's official open API and turns dry numbers into intuitive charts, so you can see your vocabulary-learning status at a glance. As of v0.30 it ships with a built-in **smart review-recommendation engine** (backed by SQL Server) and can also run as a **native desktop window**.

## Features

- **Tile-card interaction**: Every chart is a rounded tile that can be dragged to swap positions, used in split-screen comparisons (single / left-right / three-way / quad grid), or clicked to go fullscreen.
- **Seven chart types**: Check-in heatmap, study trends, memory curve, AI word classification, wordbook progress, vocabulary growth, and smart review recommendations.
- **Smart review recommendations**: Based on daily SQL Server snapshots, it auto-generates a TOP-30 recommendation list ranked by forgetting risk (overdue + response status + review interval), displayed in tiers and markable as reviewed.
- **Two run modes**: Browser mode (`python server.py`) and native desktop window mode (`python app.py`, based on pywebview).
- **Auto refresh**: Periodically pulls the latest data from the Maimemo API and recomputes the charts-default 10 minutes, with 5/10/15/30/60-minute options. Refresh pauses while dragging and catches up automatically afterward.
- **Custom heatmap palettes**: 6 preset palettes (one each for light and dark mode), switchable from the status bar.
- **Privacy-first**: Tokens and AI keys are stored only locally; the proxy server and database run solely on your own machine.
- **Local caching**: API data is cached locally to reduce requests and open faster.
- **Word self-test mode**: Review today’s words on PC with AI-translated definitions, flip-card recall, and know / vague / forget grading stored locally.

## Tech Stack

Native HTML / CSS / JavaScript + [ECharts](https://echarts.apache.org/) + Python local proxy + SQL Server (smart recommendations). Desktop window via [pywebview](https://pywebview.flowrl.com/).

## Quick Start

### Option 1: Browser mode
```bash
cd memo-superform
python server.py
```
Once the server starts it prints the access URL (default http://localhost:8888) and opens your browser automatically.

### Option 2: Native desktop window
```bash
python app.py
```
Runs as a native window (no browser needed); closing the window exits the app.

### Configure your token
- Click the Settings button in the top-right corner.
- Enter your Maimemo API token (in the app: Me -> More settings -> Experimental features -> Open API).
- Click "Test connection" to verify; after saving, the data loads automatically.

> Smart review recommendations require a local SQL Server (Express is fine). On the first load of the day it automatically creates the database, saves a snapshot, and generates recommendations; if the database is unavailable, the other charts still work normally.

## Charts

| Chart | Description |
|------|------|
| Check-in heatmap | Monthly study calendar; each cell shows the number of words studied that day, with month navigation and 6 palettes. |
| Study trends | New / review / total trends, switchable across 7 / 30 / 90 / all days. |
| Memory curve | Bucketed by days since last study; shows retention rate and the known / recognized / fuzzy / forgotten distribution. |
| AI word classification | Calls an AI to classify words from your cloud wordbook or a custom time range by topic. |
| Wordbook progress | Mastery progress of the words in your cloud wordbook. |
| Vocabulary growth | Cumulative vocabulary and monthly new additions. |
| Smart review recommendations | Daily TOP-30 words by forgetting risk, shown as tiered cards, markable as reviewed. |

### Interaction features
- Split layouts: single / left-right / three-way / quad grid
- Drag to swap: drag a tile to swap two charts' positions (smooth FLIP animation)
- Fullscreen: click the button in the top-right of a card
- Chart switching: each tile can independently switch chart types

### AI classification config
Supports OpenAI-compatible endpoints (DeepSeek, Zhipu, Qwen, etc.):
- API Endpoint: defaults to https://api.deepseek.com/v1
- Data source: all words in the cloud wordbook, or words from study records within a custom time range

## How smart review recommendations work

On the first load of each day, all of that day's study records are saved as a snapshot (`study_records`), and every word's forgetting-risk score (0-100) is computed using these weights:

- **Overdue 50%**: the earlier `next_study_date` is relative to today, the higher the score; words due today get a base of 25.
- **Response status 30%**: forgotten 30 / fuzzy 20 / familiar 10 / known 5.
- **Review interval 20%**: the longer it has been since the last review, the higher the score, capped at 20 days.

The top 30 words by risk score become the day's recommendations: >=60 is urgent review, 30-59 is suggested review, and <30 is stable.

## File structure
```
memo-superform/
├── server.py          # Local proxy server (browser-mode entry)
├── app.py             # Native desktop window entry (pywebview)
├── db.py              # SQL Server data-access layer
├── recommender.py     # Smart review-recommendation engine
├── schema.sql         # T-SQL schema script
├── index.html         # Main page
├── css/style.css      # Styles
├── js/
│   ├── api.js         # API wrappers (Maimemo / AI / recommendations)
│   ├── charts.js      # ECharts charts
│   ├── layout.js      # Split / fullscreen / drag layout
│   └── app.js         # App entry
├── vendor/echarts.min.js
└── README.md
```

## API reference
Built on the Maimemo open API (https://open.maimemo.com/):
- POST /api/v1/memo/study/query_study_records - query study records
- GET /api/v1/memo/notepads - list cloud wordbooks
- GET /api/v1/memo/notepads/{id} - get cloud wordbook details
- POST /api/v1/memo/study/get_study_progress - get today's progress

Local recommendation APIs (served by server.py):
- GET /api/recommendations/today - get today's recommendations
- POST /api/recommendations/{id}/review - mark as reviewed
- POST /api/snapshot - save a snapshot and generate recommendations
- GET /api/stats/history?days=30 - historical stats

## Packaging
Double-click `dist/MemoSuperform.exe` to run. The exe bundles ECharts, so charts can be viewed offline (fetching data, AI classification, and recommendations still require network / SQL Server).

## License

This project is open-sourced under [AGPL v3](LICENSE). You are free to use, modify, and distribute it, but any derivative work (including services provided over a network) must be open-sourced under the same license.

---

<div align="right">
  <a href="#memo-superform">
    <img src="https://img.shields.io/badge/切换到中文-中文-blue?style=flat-square" alt="切换到中文">
  </a>
  &nbsp;
  <a href="#memo-superform-english">
    <img src="https://img.shields.io/badge/Back_to_top-⬆-lightgrey?style=flat-square" alt="Back to top">
  </a>
</div>
