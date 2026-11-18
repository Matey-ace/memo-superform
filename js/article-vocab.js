/* Memo Superform - 文章选词：从一篇文章里挑出值得学的词，再加进墨墨学习列表。
 *
 * 这一层只做「界面状态机 + 用户意图」，不解析 AI 原文、不猜词 ID、不重试写请求：
 * 选词校验、词 ID 映射、批量提交全部在服务端（article_vocab.py）完成。
 * 三条不能退让的约束写在这里，改代码前请先读：
 *
 * 1. **不打开就不干活**：没 mount、没 start 时不轮询、不加载依赖、不请求网络。
 * 2. **自动添加默认关闭**：开启必须由用户显式动作触发并写入本地授权记录，
 *    授权可以随时撤销；未授权时提交按钮永远需要一次真实点击。
 * 3. **uncertain 不自动重试**：写请求超时/连接中断后官方可能已经写入，
 *    自动重试会造成重复写入。这里只显示「结果待核实」，把决定权交回用户。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ArticleVocab = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = '20261116-article-vocab';
    var DEFAULT_WORD_COUNT = 20;
    var MAX_WORD_COUNT = 100;
    var MIN_WORD_COUNT = 1;
    var STORAGE_KEY = 'memo_article_vocab_auto_add';
    /* 主机上没有 localStorage（node 测试、受限 WebView）时用内存副本，
     * 行为与已授权一致，但绝不假装"已持久化"。 */
    var memoryPrefs = { autoAdd: false };

    var STATE = {
        IDLE: 'idle',
        EXTRACTING: 'extracting',
        SELECTING: 'selecting',
        PREVIEW: 'preview',
        SUBMITTING: 'submitting',
        DONE: 'done',
        ERROR: 'error'
    };

    var TEXT = {
        idle: '粘贴一篇文章，挑出值得学的词。',
        extracting: '正在抽取英文内容…',
        selecting: '正在挑选适合你的词…',
        preview: '确认要加入的候选词。',
        submitting: '正在加入墨墨学习列表…',
        done: '已加入墨墨学习列表。',
        error: '处理失败。',
        empty: '这篇文章里没有找到合适的候选词。',
        cancelled: '已取消。',
        partial: '部分词已计入，其余未计入。',
        uncertain: '结果待核实：请求过程中连接中断，云端可能已经写入。',
        learnedLocal: '本地记录显示已学',
        notLearnedLocal: '本地没有学习记录',
        unknownOfficial: '官方收录未知',
        knownOfficial: '官方已收录'
    };

    function isObject(value) { return !!value && typeof value === 'object'; }

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function toCount(value, fallback) {
        var num = typeof value === 'number' ? value : Number(value);
        if (typeof num !== 'number' || !isFinite(num) || num < 0) return fallback;
        return Math.floor(num);
    }

    function clampWordCount(value) {
        var num = toCount(value, DEFAULT_WORD_COUNT);
        if (num === null || num === undefined) return DEFAULT_WORD_COUNT;
        if (num < MIN_WORD_COUNT) return MIN_WORD_COUNT;
        if (num > MAX_WORD_COUNT) return MAX_WORD_COUNT;
        return num;
    }

    function readsStorage() {
        try {
            if (typeof localStorage === 'undefined' || !localStorage) return null;
            if (typeof localStorage.getItem !== 'function') return null;
            return localStorage;
        } catch (e) {
            return null;
        }
    }

    /* 授权是"用户曾经明确打开过开关"，不是"上次开关的样子"：
     * 存的是字符串 '1'，任何其它值都当作未授权。 */
    function loadAutoAddPref() {
        var store = readsStorage();
        if (!store) return memoryPrefs.autoAdd === true;
        try {
            var raw = store.getItem(STORAGE_KEY);
            if (raw === null || raw === undefined) return false;
            return String(raw) === '1';
        } catch (e) {
            return false;
        }
    }

    function saveAutoAddPref(enabled) {
        memoryPrefs.autoAdd = enabled === true;
        var store = readsStorage();
        if (!store) return memoryPrefs.autoAdd;
        try {
            if (enabled) store.setItem(STORAGE_KEY, '1');
            else store.removeItem(STORAGE_KEY);
        } catch (e) {}
        return memoryPrefs.autoAdd;
    }

    function setAttr(el, name, value) {
        if (!el || typeof el.setAttribute !== 'function') return false;
        try { el.setAttribute(name, String(value)); return true; } catch (e) { return false; }
    }

    function removeAttr(el, name) {
        if (!el || typeof el.removeAttribute !== 'function') return false;
        try { el.removeAttribute(name); return true; } catch (e) { return false; }
    }

    function setText(el, text) {
        if (!el) return;
        try { el.textContent = String(text); return; } catch (e) {}
        try { el.innerHTML = escapeHtml(text); } catch (e) {}
    }

    /* 统一错误分类：只认服务端给的 code / uncertain，缺失时按"未知失败"处理，
     * 不猜测重试是否安全。 */
    function classifyError(error) {
        var payload = isObject(error) ? error : {};
        var code = String(payload.code || payload.error_code || '').trim();
        var message = '';
        if (typeof error === 'string') message = error;
        else message = String(payload.message || payload.error || '');
        message = message.trim();
        var uncertain = payload.uncertain === true || code === 'uncertain';
        var retryable = payload.retryable === true;
        return {
            code: code || (uncertain ? 'uncertain' : 'unknown'),
            message: message || '请求失败',
            uncertain: uncertain,
            retryable: retryable && !uncertain,
            status: toCount(payload.status, null)
        };
    }

    function create(options) {
        options = isObject(options) ? options : {};
        var state = {
            mounted: false,
            phase: STATE.IDLE,
            title: '',
            text: '',
            targetLevel: '',
            purpose: '',
            wordCount: DEFAULT_WORD_COUNT,
            candidateCount: 0,
            truncated: false,
            items: [],
            rejected: [],
            selected: {},
            /** 已勾选的 lemma（小写）→ true。默认全选，用户可取消。 */
            autoAdd: loadAutoAddPref(),
            /* autoAddArmed = 用户已显式授权（可随时撤销）；
             * autoSubmitted = 本轮已经自动提交过（每轮 start 重置）。
             * 两者必须分开：把"授权"当成"已提交"会导致开着开关却从不自动提交。 */
            autoAddArmed: false,
            autoSubmitted: false,
            message: '',
            error: null,
            uncertain: false,
            partial: false,
            result: null,
            polling: false,
            history: []
        };
        var host = null;
        var nodes = emptyNodes();
        var destroyed = false;
        var requestToken = 0;
        var inFlight = false;
        var queryToken = 0;

        function emptyNodes() {
            return {
                root: null, phase: null, message: null,
                titleInput: null, textInput: null, levelInput: null, purposeInput: null,
                countInput: null, countLabel: null,
                selectBtn: null, cancelBtn: null, reselectBtn: null, clearBtn: null,
                list: null, submitBtn: null, autoAddInput: null, autoAddLabel: null,
                emptyHint: null, uncertainHint: null, partialHint: null, footer: null
            };
        }

        function notify() {
            if (typeof options.onStateChange !== 'function') return;
            try { options.onStateChange(getState()); } catch (e) {}
        }

        function setPhase(phase) {
            if (state.phase === phase) return;
            state.phase = phase;
            state.history.push(phase);
            render();
            notify();
        }

        function resetItems() {
            state.items = [];
            state.rejected = [];
            state.selected = {};
            state.candidateCount = 0;
            state.truncated = false;
            state.result = null;
            state.partial = false;
            state.uncertain = false;
            state.error = null;
            state.autoSubmitted = false;
        }

        function fail(error) {
            var info = classifyError(error);
            state.error = info;
            state.uncertain = !!info.uncertain;
            state.message = info.uncertain ? TEXT.uncertain : (info.message || TEXT.error);
            inFlight = false;
            requestToken += 1;
            setPhase(STATE.ERROR);
        }

        function pendingItems() {
            var list = [];
            for (var i = 0; i < state.items.length; i++) {
                var item = state.items[i];
                if (!isObject(item)) continue;
                if (state.selected[String(item.lemma || '').toLowerCase()]) list.push(item);
            }
            return list;
        }

        function selectedCount() { return pendingItems().length; }

        /* ---------- 渲染 ---------- */

        function buildHtml() {
            var phase = state.phase;
            var busy = phase === STATE.EXTRACTING || phase === STATE.SELECTING || phase === STATE.SUBMITTING;
            var hasItems = state.items.length > 0;
            var isPreview = phase === STATE.PREVIEW || phase === STATE.SUBMITTING || phase === STATE.DONE;
            var learnedNotice = '「本地记录」指本机已有的学习记录；本地没有记录不代表云端未学，最终以墨墨账号为准。';

            var head = '<div class="article-vocab__head">'
                + '<h3 class="article-vocab__title">文章选词</h3>'
                + '<span class="article-vocab__phase" data-testid="article-vocab-phase">' + escapeHtml(phaseLabel(phase)) + '</span>'
                + '</div>';

            var form = '<div class="article-vocab__form">'
                + '<label class="article-vocab__field"><span>文章标题（可选）</span>'
                + '<input type="text" data-testid="article-vocab-title" data-field="title" maxlength="200"'
                + ' value="' + escapeHtml(state.title) + '"' + (busy ? ' disabled' : '') + '></label>'
                + '<label class="article-vocab__field"><span>文章内容</span>'
                + '<textarea data-testid="article-vocab-text" data-field="text" rows="8"'
                + (busy ? ' disabled' : '') + '>' + escapeHtml(state.text) + '</textarea></label>'
                + '<div class="article-vocab__row">'
                + '<label class="article-vocab__field article-vocab__field--half"><span>目标水平</span>'
                + '<input type="text" data-testid="article-vocab-level" data-field="level" maxlength="60"'
                + ' placeholder="例如 CET-6 / 雅思 6.5" value="' + escapeHtml(state.targetLevel) + '"'
                + (busy ? ' disabled' : '') + '></label>'
                + '<label class="article-vocab__field article-vocab__field--half"><span>用途</span>'
                + '<input type="text" data-testid="article-vocab-purpose" data-field="purpose" maxlength="60"'
                + ' placeholder="例如 阅读 / 写作 / 口语" value="' + escapeHtml(state.purpose) + '"'
                + (busy ? ' disabled' : '') + '></label>'
                + '</div>'
                + '<label class="article-vocab__field article-vocab__field--half"><span>期望词数'
                + ' <b data-testid="article-vocab-count">' + escapeHtml(state.wordCount) + '</b></span>'
                + '<input type="range" data-testid="article-vocab-count-range" data-field="count"'
                + ' min="' + MIN_WORD_COUNT + '" max="' + MAX_WORD_COUNT + '" step="1"'
                + ' value="' + escapeHtml(state.wordCount) + '"' + (busy ? ' disabled' : '') + '></label>'
                + '<p class="article-vocab__hint">期望词数只是上限；文章里不够好的词时不会凑数。</p>'
                + '<div class="article-vocab__actions">'
                + '<button type="button" data-testid="article-vocab-select"' + (busy ? ' disabled' : '') + '>'
                + escapeHtml(hasItems ? '重新挑选' : '开始挑选') + '</button>'
                + (busy ? '<button type="button" class="article-vocab__ghost" data-testid="article-vocab-cancel">取消</button>' : '')
                + (hasItems && !busy ? '<button type="button" class="article-vocab__ghost" data-testid="article-vocab-clear">清空</button>' : '')
                + '</div>'
                + '</div>';

            var notice = state.message
                ? '<p class="article-vocab__notice" data-testid="article-vocab-message" role="status">'
                    + escapeHtml(state.message) + '</p>'
                : '';
            var uncertainHint = state.uncertain
                ? '<p class="article-vocab__notice is-uncertain" data-testid="article-vocab-uncertain" role="alert">'
                    + escapeHtml(TEXT.uncertain) + ' 请到墨墨 App 核对后再决定是否重试。</p>'
                : '';
            var partialHint = state.partial && state.result
                ? '<p class="article-vocab__notice is-partial" data-testid="article-vocab-partial" role="status">'
                    + escapeHtml(String(state.result.note || TEXT.partial)) + '</p>'
                : '';
            var emptyHint = isPreview && !state.items.length
                ? '<p class="article-vocab__empty" data-testid="article-vocab-empty">'
                    + escapeHtml(TEXT.empty) + '</p>'
                : '';
            var truncatedHint = state.truncated
                ? '<p class="article-vocab__notice" data-testid="article-vocab-truncated" role="status">'
                    + '文章内容较长，已按上限截断；结果只基于前半部分。</p>'
                : '';

            var listHtml = isPreview ? listMarkup() : '';

            var submitRow = isPreview
                ? '<div class="article-vocab__submit-row">'
                    + '<span class="article-vocab__selected" data-testid="article-vocab-selected-count">'
                    + escapeHtml(selectedCount()) + ' / ' + escapeHtml(state.items.length) + ' 个已选</span>'
                    + '<button type="button" data-testid="article-vocab-submit"'
                    + (busy || !selectedCount() ? ' disabled' : '') + '>加入墨墨学习列表</button>'
                    + '</div>'
                    + '<label class="article-vocab__auto">'
                    + '<input type="checkbox" data-testid="article-vocab-auto-add"'
                    + (state.autoAdd ? ' checked' : '') + (busy ? ' disabled' : '') + '>'
                    + '<span>自动添加（记住授权：下次挑选完成后可直接提交）</span></label>'
                    + '<p class="article-vocab__hint" data-testid="article-vocab-auto-hint">'
                    + escapeHtml(state.autoAdd
                        ? '已开启：挑选完成后会自动提交一次；可随时关闭。'
                        : '默认关闭。开启后挑选完成会自动提交，不会弹出二次确认。')
                    + '</p>'
                : '';

            var learned = '<p class="article-vocab__hint" data-testid="article-vocab-learned-hint">'
                + escapeHtml(learnedNotice) + '</p>';

            return '<section class="article-vocab" data-testid="article-vocab"'
                + ' data-phase="' + escapeHtml(phase) + '"'
                + ' data-auto-add="' + (state.autoAdd ? 'true' : 'false') + '"'
                + ' data-uncertain="' + (state.uncertain ? 'true' : 'false') + '"'
                + ' data-partial="' + (state.partial ? 'true' : 'false') + '">'
                + head + form + notice + uncertainHint + partialHint + truncatedHint
                + emptyHint + listHtml + submitRow + learned
                + '</section>';
        }

        function phaseLabel(phase) {
            if (phase === STATE.EXTRACTING) return '抽取中';
            if (phase === STATE.SELECTING) return '挑选中';
            if (phase === STATE.PREVIEW) return '待确认';
            if (phase === STATE.SUBMITTING) return '提交中';
            if (phase === STATE.DONE) return '已完成';
            if (phase === STATE.ERROR) return '失败';
            return '未开始';
        }

        function masteryText(item) {
            var local = item && item.learned_local === true;
            if (local) return TEXT.learnedLocal;
            return TEXT.notLearnedLocal;
        }

        function officialText(item) {
            var status = item ? String(item.official_status || '') : '';
            if (status === 'matched') return TEXT.knownOfficial;
            if (status === 'ambiguous') return '官方返回多个同名条目，需人工核对';
            if (status === 'missing') return '官方未收录';
            return TEXT.unknownOfficial;
        }

        function listMarkup() {
            if (!state.items.length) return '';
            var rows = '';
            for (var i = 0; i < state.items.length; i++) {
                var item = state.items[i];
                if (!isObject(item)) continue;
                var lemma = String(item.lemma || '');
                var key = lemma.toLowerCase();
                var checked = !!state.selected[key];
                rows += '<li class="article-vocab__item" data-testid="article-vocab-item"'
                    + ' data-lemma="' + escapeHtml(key) + '" data-selected="' + (checked ? 'true' : 'false') + '">'
                    + '<label class="article-vocab__check">'
                    + '<input type="checkbox" data-testid="article-vocab-item-check" data-lemma="' + escapeHtml(key) + '"'
                    + (checked ? ' checked' : '') + '>'
                    + '<span class="article-vocab__lemma">' + escapeHtml(lemma) + '</span>'
                    + (item.pos ? '<span class="article-vocab__pos">' + escapeHtml(item.pos) + '</span>' : '')
                    + '</label>'
                    + '<p class="article-vocab__gloss">' + escapeHtml(item.gloss_zh || '') + '</p>'
                    + (item.context ? '<p class="article-vocab__context" data-testid="article-vocab-context">'
                        + escapeHtml(item.context) + '</p>' : '')
                    + (item.reason ? '<p class="article-vocab__reason" data-testid="article-vocab-reason">'
                        + escapeHtml(item.reason) + '</p>' : '')
                    + '<p class="article-vocab__meta">'
                    + '<span data-testid="article-vocab-mastery">' + escapeHtml(masteryText(item)) + '</span>'
                    + '<span data-testid="article-vocab-official">' + escapeHtml(officialText(item)) + '</span>'
                    + '</p>'
                    + '<button type="button" class="article-vocab__remove" data-testid="article-vocab-remove"'
                    + ' data-lemma="' + escapeHtml(key) + '">删除</button>'
                    + '</li>';
            }
            return '<ul class="article-vocab__list" data-testid="article-vocab-list">' + rows + '</ul>';
        }

        function collect(rootEl) {
            var result = emptyNodes();
            if (!rootEl || typeof rootEl.querySelector !== 'function') return result;
            function q(selector) {
                try { return rootEl.querySelector(selector); } catch (e) { return null; }
            }
            result.root = q('[data-testid="article-vocab"]');
            result.phase = q('[data-testid="article-vocab-phase"]');
            result.message = q('[data-testid="article-vocab-message"]');
            result.titleInput = q('[data-field="title"]');
            result.textInput = q('[data-field="text"]');
            result.levelInput = q('[data-field="level"]');
            result.purposeInput = q('[data-field="purpose"]');
            result.countInput = q('[data-field="count"]');
            result.countLabel = q('[data-testid="article-vocab-count"]');
            result.selectBtn = q('[data-testid="article-vocab-select"]');
            result.cancelBtn = q('[data-testid="article-vocab-cancel"]');
            result.clearBtn = q('[data-testid="article-vocab-clear"]');
            result.list = q('[data-testid="article-vocab-list"]');
            result.submitBtn = q('[data-testid="article-vocab-submit"]');
            result.autoAddInput = q('[data-testid="article-vocab-auto-add"]');
            result.uncertainHint = q('[data-testid="article-vocab-uncertain"]');
            result.partialHint = q('[data-testid="article-vocab-partial"]');
            result.emptyHint = q('[data-testid="article-vocab-empty"]');
            return result;
        }

        /* ---------- 事件绑定（幂等）---------- */

        function on(el, name, handler) {
            if (!el || typeof el.addEventListener !== 'function') return;
            try { el.addEventListener(name, handler); } catch (e) {}
        }

        function bindAll() {
            // 每次 render 会重建 DOM，所以绑定标记随节点一起重置。
            on(nodes.selectBtn, 'click', function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                start();
            });
            on(nodes.cancelBtn, 'click', function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                cancel();
            });
            on(nodes.clearBtn, 'click', function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                reset();
            });
            on(nodes.submitBtn, 'click', function (event) {
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                submit();
            });
            on(nodes.textInput, 'input', function (event) {
                state.text = event && event.target ? String(event.target.value || '') : state.text;
            });
            on(nodes.titleInput, 'input', function (event) {
                state.title = event && event.target ? String(event.target.value || '') : state.title;
            });
            on(nodes.levelInput, 'input', function (event) {
                state.targetLevel = event && event.target ? String(event.target.value || '') : state.targetLevel;
            });
            on(nodes.purposeInput, 'input', function (event) {
                state.purpose = event && event.target ? String(event.target.value || '') : state.purpose;
            });
            on(nodes.countInput, 'input', function (event) {
                state.wordCount = clampWordCount(event && event.target ? event.target.value : state.wordCount);
                setText(nodes.countLabel, state.wordCount);
            });
            on(nodes.autoAddInput, 'change', function (event) {
                var next = !!(event && event.target && event.target.checked);
                // 只有用户真实点击开关才算授权；代码里改 state 不算。
                setAutoAdd(next, 'user');
            });
            // 列表是动态内容：用委托避免给每个 checkbox 单独绑定。
            on(nodes.list, 'change', function (event) {
                var target = event && event.target;
                if (!target) return;
                var testid = typeof target.getAttribute === 'function' ? target.getAttribute('data-testid') : '';
                var lemma = typeof target.getAttribute === 'function' ? target.getAttribute('data-lemma') : '';
                if (testid !== 'article-vocab-item-check' || !lemma) return;
                setSelected(lemma, !!target.checked);
            });
            on(nodes.list, 'click', function (event) {
                var target = event && event.target;
                if (!target) return;
                var testid = typeof target.getAttribute === 'function' ? target.getAttribute('data-testid') : '';
                var lemma = typeof target.getAttribute === 'function' ? target.getAttribute('data-lemma') : '';
                if (testid !== 'article-vocab-remove' || !lemma) return;
                if (event && typeof event.preventDefault === 'function') event.preventDefault();
                removeItem(lemma);
            });
        }

        function render() {
            if (destroyed || !host) return;
            try { host.innerHTML = buildHtml(); } catch (e) { return; }
            nodes = collect(host);
            bindAll();
        }

        /* ---------- 动作 ---------- */

        /* 从 DOM 回读表单。真实浏览器里 input 事件已经把每次按键写进 state，
         * 所以这里只是兜底；**空值不覆盖 state**，否则用 setInput 预填的内容
         * 会被一个尚未渲染的控件抹掉。清空文本框由 input 事件负责。 */
        function readForm() {
            if (nodes.textInput) {
                var textValue = nodes.textInput.value;
                // 只在控件里真的有内容时采纳：空字符串会覆盖 setInput 写入的值。
                if (typeof textValue === 'string' && textValue !== '' && textValue !== state.text) {
                    state.text = textValue;
                }
            }
            if (nodes.titleInput) {
                var titleValue = nodes.titleInput.value;
                if (typeof titleValue === 'string' && titleValue !== '' && titleValue !== state.title) {
                    state.title = titleValue;
                }
            }
            if (nodes.levelInput) {
                var levelValue = nodes.levelInput.value;
                if (typeof levelValue === 'string' && levelValue !== '' && levelValue !== state.targetLevel) {
                    state.targetLevel = levelValue;
                }
            }
            if (nodes.purposeInput) {
                var purposeValue = nodes.purposeInput.value;
                if (typeof purposeValue === 'string' && purposeValue !== '' && purposeValue !== state.purpose) {
                    state.purpose = purposeValue;
                }
            }
            if (nodes.countInput) {
                state.wordCount = clampWordCount(nodes.countInput.value);
            }
        }

        function applySelection(payload) {
            var items = isObject(payload) && payload.items && typeof payload.items.length === 'number'
                ? payload.items : [];
            var rejected = isObject(payload) && payload.rejected && typeof payload.rejected.length === 'number'
                ? payload.rejected : [];
            state.items = [];
            state.selected = {};
            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (!isObject(item)) continue;
                var lemma = String(item.lemma || '').trim();
                if (!lemma) continue;
                var copy = {};
                for (var key in item) {
                    if (!Object.prototype.hasOwnProperty.call(item, key)) continue;
                    copy[key] = item[key];
                }
                copy.lemma = lemma;
                // 没查过官方就显式标为未知：绝不预设 matched/missing。
                if (!copy.official_status) copy.official_status = 'unknown';
                // voc_id 只有跟 matched 一起出现才可信（来自服务端官方查询）；
                // 单独出现的 voc_id 可能是模型编的，一律丢弃。
                if (copy.official_status !== 'matched' || !copy.voc_id) delete copy.voc_id;
                state.items.push(copy);
                state.selected[lemma.toLowerCase()] = true;
            }
            state.rejected = rejected;
            state.candidateCount = toCount(payload && payload.candidate_count, state.items.length);
            state.truncated = !!(payload && payload.truncated);
        }

        /* 服务端把「是否有官方词 ID」也算进来了：这里只透传展示，绝不自己填。 */
        function start() {
            if (destroyed || inFlight) return null;
            readForm();
            var text = state.text;
            if (!text || !String(text).trim()) {
                state.error = { code: 'empty_article', message: '请先粘贴文章内容', uncertain: false, retryable: false, status: null };
                state.message = '请先粘贴文章内容';
                setPhase(STATE.ERROR);
                return null;
            }
            inFlight = true;
            resetItems();
            state.history = [];
            state.message = TEXT.extracting;
            setPhase(STATE.EXTRACTING);

            var token = ++requestToken;
            var payload = {
                title: state.title,
                text: text,
                target_level: state.targetLevel,
                purpose: state.purpose,
                word_count: state.wordCount,
                // 只按本地记录过滤；服务端会明确标注这是本地视角
                filters: { local_known: true }
            };

            var request;
            if (typeof options.requestAi === 'function') {
                try {
                    request = options.requestAi(payload);
                } catch (error) {
                    fail(error);
                    return null;
                }
            } else if (typeof options.requestSelect === 'function') {
                try {
                    request = options.requestSelect(payload);
                } catch (error) {
                    fail(error);
                    return null;
                }
            } else {
                inFlight = false;
                state.message = '选词服务未接线';
                setPhase(STATE.ERROR);
                return null;
            }

            if (token !== requestToken) return null;
            state.message = TEXT.selecting;
            setPhase(STATE.SELECTING);

            return settle(request, function done(payloadValue) {
                if (destroyed || token !== requestToken) return;
                inFlight = false;
                if (!isObject(payloadValue)) {
                    fail({ code: 'bad_payload', message: '选词服务返回格式异常' });
                    return;
                }
                if (payloadValue.ok === false) {
                    fail(payloadValue);
                    return;
                }
                if (payloadValue.truncated) state.truncated = true;
                applySelection(payloadValue);
                state.error = null;
                if (!state.items.length) {
                    state.message = TEXT.empty;
                    setPhase(STATE.PREVIEW);
                    notify();
                    return;
                }
                state.message = TEXT.preview;
                setPhase(STATE.PREVIEW);
                var next = maybeAutoSubmit();
                refreshOfficial(token, next);
            }, function failed(error) {
                if (destroyed || token !== requestToken) return;
                fail(error);
            });
        }

        /* 自动添加：只有用户此前显式开启过授权才会走到这里，且每轮只提交一次。 */
        function maybeAutoSubmit() {
            if (!state.autoAdd || !state.autoAddArmed) return false;
            if (state.autoSubmitted) return false; // 已自动提交过一次，不重复写
            if (selectedCount() <= 0) return false;
            state.autoSubmitted = true;
            submit({ automatic: true });
            return true;
        }

        /* 官方收录核对：单次只读查询，不是轮询。
         * 没接线 requestQuery 时就保留「官方收录未知」，绝不假装已核对。
         * 失败也只是把状态留在未知，不阻塞用户提交，更不自动重试。 */
        function refreshOfficial(token, skip) {
            if (skip || destroyed) return null;
            if (typeof options.requestQuery !== 'function') return null;
            if (!state.items.length) return null;
            var spellings = state.items.map(function (item) {
                return String((item && item.surface) || (item && item.lemma) || '');
            }).filter(function (value) { return !!value; });
            if (!spellings.length) return null;

            var queryTokenValue = ++queryToken;
            var request;
            try {
                request = options.requestQuery({ spellings: spellings, purpose: 'official_status' });
            } catch (e) {
                return null;
            }
            return settle(request, function ok(result) {
                if (destroyed || queryTokenValue !== queryToken || token !== requestToken) return;
                mergeOfficial(result);
            }, function bad() {
                // 静默保留「官方收录未知」，不弹错、不重试。
                if (destroyed || queryTokenValue !== queryToken) return;
                render();
                notify();
            });
        }

        /* 只按服务端给出的 matched/missing/ambiguous 标注，不按返回顺序猜。 */
        function mergeOfficial(result) {
            if (!isObject(result)) return;
            var matched = isObject(result.matched) ? result.matched : {};
            var missing = result.missing && typeof result.missing.length === 'number' ? result.missing : [];
            var ambiguous = isObject(result.ambiguous) ? result.ambiguous : {};
            var missingSet = {};
            for (var i = 0; i < missing.length; i++) missingSet[String(missing[i]).toLowerCase()] = true;

            for (var j = 0; j < state.items.length; j++) {
                var item = state.items[j];
                if (!isObject(item)) continue;
                var lemmaKey = String(item.lemma || '').toLowerCase();
                var surfaceKey = String(item.surface || '').toLowerCase();
                var hit = matched[lemmaKey] || matched[surfaceKey];
                if (isObject(hit) && hit.id) {
                    item.official_status = 'matched';
                    item.voc_id = String(hit.id);
                } else if (ambiguous.hasOwnProperty(lemmaKey) || ambiguous.hasOwnProperty(surfaceKey)) {
                    item.official_status = 'ambiguous';
                    delete item.voc_id;
                } else if (missingSet[lemmaKey] === true || missingSet[surfaceKey] === true) {
                    item.official_status = 'missing';
                    delete item.voc_id;
                } else {
                    // 官方没提这个词：仍是未知，不能推断成"未收录"。
                    item.official_status = 'unknown';
                    delete item.voc_id;
                }
            }
            render();
            notify();
        }

        /* 统一的 Promise 收口：把回调里抛出的异常吞掉，并且**绝不把原始请求的
         * reject 抛给 await 调用方**——否则宿主 `await start()` 会炸在自己的
         * try/catch 之外，界面就停在"处理中"了。返回的 Promise 永远 resolve。 */
        function settle(request, onOk, onFail) {
            function handleOk(value) {
                try { onOk(value); } catch (e) { /* 渲染异常不该打断状态机 */ }
                return null;
            }
            function handleFail(error) {
                try { onFail(error); } catch (e) { }
                return null;
            }
            if (request && typeof request.then === 'function') {
                try {
                    return Promise.resolve(request).then(handleOk, handleFail);
                } catch (error) {
                    handleFail(error);
                    return Promise.resolve(null);
                }
            }
            if (request !== null && request !== undefined) {
                handleOk(request);
            } else {
                handleFail({ code: 'no_response', message: '选词服务没有返回结果' });
            }
            return Promise.resolve(null);
        }

        /* 供宿主（弹层、粘贴事件、测试）直接写入表单值；DOM 存在时同步到控件。 */
        function setInput(field, value) {
            if (destroyed) return null;
            var text = value === null || value === undefined ? '' : String(value);
            if (field === 'text') state.text = text;
            else if (field === 'title') state.title = text;
            else if (field === 'level' || field === 'target_level') state.targetLevel = text;
            else if (field === 'purpose') state.purpose = text;
            else if (field === 'word_count' || field === 'count') {
                state.wordCount = clampWordCount(text);
            } else {
                return null;
            }
            render();
            notify();
            return getState();
        }

        function setSelected(lemma, value) {
            var key = String(lemma || '').toLowerCase();
            if (!key) return null;
            if (!state.selected.hasOwnProperty(key) && !value) return null;
            if (value) state.selected[key] = true;
            else delete state.selected[key];
            render();
            notify();
            return null;
        }

        function removeItem(lemma) {
            var key = String(lemma || '').toLowerCase();
            if (!key) return null;
            var next = [];
            for (var i = 0; i < state.items.length; i++) {
                var item = state.items[i];
                if (!isObject(item)) continue;
                if (String(item.lemma || '').toLowerCase() === key) continue;
                next.push(item);
            }
            state.items = next;
            delete state.selected[key];
            render();
            notify();
            return null;
        }

        /* 一次明确提交。不做多层确认弹窗：selected 就是用户的意图表达。
         * confirm 由调用方（HTTP 层）校验，这里固定传 true。 */
        function submit(flags) {
            if (destroyed || inFlight) return null;
            if (state.phase === STATE.SUBMITTING) return null;
            var chosen = pendingItems();
            if (!chosen.length) {
                state.message = '没有选中的词';
                render();
                notify();
                return null;
            }
            if (typeof options.requestAdd !== 'function') {
                state.message = '加入学习列表的通道未接线';
                setPhase(STATE.ERROR);
                return null;
            }
            inFlight = true;
            state.partial = false;
            state.uncertain = false;
            state.message = TEXT.submitting;
            setPhase(STATE.SUBMITTING);

            var token = ++requestToken;
            var payload = {
                confirm: true,
                advance: false,
                operation_id: String(options.operationId || makeOperationId()),
                items: chosen.map(function (item) {
                    return {
                        lemma: String(item.lemma || ''),
                        // 只有官方 matched 的 id 才回传；未知/歧义一律留空，
                        // 让服务端自己去查，绝不把编造的 id 送进云端。
                        voc_id: (item.official_status === 'matched' && item.voc_id)
                            ? String(item.voc_id) : '',
                        selected: true
                    };
                }),
                automatic: !!(flags && flags.automatic)
            };

            var request;
            try {
                request = options.requestAdd(payload);
            } catch (error) {
                fail(error);
                return null;
            }

            return settle(request, function done(result) {
                if (destroyed || token !== requestToken) return;
                inFlight = false;
                if (!isObject(result)) {
                    fail({ code: 'bad_payload', message: '提交结果格式异常' });
                    return;
                }
                if (result.uncertain === true || result.code === 'uncertain') {
                    // 超时/连接中断：云端可能已经写入，**不自动重试**。
                    fail({
                        code: 'uncertain',
                        message: result.note || result.message || TEXT.uncertain,
                        uncertain: true,
                        retryable: false,
                        status: result.status
                    });
                    return;
                }
                if (result.ok === false) {
                    fail(result);
                    return;
                }
                state.result = result;
                var status = String(result.status || '');
                state.partial = status === 'partial' || status === 'none';
                state.error = null;
                state.message = result.note || (state.partial ? TEXT.partial : TEXT.done);
                setPhase(STATE.DONE);
            }, function failed(error) {
                if (destroyed || token !== requestToken) return;
                fail(error);
            });
        }

        function makeOperationId() {
            var now = Date.now();
            var rand = Math.floor(Math.random() * 1e9).toString(36);
            return 'av-' + now.toString(36) + '-' + rand;
        }

        /* 用户主动取消：只停止本组件等待，不 abort 已发出的写请求（写请求
         * 可能已经到云端，abort 只会让结果更不清楚）。 */
        function cancel() {
            if (destroyed) return null;
            requestToken += 1;
            inFlight = false;
            if (state.phase === STATE.SUBMITTING) {
                state.uncertain = true;
                state.message = '已取消等待。提交请求可能已经送达云端，请到墨墨 App 核对结果。';
            } else {
                state.message = TEXT.cancelled;
            }
            setPhase(state.phase === STATE.SUBMITTING ? STATE.ERROR : STATE.PREVIEW);
            return null;
        }

        function reset() {
            if (destroyed) return null;
            requestToken += 1;
            inFlight = false;
            resetItems();
            state.message = '';
            state.autoAddArmed = false;
            setPhase(STATE.IDLE);
            return null;
        }

        function setAutoAdd(enabled, source) {
            if (destroyed) return false;
            var value = enabled === true;
            state.autoAdd = value;
            saveAutoAddPref(value);
            // 只有用户显式操作才写授权；source 仅用于状态记录
            state.autoAddArmed = value && source === 'user';
            render();
            notify();
            return value;
        }

        /* ---------- 生命周期 ---------- */

        function mount(container) {
            if (destroyed) return null;
            if (!container || typeof container !== 'object') return null;
            host = container;
            state.mounted = true;
            render();
            notify();
            return null;
        }

        function destroy() {
            destroyed = true;
            requestToken += 1;
            inFlight = false;
            state.polling = false;
            if (host) {
                try { host.innerHTML = ''; } catch (e) {}
            }
            host = null;
            nodes = emptyNodes();
            state.mounted = false;
            return null;
        }

        function getState() {
            return {
                version: VERSION,
                mounted: state.mounted,
                mountedTo: !!host,
                phase: state.phase,
                busy: state.phase === STATE.EXTRACTING || state.phase === STATE.SELECTING || state.phase === STATE.SUBMITTING,
                title: state.title,
                targetLevel: state.targetLevel,
                purpose: state.purpose,
                wordCount: state.wordCount,
                candidateCount: state.candidateCount,
                truncated: !!state.truncated,
                items: state.items.slice ? state.items.slice(0) : state.items,
                rejected: state.rejected.slice ? state.rejected.slice(0) : state.rejected,
                selected: Object.keys(state.selected),
                selectedCount: selectedCount(),
                autoAdd: !!state.autoAdd,
                autoAddArmed: !!state.autoAddArmed,
                message: state.message,
                error: state.error,
                uncertain: !!state.uncertain,
                partial: !!state.partial,
                result: state.result,
                polling: !!state.polling,
                history: state.history.slice ? state.history.slice(0) : state.history,
                text: state.text
            };
        }

        return {
            mount: mount,
            start: start,
            submit: submit,
            cancel: cancel,
            reset: reset,
            setAutoAdd: setAutoAdd,
            setSelected: setSelected,
            setInput: setInput,
            removeItem: removeItem,
            destroy: destroy,
            getState: getState
        };
    }

    return {
        version: VERSION,
        DEFAULT_WORD_COUNT: DEFAULT_WORD_COUNT,
        MAX_WORD_COUNT: MAX_WORD_COUNT,
        MIN_WORD_COUNT: MIN_WORD_COUNT,
        STORAGE_KEY: STORAGE_KEY,
        STATE: STATE,
        TEXT: TEXT,
        create: create,
        clampWordCount: clampWordCount,
        classifyError: classifyError,
        /* 清掉已记住的自动添加授权（退出登录、切换账号、测试隔离都用它）。
         * 单独导出而不是塞进 create，是因为授权是设备级偏好，不是实例状态。 */
        resetAutoAddPref: function () {
            memoryPrefs.autoAdd = false;
            var store = readsStorage();
            if (!store) return false;
            try { store.removeItem(STORAGE_KEY); } catch (e) { return false; }
            return true;
        },
        loadAutoAddPref: loadAutoAddPref
    };
});
