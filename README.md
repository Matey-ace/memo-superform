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

Memo Superform 是一个本地运行的**墨墨背单词数据可视化仪表盘**。它通过墨墨官方开放 API 拉取你的学习记录和云词本，把枯燥的数字变成直观的图表，让你一眼看清自己的背词状态。内置基于 SQLite 的**智能复习推荐引擎**，并支持以**原生桌面窗口**运行。

完整版本变更记录见 [CHANGELOG.md](CHANGELOG.md)。

- **Anon的笔记本前端（`index-anon.html`）**：笔记本视觉界面，功能与原版一致。
- **Anon的笔记本磁贴**：以Anon的笔记本/日记风展示每日背词（数量分级：摸鱼 / 日常 / 努力 / 爆肝），爆肝日飘爱心，支持列表 / 详情双视图
- **背单词磁贴（网页版）**：内嵌墨墨网页版 SPA，可实时背单词，暗色主题跟随仪表盘
- **Anon Live2D 陪伴学习**：独立双栏模式，左侧背词、右侧角色与学习反馈；模型衣柜支持 Bestdori 角色/服装检索下载以及本地模型导入，未选择模型时自动使用现有 Anon GIF
- **字体本地化**：Noto Serif SC / Noto Sans SC / M PLUS Rounded 1c 完整中文子集已本地化，离线可用
- **本地安全加固**：仅接受 localhost/127.0.0.1 的 Host，CORS 仅回显同源 Origin，避免跨域滥用

## 特性

- **磁贴卡片交互**：每张图表是一块圆角磁贴，支持拖拽互换位置、分屏对比（单格 / 左右 / 三分 / 田字格）、点击全屏放大
- **七种图表**：打卡热力图、学习趋势、记忆曲线、AI 单词分类、词书进度、词汇量增长、智能复习推荐
- **智能复习推荐**：基于 SQLite 冻结的每日快照，按遗忘风险（逾期 + 回应状态 + 复习间隔）自动生成 TOP-30 推荐词，分级展示并可标记已复习
- **两种运行模式**：浏览器模式（`python server.py`）与桌面原生窗口模式（`python app.py`，基于 pywebview）
- **统一 Windows EXE**：发布包只提供 `MemoSuperform.exe` 一个入口；启动后选择或记忆“网页模式 / 桌面模式”，两种运行方式共用同一份程序与数据目录
- **Windows 托盘状态**：运行时会在右下角通知区域显示 Memo Superform 图标与当前模式；双击或菜单“打开”可恢复页面/窗口，菜单“退出”会完整停止后台服务。再次启动同一 EXE 会自动唤醒已有实例，不再误报启动错误。
- **按需增量刷新**：日常只检查今日变化、到期候选和必要的 30 天活动窗口；默认 10 分钟，支持 5/10/15/30/60 分钟，设置内可手动完整核验
- **热力图自定义配色**：6 套配色预设，亮色与暗色模式各一套，状态栏一键切换
- **隐私安全**：Token 和 AI Key 只存在本地，代理服务器与数据库仅运行在你自己的电脑上
- **SQLite 数据中心**：先显示本地已提交数据，再后台增量检查；历史快照不会被普通刷新反复拉取或覆盖
- **背单词自测模式**：在电脑上复习今日单词，AI 批量翻译释义，翻卡片自测记忆，支持认识/模糊/忘记三级标记，结果本地保存
- **陪伴学习反馈**：按学习节点读取本轮统计与当前单词，调用已配置的 AI 生成短鼓励；无 AI 配置或离线时自动采用本地反馈，不会中断背词

## 技术栈

