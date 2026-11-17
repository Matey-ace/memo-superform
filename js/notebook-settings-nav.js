// ==========================================
// Memo Superform - Anon的笔记本设置页：分类目录 → 分类详情
// ==========================================
// 目标：笔记本主题下设置不再是一张长页。打开先看到分类目录，进入分类后能
// 明确返回目录；窄窗口在"目录 / 详情"之间切换，宽窗口目录常驻。
//
// 关键约束：
//   · index.html 里的设置面板是普通版和笔记本共用的同一份 DOM，分类结构
//     **不能**写死在 HTML 里。本模块只在笔记本主题下把原有的 setting-group
//     就地分组，普通版根本不会执行到这里（见下方 isNotebook 早退）。
//   · 与 js/standard-settings-nav.js 主题互斥：两边各自早退，同一时刻只有
//     一个模块会定义 window.MemoSettingsNav，app.js 的生命周期契约不变。
//   · 分类页一旦建好就存在，切换只改可见性 —— 不重建 DOM、不重复绑定、
//     不发请求、不重载大资源（语音包、模型库、角色编辑器都保持原状态）。
//   · 只搬运节点，不复制节点：每个设置仍然只有一份，id 不会重复。
//   · 未保存的内容在切换分类 / 返回目录 / 关闭设置前都要提示，不静默丢弃。
(function () {
    'use strict';

    var style = window.MemoUIStyle || {};
    // 普通版由 standard-settings-nav.js 负责；它会在笔记本下早退，这里镜像处理。
    if (!style.isNotebook) return;

    var STORAGE_KEY = 'memo_notebook_settings_last_category';
    var NARROW_MEDIA = '(max-width: 900px)';
    // 需要"保存设置"才生效的字段：关闭或切换前若与其已保存值不同，就要提示。
    // 必须与 app.js 保存处理器实际写入的字段一一对应，漏一个就会静默丢改动。
    var SAVE_FIELDS = ['aiProviderSelect', 'aiEndpointInput', 'aiKeyInput', 'aiModelInput',
        'uiStyleSelect', 'defaultModeSelect'];
    // 只有用户真的 input/change 过才算"脏"；程序回填值不会触发事件，正是我们要的区别。
    var dirtyFields = {};

    var panel = null;
    var layout = null;
    var nav = null;
    var pagesBox = null;
    var cover = null;
    var currentId = '';
    var summaryResolved = false;

    // 分类与原有设置组的对应关系。每个原组恰好出现在一个分类里，
    // 既不新增也不遗漏设置项（组用标题文字识别，见 groupTitleOf）。
    var CATEGORIES = [
        { id: 'account', title: '账号与连接', summary: '墨墨账号连接与一键授权',
          icon: '🔖', accent: 'rose', groups: ['墨墨账号'] },
        { id: 'learning', title: '学习与进度', summary: '学习数据更新、核验与缓存',
          icon: '📖', accent: 'sky', groups: ['数据更新'] },
        { id: 'companion', title: '角色与陪伴', summary: '陪伴模式与 Live2D 模型库',
          icon: '🎀', accent: 'rose', groups: ['陪伴模式', 'Live2D 模型库'] },
        { id: 'voice', title: '语音与音频', summary: '语音包、角色资料与朗读',
          icon: '🎧', accent: 'sky', groups: ['语音功能（GPT-SoVITS 资源包）'] },
        { id: 'ai', title: 'AI 与记忆', summary: 'AI 接口与 Codex 登录',
          icon: '✨', accent: 'rose', groups: ['AI API 配置（可选）'] },
        { id: 'appearance', title: '外观与窗口', summary: '界面风格与启动模式',
          icon: '🖋', accent: 'sky', groups: ['界面风格', '运行模式'] },
        { id: 'maintenance', title: '数据与维护', summary: '软件版本与更新检查',
          icon: '🧰', accent: 'rose', groups: ['软件更新'] }
    ];

    function groupTitleOf(group) {
        var heading = group.querySelector('h3');
        return heading ? heading.textContent.trim() : '';
    }

    function warn(message) {
        if (window.console && typeof console.warn === 'function') {
            console.warn('[notebook-settings] ' + message);
        }
    }

    // 把原来的 9 个设置组搬进 7 个分类页。只移动已有节点，不复制。
    // 任何一组对不上分类、或标题重复导致无法一一对应，都宁可保持长页。
    function buildCategories() {
        var body = document.querySelector('#settingsPanel .settings-body');
        if (!body || body.dataset.notebookSettingsSplit === 'true') return !!body;
        var groups = Array.prototype.slice.call(body.children).filter(function (node) {
            return node.classList && node.classList.contains('setting-group');
        });
        if (!groups.length) return false;

        var byTitle = {};
        var duplicated = [];
        groups.forEach(function (group) {
            var title = groupTitleOf(group);
            if (Object.prototype.hasOwnProperty.call(byTitle, title)) duplicated.push(title);
            byTitle[title] = group;
        });
        if (duplicated.length) {
            warn('设置组标题重复，无法一一分组，保持长页：' + duplicated.join('、'));
            return false;
        }

        var claimed = {};
        CATEGORIES.forEach(function (category) {
            category.groups.forEach(function (title) { claimed[title] = true; });
        });
        var missing = groups.filter(function (group) { return !claimed[groupTitleOf(group)]; });
        if (missing.length) {
            warn('未分类的设置组，保持长页：' + missing.map(groupTitleOf).join('、'));
            return false;
        }

        // 只保留真正有对应设置组的分类：不建空分类，也不丢设置。
        var categories = CATEGORIES.map(function (category) {
            return {
                meta: category,
                groups: category.groups.map(function (title) { return byTitle[title]; })
                    .filter(function (group) { return !!group; })
            };
        }).filter(function (entry) { return entry.groups.length > 0; });
        if (!categories.length) return false;

        var layoutEl = document.createElement('div');
        layoutEl.className = 'settings-layout notebook-settings-layout';

        var navEl = document.createElement('nav');
        navEl.className = 'settings-nav notebook-settings-nav';
        navEl.setAttribute('role', 'tablist');
        navEl.setAttribute('aria-label', '设置分类');
        navEl.setAttribute('aria-orientation', 'vertical');

        var navHeading = document.createElement('p');
        navHeading.className = 'notebook-settings-nav-heading';
        navHeading.textContent = '目录';
        navEl.appendChild(navHeading);

        var pagesEl = document.createElement('div');
        pagesEl.className = 'settings-pages notebook-settings-pages';

        // 宽窗口下"目录常驻"，右侧在没翻页时显示一页纸面封面，而不是空白。
        var coverEl = document.createElement('section');
        coverEl.className = 'notebook-settings-cover';
        coverEl.setAttribute('aria-hidden', 'true');
        var coverKicker = document.createElement('p');
        coverKicker.className = 'notebook-settings-cover-kicker';
        coverKicker.textContent = 'Anon 的笔记本 · 设置';
        var coverTitle = document.createElement('h3');
        coverTitle.className = 'notebook-settings-cover-title';
        coverTitle.textContent = '从左边挑一页翻开';
        var coverText = document.createElement('p');
        coverText.className = 'notebook-settings-cover-text';
        coverText.textContent = '账号、学习、陪伴、语音、AI、外观与维护都记在这里。每一页只放相关的内容，改完记得点底部的「保存设置」。';
        coverEl.appendChild(coverKicker);
        coverEl.appendChild(coverTitle);
        coverEl.appendChild(coverText);
        pagesEl.appendChild(coverEl);

        categories.forEach(function (entry, index) {
            var category = entry.meta;
            var tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'settings-nav-item notebook-settings-nav-item';
            tab.id = 'notebookSettingsTab-' + category.id;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('data-settings-target', category.id);
            tab.setAttribute('data-accent', category.accent || 'rose');
            tab.setAttribute('aria-controls', 'notebookSettingsPage-' + category.id);
            tab.setAttribute('aria-selected', 'false');
            tab.tabIndex = index === 0 ? 0 : -1;

            var badge = document.createElement('span');
            badge.className = 'notebook-settings-nav-icon';
            badge.setAttribute('aria-hidden', 'true');
            badge.textContent = category.icon || '·';
            var tabTitle = document.createElement('span');
            tabTitle.className = 'settings-nav-title notebook-settings-nav-title';
            tabTitle.textContent = category.title;
            var tabSummary = document.createElement('span');
            tabSummary.className = 'settings-nav-summary notebook-settings-nav-summary';
            tabSummary.setAttribute('data-settings-summary', category.id);
            tabSummary.textContent = category.summary;

            var text = document.createElement('span');
            text.className = 'notebook-settings-nav-text';
            text.appendChild(tabTitle);
            text.appendChild(tabSummary);
            tab.appendChild(badge);
            tab.appendChild(text);
            navEl.appendChild(tab);

            var page = document.createElement('section');
            page.className = 'settings-page notebook-settings-page';
            page.id = 'notebookSettingsPage-' + category.id;
            page.setAttribute('role', 'tabpanel');
            page.setAttribute('aria-labelledby', 'notebookSettingsTab-' + category.id);
            page.setAttribute('data-settings-page', category.id);
            page.hidden = true;

            var header = document.createElement('header');
            header.className = 'settings-page-header notebook-settings-page-header';
            var back = document.createElement('button');
            back.type = 'button';
            back.className = 'settings-back notebook-settings-back';
            back.setAttribute('data-settings-back', '');
            var arrow = document.createElement('span');
            arrow.setAttribute('aria-hidden', 'true');
            arrow.textContent = '←';
            back.appendChild(arrow);
            back.appendChild(document.createTextNode(' 全部设置'));
            var heading = document.createElement('h3');
            heading.className = 'settings-page-title notebook-settings-page-title';
            heading.textContent = category.title;
            var summary = document.createElement('p');
            summary.className = 'settings-page-summary notebook-settings-page-summary';
            summary.setAttribute('data-settings-page-summary', category.id);
            summary.textContent = category.summary;
            header.appendChild(back);
            header.appendChild(heading);
            header.appendChild(summary);
            page.appendChild(header);

            // 注意：appendChild 已经把节点移到分类页里了，不能再"清理"一遍 ——
            // 那时 group.parentNode 已经是分类页，再 removeChild 会把设置删掉。
            entry.groups.forEach(function (group) { page.appendChild(group); });
            pagesEl.appendChild(page);
        });

        layoutEl.appendChild(navEl);
        layoutEl.appendChild(pagesEl);
        body.appendChild(layoutEl);
        body.dataset.notebookSettingsSplit = 'true';
        if (panel) panel.classList.add('notebook-settings-split');

        // 搬运后自检：所有原设置组必须仍然在 DOM 里，且各出现一次。
        var placed = pagesEl.querySelectorAll('.settings-page .setting-group').length;
        if (placed !== groups.length) {
            warn('设置组搬运数量不符（' + placed + '/' + groups.length + '），已回退长页');
            body.removeChild(layoutEl);
            body.dataset.notebookSettingsSplit = 'false';
            if (panel) panel.classList.remove('notebook-settings-split');
            return false;
        }
        return true;
    }

    function allPages() {
        return pagesBox ? Array.prototype.slice.call(pagesBox.querySelectorAll('[data-settings-page]')) : [];
    }
    function allTabs() {
        return nav ? Array.prototype.slice.call(nav.querySelectorAll('[data-settings-target]')) : [];
    }
    function isNarrow() {
        return typeof window.matchMedia === 'function' && window.matchMedia(NARROW_MEDIA).matches;
    }
    function firstPageId() {
        var pages = allPages();
        return pages.length ? pages[0].getAttribute('data-settings-page') : '';
    }
    function pageIdOf(tab) {
        return tab ? tab.getAttribute('data-settings-target') : '';
    }

    // 目录里的一句话状态：账号未连接、语音是否就绪之类。等级交给 CSS 上色。
    function setSummary(id, text, level) {
        ['[data-settings-summary="' + id + '"]',
         '[data-settings-page-summary="' + id + '"]'].forEach(function (selector) {
            var node = document.querySelector(selector);
            if (!node) return;
            if (text) node.textContent = text;
            if (level) node.setAttribute('data-state', level);
            else node.removeAttribute('data-state');
        });
    }

    // 账号摘要接真实状态（MaimemoAPI 是 js/api.js 的顶层 const，不是 window 属性）。
    function syncAccountSummary() {
        var api = typeof MaimemoAPI !== 'undefined' ? MaimemoAPI : null;
        var status = null;
        try { status = api && api.connectionStatus ? api.connectionStatus() : null; } catch (e) { status = null; }
        if (!status) return;
        summaryResolved = true;
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

    // 语音摘要只读一次已有状态快照，不发请求、不轮询。
    function syncVoiceSummary() {
        var tts = typeof TTS !== 'undefined' ? TTS : null;
        if (!tts || typeof tts.getStatus !== 'function') return;
        var status = null;
        try { status = tts.getStatus(); } catch (e) { status = null; }
        if (!status || status.loaded === false) return;
        if (!status.pack_ready) setSummary('voice', '还没导入语音包', 'warn');
        else if (status.enabled) setSummary('voice', '语音包就绪 · 朗读已开启', 'ok');
        else setSummary('voice', '语音包就绪 · 朗读未开启', 'warn');
    }

    // AI 摘要读本地配置（同样不发请求）。
    function syncAiSummary() {
        var api = typeof AIAPI !== 'undefined' ? AIAPI : null;
        if (!api || typeof api.getConfig !== 'function') return;
        var cfg = null;
        try { cfg = api.getConfig(); } catch (e) { cfg = null; }
        if (!cfg) return;
        if (cfg.provider === 'codex') setSummary('ai', '使用 Codex 登录', 'ok');
        else if (cfg.apiKey) setSummary('ai', '已配置 · ' + (cfg.model || '自定义模型'), 'ok');
        else setSummary('ai', '还没填写 API Key', 'warn');
    }

    function syncSummaries() {
        syncAccountSummary();
        syncVoiceSummary();
        syncAiSummary();
    }

    // 程序回填或用户保存后，基线必须跟着前移；否则关面板时会误报"还有未保存的改动"。
    function markClean(id) {
        var node = document.getElementById(id);
        if (node) node.dataset.savedNotebookValue = node.value;
        delete dirtyFields[id];
    }

    function savedValue(id) {
        // AI 配置的持久值来自 AIAPI（localStorage），界面风格来自 MemoUIStyle.name。
        // AIAPI 是 js/api.js 里的顶层 const，不挂在 window 上，必须用 typeof 取；
        // 写成 window.AIAPI 会恒为 null，导致"保存成功后仍被拦未保存"。
        if (id === 'uiStyleSelect') return style.name;
        var api = typeof AIAPI !== 'undefined' ? AIAPI : null;
        try {
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
        if (!node) return '';
        return node.dataset.savedNotebookValue !== undefined ? node.dataset.savedNotebookValue : node.value;
    }

    // 只有用户真的动过、且值与已保存/基线值不同，才算"未保存"。
    function hasUnsavedChanges() {
        return SAVE_FIELDS.some(function (id) {
            if (!dirtyFields[id]) return false;
            var node = document.getElementById(id);
            if (!node) return false;
            return String(node.value || '') !== String(savedValue(id) || '');
        });
    }

    // 保存语义不变：只有点"保存设置"才落盘。这里只是把当前值记成新的基线。
    function captureBaseline() {
        SAVE_FIELDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (node) node.dataset.savedNotebookValue = node.value;
        });
        dirtyFields = {};
    }

    // app.js 的保存处理器是同步关闭面板的，靠 setTimeout 前移基线来不及，
    // 所以必须由保存逻辑直接调用这个函数（普通版同名接口同理）。
    function markSaved() {
        captureBaseline();
    }

    // 用户交互才置脏；程序赋值不会触发这些事件，正是我们想要的区别。
    function watchDirtyFields() {
        SAVE_FIELDS.forEach(function (id) {
            var node = document.getElementById(id);
            if (!node || node.dataset.notebookUnsavedWatch === 'true') return;
            node.dataset.notebookUnsavedWatch = 'true';
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

    function layoutInDetail() {
        return !!(layout && layout.classList.contains('is-detail'));
    }

    function scrollTop() {
        if (pagesBox) pagesBox.scrollTop = 0;
        if (nav) nav.scrollTop = 0;
    }

    function focusPageTitle(id) {
        var page = pagesBox && pagesBox.querySelector('[data-settings-page="' + id + '"]');
        var title = page && page.querySelector('.settings-page-title');
        if (!title) return;
        title.setAttribute('tabindex', '-1');
        if (typeof title.focus === 'function') title.focus({ preventScroll: true });
    }

    // 分类切换只改可见性：不重新挂载模型库/语音包/角色编辑器，不发请求。
    function setActive(id, options) {
        options = options || {};
        var pages = allPages();
        var tabs = allTabs();
        if (!pages.length) return;
        var exists = pages.some(function (page) { return page.getAttribute('data-settings-page') === id; });
        if (!exists) id = firstPageId();
        currentId = id;

        var detail = typeof options.detail === 'boolean' ? options.detail : layoutInDetail();
        pages.forEach(function (page) {
            var active = page.getAttribute('data-settings-page') === id;
            page.classList.toggle('is-active', active);
            page.hidden = !(active && detail);
        });
        tabs.forEach(function (tab) {
            var active = pageIdOf(tab) === id;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
            tab.tabIndex = active ? 0 : -1;
        });
        if (layout) layout.classList.toggle('is-detail', detail);
        if (cover) cover.hidden = detail;
        if (options.scrollTop !== false) scrollTop();

        // 记住最后浏览的分类（独立键，绝不与普通版共用），但不改变任何设置值。
        try { localStorage.setItem(STORAGE_KEY, id); } catch (e) {}

        if (detail && options.focusTitle) focusPageTitle(id);
        if (options.focusTab) {
            var activeTab = tabs.filter(function (tab) { return pageIdOf(tab) === id; })[0];
            if (activeTab && typeof activeTab.focus === 'function') activeTab.focus({ preventScroll: true });
        }
    }

    function moveTab(delta) {
        var tabs = allTabs();
        if (!tabs.length) return;
        // 从"当前聚焦的分类"移动，而不是上次选中的那个。
        var anchor = tabs.indexOf(document.activeElement);
        var index = anchor >= 0 ? anchor
            : tabs.findIndex(function (tab) { return pageIdOf(tab) === currentId; });
        if (index < 0) index = 0;
        var next = (index + delta + tabs.length) % tabs.length;
        setActive(pageIdOf(tabs[next]), { focusTab: true });
    }

    // 目录态 = 窄窗口下的第一页；宽窗口下目录常驻，右侧退回纸面封面。
    function resetToDirectory() {
        if (!layout) return;
        layout.classList.remove('is-detail');
        allPages().forEach(function (page) {
            var active = page.getAttribute('data-settings-page') === currentId;
            page.classList.toggle('is-active', active);
            page.hidden = true;
        });
        if (cover) cover.hidden = false;
        scrollTop();
    }

    function openTab(tab) {
        var target = pageIdOf(tab);
        if (!target) return;
        if (target === currentId && layoutInDetail()) {
            setActive(target, { detail: true, scrollTop: false });
            return;
        }
        if (!confirmLeave('切换分类')) return;
        // 窄窗口下点分类 = 进入详情（焦点交给详情页标题，键盘用户不会丢位置）；
        // 宽窗口下目录仍在，焦点留在分类上更自然。
        var narrow = isNarrow();
        setActive(target, { detail: true, focusTitle: narrow });
    }

    function backToDirectory() {
        if (!confirmLeave('返回分类目录')) return;
        resetToDirectory();
        var activeTab = nav && nav.querySelector('.settings-nav-item.is-active');
        if (activeTab && typeof activeTab.focus === 'function') activeTab.focus({ preventScroll: true });
    }

    function bind() {
        panel = document.getElementById('settingsPanel');
        if (!panel || panel.dataset.notebookSettingsNav === 'true') return;
        panel.dataset.notebookSettingsNav = 'true';

        allTabs().forEach(function (tab) {
            tab.addEventListener('click', function () { openTab(tab); });
            tab.addEventListener('keydown', function (event) {
                if (event.key === 'ArrowDown' || event.key === 'ArrowRight') { event.preventDefault(); moveTab(1); }
                else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') { event.preventDefault(); moveTab(-1); }
                else if (event.key === 'Home') {
                    event.preventDefault();
                    var first = allTabs()[0];
                    if (first) setActive(pageIdOf(first), { focusTab: true });
                } else if (event.key === 'End') {
                    event.preventDefault();
                    var tabs = allTabs();
                    if (tabs.length) setActive(pageIdOf(tabs[tabs.length - 1]), { focusTab: true });
                }
            });
        });

        Array.prototype.slice.call(panel.querySelectorAll('[data-settings-back]')).forEach(function (button) {
            button.addEventListener('click', backToDirectory);
        });

        captureBaseline();
        watchDirtyFields();
    }

    function rememberedCategory() {
        var saved = '';
        try { saved = localStorage.getItem(STORAGE_KEY) || ''; } catch (e) {}
        return saved;
    }

    function init() {
        // 笔记主题下的第二次确认：普通版已经早退，这里再防一次重复初始化。
        if (!(window.MemoUIStyle && window.MemoUIStyle.isNotebook)) return;
        if (!buildCategories()) return;
        layout = document.querySelector('#settingsPanel .settings-layout');
        nav = layout ? layout.querySelector('.settings-nav') : null;
        pagesBox = layout ? layout.querySelector('.settings-pages') : null;
        cover = layout ? layout.querySelector('.notebook-settings-cover') : null;
        if (!layout) return;
        bind();
        if (!layout) return;

        // 打开设置先看到目录：只高亮上次的分类，不直接翻到它的详情页。
        setActive(rememberedCategory() || firstPageId(), { detail: false, scrollTop: false });
        resetToDirectory();
        captureBaseline();
        watchDirtyFields();
        syncSummaries();

        // 设置面板每次打开都回到目录态并重新对齐基线：用户可能在别处改过 AI
        // 配置，也可能刚完成授权（目录摘要要跟着变）。
        ['settingsBtn', 'welcomeSettingsBtn'].forEach(function (id) {
            var button = document.getElementById(id);
            if (button) button.addEventListener('click', function () {
                setTimeout(function () { prepareOpen(); }, 0);
            });
        });
        // 账号状态变化时同步目录摘要，不需要额外轮询。
        window.addEventListener('memo-account-changed', syncAccountSummary);
        // 窗口从窄变宽（或反过来）时，详情/目录的可见性由 CSS 接管，这里只需
        // 保证"宽窗口目录常驻"成立，不额外改动状态。
    }

    // 程序化打开设置（如"去配置 AI"）时也要回到目录并重对基线、刷新摘要。
    function prepareOpen() {
        resetToDirectory();
        captureBaseline();
        watchDirtyFields();
        syncSummaries();
    }

    window.MemoSettingsNav = {
        init: init,
        syncAccountSummary: syncAccountSummary,
        resetToDirectory: resetToDirectory,
        markSaved: markSaved,
        prepareOpen: prepareOpen,
        show: setActive,
        current: function () { return currentId; },
        setSummary: setSummary,
        hasUnsavedChanges: hasUnsavedChanges,
        confirmLeave: confirmLeave
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
})();
