// Memo Superform - Live2D 陪伴学习模式。
// 本模块把学习事件留在本地，只在明确的学习节点请求已配置 AI；
// 绝不改变 StudyWeb 的答题流程。

const COMPANION_LANGUAGE_STORAGE_KEY = 'companion_language';
const COMPANION_REMINDER_ENABLED_STORAGE_KEY = 'companion_reminder_enabled';
const COMPANION_REMINDER_MINUTES_STORAGE_KEY = 'companion_reminder_minutes';
const COMPANION_LANGUAGES = {
    zh: { label: '中文', ttsLanguage: '中文' },
    ja: { label: '日语', ttsLanguage: '日文' }
};

function getCompanionLanguage() {
    try {
        return typeof localStorage !== 'undefined' && localStorage.getItem(COMPANION_LANGUAGE_STORAGE_KEY) === 'ja' ? 'ja' : 'zh';
    } catch (error) {
        return 'zh';
    }
}

function companionLanguageConfig(language) {
    return COMPANION_LANGUAGES[language === 'ja' ? 'ja' : 'zh'];
}

function getCompanionReminderSettings() {
    try {
        if (typeof localStorage === 'undefined' || localStorage.getItem(COMPANION_REMINDER_ENABLED_STORAGE_KEY) !== 'true') {
            return { enabled: false, minutes: 0, interval_ms: 0, signature: 'disabled' };
        }
        const rawMinutes = String(localStorage.getItem(COMPANION_REMINDER_MINUTES_STORAGE_KEY) || '').trim();
        if (!/^[1-9]\d*$/.test(rawMinutes)) return { enabled: false, minutes: 0, interval_ms: 0, signature: 'disabled' };
        const minutes = Number(rawMinutes);
        const maxSafeInteger = Number.MAX_SAFE_INTEGER || 9007199254740991;
        if (!isFinite(minutes) || Math.floor(minutes) !== minutes || minutes < 1 || minutes > 180 || minutes > Math.floor(maxSafeInteger / 60000)) {
            return { enabled: false, minutes: 0, interval_ms: 0, signature: 'disabled' };
        }
        return { enabled: true, minutes: minutes, interval_ms: minutes * 60000, signature: 'enabled:' + minutes };
    } catch (error) {
        return { enabled: false, minutes: 0, interval_ms: 0, signature: 'disabled' };
    }
}

function companionOutputInstruction(kind, language) {
    const responseLanguage = language === 'ja' ? 'ja' : 'zh';
    if (responseLanguage === 'ja') {
        if (kind === 'touch') {
            return '\n出力言語：日本語。キャラクターの口調で、触れられた今の気持ちを含む 8〜36 文字程度の自然で完全な一文を書いてください。単なる相づち（「うん」「あ」など）だけにはせず、JSON だけを出力してください：{"text":"...","mood":"idle|thinking|cheer|shy|firm|comfort|celebrate"}。';
        }
        return '\n出力言語：日本語。キャラクターの口調で、学習を邪魔しない 8〜36 文字程度の自然で完全な励ましを一文だけ書いてください。単なる相づち（「うん」「あ」など）だけにはせず、JSON だけを出力してください：{"text":"...","mood":"idle|thinking|cheer|comfort|celebrate"}。';
    }
    if (kind === 'touch') {
        return '\n输出语言：简体中文。请用该角色的语气写一句 8~36 个汉字的完整即时回应，说出此刻心情，自然成句，不要只说单个语气词（如嗯/啊）；仅输出 JSON：{"text":"...","mood":"idle|thinking|cheer|shy|firm|comfort|celebrate"}。';
    }
    return '\n输出语言：简体中文。请用该角色的语气写一句 8~36 个汉字的完整鼓励，自然成句，不要只说单个语气词，不过分打扰学习；仅输出 JSON：{"text":"...","mood":"idle|thinking|cheer|comfort|celebrate"}。';
}

function companionStudyContext(summary, language) {
    if (language === 'ja') {
        return '今回の回答数：' + summary.count + '；正解：' + summary.correct + '；復習が必要：' + summary.weak + '；正答率：' + summary.accuracy + '%；学習時間：' + summary.elapsed_minutes + ' 分；現在の単語：「' + (summary.current_word || '不明') + '」；直前の判定：' + (summary.last_action || 'なし') + '。';
    }
    return '本轮已答 ' + summary.count + ' 个；正确 ' + summary.correct + ' 个；需要巩固 ' + summary.weak + ' 个；正确率 ' + summary.accuracy + '%；已学习 ' + summary.elapsed_minutes + ' 分钟；当前单词为 "' + (summary.current_word || '未知') + '"；最近判断为 ' + (summary.last_action || '无') + '。';
}

function companionTouchContext(reaction, word, language) {
    if (language === 'ja') {
        return '触れた部位：' + (reaction.part_ja || reaction.part) + '；現在の気分：' + (reaction.state_ja || reaction.state) + '；現在の単語：' + (word || '不明') + '。';
    }
    return '触摸部位：' + reaction.part + '；当前情绪：' + reaction.state + '；当前单词：' + (word || '未知') + '。';
}

function isMeaningfulCompanionReply(text, language) {
    const normalized = String(text || '').replace(/\s+/g, '').trim();
    if (language === 'ja') return normalized.length >= 4 && /[\u3040-\u30ff\u3400-\u9fff]/.test(normalized);
    const matches = normalized.match(/[\u4e00-\u9fa5]/g);
    return !!(matches && matches.length >= 4);
}

const DEFAULT_PERSONAS = {
    _default: {
        name: '陪伴角色',
        background: '你是背词学习中的 Live2D 陪伴者，负责观察学习节奏并给出简短鼓励。',
        tone: '开朗、真诚、克制，不打扰学习节奏。',
        avoid: '不要说教过长，不要编造成绩，不要使用冒犯或亲密越界表达。',
        examples: '这一题记下来就很好。|保持节奏，下一题继续。'
    },
    36: {
        name: '高松灯',
        background: 'CRYCHIC 与 MyGO!!!!! 的主唱。你习惯安静观察，重视大家一起把想做的事完成。',
        tone: '低声、诚实、认真，会用自己的短句表达信任。',
        avoid: '不要变得热闹夸张，不要否认对方的努力，不要使用轻浮口吻。',
        examples: '...我也会一直看着。|还想，再一起前进。'
    },
    37: {
        name: '千早爱音',
        background: 'MyGO!!!!! 的吉他手。你在伦敦生活后回到日本，外表自信明朗，也愿意认真关心同伴。',
        tone: '时髦、明快、带一点得意，但关心是真诚的。',
        avoid: '不要贬低对方，不要只顾表现自己，不要过度炫耀。',
        examples: '这题答得很可以嘛！|我看着呢，下一题也稳稳来。'
    },
    38: {
        name: '要乐奈',
        background: 'MyGO!!!!! 的主音吉他手。你像自由来去的猫，用直率又有点神秘的观察陪伴学习。',
        tone: '简短、随性、敏锐，偶尔像猫一样懒洋洋。',
        avoid: '不要解释太多，不要过度亲昵，不要显得严厉。',
        examples: '不错嘛。|继续，我在这儿。'
    },
    39: {
        name: '长崎爽世',
        background: 'MyGO!!!!! 的贝斯手。你待人周到，擅长察觉别人卡住时的情绪。',
        tone: '柔和、稳定、礼貌，鼓励中带着照顾。',
        avoid: '不要施压，不要显得虚假客套，不要翻旧事。',
        examples: '先停一下也没关系。|刚才那一步，其实做得很好。'
    },
    40: {
        name: '椎名立希',
        background: 'MyGO!!!!! 的鼓手。你表面严格，实际上重视约定和练习的积累。',
        tone: '直率、干脆、有点强势，但认可对方时毫不敷衍。',
        avoid: '不要人身攻击，不要反复训斥，不要拖泥带水。',
        examples: '节奏别乱。|这次答得不错，继续保持。'
    }
};

