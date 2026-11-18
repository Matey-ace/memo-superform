# 原生答题按钮图层修复

## 用户要求与范围

用户明确要求先修复父壳新增的熟悉/模糊等悬浮答题按钮遮住墨墨原生快捷键说明关闭入口的问题；改为注入样式覆盖网页原本按钮，保留原生层级。

本次仅主主题、非陪伴 dashboard 及学习原节点迁入的 fullscreenModal 内取消重复 `.study-web-actions` 的显示。既有 DOM 暂保留供其他模式使用，但在目标模式下不绘制、不占点击区、不能Tab进入。notebook 与 companion-mode 不匹配新规则，其原行为不变。原生 `.rev-resp-btns` 使用已批准的 `memo-study-skin` 注入皮肤，不新建点击控件，不代理/重复派发答案，不改原生位置、z-index、事件或顺序。

产品差异位于 `css/theme-constructivist-components.css` 的单条严格守卫规则。`js/study-web.js`、`js/study-shortcuts.js`、两份共享学习CSS未因本修复改动。此前已批准的注入视觉标记是原生皮肤启用条件，不在这里扩大授权。

## 真实页面验证

证据目录均保留原始PNG和对应metrics，不裁切、不掩盖、不暂停素材：

| 状态 | 证据目录 | 实测 |
|---|---|---|
| 修复前同一原生说明 | `native-answer-fix/before/` | 目标中心的父页命中为DIV.study-web-actions，重复栏display:flex |
| 不刷新当前词条加载产品CSS | `native-answer-fix/overlay-removed/` | 同一确认中心父页命中IFRAME，重复栏display:none |
| 关闭原生说明 | `native-answer-fix/native-dialog-closed/` | 先取消独立的闲置连接中断提示，再真实点击原生确认；确认框隐藏 |
| 同源代理重新加载新注入 | `native-answer-fix/persistent-native-injection/` | iframe真实类memo-main-redesign memo-standard，原生按钮纸墨色、position:relative、z-index:auto |
| 持久注入后重新打开原生说明 | `native-answer-fix/persistent-native-guide-open/` | 父页命中IFRAME，子页命中原生taroify-dialog__confirm；原生按钮仍259×63px |

最后再次真实点击原生确认，不force、不派发合成事件，等待 `.shortcut-help-content` 隐藏，输出 `PERSISTENT_INJECTION_NATIVE_CONFIRM_CLICK_PASS`。

原生更多菜单的文字节点具有不可点击的文本层；初次以getByText点击超时，随后按其实际 `.taroify-button` 父级定位成功。这是测试定位修正，没有修改网页事件或穿透点击。

代理原进程在当前词条正/反面基线取证后，以相同55395端口和相同隔离data-main重新运行；浏览器资料未更换，未读取或导出cookie/storage。网页回到协议入口时，检测到勾选框未选，助手中止进入；由用户本人确认协议并进入单词页后才继续只读验证。

## 自动化

- `node tests/redesign/native-answer-layer.js`：首次54项通过，补测原节点移入全屏后独立复跑为**78项通过**。三尺寸×明暗的独立无账号fixture；两宿主原生说明关闭实点、答案单击仅一次、原生按钮前后矩形和顺序一致；notebook/companion重复栏原行为保持。fixture答案计数不是用户学习记录。
- [既有完整回归实录](round1/followup-full-regression-pass.log)：551项Python及五组浏览器脚本均通过；测试焦点前提修正说明见[工作日志](worklog.md)。
- `node tests/redesign/study-theme-isolation.js --out docs/redesign/sa6/lead-round1-review`：父级独立复跑193项通过；[原始结果](sa6/lead-round1-review/isolation-results.json)与原SA-6证据分开。
- `python tests/redesign/asset_guard.py verify`：1063公共资产、11个保护片段检查通过，无声明范围外变化。
- 辅助脚本 `tests/redesign/native-layer-live.js` 只采样式、矩形、命中和截图；不读取表单值、认证URL或会话数据。测试证据目录拒绝覆盖。

## 边界

真实答题、切词判断和词条保存继续由用户本人控制，助手没有点击真实答案或保存按钮。原生三种判断标签与布局得到实际DOM证据，但不据此声称云端三种答案/保存业务均通过。主界面重设计整体仍未完成，SA-8轮1为不通过，待既定后续修复、SA-5/7、轮2/3和SA-9。截图已生成；当前模型不能图像输入，没有伪称目视美学验收。
