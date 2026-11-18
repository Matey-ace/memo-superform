# Memo Superform 0.92 交付说明

本轮三件事：**修启动 404**、**修设置页滚不到底**、**新增「近期词汇阅读」四六级仔细阅读练习**。

- 分支：`codex/companion-redesign-test-build`
- 起点提交：`dab3d8e`（0.91）
- 版本：0.92
- 草稿 PR：https://github.com/Matey-ace/memo-superform/pull/7 （未合并 main，未发 Release）

---

## 一、启动 404

### 根因（实测复现，不是推测）

`server.py` 里静态目录原本取 `sys._MEIPASS`：

```python
WEB_DIR = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
```

PyInstaller onefile 的 `_MEIPASS` 是**一次性解压目录**，由「第一个启动的那个进程」负责在退出时删除，
并不跟着真正在服务网页的进程走。于是出现：

1. 某个进程退出，把 `_MEIxxxxx` 删掉（或部分删掉）；
2. 另一次启动因为单实例锁被占而**直接退出**，用户看到的却是一个仍然活着、但静态目录已被抽空的实例；
3. `/api/*` 这类由 Python 直接处理的接口仍然 200，页面却 404 —— 这正是「健康检查只看状态码」的盲区。

实测（0.91 与 0.92 均可复现）：

```
删除运行中实例 _MEI 目录里的 index.html 后：
  GET /index.html                -> 404
  GET /api/maimemo-auth/status   -> 200
```

三层原因：

| 层 | 问题 |
| --- | --- |
| A | `WEB_DIR` 绑在生命周期不受控的一次性解压目录上 |
| B | 健康判定只问「端口通不通 / 接口 200 不 200」，不问「页面能不能取到」 |
| C | 没有恢复分支：锁被占就当作「已在运行」，把用户送回坏页面 |

`%TEMP%` 下当时有 14 个泄漏的 `_MEI*` 目录，其中 2 个已经缺 `index.html`。

### 修法

**A. 静态目录每次请求都重新确认**（`server.py`）
新增 `WEB_DIR_REQUIRED`、`_WEB_DIR_CANDIDATES`、`web_dir_is_usable()`、`resolve_web_dir()`；
handler 每次请求用 `directory=resolve_web_dir()`，而不是构造时定死的常量。

需要说清楚的**能力边界**：onefile 打包时资源只在 `sys._MEIPASS` 里，
exe 同级目录和 `_internal` 都没有 `index.html`（已实测 `dist/` 里两者皆无）。
所以 `_WEB_DIR_CANDIDATES` 的后两项对 onefile 是**无害的死代码**（留给将来可能的 onedir 布局）。
这一步的作用是**准确检测**"这个目录还能不能服务页面"，不是把已经消失的目录变回来。
真正修掉 404 的是下面 B+C：判失败后精确定位并重启。
`tests/test_web_dir_resolution.py` 把这条边界钉住了。

**B. 健康检查改为「能取到页面」**（`launcher.py`）
`probe_instance_health(port)` 要求三条同时成立：
- 身份：`/api/app/current-mode` 返回的 mode 与预期一致；
- 页面：`/index.html` 状态 200 且 ≥2000 字节且含 `<html`/`<!doctype`；
- 关键静态资源：`/js/api.js`、`/css/style.css` 非空。

`find_running_app_url` 也换成它，半死实例不再被当成「已在运行」。

**C. 精确恢复**（`launcher.py`）
锁被占但无健康实例时：
1. 先等最多 6 秒让它自愈（可能正在冷启动）；
2. 仍不健康 → `_lock_owner_pid()` **只查监听本应用私有锁端口（15191）的那个 PID**（不是按进程名），
   `_pid_is_our_executable()` 确认映像是本应用后，`taskkill /PID <pid> /F /T` 只结束这一个进程；
3. 锁释放后重新走启动流程。

