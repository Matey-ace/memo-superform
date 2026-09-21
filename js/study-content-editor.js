// 墨墨单词内容编辑器：在背词 iframe 外提供同源的释义 / 助记 CRUD 面板。
// 内容由墨墨开放 API 维护；本模块不读取或保存访问令牌。
const StudyContentEditor = (function() {
    const OWN_KEY = 'memo_content_owned_';

    function apiAvailable() {
        return typeof MaimemoAPI !== 'undefined' && MaimemoAPI &&
            typeof MaimemoAPI.getVocabulary === 'function';
    }

    function profileKey() {
        try {
            const status = typeof MaimemoAPI !== 'undefined' && MaimemoAPI.connectionStatus
                ? MaimemoAPI.connectionStatus()
                : null;
            const profile = status && status.profile_id;
            if (profile) return String(profile).slice(-24);
        } catch (e) {}
        return 'default';
    }

    function ownedIds(kind) {
        try {
            const raw = localStorage.getItem(OWN_KEY + profileKey() + '_' + kind);
            const ids = JSON.parse(raw || '[]');
            return Array.isArray(ids) ? ids.map(String) : [];
        } catch (e) { return []; }
    }

    function rememberOwned(kind, id) {
        if (!id) return;
        const ids = ownedIds(kind);
        const value = String(id);
        if (ids.indexOf(value) >= 0) return;
        ids.push(value);
        try { localStorage.setItem(OWN_KEY + profileKey() + '_' + kind, JSON.stringify(ids.slice(-500))); } catch (e) {}
    }

    function forgetOwned(kind, id) {
        const value = String(id || '');
        const ids = ownedIds(kind).filter(function(item) { return item !== value; });
        try { localStorage.setItem(OWN_KEY + profileKey() + '_' + kind, JSON.stringify(ids)); } catch (e) {}
    }

    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function create(options) {
        options = options || {};
        const container = options.container;
        const iframe = options.iframe;
        const trigger = options.trigger;
        const panel = options.panel;
        const body = panel && panel.querySelector('[data-editor-body]');
        const status = panel && panel.querySelector('[data-editor-status]');
        const wordLabel = panel && panel.querySelector('.study-content-editor-word');
        if (!container || !iframe || !trigger || !panel || !body || !status) return { refresh: function() {}, dispose: function() {} };

        const state = {
            word: '', vocId: '', interpretations: [], notes: [],
            loading: false, saving: false, open: false, error: '',
            form: null, readonly: { interpretation: {}, note: {} }
        };
        let observer = null;
        let poll = 0;
        let disposed = false;

        function currentWord() {
            try { return String((typeof options.getWord === 'function' ? options.getWord() : '') || '').trim(); }
            catch (e) { return ''; }
        }

        function setStatus(message, kind) {
            status.textContent = message || '';
            status.dataset.state = kind || '';
            status.hidden = !message;
        }

        function setOpen(open) {
            state.open = !!open;
            panel.hidden = !state.open;
            panel.setAttribute('aria-hidden', state.open ? 'false' : 'true');
            trigger.setAttribute('aria-expanded', state.open ? 'true' : 'false');
            if (!state.open) {
                state.form = null;
                state.error = '';
                setStatus('', '');
            }
        }

        function refreshTrigger() {
            if (disposed) return;
            const word = currentWord();
            state.word = word;
            trigger.hidden = !word;
            trigger.disabled = !word || state.loading || state.saving;
            trigger.setAttribute('aria-label', word ? '编辑 ' + word + ' 的释义和助记' : '编辑当前单词的释义和助记');
            if (!state.open && wordLabel && wordLabel.textContent !== word) wordLabel.textContent = word;
        }

        function renderEmpty(kind, label) {
            return '<div class="study-content-empty"><span>还没有' + label + '</span>' +
                '<button type="button" class="study-content-link" data-editor-action="new" data-kind="' + kind + '">添加' + label + '</button></div>';
        }

        function renderCards(kind, items, label) {
            if (!items.length) return renderEmpty(kind, label);
            const owned = ownedIds(kind);
            return items.map(function(item) {
                const id = String(item.id || '');
                const isKnownOwned = owned.indexOf(id) >= 0;
                const isReadonly = !!state.readonly[kind][id];
                const text = kind === 'interpretation' ? item.interpretation : item.note;
                const meta = kind === 'interpretation'
                    ? ((item.tags || []).join(' · ') || '无标签')
                    : (item.note_type || '助记');
                const buttons = isReadonly
                    ? '<button type="button" class="study-content-link" data-editor-action="copy" data-kind="' + kind + '" data-id="' + escapeHtml(id) + '">复制到我的内容</button>'
                    : '<button type="button" class="study-content-link" data-editor-action="edit" data-kind="' + kind + '" data-id="' + escapeHtml(id) + '">' + (isKnownOwned ? '编辑' : '编辑/复制') + '</button>' +
                        '<button type="button" class="study-content-link danger" data-editor-action="delete" data-kind="' + kind + '" data-id="' + escapeHtml(id) + '">删除</button>';
                return '<article class="study-content-card ' + (isKnownOwned ? 'is-owned' : 'is-public') + (isReadonly ? ' is-readonly' : '') + '" data-content-kind="' + kind + '" data-content-id="' + escapeHtml(id) + '">' +
                    '<div class="study-content-card-meta"><span>' + escapeHtml(meta) + '</span><em>' + (isKnownOwned ? '我的内容' : '墨墨内容') + '</em></div>' +
                    '<p class="study-content-card-text">' + escapeHtml(text || '暂无内容').replace(/\n/g, '<br>') + '</p>' +
                    '<div class="study-content-card-actions">' + buttons + '</div>' +
                    '</article>';
            }).join('');
        }

        function formHtml(form) {
            const kind = form.kind;
            const isInterpretation = kind === 'interpretation';
            const title = form.mode === 'create' ? '新增' : '编辑';
            const text = isInterpretation ? (form.interpretation || '') : (form.note || '');
            const meta = isInterpretation ? ((form.tags || []).join(', ')) : (form.note_type || '');
            return '<form class="study-content-form" data-editor-form data-kind="' + kind + '">' +
                '<div class="study-content-form-title">' + title + (isInterpretation ? '释义' : '助记') + '</div>' +
                (isInterpretation
                    ? '<label>释义<textarea name="interpretation" rows="4" maxlength="4000" required>' + escapeHtml(text) + '</textarea></label>' +
                        '<label>标签<input name="tags" value="' + escapeHtml(meta) + '" maxlength="500" placeholder="用逗号分隔，可留空"></label>'
                    : '<label>类型<input name="note_type" value="' + escapeHtml(meta) + '" maxlength="80" required placeholder="例如：谐音、词根"></label>' +
                        '<label>助记<textarea name="note" rows="4" maxlength="4000" required>' + escapeHtml(text) + '</textarea></label>') +
                '<div class="study-content-form-actions"><button type="button" class="study-content-link" data-editor-action="cancel-form">取消</button><button type="submit" class="study-content-primary"' + (state.saving ? ' disabled' : '') + '>保存到墨墨</button></div>' +
                '</form>';
        }

        function render() {
            if (!state.open) return;
            wordLabel.textContent = state.word || '当前单词';
            if (state.loading) {
                body.innerHTML = '<div class="study-content-loading">正在读取墨墨内容…</div>';
                return;
            }
            if (state.error) {
                body.innerHTML = '<div class="study-content-error">' + escapeHtml(state.error) + '</div>' +
                    '<button type="button" class="study-content-primary" data-editor-action="reload">重新读取</button>';
                return;
            }
            if (state.form) {
                body.innerHTML = formHtml(state.form);
                const field = body.querySelector('textarea, input');
                if (field) setTimeout(function() { try { field.focus(); } catch (e) {} }, 0);
                return;
            }
            body.innerHTML =
                '<section class="study-content-group"><div class="study-content-group-head"><h3>释义</h3><button type="button" class="study-content-link" data-editor-action="new" data-kind="interpretation">新增</button></div>' +
                    renderCards('interpretation', state.interpretations, '释义') + '</section>' +
                '<section class="study-content-group"><div class="study-content-group-head"><h3>助记</h3><button type="button" class="study-content-link" data-editor-action="new" data-kind="note">新增</button></div>' +
                    renderCards('note', state.notes, '助记') + '</section>';
        }

        async function load(word) {
            const targetWord = String(word || currentWord()).trim();
            if (!targetWord || !apiAvailable()) {
                state.error = apiAvailable() ? '未检测到当前单词。' : '账号接口尚未加载，请刷新页面后重试。';
                state.loading = false;
                render();
                return;
            }
            state.word = targetWord;
            state.loading = true;
            state.error = '';
            state.form = null;
            state.interpretations = [];
            state.notes = [];
            setStatus('正在从墨墨读取公开内容…', 'loading');
            render();
            try {
                const voc = await MaimemoAPI.getVocabulary(targetWord, false);
                const vocId = voc && (voc.voc || voc).id;
                if (!vocId) throw new Error('墨墨没有返回该单词 ID');
                state.vocId = String(vocId);
                const result = await Promise.all([
                    MaimemoAPI.listInterpretations(state.vocId, false),
                    MaimemoAPI.listNotes(state.vocId, false)
                ]);
                state.interpretations = (result[0] && result[0].interpretations) || [];
                state.notes = (result[1] && result[1].notes) || [];
                state.loading = false;
                setStatus('', '');
                render();
            } catch (error) {
                state.loading = false;
                state.error = error && error.message ? error.message : '读取墨墨内容失败';
                setStatus(state.error, 'error');
                render();
            }
        }

        function findItem(kind, id) {
            const list = kind === 'interpretation' ? state.interpretations : state.notes;
            return list.find(function(item) { return String(item.id || '') === String(id || ''); }) || null;
        }

        function openForm(kind, item, copy) {
            const source = item || {};
            state.form = {
                mode: copy || !item ? 'create' : 'update', kind: kind,
                id: copy ? '' : String(source.id || ''),
                interpretation: source.interpretation || '',
                tags: Array.isArray(source.tags) ? source.tags.slice() : [],
                note_type: source.note_type || '', note: source.note || ''
            };
            setStatus(copy ? '已复制内容，请修改后保存。' : '', copy ? 'info' : '');
            render();
        }

        async function saveForm(formElement) {
            if (state.saving) return;
            const kind = formElement.getAttribute('data-kind');
            const data = new FormData(formElement);
            state.saving = true;
            setStatus('正在保存到墨墨…', 'loading');
            formElement.querySelectorAll('input, textarea, button').forEach(function(node) { node.disabled = true; });
            try {
                let result;
                if (kind === 'interpretation') {
                    const text = String(data.get('interpretation') || '').trim();
                    const tags = String(data.get('tags') || '').split(/[,，]/).map(function(value) { return value.trim(); }).filter(Boolean);
                    result = state.form.mode === 'update'
                        ? await MaimemoAPI.updateInterpretation(state.form.id, text, tags)
                        : await MaimemoAPI.createInterpretation(state.vocId, text, tags);
                    const id = result && ((result.interpretation && result.interpretation.id) || result.id);
                    if (id) rememberOwned('interpretation', id);
                } else {
                    const type = String(data.get('note_type') || '').trim();
                    const text = String(data.get('note') || '').trim();
                    result = state.form.mode === 'update'
                        ? await MaimemoAPI.updateNote(state.form.id, type, text)
                        : await MaimemoAPI.createNote(state.vocId, type, text);
                    const id = result && ((result.note && result.note.id) || result.id);
                    if (id) rememberOwned('note', id);
                }
                state.saving = false;
                state.form = null;
                setStatus('已保存，正在刷新内容…', 'success');
                await load(state.word);
            } catch (error) {
                state.saving = false;
                const message = error && error.message ? error.message : '保存失败';
                const permissionDenied = state.form && state.form.id &&
                    (error && error.status === 403 || /403|权限|禁止|无权/.test(message));
                if (permissionDenied) {
                    state.readonly[kind][state.form.id] = true;
                }
                if (permissionDenied) state.form = null;
                setStatus(message + (permissionDenied ? '；该条目可以复制为你的内容。' : ''), 'error');
                render();
            }
        }

        async function remove(kind, id) {
            const item = findItem(kind, id);
            if (!item || state.saving) return;
            if (!window.confirm('确定删除这条' + (kind === 'note' ? '助记' : '释义') + '吗？此操作会同步到墨墨云端。')) return;
            state.saving = true;
            setStatus('正在删除…', 'loading');
            try {
                if (kind === 'note') await MaimemoAPI.deleteNote(id);
                else await MaimemoAPI.deleteInterpretation(id);
                forgetOwned(kind, id);
                state.saving = false;
                await load(state.word);
            } catch (error) {
                state.saving = false;
                const message = error && error.message ? error.message : '删除失败';
                if (error && error.status === 403 || /403|权限|禁止|无权/.test(message)) {
                    state.readonly[kind][String(id)] = true;
                }
                setStatus(message + ((error && error.status === 403) ? '；该条目可以复制为你的内容。' : ''), 'error');
                render();
            }
        }

        body.addEventListener('click', function(event) {
            const button = event.target.closest && event.target.closest('[data-editor-action]');
            if (!button) return;
            event.preventDefault();
            event.stopPropagation();
            const action = button.getAttribute('data-editor-action');
            const kind = button.getAttribute('data-kind');
            const id = button.getAttribute('data-id');
            if (action === 'new') openForm(kind, null, false);
            else if (action === 'edit') openForm(kind, findItem(kind, id), false);
            else if (action === 'copy') openForm(kind, findItem(kind, id), true);
            else if (action === 'delete') remove(kind, id);
            else if (action === 'cancel-form') { state.form = null; setStatus('', ''); render(); }
            else if (action === 'reload') load(state.word);
        });
        body.addEventListener('submit', function(event) {
            const form = event.target.closest && event.target.closest('[data-editor-form]');
            if (!form) return;
            event.preventDefault();
            event.stopPropagation();
            saveForm(form);
        });
        body.addEventListener('keydown', function(event) {
            if (event.key === ' ' || event.code === 'Space') {
                // 编辑器输入必须保留空格，不能冒泡为背词快捷键。
                const editable = event.target && event.target.closest && event.target.closest('input, textarea, [contenteditable]');
                if (editable) event.stopPropagation();
            }
            if (event.key === 'Escape' && !state.saving) {
                event.preventDefault();
                event.stopPropagation();
                if (state.form) { state.form = null; render(); }
                else setOpen(false);
            }
        });
        body.addEventListener('compositionstart', function(event) { event.stopPropagation(); });
        body.addEventListener('compositionend', function(event) { event.stopPropagation(); });
        trigger.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            if (!state.open) { setOpen(true); load(currentWord()); }
        });
        const closeButton = panel.querySelector('[data-close-content-editor]');
        if (closeButton) closeButton.addEventListener('click', function() { if (!state.saving) setOpen(false); });

        function update() {
            const previousWord = state.word;
            const activeWord = currentWord();
            if (state.open && previousWord && (!activeWord || activeWord !== previousWord) && !state.saving) {
                setOpen(false);
            }
            refreshTrigger();
        }
        function startObserver() {
            update();
            clearInterval(poll);
            poll = setInterval(update, 500);
            try {
                const doc = iframe.contentDocument;
                if (doc && doc.documentElement) {
                    if (observer) observer.disconnect();
                    observer = new MutationObserver(update);
                    observer.observe(doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
                }
            } catch (e) {}
        }
        iframe.addEventListener('load', startObserver);
        startObserver();

        return {
            refresh: update,
            dispose: function() {
                disposed = true;
                clearInterval(poll);
                if (observer) observer.disconnect();
                iframe.removeEventListener('load', startObserver);
                setOpen(false);
            }
        };
    }

    return { mount: create };
})();
