# Memo Superform · 墨墨开放平台申请材料

## 应用信息

- 应用名称：`Memo Superform`
- 应用类型：纯前端应用
- 主页：`https://matey-ace.github.io/memo-superform/`
- OAuth 回调：`https://matey-ace.github.io/memo-superform/oauth/callback.html`
- 已获批范围：`openid profile offline_access open.memo.study open.memo.content`。

## 用途说明

Memo Superform 是 Windows 本地运行的学习数据仪表盘。用户主动授权后，应用读取学习进度、学习记录和云词本，在用户设备本地生成统计图表、同步状态和复习提醒。数据默认保存于本机 SQLite；设置中提供断开账号和删除当前档案本机学习数据的入口。

OAuth 使用 Authorization Code + PKCE S256。GitHub Pages 只承载介绍页、授权启动页和回调页；回调页只将短期授权码与 state 通过 `memo-superform://` 交给已运行的桌面应用，页面不接触 access token、refresh token 或 PKCE verifier。桌面应用经 localhost 代理访问官方接口，并对白名单接口施加平台公开的统一限流。

## 接口范围

- 学习进度：`study/get_study_progress`
- 今日条目：`study/get_today_items`
- 学习记录：`study/query_study_records`
- 云词本：`notepads`、`notepads/{id}`

开放平台已批准 study/content 的读写 scope；当前版本仍在本机代理层强制白名单，只使用上述读取接口，不会向墨墨云端写入学习记录、云词本或内容。

## 嵌入式学习页确认项

应用保留本地嵌入式学习页、主题与快捷键增强，以便用户在桌面窗口内学习。正式提交审核前，请通过 Issue 或飞书群确认该网页代理、主题与快捷键注入是否可随第三方应用发布；若平台要求调整，将在正式发布前按确认结果处理。
