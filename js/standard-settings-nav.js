// ==========================================
// Memo Superform - 普通版设置页：分类目录 → 分类详情
// ==========================================
// 目标：设置不再是一张长页。打开先看到分类目录，进入分类后回到目录。
//
// 关键约束：index.html 里的设置面板是普通版和笔记本共用的同一份 DOM。
// 因此分类结构**不能写死在 HTML 里** —— 那会把笔记本的长页设置也拆掉。
// 本模块只在普通版运行时把原有的 setting-group 就地分组，笔记本主题
// 根本不会执行到这里（见下方 isNotebook 早退），其设置页保持原样。
//
// 其它约束：
//   · 分类页一旦建好就存在，切换只改可见性 —— 不重建 DOM、不重复绑定、
//     不发请求、不重载大资源（语音包、模型库、角色编辑器都保持原状态）。
//   · 只搬运节点，不复制节点：每个设置仍然只有一份，id 不会重复。
//   · 未保存的内容在切换分类 / 返回目录 / 关闭设置前都要提示，不静默丢弃。
(function () {
    'use strict';

    var style = window.MemoUIStyle || {};
    // 笔记本主题：设置页必须保持原来的一张长页，本模块完全不介入。
    if (style.isNotebook) return;

    var STORAGE_KEY = 'memo_settings_last_category';
    var panel, nav, pages, backButtons;
    var currentId = '';
    // 需要“保存设置”才生效的字段：关闭或切换前若与其已保存值不同，就要提示。
    // 必须与 app.js 保存处理器实际写入的字段一一对应，漏一个就会静默丢改动
    // （aiProviderSelect 之前就是这样漏掉的）。
    var SAVE_FIELDS = ['aiProviderSelect', 'aiEndpointInput', 'aiKeyInput', 'aiModelInput',
        'uiStyleSelect', 'defaultModeSelect'];
    // 运行模式由异步请求回填，回填完成前后都不能当成“用户改了”。
    var dirtyFields = {};

    var summaryState = '';

    function summaryResolved() {
        return summaryState !== '';
    }

    // 目录里的状态摘要接真实状态，而不是永远显示同一句静态文案。
    function syncAccountSummary() {
        // MaimemoAPI 是 js/api.js 里的顶层 const，不是 window 上的属性；用 typeof
        // 直接判断标识符才拿得到它。
        var api = typeof MaimemoAPI !== 'undefined' ? MaimemoAPI : null;
        var status = api && api.connectionStatus ? api.connectionStatus() : null;
        if (!status) return;
        summaryState = 'set';
        if (status.connected) {
            var who = status.mode === 'oauth'
                ? (status.display_name ? '已连接 · ' + status.display_name : '已连接')
                : '已连接 · 手动 Token';
            setSummary('account', who, 'ok');
        } else if (status.error) {
            setSummary('account', '状态读取失败，可重新检测', 'error');
        } else if (status.pending) {
            setSummary('account', '等待浏览器完成授权', 'warn');
        } else if (status.configured === false) {
            setSummary('account', '未配置开放平台 client_id', 'warn');
        } else {
            setSummary('account', '未连接墨墨账号', 'warn');
        }
    }

    // 分类与原有设置组的对应关系。每个原组恰好出现在一个分类里，
    // 既不新增也不遗漏设置项（组用标题文字识别，见 groupTitleOf）。
    var CATEGORIES = [
        { id: 'account', title: '账号与连接', summary: '墨墨账号连接与一键授权',
          groups: ['墨墨账号'] },
        { id: 'learning', title: '学习与进度', summary: '学习数据更新、核验与缓存',
          groups: ['数据更新'] },
        { id: 'companion', title: '角色与陪伴', summary: '陪伴模式、提醒与 Live2D 模型',
          groups: ['陪伴模式', 'Live2D 模型库'] },
        { id: 'voice', title: '语音与音频', summary: '语音包、角色与朗读参数',
          groups: ['语音功能（GPT-SoVITS 资源包）'] },
        { id: 'ai', title: 'AI 与记忆', summary: 'AI 接口与 Codex 登录',
          groups: ['AI API 配置（可选）'] },
        { id: 'appearance', title: '外观与窗口', summary: '界面风格与启动模式',
          groups: ['界面风格', '运行模式'] },
        { id: 'maintenance', title: '数据与维护', summary: '软件版本与更新检查',
          groups: ['软件更新'] }
    ];

    function groupTitleOf(group) {
        var heading = group.querySelector('h3');
        return heading ? heading.textContent.trim() : '';
    }

    // 把原来的 9 个设置组搬进 7 个分类页。只移动已有节点，不复制。
    function buildCategories() {
        var body = document.querySelector('#settingsPanel .settings-body');
        if (!body || body.dataset.settingsSplit === 'true') return !!body;
        var groups = Array.prototype.slice.call(body.children).filter(function (node) {
            return node.classList && node.classList.contains('setting-group');
        });
        if (!groups.length) return false;

        var byTitle = {};
        groups.forEach(function (group) { byTitle[groupTitleOf(group)] = group; });
        // 有任何原组对不上分类，就不动 DOM：宁可保持长页，也不要把设置弄丢。
        var claimed = {};
        CATEGORIES.forEach(function (category) {
            category.groups.forEach(function (title) { claimed[title] = true; });
        });
        var missing = groups.filter(function (group) { return !claimed[groupTitleOf(group)]; });
        if (missing.length) {
            if (window.console && console.warn) {
                console.warn('[settings] 未分类的设置组，保持长页：',
                    missing.map(groupTitleOf).join('、'));
            }
            return false;
        }

        var layout = document.createElement('div');
        layout.className = 'settings-layout';

        var navEl = document.createElement('nav');
        navEl.className = 'settings-nav';
        navEl.setAttribute('role', 'tablist');
        navEl.setAttribute('aria-label', '设置分类');
        navEl.setAttribute('aria-orientation', 'vertical');

        var pagesEl = document.createElement('div');
        pagesEl.className = 'settings-pages';

        CATEGORIES.forEach(function (category, index) {
            var tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'settings-nav-item';
            tab.id = 'settingsTab-' + category.id;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('data-settings-target', category.id);
            tab.setAttribute('aria-controls', 'settingsPage-' + category.id);
            tab.setAttribute('aria-selected', index === 0 ? 'true' : 'false');
            tab.tabIndex = index === 0 ? 0 : -1;
            var tabTitle = document.createElement('span');
            tabTitle.className = 'settings-nav-title';
            tabTitle.textContent = category.title;
            var tabSummary = document.createElement('span');
            tabSummary.className = 'settings-nav-summary';
            tabSummary.setAttribute('data-settings-summary', category.id);
            tabSummary.textContent = category.summary;
            tab.appendChild(tabTitle);
            tab.appendChild(tabSummary);
            navEl.appendChild(tab);

            var page = document.createElement('section');
            page.className = 'settings-page' + (index === 0 ? ' is-active' : '');
            page.id = 'settingsPage-' + category.id;
            page.setAttribute('role', 'tabpanel');
            page.setAttribute('aria-labelledby', 'settingsTab-' + category.id);
            page.setAttribute('data-settings-page', category.id);
            page.hidden = index !== 0;

            var header = document.createElement('header');
            header.className = 'settings-page-header';
            var back = document.createElement('button');
            back.type = 'button';
            back.className = 'settings-back';
            back.setAttribute('data-settings-back', '');
            var arrow = document.createElement('span');
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '←';
            back.appendChild(arrow);
            back.appendChild(document.createTextNode(' 全部设置'));
            var heading = document.createElement('h3');
            heading.className = 'settings-page-title';
            heading.textContent = category.title;
            var summary = document.createElement('p');
            summary.className = 'settings-page-summary';
            summary.setAttribute('data-settings-page-summary', category.id);
            summary.textContent = category.summary;
            header.appendChild(back);
            header.appendChild(heading);
            header.appendChild(summary);
            page.appendChild(header);

            category.groups.forEach(function (title) {
                var group = byTitle[title];
                if (group) page.appendChild(group);
            });
            pagesEl.appendChild(page);
        });

        // 注意：appendChild 已经把节点移到分类页里了，不能再"清理"一遍 ——
        // 那时 group.parentNode 已经是分类页，再 removeChild 会把设置删掉。
        layout.appendChild(navEl);
        layout.appendChild(pagesEl);
        body.appendChild(layout);
        body.dataset.settingsSplit = 'true';
        return true;
    }

    function allPages() {
        return Array.prototype.slice.call(document.querySelectorAll('[data-settings-page]'));
    }
    function allTabs() {
        return Array.prototype.slice.call(document.querySelectorAll('.settings-nav-item'));
    }

    // 程序回填或用户保存后，基线必须跟着前移；否则关面板时会误报“还有未保存的改动”。
    function markClean(id) {
        var node = document.getElementById(id);
        if (node) node.dataset.savedValue = node.value;
        delete dirtyFields[id];
    }

    function savedValue(id) {
        // AI 配置的持久值来自 AIAPI（localStorage），其余用基线值。
        // AIAPI 是 js/api.js 里的顶层 const，不挂在 window 上，必须用 typeof 取。
        try {
            if (id === 'uiStyleSelect') return style.name;
            var api = typeof AIAPI !== 'undefined' ? AIAPI : null;
            if (api && typeof api.getConfig === 'function') {
                var cfg = api.getConfig();
                if (cfg) {
                    if (id === 'aiProviderSelect') return cfg.provider || '';
                    if (id === 'aiEndpointInput') return cfg.endpoint || '';
                    if (id === 'aiKeyInput') return cfg.apiKey || '';
                    if (id === 'aiModelInput') return cfg.model || '';
                }
            }
        } catch (e) {}
        var node = document.getElementById(id);
        return node ? (node.dataset.savedValue !== undefined ? node.dataset.savedValue : node.value) : '';
    }

    // 只有用户真的动过、且值与打开面板时不同，才算“未保存”。程序回填值不算：
    // 运行模式要等一次异步请求才知道真正的值，若拿回填前的标记值当基线，
    // 用户什么都没改也会被拦“还有未保存的改动”。
    function hasUnsavedChanges() {
        return SAVE_FIELDS.some(function (id) {
            if (!dirtyFields[id]) return false;
            var node = document.getElementById(id);
            if (!node) return false;
            return String(node.value || '') !== String(savedValue(id) || '');
        });
    }

    // 保存语义不变：只有点“保存设置”才落盘。这里只是把当前值记成新的基线。
    function captureBaseline() {
        SAVE_FIELDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (node) node.dataset.savedValue = node.value;
        });
        dirtyFields = {};
    }

    // app.js 的保存处理器会同步关闭面板，而这里用 setTimeout 前移基线来不及，
    // 于是会误报“还有未保存的改动”。保存逻辑必须主动调这个函数。
    function markSaved() {
        captureBaseline();
    }

    // 用户交互才置脏；程序赋值不会触发这些事件，正是我们想要的区别。
    function watchDirtyFields(scope) {
        SAVE_FIELDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (!node || node.dataset.unsavedWatch === 'true') return;
            node.dataset.unsavedWatch = 'true';
            ['input', 'change'].forEach(function (type) {
                node.addEventListener(type, function () { dirtyFields[id] = true; });
            });
        });
    }

    function confirmLeave(action) {
        if (!hasUnsavedChanges()) return true;
        return typeof window.confirm === 'function'
            ? window.confirm('设置里还有未保存的改动，' + action + '会丢弃它们。继续吗？')
            : true;
    }

    function pageIdOf(tab) {
        return tab ? tab.getAttribute('data-settings-target') : '';
    }

    // 目录里的一句话状态：账号未连接、语音未就绪之类。文字与等级由调用方给出。
    function setSummary(id, text, level) {
        var targets = [
            document.querySelector('[data-settings-summary="' + id + '"]'),
            document.querySelector('[data-settings-page-summary="' + id + '"]')
        ];
        targets.forEach(function (node) {
            if (!node) return;
            if (text) node.textContent = text;
            // CSS 用的是 [data-state="..."]，之前加的是裸 class，两边对不上。
            if (level) node.setAttribute('data-state', level);
            else node.removeAttribute('data-state');
        });
    }

    function setActive(id, options) {
        options = options || {};
        var pages = allPages(), tabs = allTabs();
        if (!pages.length) return;
        var exists = pages.some(function (page) { return page.getAttribute('data-settings-page') === id; });
        if (!exists) id = pages[0].getAttribute('data-settings-page');
        currentId = id;
        pages.forEach(function (page) {
            var active = page.getAttribute('data-settings-page') === id;
            page.classList.toggle('is-active', active);
            page.hidden = !active;
        });
        tabs.forEach(function (tab) {
            var active = pageIdOf(tab) === id;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
        });
        // 窄窗口用 .is-detail 在“目录页”和“详情页”之间切换；宽窗口两者同时可见，
        // 这个类不影响布局（见 css/standard-settings.css 的媒体查询）。
        if (typeof options.showDetail === 'boolean') {
            var layout = document.querySelector('.settings-layout');
            if (layout) layout.classList.toggle('is-detail', options.showDetail);
        }
        // 记住最后浏览的分类，下次打开直接回到这里（不改变任何设置值）。
        try { localStorage.setItem(STORAGE_KEY, id); } catch (e) {}
        // 只在“用户主动切换”时把焦点移到分类上，避免打开面板时抢走焦点。
        if (options.focusTab) {
            var activeTab = tabs.filter(function (tab) { return pageIdOf(tab) === id; })[0];
            if (activeTab && typeof activeTab.focus === 'function') activeTab.focus();
        }
        if (options.scrollTop !== false) {
            var pagesBox = document.querySelector('.settings-pages');
            if (pagesBox) pagesBox.scrollTop = 0;
        }
    }

    function moveTab(delta) {
        var tabs = allTabs();
        if (!tabs.length) return;
        // 从“当前聚焦的那个分类”移动，而不是从上次选中的那个。用户用 Tab 把
        // 焦点放到某个分类上再按方向键时，必须从那个分类开始走。
        var anchor = tabs.indexOf(document.activeElement);
        var index = anchor >= 0 ? anchor
            : tabs.findIndex(function (tab) { return pageIdOf(tab) === currentId; });
        if (index < 0) index = 0;
        var next = (index + delta + tabs.length) % tabs.length;
        setActive(pageIdOf(tabs[next]), { focusTab: true });
    }

    function bind() {
        panel = document.getElementById('settingsPanel');
        if (!panel || panel.dataset.settingsNavReady) return;
        panel.dataset.settingsNavReady = 'true';

        allTabs().forEach(function (tab) {
            tab.addEventListener('click', function () {
                var target = pageIdOf(tab);
                // 窄窗口下点分类 = 进入详情页；宽窗口下右侧本来就在，行为一致。
                if (target === currentId && document.querySelector('.settings-layout.is-detail')) {
                    setActive(target, { scrollTop: false, showDetail: true });
                    return;
                }
                if (!confirmLeave('切换分类')) return;
                setActive(target, { scrollTop: true, showDetail: true });
                // 窄窗口下导航被隐藏，被点的 tab 不可见会让焦点掉到 body。把焦点
                // 交给详情页标题，键盘用户不会在进入详情时丢掉位置。
                if (document.querySelector('.settings-layout.is-detail')) {
                    var page = document.querySelector('[data-settings-page="' + target + '"]');
                    var title = page && page.querySelector('.settings-page-title');
                    if (title) {
                        title.setAttribute('tabindex', '-1');
                        if (typeof title.focus === 'function') title.focus();
                    }
                }
            });
            tab.addEventListener('keydown', function (event) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); moveTab(1); }
                else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1); }
                else if (event.key === 'Home') { event.preventDefault(); var t = allTabs(); if (t.length) setActive(pageIdOf(t[0]), { focusTab: true }); }
                else if (event.key === 'End') { event.preventDefault(); var a = allTabs(); if (a.length) setActive(pageIdOf(a[a.length - 1]), { focusTab: true }); }
            });
        });

        Array.prototype.slice.call(panel.querySelectorAll('[data-settings-back]')).forEach(function (button) {
            // 返回目录：窄窗口下回到目录页本身，宽窗口下回到当前分类（导航一直在）。
            button.addEventListener('click', function () {
                if (!confirmLeave('返回分类目录')) return;
                var layout = document.querySelector('.settings-layout');
                if (layout) layout.classList.remove('is-detail');
                var pagesBox = document.querySelector('.settings-pages');
                if (pagesBox) pagesBox.scrollTop = 0;
                var activeTab = document.querySelector('.settings-nav-item.is-active');
                if (activeTab && typeof activeTab.focus === 'function') activeTab.focus();
            });
        });

        captureBaseline();

        // 保存成功后基线前移，避免下次关闭又提示“未保存”。
        var save = document.getElementById('saveSettingsBtn');
        if (save) save.addEventListener('click', function () { setTimeout(captureBaseline, 0); });
    }

    function firstPageId() {
        var pages = allPages();
        return pages.length ? pages[0].getAttribute('data-settings-page') : '';
    }

    // 面板关闭时回到目录态。否则窄窗口下“进详情 → 关闭 → 再打开”会直接落在
    // 上一页详情，看不到要求里的分类目录。
    function resetToDirectory() {
        var layout = document.querySelector('.settings-layout');
        if (layout) layout.classList.remove('is-detail');
    }

    function openInitial() {
        var saved = '';
        try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
        // 打开设置先看到分类目录（窄窗口），宽窗口则直接显示上次的分类详情。
        setActive(saved || firstPageId(), { scrollTop: false, showDetail: false });
        resetToDirectory();
        captureBaseline();
        watchDirtyFields();
    }

    function init() {
        // 笔记主题下 buildCategories 不会被调用（上方已早退），这里再确认一次。
        if (style.isNotebook) return;
        if (!buildCategories()) return;
        bind();
        if (panel) openInitial();
        // 目录摘要要在首次打开时就是真实状态。MaimemoAPI 可能还没加载完，
        // 所以查询失败就稍后再试一次，不引入轮询。
        syncAccountSummary();
        if (!summaryResolved()) setTimeout(syncAccountSummary, 1200);
        // 设置面板每次打开都回到目录态并重新对齐基线：用户可能在别处改过 AI
        // 配置，也可能刚完成授权（目录摘要要跟着变）。
        ['settingsBtn', 'welcomeSettingsBtn'].forEach(function (id) {
            var button = document.getElementById(id);
            if (button) button.addEventListener('click', function () {
                setTimeout(function () { captureBaseline(); resetToDirectory(); syncAccountSummary(); }, 0);
            });
        });
        // 账号状态变化时同步目录摘要，不需要额外轮询。
        window.addEventListener('memo-account-changed', syncAccountSummary);
    }

    window.MemoSettingsNav = {
        init: init,
        syncAccountSummary: syncAccountSummary,
        resetToDirectory: resetToDirectory,
        markSaved: markSaved,
        // 程序化打开设置（如“去配置 AI”）也要回到目录并重对基线。
        prepareOpen: function () { resetToDirectory(); captureBaseline(); syncAccountSummary(); },
        show: setActive,
        current: function () { return currentId; },
        setSummary: setSummary,
        hasUnsavedChanges: hasUnsavedChanges,
        confirmLeave: confirmLeave
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