无法确认归属时（查不到 PID、是本进程、映像不符）**一律不动手**，改为明确报错。

另外 `cleanup_stale_runtime_dirs()` 在拿到锁之后清理自己遗留的 `_MEI*`，用「改名抢占再删」避免撞上正在启动的实例。

**这里自查时发现并修掉了一个会误删别人目录的缺陷**：原判定只看
`index.html` / `js/api.js` / `js/app.js` 三个文件名是否存在，而这套组合
对别的 PyInstaller 程序同样可能成立。用假目录实测复现：构造一个
「有这三个文件、但不属于本应用」的 `_MEI*`，旧逻辑**直接把它删了**。
现在改为「文件齐全 **且** `index.html` 内含本应用独有标识」双重判定，
无法确认归属时一律不动（宁可留垃圾也不误删），并加了 5 条单元测试锁住。

### 验证

- `tests/test_launch_health.py`（9 例）：含「状态 200 但页面 404」「空页面」「缺静态资源」「完全健康」「mode 不符」；清理目录只删自己的、绝不删当前运行时。
- `tests/test_stale_recovery.py`（16 例）：端口定位只认 `LISTENING`、不误匹配更长端口号、拒绝结束外来进程、拒绝结束自己、确认按 `/PID` 而非 `/IM`。
- 真实 EXE 实测：删掉运行中实例的 `index.html` → 页面 404 / 接口 200 → 再次启动 → 自动定位并结束残留实例 → 新实例页面 200。
- 重复启动（已有健康实例）：第二个进程退出码 0，页面仍是 200。

---

## 二、设置页滚不到底

### 根因（不是 `overflow` 配错）

`.settings-layout` 是 `height:100%` 的网格，而 `.settings-body` 只是普通块级。
网格行按 `min-height:auto` 被内容撑到 **1360px**，于是 `.settings-pages` 的
`clientHeight === scrollHeight === 1360` —— 它内部**没有**可滚动余量，
而外层 `.settings-content` 的 `overflow:hidden` 把超出部分直接裁掉。

所以「加高度」「去掉 overflow:hidden」都治不了：真正缺的是**高度约束链**。

### 修法（`css/notebook-settings.css`，只影响笔记本主题）

```css
html[data-ui-style="notebook"] .settings-panel .settings-body {
  display: flex; flex-direction: column; min-height: 0; overflow: hidden;
}
html[data-ui-style="notebook"] .settings-layout {
  flex: 1 1 auto; height: auto; min-height: 0; overflow: hidden;
}
```

`min-height:0` 断开 `min-height:auto` 的内容撑高，`flex:1 1 auto` 让布局占据剩余高度，
滚动因此真正落在 `.settings-pages` 上。

### 验证（真实滚轮 + 末尾控件真实可点）

先点进一个分类并展开所有 `<details>` 制造最长内容，再用真实 `mouse.wheel` 滚动：

| 主题 | 视口 | 滚动区 client/scroll | 滚后 scrollTop | 末尾控件 inView / focused / 可命中 |
| --- | --- | --- | --- | --- |
| notebook | 1440x900 | 723 / 1360 | 637 | true / true / true |
| notebook | 1280x720 | 543 / 1360 | 817 | true / true / true |
| notebook | 1024x640 | 463 / 1360 | 897 | true / true / true |
| standard | 1440x900 | 439 / 1556 | 1117 | true / true / true |

修复前：笔记本主题三种尺寸下都是 1360/1360，完全不可滚动；标准主题本来就正常（668/1556），未受影响。

---

## 三、近期词汇阅读（新功能）

### 3.1 取词

