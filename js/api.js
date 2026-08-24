// ==========================================
// Memo Superform - API 模块
// 封装墨墨背单词开放 API 和 AI API 调用
// 通过本地代理服务器解决 CORS 问题
// ==========================================

const MaimemoAPI = (function() {
    const PROXY_BASE = '/proxy/memo';
    let token = localStorage.getItem('maimemo_token') || '';
    
    const CACHE_PREFIX = 'memo_cache_';
    const CACHE_TTL = 30 * 60 * 1000;
    
    function setToken(newToken) {
        token = newToken;
        if (newToken) localStorage.setItem('maimemo_token', newToken);
        else localStorage.removeItem('maimemo_token');
    }
    
    function getToken() { return token; }
    function hasToken() { return token && token.length > 0; }
    
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
            if (key.startsWith(CACHE_PREFIX)) keys.push(key);
        }
        keys.forEach(k => localStorage.removeItem(k));
        return keys.length;
    }
    
    async function request(path, options = {}) {
        if (!token) throw new Error('请先配置墨墨 API Token');
        
        const url = PROXY_BASE + path;
        const config = {
            method: options.method || 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': 'Bearer ' + token,
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
        const cacheKey = 'study_progress_' + token.slice(-8);
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/study/get_study_progress', { method: 'POST', body: {} });
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    async function queryStudyRecords(params = {}, useCache = true) {
        const cacheKey = 'study_records_' + token.slice(-8) + '_' + JSON.stringify(params);
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/study/query_study_records', { method: 'POST', body: params });
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    // 分页拉取全部学习记录
    async function getAllStudyRecords(useCache = true, onProgress = null) {
        const cacheKey = 'all_study_records_v2_' + token.slice(-8);
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }

        const countData = await queryStudyRecords({ as_count: true }, false);
        const total = countData.count || 0;
        if (total === 0) return [];

        // 去重辅助
        function dedupe(records) {
            const seen = new Set();
            const out = [];
            for (const r of records) {
                const key = r.voc_id + '|' + r.next_study_date;
                if (!seen.has(key)) {
                    seen.add(key);
                    out.push(r);
                }
            }
            return out;
        }

        // 拉取一段区间；若单次返回满 1000 条（可能被截断），二分递归
        async function fetchSegment(startStr, endStr, depth) {
            depth = depth || 0;
            // 护栏1：递归深度上限，防止极端情况下栈溢出
            if (depth > 60) {
                console.warn('[fetchSegment] 达到深度上限 60，停止二分');
                return [];
            }
            // 控制请求频率，避免触发 API 限流（10秒20次）
            await new Promise(resolve => setTimeout(resolve, 300));
            const result = await queryStudyRecords({
                next_study_date: { start: startStr, end: endStr },
                limit: 1000
            }, false);
            const recs = result.records || [];
            if (recs.length < 1000) return recs;

            const start = new Date(startStr);
            const end = new Date(endStr);
            // 护栏2：区间细分到不足1天（next_study_date 为天粒度，再分无意义），转 offset 分页
            if (end.getTime() - start.getTime() < 86400000) {
                return await fetchByOffset([startStr, endStr]);
            }
            const mid = new Date((start.getTime() + end.getTime()) / 2);
            const left = await fetchSegment(start.toISOString(), mid.toISOString(), depth + 1);
            const right = await fetchSegment(mid.toISOString(), end.toISOString(), depth + 1);
            return left.concat(right);
        }

        // offset 分页兜底：当某个时间点/极小区间内单词 >=1000，二分已失效时逐页拉取
        async function fetchByOffset(dateRange) {
            const all = [];
            let offset = 0;
            let lastSig = null;
            // 防御：最多拉 200 页（20万词），避免异常时无限循环
            while (offset < 200000) {
                await new Promise(resolve => setTimeout(resolve, 300));
                const params = { limit: 1000, offset: offset };
                if (dateRange) params.next_study_date = { start: dateRange[0], end: dateRange[1] };
                const result = await queryStudyRecords(params, false);
                const recs = result.records || [];
                if (recs.length === 0) break;
                // 护栏3：进展检测。若 offset 不被支持，返回的会与上一页相同 -> 停止
                const sig = recs.map(function (r) { return r.voc_id + '|' + r.next_study_date; }).sort().join(',');
                if (sig === lastSig) {
                    console.warn('[fetchByOffset] offset 未生效（返回相同数据），停止分页，该区间已截断');
                    break;
                }
                for (const r of recs) all.push(r);
                lastSig = sig;
                if (recs.length < 1000) break;
                offset += 1000;
            }
            return all;
        }

        // next_study_date 可能从很早到 2100+：
        // 按大段拉取（跳过大概率空的 2020-2025 等），满 1000 的段自动二分
        const allRecords = [];
        const ranges = [
            ['2020-01-01T00:00:00', '2025-12-31T23:59:59'],
            ['2026-01-01T00:00:00', '2026-12-31T23:59:59'],
            ['2027-01-01T00:00:00', '2027-12-31T23:59:59'],
            ['2028-01-01T00:00:00', '2028-12-31T23:59:59'],
            ['2029-01-01T00:00:00', '2030-12-31T23:59:59'],
            ['2031-01-01T00:00:00', '2200-12-31T23:59:59']
        ];
        for (const [startStr, endStr] of ranges) {
            const rangeRecs = await fetchSegment(startStr, endStr);
            allRecords.push(...rangeRecs);
            if (onProgress) onProgress(allRecords.length, total);
            if (allRecords.length >= total) break;
        }

        // 兜底：若还是没拉全，直接拉一次全量
        // 补拉：无日期过滤，覆盖 next_study_date 为空/超范围的记录
        const catchAll = await fetchByOffset(null);
        for (const r of catchAll) allRecords.push(r);
        if (onProgress) onProgress(allRecords.length, total);

        // 去重后返回
        const uniqueRecords = dedupe(allRecords);
        if (uniqueRecords.length < total) {
            console.warn('[getAllStudyRecords] 拉取数量不足 total:', uniqueRecords.length, '/', total);
        }
        if (useCache) setCache(cacheKey, uniqueRecords);
        return uniqueRecords;
    }
    
    // 按时间范围从学习记录中提取单词
    // dateField: 'add_date' | 'first_study_date' | 'last_study_date'
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
        const cacheKey = 'notepads_' + token.slice(-8) + '_' + limit + '_' + offset;
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/notepads?limit=' + limit + '&offset=' + offset);
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    async function listAllNotepads(useCache = true) {
        const cacheKey = 'all_notepads_' + token.slice(-8);
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
        const cacheKey = 'notepad_' + token.slice(-8) + '_' + id;
        if (useCache) { const c = getCache(cacheKey); if (c) return c; }
        const data = await request('/notepads/' + id);
        if (useCache) setCache(cacheKey, data);
        return data;
    }
    
    async function getAllNotepadWords(useCache = true) {
        const cacheKey = 'all_notepad_words_' + token.slice(-8);
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
        const originalToken = token;
        token = testToken;
        try {
            const data = await getStudyProgress(false);
            token = originalToken;
            return { success: true, data: data };
        } catch (e) {
            token = originalToken;
            return { success: false, error: e.message };
        }
    }
    
    return {
        setToken, getToken, hasToken, clearCache,
        getStudyProgress, queryStudyRecords, getAllStudyRecords,
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
// 智能推荐 API 模块（本地 SQL Server）
// ==========================================
const RecommendAPI = (function() {
    async function getToday() {
        const resp = await fetch('/api/recommendations/today');
        if (!resp.ok) throw new Error('获取推荐失败: ' + resp.status);
        return resp.json();
    }
    async function markReviewed(id) {
        const resp = await fetch('/api/recommendations/' + id + '/review', { method: 'POST', headers: { 'X-Requested-With': 'XMLHttpRequest' } });
        return resp.ok;
    }
    async function saveSnapshot(records, force) {
        const resp = await fetch('/api/snapshot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
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
