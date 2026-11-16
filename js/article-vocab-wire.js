/**
 * 文章选词的入口接线：把 `ArticleVocab` 模块接到实际页面元素与后端路由上。
 *
 * 这一层刻意很薄，只做四件事：
 * 1. 提供一个用户能点到的入口（仪表盘工具栏按钮 + 浮层容器）。
 * 2. 把 `requestSelect/requestAi/requestQuery/requestAdd` 接到 `/api/article-vocab/*`。
 * 3. 处理"没配置 AI Key"这种用户可自行解决的前置条件，给出准确提示。
 * 4. 关闭时销毁实例，不留监听与定时器（模块自身在 mount 前不干活）。
 *
 * 不在这里做的事（都有明确归属，避免重复）：
 * - 不做选词逻辑 → `js/article-vocab.js`
 * - 不做官方接口调用 → `server.py` 代理 + `official_vocab_api.py`
 * - 不做云端写入判定 → `app_api.py`（confirm / 账号代次 / 幂等都在后端）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ArticleVocabUI = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // UMD 的外层 `root` 参数不会传进 factory，所以这里自己取一次全局。
    // 少了这一行，"打开面板"时 `root.ArticleVocab` 会抛 ReferenceError。
    var globalScope = (typeof self !== 'undefined' && self) ||
        (typeof window !== 'undefined' && window) || {};

    var instance = null;
    var overlay = null;

    function postJSON(url, payload) {
        return fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                // 本地写接口要求这个头（server.py 的 _local_mutation_allowed）。
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: JSON.stringify(payload || {})
        }).then(function (response) {
            return response.json().catch(function () { return {}; }).then(function (data) {
                if (!response.ok) {
                    var error = new Error(data.error || ('请求失败：' + response.status));
                    error.code = data.code;
                    error.status = response.status;
                    error.uncertain = !!data.uncertain;
                    error.retryable = !!data.retryable;
                    error.payload = data;
                    throw error;
                }
                return data;
            });
        });
    }

    function aiConfig() {
        // 复用项目既有的 AI 配置（js/api.js 也读这两个键），不另建一套设置。
        var provider = (localStorage.getItem('ai_provider') || '').trim();
        var endpoint = (localStorage.getItem('ai_endpoint') || 'https://api.deepseek.com/v1').trim();
        var apiKey = (localStorage.getItem('ai_key') || '').trim();
        return { provider: provider, endpoint: endpoint, apiKey: apiKey };
    }

    /**
     * 一次选词请求的 AI 调用。
     *
     * 关键：带 `noMemory: true`。文章选词是结构化任务，陪伴角色的人设会改变
     * 模型语气并污染 JSON 形状，因此必须隔离角色记忆（见 server.py 的该分支）。
     * 这里也强制 `stream: false` 与较低温度，让输出尽量稳定可解析。
     */
    function requestAi(payload) {
        var config = aiConfig();
        if (config.provider !== 'codex' && !config.apiKey) {
            var missing = new Error('请先在设置中配置 AI API Key，再使用文章选词');
            missing.code = 'missing_ai_key';
            return Promise.reject(missing);
        }
        // 三步编排都在这一层完成，模块只接收"已校验的候选"：
        //   1. /select   构造提示词（只读，不写云端）
        //   2. /proxy/ai 调模型（noMemory，隔离角色记忆）
        //   3. /parse    用原文校验 AI 输出（丢弃编造语境的条目）
        // 第 3 步不可省：它是唯一能防"模型编造原文证据"的地方。
        var article = payload.text;
        var wordCount = payload.word_count;
        return postJSON('/api/article-vocab/select', {
            article: article,
            targetLevel: payload.target_level || '',
            purpose: payload.purpose || '',
            wordCount: wordCount
        }).then(function (prompt) {
            if (!prompt.messages) {
                var badPrompt = new Error('选词服务未返回提示词');
                badPrompt.code = 'bad_payload';
                throw badPrompt;
            }
            return postJSON('/proxy/ai', {
                provider: config.provider,
                endpoint: config.endpoint,
                apiKey: config.apiKey,
                noMemory: true,
                body: {
                    model: localStorage.getItem('ai_model') || 'deepseek-chat',
                    messages: prompt.messages,
                    temperature: 0.2,
                    stream: false
                }
            }).then(function (data) {
                var choice = data && data.choices && data.choices[0];
                var text = choice && choice.message && choice.message.content;
                if (!text) {
                    var empty = new Error('AI 没有返回可用内容，请重试');
                    empty.code = 'empty_ai_reply';
                    throw empty;
                }
                return postJSON('/api/article-vocab/parse', {
                    article: article, raw: text, wordCount: wordCount
                });
            });
        }).then(function (parsed) {
            // 透传 truncated，让界面能说明"文章被截断"，而不是假装全文都分析过。
            return {
                items: parsed.items || [],
                rejected: parsed.rejected || [],
                truncated: !!parsed.truncated
            };
        });
    }

    function ensureOverlay() {
        if (overlay) return overlay;
        overlay = document.createElement('div');
        overlay.className = 'article-vocab-overlay';
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');
        overlay.hidden = true;
        overlay.innerHTML =
            '<div class="article-vocab-overlay__panel">' +
            '  <button type="button" class="article-vocab-overlay__close"' +
            '          data-testid="article-vocab-close" aria-label="关闭文章选词">&times;</button>' +
            '  <div class="article-vocab-overlay__body" data-article-vocab-host></div>' +
            '</div>';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', function (event) {
            if (event.target === overlay) close();
        });
        overlay.querySelector('[data-testid="article-vocab-close"]')
            .addEventListener('click', close);
        return overlay;
    }

    function close() {
        if (!overlay) return;
        overlay.hidden = true;
        if (instance && typeof instance.destroy === 'function') instance.destroy();
        instance = null;
    }

    function open() {
        if (typeof globalScope.ArticleVocab === 'undefined') return;
        ensureOverlay();
        overlay.hidden = false;
        if (instance) return;
        var host = overlay.querySelector('[data-article-vocab-host]');
        instance = globalScope.ArticleVocab.create({
            requestAi: requestAi,
            requestQuery: function (payload) {
                // 只查 ID：绝不在这里写云端。
                return postJSON('/api/article-vocab/query-ids', {
                    lemmas: payload.spellings || payload.lemmas || []
                });
            },
            requestAdd: function (payload) {
                // 唯一的云端写入。
                //
                // 字段名必须与 `js/article-vocab.js` 的 submit() 实际发出的形状对齐
                // （那里是 `operation_id` / `items[]`，早期这里读 `operationId` /
                // `lemmas` 全部恒为 undefined → 后端 400 empty/缺少 operationId）。
                // 有 voc_id 的先用上，没有的让服务端自己查，绝不凭空编造 id。
                var items = Array.isArray(payload.items) ? payload.items : [];
                var lemmas = items.map(function (item) {
                    return String((item && item.lemma) || '');
                }).filter(function (value) { return value !== ''; });
                return postJSON('/api/article-vocab/add', {
                    confirm: payload.confirm === true,
                    operationId: String(payload.operation_id || ''),
                    lemmas: lemmas,
                    advance: false,
                    // 优先用模块自带的代次；没有就用打开面板时从 /status 取到的。
                    account_epoch: typeof payload.account_epoch === 'number'
                        ? payload.account_epoch
                        : (instance && typeof instance.__accountEpoch === 'number'
                            ? instance.__accountEpoch : undefined)
                });
            }
        });
        // 取一次账号代次随提交上传：服务端用它判断"查 ID 之后、写入之前"
        // 有没有切号。拿不到就不传，服务端写入前仍会二次核对。
        return postJSON('/api/article-vocab/status', {}).then(function (status) {
            if (instance && status && typeof status.account_epoch === 'number') {
                instance.__accountEpoch = status.account_epoch;
            }
            if (instance && typeof instance.mount === 'function') instance.mount(host);
            if (instance && typeof instance.start === 'function') instance.start();
        }, function () {
            if (instance && typeof instance.mount === 'function') instance.mount(host);
            if (instance && typeof instance.start === 'function') instance.start();
        });
    }

    function bindEntry() {
        var button = document.getElementById('articleVocabBtn');
        if (!button || button.dataset.ready) return;
        button.dataset.ready = 'true';
        button.addEventListener('click', open);
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && overlay && !overlay.hidden) close();
        });
    }

    function init() {
        bindEntry();
    }

    return {
        init: init,
        open: open,
        close: close,
        requestAi: requestAi,
        // 测试用：不创建真实 DOM 也能验证 AI 请求体是否带了 noMemory。
        _aiConfig: aiConfig
    };
}));