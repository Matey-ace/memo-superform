# 本轮（0.92）接口契约与文件所有权

基线 `dab3d8e`，版本 0.91 → 本轮 0.92。两条主线：修两个故障 + 新增"近期词汇阅读"。

## 已由主执行 AI 完成（勿重复修改）

| 文件 | 改动 | 状态 |
|---|---|---|
| `css/notebook-settings.css` | 高度链修复（.settings-body 变 flex、.settings-layout 用 flex:1 替代 height:100%） | 已改，实测滚轮可达底部 |
| `server.py` | `WEB_DIR_REQUIRED`/`web_dir_is_usable`/`resolve_web_dir` 自愈；handler 用 `resolve_web_dir()` | 已改，7 项测试通过 |
| `launcher.py` | `probe_instance_health`/`find_running_health`/`recover_stale_instance`；启动流程按健康判定放行；verify_build 增首页渲染检查 | 已改 |
| `tests/launch-health-regression.py` | 7 项健康检查测试 | 新增 |

## 文件所有权（严格划分，避免并行覆盖）

### 子智能体 A：近期词汇与阅读业务（纯逻辑，无样式）
可写：
- `js/recent-vocab.js`（新）— 候选词获取、筛选、去重、规范化、完整性判定
- `js/reading-practice.js`（新）— 生成请求、结构校验、确定性判分、存储读写
- `tests/recent-vocab-regression.js`（新）
- `tests/reading-practice-regression.js`（新）
禁改：`index.html`、`js/app.js`、`js/api.js`、任何 css、`server.py`、`launcher.py`

### 子智能体 B：阅读界面与两套主题视觉
可写：
- `css/reading-practice.css`（新）— 普通版视觉
- `css/reading-practice-notebook.css`（新）— 笔记本视觉
- `js/reading-practice-ui.js`（新）— 作答/草稿/提交/解析交互
禁改：`index.html`、`js/app.js`、`js/ui-style.js`、`css/notebook-settings.css`、A 的任何文件

### 主执行 AI（我）
`index.html`、`js/app.js`、`js/api.js`、`js/ui-style.js`、`server.py`、`launcher.py`、
`build_info.py`、`tests/run.ps1`、打包与最终验证。

## 数据契约

### 候选词（`js/recent-vocab.js` 导出）
```js
window.MemoRecentVocab = {
  RANGES: [{key:'today',label:'今天',days:0},{key:'d3',label:'最近 3 天',days:3},
           {key:'d7',label:'最近 7 天',days:7},{key:'d14',label:'最近 14 天',days:14}],
  async collect(rangeKey) -> {
    ok: boolean,
    reason?: 'no-account'|'not-synced'|'partial'|'empty'|'error',
    rangeKey, rangeLabel, days,
    syncedAt: string|null,        // 学习记录同步时间
    completeness: 'complete'|'partial'|'stale'|'empty',
    candidates: [{ vocId, spelling, lastStudyDate, feedback, studyCount, source }],
      // source: 'today-items' | 'study-records'
    rawCount: number,             // 去重前
    accountScope: string          // 账号隔离用
  }
}
```
规则：今天走 `POST /study/get_today_items`（`is_finished:true`）；最近 N 天用本地
完整学习记录按 `last_study_date`（北京时间）筛选；按 voc_id 去重；只读，不写学习记录；
不给官方接口编造 `last_study_date` 查询参数；不把日期当逐词答题时间。

### 练习对象（`js/reading-practice.js` 导出）
```js
window.MemoReadingPractice = {
  LEVELS: [{key:'cet4',label:'四级',targetWords:320,allowed:[300,350]},
           {key:'cet6',label:'六级',targetWords:425,allowed:[400,450]}],
  async generate({candidates, levelKey, targetWords, theme, onProgress}) -> {ok, practice|reason},
  validate(practice) -> {ok, errors:string[]},          // 结构 + 五题四选项 + 依据存在
  async reviewSemantics(practice) -> {ok, notes},        // 独立审题（第二遍 AI）
  grade(practice, answers) -> {correct, total, perQuestion:[{id,chosen,correct,ok}]},
  save / load / listDrafts / submit / listAttempts       // 按账号档案隔离
}
```
练习对象冻结字段（判分只认这些，提交时不重新问 AI）：
```js
{
  schema: 'memo-reading-v1', id, createdAt, level, levelLabel,
  title, paragraphs: string[], wordCount,
  source: { rangeKey, rangeLabel, days, syncedAt, completeness },
  targetWords: [{ vocId, spelling, surface, paragraphIndex, charOffset }],
  questions: [{ id, stem, options:[{key:'A',text},...], answer:'A'|'B'|'C'|'D',
                evidence: {paragraphIndex, quote}, explanation,
                distractors:[{key,why}], type:'detail'|'main'|'infer'|'vocab'|'attitude' }],
  generation: { provider, model, promptVersion, reviewedAt, reviewNotes },
  accountScope
}
```

### 界面契约（`js/reading-practice-ui.js`）
```js
window.MemoReadingUI = {
  open(),                       // 打开"近期词汇阅读"入口页
  close(),
  openPractice(idOrPractice),   // 作答页
  mount(rootElement)            // 由 app.js 在主题就绪后调用
}
```
必须实现：文章/题目同屏；窄窗口切换并保留阅读位置与答案；每题可选改 A~D；
已答/未答计数；标记待检查；保存草稿、退出续做；默认隐藏答案解析翻译；
未答完提交提示；防重复提交；提交后逐题展示用户答案/正确答案/定位句/逐项解析；
词汇复习；重做生成独立记录。
**只用 textContent / createElement，绝不用 innerHTML 插入模型输出。**

## AI 调用
复用现有 `AIAPI`（`js/api.js` 顶层 const，**必须用 `typeof AIAPI !== 'undefined'` 取，
不能写 `window.AIAPI`**）。只发送：目标词表、难度、主题、题目结构要求。
不发送完整学习历史、不发送墨墨凭据或 API Key。
