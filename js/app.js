// ==========================================
// Memo Superform - 应用入口
// ==========================================

const App = (function() {
    let isLoading = false;
    let proxyOnline = false;
    
    // ---- 自动刷新状态 ----
    let autoRefreshTimer = null;
    let countdownTimer = null;
    let nextRefreshTime = 0;
    let pendingRefresh = false;
    let autoRefreshEnabled = localStorage.getItem('auto_refresh_enabled') !== 'false';
    let autoRefreshInterval = parseInt(localStorage.getItem('auto_refresh_interval') || '10', 10);
    
    function init() {
        setupSettingsPanel();
        setupRefreshButton();
        setupServerStatusCheck();
        setupAIClassifyButton();
        setupTheme();
        LayoutManager.init();
        setupAutoRefresh();
        
        checkProxyServer().then(online => {
            if (online && MaimemoAPI.hasToken()) {
                hideWelcome();
                loadAllData();
            } else {
                showWelcome();
            }
        });
    }

    // ---- 明暗主题切换 ----

    function setupTheme() {
        // 恢复上次的主题偏好
        const saved = localStorage.getItem('theme') || 'light';
        document.body.classList.toggle('dark', saved === 'dark');
        updateThemeIcon();

        document.getElementById('themeBtn').addEventListener('click', function() {
            const dark = document.body.classList.toggle('dark');
            localStorage.setItem('theme', dark ? 'dark' : 'light');
            updateThemeIcon();
            // 重绘所有图表以适配新主题的文字颜色
            ChartManager.renderAll();
        });
    }

    function updateThemeIcon() {
        const dark = document.body.classList.contains('dark');
        const sun = document.getElementById('iconSun');
        const moon = document.getElementById('iconMoon');
        if (sun) sun.style.display = dark ? '' : 'none';
        if (moon) moon.style.display = dark ? 'none' : '';
    }
    
    // ---- 代理服务器检查 ----
    
    async function checkProxyServer() {
        const el = document.getElementById('serverStatus');
        if (el) el.className = 'server-status checking';
        try {
            const resp = await fetch('/css/style.css', { method: 'HEAD' });
            proxyOnline = resp.ok;
        } catch (e) { proxyOnline = false; }
        if (el) {
            el.className = proxyOnline ? 'server-status online' : 'server-status offline';
            el.textContent = proxyOnline ? '● 代理服务正常' : '● 代理服务离线';
        }
        return proxyOnline;
    }
    
    function setupServerStatusCheck() {
        const el = document.getElementById('serverStatus');
        if (el) el.addEventListener('click', function() {
            if (!proxyOnline) alert('代理服务器未启动！\n\n请在项目目录下运行：\n  python server.py\n\n然后访问 http://localhost:8888');
        });
    }
    
    function showWelcome() { document.getElementById('welcomeOverlay').classList.remove('hidden'); }
    function hideWelcome() { document.getElementById('welcomeOverlay').classList.add('hidden'); }
    
    // ---- 设置面板 ----
    
    function setupSettingsPanel() {
        const panel = document.getElementById('settingsPanel');
        document.getElementById('settingsBtn').addEventListener('click', openSettings);
        document.getElementById('welcomeSettingsBtn').addEventListener('click', function() {
            hideWelcome(); openSettings();
        });
        document.getElementById('closeSettings').addEventListener('click', closeSettings);
        panel.querySelector('.settings-overlay').addEventListener('click', closeSettings);
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && panel.classList.contains('show')) closeSettings();
        });
        
        const token = MaimemoAPI.getToken();
        if (token) document.getElementById('tokenInput').value = token;
        const aiConfig = AIAPI.getConfig();
        document.getElementById('aiEndpointInput').value = aiConfig.endpoint;
        document.getElementById('aiKeyInput').value = aiConfig.apiKey;
        document.getElementById('aiModelInput').value = aiConfig.model;
        
        document.getElementById('testTokenBtn').addEventListener('click', async function() {
            const testToken = document.getElementById('tokenInput').value.trim();
            const statusEl = document.getElementById('tokenStatus');
            if (!testToken) { statusEl.textContent = '请输入 Token'; statusEl.className = 'status-text error'; return; }
            if (!proxyOnline) { statusEl.textContent = '代理服务器未启动'; statusEl.className = 'status-text error'; return; }
            
            statusEl.textContent = '测试中...'; statusEl.className = 'status-text';
            this.disabled = true;
            try {
                const result = await MaimemoAPI.testToken(testToken);
                if (result.success) {
                    const p = result.data.progress || result.data;
                    statusEl.textContent = '✓ 连接成功！今日进度: ' + p.finished + '/' + p.total;
                    statusEl.className = 'status-text success';
                } else {
                    statusEl.textContent = '✗ ' + result.error;
                    statusEl.className = 'status-text error';
                }
            } catch (e) {
                statusEl.textContent = '✗ ' + e.message;
                statusEl.className = 'status-text error';
            }
            this.disabled = false;
        });
        
        document.getElementById('clearCacheBtn').addEventListener('click', function() {
            const count = MaimemoAPI.clearCache();
            const aiCache = localStorage.getItem('ai_classification_cache');
            if (aiCache) localStorage.removeItem('ai_classification_cache');
            alert('已清除 ' + count + ' 条缓存数据');
        });
        
        document.getElementById('saveSettingsBtn').addEventListener('click', function() {
            const token = document.getElementById('tokenInput').value.trim();
            const oldToken = MaimemoAPI.getToken();
            MaimemoAPI.setToken(token);
            AIAPI.setConfig({
                endpoint: document.getElementById('aiEndpointInput').value.trim(),
                apiKey: document.getElementById('aiKeyInput').value.trim(),
                model: document.getElementById('aiModelInput').value.trim()
            });
            closeSettings();
            if (token) { hideWelcome(); if (token !== oldToken) loadAllData(); }
            else showWelcome();
        });
    }
    
    function openSettings() { document.getElementById('settingsPanel').classList.add('show'); }
    function closeSettings() { document.getElementById('settingsPanel').classList.remove('show'); }
    
    // ---- AI 分类按钮（事件委托）----
    
    function setupAIClassifyButton() {
        document.addEventListener('click', async function(e) {
            const btn = e.target.closest('.ai-btn');
            if (!btn) return;
            
            const tile = btn.closest('.tile');
            const toolbar = btn.closest('.ai-toolbar');
            const statusEl = toolbar ? toolbar.querySelector('.ai-status') : null;
            
            if (!AIAPI.hasConfig()) {
                alert('请先在设置中配置 AI API Key');
                openSettings();
                return;
            }
            
            // 读取数据源配置
            let dataSource = 'notepad';
            let startDate = null, endDate = null, dateField = 'last_study_date';
            
            if (toolbar) {
                const sourceSelect = toolbar.querySelector('.ai-source-select');
                if (sourceSelect) dataSource = sourceSelect.value;
                
                const startInput = toolbar.querySelector('.ai-date-start');
                const endInput = toolbar.querySelector('.ai-date-end');
                const fieldSelect = toolbar.querySelector('.ai-date-field');
                
                if (startInput) startDate = startInput.value;
                if (endInput) endDate = endInput.value;
                if (fieldSelect) dateField = fieldSelect.value;
            }
            
            btn.disabled = true;

            try {
                let words = [];

                // 构造本次分类的缓存标识
                const cacheKey = dataSource === 'study'
                    ? 'study_' + startDate + '_' + endDate + '_' + dateField
                    : 'notepad';

                // 命中缓存则直接使用，不重复调用 AI
                const aiCacheRaw = localStorage.getItem('ai_classification_cache');
                if (aiCacheRaw) {
                    try {
                        const cached = JSON.parse(aiCacheRaw);
                        if (cached.key === cacheKey &&
                            Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000) {
                            ChartManager.setAIClassification(cached.data);
                            document.querySelectorAll('.tile').forEach(t => {
                                const index = parseInt(t.dataset.tile);
                                if (ChartManager.getChartType(index) === 'aiclass') {
                                    ChartManager.render(index, 'aiclass');
                                }
                            });
                            if (statusEl) {
                                statusEl.textContent = '✓ 使用缓存结果（' + cached.wordCount + ' 个单词）';
                                setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 3000);
                            }
                            btn.disabled = false;
                            return;
                        }
                    } catch (e) {}
                }
                
                if (dataSource === 'study') {
                    // 从学习记录中按时间范围获取单词
                    if (statusEl) statusEl.textContent = '正在拉取学习记录（首次约需 10-20 秒）...';
                    
                    if (!startDate || !endDate) {
                        if (statusEl) statusEl.textContent = '请选择时间范围';
                        btn.disabled = false;
                        return;
                    }
                    
                    words = await MaimemoAPI.getWordsFromStudyRecords(
                        startDate, endDate, dateField, true,
                        function(current, total) {
                            if (statusEl) {
                                statusEl.textContent = '正在拉取学习记录 ' + current + '/' + total + ' ...';
                            }
                        }
                    );
                    
                    if (statusEl) statusEl.textContent = `找到 ${words.length} 个单词（${startDate} ~ ${endDate}），正在调用 AI 分类...`;
                } else {
                    // 从云词本获取单词
                    if (statusEl) statusEl.textContent = '正在获取云词本单词...';
                    words = await MaimemoAPI.getAllNotepadWords();
                    
                    if (statusEl) statusEl.textContent = `找到 ${words.length} 个单词，正在调用 AI 分类...`;
                }
                
                if (words.length === 0) {
                    if (statusEl) statusEl.textContent = dataSource === 'study' 
                        ? '该时间范围内没有学习记录' 
                        : '你的云词本里还没有单词';
                    btn.disabled = false;
                    return;
                }
                
                // 调用 AI 分类
                const wordList = words.map(w => w.word || w);
                const classification = await AIAPI.classifyWords(wordList);
                
                // 缓存结果
                localStorage.setItem('ai_classification_cache', JSON.stringify({
                    data: classification,
                    timestamp: Date.now(),
                    wordCount: words.length,
                    source: dataSource,
                    startDate: startDate,
                    endDate: endDate,
                    key: cacheKey
                }));
                
                ChartManager.setAIClassification(classification);
                
                // 重新渲染所有 AI 分类图表
                document.querySelectorAll('.tile').forEach(t => {
                    const index = parseInt(t.dataset.tile);
                    if (ChartManager.getChartType(index) === 'aiclass') {
                        ChartManager.render(index, 'aiclass');
                    }
                });
                
                if (statusEl) {
                    const sourceLabel = dataSource === 'study' 
                        ? `（${startDate} ~ ${endDate}）` 
                        : '（云词本）';
                    statusEl.textContent = `✓ 分类完成，${words.length} 个单词${sourceLabel}`;
                    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
                }
                
            } catch (e) {
                if (statusEl) statusEl.textContent = '✗ ' + e.message;
                console.error('AI 分类失败:', e);
            }
            
            btn.disabled = false;
        });
    }
    
    // ---- 刷新按钮 ----
    
    function setupRefreshButton() {
        document.getElementById('refreshBtn').addEventListener('click', function() {
            checkProxyServer().then(online => {
                if (online) loadAllData(true);
                else alert('代理服务器未启动！\n\n请在项目目录下运行：\n  python server.py');
            });
        });
    }
    
    // ---- 自动刷新 ----
    
    function setupAutoRefresh() {
        // 拖拽结束回调：拖拽期间跳过的刷新，在拖拽完成后补刷
        LayoutManager.setDragEndCallback(function() {
            if (pendingRefresh) {
                pendingRefresh = false;
                doDeferredRefresh();
            }
        });
        
        var toggle = document.getElementById('autoRefreshToggle');
        var select = document.getElementById('autoRefreshInterval');
        
        toggle.classList.toggle('active', autoRefreshEnabled);
        select.value = String(autoRefreshInterval);
        
        toggle.addEventListener('click', function() {
            autoRefreshEnabled = !autoRefreshEnabled;
            localStorage.setItem('auto_refresh_enabled', autoRefreshEnabled ? 'true' : 'false');
            toggle.classList.toggle('active', autoRefreshEnabled);
            if (autoRefreshEnabled) {
                startAutoRefresh();
            } else {
                stopAutoRefresh();
            }
        });
        
        select.addEventListener('change', function() {
            autoRefreshInterval = parseInt(this.value, 10);
            localStorage.setItem('auto_refresh_interval', String(autoRefreshInterval));
            if (autoRefreshEnabled) {
                startAutoRefresh();
            }
        });
        
        if (autoRefreshEnabled) {
            startAutoRefresh();
        } else {
            updateCountdown();
        }
    }
    
    function startAutoRefresh() {
        stopAutoRefresh();
        nextRefreshTime = Date.now() + autoRefreshInterval * 60 * 1000;
        autoRefreshTimer = setInterval(function() {
            if (LayoutManager.isDragging()) {
                pendingRefresh = true;
                return;
            }
            doAutoRefresh();
        }, autoRefreshInterval * 60 * 1000);
        countdownTimer = setInterval(updateCountdown, 1000);
        updateCountdown();
    }
    
    function stopAutoRefresh() {
        if (autoRefreshTimer) { clearInterval(autoRefreshTimer); autoRefreshTimer = null; }
        if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
        updateCountdown();
    }
    
    var pendingRecords = null;

    async function doAutoRefresh() {
        if (isLoading) return;
        if (!proxyOnline) return;
        var toggle = document.getElementById('autoRefreshToggle');
        if (toggle) toggle.classList.add('refreshing');
        isLoading = true;
        try {
            var records = await MaimemoAPI.getAllStudyRecords(false);
            // await 返回后可能用户已经开始新一轮拖拽，此时重绘会导致 DOM 与图表错位
            // 先保存数据，若正在拖拽则延迟到拖拽结束后再重绘
            if (LayoutManager.isDragging()) {
                pendingRecords = records;
                pendingRefresh = true;
                return;
            }
            ChartManager.setRecords(records);
            ChartManager.renderVisibleFromSelectors(true);
            nextRefreshTime = Date.now() + autoRefreshInterval * 60 * 1000;
            updateCountdown();
        } catch (e) {
            console.warn('自动刷新失败:', e);
        } finally {
            isLoading = false;
            if (toggle) toggle.classList.remove('refreshing');
        }
    }

    // 拖拽结束后补刷：如果数据已拉取完成，直接重绘（无需重新请求 API）
    function doDeferredRefresh() {
        if (pendingRecords) {
            ChartManager.setRecords(pendingRecords);
            pendingRecords = null;
        }
        ChartManager.renderVisibleFromSelectors(true);
        nextRefreshTime = Date.now() + autoRefreshInterval * 60 * 1000;
        updateCountdown();
    }
    
    function updateCountdown() {
        var el = document.getElementById('autoRefreshCountdown');
        if (!el) return;
        if (!autoRefreshEnabled) {
            el.textContent = '已暂停';
            el.classList.add('paused');
            return;
        }
        el.classList.remove('paused');
        var remaining = Math.max(0, nextRefreshTime - Date.now());
        var mins = Math.floor(remaining / 60000);
        var secs = Math.floor((remaining % 60000) / 1000);
        el.textContent = mins + ':' + String(secs).padStart(2, '0');
    }
        // ---- 加载所有数据 ----
    
    async function loadAllData(forceRefresh = false) {
        if (isLoading) return;
        isLoading = true;
        document.querySelectorAll('.chart-container').forEach(el => el.classList.add('loading'));
        
        try {
            const records = await MaimemoAPI.getAllStudyRecords(!forceRefresh);
            ChartManager.setRecords(records);

            // 预取云词本单词，供词书进度图使用
            try {
                const notepadWords = await MaimemoAPI.getAllNotepadWords();
                ChartManager.setNotepadWords(notepadWords);
            } catch (e) {
                console.warn('加载云词本失败:', e.message);
            }
            
            const aiCache = localStorage.getItem('ai_classification_cache');
            if (aiCache) {
                try {
                    const cached = JSON.parse(aiCache);
                    if (Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000) {
                        ChartManager.setAIClassification(cached.data);
                    }
                } catch (e) {}
            }
            
            // 根据磁贴下拉框的实际值渲染，确保标题与内容一致
            setTimeout(function() {
                ChartManager.renderVisibleFromSelectors(false);
            }, 100);
        } catch (e) {
            console.error('加载数据失败:', e);
            alert('加载数据失败: ' + e.message + '\n\n请检查：\n1. 代理服务器是否已启动\n2. Token 是否正确');
        } finally {
            isLoading = false;
            document.querySelectorAll('.chart-container').forEach(el => el.classList.remove('loading'));
        }
    }
    
    return { init };
})();

document.addEventListener('DOMContentLoaded', function() { App.init(); });