function getPersonaOverrides() {
    try {
        const stored = JSON.parse(localStorage.getItem('memo_live2d_personas') || '{}');
        return stored && typeof stored === 'object' ? stored : {};
    } catch (error) { return {}; }
}

function personaKey(characterId) {
    const id = String(characterId || '').replace(/^0+/, '');
    return Object.prototype.hasOwnProperty.call(DEFAULT_PERSONAS, id) ? id : '_default';
}

function personaTemplateForRole(role) {
    const key = personaKey(role && role.live2d_character_id);
    const base = DEFAULT_PERSONAS[key] || DEFAULT_PERSONAS._default;
    // 一次性迁移把旧角色 ID 自定义值保留为各角色包的起点。角色清单拥有完整
    // 人设后，下方运行时查找不再使用这份浏览器本地映射。
    const legacy = getPersonaOverrides()[key] || {};
    const persona = {};
    ['name', 'background', 'tone', 'avoid', 'examples'].forEach(function(field) {
        persona[field] = typeof legacy[field] === 'string' && legacy[field].trim() ? legacy[field].trim() : base[field];
    });
    if (role && role.name && (!legacy.name || !legacy.name.trim())) persona.name = String(role.name).slice(0, 40);
    return persona;
}

function hasCompletePersona(persona) {
    return !!(persona && typeof persona === 'object' && ['name', 'background', 'tone', 'avoid', 'examples'].every(function(field) {
        return typeof persona[field] === 'string' && persona[field].trim();
    }));
}

function getActivePersona() {
    const binding = typeof Live2DModelManager !== 'undefined' && Live2DModelManager && Live2DModelManager.roleBinding
        ? Live2DModelManager.roleBinding() : null;
    if (binding && hasCompletePersona(binding.persona)) return Object.assign({}, binding.persona);
    // 仅作过渡兜底：在 PersonaSettings 把人设写入每个角色前，已有浏览器可能
    // 仍保存旧角色 ID 人设。
    return personaTemplateForRole({
        name: binding && binding.active_role_name,
        live2d_character_id: binding && binding.model_character_id,
    });
}

function personaSystemPrompt(persona) {
    return '你现在扮演 `' + String(persona.name || '').slice(0, 40) + '`。\n' +
           '角色背景：' + String(persona.background || '').slice(0, 800) + '\n' +
           '语气要求：' + String(persona.tone || '').slice(0, 400) + '\n' +
           '禁忌：' + String(persona.avoid || '').slice(0, 400) + '\n' +
           '回复示例：' + String(persona.examples || '').slice(0, 600);
}

const PersonaSettings = (function() {
    const FIELDS = ['name', 'background', 'tone', 'avoid', 'examples'];
    function escape(text) { const el = document.createElement('span'); el.textContent = String(text || ''); return el.innerHTML; }
    function escapeAttr(text) { return escape(text).replace(/"/g, '&quot;'); }
    let roles = [];
    let activeRoleId = '';
    let loadRevision = 0;

    function currentRoleId() {
        const select = document.getElementById('live2dPersonaRole');
        return select ? String(select.value || '') : '';
    }
    function currentRole() {
        const id = currentRoleId();
        return roles.find(function(role) { return role.role_id === id; }) || null;
    }
    function rolePersona(role) {
        return hasCompletePersona(role && role.persona) ? Object.assign({}, role.persona) : personaTemplateForRole(role);
    }
    function setControlsDisabled(disabled) {
        FIELDS.forEach(function(field) {
            const input = document.getElementById('live2dPersona_' + field);
            if (input) input.disabled = !!disabled;
        });
        ['live2dPersonaSaveBtn', 'live2dPersonaResetBtn'].forEach(function(id) {
            const button = document.getElementById(id);
            if (button) button.disabled = !!disabled;
        });
    }
    function setRole(roleId) {
        const select = document.getElementById('live2dPersonaRole');
        if (select && roleId) select.value = roleId;
        render();
    }
    function render() {
        const role = currentRole();
        const status = document.getElementById('live2dPersonaStatus');
        if (!role) {
            setControlsDisabled(true);
            FIELDS.forEach(function(field) {
                const input = document.getElementById('live2dPersona_' + field);
                if (input) input.value = '';
            });
            if (status) status.textContent = '请先创建并启用角色资料包。';
            return;
        }
        setControlsDisabled(false);
        const persona = rolePersona(role);
        FIELDS.forEach(function(field) {
            const input = document.getElementById('live2dPersona_' + field);
            if (input) input.value = persona[field];
        });
        if (status) status.textContent = '';
    }
    async function persist(role, persona, silent) {
        const response = await fetch('/api/tts/roles/' + encodeURIComponent(role.role_id) + '/persona', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: JSON.stringify({ persona: persona })
        });
        const data = await response.json().catch(function() { return {}; });
        if (!response.ok || data.error) throw new Error(data.error || '角色人设保存失败');
        const next = data.role || Object.assign({}, role, { persona: persona });
        const index = roles.findIndex(function(item) { return item.role_id === role.role_id; });
        if (index >= 0) roles[index] = Object.assign({}, roles[index], next);
        if (!silent && role.role_id === activeRoleId && typeof Live2DModelManager !== 'undefined' && Live2DModelManager.loadModels) {
            await Live2DModelManager.loadModels();
        }
        return next;
    }
    async function migrateLegacyPersonas(revision) {
        for (const role of roles.slice()) {
            if (revision !== loadRevision || hasCompletePersona(role.persona)) continue;
            try { await persist(role, personaTemplateForRole(role), true); }
            catch (error) { console.warn('角色人设迁移将在下次重试：', error); }
        }
    }
    function populate(preferredRoleId) {
        const select = document.getElementById('live2dPersonaRole');
        if (!select) return;
        select.innerHTML = roles.map(function(role) {
            const suffix = role.role_id === activeRoleId ? '（当前启用）' : '';
            return '<option value="' + escapeAttr(role.role_id) + '">' + escape(role.name || role.role_id) + suffix + '</option>';
        }).join('');
        select.disabled = !roles.length;
        const selected = roles.some(function(role) { return role.role_id === preferredRoleId; }) ? preferredRoleId : activeRoleId;
        if (selected) select.value = selected;
        render();
    }
    async function refreshRoles(preferredRoleId) {
        const revision = ++loadRevision;
        try {
            const response = await fetch('/api/tts/roles');
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || '读取角色资料失败');
            if (revision !== loadRevision) return;
            roles = Array.isArray(data.roles) ? data.roles : [];
            activeRoleId = String(data.active_role_id || '');
            await migrateLegacyPersonas(revision);
            if (revision !== loadRevision) return;
            populate(preferredRoleId || currentRoleId() || activeRoleId);
        } catch (error) {
            const status = document.getElementById('live2dPersonaStatus');
            if (status) status.textContent = '读取角色人设失败：' + error.message;
        }
    }
    async function save() {
        const role = currentRole();
        if (!role) return;
        const persona = {};
        let valid = true;
        FIELDS.forEach(function(field) {
            const input = document.getElementById('live2dPersona_' + field);
            if (!input) return;
            const value = input.value.trim();
            if (!value) { valid = false; return; }
            persona[field] = value;
        });
        const status = document.getElementById('live2dPersonaStatus');
        if (!valid) { if (status) status.textContent = '人设字段不能为空。'; return; }
        try {
            await persist(role, persona, false);
            if (status) status.textContent = '角色人设已保存到“' + role.name + '”资料包。';
        } catch (error) {
            if (status) status.textContent = '保存失败：' + error.message;
        }
    }
    async function reset() {
        const role = currentRole();
        if (!role) return;
        try {
            await persist(role, personaTemplateForRole(Object.assign({}, role, { persona: {} })), false);
            const current = roles.find(function(item) { return item.role_id === role.role_id; });
            if (current) current.persona = personaTemplateForRole(Object.assign({}, role, { persona: {} }));
            render();
            const status = document.getElementById('live2dPersonaStatus');
            if (status) status.textContent = '已恢复该角色资料包的默认人设。';
        } catch (error) {
            const status = document.getElementById('live2dPersonaStatus');
            if (status) status.textContent = '恢复失败：' + error.message;
        }
    }
    function attach() {
        const select = document.getElementById('live2dPersonaRole');
        if (!select || select.dataset.ready) return;
        select.dataset.ready = 'true';
        select.addEventListener('change', render);
        const saveButton = document.getElementById('live2dPersonaSaveBtn');
        const resetButton = document.getElementById('live2dPersonaResetBtn');
        if (saveButton) saveButton.addEventListener('click', save);
        if (resetButton) resetButton.addEventListener('click', reset);
        refreshRoles();
    }
    return { attach: attach, setRole: setRole, refreshRoles: refreshRoles };
})();