- 「今天已完成」用 `POST /study/get_today_items`，`is_finished=true`（只取已完成的）。
- 「最近几天」复用已有学习记录全量同步，按其 `last_study_date` 在本地过滤；默认最近 7 天，可选今天 / 3 天 / 7 天 / 14 天。
- 全部按**北京时间**切日；日期级时间戳只当日期，不伪造成具体答题时刻。
- 按 `voc_id` 去重，没有 `voc_id` 时退化为按规范化拼写去重（不会静默丢词）。
- 界面显式展示：日期范围、记录同步时间、候选词数量、数据完整性（完整/部分/过旧/空）。
- 空数据时区分「未完成首次同步」「缓存过旧」「范围内确实没有」，分别给重新读取 / 扩大范围 / 重新连接；
  **绝不用示例词冒充用户数据**。
- 对墨墨全程只读，不加词、不改记录、不写学习数据。

### 3.2 练习形态（四六级 Section C 仔细阅读）

- 一篇原创英文文章（约 305 词四级档），3 段，统一主题。
- **5 道单选题，每题 4 个选项 A–D，恰好一个最佳答案。**
- 四级 300–350 词、六级 400–450 词，差异同时在词汇层次、句式复杂度、信息密度、推断难度上，不只是长度。
- 阅读格式是**仔细阅读**（Careful Reading, Section C），**不是** Section B 段落匹配：
  不做千词长文、不出十道段落匹配题、不让读者选段落字母、不让一段对应多题。
  提示词里把这些旧形态**明确列为禁止项**。
- 目标词自然融入，允许词形变化并记录对应关系；覆盖判定按**词元**匹配（`art` 不会命中 `heart`）。
- 标注为「AI 原创模拟练习」，不冒充官方真题，不编造研究、专家、机构或背书。

### 3.3 生成流水线

生成 → 程序校验 → 独立审题 → 发布。

校验（`validate`）逐条硬性检查：5 题、每题 4 项、答案在 A–D、选项文本非空且不重复、
证据引文必须**真实出现在指定段落**、目标词必须在文中真实出现、正文字数落在难度区间、
`wordCount` 与正文一致、存在冻结答案。

独立审题（`reviewSemantics`）用另一次调用让模型自查：每题是否唯一最佳答案、依据是否成立、
干扰项是否合理、审题给出的最佳答案是否与冻结答案一致。**不一致就不放行**。

不合格的内容 `isSubmittable` 为 false，不能变成可提交状态；界面给真实重试入口与返回修改选词的入口。

### 3.4 作答与判分

- 专职入口「近期词汇阅读」，两套主题各自的观感。
- 文章与题目可同时查看；窄窗口（≤900px）提供切换，**切换保留阅读位置与已选答案**。
- 每题 A–D 可选可改，显示「已答 n / 5」；支持标记待检查、保存草稿、退出后继续。
- 答案/解析/翻译**默认全部隐藏**。
- 未答完提交会明确提示「还有 N 题没有作答」；取消后仍停在作答页，不误判。
- 判分**只用生成时冻结的答案**，提交时绝不再问 AI，确定性可复现；同一篇重复提交只算一次。
- 结果给出「本篇正确率」，并明确写：**不换算成真实四六级分数，也不代表这些单词已经掌握**。
- 每题展示：你选的、正确答案、可点击跳转并高亮的原文定位句、正确项为何成立、其余三项各自为何不成立。
- 另附目标词在本文语境下的用法回顾卡片。
- 重做会生成新的作答记录，不覆盖原记录。

### 3.5 存储与隔离

复用现有本地存储，按账号作用域分键（`profile:<id>`）。保存文章、题目、冻结答案、
讲解快照、词源与目标词、练习版本、草稿与作答记录。服务端校验归属；
换账号读不到别人的练习，用别的账号提交会被拒绝。作答页默认不暴露解析。

### 3.6 安全

四个新 JS 文件**完全没有** `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`
（严格扫描，排除注释后为 0 命中）。模型输出全部走 `textContent`/属性赋值，不拼进 HTML、
不拼进事件属性字符串。发送给模型的只有必要的候选词与难度，不发完整学习历史、不发凭据。

---

## 四、测试

### 自动化