原生 HTML / CSS / JavaScript + [ECharts](https://echarts.apache.org/) + Python 本地代理 + SQLite。桌面窗口基于 [pywebview](https://pywebview.flowrl.com/)。

### Live2D 模型衣柜

点击顶部「陪伴学习」进入固定双栏：左侧为墨墨背词，右侧为角色和本轮学习反馈。模型在设置 →「Live2D 模型衣柜」中管理：可检索下载 Bestdori 目录中的角色/服装，也可输入已有 Live2D 模型文件夹路径导入。模型文件会复制至 `data/live2d/models/`；安装包不携带任何角色模型。支持 Cubism 2 与 Cubism 3/4 格式，模型或 WebGL 不可用时自动回退到 Anon GIF。

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

### Windows 统一 EXE
发布版本使用单一的 `MemoSuperform.exe`：首次启动可选择网页模式或桌面模式，之后会记住选择；运行 `MemoSuperform.exe --reset` 可清除该选择。

Windows 版运行后会在系统托盘保留状态图标。网页模式关闭浏览器后服务仍可从托盘重新打开；桌面模式关闭窗口会隐藏到托盘，使用托盘菜单“退出 Memo Superform”才会完全退出。

### 配置 Token
- 点击右上角 设置 按钮
- 填入墨墨 API Token（App: 我的 -> 更多设置 -> 实验功能 -> 开放 API）
- 点击「测试连接」验证，保存后自动加载数据

> SQLite 主库会在 `data/memo-superform.db` 自动建立，无需安装数据库。已有 SQL Server 数据库只会通过可选的只读迁移器导入，原库不会被修改。

## Linux 支持

> **已停止维护。** Linux 相关的构建/运行支持已归档到 `codex/linux-archived` 分支，不再随本分支更新；
> 如需 Linux 版本，请切换到该分支查看。

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

也支持 **OpenAI Codex（ChatGPT OAuth）** 调用方式：在设置的“调用方式”中选择
“OpenAI Codex”，点击登录并在浏览器完成 ChatGPT 授权。授权令牌只保存在本机
`data/codex_auth.json`，服务会自动刷新令牌，并通过 Codex Responses 接口完成分类与释义。
可选模型包括 `gpt-5.6-terra`、`gpt-5.6-sol`、`gpt-5.6-luna`、`gpt-5.5` 和 `gpt-5.4`。

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
├── db.py              # SQLite 数据中心与旧 SQL Server 只读迁移
├── recommender.py     # 智能复习推荐引擎
├── sqlite_schema.sql  # SQLite 运行时架构
├── schema.sql         # 旧 SQL Server 架构（只读迁移参考）
├── windows_tray.py     # Windows 通知区域运行状态
├── CHANGELOG.md        # 版本更新记录
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

| Anon的笔记本 | 每日背词Anon的笔记本：数量分级（摸鱼/日常/努力/爆肝），爆肝日飘爱心，列表/详情双视图 |
| 背单词 | 内嵌墨墨网页版，实时背单词，暗色跟随 |
- `index-anon.html`      # Anon的笔记本前端
- `css/style-anon.css`   # Anon的笔记本风格样式
- `css/diary.css`       # Anon的笔记本样式
- `css/fonts.css`       # 本地化字体（Noto 等完整中文子集）
- `js/diary.js`         # Anon的笔记本渲染器
- `fonts/`              # 本地字体文件（woff2 子集）
> 默认入口为 `index.html`（原版）；`index-anon.html` 为 Anon的笔记本备用界面。打包时需将 `index-anon.html`、`fonts/` 一并打入。

## 打包
双击 `dist/MemoSuperform.exe` 即可运行。exe 内已内置 ECharts 与 SQLite，离线可查看已经同步的数据和推荐；拉取新数据与 AI 分类仍需联网。

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

Memo Superform is a locally-run **data-visualization dashboard for Maimemo**. It pulls study records and cloud wordbooks through Maimemo's official open API, stores committed state in SQLite, and can also run as a **native desktop window**.

See [CHANGELOG.md](CHANGELOG.md) for the complete version history.

- **Anon’s Notebook frontend (`index-anon.html`)**: notebook visuals, same features as the original dashboard.
- **Memory Diary tile**: a journal-style daily word tracker (tiers: slacking / daily / focused / grinding), floating hearts on grind days, list & detail views
- **Study tile (web edition)**: embeds the Maimemo web SPA for real-time word study, dark theme follows the dashboard
- **Localized fonts**: full Chinese subsets of Noto Serif SC / Noto Sans SC / M PLUS Rounded 1c bundled locally, works offline
- **Local security hardening**: Host allow-list (localhost/127.0.0.1 only), CORS echoes same-origin only

## Features

- **Tile-card interaction**: Every chart is a rounded tile that can be dragged to swap positions, used in split-screen comparisons (single / left-right / three-way / quad grid), or clicked to go fullscreen.
- **Seven chart types**: Check-in heatmap, study trends, memory curve, AI word classification, wordbook progress, vocabulary growth, and smart review recommendations.
- **Smart review recommendations**: Based on immutable daily SQLite snapshots, it generates a TOP-30 list ranked by forgetting risk and preserves reviewed state.
- **Two run modes**: Browser mode (`python server.py`) and native desktop window mode (`python app.py`, based on pywebview).
- **Windows tray status**: The notification-area icon shows that Memo Superform is alive, restores the current page/window on double-click, and exits the background service from its menu. A second launch activates the existing instance instead of failing ambiguously.
- **Incremental refresh**: Checks compact today-state and due candidates by default, scans the 30-day active window only when needed, and offers weekly/manual reconciliation.
- **Custom heatmap palettes**: 6 preset palettes (one each for light and dark mode), switchable from the status bar.
- **Privacy-first**: Tokens and AI keys are stored only locally; the proxy server and database run solely on your own machine.
- **SQLite data centre**: Displays committed local data immediately and updates only changed rows; ordinary refreshes never rescan frozen history.
- **Word self-test mode**: Review today’s words on PC with AI-translated definitions, flip-card recall, and know / vague / forget grading stored locally.

## Tech Stack

Native HTML / CSS / JavaScript + [ECharts](https://echarts.apache.org/) + Python local proxy + SQLite. Desktop window via [pywebview](https://pywebview.flowrl.com/).

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

On Windows, the tray icon remains visible while the app is running. Closing the desktop window hides it to the tray; use **Exit Memo Superform** from the tray menu to stop it completely.
Runs as a native window (no browser needed); closing the window exits the app.

### Configure your token
- Click the Settings button in the top-right corner.
- Enter your Maimemo API token (in the app: Me -> More settings -> Experimental features -> Open API).
- Click "Test connection" to verify; after saving, the data loads automatically.

> The SQLite database is created automatically at `data/memo-superform.db`. A legacy SQL Server installation is optional and is opened read-only for migration only.

## Linux Support

> **No longer maintained.** Linux build/run support has been archived to the `codex/linux-archived` branch
> and is no longer updated here. For a Linux build, switch to that branch.

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
├── db.py              # SQLite data centre + read-only legacy import
├── recommender.py     # Smart review-recommendation engine
├── sqlite_schema.sql  # Runtime SQLite schema
├── schema.sql         # Legacy SQL Server schema reference
├── windows_tray.py     # Windows notification-area status
├── CHANGELOG.md        # Version history
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

| Memory Diary | Daily word journal with tiers + hearts on grind days, list/detail views |
| Study | Embeds Maimemo web, real-time study, follows dark theme |
- `index-anon.html`      # Anon’s Notebook frontend
- `css/style-anon.css`   # Anon’s Notebook styles
- `css/diary.css`       # Memory Diary styles
- `css/fonts.css`       # Localized fonts (full Chinese subsets)
- `js/diary.js`         # Memory Diary renderer
- `fonts/`              # Local font files (woff2 subsets)
> Default landing is `index.html` (original); `index-anon.html` is the alternate Anon’s Notebook frontend. Packaging must include `index-anon.html` and `fonts/`.

## Packaging
Double-click `dist/MemoSuperform.exe` to run. The exe bundles ECharts and SQLite, so committed charts and recommendations remain available offline; fetching new data and AI classification require network access.

## License

This project is open-sourced under [AGPL v3](LICENSE). You are free to use, modify, and distribute it, but any derivative work (including services provided over a network) must be open-sourced under the same license.

## 致谢 / Acknowledgements

### D_sakiko 与 GPT-SoVITS 语音资源

Memo Superform 的本地 TTS 资源包接入并适配了 [D_sakiko](https://github.com/MacchaPafe/D_sakiko) 的 GPT-SoVITS 推理相关内容，实际使用范围如下：

- `data/tts_pack/tts_engine/` 中的 GPT-SoVITS 推理运行时：模型加载、参考音频与逐字参考文本的条件输入、音频合成调用链，以及其所需的推理依赖约束（包括 `inference_cli.py`、`TTS_infer_pack/` 及相关运行时模块）。
- D_sakiko 发布资源中的丰川祥子 GPT / SoVITS 音色模型、日文参考音频和逐字参考文本，作为历史资料迁移的来源。这些模型与音频只由用户保存在本地 `data/tts_pack/` 中，不提交至本仓库，也不包含在发布的 EXE 内。

Memo Superform 自行实现了角色资料包、Web/API 集成、触摸与陪伴逻辑、Live2D 绑定、语音队列及前端设置；D_sakiko 的桌面 UI、聊天/LLM、角色配置和 Live2D 程序均未纳入本项目。

D_sakiko 按 GPL-3.0 发布；其所使用的 [GPT-SoVITS](https://github.com/RVC-Boss/GPT-SoVITS) 推理本体按上游许可证发布。涉及这些内容的部分保留原项目的版权和许可声明；如需再分发音色模型或参考音频，请自行确认相应音色、素材与角色的版权。

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
