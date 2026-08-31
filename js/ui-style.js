// Memo Superform - 统一界面样式引导。
// 本文件刻意不偏向任一视觉主题：在 document body 渲染前只选择一套视觉资源。
(function () {
    'use strict';

    var STORAGE_KEY = 'memo_ui_style';
    // 此缓存标记仅用于本地静态资源失效，不参与应用版本或更新比较。
    var VERSION = '20260831-auto-update';
    var value = 'standard';
    try {
        var saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'notebook') value = 'notebook';
    } catch (e) {}

    var notebook = value === 'notebook';
    document.documentElement.setAttribute('data-ui-style', value);
    document.title = notebook ? 'Memo Superform · Anon的笔记本' : 'Memo Superform - 墨墨数据磁贴';

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
        css('css/live2d-companion.css', 'memo-live2d-companion');
    } else {
        css('css/style.css', 'memo-dashboard-theme');
        css('css/ai-toolbar.css', 'memo-ai-toolbar');
        css('css/drag.css', 'memo-drag');
        css('css/study-web.css', 'memo-study-core');
        css('css/study-web-standard.css', 'memo-study-theme');
        css('css/live2d-companion.css', 'memo-live2d-companion');
    }

    function applyBody(body) {
        if (!body) return;
        body.classList.toggle('notebook-mode', notebook);
        body.classList.toggle('standard-mode', !notebook);
        // Anon 的笔记本采用固定浅色纸张配色。不要覆盖已保存的标准主题偏好；只保证
        // 运行时“笔记本模式”和暗色模式不会同时生效。
        if (notebook) body.classList.remove('dark');
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
            option.textContent = 'Anon的笔记本';
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
