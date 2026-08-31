// ==========================================
// Memo Superform - API 模块
// 封装墨墨背单词开放 API 和 AI API 调用
// 通过本地代理服务器解决 CORS 问题
// ==========================================

const MaimemoAPI = (function() {
    const PROXY_BASE = '/proxy/memo';
    // 令牌只保存在 Windows DPAPI 本机凭据库；网页脚本从不保留或读取令牌明文。
    let connection = { connected: false, mode: '', profile_id: '' };
    
    const CACHE_PREFIX = 'memo_cache_';
    const CACHE_TTL = 30 * 60 * 1000;
    
    function cacheScope() {
        return String(connection.profile_id || 'disconnected').slice(-16);
    }

    async function authRequest(path, options = {}) {
        const hasBody = options.body !== undefined;
        const response = await fetch(path, {
            method: options.method || 'GET',
            headers: {
                'Accept': 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                ...(hasBody ? { 'Content-Type': 'application/json' } : {})
            },
            ...(hasBody ? { body: JSON.stringify(options.body) } : {})
        });
        const data = await response.json().catch(function() { return {}; });
        if (!response.ok) throw new Error(data.error || ('账号服务错误: ' + response.status));
        return data;
    }

    async function refreshConnection() {
        connection = await authRequest('/api/maimemo-auth/status');
        return connection;
    }

    async function bootstrap() {
        // 仅迁移旧版本遗留的 localStorage Token。迁移完成即删除浏览器副本，
        // 后续请求由本机服务自动附加 Authorization。
        const legacyToken = localStorage.getItem('maimemo_token') || '';
        if (legacyToken.trim()) {
            await authRequest('/api/maimemo-auth/manual-token', {
                method: 'POST', body: { token: legacyToken.trim() }
            });
            localStorage.removeItem('maimemo_token');
        }
        return refreshConnection();
    }

    async function connect() {
        return authRequest('/api/maimemo-auth/start', { method: 'POST', body: {} });
    }

    async function saveManualToken(value) {
        connection = await authRequest('/api/maimemo-auth/manual-token', {
            method: 'POST', body: { token: String(value || '').trim() }
        });
        return connection;
    }

    async function disconnect() {
        const result = await authRequest('/api/maimemo-auth/disconnect', { method: 'POST', body: {} });
        connection = { connected: false, mode: '', profile_id: '' };
        return result;
    }

    async function deleteLocalData() {
        return authRequest('/api/maimemo-auth/data', { method: 'DELETE' });
    }

    // 供尚未迁移的角色/Live2D 代码检测使用；始终为空，避免浏览器侧重新泄漏 token。
    function getToken() { return ''; }
    function hasToken() { return Boolean(connection.connected); }
    
    function getCache(key) {
        try {
            const cached = localStorage.getItem(CACHE_PREFIX + key);
            if (cached) {
                const data = JSON.parse(cached);
                // 学习记录缓存给更长的有效期（2 小时），因为学习数据不会频繁变化
                const ttl = key.startsWith('all_study_records_') ? 2 * 60 * 60 * 1000 : CACHE_TTL;
                if (Date.now() - data.timestamp < ttl) return data.value;
                localStorage.removeItem(CACHE_PREFIX + key);
            }
        } catch (e) {}
        return null;
    }
    
    function setCache(key, value) {
        try {
            localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ timestamp: Date.now(), value: value }));
        } catch (e) {}
    }
    
    function clearCache() {
        const keys = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            // 学习记录已迁移到本地 SQLite。保留旧浏览器基线，供首次迁移时校验，
            // “清除派生缓存”不会破坏它，更不会删除 SQLite 中的学习数据。
            if (key.startsWith(CACHE_PREFIX) &&
                !key.slice(CACHE_PREFIX.length).startsWith('all_study_records_')) {
                keys.push(key);
            }
        }
        keys.forEach(k => localStorage.removeItem(k));
        return keys.length;
    }
    
    async function request(path, options = {}) {
        if (!connection.connected) throw new Error('请先连接墨墨账号');
        
        const url = PROXY_BASE + path;
        const config = {
            method: options.method || 'GET',
            headers: {
                'Accept': 'application/json',
                ...(options.body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(options.body ? { body: JSON.stringify(options.body) } : {})
        };
        
        const response = await fetch(url, config);
        const json = await response.json();
        
        if (!response.ok || json.success === false) {
            let errMsg = 'API 错误: ' + response.status;
            if (json.errors && json.errors.length > 0) {
                errMsg = json.errors[0].msg || json.errors[0].code || errMsg;
                if (json.errors[0].info) errMsg += ' (' + json.errors[0].info + ')';
            }
            if (json.error) errMsg = json.error;
            throw new Error(errMsg);
        }
        
        return json.data !== undefined ? json.data : json;
    }
    
    // ---- 学习数据接口 ----
    
    async function getStudyProgress(useCache = true) {
        const cacheKey = 'study_progress_' + cacheScope();
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/study/get_study_progress', { method: 'POST', body: {} });
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    async function queryStudyRecords(params = {}, useCache = true) {
        const cacheKey = 'study_records_' + cacheScope() + '_' + JSON.stringify(params);
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/study/query_study_records', { method: 'POST', body: params });
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    // ---- 本地 SQLite 学习数据接口 ----
    // 学习记录的拉取、增量比对和限流统一由本地服务负责。前端只读取已提交的
    // SQLite 当前状态，因此自动刷新不会再把 2020-2022 等历史区间重新拉取一遍。
    function localHeaders(hasBody) {
        const headers = {
            'Accept': 'application/json',
            'X-Requested-With': 'XMLHttpRequest'
        };
        if (hasBody) headers['Content-Type'] = 'application/json';
        return headers;
    }

    async function localRequest(path, options = {}) {
        const hasBody = options.body !== undefined;
        const response = await fetch(path, {
            method: options.method || 'GET',
            headers: localHeaders(hasBody),
            ...(hasBody ? { body: JSON.stringify(options.body) } : {})
        });
        const payload = await response.json().catch(function() { return {}; });
        // 同步状态在 HTTP 200 中会携带最近一次任务的 error 字段；它是状态数据，
        // 不是本次本地请求失败。真正接口错误始终使用非 2xx 或 success:false。
        if (!response.ok || payload.success === false) {
            throw new Error(payload.error || payload.message || ('本地数据服务错误: ' + response.status));
        }
        return payload.data !== undefined ? payload.data : payload;
    }

    function normalizeStudyRecords(payload) {
        if (Array.isArray(payload)) return payload;
        if (payload && Array.isArray(payload.records)) return payload.records;
        return [];
    }

    // 旧版本可能保留过全量浏览器缓存。它只在 bootstrap 时作为一次性迁移种子，
    // 绝不再被当作运行期数据源，也不触发远端全量补拉。
    function getCachedStudyRecordSeed() {
        const candidates = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || !key.startsWith(CACHE_PREFIX + 'all_study_records_')) continue;
                const parsed = JSON.parse(localStorage.getItem(key) || '{}');
                const records = normalizeStudyRecords(parsed.value !== undefined ? parsed.value : parsed);
                if (records.length) candidates.push({ timestamp: Number(parsed.timestamp) || 0, records: records });
            }
        } catch (e) {
            console.warn('读取旧学习记录缓存失败:', e.message);
        }
        candidates.sort(function(a, b) { return b.timestamp - a.timestamp; });
        if (!candidates.length) return [];

        const seen = new Set();
        const valid = [];
        for (const record of candidates[0].records) {
            if (!record || record.voc_id === undefined || record.voc_id === null || record.voc_id === '') continue;
            const id = String(record.voc_id);
            if (seen.has(id)) continue;
            seen.add(id);
            valid.push(record);
        }
        return valid;
    }

    // 保持原公开名称和数组返回值。useCache 参数为旧调用方兼容保留；数据始终从
    // SQLite 读取，避免 localStorage 过期数据覆盖服务端的增量结果。
    async function getAllStudyRecords(useCache = true, onProgress = null) {
        const data = await localRequest('/api/study-records');
        const records = normalizeStudyRecords(data);
        if (onProgress) onProgress(records.length, records.length);
        return records;
    }

    async function startStudySync(mode = 'incremental', options = {}) {
        const allowed = ['incremental', 'reconcile', 'bootstrap'];
        if (!allowed.includes(mode)) throw new Error('未知数据更新模式: ' + mode);
        const body = { mode: mode, reason: options.reason || 'manual' };
        if (mode === 'bootstrap') {
            const seed = Array.isArray(options.seedRecords) ? options.seedRecords : getCachedStudyRecordSeed();
            if (seed.length) body.seed_records = seed;
        }
        return localRequest('/api/study-sync', { method: 'POST', body: body });
    }

    async function getStudySyncStatus() {
        return localRequest('/api/study-sync/status');
    }

    async function cancelStudySync() {
        return localRequest('/api/study-sync/current', { method: 'DELETE' });
    }

    // 按时间范围从学习记录中提取单词
    // dateField 可选值：'add_date' | 'first_study_date' | 'last_study_date'
    async function getWordsFromStudyRecords(startDate, endDate, dateField, useCache, onProgress) {
        const allRecords = await getAllStudyRecords(useCache !== false, onProgress);
        
        // 将日期字符串转为时间戳用于比较
        const startTime = new Date(startDate + 'T00:00:00+08:00').getTime();
        const endTime = new Date(endDate + 'T23:59:59+08:00').getTime();
        
        const wordMap = {};
        const words = [];
        
        for (const record of allRecords) {
            const dateStr = record[dateField];
            if (!dateStr) continue;
            
            const recordTime = new Date(dateStr).getTime();
            if (recordTime >= startTime && recordTime <= endTime) {
                const word = (record.voc_spelling || '').toLowerCase().trim();
                if (word && !wordMap[word]) {
                    wordMap[word] = true;
                    words.push({
                        word: word,
                        study_count: record.study_count || 0,
                        last_response: record.last_response || '',
                        date: dateStr
                    });
                }
            }
        }
        
        return words;
    }
    
    // ---- 云词本接口 ----
    
    // 获取今日学习单词（公测接口）
      async function listNotepads(limit = 10, offset = 0, useCache = true) {
        if (limit > 10) limit = 10;
        const cacheKey = 'notepads_' + cacheScope() + '_' + limit + '_' + offset;
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/notepads?limit=' + limit + '&offset=' + offset);
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    async function listAllNotepads(useCache = true) {
        const cacheKey = 'all_notepads_' + cacheScope();
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        
        const allNotepads = [];
        let offset = 0;
        
        while (true) {
            const data = await listNotepads(10, offset, false);
            const notepads = data.notepads || [];
            allNotepads.push(...notepads);
            if (notepads.length < 10) break;
            offset += 10;
            if (offset >= 100) break;
        }
        
        if (useCache) setCache(cacheKey, allNotepads);
        return allNotepads;
    }
    
    async function getNotepad(id, useCache = true) {
        const cacheKey = 'notepad_' + cacheScope() + '_' + id;
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/notepads/' + id);
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    async function getAllNotepadWords(useCache = true) {
        const cacheKey = 'all_notepad_words_' + cacheScope();
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        
        const notepads = await listAllNotepads(false);
        const allWords = [];
        const wordMap = {};
        
        for (const np of notepads) {
            try {
                const detail = await getNotepad(np.id, false);
                if (detail.notepad && detail.notepad.list) {
                    for (const item of detail.notepad.list) {
                        if ((item.type === 'WORD' || item.type === 'DRAFT_WORD') && item.word) {
                            const word = item.word.toLowerCase().trim();
                            if (word && !wordMap[word]) {
                                wordMap[word] = true;
                                allWords.push({ word: word, notepad: np.title });
                            }
                        }
                    }
                }
            } catch (e) {
                console.warn('获取云词本失败:', np.title, e.message);
            }
        }
        
        if (useCache) setCache(cacheKey, allWords);
        return allWords;
    }
    
      
    async function testToken(testToken) {
        try {
            if (testToken) await saveManualToken(testToken);
            const data = await getStudyProgress(false);
            return { success: true, data: data };
        } catch (e) {
            return { success: false, error: e.message };
        }
    }
    
    return {
        bootstrap, refreshConnection, connect, saveManualToken, disconnect, deleteLocalData,
        getToken, hasToken, clearCache,
        getStudyProgress, queryStudyRecords, getAllStudyRecords,
        startStudySync, getStudySyncStatus, cancelStudySync,
        getWordsFromStudyRecords,
        listNotepads, listAllNotepads, getNotepad, getAllNotepadWords,
        testToken
    };
})();

// ==========================================
// AI API 模块
// ==========================================

const AIAPI = (function() {
    function getConfig() {
        return {
            provider: localStorage.getItem('ai_provider') || 'openai-compatible',
            endpoint: localStorage.getItem('ai_endpoint') || 'https://api.deepseek.com/v1',
            apiKey: localStorage.getItem('ai_key') || '',
            model: localStorage.getItem('ai_model') || 'deepseek-chat'
        };
    }
    
    function setConfig(config) {
        if (config.provider !== undefined) localStorage.setItem('ai_provider', config.provider);
        if (config.endpoint !== undefined) localStorage.setItem('ai_endpoint', config.endpoint);
        if (config.apiKey !== undefined) localStorage.setItem('ai_key', config.apiKey);
        if (config.model !== undefined) localStorage.setItem('ai_model', config.model);
    }
    
    function hasConfig() {
        const config = getConfig();
        return config.provider === 'codex' || (config.apiKey && config.apiKey.length > 0);
    }
    
    async function classifyWords(words) {
        const config = getConfig();
        if (config.provider !== 'codex' && !config.apiKey) throw new Error('请先在设置中配置 AI API Key');
        
        const wordList = words.slice(0, 200).join(', ');
        const categories = [
            '科技与互联网', '商业与经济', '日常生活', '学术与教育',
            '情感与心理', '自然与环境', '政治与社会', '健康与医疗',
            '艺术与文化', '法律与军事', '其他'
        ];
        
        const prompt = '请将以下英语单词按照主题进行分类。\n\n单词列表：' + wordList + '\n\n分类类别：' + categories.join('、') + '\n\n要求：\n1. 只输出 JSON 格式，不要有任何其他文字\n2. JSON 格式：{"分类名": ["单词1", "单词2"], ...}\n3. 每个单词只分到一个类别\n4. 尽量覆盖所有单词\n5. 如果某个单词拿不准，分到"其他"类别';
        
        const response = await fetch('/proxy/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                provider: config.provider,
                endpoint: config.endpoint,
                apiKey: config.apiKey,
                body: {
                    model: config.model,
                    messages: [
                        { role: 'system', content: '你是一个专业的英语词汇分类专家，擅长将单词按主题分类。只输出 JSON，不要有任何解释。' },
                        { role: 'user', content: prompt }
                    ],
                    temperature: 0.3,
                    response_format: { type: 'json_object' }
                }
            })
        });
        
        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error('AI API 错误: ' + response.status + ' ' + (errData.error || ''));
        }
        
        const data = await response.json();
        if (data.error) throw new Error(data.error);
        
        const content = data.choices[0].message.content;
        try {
            return JSON.parse(content);
        } catch (e) {
            const match = content.match(/\{[\s\S]*\}/);
            if (match) return JSON.parse(match[0]);
            throw new Error('AI 返回的内容无法解析为 JSON');
        }
    }
    
        // 批量获取单词中文释义（AI翻译，带本地缓存）
    async function getWordDefinitions(words) {
        const DEF_CACHE = 'memo_wdef_';
        const result = {};
        const uncached = [];
        for (const w of words) {
            const key = DEF_CACHE + w.toLowerCase();
            const cached = localStorage.getItem(key);
            if (cached) {
                try { result[w] = JSON.parse(cached); continue; } catch(e) {}
            }
            uncached.push(w);
        }
        if (uncached.length === 0) return result;
        const config = getConfig();
        if (config.provider !== 'codex' && !config.apiKey) return result;
        for (let i = 0; i < uncached.length; i += 30) {
            const batch = uncached.slice(i, i + 30);
            const prompt = '请将以下英语单词翻译为中文，并返回JSON格式。\n\n单词列表：' + batch.join(', ') + '\n\n要求：\n1. 只输出JSON\n2. 格式：{"word": {"trans": "中文释义", "phonetic": "音标", "example": "英文例句"}}\n3. trans含词性如"n. 苹果"';
            try {
                const response = await fetch('/proxy/ai', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        provider: config.provider,
                        endpoint: config.endpoint, apiKey: config.apiKey,
                        body: {
                            model: config.model,
                            messages: [
                                { role: 'system', content: '你是专业英汉词典，只输出JSON。' },
                                { role: 'user', content: prompt }
                            ],
                            temperature: 0.3,
                            response_format: { type: 'json_object' }
                        }
                    })
                });
                if (!response.ok) continue;
                const data = await response.json();
                if (data.error) continue;
                const content = data.choices[0].message.content;
                let parsed;
                try { parsed = JSON.parse(content); }
                catch(e) { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else continue; }
                for (const w of batch) {
                    const def = parsed[w] || parsed[w.toLowerCase()];
                    if (def) { result[w] = def; localStorage.setItem(DEF_CACHE + w.toLowerCase(), JSON.stringify(def)); }
                }
            } catch(e) { console.warn('AI翻译失败:', e); }
        }
        return result;
    }

