// Memo Superform - Live2D companion learning mode.
// This module keeps study events local and only asks the configured AI at
// deliberate learning milestones.  It never changes StudyWeb's answer flow.

const Live2DModelManager = (function() {
    let currentModels = [];
    let preference = { active_model_id: null, companion_enabled: false };
    let activeJob = null;

    function headers(json) {
        const result = { 'X-Requested-With': 'XMLHttpRequest' };
        const token = (typeof MaimemoAPI !== 'undefined' && MaimemoAPI.getToken) ? MaimemoAPI.getToken() : '';
        if (token) result.Authorization = 'Bearer ' + token;
        if (json) result['Content-Type'] = 'application/json';
        return result;
    }
    async function request(path, options) {
        const response = await fetch(path, Object.assign({ headers: headers(false) }, options || {}));
        const data = await response.json().catch(function() { return {}; });
        if (!response.ok || data.error) throw new Error(data.error || ('请求失败: ' + response.status));
        return data;
    }
    async function loadModels() {
        const data = await request('/api/live2d/models');
        currentModels = data.models || [];
        preference = data.preference || preference;
        renderSettings();
        return data;
    }
    async function searchCatalog(query, refresh) {
        const suffix = '?q=' + encodeURIComponent(query || '') + (refresh ? '&refresh=1' : '');
        const data = await request('/api/live2d/catalog' + suffix);
        const box = document.getElementById('live2dCatalogResults');
        if (!box) return data;
        box.innerHTML = (data.models || []).slice(0, 80).map(function(item) {
            return '<div class="live2d-catalog-row"><span><strong>' + escape(item.character_name) + '</strong><small>' + escape(item.catalog_name) + '</small></span>' +
                   '<button type="button" class="test-btn" data-live2d-download="' + escapeAttr(item.catalog_name) + '">下载</button></div>';
        }).join('') || '<p class="hint">没有匹配的可下载模型。</p>';
        box.querySelectorAll('[data-live2d-download]').forEach(function(button) {
            button.addEventListener('click', function() { startDownload(button.getAttribute('data-live2d-download')); });
        });
        return data;
    }
    function escape(text) { const el = document.createElement('span'); el.textContent = String(text || ''); return el.innerHTML; }
    function escapeAttr(text) { return escape(text).replace(/"/g, '&quot;'); }
    async function startDownload(catalogName) {
        try {
            const job = await request('/api/live2d/download', { method: 'POST', headers: headers(true), body: JSON.stringify({ catalog_name: catalogName }) });
            activeJob = job;
            renderDownloadStatus();
            pollDownload(job.job_id);
        } catch (error) { setStatus(error.message, true); }
    }
    async function pollDownload(jobId) {
        if (!jobId) return;
        try {
            const job = await request('/api/live2d/downloads/' + encodeURIComponent(jobId));
            activeJob = job;
            renderDownloadStatus();
            if (job.status === 'queued' || job.status === 'fetching') {
                setTimeout(function() { pollDownload(jobId); }, 700);
            } else if (job.status === 'completed') {
                setStatus('模型下载完成，可以设为当前陪伴。');
                activeJob = null;
                await loadModels();
            } else if (job.status !== 'unknown') {
                setStatus(job.error || '模型下载未完成。', true);
                activeJob = null;
            }
        } catch (error) { setStatus(error.message, true); }
    }
    async function cancelDownload() {
        if (!activeJob || !activeJob.job_id) return;
        try { activeJob = await request('/api/live2d/downloads/' + encodeURIComponent(activeJob.job_id), { method: 'DELETE', headers: headers(false) }); renderDownloadStatus(); }
        catch (error) { setStatus(error.message, true); }
    }
    async function importDirectory() {
        const field = document.getElementById('live2dImportPath');
        const sourcePath = field && field.value.trim();
        if (!sourcePath) { setStatus('请输入本地 Live2D 模型文件夹路径。', true); return; }
        try {
            await request('/api/live2d/import', { method: 'POST', headers: headers(true), body: JSON.stringify({ source_path: sourcePath }) });
            setStatus('模型已复制并完成校验。');
            if (field) field.value = '';
            await loadModels();
        } catch (error) { setStatus(error.message, true); }
    }
    async function selectModel(modelId) {
        try {
            preference = await request('/api/live2d/active', { method: 'POST', headers: headers(true), body: JSON.stringify({ model_id: modelId || null, companion_enabled: true }) });
            await loadModels();
            if (window.Live2DCompanion) Live2DCompanion.reloadModel();
        } catch (error) { setStatus(error.message, true); }
    }
    async function removeModel(modelId) {
        try {
            await request('/api/live2d/models/' + encodeURIComponent(modelId), { method: 'DELETE', headers: headers(false) });
            await loadModels();
            if (window.Live2DCompanion) Live2DCompanion.reloadModel();
        } catch (error) { setStatus(error.message, true); }
    }
    function setStatus(message, isError) {
        const target = document.getElementById('live2dModelStatus');
        if (!target) return;
        target.textContent = message || '';
        target.classList.toggle('error', !!isError);
    }
    function renderDownloadStatus() {
        const target = document.getElementById('live2dDownloadStatus');
        const cancel = document.getElementById('live2dCancelDownloadBtn');
        if (!target) return;
        if (!activeJob || activeJob.status === 'unknown') { target.textContent = ''; if (cancel) cancel.hidden = true; return; }
        target.textContent = activeJob.status === 'fetching' ? ('正在下载 ' + activeJob.model_name + '：' + activeJob.completed + '/' + activeJob.total) : ('下载状态：' + activeJob.status);
        if (cancel) cancel.hidden = activeJob.status !== 'queued' && activeJob.status !== 'fetching';
    }
    function renderSettings() {
        const list = document.getElementById('live2dInstalledModels');
        if (!list) return;
        list.innerHTML = currentModels.map(function(item) {
            const active = item.model_id === preference.active_model_id;
            return '<div class="live2d-installed-row' + (active ? ' active' : '') + '"><span><strong>' + escape(item.display_name) + '</strong><small>' + escape(item.model_format) + ' · ' + Math.round((item.byte_size || 0) / 1024 / 1024) + ' MB</small></span>' +
                '<span><button type="button" class="test-btn" data-live2d-select="' + escapeAttr(item.model_id) + '">' + (active ? '当前使用' : '使用') + '</button><button type="button" class="danger-btn" data-live2d-remove="' + escapeAttr(item.model_id) + '">删除</button></span></div>';
        }).join('') || '<p class="hint">尚未安装模型；可搜索下载或导入本地文件夹。</p>';
        list.querySelectorAll('[data-live2d-select]').forEach(function(button) { button.addEventListener('click', function() { selectModel(button.getAttribute('data-live2d-select')); }); });
        list.querySelectorAll('[data-live2d-remove]').forEach(function(button) { button.addEventListener('click', function() { removeModel(button.getAttribute('data-live2d-remove')); }); });
    }
    function attachSettings() {
        const search = document.getElementById('live2dCatalogSearch');
        const refresh = document.getElementById('live2dCatalogRefreshBtn');
        const importBtn = document.getElementById('live2dImportBtn');
        const cancel = document.getElementById('live2dCancelDownloadBtn');
        if (!search || search.dataset.live2dReady) return;
        search.dataset.live2dReady = 'true';
        let timer = 0;
        search.addEventListener('input', function() { clearTimeout(timer); timer = setTimeout(function() { searchCatalog(search.value); }, 280); });
        refresh.addEventListener('click', function() { searchCatalog(search.value, true); });
        importBtn.addEventListener('click', importDirectory);
        cancel.addEventListener('click', cancelDownload);
        loadModels().catch(function(error) { setStatus(error.message, true); });
    }
    function current() { return currentModels.find(function(item) { return item.model_id === preference.active_model_id; }) || null; }
    return { attachSettings: attachSettings, loadModels: loadModels, searchCatalog: searchCatalog, current: current, selectModel: selectModel };
})();

const CompanionSession = (function() {
    const POSITIVE = { FAMILIAR: true, WELL_FAMILIAR: true };
    function create(onSignal) {
        let active = false, startedAt = 0, records = [], currentWord = '', lastPromptAt = 0, timedPrompted = false;
        function emit(kind, force) {
            const now = Date.now();
            if (!force && now - lastPromptAt < 90000) return;
            lastPromptAt = now;
            if (onSignal) onSignal(kind, summary());
        }
        function summary() {
            const correct = records.filter(function(row) { return POSITIVE[row.action]; }).length;
            const weak = records.filter(function(row) { return !POSITIVE[row.action]; }).length;
            return { count: records.length, correct: correct, weak: weak, accuracy: records.length ? Math.round(correct * 100 / records.length) : 0,
                     elapsed_minutes: startedAt ? Math.max(1, Math.floor((Date.now() - startedAt) / 60000)) : 0,
                     current_word: currentWord || '', last_action: records.length ? records[records.length - 1].action : '' };
        }
        return {
            screen: function(isStudy) {
                if (isStudy && !active) { active = true; startedAt = Date.now(); records = []; currentWord = ''; timedPrompted = false; if (onSignal) onSignal('started', summary()); }
                if (!isStudy && active) { if (records.length) emit('finish', true); active = false; }
            },
            record: function(event) {
                if (!active || !event || !event.action) return;
                currentWord = event.word || currentWord;
                records.push({ action: event.action, at: Date.now(), word: currentWord });
                const lastThree = records.slice(-3);
                if (records.length === 5 || (records.length > 5 && records.length % 10 === 0)) emit('milestone');
                else if (lastThree.length === 3 && lastThree.every(function(row) { return !POSITIVE[row.action]; })) emit('needs-help');
                else if (onSignal) onSignal('state', summary());
            },
            tick: function() {
                if (active && !timedPrompted && records.length >= 8 && Date.now() - startedAt >= 12 * 60 * 1000) { timedPrompted = true; emit('focus-time'); }
                if (active && onSignal) onSignal('state', summary());
            },
            ask: function() { if (active) emit('manual', true); else if (onSignal) onSignal('manual-empty', summary()); },
            isActive: function() { return active; }, summary: summary
        };
    }
    return { create: create };
})();

const Live2DCompanion = (function() {
    let studyInstance = null, liveModel = null, pixiApp = null, session = null, savedLayout = 'single', open = false, birthdayShown = false;
    let rendererGeneration = 0, rendererRetryTimer = 0, modelNaturalWidth = 0, modelNaturalHeight = 0, rendererLoading = false, rendererFitPending = false, lastTouchAt = 0, lastTouchAIAt = 0;
    const LOCAL_LINES = {
        started: ['准备好了！我们慢慢来。', '今天也一起把这些词拿下吧。'], state: ['这一题记下来就很好。', '保持节奏，下一题继续。'], milestone: ['这一组完成得很漂亮！', '进度又向前走了一步！'],
        'needs-help': ['没关系，先把容易混淆的地方记下来。', '卡住也正常，我们调整一下节奏。'], 'focus-time': ['已经专心学习一会儿了，喝口水再继续吧。'], finish: ['这一轮辛苦了，今天的积累很扎实。'], 'manual-empty': ['先进入背词学习页，我就能看到这一轮的进度。']
    };
    const MOOD_LABELS = { idle: '待机', thinking: '思考', cheer: '开心', comfort: '安慰', shy: '害羞', firm: '生气', celebrate: '庆祝' };
    const TOUCH_REACTIONS = {
        head: { label: '摸头', mood: 'cheer', part: '头部', state: '被摸头后很开心、很有精神', lines: ['嘿嘿，摸头会让我更有精神！下一题也一起拿下吧。', '收到鼓励！这题我们稳稳地记住。'] },
        hand: { label: '击掌', mood: 'celebrate', part: '手部', state: '被击掌后干劲十足', lines: ['击掌！保持这个节奏继续冲。', '配合得不错，下一题继续。'] },
        body: { label: '害羞', mood: 'shy', part: '胸部和腹部', state: '被碰到后有点害羞', lines: ['呀……被碰到会有点害羞，先专心看下一个单词啦。', '别、别盯着看……我们把这一题背完再说。'] },
        lower: { label: '住手！', mood: 'firm', part: '下体位置', state: '被碰到后有些不高兴、想让你专心背词', lines: ['喂！那里不能乱碰，专心背词！', '生气啦！先把这一题背完再闹。'] }
    };
    function setMoodLabel(mood) {
        const state = document.getElementById('companionMood');
        if (state) state.textContent = MOOD_LABELS[mood] || mood || '待机';
    }
    function setMessage(text, mood) {
        const bubble = document.getElementById('companionBubble');
        if (bubble) bubble.textContent = text;
        setMoodLabel(mood);
        playMood(mood || 'idle');
    }
    function setReply(text, mood) {
        const bubble = document.getElementById('companionBubble');
        if (bubble) bubble.textContent = text;
        setMoodLabel(mood);
    }
    function randomLine(kind) { const lines = LOCAL_LINES[kind] || LOCAL_LINES.state; return lines[Math.floor(Math.random() * lines.length)]; }
    function updateSummary(summary) {
        const target = document.getElementById('companionSummary');
        if (!target) return;
        target.innerHTML = '<span>本轮 <b>' + summary.count + '</b> 词</span><span>正确率 <b>' + summary.accuracy + '%</b></span><span>专注 <b>' + summary.elapsed_minutes + '</b> 分钟</span>';
        const word = document.getElementById('companionCurrentWord');
        if (word) word.textContent = summary.current_word ? ('当前单词：' + summary.current_word) : '等待进入学习页';
    }
    async function askAI(kind, summary) {
        updateSummary(summary);
        if (typeof AIAPI === 'undefined' || !AIAPI.hasConfig()) { setMessage(randomLine(kind), kind === 'needs-help' ? '安慰' : '鼓励'); return; }
        const button = document.getElementById('companionAskBtn');
        if (button) button.disabled = true;
        try {
            const config = AIAPI.getConfig();
            const prompt = '学习会话摘要：本轮已答 ' + summary.count + ' 个；正确 ' + summary.correct + ' 个；需要巩固 ' + summary.weak + ' 个；正确率 ' + summary.accuracy + '%；已学习 ' + summary.elapsed_minutes + ' 分钟；当前单词为 "' + (summary.current_word || '未知') + '"；最近判断为 ' + (summary.last_action || '无') + '。\n请用开朗、真诚、不过分打扰学习的中文写一句 36 字以内鼓励，并仅输出 JSON：{"text":"...","mood":"idle|thinking|cheer|comfort|celebrate"}。';
            const response = await fetch('/proxy/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey, body: { model: config.model, messages: [{ role: 'system', content: '你是专注于学习鼓励的陪伴角色。只输出约定 JSON。' }, { role: 'user', content: prompt }], temperature: 0.7, response_format: { type: 'json_object' } } }) });
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || 'AI 暂时不可用');
            const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            const parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]);
            const moods = ['idle', 'thinking', 'cheer', 'comfort', 'celebrate'];
            setMessage(String(parsed.text || randomLine(kind)).slice(0, 80), moods.indexOf(parsed.mood) >= 0 ? parsed.mood : 'cheer');
        } catch (error) { setMessage(randomLine(kind), kind === 'needs-help' ? 'comfort' : 'cheer'); }
        finally { if (button) button.disabled = false; }
    }
    function onSessionSignal(kind, summary) {
        updateSummary(summary);
        if (kind === 'milestone' && isAnonBirthday()) showBirthdayCard();
        if (kind === 'state' || kind === 'started') { setMessage(kind === 'started' ? '进入学习页后，我会陪着你记录这一轮。' : randomLine('state'), 'thinking'); return; }
        askAI(kind, summary);
    }
    function disposeRenderer() {
        if (liveModel && liveModel.destroy) { try { liveModel.destroy({ children: true }); } catch (e) {} }
        liveModel = null;
        if (pixiApp && pixiApp.destroy) { try { pixiApp.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (e) {} }
        pixiApp = null;
        modelNaturalWidth = 0;
        modelNaturalHeight = 0;
    }
    function destroyRenderer() {
        rendererGeneration += 1;
        clearTimeout(rendererRetryTimer);
        rendererLoading = false;
        rendererFitPending = false;
        disposeRenderer();
    }
    function fitLiveModel() {
        const host = document.getElementById('companionLive2DHost');
        if (!host || !liveModel || !pixiApp) return false;
        const width = Math.round(host.clientWidth || 0), height = Math.round(host.clientHeight || 0);
        if (width < 32 || height < 32 || !modelNaturalWidth || !modelNaturalHeight) return false;
        try {
            if (pixiApp.renderer && pixiApp.renderer.resize) pixiApp.renderer.resize(width, height);
            const scale = Math.min(width / modelNaturalWidth * 0.92, height / modelNaturalHeight * 0.92);
            if (!isFinite(scale) || scale <= 0) return false;
            liveModel.scale.set(scale);
            liveModel.x = width / 2;
            liveModel.y = height * 0.96;
            return true;
        } catch (e) { return false; }
    }
    function scheduleRendererReload(delay) {
        clearTimeout(rendererRetryTimer);
        rendererRetryTimer = setTimeout(function() {
            if (!open) return;
            if (rendererLoading) { rendererFitPending = true; return; }
            if (!fitLiveModel()) loadRenderer();
        }, delay || 180);
    }
    async function loadRenderer() {
        if (rendererLoading) { rendererFitPending = true; return; }
        rendererLoading = true;
        const generation = ++rendererGeneration;
        disposeRenderer();
        const host = document.getElementById('companionLive2DHost');
        const fallback = document.getElementById('companionGifFallback');
        if (!host) { rendererLoading = false; return; }
        if (fallback) fallback.hidden = false;
        const model = Live2DModelManager.current();
        const tag = document.getElementById('companionModelName');
        if (tag) tag.textContent = model ? model.display_name : '尚未选择模型';
        if (!model || !window.PIXI || !PIXI.live2d || !PIXI.live2d.Live2DModel) { if (fallback) fallback.hidden = false; rendererLoading = false; return; }
        const canvas = document.getElementById('companionLive2DCanvas');
        const width = Math.round(host.clientWidth || 0), height = Math.round(host.clientHeight || 0);
        if (!canvas || width < 32 || height < 32) { rendererLoading = false; scheduleRendererReload(180); return; }
        let nextApp = null, nextModel = null;
        try {
            nextApp = new PIXI.Application({ view: canvas, width: width, height: height, backgroundAlpha: 0, autoDensity: true, antialias: true });
            const url = '/api/live2d/assets/' + encodeURIComponent(model.model_id) + '/' + model.entry_file.split('/').map(encodeURIComponent).join('/');
            nextModel = await PIXI.live2d.Live2DModel.from(url, { autoInteract: true });
            if (generation !== rendererGeneration || !open) {
                if (nextModel.destroy) nextModel.destroy({ children: true });
                if (nextApp.destroy) nextApp.destroy(true, { children: true, texture: true, baseTexture: true });
                return;
            }
            liveModel = nextModel;
            pixiApp = nextApp;
            modelNaturalWidth = Math.max(liveModel.width, 1);
            modelNaturalHeight = Math.max(liveModel.height, 1);
            liveModel.anchor.set(0.5, 1);
            pixiApp.stage.addChild(liveModel);
            if (!fitLiveModel()) { disposeRenderer(); scheduleRendererReload(180); return; }
            if (fallback) fallback.hidden = true;
            playMood('idle');
        } catch (error) {
            if (generation !== rendererGeneration) {
                if (nextModel && nextModel.destroy) { try { nextModel.destroy({ children: true }); } catch (e) {} }
                if (nextApp && nextApp.destroy) { try { nextApp.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (e) {} }
                return;
            }
            if (nextModel && nextModel.destroy) { try { nextModel.destroy({ children: true }); } catch (e) {} }
            if (nextApp && nextApp.destroy) { try { nextApp.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (e) {} }
            disposeRenderer();
            if (fallback) fallback.hidden = false;
            setMessage('模型暂时无法预览，已切换为备用陪伴图。', '待机');
        } finally {
            if (generation === rendererGeneration) {
                rendererLoading = false;
                if (rendererFitPending) { rendererFitPending = false; scheduleRendererReload(0); }
            }
        }
    }
    function playMood(mood) {
        if (!liveModel || !liveModel.motion) return;
        const candidates = { idle: ['idle', 'nf', 'nnf'], thinking: ['thinking', 'serious'], cheer: ['smile', 'wink', 'kime'], comfort: ['sad', 'shame', 'cry'], shy: ['shame', 'sad', 'cry'], firm: ['angry', 'serious'], celebrate: ['kandou', 'smile', 'gacha'] }[mood] || ['idle'];
        candidates.some(function(name) { try { liveModel.motion(name); return true; } catch (e) { return false; } });
    }
    function randomTouchLine(region) {
        const lines = (TOUCH_REACTIONS[region] || TOUCH_REACTIONS.lower).lines;
        return lines[Math.floor(Math.random() * lines.length)];
    }
    async function askTouchAI(region) {
        const reaction = TOUCH_REACTIONS[region] || TOUCH_REACTIONS.lower;
        // React immediately so the touch always lands, then ask the AI to enrich the reply.
        setMessage(randomTouchLine(region), reaction.mood);
        if (typeof AIAPI === 'undefined' || !AIAPI.hasConfig()) return;
        if (Date.now() - lastTouchAIAt < 1800) return;
        lastTouchAIAt = Date.now();
        try {
            const config = AIAPI.getConfig();
            const summary = session && session.summary ? session.summary() : null;
            const word = summary && summary.current_word ? summary.current_word : '';
            const prompt = '你是在背词陪伴模式里可爱的 Live2D 角色。用户刚刚触摸了你的' + reaction.part + '，' + reaction.state
                + '。' + (word ? ('当前正在背的单词是 \'' + word + '\'。') : '') + '请用活泼、真诚、不过分打扰学习的中文写一句不超过 36 字的即时回应，说出你此刻的心情。仅输出 JSON：{"text":"...","mood":"..."}，mood 只能是 idle|thinking|cheer|shy|firm|comfort|celebrate。';
            const response = await fetch('/proxy/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey, body: { model: config.model, messages: [{ role: 'system', content: '你是专注于陪伴学习的角色。只输出约定 JSON。' }, { role: 'user', content: prompt }], temperature: 0.8, response_format: { type: 'json_object' } } }) });
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || 'AI 暂时不可用');
            const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            const parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]);
            setReply(String(parsed.text || randomTouchLine(region)).slice(0, 80), reaction.mood);
        } catch (error) {
            // Keep the local line already shown so the touch still lands with a reaction.
        }
    }
    function showTouchFeedback(event, label) {
        const host = document.getElementById('companionLive2DHost');
        if (!host) return;
        const rect = host.getBoundingClientRect();
        const note = document.createElement('span');
        note.className = 'companion-touch-feedback';
        note.textContent = label;
        note.style.left = Math.max(8, Math.min(rect.width - 62, event.clientX - rect.left - 24)) + 'px';
        note.style.top = Math.max(8, Math.min(rect.height - 32, event.clientY - rect.top - 14)) + 'px';
        host.appendChild(note);
        setTimeout(function() { note.remove(); }, 560);
    }
    function touchRegionFor(event) {
        const canvas = document.getElementById('companionLive2DCanvas');
        if (!canvas || !liveModel || !pixiApp || !liveModel.width || !liveModel.height) return null;
        const canvasRect = canvas.getBoundingClientRect();
        if (!canvasRect.width || !canvasRect.height) return null;
        const stageWidth = (pixiApp.renderer && pixiApp.renderer.screen ? pixiApp.renderer.screen.width : canvasRect.width);
        const stageHeight = (pixiApp.renderer && pixiApp.renderer.screen ? pixiApp.renderer.screen.height : canvasRect.height);
        const stageX = (event.clientX - canvasRect.left) * stageWidth / canvasRect.width;
        const stageY = (event.clientY - canvasRect.top) * stageHeight / canvasRect.height;
        const left = liveModel.x - liveModel.width / 2;
        const top = liveModel.y - liveModel.height;
        const x = (stageX - left) / liveModel.width;
        const y = (stageY - top) / liveModel.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        if (y < 0.26) return 'head';
        if (y < 0.74 && (x < 0.24 || x > 0.76)) return 'hand';
        if (y > 0.74) return 'lower';
        return 'body';
    }
    function handleCharacterTouch(event) {
        if (!open || !liveModel || Date.now() - lastTouchAt < 560) return;
        const region = touchRegionFor(event);
        if (!region) return;
        lastTouchAt = Date.now();
        const reaction = TOUCH_REACTIONS[region] || TOUCH_REACTIONS.lower;
        showTouchFeedback(event, reaction.label);
        askTouchAI(region);
    }
    async function enter() {
        if (open) return;
        open = true;
        savedLayout = (typeof LayoutManager !== 'undefined' && LayoutManager) ? LayoutManager.getCurrentLayout() : 'single';
        if (typeof ChartManager !== 'undefined' && ChartManager) ChartManager.disposeAll();
        document.getElementById('dashboard').hidden = true;
        const root = document.getElementById('companionStudy'); root.hidden = false; document.body.classList.add('companion-mode');
        document.getElementById('companionBirthdayCard').hidden = true;
        await Live2DModelManager.loadModels().catch(function() {});
        studyInstance = StudyWeb.render('companionStudyFrame', { onStudyEvent: function(event) { if (!session) return; if (event.type === 'screen') session.screen(event.active); if (event.type === 'answer') session.record(event); } });
        session = CompanionSession.create(onSessionSignal);
        await loadRenderer();
        if (isAnonBirthday()) showBirthday();
    }
    function exit() {
        if (!open) return;
        if (session) session.screen(false);
        session = null;
        if (studyInstance && studyInstance.dispose) studyInstance.dispose();
        studyInstance = null;
        destroyRenderer();
        document.getElementById('companionStudy').hidden = true;
        document.getElementById('companionBirthdayCard').hidden = true;
        document.getElementById('dashboard').hidden = false;
        document.body.classList.remove('companion-mode');
        open = false;
        if (typeof LayoutManager !== 'undefined' && LayoutManager) LayoutManager.switchLayout(savedLayout);
        if (typeof ChartManager !== 'undefined' && ChartManager) ChartManager.renderAll();
    }
    function isAnonBirthday() {
        const model = Live2DModelManager.current(); const now = new Date();
        return model && String(model.character_id) === '037' && now.getMonth() === 8 && now.getDate() === 6;
    }
    function showBirthday() {
        if (birthdayShown) return; birthdayShown = true;
        setMessage('生日快乐！今天也一起把想做的事认真完成吧。', 'celebrate');
        document.getElementById('companionBirthdayBadge').hidden = false;
    }
    function showBirthdayCard() {
        const day = new Date();
        const key = 'memo_anon_birthday_milestone_' + day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
        try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) {}
        const card = document.getElementById('companionBirthdayCard');
        if (card) card.hidden = false;
        playMood('celebrate');
    }
    function init() {
        const openButton = document.getElementById('companionModeBtn');
        if (!openButton || openButton.dataset.ready) return;
        openButton.dataset.ready = 'true';
        openButton.addEventListener('click', enter);
        document.getElementById('exitCompanionModeBtn').addEventListener('click', exit);
        document.getElementById('companionAskBtn').addEventListener('click', function() { if (session) session.ask(); });
        document.getElementById('closeCompanionBirthdayCard').addEventListener('click', function() { document.getElementById('companionBirthdayCard').hidden = true; });
        window.addEventListener('resize', function() { if (open) scheduleRendererReload(180); });
        const companionCanvas = document.getElementById('companionLive2DCanvas');
        if (companionCanvas) companionCanvas.addEventListener('pointerup', handleCharacterTouch);
        if (companionCanvas) companionCanvas.addEventListener('webglcontextlost', function(event) {
            event.preventDefault();
            document.getElementById('companionGifFallback').hidden = false;
            destroyRenderer();
            if (open) scheduleRendererReload(260);
        });
        setInterval(function() { if (session) session.tick(); }, 60000);
        Live2DModelManager.attachSettings();
    }
    function reloadModel() { if (open) { destroyRenderer(); loadRenderer(); } }
    return { init: init, enter: enter, exit: exit, reloadModel: reloadModel, isOpen: function() { return open; } };
})();

// Top-level const bindings are not properties of window.  App.init() and the
// page entry use window.* so expose the three public modules explicitly.
window.Live2DModelManager = Live2DModelManager;
window.CompanionSession = CompanionSession;
window.Live2DCompanion = Live2DCompanion;
