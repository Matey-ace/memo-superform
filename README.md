# Memo Superform - 墨墨数据磁贴

一个纯前端 + 轻量本地代理的**墨墨背单词数据可视化仪表盘**。

以磁贴/便签风格的卡片承载数据图表，支持分屏布局和全屏放大。

## Quick Start

### 1. 启动代理服务器
```bash
cd memo-superform
python server.py
```
服务器启动后会显示访问地址（默认 http://localhost:8888）。

### 2. 打开浏览器
访问 http://localhost:8888

### 3. 配置 Token
- 点击右上角 设置 按钮
- 填入墨墨 API Token（App: 我的 -> 更多设置 -> 实验功能 -> 开放 API）
- 点击「测试连接」验证
- 保存后自动加载数据

> 代理服务器必须保持运行，关闭终端窗口会停止服务。

## 为什么需要代理服务器？

墨墨开放 API 不支持 CORS（跨域资源共享），浏览器直接调用会被拒绝（返回 403）。
代理服务器的作用是：
1. 转发请求到墨墨 API（去掉浏览器的 Origin 头）
2. 同时提供静态文件服务（HTML/CSS/JS）

代理服务器只运行在你的本地，Token 不会经过任何第三方。

## 功能特性

### 4 个核心图表
| 图表 | 说明 |
|------|------|
| 打卡热力图 | GitHub 风格的年度学习日历热力图 |
| 学习趋势图 | 新学/复习/总计趋势，支持 7/30/90/全部天切换 |
| 记忆曲线 | 学习次数分布 + 累计留存率双轴图 |
| AI 单词分类 | 调用 AI 将云词本单词按主题分类统计 |

### 交互功能
- 分屏布局：单格 / 左右分屏 / 三分屏 / 田字格
- 全屏放大：点击卡片右上角按钮
- 图表切换：每个磁贴可独立切换图表类型
- 本地缓存：API 数据缓存 30 分钟

### AI 分类配置
支持 OpenAI 兼容接口（DeepSeek、智谱、通义千问等）：
- API Endpoint：默认 https://api.deepseek.com/v1
- 模型：默认 deepseek-chat

## 文件结构
```
memo-superform/
├── server.py       # 本地代理服务器
├── index.html      # 主页面
├── css/style.css   # 样式
├── js/
│   ├── api.js      # API 封装（通过代理）
│   ├── charts.js   # ECharts 图表
│   ├── layout.js   # 分屏/全屏布局
│   └── app.js      # 应用入口
└── README.md
```

## API 说明
基于墨墨开放 API (https://open.maimemo.com/) 开发：
- POST /api/v1/memo/study/query_study_records - 查询学习记录
- GET /api/v1/memo/notepads - 查询云词本列表
- GET /api/v1/memo/notepads/{id} - 获取云词本详情
- POST /api/v1/memo/study/get_study_progress - 获取今日进度
