// Memo Superform - 近期词汇阅读 · 界面与交互层
//
// 两套主题共用这一份结构与逻辑，视觉差异全部由样式表承担
// （css/reading-practice.css / css/reading-practice-notebook.css）。
//
// 安全约定：模型输出与词汇文本一律用 createElement + textContent 渲染，
// 本文件不出现 innerHTML / outerHTML / insertAdjacentHTML / document.write，
// 也不把任何数据拼进内联事件属性。
(function (root) {
    'use strict';

    var RANGES = [
        { key: 'today', label: '今天' },
        { key: 'd3', label: '最近 3 天' },
        { key: 'd7', label: '最近 7 天' },
        { key: 'd14', label: '最近 14 天' }
    ];
    var LEVELS = [
        { key: 'cet4', label: '四级', target: 320, allowed: [300, 350], hint: '约 300~350 词 · 生活与校园话题' },
        { key: 'cet6', label: '六级', target: 425, allowed: [400, 450], hint: '约 400~450 词 · 更复杂的句法与推理' }
    ];
    var DEFAULT_RANGE = 'd7';
    var DEFAULT_LEVEL = 'cet4';
    var MAX_WORDS = 40;

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
    }

    function clear(node) {
        while (node && node.firstChild) node.removeChild(node.firstChild);
    }

    function vocab() { return typeof root.MemoRecentVocab !== 'undefined' ? root.MemoRecentVocab : null; }
    function practiceModule() { return typeof root.MemoReadingPractice !== 'undefined' ? root.MemoReadingPractice : null; }

    /* ================= 状态 ================= */

    var state = {
        phase: 'setup',          // setup | generating | answering | reviewing
        rangeKey: DEFAULT_RANGE,
        levelKey: DEFAULT_LEVEL,
        /* 当前账号作用域：草稿与成绩按它分区存储。取不到就留空，
         * 业务层会退到 anonymous（未登录也能练，但不与任何账号混在一起）。 */
        accountScope: '',
        collection: null,        // collect() 的结果
        selected: [],            // 选中的 vocId
        candidates: [],
        practice: null,
        answers: {},             // questionId -> 'A'..'D'
        flagged: {},             // questionId -> true
        attempt: null,           // 判分记录
        /* 每次开始作答生成一个新 key：同一 key 重复提交只算一次（防连点），
         * 换 key 就是新的一次作答（重做必须重新判分），两者靠它区分。 */
        attemptKey: '',
        showExplanation: {},
        pane: 'article',         // 窄窗口：article | questions
        scrollTop: 0,
        busy: false,
        notice: null,
        progress: null,
        error: null
    };

    var mountedHost = null;
    var shell = {};
    var generationToken = 0;
    var accountBound = false;

    /* 切换账号时必须作废旧任务并清掉上一位用户的痕迹。
     * 否则：账号 A 的生成请求晚回来，token 仍然相等，会被写进 state.practice，
     * 随后以账号 B 的作用域存进 B 的存储（实测复现过这种串号）。
     * 另外 token 归零后迟到的 A 响应必然对不上，一定被丢弃。 */
    function resetForAccountChange() {
        generationToken += 1;
        state.accountScope = '';
        state.collection = null;
        state.candidates = [];
        state.selected = [];
        state.practice = null;
        state.answers = {};
        state.flagged = {};
        state.attempt = null;
        state.showExplanation = {};
        state.phase = 'setup';
        state.notice = null;
        state.progress = null;
        state.error = null;
        state.busy = false;
        var module = practiceModule();
        if (module && typeof module.cancel === 'function') {
            try { module.cancel(); } catch (error) { /* 忽略 */ }
        }
    }

    function bindAccountChange() {
        if (accountBound) return;
        accountBound = true;
        try {
            if (typeof root.addEventListener === 'function') {
                root.addEventListener('memo-account-changed', function () {
                    resetForAccountChange();
                    if (state.phase !== 'setup' && mountedHost) renderSetup();
                });
            }
        } catch (error) { /* 事件不可用就当没有，不影响主流程 */ }
    }

    /* ================= 骨架 ================= */

    function buildShell(host) {
        clear(host);

        var head = el('div', 'reading-head');
        var title = el('h2', 'reading-title', '近期词汇阅读');
        title.id = 'readingTitle';
        var subtitle = el('div', 'reading-subtitle', '用最近学过的词，练一篇四六级仔细阅读');
        head.appendChild(title);
        head.appendChild(subtitle);
        head.appendChild(el('div', 'reading-head-spacer'));

        var backBtn = el('button', 'reading-btn', '返回设置');
        backBtn.type = 'button';
        backBtn.hidden = true;
        head.appendChild(backBtn);

        var body = el('div', 'reading-body');

        host.appendChild(head);
        host.appendChild(body);

        shell = { head: head, title: title, subtitle: subtitle, backBtn: backBtn, body: body };
        backBtn.addEventListener('click', function () { renderSetup(); });
        return shell;
    }

    /* ================= 工具：元信息 / 提示 ================= */

    function metaGrid(items) {
        var grid = el('div', 'reading-meta');
        items.forEach(function (item) {
            var box = el('div', 'reading-meta-item');
            box.appendChild(el('span', 'reading-meta-label', item.label));
            var value = el('span', 'reading-meta-value', item.value === null || item.value === undefined || item.value === '' ? '—' : item.value);
            if (item.state) value.setAttribute('data-state', item.state);
            box.appendChild(value);
            grid.appendChild(box);
        });
        return grid;
    }

    function noticeBox(kind, text, actions) {
        var box = el('div', 'reading-notice');
        if (kind) box.setAttribute('data-kind', kind);
        box.appendChild(el('div', null, text));
        if (actions && actions.length) {
            var row = el('div', 'reading-notice-actions');
            actions.forEach(function (action) {
                var btn = el('button', 'reading-btn', action.label);
                btn.type = 'button';
                btn.addEventListener('click', action.onClick);
                row.appendChild(btn);
            });
            box.appendChild(row);
        }
        return box;
    }

    function completenessLabel(value) {
        if (value === 'complete') return { text: '完整', state: 'ok' };
        if (value === 'partial') return { text: '不完整（部分记录）', state: 'warn' };
        if (value === 'stale') return { text: '缓存偏旧', state: 'warn' };
        if (value === 'empty') return { text: '暂无数据', state: 'error' };
        return { text: value || '未知', state: 'warn' };
    }

    function formatTime(value) {
        if (!value) return '';
        var date = new Date(value);
        if (isNaN(date.getTime())) return String(value);
        var pad = function (n) { return n < 10 ? '0' + n : String(n); };
        return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) +
            ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
    }

    /* ================= 第一步：选范围、取词 ================= */

    /* 开始一次新的作答会话：换 key，使这次提交一定是新的一次判分。 */
    function newAttemptKey() {
        return 'sess-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e6).toString(36);
    }

    function renderSetup() {
        state.phase = 'setup';
        state.practice = null;
        state.answers = {};
        state.flagged = {};
        state.attempt = null;
        state.pane = 'article';
        if (shell.backBtn) shell.backBtn.hidden = true;
        var body = shell.body;
        clear(body);

        var section = el('div', 'reading-section');
        section.appendChild(el('h3', 'reading-section-title', '① 选择时间范围'));

        var rangeRow = el('div', 'reading-ranges');
        RANGES.forEach(function (range) {
            var btn = el('button', 'reading-range', range.label);
            btn.type = 'button';
            btn.setAttribute('aria-pressed', String(range.key === state.rangeKey));
            btn.addEventListener('click', function () {
                if (state.rangeKey === range.key) return;
                state.rangeKey = range.key;
                Array.prototype.forEach.call(rangeRow.children, function (child) {
                    child.setAttribute('aria-pressed', String(child === btn));
                });
                loadCandidates();
            });
            rangeRow.appendChild(btn);
        });
        section.appendChild(rangeRow);

        var metaHost = el('div');
        section.appendChild(metaHost);
        body.appendChild(section);

        var noticeHost = el('div');
        body.appendChild(noticeHost);

        var wordsHost = el('div');
        body.appendChild(wordsHost);

        var levelSection = el('div', 'reading-section');
        levelSection.appendChild(el('h3', 'reading-section-title', '② 选择难度'));
        var levelRow = el('div', 'reading-levels');
        LEVELS.forEach(function (level) {
            var btn = el('button', 'reading-level');
            btn.type = 'button';
            btn.setAttribute('aria-pressed', String(level.key === state.levelKey));
            btn.appendChild(el('span', 'reading-level-name', level.label));
            btn.appendChild(el('span', 'reading-level-hint', level.hint));
            btn.addEventListener('click', function () {
                state.levelKey = level.key;
                Array.prototype.forEach.call(levelRow.children, function (child) {
                    child.setAttribute('aria-pressed', String(child === btn));
                });
            });
            levelRow.appendChild(btn);
        });
        levelSection.appendChild(levelRow);
        body.appendChild(levelSection);

        var actionSection = el('div', 'reading-section');
        actionSection.appendChild(el('h3', 'reading-section-title', '③ 生成练习'));
        var actionRow = el('div', 'reading-actions');
        var genBtn = el('button', 'reading-btn reading-btn-primary', '生成练习');
        genBtn.type = 'button';
        genBtn.addEventListener('click', startGeneration);
        actionRow.appendChild(genBtn);
        var statusNote = el('span', 'reading-status-note', '');
        actionRow.appendChild(statusNote);
        actionSection.appendChild(actionRow);
        var progressHost = el('div');
        actionSection.appendChild(progressHost);
        body.appendChild(actionSection);

        shell.genBtn = genBtn;
        shell.statusNote = statusNote;
        shell.progressHost = progressHost;
        shell.metaHost = metaHost;
        shell.noticeHost = noticeHost;
        shell.wordsHost = wordsHost;

        loadCandidates();
    }

    async function loadCandidates() {
        var api = vocab();
        var metaHost = shell.metaHost;
        var noticeHost = shell.noticeHost;
        var wordsHost = shell.wordsHost;
        if (!metaHost) return;

        clear(metaHost);
        clear(wordsHost);
        clear(noticeHost);
        metaHost.appendChild(el('div', 'reading-notice', '正在读取最近的学习记录…'));

        var collection = null;
        if (!api || typeof api.collect !== 'function') {
            collection = { ok: false, reason: 'error', notes: ['词汇模块没有加载'], candidates: [], completeness: 'empty' };
        } else {
            try {
                collection = await api.collect(state.rangeKey);
            } catch (error) {
                collection = {
                    ok: false, reason: 'error', candidates: [], completeness: 'empty',
                    notes: ['读取近期词汇失败：' + (error && error.message ? error.message : String(error))]
                };
            }
        }
        state.collection = collection;
        /* 采集结果里带着当前账号作用域，存下来供生成/草稿/成绩复用；
         * 不存的话所有账号会共用同一个存储分区（实测复现过）。 */
        if (collection && collection.accountScope) state.accountScope = collection.accountScope;

        clear(metaHost);
        var complete = completenessLabel(collection.completeness);
        metaHost.appendChild(metaGrid([
            { label: '日期范围', value: collection.start && collection.end ? collection.start + ' ~ ' + collection.end : (collection.rangeLabel || '—') },
            { label: '记录同步时间', value: formatTime(collection.syncedAt) || '未知', state: collection.syncedAt ? '' : 'warn' },
            { label: '候选词数量', value: String((collection.candidates || []).length) },
            { label: '数据完整性', value: complete.text, state: complete.state }
        ]));

        clear(wordsHost);
        clear(noticeHost);

        var candidates = Array.isArray(collection.candidates) ? collection.candidates : [];
        state.candidates = candidates;

        if (!collection.ok || !candidates.length) {
            var reasonText = {
                'no-account': '还没有连接墨墨账号，无法读取学习记录。',
                'not-synced': '本地还没有学习记录，需要先完成一次同步。',
                'partial': '学习记录同步不完整，可能漏掉一部分近期单词。',
                'empty': '所选时间范围内没有已完成的单词。',
                'error': '读取学习记录时出错。'
            }[collection.reason] || '没有可用的候选词。';
            var actions = [
                { label: '重新读取', onClick: loadCandidates },
                { label: '扩大范围', onClick: function () { state.rangeKey = 'd14'; renderSetup(); } }
            ];
            if (collection.reason === 'no-account') {
                actions.push({ label: '重新连接账号', onClick: function () { root.location.reload(); } });
            }
            var box = noticeBox('warn', reasonText + ' 这里不会用示例词代替你的数据。', actions);
            if (collection.notes && collection.notes.length) {
                var list = el('ul');
                list.style.margin = '8px 0 0 18px';
                collection.notes.slice(0, 4).forEach(function (note) {
                    list.appendChild(el('li', null, String(note)));
                });
                box.appendChild(list);
            }
            noticeHost.appendChild(box);
            updateGenButton();
            return;
        }

        if (collection.completeness !== 'complete') {
            noticeHost.appendChild(noticeBox(collection.completeness === 'empty' ? 'warn' : 'warn',
                complete.text + '：结果可能偏少或偏旧，已尽量读全可用记录。',
                [
                    { label: '重新读取', onClick: loadCandidates },
                    { label: '扩大范围', onClick: function () { state.rangeKey = 'd14'; renderSetup(); } }
                ]));
        }

        renderWords(candidates);
        updateGenButton();
    }

    function renderWords(candidates) {
        var host = shell.wordsHost;
        clear(host);

        var section = el('div', 'reading-section');
        var head = el('h3', 'reading-section-title', '候选词');
        var count = el('span', 'reading-word-count', '');
        head.appendChild(count);
        section.appendChild(head);

        // 默认选中：按最近学习优先，取不超过 MAX_WORDS 个
        if (!state.selected.length) {
            state.selected = candidates.slice(0, Math.min(MAX_WORDS, candidates.length))
                .map(function (item) { return item.vocId || item.spelling; });
        }

        var wrap = el('div', 'reading-words');
        candidates.forEach(function (item) {
            var key = item.vocId || item.spelling;
            var chip = el('button', 'reading-word');
            chip.type = 'button';
            chip.setAttribute('aria-pressed', String(state.selected.indexOf(key) >= 0));
            chip.appendChild(el('span', null, item.spelling));
            if (item.lastStudyDate) {
                var date = el('span', 'reading-word-count', String(item.lastStudyDate).slice(5));
                chip.appendChild(date);
            }
            chip.addEventListener('click', function () {
                var index = state.selected.indexOf(key);
                if (index >= 0) state.selected.splice(index, 1);
                else state.selected.push(key);
                chip.setAttribute('aria-pressed', String(index < 0));
                count.textContent = '已选 ' + state.selected.length + ' / ' + candidates.length;
                updateGenButton();
            });
            wrap.appendChild(chip);
        });
        section.appendChild(wrap);

        var quick = el('div', 'reading-notice-actions');
        var allBtn = el('button', 'reading-btn', '全选');
        allBtn.type = 'button';
        allBtn.addEventListener('click', function () {
            state.selected = candidates.map(function (item) { return item.vocId || item.spelling; });
            renderWords(candidates);
            updateGenButton();
        });
        var noneBtn = el('button', 'reading-btn', '全不选');
        noneBtn.type = 'button';
        noneBtn.addEventListener('click', function () {
            state.selected = [];
            renderWords(candidates);
            updateGenButton();
        });
        quick.appendChild(allBtn);
        quick.appendChild(noneBtn);
        section.appendChild(quick);

        count.textContent = '已选 ' + state.selected.length + ' / ' + candidates.length;
        host.appendChild(section);
    }

    function updateGenButton() {
        if (!shell.genBtn) return;
        var enough = state.selected.length >= 1;
        shell.genBtn.disabled = !enough || state.busy;
        if (shell.statusNote) {
            shell.statusNote.textContent = enough
                ? '将用 ' + state.selected.length + ' 个词成文'
                : '请至少选 1 个词';
            shell.statusNote.setAttribute('data-kind', enough ? '' : 'warn');
        }
    }

    /* ================= 生成 ================= */

    async function startGeneration() {
        var module = practiceModule();
        if (!module || typeof module.generate !== 'function') {
            if (shell.progressHost) {
                clear(shell.progressHost);
                shell.progressHost.appendChild(noticeBox('error', '练习模块没有加载，无法生成。', []));
            }
            return;
        }
        if (state.selected.length === 0) return;

        var level = LEVELS.filter(function (item) { return item.key === state.levelKey; })[0] || LEVELS[0];
        var picked = state.candidates.filter(function (item) {
            return state.selected.indexOf(item.vocId || item.spelling) >= 0;
        });

        state.busy = true;
        var token = ++generationToken;
        updateGenButton();
        clear(shell.progressHost);

        var progress = el('div', 'reading-progress');
        progress.appendChild(el('div', 'reading-spinner'));
        var progressText = el('span', null, '正在生成文章与题目…');
        progress.appendChild(progressText);
        var cancelBtn = el('button', 'reading-btn', '取消');
        cancelBtn.type = 'button';
        cancelBtn.addEventListener('click', function () {
            if (typeof module.cancel === 'function') module.cancel();
            progressText.textContent = '已取消';
            state.busy = false;
            updateGenButton();
        });
        progress.appendChild(cancelBtn);
        shell.progressHost.appendChild(progress);

        var result;
        /* source 必须由界面显式带上：业务层要记录"这篇练习取自哪个时间范围、
         * 当时数据是否完整、什么时候同步的"。不传的话 validate 必然报
         * source.rangeKey 缺失 → 生成 100% 失败（已用真实模块实测确认）。
         * accountScope 同理：练习、草稿、成绩都按账号分区存储。 */
        var collection = state.collection || {};
        var source = {
            rangeKey: collection.rangeKey || state.rangeKey || DEFAULT_RANGE,
            rangeLabel: collection.rangeLabel || '',
            days: collection.days || 7,
            completeness: collection.completeness || 'complete',
            syncedAt: collection.syncedAt || ''
        };
        try {
            result = await module.generate({
                candidates: picked,
                levelKey: level.key,
                targetWords: level.target,
                source: source,
                accountScope: state.accountScope || collection.accountScope || '',
                onProgress: function (stage) {
                    if (token !== generationToken) return;
                    if (stage === 'prompt') progressText.textContent = '正在准备提示词…';
                    else if (stage === 'generating') progressText.textContent = '正在生成文章与题目…';
                    else if (stage === 'validating') progressText.textContent = '正在校验结构与依据…';
                    else if (stage === 'reviewing') progressText.textContent = '正在独立审题…';
                }
            });
        } catch (error) {
            result = { ok: false, reason: 'error', message: error && error.message ? error.message : String(error) };
        }

        if (token !== generationToken) return;   // 迟到响应：绝不覆盖新任务
        state.busy = false;
        updateGenButton();

        clear(shell.progressHost);
        if (!result || !result.ok) {
            var why = (result && (result.message || (result.errors && result.errors[0]))) || '生成失败';
            var retry = [
                { label: '重试', onClick: startGeneration },
                { label: '返回修改选词', onClick: renderSetup }
            ];
            shell.progressHost.appendChild(noticeBox('error', '没能生成合格的练习：' + why, retry));
            if (result && result.errors && result.errors.length > 1) {
                var detail = el('ul');
                detail.style.margin = '6px 0 0 18px';
                result.errors.slice(0, 5).forEach(function (item) { detail.appendChild(el('li', null, String(item))); });
                shell.progressHost.appendChild(detail);
            }
            return;
        }

        state.practice = result.practice;
        state.answers = {};
        state.flagged = {};
        state.attempt = null;
        state.showExplanation = {};
        state.attemptKey = newAttemptKey();

        // 保存草稿（校验通过的才存）
        try { module.save(state.practice, { accountScope: state.accountScope }); } catch (error) { /* 存储失败不阻塞作答 */ }
        renderPractice();
    }

    /* ================= 第二步：作答 ================= */

    function renderPractice() {
        state.phase = 'answering';
        if (shell.backBtn) shell.backBtn.hidden = false;
        var body = shell.body;
        clear(body);
        var p = state.practice;
        if (!p) return;

        var switchRow = el('div', 'reading-switch');
        [['article', '读文章'], ['questions', '做题目']].forEach(function (pair) {
            var btn = el('button', 'reading-btn', pair[1]);
            btn.type = 'button';
            btn.setAttribute('aria-pressed', String(state.pane === pair[0]));
            btn.addEventListener('click', function () {
                state.pane = pair[0];
                state.scrollTop = body.scrollTop;
                renderPractice();
                body.scrollTop = state.scrollTop;
            });
            switchRow.appendChild(btn);
        });
        body.appendChild(switchRow);

        var layout = el('div', 'reading-practice');
        layout.setAttribute('data-pane', state.pane);

        // ---- 文章 ----
        var articlePane = el('div', 'reading-article-pane');
        articlePane.appendChild(el('h3', 'reading-article-title', p.title));
        var meta = el('div', 'reading-article-meta');
        meta.appendChild(el('span', null,
            (p.levelLabel || '') + ' · ' + p.wordCount + ' 词 · ' +
            (p.theme ? p.theme + '题材 · ' : '') +
            ((p.source && p.source.rangeLabel) || '') + ' · AI 原创模拟练习'));
        articlePane.appendChild(meta);

        (p.paragraphs || []).forEach(function (text, index) {
            var para = el('p', 'reading-paragraph');
            para.setAttribute('data-paragraph', String(index));
            para.textContent = text;
            articlePane.appendChild(para);
        });
        layout.appendChild(articlePane);

        // ---- 题目 ----
        var questionPane = el('div', 'reading-question-pane');
        var answered = answeredCount();
        var qbar = el('div', 'reading-qbar');
        qbar.appendChild(el('span', null, '已答 ' + answered + ' / ' + (p.questions || []).length));
        qbar.appendChild(el('span', 'reading-qbar-spacer'));
        var saveBtn = el('button', 'reading-btn', '保存草稿');
        saveBtn.type = 'button';
        saveBtn.addEventListener('click', function () {
            var module = practiceModule();
            var saved = module && typeof module.save === 'function'
                ? module.save(state.practice, { accountScope: state.accountScope })
                : { ok: false };
            var note = shell.body.querySelector('[data-save-note]');
            if (note) note.textContent = saved && saved.ok ? '已保存，可退出后继续' : '保存失败';
        });
        qbar.appendChild(saveBtn);
        var saveNote = el('span', 'reading-status-note', '');
        saveNote.setAttribute('data-save-note', '');
        qbar.appendChild(saveNote);
        questionPane.appendChild(qbar);

        (p.questions || []).forEach(function (question, qIndex) {
            questionPane.appendChild(renderQuestion(question, qIndex));
        });

        // ---- 提交条 ----
        var actions = el('div', 'reading-actions');
        var status = el('span', 'reading-status-note', '');
        status.setAttribute('data-submit-status', '');
        var submitBtn = el('button', 'reading-btn reading-btn-primary', '提交答案');
        submitBtn.type = 'button';
        submitBtn.addEventListener('click', function () { submitAnswers(submitBtn, status); });
        actions.appendChild(status);
        actions.appendChild(el('span', 'reading-actions-spacer'));
        actions.appendChild(submitBtn);
        questionPane.appendChild(actions);

        layout.appendChild(questionPane);
        body.appendChild(layout);
        updateAnsweredStatus();
        body.scrollTop = state.scrollTop || 0;
    }

    function answeredCount() {
        var p = state.practice;
        if (!p || !Array.isArray(p.questions)) return 0;
        return p.questions.filter(function (q) { return !!state.answers[q.id]; }).length;
    }

    function updateAnsweredStatus() {
        var p = state.practice;
        if (!p) return;
        var total = (p.questions || []).length;
        var done = answeredCount();
        var bar = shell.body.querySelector('.reading-qbar span');
        if (bar) bar.textContent = '已答 ' + done + ' / ' + total;
        var status = shell.body.querySelector('[data-submit-status]');
        if (status && !state.busy) {
            var left = total - done;
            status.textContent = left > 0 ? '还有 ' + left + ' 题未作答' : '已全部作答';
            status.setAttribute('data-kind', left > 0 ? 'warn' : '');
        }
    }

    function renderQuestion(question, qIndex) {
        var box = el('div', 'reading-question');
        box.setAttribute('data-question', question.id);

        var stem = el('p', 'reading-stem');
        stem.textContent = (qIndex + 1) + '. ' + question.stem;
        box.appendChild(stem);

        var list = el('ul', 'reading-options');
        (question.options || []).forEach(function (option) {
            var chosen = state.answers[question.id] === option.key;
            var item = el('li', 'reading-option');
            item.setAttribute('data-chosen', String(chosen));
            item.setAttribute('data-option', option.key);

            var input = el('input');
            input.type = 'radio';
            input.name = 'reading-q-' + question.id;
            input.value = option.key;
            input.checked = chosen;
            input.id = 'reading-' + question.id + '-' + option.key;
            input.addEventListener('change', function () {
                state.answers[question.id] = option.key;
                Array.prototype.forEach.call(list.children, function (child) {
                    child.setAttribute('data-chosen', String(child === item));
                });
                updateAnsweredStatus();
            });

            var label = el('label');
            label.setAttribute('for', input.id);
            label.style.display = 'flex';
            label.style.gap = '8px';
            label.style.alignItems = 'flex-start';
            label.style.cursor = 'pointer';

            label.appendChild(input);
            label.appendChild(el('span', 'reading-option-key', option.key + '.'));
            label.appendChild(el('span', null, option.text));
            item.appendChild(label);
            list.appendChild(item);
        });
        box.appendChild(list);

        var foot = el('div', 'reading-notice-actions');
        var flagBtn = el('button', 'reading-btn', state.flagged[question.id] ? '取消标记' : '标记待检查');
        flagBtn.type = 'button';
        flagBtn.addEventListener('click', function () {
            state.flagged[question.id] = !state.flagged[question.id];
            flagBtn.textContent = state.flagged[question.id] ? '取消标记' : '标记待检查';
        });
        foot.appendChild(flagBtn);
        box.appendChild(foot);
        return box;
    }

    function submitAnswers(button, statusNode) {
        if (state.busy) return;
        var p = state.practice;
        var module = practiceModule();
        if (!p || !module) return;

        var total = (p.questions || []).length;
        var done = answeredCount();
        if (done < total) {
            var proceed = typeof root.confirm === 'function'
                ? root.confirm('还有 ' + (total - done) + ' 题没有作答，未作答的题会算错。确定提交吗？')
                : true;
            if (!proceed) {
                statusNode.textContent = '还有 ' + (total - done) + ' 题未作答';
                statusNode.setAttribute('data-kind', 'warn');
                return;
            }
        }

        state.busy = true;
        button.disabled = true;
        statusNode.textContent = '正在判分…';

        var outcome;
        try {
            outcome = module.submit(p, state.answers, {
                accountScope: state.accountScope,
                attemptKey: state.attemptKey || ''
            });
        } catch (error) {
            outcome = { ok: false, message: error && error.message ? error.message : String(error) };
        }

        state.busy = false;
        if (!outcome || !outcome.ok) {
            button.disabled = false;
            statusNode.textContent = (outcome && outcome.message) || '提交失败，请重试';
            statusNode.setAttribute('data-kind', 'warn');
            return;
        }

        state.attempt = outcome.attempt;
        renderResult(outcome.result, outcome.attempt);
    }

    /* ================= 第三步：判分与解析 ================= */

    function renderResult(result, attempt) {
        state.phase = 'reviewing';
        var body = shell.body;
        var p = state.practice;
        clear(body);
        if (shell.backBtn) shell.backBtn.hidden = false;

        var section = el('div', 'reading-section');
        var head = el('div', 'reading-result-head');
        head.appendChild(el('div', 'reading-score', result.correct + ' / ' + result.total));
        head.appendChild(el('div', 'reading-score-sub',
            '本篇正确率 ' + Math.round((result.correct / Math.max(1, result.total)) * 100) + '%'));
        section.appendChild(head);

        section.appendChild(el('div', 'reading-disclaimer',
            '这是 AI 原创模拟练习的作答结果，只反映本篇的作答情况：不换算成真实四六级分数，也不代表这些单词已经掌握。'));

        var actions = el('div', 'reading-actions');
        var toggleAll = el('button', 'reading-btn', '展开全部解析');
        toggleAll.type = 'button';
        toggleAll.addEventListener('click', function () {
            var anyHidden = (p.questions || []).some(function (q) { return !state.showExplanation[q.id]; });
            (p.questions || []).forEach(function (q) { state.showExplanation[q.id] = anyHidden; });
            renderResult(result, attempt);
        });
        actions.appendChild(toggleAll);

        var redoBtn = el('button', 'reading-btn', '重做本文');
        redoBtn.type = 'button';
        redoBtn.addEventListener('click', function () {
            // 重做 = 重新作答同一篇，成绩另记一条，不覆盖原记录
            state.answers = {};
            state.flagged = {};
            state.attempt = null;
            state.showExplanation = {};
            state.attemptKey = newAttemptKey();
            renderPractice();
        });
        actions.appendChild(redoBtn);
        actions.appendChild(el('span', 'reading-actions-spacer'));

        var newBtn = el('button', 'reading-btn reading-btn-primary', '再生成一篇');
        newBtn.type = 'button';
        newBtn.addEventListener('click', function () { renderSetup(); });
        actions.appendChild(newBtn);
        section.appendChild(actions);
        body.appendChild(section);

        // 逐题解析
        var byId = {};
        (result.perQuestion || []).forEach(function (entry) { byId[entry.id] = entry; });

        (p.questions || []).forEach(function (question, index) {
            var box = el('div', 'reading-section');
            var stem = el('h3', 'reading-section-title');
            stem.textContent = (index + 1) + '. ' + question.stem;
            box.appendChild(stem);

            var entry = byId[question.id] || { chosen: null, correct: question.answer, ok: false };
            var summary = el('div', 'reading-result-head');
            summary.appendChild(el('span', 'reading-score-sub',
                (entry.ok ? '✅ 答对' : '❌ 答错') + ' · 你的答案 ' + (entry.chosen || '未作答') + ' · 正确答案 ' + entry.correct));
            box.appendChild(summary);

            // 选项列表（带判分色）
            var list = el('ul', 'reading-options');
            (question.options || []).forEach(function (option) {
                var item = el('li', 'reading-option');
                item.setAttribute('data-chosen', String(entry.chosen === option.key));
                if (option.key === entry.correct) item.setAttribute('data-result', 'correct');
                else if (entry.chosen === option.key) item.setAttribute('data-result', 'wrong');
                item.appendChild(el('span', 'reading-option-key', option.key + '.'));
                item.appendChild(el('span', null, option.text));
                list.appendChild(item);
            });
            box.appendChild(list);

            // 解析（默认隐藏）
            var shown = !!state.showExplanation[question.id];
            var toggle = el('button', 'reading-btn', shown ? '收起解析' : '查看解析');
            toggle.type = 'button';
            toggle.addEventListener('click', function () {
                state.showExplanation[question.id] = !state.showExplanation[question.id];
                renderResult(result, attempt);
            });
            var foot = el('div', 'reading-notice-actions');
            foot.appendChild(toggle);
            box.appendChild(foot);

            var explain = el('div', 'reading-explain');
            explain.hidden = !shown;
            if (shown) {
                if (question.evidence && question.evidence.quote) {
                    var evidenceRow = el('div', 'reading-explain-row');
                    evidenceRow.appendChild(el('span', 'reading-explain-label', '原文依据'));
                    var evidence = el('div', 'reading-evidence');
                    evidence.setAttribute('role', 'button');
                    evidence.setAttribute('tabindex', '0');
                    evidence.textContent = '第 ' + ((question.evidence.paragraphIndex || 0) + 1) + ' 段：' + question.evidence.quote;
                    var jump = function () {
                        state.pane = 'article';
                        renderPractice();
                        var target = shell.body.querySelector('[data-paragraph="' + (question.evidence.paragraphIndex || 0) + '"]');
                        if (target) {
                            target.setAttribute('data-highlight', 'true');
                            if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'center' });
                        }
                    };
                    evidence.addEventListener('click', jump);
                    evidence.addEventListener('keydown', function (event) {
                        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); jump(); }
                    });
                    evidenceRow.appendChild(evidence);
                    explain.appendChild(evidenceRow);
                }

                if (question.explanation) {
                    var whyRow = el('div', 'reading-explain-row');
                    whyRow.appendChild(el('span', 'reading-explain-label', '为何成立'));
                    whyRow.appendChild(el('span', null, question.explanation));
                    explain.appendChild(whyRow);
                }

                if (Array.isArray(question.distractors) && question.distractors.length) {
                    var disRow = el('div', 'reading-explain-row');
                    disRow.appendChild(el('span', 'reading-explain-label', '其他选项'));
                    var disBox = el('div');
                    question.distractors.forEach(function (item) {
                        if (item.key === entry.correct) return;
                        var line = el('span', 'reading-distractor');
                        line.appendChild(el('span', 'reading-distractor-key', item.key + '.'));
                        line.appendChild(el('span', null, item.why));
                        disBox.appendChild(line);
                    });
                    disRow.appendChild(disBox);
                    explain.appendChild(disRow);
                }
            }
            box.appendChild(explain);
            body.appendChild(box);
        });

        // 目标词复习
        var vocabSection = el('div', 'reading-section');
        vocabSection.appendChild(el('h3', 'reading-section-title', '本篇目标词与语境'));
        var grid = el('div', 'reading-vocab-review');
        (p.targetWords || []).forEach(function (word) {
            var card = el('div', 'reading-vocab-card');
            var head2 = el('div');
            head2.appendChild(el('span', 'reading-vocab-word', word.spelling));
            if (word.surface && word.surface !== word.spelling) {
                head2.appendChild(el('span', 'reading-vocab-surface', '（文中作 ' + word.surface + '）'));
            }
            card.appendChild(head2);
            var para = (p.paragraphs || [])[word.paragraphIndex];
            if (para) {
                var clipped = String(para);
                var at = clipped.toLowerCase().indexOf(String(word.surface || word.spelling).toLowerCase());
                if (at >= 0) {
                    var start = Math.max(0, at - 60);
                    clipped = (start > 0 ? '…' : '') + clipped.slice(start, Math.min(clipped.length, at + 120)) + '…';
                }
                card.appendChild(el('div', 'reading-vocab-context', clipped));
            }
            grid.appendChild(card);
        });
        vocabSection.appendChild(grid);
        body.appendChild(vocabSection);

        body.scrollTop = 0;
    }

    /* ================= 对外接口 ================= */

    function mount(host) {
        if (!host) return;
        mountedHost = host;
        bindAccountChange();
        buildShell(host);
        var module = practiceModule();
        // 有草稿就提示继续；没有就进选择页
        if (module && typeof module.listDrafts === 'function') {
            var drafts = [];
            try { drafts = module.listDrafts({ accountScope: state.accountScope }) || []; } catch (error) { drafts = []; }
            if (drafts.length) {
                renderSetup();
                var body = shell.body;
                var box = noticeBox('', '有一份未完成的练习：' + (drafts[0].title || '未命名') + '（' + formatTime(drafts[0].createdAt) + '）', [
                    {
                        label: '继续作答',
                        onClick: function () {
                            var loaded = module.load(drafts[0].id, { accountScope: state.accountScope });
                            if (loaded) {
                                state.practice = loaded;
                                state.answers = {};
                                state.attemptKey = newAttemptKey();
                                state.pane = 'article';
                                renderPractice();
                            }
                        }
                    },
                    { label: '重新开始', onClick: renderSetup }
                ]);
                body.insertBefore(box, body.firstChild);
                return;
            }
        }
        renderSetup();
    }

    function open() {
        if (mountedHost) buildShell(mountedHost);
        state.pane = 'article';
        state.phase = 'setup';
    }

    function close() {
        if (shell.body) state.scrollTop = shell.body.scrollTop;
    }

    function openPractice(idOrPractice) {
        var module = practiceModule();
        var practice = idOrPractice;
        if (typeof idOrPractice === 'string' && module && typeof module.load === 'function') {
            practice = module.load(idOrPractice, { accountScope: state.accountScope });
        }
        if (!practice) return false;
        state.practice = practice;
        state.answers = {};
        state.flagged = {};
        state.attempt = null;
        state.showExplanation = {};
        state.attemptKey = newAttemptKey();
        if (mountedHost) {
            buildShell(mountedHost);
            renderPractice();
        }
        return true;
    }

    // 测试与接线用：暴露只读状态快照，不暴露可变引用。
    function snapshot() {
        return {
            phase: state.phase,
            rangeKey: state.rangeKey,
            levelKey: state.levelKey,
            selectedCount: state.selected.length,
            candidateCount: state.candidates.length,
            answered: answeredCount(),
            practiceId: state.practice ? state.practice.id : null,
            hasAttempt: !!state.attempt
        };
    }

    root.MemoReadingUI = {
        open: open,
        close: close,
        mount: mount,
        openPractice: openPractice,
        snapshot: snapshot,
        // 供测试替换状态
        _state: state
    };
}(typeof window !== 'undefined' ? window : this));
