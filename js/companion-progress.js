/* Memo Superform - 陪伴会话的进度条渲染。
 * 只负责「把服务端会话视图画成进度」，不自己算目标、不自己推断完成度：
 * 服务端说 known=false 时目标数不可信，这里必须退化成不定态，
 * 否则用户会看到一个凭空捏造的百分比。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CompanionProgress = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var SEP = '\u3000\u00b7\u3000';
    var PENDING_ARIA_TEXT = '\u76ee\u6807\u5f85\u786e\u8ba4';
    var TODAY_PENDING = '\u4eca\u65e5\u76ee\u6807\u5f85\u786e\u8ba4';

    function isObject(value) { return !!value && typeof value === 'object'; }

    function toCount(value) {
        var num = typeof value === 'number' ? value : Number(value);
        if (typeof num !== 'number' || !isFinite(num) || num < 0) return null;
        return Math.floor(num);
    }

    function escapeHtml(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /* 分钟只用于展示，取整即可；不足一分钟直接说清楚，避免出现「0 分钟」 */
    function minutesText(seconds) {
        var total = typeof seconds === 'number' && isFinite(seconds) ? seconds : Number(seconds);
        if (typeof total !== 'number' || !isFinite(total) || total <= 0) return '';
        var minutes = Math.floor(total / 60);
        if (minutes < 1) return '\u4e0d\u5230 1 \u5206\u949f';
        return minutes + ' \u5206\u949f';
    }

    function setAttr(el, name, value) {
        if (!el || typeof el.setAttribute !== 'function') return false;
        try { el.setAttribute(name, String(value)); return true; } catch (e) { return false; }
    }

    function removeAttr(el, name) {
        if (!el || typeof el.removeAttribute !== 'function') return false;
        try { el.removeAttribute(name); return true; } catch (e) { return false; }
    }

    function addClass(el, name) {
        if (!el || !el.classList || typeof el.classList.add !== 'function') return false;
        try { el.classList.add(name); return true; } catch (e) { return false; }
    }

    function removeClass(el, name) {
        if (!el || !el.classList || typeof el.classList.remove !== 'function') return false;
        try { el.classList.remove(name); return true; } catch (e) { return false; }
    }

    function prefersReducedMotion(win) {
        try {
            var view = win || (typeof window !== 'undefined' ? window : null);
            if (!view || typeof view.matchMedia !== 'function') return false;
            var query = view.matchMedia('(prefers-reduced-motion: reduce)');
            return !!(query && query.matches);
        } catch (e) {
            return false;
        }
    }

    function defaultFetchJson(url, init) {
        var view = typeof window !== 'undefined' ? window : null;
        if (!view || typeof view.fetch !== 'function') return null;
        try { return view.fetch(url, init); } catch (e) { return null; }
    }

    function create(options) {
        options = isObject(options) ? options : {};
        var state = {
            mounted: false,
            sessionId: '',
            state: '',
            goalKind: '',
            roleId: '',
            roleName: '',
            known: false,
            done: 0,
            total: null,
            progressText: '',
            labelText: '',
            todayText: TODAY_PENDING,
            pendingReason: '',
            pending: false,
            aria: { valuenow: null, valuemax: null, valuetext: null, label: '' },
            reducedMotion: false,
            revision: null
        };
        var view = null;
        var host = null;
        var nodes = emptyNodes();
        var destroyed = false;
        var clickBound = false;

        function emptyNodes() {
            return { root: null, bar: null, label: null, today: null, pending: null, fill: null, retry: null };
        }

        function ariaLabel() {
            var prefix = state.roleName ? (state.roleName + SEP) : '';
            if (state.known) {
                return prefix + '\u672c\u8f6e\u5b66\u4e60\u8fdb\u5ea6 ' + state.done + ' / ' + state.total + ' \u8bcd';
            }
            return prefix + '\u672c\u8f6e\u5b66\u4e60\u8fdb\u5ea6\uff0c\u76ee\u6807\u5f85\u786e\u8ba4';
        }

        function todayFromView(nextView) {
            /* 今日数字只能来自 today_plan 且 total 可信；
             * 会话目标是 session_goal 时今日进度未知，绝不能拿本轮数字顶替。 */
            var progress = isObject(nextView) && isObject(nextView.progress) ? nextView.progress : {};
            var goalKind = isObject(nextView) ? String(nextView.goal_kind || '') : '';
            var total = toCount(progress.total);
            var done = toCount(progress.done);
            if (goalKind === 'today_plan' && progress.known !== false && total !== null && total > 0) {
                return '\u4eca\u65e5 ' + (done === null ? 0 : done) + ' / ' + total + ' \u8bcd';
            }
            return TODAY_PENDING;
        }

        function composeTexts() {
            var roundText = state.known
                ? ('\u672c\u8f6e ' + state.done + ' / ' + state.total + ' \u8bcd')
                : ('\u672c\u8f6e ' + state.done + ' \u8bcd');
            var minutes = minutesText(view && view.active_seconds);
            var labelText = minutes && state.known ? (roundText + SEP + minutes) : roundText;
            var full = labelText + SEP + state.todayText;
            /* 文本先落进 state，再画 DOM：宿主缺失时 getState() 仍要能报告当前进度 */
            state.labelText = labelText;
            state.progressText = full;
            return {
                label: labelText,
                today: state.todayText,
                full: full
            };
        }

        function buildHtml(reduced) {
            var texts = composeTexts();
            var known = state.known;
            var rootAttrs = ' data-testid="companion-progress" data-state="' + escapeHtml(state.state) + '"'
                + ' data-goal-kind="' + escapeHtml(state.goalKind) + '"'
                + ' data-known="' + (known ? 'true' : 'false') + '"'
                + ' data-pending="' + (state.pending ? 'true' : 'false') + '"';
            var barAttrs = ' data-testid="companion-progress-bar" role="progressbar"'
                + ' aria-valuemin="0" aria-label="' + escapeHtml(ariaLabel()) + '"';
            if (known) {
                barAttrs += ' aria-valuenow="' + state.done + '" aria-valuemax="' + state.total + '"';
            } else {
                barAttrs += ' aria-valuetext="' + escapeHtml(PENDING_ARIA_TEXT) + '"';
            }
            var trackClass = 'companion-progress__track'
                + (known ? '' : ' is-indeterminate')
                + (reduced ? ' is-static' : '');
            var head = state.roleName
                ? '<span class="companion-progress__title" data-testid="companion-progress-title">'
                    + escapeHtml(state.roleName) + '</span>'
                : '';
            var stateLabel = state.state ? '<span class="companion-progress__state">'
                + escapeHtml(stateLabelText()) + '</span>' : '';
            var pendingBlock = '';
            if (state.pending || state.pendingReason) {
                pendingBlock = '<p class="companion-progress__pending" data-testid="companion-progress-pending" role="status">'
                    + escapeHtml(state.pendingReason || '\u7b49\u5f85\u786e\u8ba4\u672c\u8f6e\u8fdb\u5ea6')
                    + '<button type="button" class="companion-progress__retry" data-testid="companion-progress-retry">'
                    + '\u91cd\u65b0\u83b7\u53d6</button></p>';
            }
            return '<div class="companion-progress' + (state.pending ? ' is-pending' : '') + '"' + rootAttrs + '>'
                + '<div class="companion-progress__head">' + head + stateLabel + '</div>'
                + '<div class="' + trackClass + '"' + barAttrs + '>'
                + '<span class="companion-progress__fill" data-testid="companion-progress-fill"></span>'
                + '</div>'
                + '<div class="companion-progress__lines">'
                + '<span class="companion-progress__label" data-testid="companion-progress-label">'
                + escapeHtml(texts.label) + '</span>'
                + '<span class="companion-progress__today" data-testid="companion-progress-today">'
                + escapeHtml(texts.today) + '</span>'
                + '</div>'
                + pendingBlock
                + '</div>';
        }

        function stateLabelText() {
            if (state.state === 'paused') return '\u5df2\u6682\u505c';
            if (state.state === 'completed') return '\u5df2\u5b8c\u6210';
            if (state.state === 'abandoned') return '\u5df2\u653e\u5f03';
            if (state.state === 'active') return '\u8fdb\u884c\u4e2d';
            return '';
        }

        function collect(rootEl) {
            var result = emptyNodes();
            if (!rootEl || typeof rootEl.querySelector !== 'function') return result;
            function q(selector) {
                try { return rootEl.querySelector(selector); } catch (e) { return null; }
            }
            result.root = q('[data-testid="companion-progress"]');
            result.bar = q('[data-testid="companion-progress-bar"]');
            result.label = q('[data-testid="companion-progress-label"]');
            result.today = q('[data-testid="companion-progress-today"]');
            result.pending = q('[data-testid="companion-progress-pending"]');
            result.fill = q('[data-testid="companion-progress-fill"]');
            result.retry = q('[data-testid="companion-progress-retry"]');
            return result;
        }

        /* 关键点：目标数不可信时，aria-valuemax / aria-valuenow 必须真的不存在，
         * 只留 aria-valuetext，读屏软件才不会读出一个假的上限。 */
        function applyAria() {
            var bar = nodes.bar;
            if (state.known) {
                setAttr(bar, 'aria-valuenow', state.done);
                setAttr(bar, 'aria-valuemax', state.total);
                removeAttr(bar, 'aria-valuetext');
                state.aria.valuenow = state.done;
                state.aria.valuemax = state.total;
                state.aria.valuetext = null;
            } else {
                removeAttr(bar, 'aria-valuenow');
                removeAttr(bar, 'aria-valuemax');
                setAttr(bar, 'aria-valuetext', PENDING_ARIA_TEXT);
                state.aria.valuenow = null;
                state.aria.valuemax = null;
                state.aria.valuetext = PENDING_ARIA_TEXT;
            }
            setAttr(bar, 'aria-valuemin', 0);
            setAttr(bar, 'aria-label', ariaLabel());
            state.aria.label = ariaLabel();
            if (state.known) removeClass(bar, 'is-indeterminate');
            else addClass(bar, 'is-indeterminate');
        }

        function applyFill() {
            var fill = nodes.fill;
            if (!state.known || !state.total || state.total <= 0) {
                if (fill && fill.style) { try { fill.style.width = ''; } catch (e) {} }
                return;
            }
            var percent = Math.round((state.done / state.total) * 1000) / 10;
            if (percent > 100) percent = 100;
            if (percent < 0) percent = 0;
            if (fill && fill.style) {
                try { fill.style.width = percent + '%'; } catch (e) {}
                try { fill.setAttribute('data-percent', String(percent)); } catch (e) {}
            }
        }

        function attachRetry() {
            if (clickBound || !nodes.retry || typeof nodes.retry.addEventListener !== 'function') return;
            clickBound = true;
            try {
                nodes.retry.addEventListener('click', function (event) {
                    if (event && typeof event.preventDefault === 'function') event.preventDefault();
                    requestSession();
                });
            } catch (e) {}
        }

        /* 网络动作全部走可选回调：父级没接线时按钮只是不出效果，不会让组件崩掉 */
        function requestSession() {
            var sid = state.sessionId;
            if (!sid) return null;
            if (typeof options.onRequest === 'function') {
                try {
                    var result = options.onRequest({
                        type: 'refresh_session',
                        session_id: sid,
                        reason: state.pendingReason || 'manual'
                    });
                    if (result && typeof result.then === 'function') {
                        result.then(function (next) { if (next) update(next); }, function (err) { reportError(err); });
                    } else if (isObject(result)) {
                        update(result);
                    }
                    return result;
                } catch (e) {
                    reportError(e);
                    return null;
                }
            }
            var fetcher = typeof options.fetchJson === 'function' ? options.fetchJson : defaultFetchJson;
            if (typeof fetcher !== 'function') return null;
            var url = '/api/companion/sessions/' + encodeURIComponent(sid);
            try {
                var pending = fetcher(url, { method: 'GET', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
                if (pending && typeof pending.then === 'function') {
                    pending.then(function (payload) {
                        if (payload && typeof payload.json === 'function') {
                            return payload.json().then(function (data) {
                                if (data) update(data);
                            });
                        }
                        if (isObject(payload)) update(payload);
                        return null;
                    }).then(null, function (err) { reportError(err); });
                }
                return pending;
            } catch (e) {
                reportError(e);
                return null;
            }
        }

        function reportError(error) {
            if (typeof options.onError !== 'function') return;
            try { options.onError(error); } catch (e) {}
        }

        function render() {
            if (destroyed) return;
            /* 先算文案，再判宿主：没有 DOM 时状态依旧是最新的 */
            state.reducedMotion = prefersReducedMotion();
            var html = buildHtml(state.reducedMotion);
            if (!host) return;
            try { host.innerHTML = html; } catch (e) { return; }
            nodes = collect(host);
            applyAria();
            applyFill();
            attachRetry();
            if (nodes.root) {
                setAttr(nodes.root, 'data-testid', 'companion-progress');
            }
        }

        function update(nextView) {
            if (destroyed) return getState();
            if (!isObject(nextView)) return getState();
            view = nextView;
            state.sessionId = String(nextView.session_id || state.sessionId || '');
            state.state = String(nextView.state || '');
            state.goalKind = String(nextView.goal_kind || '');
            state.roleId = String(nextView.role_id || '');
            state.roleName = String(nextView.role_name || '');
            state.revision = toCount(nextView.revision) !== null ? toCount(nextView.revision) : state.revision;

            var progress = isObject(nextView.progress) ? nextView.progress : {};
            var progressTotal = toCount(progress.total);
            var progressDone = toCount(progress.done);
            var known = progress.known !== false && progressTotal !== null && progressTotal > 0;

            /* 本轮计数优先用会话自己的 confirmed/target（今日计划与本轮不是一回事），
             * 缺字段时再退回 progress，保证两种视图都能显示。 */
            var confirmed = toCount(nextView.confirmed_count);
            var target = toCount(nextView.target_count);
            var roundTotal = (target !== null && target > 0) ? target : (known ? progressTotal : null);
            var roundDone = confirmed !== null ? confirmed : (progressDone === null ? 0 : progressDone);
            var roundKnown = roundTotal !== null && roundTotal > 0 && progress.known !== false;

            state.done = roundDone;
            state.known = roundKnown;
            state.total = roundKnown ? roundTotal : null;
            /* 今日部分独立计算：goal_kind 不是 today_plan 时今日进度根本没有数据源 */
            state.todayText = todayFromView(nextView);
            if (!state.known) {
                state.todayText = TODAY_PENDING;
            }

            if (state.pendingReason) {
                var completion = isObject(nextView.completion) ? nextView.completion : null;
                var serverReason = completion && typeof completion.reason === 'string' ? completion.reason : '';
                if (serverReason) state.pendingReason = serverReason;
            }

            render();
            return getState();
        }

        function setPending(reason) {
            if (destroyed) return getState();
            var text = typeof reason === 'string' ? reason.trim() : '';
            if (!text && isObject(view) && isObject(view.completion) && typeof view.completion.reason === 'string') {
                text = view.completion.reason.trim();
            }
            state.pending = true;
            state.pendingReason = text || '\u7b49\u5f85\u786e\u8ba4\u672c\u8f6e\u8fdb\u5ea6';
            render();
            return getState();
        }

        function mount(container) {
            if (destroyed) return null;
            if (!container || typeof container !== 'object') return null;
            /* 幂等：同一容器重复 mount 只重画，不叠加一份 DOM */
            host = container;
            state.mounted = true;
            render();
            return null;
        }

        function destroy() {
            destroyed = true;
            if (host) {
                try { host.innerHTML = ''; } catch (e) {}
            }
            host = null;
            nodes = emptyNodes();
            state.mounted = false;
            state.pending = false;
            state.pendingReason = '';
            return null;
        }

        function getState() {
            return {
                mounted: state.mounted,
                mountedTo: !!host,
                sessionId: state.sessionId,
                state: state.state,
                goalKind: state.goalKind,
                roleId: state.roleId,
                roleName: state.roleName,
                known: state.known,
                done: state.done,
                total: state.total,
                progressText: state.progressText,
                labelText: state.labelText,
                todayText: state.todayText,
                pending: state.pending,
                pendingReason: state.pendingReason,
                aria: {
                    valuenow: state.aria.valuenow,
                    valuemax: state.aria.valuemax,
                    valuetext: state.aria.valuetext,
                    label: state.aria.label
                },
                reducedMotion: state.reducedMotion,
                revision: state.revision
            };
        }

        return {
            mount: mount,
            update: update,
            setPending: setPending,
            destroy: destroy,
            getState: getState
        };
    }

    return {
        create: create,
        minutesText: minutesText,
        TODAY_PENDING: TODAY_PENDING
    };
});