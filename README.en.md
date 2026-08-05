🌐 English | [简体中文](./README.md)

# Memo Superform

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