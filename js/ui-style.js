// Memo Superform - unified UI style bootstrap.
// This file is deliberately visual-neutral: it selects exactly one visual
// resource set before the document body is rendered.
(function () {
    'use strict';

    var STORAGE_KEY = 'memo_ui_style';
    var VERSION = '20260825-unified-ui';
    var value = 'standard';
    try {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'notebook') value = 'notebook';
    } catch (e) {}

    var notebook = value === 'notebook';
    document.documentElement.setAttribute('data-ui-style', value);
    document.title = notebook ? 'Memo Superform · anon 笔记本' : 'Memo Superform - 墨墨数据磁贴';

    function css(path, id) {
        document.write('<link rel="stylesheet" id="' + id + '" href="' + path + '?v=' + VERSION + '">');
    }

    if (notebook) {
        css('css/ai-toolbar.css', 'memo-ai-toolbar');
        css('css/drag.css', 'memo-drag');
        css('css/study-web.css', 'memo-study-core');
        css('css/diary.css', 'memo-diary');
        css('css/fonts.css', 'memo-notebook-fonts');
        css('css/style-anon.css', 'memo-dashboard-theme');
        css('css/study-web-notebook.css', 'memo-study-theme');
    } else {
        css('css/style.css', 'memo-dashboard-theme');
        css('css/ai-toolbar.css', 'memo-ai-toolbar');
        css('css/drag.css', 'memo-drag');
        css('css/study-web.css', 'memo-study-core');
        css('css/study-web-standard.css', 'memo-study-theme');
    }

    function applyBody(body) {
        if (!body) return;
        body.classList.toggle('notebook-mode', notebook);
        body.classList.toggle('standard-mode', !notebook);
    }

    function activate(root) {
        applyBody(root.body);
        root.querySelectorAll('[data-notebook-only]').forEach(function (node) {
            node.hidden = !notebook;
        });
        root.querySelectorAll('[data-standard-only]').forEach(function (node) {
            node.hidden = notebook;
        });

        if (!notebook) return;
        root.querySelectorAll('[data-notebook-src]').forEach(function (node) {
            var src = node.getAttribute('data-notebook-src');
            if (src && !node.getAttribute('src')) node.setAttribute('src', src);
        });
        root.querySelectorAll('.chart-selector').forEach(function (select) {
            if (select.querySelector('option[value="diary"]')) return;
            var option = root.createElement('option');
            option.value = 'diary';
            option.textContent = '记忆手账';
            select.appendChild(option);
        });
    }

    window.MemoUIStyle = {
        key: STORAGE_KEY,
        name: value,
        isNotebook: notebook,
        applyBody: applyBody,
        activate: activate,
        save: function (next) {
            var safe = next === 'notebook' ? 'notebook' : 'standard';
            localStorage.setItem(STORAGE_KEY, safe);
            return safe;
        }
    };
})();