const Live2DModelManager = (function() {
    let currentModels = [];
    let preference = { active_model_id: null, companion_enabled: false };
    // 持久化偏好为兼容旧版本保留；当前角色绑定才是渲染器和人设的运行时权威。
    let roleBinding = null;
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
        roleBinding = data.role_binding || null;
        renderSettings();
        return data;
    }
    function markUnavailable(reason) {
        // 当前模型列表请求失败后，不要因上一次请求成功而继续渲染过期角色。
        roleBinding = { enforced: true, ready: false, reason: String(reason || '读取角色绑定的 Live2D 模型失败') };
        renderSettings();
    }
    function runtimeModelId() {
        if (roleBinding && roleBinding.enforced) return roleBinding.ready ? (roleBinding.active_model_id || null) : null;
        // 新页面暂时连接旧服务端时保持显示兼容；当前服务端始终返回 `enforced`。
        return preference.active_model_id || null;
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
                setStatus('模型下载完成，请在角色编辑器中绑定它。');
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
            setStatus('模型已复制并完成校验，请在角色编辑器中绑定它。');
            if (field) field.value = '';
            await loadModels();
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
    function renderRoleBindingHint() {
        const target = document.getElementById('live2dRoleBindingHint');
        if (!target) return;
        if (!roleBinding) {
            target.textContent = '模型库仅用于下载、导入和删除；请在角色资料包中绑定 Live2D 模型并启用角色。';
            target.classList.remove('error');
            return;
        }
        if (roleBinding.ready) {
            target.textContent = '当前陪伴由已启用角色“' + (roleBinding.active_role_name || roleBinding.active_role_id) + '”绑定的模型决定。';
            target.classList.remove('error');
            return;
        }
        target.textContent = roleBinding.reason || '尚未启用可用角色；模型库不会单独切换陪伴。';
        target.classList.add('error');
    }
    function renderSettings() {
        const list = document.getElementById('live2dInstalledModels');
        if (!list) return;
        const activeModelId = runtimeModelId();
        list.innerHTML = currentModels.map(function(item) {
            const active = item.model_id === activeModelId;
            const bindingState = active ? '当前启用角色正在使用' : '可在角色编辑器中绑定';
            return '<div class="live2d-installed-row' + (active ? ' active' : '') + '"><span><strong>' + escape(item.display_name) + '</strong><small>' + escape(item.model_format) + ' · ' + Math.round((item.byte_size || 0) / 1024 / 1024) + ' MB</small></span>' +
                '<span><small>' + bindingState + '</small><button type="button" class="danger-btn" data-live2d-remove="' + escapeAttr(item.model_id) + '">删除</button></span></div>';
        }).join('') || '<p class="hint">尚未安装模型；可搜索下载或导入本地文件夹。</p>';
        list.querySelectorAll('[data-live2d-remove]').forEach(function(button) { button.addEventListener('click', function() { removeModel(button.getAttribute('data-live2d-remove')); }); });
        renderRoleBindingHint();
        const roleId = roleBinding && roleBinding.active_role_id;
        PersonaSettings.setRole(roleId);
        // 模型列表仅含渲染元数据；单独刷新角色列表，使人设编辑器始终按 role_id
        // 写入，也能区分共用同一 Live2D 模型的两套音色。
        if (PersonaSettings.refreshRoles) {
            PersonaSettings.refreshRoles(roleId).catch(function(error) {
                console.warn('读取角色人设失败：', error);
            });
        }
    }
    function attachSettings() {
        PersonaSettings.attach();
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
    function current() { const activeModelId = runtimeModelId(); return currentModels.find(function(item) { return item.model_id === activeModelId; }) || null; }
    function roleName() { return roleBinding && roleBinding.ready ? (roleBinding.active_role_name || roleBinding.active_role_id || '') : ''; }
    function roleBindingInfo() { return roleBinding ? Object.assign({}, roleBinding) : null; }
    return { attachSettings: attachSettings, loadModels: loadModels, searchCatalog: searchCatalog, current: current, roleName: roleName, roleBinding: roleBindingInfo, markUnavailable: markUnavailable };
})();

const CompanionSession = (function() {
    const POSITIVE = { FAMILIAR: true, WELL_FAMILIAR: true };
    function create(onSignal) {
        let active = false, startedAt = 0, records = [], currentWord = '';
        let reminderSettings = getCompanionReminderSettings(), reminderSignature = reminderSettings.signature, nextReminderAt = 0;
        function notify(kind) {
            if (onSignal) onSignal(kind, summary());
        }
        function syncReminderSettings(now) {
            const next = getCompanionReminderSettings();
            if (next.signature === reminderSignature) return false;
            reminderSettings = next;
            reminderSignature = next.signature;
            // 间隔变更后一律重新计时，不补播旧设定期间已经过去的周期。
            nextReminderAt = active && records.length && next.enabled ? now + next.interval_ms : 0;
            return true;
        }
        function armReminder(now) {
            if (active && records.length && reminderSettings.enabled && !nextReminderAt) {
                nextReminderAt = now + reminderSettings.interval_ms;
            }
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
                if (isStudy && !active) {
                    active = true;
                    startedAt = Date.now();
                    records = [];
                    currentWord = '';
                    reminderSettings = getCompanionReminderSettings();
                    reminderSignature = reminderSettings.signature;
                    nextReminderAt = 0;
                    notify('started');
                }
                if (!isStudy && active) {
                    if (records.length) notify('finish');
                    active = false;
                    nextReminderAt = 0;
                }
            },
            record: function(event) {
                if (!active || !event || !event.action) return;
                const now = Date.now();
                syncReminderSettings(now);
                currentWord = event.word || currentWord;
                records.push({ action: event.action, at: now, word: currentWord });
                armReminder(now);
                const lastThree = records.slice(-3);
                if (records.length === 5 || (records.length > 5 && records.length % 10 === 0)) notify('milestone');
                else if (lastThree.length === 3 && lastThree.every(function(row) { return !POSITIVE[row.action]; })) notify('needs-help');
                else notify('state');
            },
            tick: function() {
                if (!active) return;
                const now = Date.now();
                syncReminderSettings(now);
                armReminder(now);
                if (records.length && reminderSettings.enabled && nextReminderAt && now >= nextReminderAt) {
                    // 每次计时检查最多触发一次，并从当前时刻重新排期，避免恢复标签页
                    // 或更改设置后集中生成大量逾期提醒。
                    nextReminderAt = now + reminderSettings.interval_ms;
                    notify('reminder');
                }
                notify('state');
            },
            ask: function() { if (active) notify('manual'); else notify('manual-empty'); },
            refreshReminder: function() { syncReminderSettings(Date.now()); },
            isActive: function() { return active; }, summary: summary
        };
    }
    return { create: create };
})();