return { getConfig, setConfig, hasConfig, classifyWords, getWordDefinitions };
})();

// ==========================================
// 智能推荐 API 模块（本地 SQLite）
// ==========================================
const RecommendAPI = (function() {
    function authHeaders(extra) {
        const headers = Object.assign({}, extra || {});
        const token = MaimemoAPI.getToken();
        if (token) headers.Authorization = 'Bearer ' + token;
        return headers;
    }
    async function getToday() {
        const resp = await fetch('/api/recommendations/today', { headers: authHeaders() });
        if (!resp.ok) throw new Error('获取推荐失败: ' + resp.status);
        return resp.json();
    }
    async function markReviewed(id) {
        const resp = await fetch('/api/recommendations/' + id + '/review', {
            method: 'POST', headers: authHeaders({ 'X-Requested-With': 'XMLHttpRequest' })
        });
        return resp.ok;
    }
    async function saveSnapshot(records, force) {
        const resp = await fetch('/api/snapshot', {
            method: 'POST',
            headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
            body: JSON.stringify({ records: records, force: !!force })
        });
        const data = await resp.json().catch(function() { return {}; });
        if (!resp.ok || data.error) {
            throw new Error(data.error || ('保存快照失败: ' + resp.status));
        }
        return data;
    }
      return { getToday: getToday, markReviewed: markReviewed, saveSnapshot: saveSnapshot,  };
})();