| 项目 | 结果 |
| --- | --- |
| `tests/run.ps1` 全量回归 | **REGRESSION_SUITE_PASS** |
| Python 单元测试 | **560 通过**（0.91 时 551，本轮新增 9） |
| 新增阅读业务回归 | 31 通过 |
| 新增取词回归 | 16 通过 |
| 新增启动健康测试 | 9 通过 |
| 新增残留实例恢复测试 | 16 通过 |
| 阅读 UI 端到端（真实浏览器，两主题） | READING_UI_E2E_PASS |
| 资源加载（真实页面，无桩） | ASSET_CHECK_PASS |
| 设置页滚动（真实滚轮，3 尺寸 × 2 主题） | SETTINGS_SCROLL_PASS |
| 两主题视觉差异 | THEME_VISUAL_PASS（12 项样式属性不同） |
| 打包后 `--verify-build` | passed=true，30 项检查 |
| 最终 EXE 全流程 | EXE_FLOW_PASS（29 步） |

### 最终 EXE 全流程（隔离数据目录）

`dist\MemoSuperform.exe --mode web`，`MEMO_DATA_DIR` 指向 `%TEMP%` 下的独立目录，
用 Edge + Playwright 真实点击：

获取近期词汇 → 生成文章与五道单选题 → 作答 → 保存草稿 → 重新打开面板 → 提交判分 → 查看解析 → 定位句跳转。

29 步全过，全程无控制台错误、无 404 / 失败请求、只判分一次。

**验收期间自查出一次严重的验证偏差，已纠正并重做**：先前我为了调试在 8888 上留了一个
`python server.py` 开发服务器，导致「EXE 验收」实际上访问的是开发服务器而不是打包后的
二进制——那些通过结果不算数。已确认 8888 上没有其它进程后重跑，并在脚本开头打印
`Get-Process -Id <listening pid>` 的 `ProcessName/Path`，确认为
`MemoSuperform @ D:\MeMo1\dist\MemoSuperform.exe` 才算数。

### 真实产品链路（不是"整层打桩"）

原有 29 步流程把业务模块整体替换成了桩，只能证明界面骨架可用。
本轮另加 `real-product-flow.js`：页面、`reading-practice.js`、`recent-vocab.js`、
存储、判分**全部用仓库真实代码**，只替换两处外部依赖（墨墨账号读取、AI 上游调用）。
在真实 EXE 上两主题均 `REAL_PRODUCT_FLOW_PASS`；全选 B 稳定得 3/5，证明判分用的是冻结答案。

### 真实 EXE 上的残留实例恢复（故障可见 → 自动恢复）

在同一台机器、同一个二进制上完整走了一遍：

1. 正常启动，页面 200；
2. 只删掉**正在服务的那一份** `_MEIPASS` 里的 `index.html`；
3. 页面立刻 404，而 `/api/maimemo-auth/status` 仍是 200（正是用户报的"接口活着、页面打不开"）；
4. 再次双击启动；
5. 旧实例被精确定位并结束（pid 42664 → gone），新实例起在新解压目录 `_MEI6082`，页面恢复 200。

复现结论：404 的根因确实是"静态目录绑在一次性的解压目录上 + 健康判定不看页面能不能打开"，
不是路由或缓存问题。

### 本轮发现并修掉的自测问题

- `dedupe` 原本会**丢弃**没有 `voc_id` 的记录，导致「学过却不出现」；改为按规范化拼写兜底去重。
- `collect` 原本不返回起止日期，而界面必须展示日期范围；补 `start`/`end`。
- `verify_build` 原本不检查新增的六个阅读资源，缺文件时会「按钮在、点了没反应」；补齐检查。
- **界面调 `generate()` 时没传 `source` / `accountScope`**，而业务层要求 `source.rangeKey`，
  结果是点「生成练习」100% 失败。这条是独立审查指出的阻断问题，已用真实模块复现
  （`UI_ARGS → source.rangeKey 缺失`）并修复，补传后实测可正常生成。
