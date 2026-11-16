/* Memo Superform - 陪伴结算弹层的展示与「只演一次」约束。
 * 结算属于一次性仪式：本地文字必须先出现，AI/TTS/动作都只是可选增强。
 * 重看历史结算时不能再演一遍，否则用户每点一次就多听一句，像被复读机缠上。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.CompanionSettlement = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var MAX_WEAK_WORDS = 10;
    var UPDATED_NOTICE = '\u8fd9\u4e00\u8f6e\u8bb0\u5f55\u5df2\u66f4\u65b0';

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

    function minutesText(seconds) {
        var total = toCount(seconds, 0);
        if (total <= 0) return '';
        var minutes = Math.floor(total / 60);
        if (minutes < 1) return '\u4e0d\u5230 1 \u5206\u949f';
        return minutes + ' \u5206\u949f';
    }

    function weakWordsList(payload) {
        var source = isObject(payload) && payload.weak_words;
        var list = [];
        if (!source || typeof source.length !== 'number') return list;
        for (var i = 0; i < source.length && list.length < MAX_WEAK_WORDS; i++) {
            var word = source[i];
            var text = '';
            if (typeof word === 'string') text = word;
            else if (isObject(word)) text = String(word.word || word.text || word.name || '');
            text = text.trim();
            if (text) list.push(text);
        }
        return list;
    }

    function cardPayload(view) {
        var rewards = isObject(view) && view.rewards && typeof view.rewards.length === 'number' ? view.rewards : [];
        for (var i = 0; i < rewards.length; i++) {
            var reward = rewards[i];
            if (!isObject(reward)) continue;
            if (String(reward.type || '') === 'memorial_card') return isObject(reward.payload) ? reward.payload : {};
        }
        return null;
    }

    function hasBadge(view, type) {
        var rewards = isObject(view) && view.rewards && typeof view.rewards.length === 'number' ? view.rewards : [];
        for (var i = 0; i < rewards.length; i++) {
            if (isObject(rewards[i]) && String(rewards[i].type || '') === type) return true;
        }
        return false;
    }

    function rewardTypes(view) {
        var rewards = isObject(view) && view.rewards && typeof view.rewards.length === 'number' ? view.rewards : [];
        var types = [];
        for (var i = 0; i < rewards.length; i++) {
            if (!isObject(rewards[i])) continue;
            var type = String(rewards[i].type || '');
            if (type && types.indexOf(type) === -1) types.push(type);
        }
        return types;
    }

    function setAttr(el, name, value) {
        if (!el || typeof el.setAttribute !== 'function') return false;
        try { el.setAttribute(name, String(value)); return true; } catch (e) { return false; }
    }

    function focusEl(el) {
        if (!el || typeof el.focus !== 'function') return false;
        try { el.focus(); return true; } catch (e) { return false; }
    }

    function create(options) {
        options = isObject(options) ? options : {};
        var state = {
            open: false,
            stale: false,
            settlementId: '',
            roleId: '',
            aiAskedId: '',
            aiText: '',
            localText: '',
            notice: '',
            message: '',
            canAi: false,
            aiRequested: false,
            spoken: false,
            motionPlayed: false,
            cardVisible: false,
            badgeVisible: false,
            weakWords: [],
            activeSeconds: 0,
            confirmedTotal: 0,
            studyDay: '',
            roleName: '',
            rewardTypes: [],
            reducedMotion: false,
            lastView: null
        };
        var view = null;
        var host = null;
        var nodes = emptyNodes();
        var destroyed = false;
        var aiTicket = 0;
        var openerEl = null;
        var listening = false;

        function emptyNodes() {
            return { root: null, title: null, card: null, badge: null, closeBtn: null, body: null, notice: null, cardImage: null };
        }

        function prefersReducedMotion() {
            try {
                if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
                var media = window.matchMedia('(prefers-reduced-motion: reduce)');
                return !!(media && media.matches);
            } catch (e) {
                return false;
            }
        }

        function cardHtml(payload) {
            if (!payload) return '';
            var payloadRole = String(payload.role_name || state.roleName || '');
            var payloadDay = String(payload.study_day || state.studyDay || '');
            var payloadTotal = toCount(payload.confirmed_total, state.confirmedTotal);
            var words = weakWordsList(payload);
            if (!words.length) words = state.weakWords;
            var wordsHtml = '';
            for (var i = 0; i < words.length; i++) {
                wordsHtml += '<li class="companion-settlement__word">' + escapeHtml(words[i]) + '</li>';
            }
            var wordsBlock = wordsHtml
                ? '<ul class="companion-settlement__words" data-testid="companion-settlement-words">' + wordsHtml + '</ul>'
                : '';
            var imageBlock = '<img class="companion-settlement__card-image" data-testid="companion-settlement-card-image"'
                + ' src="img/gifs/anon-think.gif" alt="" aria-hidden="true" loading="lazy">';
            return '<section class="companion-settlement__card" data-testid="companion-settlement-card"'
                + ' data-weak-count="' + words.length + '">'
                + imageBlock
                + '<p class="companion-settlement__card-head">\u7eaa\u5ff5\u5361</p>'
                + '<dl class="companion-settlement__card-meta">'
                + (payloadDay ? '<div><dt>\u5b66\u4e60\u65e5</dt><dd>' + escapeHtml(payloadDay) + '</dd></div>' : '')
                + (payloadRole ? '<div><dt>\u89d2\u8272</dt><dd>' + escapeHtml(payloadRole) + '</dd></div>' : '')
                + '<div><dt>\u786e\u8ba4\u8bcd\u6570</dt><dd>' + escapeHtml(payloadTotal) + '</dd></div>'
                + '</dl>'
                + wordsBlock
                + '</section>';
        }

        function badgeHtml() {
            if (!state.badgeVisible) return '';
            return '<span class="companion-settlement__badge" data-testid="companion-settlement-badge"'
                + ' data-badge-type="first_completion">\u9996\u6b21\u5b8c\u6210</span>';
        }

        function noticeHtml() {
            if (!state.notice) return '';
            return '<p class="companion-settlement__notice" data-testid="companion-settlement-notice" role="status">'
                + escapeHtml(state.notice) + '</p>';
        }

        function bodyHtml() {
            var notice = noticeHtml();
            /* 已过期的结算只留提示：旧数字继续摆着会和「已更新」自相矛盾 */
            if (state.stale) return notice;
            var local = state.localText ? '<p class="companion-settlement__message" data-testid="companion-settlement-message">'
                + escapeHtml(state.localText) + '</p>' : '';
            var ai = state.aiText ? '<p class="companion-settlement__ai" data-testid="companion-settlement-ai">'
                + escapeHtml(state.aiText) + '</p>' : '';
            var stats = '<p class="companion-settlement__stats" data-testid="companion-settlement-stats">'
                + '\u65b0\u8bcd ' + escapeHtml(toCount(view && view.confirmed_new, 0))
                + '\u3000\u590d\u4e60 ' + escapeHtml(toCount(view && view.confirmed_review, 0))
                + '\u3000\u5171 ' + escapeHtml(toCount(view && view.confirmed_total, 0)) + ' \u8bcd'
                + (minutesText(view && view.active_seconds)
                    ? '\u3000\u00b7\u3000' + escapeHtml(minutesText(view && view.active_seconds)) : '')
                + '</p>';
            return notice + local + ai + stats + (state.cardVisible ? cardHtml(cardPayload(view)) : '') + badgeHtml();
        }

        function buildHtml() {
            var labelId = 'companion-settlement-title';
            return '<div class="companion-settlement' + (state.reducedMotion ? ' is-static' : '') + '"'
                + ' data-testid="companion-settlement" role="dialog" aria-modal="true"'
                + ' aria-labelledby="' + labelId + '" aria-describedby="' + labelId + '-desc"'
                + ' data-settlement-id="' + escapeHtml(state.settlementId) + '"'
                + ' data-role-id="' + escapeHtml(state.roleId) + '"'
                + ' data-open="true" data-ai-requested="' + (state.aiRequested ? 'true' : 'false') + '">'
                + '<div class="companion-settlement__panel" data-testid="companion-settlement-panel">'
                + '<h2 class="companion-settlement__title" id="' + labelId + '"'
                + ' data-testid="companion-settlement-title" tabindex="-1">'
                + escapeHtml(state.roleName ? (state.roleName + ' \u00b7 \u672c\u8f6e\u7ed3\u7b97') : '\u672c\u8f6e\u7ed3\u7b97')
                + '</h2>'
                + '<p class="companion-settlement__subtitle" id="' + labelId + '-desc">'
                + escapeHtml(state.studyDay ? ('\u5b66\u4e60\u65e5 ' + state.studyDay) : '\u4eca\u5929\u7684\u966a\u4f34\u8bb0\u5f55') + '</p>'
                + '<div class="companion-settlement__body" data-testid="companion-settlement-body">'
                + bodyHtml()
                + '</div>'
                + '<button type="button" class="companion-settlement__close" data-testid="companion-settlement-close">\u5173\u95ed</button>'
                + '</div>'
                + '</div>';
        }

        function collect(rootEl) {
            var result = emptyNodes();
            if (!rootEl || typeof rootEl.querySelector !== 'function') return result;
            function q(selector) {
                try { return rootEl.querySelector(selector); } catch (e) { return null; }
            }
            result.root = q('[data-testid="companion-settlement"]');
            result.title = q('[data-testid="companion-settlement-title"]');
            result.card = q('[data-testid="companion-settlement-card"]');
            result.badge = q('[data-testid="companion-settlement-badge"]');
            result.closeBtn = q('[data-testid="companion-settlement-close"]');
            result.body = q('[data-testid="companion-settlement-body"]');
            result.notice = q('[data-testid="companion-settlement-notice"]');
            result.cardImage = q('[data-testid="companion-settlement-card-image"]');
            return result;
        }

        function render() {
            if (!host) return;
            state.reducedMotion = prefersReducedMotion();
            try { host.innerHTML = buildHtml(); } catch (e) { return; }
            nodes = collect(host);
            bindKeys();
            /* 图片加载失败时直接隐藏，不留一个破图占位 */
            if (nodes.cardImage && typeof nodes.cardImage.addEventListener === 'function') {
                try {
                    nodes.cardImage.addEventListener('error', function () {
                        if (nodes.cardImage && nodes.cardImage.style) nodes.cardImage.style.display = 'none';
                    });
                } catch (e) {}
            }
            if (nodes.closeBtn && typeof nodes.closeBtn.addEventListener === 'function') {
                try { nodes.closeBtn.addEventListener('click', function () { hide(); }); } catch (e) {}
            }
            if (nodes.root && typeof nodes.root.addEventListener === 'function') {
                try {
                    nodes.root.addEventListener('click', function (event) {
                        if (event && event.target === nodes.root) hide();
                    });
                } catch (e) {}
            }
        }

        function focusables() {
            var list = [];
            if (!host || typeof host.querySelectorAll !== 'function') return list;
            var candidates;
            try {
                candidates = host.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
            } catch (e) {
                return list;
            }
            if (!candidates || typeof candidates.length !== 'number') return list;
            for (var i = 0; i < candidates.length; i++) {
                var el = candidates[i];
                if (el && el.disabled !== true) list.push(el);
            }
            return list;
        }

        function onKeyDown(event) {
            if (!event || !state.open) return;
            var key = event.key || '';
            if (key === 'Escape' || key === 'Esc') {
                if (typeof event.preventDefault === 'function') event.preventDefault();
                hide();
                return;
            }
            if (key !== 'Tab') return;
            var list = focusables();
            var doc = null;
            try { doc = typeof document !== 'undefined' ? document : null; } catch (e) { doc = null; }
            if (!list.length) {
                /* 弹层里没有可聚焦控件时，把 Tab 留在标题上，不让焦点逃到背景页面 */
                if (typeof event.preventDefault === 'function') event.preventDefault();
                focusEl(nodes.title);
                return;
            }
            var active = doc && doc.activeElement ? doc.activeElement : null;
            var index = list.indexOf(active);
            if (index === -1) index = event.shiftKey ? 0 : list.length - 1;
            var next = event.shiftKey
                ? list[(index - 1 + list.length) % list.length]
                : list[(index + 1) % list.length];
            if (typeof event.preventDefault === 'function') event.preventDefault();
            focusEl(next);
        }

        function bindKeys() {
            if (listening || !nodes.root || typeof nodes.root.addEventListener !== 'function') return;
            listening = true;
            try { nodes.root.addEventListener('keydown', onKeyDown); } catch (e) { listening = false; }
        }

        function focusInitial() {
            if (nodes.closeBtn && focusEl(nodes.closeBtn)) return;
            focusEl(nodes.title);
        }

        function currentDoc() {
            try { return typeof document !== 'undefined' ? document : null; } catch (e) { return null; }
        }

        /* 首次打开才允许 AI/TTS/动作，且用一个票据保证「晚到的旧回复」不会污染新一轮 */
        function playEnhancements(ticket, askAi) {
            var sid = state.settlementId;
            if (typeof options.playMotion === 'function') {
                try { options.playMotion({ settlement_id: sid, role_id: state.roleId }); state.motionPlayed = true; } catch (e) {}
            }
            if (typeof options.speak === 'function' && !state.reducedMotion) {
                try {
                    options.speak({ settlement_id: sid, text: state.localText, message: state.localText });
                    state.spoken = true;
                } catch (e) {}
            } else if (typeof options.speak === 'function') {
                state.spoken = false;
            }
            if (!askAi || typeof options.requestAi !== 'function') return;
            var ticketValue = ticket;
            var payload = {
                settlement_id: sid,
                session_id: String((view && view.session_id) || ''),
                role_id: state.roleId,
                ticket: ticketValue,
                message: state.localText,
                goal: view && view.goal ? view.goal : null
            };
            var settle = function (reply) {
                /* 票据不符说明弹层已经换了一轮，旧回复必须丢弃 */
                if (destroyed || !state.open || ticketValue !== aiTicket) return;
                var text = '';
                if (typeof reply === 'string') text = reply;
                else if (isObject(reply)) text = String(reply.ai_message || reply.text || reply.message || '');
                text = text.trim();
                if (!text) return;
                state.aiText = text;
                /* 只加一句 AI 补充，不覆盖服务端给的本地 message：
                 * 本地祝贺是保底内容，任何时候都该读得到 */
                if (nodes.body) {
                    try { nodes.body.innerHTML = bodyHtml(); } catch (e) {}
                }
                if (nodes.root) setAttr(nodes.root, 'data-ai-state', 'ready');
            };
            try {
                var pending = options.requestAi(payload);
                if (pending && typeof pending.then === 'function') {
                    pending.then(settle, function () {
                        /* 失败静默降级：本地 message 已经在了，绝不重试刷屏 */
                        if (nodes.root) setAttr(nodes.root, 'data-ai-state', 'failed');
                    });
                } else if (pending !== null && pending !== undefined) {
                    settle(pending);
                }
            } catch (e) {
                if (nodes.root) setAttr(nodes.root, 'data-ai-state', 'failed');
            }
        }

        function applyView(nextView) {
            view = nextView;
            state.lastView = nextView;
            state.settlementId = String(nextView.settlement_id || '');
            state.roleId = String(nextView.role_id || '');
            state.roleName = String(nextView.role_name || '');
            state.studyDay = String(nextView.study_day || '');
            state.confirmedTotal = toCount(nextView.confirmed_total, 0);
            state.activeSeconds = toCount(nextView.active_seconds, 0);
            state.weakWords = weakWordsList(nextView);
            state.rewardTypes = rewardTypes(nextView);
            state.cardVisible = !!cardPayload(nextView);
            state.badgeVisible = hasBadge(nextView, 'first_completion');
            state.canAi = !!nextView.ai_state && nextView.ai_state !== 'off' && nextView.ai_state !== 'disabled';
            /* 本地文案优先，服务端没给才用兜底句，保证文字永远先出现 */
            var local = typeof nextView.message === 'string' && nextView.message.trim()
                ? nextView.message.trim()
                : ('\u8fd9\u4e00\u8f6e\u5b8c\u6210\u4e86\uff0c\u5171\u786e\u8ba4 ' + state.confirmedTotal + ' \u4e2a\u8bcd\u3002');
            state.localText = local;
            state.message = local;
            state.notice = '';
            /* 拿到有效视图就说明不再是过期内容 */
            state.stale = false;
        }

        /* AI 只认「这一份结算的第一次打开」：同一 settlement_id 反复 show 不再请求，
         * 否则用户关掉再打开就会多花一次额度和一次等待。 */
        function aiAlreadyAsked(settlementId) {
            return !!settlementId && state.aiAskedId === settlementId;
        }

        function show(nextView) {
            if (destroyed || !isObject(nextView)) return null;
            var wasOpen = state.open;
            var previousId = state.settlementId;
            if (!wasOpen) {
                var doc = currentDoc();
                try { openerEl = doc && doc.activeElement ? doc.activeElement : null; } catch (e) { openerEl = null; }
            }
            applyView(nextView);
            state.open = true;
            state.stale = false;
            if (previousId !== state.settlementId) state.aiText = '';
            ensureHost();
            if (host) {
                try { host.hidden = false; } catch (e) {}
            }
            render();
            if (!wasOpen) focusInitial();
            /* 已在弹层里重复 show 同一份时，不做任何演出，避免双重语音/动作 */
            if (wasOpen && previousId === state.settlementId) return getState();
            var ticket = ++aiTicket;
            var ask = state.canAi && typeof options.requestAi === 'function' && !aiAlreadyAsked(state.settlementId);
            state.aiRequested = ask;
            /* 先记账再发请求：requestAi 可能同步回调，晚记会让重复 show 又发一次 */
            if (ask) state.aiAskedId = state.settlementId;
            if (!ask) removeAiPending();
            playEnhancements(ticket, ask);
            if (ask) {
                if (nodes.root) setAttr(nodes.root, 'data-ai-state', 'pending');
            }
            return getState();
        }

        /* 真实页面里父级通常只想 show(view)，所以没有显式 mount 时就自己挂到 body 上；
         * 拿不到 document（node 测试）就静默跳过，状态仍通过 getState() 可断言。 */
        function ensureHost() {
            if (host) return host;
            var doc = currentDoc();
            if (!doc || typeof doc.createElement !== 'function' || !doc.body) return null;
            try {
                var layer = doc.createElement('div');
                layer.className = 'companion-settlement-layer';
                layer.setAttribute('data-testid', 'companion-settlement-layer');
                doc.body.appendChild(layer);
                host = layer;
                return host;
            } catch (e) {
                return null;
            }
        }

        function removeAiPending() {
            if (nodes.root) setAttr(nodes.root, 'data-ai-state', 'local-only');
        }

        /* 重看同一份结算：只更新数字，不重放语音、动作、AI */
        function refresh(nextView) {
            if (destroyed) return getState();
            if (!isObject(nextView)) return getState();
            if (nextView.available === false) return invalidate();
            var nextId = String(nextView.settlement_id || '');
            var nextRole = String(nextView.role_id || '');
            if (!state.open) return getState();
            /* 换了结算或换了角色，说明这一轮已经被别的会话覆盖，旧内容不能再留着 */
            if ((state.settlementId && nextId && nextId !== state.settlementId)
                || (state.roleId && nextRole && nextRole !== state.roleId)) {
                return invalidate();
            }
            applyView(nextView);
            render();
            /* 语音属于上一份内容，数字变了就别让它继续念旧统计 */
            if (state.spoken && typeof options.stopSpeak === 'function') {
                try { options.stopSpeak(); } catch (e) {}
                state.spoken = false;
            }
            return getState();
        }

        function invalidate() {
            aiTicket++;
            /* 无条件停语音：stopSpeak 本身是幂等的，比猜测「有没有在念」更可靠 */
            stopSpeak();
            state.notice = UPDATED_NOTICE;
            state.stale = true;
            /* 不静默关窗：留一句「记录已更新」让用户知道刚才那份数字作废了 */
            if (state.open) {
                render();
                if (nodes.root) setAttr(nodes.root, 'data-stale', 'true');
                if (nodes.closeBtn) focusEl(nodes.closeBtn);
            }
            return getState();
        }

        function stopSpeak() {
            state.spoken = false;
            if (typeof options.stopSpeak !== 'function') return;
            try { options.stopSpeak(); } catch (e) {}
        }

        function hide() {
            if (!state.open && !host) return null;
            state.open = false;
            aiTicket++;
            stopSpeak();
            if (host) {
                try { host.innerHTML = ''; } catch (e) {}
                try { host.hidden = true; } catch (e) {}
            }
            nodes = emptyNodes();
            listening = false;
            var back = openerEl;
            openerEl = null;
            if (back) focusEl(back);
            if (typeof options.onClose === 'function') {
                try { options.onClose({ settlement_id: state.settlementId, notice: state.notice }); } catch (e) {}
            }
            return null;
        }

        function isOpen() { return state.open === true; }

        function mount(target) {
            if (!target || typeof target !== 'object') return null;
            host = target;
            if (state.open) render();
            return null;
        }

        function destroy() {
            if (state.spoken && typeof options.stopSpeak === 'function') {
                try { options.stopSpeak(); } catch (e) {}
            }
            destroyed = true;
            state.open = false;
            state.spoken = false;
            aiTicket++;
            if (host) {
                try { host.innerHTML = ''; } catch (e) {}
            }
            host = null;
            nodes = emptyNodes();
            view = null;
            return null;
        }

        function getState() {
            return {
                open: state.open,
                isOpen: state.open === true,
                settlementId: state.settlementId,
                roleId: state.roleId,
                roleName: state.roleName,
                studyDay: state.studyDay,
                confirmedTotal: state.confirmedTotal,
                activeSeconds: state.activeSeconds,
                localText: state.localText,
                aiText: state.aiText,
                message: state.message,
                notice: state.notice,
                stale: !!state.stale,
                aiRequested: !!state.aiRequested,
                cardVisible: !!state.cardVisible,
                badgeVisible: !!state.badgeVisible,
                weakWords: state.weakWords.slice ? state.weakWords.slice(0) : state.weakWords,
                rewardTypes: state.rewardTypes.slice ? state.rewardTypes.slice(0) : state.rewardTypes,
                spoken: !!state.spoken,
                motionPlayed: !!state.motionPlayed,
                reducedMotion: state.reducedMotion,
                /* 过期时只回报提示，避免调用方拿旧数字继续做判断 */
                text: state.stale
                    ? state.notice
                    : ((state.notice ? state.notice + ' ' : '') + state.localText
                        + (state.aiText ? ' ' + state.aiText : ''))
            };
        }

        return {
            mount: mount,
            show: show,
            hide: hide,
            refresh: refresh,
            isOpen: isOpen,
            destroy: destroy,
            getState: getState
        };
    }

    return {
        create: create,
        MAX_WEAK_WORDS: MAX_WEAK_WORDS,
        UPDATED_NOTICE: UPDATED_NOTICE
    };
});