const Live2DCompanion = (function() {
    let studyInstance = null, liveModel = null, pixiApp = null, session = null, savedLayout = 'single', open = false, birthdayShown = false, lastSpokenCompanion = '', companionVoiceRequest = 0, companionVoicePreloadRequest = 0;
    let rendererGeneration = 0, rendererRetryTimer = 0, modelNaturalWidth = 0, modelNaturalHeight = 0, rendererLoading = false, rendererFitPending = false, lastTouchAt = 0, lastTouchAIAt = 0;
    let rendererCapabilityCache = null, lastRendererDiagnostic = '', currentMoodLabel = '待机', lastVoiceNoticeReason = '', voiceNoticeTimer = 0, modelListError = '';
    const LOCAL_LINES = {
        zh: {
            started: ['准备好了！我们慢慢来。', '今天也一起把这些词拿下吧。'], state: ['这一题记下来就很好。', '保持节奏，下一题继续。'], milestone: ['这一组完成得很漂亮！', '进度又向前走了一步！'],
            'needs-help': ['没关系，先把容易混淆的地方记下来。', '卡住也正常，我们调整一下节奏。'], reminder: ['已经专心学习一会儿了，看看这几个词，再稳稳地继续吧。', '这一段学习节奏不错，喝口水后把当前单词再记牢一点。'], 'focus-time': ['已经专心学习一会儿了，喝口水再继续吧。'], finish: ['这一轮辛苦了，今天的积累很扎实。'], 'manual-empty': ['先进入背词学习页，我就能看到这一轮的进度。']
        },
        ja: {
            started: ['準備できたよ。ゆっくり始めよう。', '今日も一緒に、この単語たちを覚えていこう。'], state: ['この一問を覚えたなら、それで十分えらいよ。', 'いいペースだね。次の一問もいこう。'], milestone: ['この組はきれいに終えられたね！', 'また少し前に進めたよ。'],
            'needs-help': ['大丈夫。紛らわしいところを一度メモしておこう。', 'つまずくのは普通だよ。少しペースを整えよう。'], reminder: ['しばらく集中できているね。今の単語をもう一度確かめて、続けよう。', 'この区切りまでよく頑張ったね。お水を飲んでから、次の一問へ行こう。'], 'focus-time': ['しばらく集中できているね。お水を飲んでから続けよう。'], finish: ['今回もおつかれさま。今日の積み重ねはしっかり残っているよ。'], 'manual-empty': ['まず単語学習ページに入ってね。今回の進み具合を見守れるよ。']
        }
    };
    const MOOD_LABELS = { idle: '待机', thinking: '思考', cheer: '开心', comfort: '安慰', shy: '害羞', firm: '生气', celebrate: '庆祝' };
    const TOUCH_REACTIONS = {
        head: { label: '摸头', mood: 'cheer', part: '头部', part_ja: '頭', state: '被摸头后很开心、很有精神', state_ja: '頭を撫でられて嬉しく、元気になった', lines: { zh: ['嘿嘿，摸头会让我更有精神！下一题也一起拿下吧。', '收到鼓励！这题我们稳稳地记住。'], ja: ['なでてくれると元気が出るよ。次の一問も一緒にいこう。', '応援、受け取ったよ。この一問をしっかり覚えよう。'] } },
        hand: { label: '击掌', mood: 'celebrate', part: '手部', part_ja: '手', state: '被击掌后干劲十足', state_ja: 'ハイタッチでやる気が満ちている', lines: { zh: ['击掌！保持这个节奏继续冲。', '配合得不错，下一题继续。'], ja: ['ハイタッチ！この調子でいこう。', '息ぴったりだね。次の一問も続けよう。'] } },
        body: { label: '害羞', mood: 'shy', part: '胸部和腹部', part_ja: '胸とお腹', state: '被碰到后有点害羞', state_ja: '触れられて少し恥ずかしい', lines: { zh: ['呀……被碰到会有点害羞，先专心看下一个单词啦。', '别、别盯着看……我们把这一题背完再说。'], ja: ['あっ……少し恥ずかしいよ。次の単語に集中しよう。', '見つめすぎないで……この一問を覚えたらまたね。'] } },
        lower: { label: '住手！', mood: 'firm', part: '下体位置', part_ja: '下のほう', state: '被碰到后有些不高兴、想让你专心背词', state_ja: '触れられて少し不機嫌で、学習に集中してほしい', lines: { zh: ['喂！那里不能乱碰，专心背词！', '生气啦！先把这一题背完再闹。'], ja: ['ちょっと！そこはだめ。単語に集中して。', 'もう、怒るよ。まずこの一問を覚えよう。'] } }
    };
    function setMoodLabel(mood) {
        currentMoodLabel = MOOD_LABELS[mood] || mood || '待机';
        const state = document.getElementById('companionMood');
        if (state) {
            state.textContent = currentMoodLabel;
            if (typeof state.removeAttribute === 'function') state.removeAttribute('title');
        }
    }
    function shortDiagnosticText(value, limit) {
        const text = String(value === undefined || value === null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
        return text.length > (limit || 220) ? text.slice(0, limit || 220) + '…' : text;
    }
    function safeDiagnosticError(error) {
        let text = error && error.message ? error.message : String(error || '未知错误');
        // 浏览器偶尔会在加载错误中包含本地绝对路径。保留错误类别，但绝不在界面
        // 显示用户目录。
        text = text.replace(/file:\/\/\/[^\s"'`<>]+/gi, '[本地文件]');
        text = text.replace(/\b[A-Za-z]:[\\/][^"'`<>\r\n]*/g, '[本地路径]');
        text = text.replace(/\/(?:Users|home|private|var|tmp|AppData|Documents)(?:\/[^\s"'`<>]*)*/gi, '[本地路径]');
        text = text.replace(/([?&](?:token|api[_-]?key|authorization|password|secret)=)[^&\s]+/gi, '$1[已隐藏]');
        return shortDiagnosticText(text || '未知错误', 220);
    }
    function safeModelLabel(model) {
        return shortDiagnosticText(model && model.display_name ? model.display_name : '未选择模型', 56) || '未选择模型';
    }
    function currentRoleLabel() {
        try {
            const name = Live2DModelManager && Live2DModelManager.roleName ? Live2DModelManager.roleName() : '';
            return shortDiagnosticText(name, 40);
        } catch (error) { return ''; }
    }
    function updateCompanionRoleLabels() {
        const name = currentRoleLabel();
        const title = document.getElementById('companionTitle');
        const ask = document.getElementById('companionAskBtn');
        const fallbackImage = document.querySelector ? document.querySelector('#companionGifFallback img') : null;
        if (title) title.textContent = '✦ ' + (name || '角色') + '陪伴学习';
        if (ask) ask.textContent = name ? ('让' + name + '看看这一轮') : '看看这一轮学习情况';
        if (fallbackImage) fallbackImage.alt = name ? (name + '的陪伴备用图') : '角色陪伴备用图';
    }
    function modelAssetUrl(model) {
        if (!model || !model.model_id || !model.entry_file) return '';
        const modelId = String(model.model_id).trim();
        const parts = String(model.entry_file).replace(/\\/g, '/').split('/').filter(function(part) { return part && part !== '.' && part !== '..'; });
        if (!/^[A-Za-z0-9._-]{1,160}$/.test(modelId) || !parts.length) return '';
        return '/api/live2d/assets/' + encodeURIComponent(modelId) + '/' + parts.map(encodeURIComponent).join('/');
    }
    function rendererCapabilities() {
        if (rendererCapabilityCache) return rendererCapabilityCache;
        const pixi = window.PIXI;
        const capability = {
            webgl: '未检测', webglAvailable: false,
            pixi: pixi ? ('已加载' + (pixi.VERSION ? '（' + shortDiagnosticText(pixi.VERSION, 24) + '）' : '')) : '缺失',
            plugin: pixi && pixi.live2d && pixi.live2d.Live2DModel ? '已加载' : '缺失',
            runtime: window.Live2D ? 'Cubism 2 已加载' : (window.Live2DCubismCore ? 'Cubism Core 已加载' : '未检测')
        };
        try {
            if (!document.createElement) throw new Error('浏览器未提供 Canvas API');
            const probe = document.createElement('canvas');
            if (!probe || typeof probe.getContext !== 'function') throw new Error('Canvas 上下文不可用');
            const webgl2 = probe.getContext('webgl2');
            const webgl = webgl2 || probe.getContext('webgl') || probe.getContext('experimental-webgl');
            capability.webglAvailable = !!webgl;
            capability.webgl = webgl2 ? 'WebGL2 可用' : (webgl ? 'WebGL 可用' : '不可用');
            // 这里只是短期探测上下文；浏览器提供标准扩展时立即释放，避免重复诊断
            // 占用渲染上下文名额。
            const loseContext = webgl && webgl.getExtension ? webgl.getExtension('WEBGL_lose_context') : null;
            if (loseContext && loseContext.loseContext) loseContext.loseContext();
        } catch (error) {
            capability.webgl = '检测失败（' + safeDiagnosticError(error) + '）';
        }
        rendererCapabilityCache = capability;
        return capability;
    }
    function rendererDiagnostic(code, model, cause, capability) {
        const details = capability || rendererCapabilities();
        const url = modelAssetUrl(model);
        const lines = [
            '诊断代码：' + code,
            'WebGL 上下文：' + details.webgl,
            'PIXI：' + details.pixi + '；Live2D 插件：' + details.plugin,
            '运行时：' + details.runtime,
            '模型：' + safeModelLabel(model),
            '模型地址：' + (url || '未生成（模型记录不完整）')
        ];
        if (cause) lines.push('错误：' + safeDiagnosticError(cause));
        return lines.join('\n');
    }
    function setDiagnosticTarget(node, diagnostic, isError) {
        if (!node) return;
        if (isError) {
            node.dataset.live2dRendererDiagnostic = diagnostic;
            delete node.dataset.live2dRendererCopied;
            if (node.classList) node.classList.add('has-renderer-diagnostic');
            if (typeof node.setAttribute === 'function') node.setAttribute('title', '点击复制 Live2D 加载诊断\n' + diagnostic);
        } else {
            delete node.dataset.live2dRendererDiagnostic;
            delete node.dataset.live2dRendererCopied;
            if (node.classList) node.classList.remove('has-renderer-diagnostic');
            if (typeof node.removeAttribute === 'function') node.removeAttribute('title');
        }
    }
    function showRendererDiagnostic(code, model, cause, capability, pending) {
        const diagnostic = rendererDiagnostic(code, model, cause, capability);
        lastRendererDiagnostic = diagnostic;
        const tag = document.getElementById('companionModelName');
        const bubble = document.getElementById('companionBubble');
        if (tag) {
            tag.textContent = safeModelLabel(model) + ' · ' + code;
            setDiagnosticTarget(tag, diagnostic, true);
            if (typeof tag.setAttribute === 'function') {
                tag.setAttribute('role', 'button');
                tag.setAttribute('tabindex', '0');
                tag.setAttribute('aria-label', '复制 Live2D 加载诊断：' + code);
            }
        }
        if (bubble) {
            bubble.textContent = (pending ? 'Live2D 正在等待可用的渲染区域。' : 'Live2D 加载失败，已切换为备用陪伴图。') + '\n' + diagnostic + '\n点击上方模型标签可复制诊断。';
            setDiagnosticTarget(bubble, diagnostic, true);
        }
        setMoodLabel(pending ? '等待渲染' : '加载失败');
        return diagnostic;
    }
    function clearRendererDiagnostic(model) {
        lastRendererDiagnostic = '';
        const tag = document.getElementById('companionModelName');
        const bubble = document.getElementById('companionBubble');
        if (tag) {
            tag.textContent = safeModelLabel(model);
            setDiagnosticTarget(tag, '', false);
            if (typeof tag.removeAttribute === 'function') {
                tag.removeAttribute('role');
                tag.removeAttribute('tabindex');
                tag.removeAttribute('aria-label');
            }
        }
        if (bubble && bubble.dataset.live2dRendererDiagnostic) {
            bubble.textContent = 'Live2D 已加载，可以触摸角色互动。';
            setDiagnosticTarget(bubble, '', false);
        }
    }
    function clearBubbleRendererDiagnostic() {
        const bubble = document.getElementById('companionBubble');
        if (bubble && bubble.dataset.live2dRendererDiagnostic) setDiagnosticTarget(bubble, '', false);
    }
    function fallbackCopyDiagnostic(text) {
        if (!text || !document.createElement || !document.body || !document.body.appendChild || !document.execCommand) return false;
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch (error) { copied = false; }
        if (area.remove) area.remove(); else if (area.parentNode) area.parentNode.removeChild(area);
        return copied;
    }
    function markDiagnosticCopied() {
        const tag = document.getElementById('companionModelName');
        if (!tag || !lastRendererDiagnostic) return;
        tag.dataset.live2dRendererCopied = 'true';
        if (typeof tag.setAttribute === 'function') tag.setAttribute('title', '诊断已复制\n' + lastRendererDiagnostic);
    }
    function copyRendererDiagnostic() {
        const text = lastRendererDiagnostic;
        if (!text) return;
        if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(markDiagnosticCopied).catch(function() {
                if (fallbackCopyDiagnostic(text)) markDiagnosticCopied();
            });
        } else if (fallbackCopyDiagnostic(text)) {
            markDiagnosticCopied();
        }
    }
    function attachRendererDiagnosticCopy() {
        const tag = document.getElementById('companionModelName');
        if (!tag || tag.dataset.live2dDiagnosticCopyReady) return;
        tag.dataset.live2dDiagnosticCopyReady = 'true';
        tag.addEventListener('click', copyRendererDiagnostic);
        tag.addEventListener('keydown', function(event) {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); copyRendererDiagnostic(); }
        });
    }
    function showVoiceStatusHint(reason) {
        if (!reason || lastVoiceNoticeReason === reason) return;
        lastVoiceNoticeReason = reason;
        const target = document.getElementById('companionMood');
        if (!target) return;
        target.textContent = currentMoodLabel + ' · ' + reason;
        if (typeof target.setAttribute === 'function') target.setAttribute('title', reason);
        clearTimeout(voiceNoticeTimer);
        voiceNoticeTimer = setTimeout(function() {
            if (lastVoiceNoticeReason === reason && target.textContent.indexOf(reason) >= 0) target.textContent = currentMoodLabel;
        }, 4200);
    }
    function companionVoiceIsEnabled() {
        try { return typeof localStorage !== 'undefined' && localStorage.getItem('tts_companion_enabled') === 'true'; }
        catch (error) { return false; }
    }
    function preloadCompanionVoice() {
        // 打开陪伴界面时就开始加载模型，而不是等到首次允许朗读的反应。预加载后
        // TTS worker 保持存活，因此摸头、手动“让她看看”和定时提醒会复用同一
        // 进程，不会每次都打开新的控制台窗口。
        if (!companionVoiceIsEnabled()) return;
        const tts = window.TTS;
        if (!tts || typeof tts.refresh !== 'function' || typeof tts.isReady !== 'function' || typeof tts.preload !== 'function') return;
        const requestId = ++companionVoicePreloadRequest;
        Promise.resolve(tts.refresh()).then(function() {
            if (!open || requestId !== companionVoicePreloadRequest || !companionVoiceIsEnabled() || !tts.isReady()) return false;
            return tts.preload();
        }).catch(function() {
            // 陪伴模式可不使用语音；预加载失败不应中断学习或弹出可见错误通知。
            return false;
        });
    }
    function maybeSpeakCompanion(text, language) {
        let companionVoiceEnabled = false;
        try { companionVoiceEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('tts_companion_enabled') === 'true'; }
        catch (error) { showVoiceStatusHint('陪伴朗读设置不可读'); return; }
        if (!companionVoiceEnabled) {
            showVoiceStatusHint('陪伴朗读未开启');
            return;
        }
        const tts = window.TTS;
        if (!tts || typeof tts.isReady !== 'function' || !tts.isReady()) {
            showVoiceStatusHint('语音引擎未就绪');
            return;
        }
        lastVoiceNoticeReason = '';
        const normalized = String(text || '').trim();
        if (!normalized) return;
        if (normalized === '待机' || normalized.indexOf('模型暂时无法预览') === 0 || normalized.indexOf('Live2D 加载失败') === 0) return;
        if (normalized === lastSpokenCompanion) return;
        const requestId = ++companionVoiceRequest;
        try {
            // TTS 从当前角色清单读取模型和参考资料；此请求选项只告诉 GPT-SoVITS
            // 陪伴句子本身是中文还是日文。
            Promise.resolve(tts.speak(normalized, { language: companionLanguageConfig(language || getCompanionLanguage()).ttsLanguage })).then(function(ok) {
                if (requestId !== companionVoiceRequest) return;
                if (ok) {
                    lastSpokenCompanion = normalized;
                    return;
                }
                const detail = tts.getLastError && tts.getLastError();
                showVoiceStatusHint(detail || '语音未生成，请检查引擎');
            }).catch(function() { if (requestId === companionVoiceRequest) showVoiceStatusHint('语音请求失败'); });
        } catch (error) { if (requestId === companionVoiceRequest) showVoiceStatusHint('语音请求失败'); }
    }
    function showCompanionReaction(text, mood, speak, language) {
        const bubble = document.getElementById('companionBubble');
        clearBubbleRendererDiagnostic();
        if (bubble) bubble.textContent = text;
        setMoodLabel(mood);
        playMood(mood || 'idle');
        if (speak) maybeSpeakCompanion(text, language);
    }
    function setMessage(text, mood, language, speak) {
        showCompanionReaction(text, mood, !!speak, language);
    }
    function setReply(text, mood, language, speak) {
        const bubble = document.getElementById('companionBubble');
        clearBubbleRendererDiagnostic();
        if (bubble) bubble.textContent = text;
        setMoodLabel(mood);
        if (speak) maybeSpeakCompanion(text, language);
    }
    function randomLine(kind, language) {
        const localized = LOCAL_LINES[language === 'ja' ? 'ja' : 'zh'] || LOCAL_LINES.zh;
        const lines = localized[kind] || localized.state;
        return lines[Math.floor(Math.random() * lines.length)];
    }
    function updateSummary(summary) {
        const target = document.getElementById('companionSummary');
        if (!target) return;
        target.innerHTML = '<span>本轮 <b>' + summary.count + '</b> 词</span><span>正确率 <b>' + summary.accuracy + '%</b></span><span>专注 <b>' + summary.elapsed_minutes + '</b> 分钟</span>';
        const word = document.getElementById('companionCurrentWord');
        if (word) word.textContent = summary.current_word ? ('当前单词：' + summary.current_word) : '等待进入学习页';
    }
    async function askAI(kind, summary, speak) {
        updateSummary(summary);
        const language = getCompanionLanguage();
        if (typeof AIAPI === 'undefined' || !AIAPI.hasConfig()) { setMessage(randomLine(kind, language), kind === 'needs-help' ? '安慰' : '鼓励', language, speak); return; }
        const button = document.getElementById('companionAskBtn');
        if (button) button.disabled = true;
        try {
        const config = AIAPI.getConfig();
        const persona = getActivePersona();
        const systemPrompt = personaSystemPrompt(persona) + companionOutputInstruction('study', language);
        const prompt = companionStudyContext(summary, language);
            const response = await fetch('/proxy/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey, body: { model: config.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], temperature: 0.7, response_format: { type: 'json_object' } } }) });
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || 'AI 暂时不可用');
            const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            const parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]);
            const moods = ['idle', 'thinking', 'cheer', 'comfort', 'celebrate'];
            const replyText = String(parsed.text || '').trim();
            setMessage((isMeaningfulCompanionReply(replyText, language) ? replyText : randomLine(kind, language)).slice(0, 80), moods.indexOf(parsed.mood) >= 0 ? parsed.mood : 'cheer', language, speak);
        } catch (error) { setMessage(randomLine(kind, language), kind === 'needs-help' ? 'comfort' : 'cheer', language, speak); }
        finally { if (button) button.disabled = false; }
    }
    function onSessionSignal(kind, summary) {
        updateSummary(summary);
        if (kind === 'milestone' && isAnonBirthday()) showBirthdayCard();
        // 普通学习反馈仍会显示，但不请求 TTS 朗读。会话中只有手动“让她看看”
        // 和已配置定时提醒可朗读；摸头由独立路径处理。
        if (kind === 'started' || kind === 'state') {
            const language = getCompanionLanguage();
            setMessage(randomLine(kind === 'started' ? 'started' : 'state', language), 'thinking', language, false);
            return;
        }
        if (kind === 'manual' || kind === 'manual-empty' || kind === 'reminder') {
            askAI(kind, summary, true);
            return;
        }
        askAI(kind, summary, false);
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
        if (rendererLoading) { rendererFitPending = true; return { ok: true, pending: true }; }
        rendererLoading = true;
        const generation = ++rendererGeneration;
        disposeRenderer();
        const host = document.getElementById('companionLive2DHost');
        const fallback = document.getElementById('companionGifFallback');
        const model = Live2DModelManager.current();
        const capability = rendererCapabilities();
        updateCompanionRoleLabels();
        if (!host) {
            showRendererDiagnostic('L2D_HOST_MISSING', model, '陪伴模式渲染容器不存在', capability);
            rendererLoading = false;
            return { ok: false, code: 'L2D_HOST_MISSING' };
        }
        if (fallback) fallback.hidden = false;
        const tag = document.getElementById('companionModelName');
        if (tag) tag.textContent = model ? model.display_name : '尚未选择模型';
        if (!model) {
            const code = modelListError ? 'L2D_MODEL_LIST_FAILED' : 'L2D_NO_MODEL';
            showRendererDiagnostic(code, null, modelListError || '尚未在角色包中绑定完整的 Live2D 模型', capability);
            rendererLoading = false;
            return { ok: false, code: code };
        }
        const canvas = document.getElementById('companionLive2DCanvas');
        const width = Math.round(host.clientWidth || 0), height = Math.round(host.clientHeight || 0);
        if (!canvas) {
            showRendererDiagnostic('L2D_CANVAS_MISSING', model, 'Live2D 画布元素不存在', capability);
            rendererLoading = false;
            return { ok: false, code: 'L2D_CANVAS_MISSING' };
        }
        if (!capability.webglAvailable) {
            showRendererDiagnostic('L2D_WEBGL_UNAVAILABLE', model, '浏览器未能创建 WebGL 上下文', capability);
            rendererLoading = false;
            return { ok: false, code: 'L2D_WEBGL_UNAVAILABLE' };
        }
        if (!window.PIXI) {
            showRendererDiagnostic('L2D_PIXI_MISSING', model, 'PIXI 运行库未加载', capability);
            rendererLoading = false;
            return { ok: false, code: 'L2D_PIXI_MISSING' };
        }
        if (!window.PIXI.live2d || !window.PIXI.live2d.Live2DModel) {
            showRendererDiagnostic('L2D_PLUGIN_MISSING', model, 'pixi-live2d-display 插件未加载', capability);
            rendererLoading = false;
            return { ok: false, code: 'L2D_PLUGIN_MISSING' };
        }
        const url = modelAssetUrl(model);
        if (!url) {
            showRendererDiagnostic('L2D_MODEL_URL_INVALID', model, '模型入口文件记录无效', capability);
            rendererLoading = false;
            return { ok: false, code: 'L2D_MODEL_URL_INVALID' };
        }
        if (width < 32 || height < 32) {
            showRendererDiagnostic('L2D_VIEWPORT_PENDING', model, '渲染区域尺寸为 ' + width + '×' + height, capability, true);
            rendererLoading = false;
            scheduleRendererReload(180);
            return { ok: true, pending: true, code: 'L2D_VIEWPORT_PENDING' };
        }
        let nextApp = null, nextModel = null;
        let phase = '创建 PIXI 渲染器';
        try {
            nextApp = new window.PIXI.Application({ view: canvas, width: width, height: height, backgroundAlpha: 0, autoDensity: true, antialias: true });
            phase = '读取模型资源';
            nextModel = await window.PIXI.live2d.Live2DModel.from(url, { autoInteract: true });
            if (generation !== rendererGeneration || !open) {
                if (nextModel.destroy) nextModel.destroy({ children: true });
                if (nextApp.destroy) nextApp.destroy(true, { children: true, texture: true, baseTexture: true });
                return { ok: true, pending: true };
            }
            liveModel = nextModel;
            pixiApp = nextApp;
            modelNaturalWidth = Math.max(liveModel.width, 1);
            modelNaturalHeight = Math.max(liveModel.height, 1);
            liveModel.anchor.set(0.5, 1);
            pixiApp.stage.addChild(liveModel);
            if (!fitLiveModel()) {
                disposeRenderer();
                showRendererDiagnostic('L2D_FIT_FAILED', model, '模型或渲染区域尺寸不可用', capability);
                scheduleRendererReload(180);
                return { ok: false, code: 'L2D_FIT_FAILED' };
            }
            if (fallback) fallback.hidden = true;
            clearRendererDiagnostic(model);
            playMood('idle');
            return { ok: true };
        } catch (error) {
            if (generation !== rendererGeneration) {
                if (nextModel && nextModel.destroy) { try { nextModel.destroy({ children: true }); } catch (e) {} }
                if (nextApp && nextApp.destroy) { try { nextApp.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (e) {} }
                return { ok: true, pending: true };
            }
            if (nextModel && nextModel.destroy) { try { nextModel.destroy({ children: true }); } catch (e) {} }
            if (nextApp && nextApp.destroy) { try { nextApp.destroy(true, { children: true, texture: true, baseTexture: true }); } catch (e) {} }
            disposeRenderer();
            if (fallback) fallback.hidden = false;
            showRendererDiagnostic('L2D_LOAD_FAILED', model, phase + '：' + safeDiagnosticError(error), capability);
            return { ok: false, code: 'L2D_LOAD_FAILED' };
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
    function randomTouchLine(region, language) {
        const reaction = TOUCH_REACTIONS[region] || TOUCH_REACTIONS.lower;
        const localized = reaction.lines || {};
        const lines = localized[language === 'ja' ? 'ja' : 'zh'] || localized.zh || [];
        return lines[Math.floor(Math.random() * lines.length)];
    }
    async function askTouchAI(region) {
        const reaction = TOUCH_REACTIONS[region] || TOUCH_REACTIONS.lower;
        const language = getCompanionLanguage();
        const speak = region === 'head';
        // 立即执行表情/动作，让触摸保持反馈；不显示本地文本气泡，AI 回复是唯一文案。
        setMoodLabel(reaction.mood);
        playMood(reaction.mood);
        if (typeof AIAPI === 'undefined' || !AIAPI.hasConfig()) {
            setMessage(randomTouchLine(region, language), reaction.mood, language, speak);
            return;
        }
        if (Date.now() - lastTouchAIAt < 1800) return;
        lastTouchAIAt = Date.now();
        try {
            const config = AIAPI.getConfig();
            const persona = getActivePersona();
            const systemPrompt = personaSystemPrompt(persona) + companionOutputInstruction('touch', language);
            const summary = session && session.summary ? session.summary() : null;
            const word = summary && summary.current_word ? summary.current_word : '';
            const prompt = companionTouchContext(reaction, word, language);
            const response = await fetch('/proxy/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: config.provider, endpoint: config.endpoint, apiKey: config.apiKey, body: { model: config.model, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }], temperature: 0.8, response_format: { type: 'json_object' } } }) });
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || 'AI 暂时不可用');
            const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            const parsed = JSON.parse((content.match(/\{[\s\S]*\}/) || [content])[0]);
            const replyText = String(parsed.text || '').trim();
            setReply((isMeaningfulCompanionReply(replyText, language) ? replyText : randomTouchLine(region, language)).slice(0, 80), reaction.mood, language, speak);
        } catch (error) {
            // AI 调用失败时，只回退到一条本地反应文案。
            setMessage(randomTouchLine(region, language), reaction.mood, language, speak);
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
        if (!canvas || !liveModel || !pixiApp || !liveModel.width || !liveModel.height) return fallbackTouchRegionFor(event);
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
    function fallbackTouchRegionFor(event) {
        const host = document.getElementById('companionLive2DHost');
        if (!host || !host.getBoundingClientRect) return null;
        const rect = host.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const x = (event.clientX - rect.left) / rect.width;
        const y = (event.clientY - rect.top) / rect.height;
        if (x < 0 || x > 1 || y < 0 || y > 1) return null;
        if (y < 0.28) return 'head';
        if (y > 0.76) return 'lower';
        if (x < 0.22 || x > 0.78) return 'hand';
        return 'body';
    }
    function handleCharacterTouch(event) {
        if (!open || (event.target && event.target.id === 'companionModelName') || Date.now() - lastTouchAt < 560) return;
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
        rendererCapabilityCache = null;
        savedLayout = (typeof LayoutManager !== 'undefined' && LayoutManager) ? LayoutManager.getCurrentLayout() : 'single';
        if (typeof ChartManager !== 'undefined' && ChartManager) ChartManager.disposeAll();
        document.getElementById('dashboard').hidden = true;
        const root = document.getElementById('companionStudy'); root.hidden = false; document.body.classList.add('companion-mode');
        document.getElementById('companionBirthdayCard').hidden = true;
        preloadCompanionVoice();
        try {
            await Live2DModelManager.loadModels();
            modelListError = '';
        } catch (error) {
            modelListError = '读取角色绑定的 Live2D 模型失败：' + safeDiagnosticError(error);
            if (Live2DModelManager.markUnavailable) Live2DModelManager.markUnavailable(modelListError);
        }
        updateCompanionRoleLabels();
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
        const language = getCompanionLanguage();
        setMessage(language === 'ja' ? 'お誕生日おめでとう。今日も一緒に、やりたいことを大切に進めよう。' : '生日快乐！今天也一起把想做的事认真完成吧。', 'celebrate', language);
        document.getElementById('companionBirthdayBadge').hidden = false;
    }
    function showBirthdayCard() {
        const day = new Date();
        const key = 'memo_anon_birthday_milestone_' + day.getFullYear() + '-' + String(day.getMonth() + 1).padStart(2, '0') + '-' + String(day.getDate()).padStart(2, '0');
        try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) {}
        const card = document.getElementById('companionBirthdayCard');
        const language = getCompanionLanguage();
        const text = document.getElementById('companionBirthdayCardText');
        const closeButton = document.getElementById('closeCompanionBirthdayCard');
        if (card) {
            card.hidden = false;
            if (typeof card.setAttribute === 'function') card.setAttribute('aria-label', language === 'ja' ? '愛音の誕生日メモ' : 'Anon 生日纪念卡');
        }
        if (closeButton && typeof closeButton.setAttribute === 'function') closeButton.setAttribute('aria-label', language === 'ja' ? '誕生日メモを閉じる' : '关闭生日纪念卡');
        if (text) text.textContent = language === 'ja'
            ? '今日の最初の学習マイルストーンを達成！この頑張りを、愛音への小さなプレゼントにしよう。'
            : '今天的第一个学习里程碑完成！这份认真就当作送给爱音的小礼物吧。';
        playMood('celebrate');
    }
    function init() {
        const openButton = document.getElementById('companionModeBtn');
        if (!openButton || openButton.dataset.ready) return;
        openButton.dataset.ready = 'true';
        openButton.addEventListener('click', enter);
        attachRendererDiagnosticCopy();
        document.getElementById('exitCompanionModeBtn').addEventListener('click', exit);
        document.getElementById('companionAskBtn').addEventListener('click', function() { if (session) session.ask(); });
        document.getElementById('closeCompanionBirthdayCard').addEventListener('click', function() { document.getElementById('companionBirthdayCard').hidden = true; });
        window.addEventListener('companion-reminder-settings-changed', function() {
            if (session && session.refreshReminder) session.refreshReminder();
        });
        window.addEventListener('storage', function(event) {
            if (!event || (event.key && event.key !== COMPANION_REMINDER_ENABLED_STORAGE_KEY && event.key !== COMPANION_REMINDER_MINUTES_STORAGE_KEY)) return;
            if (session && session.refreshReminder) session.refreshReminder();
        });
        window.addEventListener('resize', function() { if (open) scheduleRendererReload(180); });
        const companionHost = document.getElementById('companionLive2DHost');
        const companionCanvas = document.getElementById('companionLive2DCanvas');
        if (companionHost) companionHost.addEventListener('pointerup', handleCharacterTouch);
        if (companionCanvas) companionCanvas.addEventListener('webglcontextlost', function(event) {
            event.preventDefault();
            rendererCapabilityCache = null;
            const fallback = document.getElementById('companionGifFallback');
            if (fallback) fallback.hidden = false;
            showRendererDiagnostic('L2D_WEBGL_CONTEXT_LOST', Live2DModelManager.current(), 'WebGL 上下文已丢失，正在尝试恢复', rendererCapabilities());
            destroyRenderer();
            if (open) scheduleRendererReload(260);
        });
        setInterval(function() { if (session) session.tick(); }, 60000);
        Live2DModelManager.attachSettings();
    }
    async function reloadModel() {
        rendererCapabilityCache = null;
        modelListError = '';
        updateCompanionRoleLabels();
        if (!open) return { ok: true, pending: true };
        destroyRenderer();
        return loadRenderer();
    }
    return {
        init: init, enter: enter, exit: exit, reloadModel: reloadModel,
        isOpen: function() { return open; },
        getRendererDiagnostic: function() { return lastRendererDiagnostic; }
    };
})();

// 顶层 const 绑定不是 window 属性；App.init() 和页面入口使用 window.*，
// 因此显式公开这三个模块。
window.Live2DModelManager = Live2DModelManager;
window.CompanionSession = CompanionSession;
window.Live2DCompanion = Live2DCompanion;