- **冻结答案只校验长度不校验 id 集合**：塞两条同 id 就能让某题脱离冻结、判分回落到可篡改字段。
  已改为「id 不重复 + 与题目 id 集合一致 + 与展示答案一致」三重校验。
- **审题只回 1 题也判通过**：另外 4 题从未被独立审题却可发布。已改为逐题覆盖，缺一题即拒。
- **`reviewed` 是个可任意置位的布尔**：改成 true 就能提交。已要求同时满足
  `reviewProblems` 为空、`reviewedAt` 可解析、逐题结论数量与题目数一致。
- **`accountScope` 恒为 anonymous**：两个真实账号的草稿混在同一个存储键里。已把采集到的
  作用域一路传到生成/保存/读取/提交/列表，并监听 `memo-account-changed` 作废在途任务。
- **「重做」返回的是上一次的分数**（与界面注释"成绩另记一条"矛盾）：提交去重原本只按
  `practiceId`。已引入 `attemptKey`——同一会话连点只算一次，重做换 key 重新判分。
- **引文只校验"3 个词元连续出现"**：跨句拼接、纯虚词都能过。已要求含实词且是原文连续片段。
- **覆盖度/题型/干扰项只报警告**：5 题挤在一段、全同题型、干扰项含正确答案都能通过。
  已升级为硬失败。
- **接口 500 被报成"你没学过"**：`recordsError` 时 `reason` 仍是 `empty`；成功时 `reason` 也仍是
  `empty`。已改为错误优先，成功时清空 reason。
- **「今天」只读 `today_items`**：今日接口一挂，本地明明有今天的记录也报"今天没学"。已改为以本地
  记录为底合并今日接口。
- **题材永远是"校园"**：界面从不传 theme。已按目标词稳定散列轮换，并显示在文章信息里
  （同组词必得同一题材，换组词会换题材）。

---

## 五、两主题隔离

- 新增样式分别写在 `css/reading-practice.css`（全部规则前缀 `html[data-ui-style="standard"]`）
  与 `css/reading-practice-notebook.css`（全部规则前缀 `html[data-ui-style="notebook"]`），
  交叉检查确认互不越界。
- `js/ui-style.js` 只在各自分支加载各自的样式表，实测两主题各自只加载自己那一份。
- 视觉实测：根容器/标题/按钮/正文/卡片的字体、背景、圆角、颜色、字距等 **12 项属性不同**，
  两套主题不是同一皮肤换名。
- 受保护的 15 个笔记本文件逐个 `git diff` 确认**零改动**；
  `tests/font-gif-manifest.sha256` 仍是 1006 行。
- 笔记本侧本轮只动允许的两处：设置滚动修复 + 阅读功能的最小入口与页面。

---

## 六、产物

- 目录：`D:\MeMo1\dist\MemoSuperform-0.92-reading-practice\`
- 主程序：`D:\MeMo1\dist\MemoSuperform-0.92-reading-practice\MemoSuperform.exe`
- 版本：0.92，`frozen=true`
- 大小：98,281,558 字节
- 启动：双击，或 `MemoSuperform.exe --mode web` / `--mode desktop`
- 构建标识：`0.92`，`--verify-build` 通过 30 项检查
- SHA256：`CD123B2BEEBF3EBFBEBE09C9ACAC75766457DFB4BB663A704C1971BD94419832`

---

## 七、已知边界

- 真实墨墨 OAuth 全流程需要用户交互，自动化里没有跑；相关代码路径未改动，沿用 0.91 已验证的行为。
- 真实 AI 生成的质量受模型波动影响；本轮用固定桩验证链路与校验/审题/判分的硬约束，
  真实模型的输出仍可能被校验拒绝——这正是重试入口存在的原因。
- 判分口径是「本篇正确率」，不是四六级分数，也不是词汇掌握率。
