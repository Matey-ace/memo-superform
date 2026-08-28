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
    let pendingSyncAfterDrag = false;
    let pendingRecords = null;
    let notepadDataLoaded = false;
    let notepadDataPromise = null;
    const VALID_REFRESH_INTERVALS = [5, 10, 15, 30, 60];
    let autoRefreshEnabled = localStorage.getItem('auto_refresh_enabled') !== 'false';
    let autoRefreshInterval = parseInt(localStorage.getItem('auto_refresh_interval') || '10', 10);
    if (!VALID_REFRESH_INTERVALS.includes(autoRefreshInterval)) autoRefreshInterval = 10;

    function init() {
        setupSettingsPanel();
        setupModeSettings();
        setupTTSSettings();
        setupRefreshButton();
        setupServerStatusCheck();
        setupAIClassifyButton();
        setupTheme();
        LayoutManager.init();
        if (typeof Live2DCompanion !== 'undefined') Live2DCompanion.init();
        window.addEventListener('memo-study-sync-status', updateCountdown);
        StudySyncUI.init({ onRecordsChanged: handleStudyRecordsChanged });
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

    // ---- 运行模式设置 ----

    function setupModeSettings() {
        const modeText = document.getElementById('currentModeText');
        const modeSelect = document.getElementById('defaultModeSelect');
        const modeStatus = document.getElementById('modeStatus');

        fetch('/api/app/current-mode').then(r => r.json()).then(info => {
            const label = info.mode === 'desktop' ? '桌面模式' : '网页模式';
            if (modeText) {
                modeText.textContent = label + (info.is_frozen ? '（打包版）' : '（源码模式）');
            }
            if (modeSelect) modeSelect.value = info.mode;
        }).catch(() => {
            if (modeText) modeText.textContent = '无法获取当前模式';
        });

        const saveBtn = document.getElementById('setDefaultModeBtn');
        if (saveBtn) saveBtn.addEventListener('click', async function() {
            const mode = modeSelect.value;
            if (!modeStatus) return;
            modeStatus.textContent = '保存中...';
            modeStatus.className = 'status-text';
            try {
                const resp = await fetch('/api/app/set-default-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ mode: mode })
                });
                const data = await resp.json();
                if (resp.ok) {
                    modeStatus.textContent = '✓ 已保存，下次启动生效';
                    modeStatus.className = 'status-text success';
                } else {
                    modeStatus.textContent = '✗ ' + (data.error || '保存失败');
                    modeStatus.className = 'status-text error';
                }
            } catch (e) {
                modeStatus.textContent = '✗ ' + e.message;
                modeStatus.className = 'status-text error';
            }
        });

        const relaunchBtn = document.getElementById('relaunchModeBtn');
        if (relaunchBtn) relaunchBtn.addEventListener('click', async function() {
            const mode = modeSelect.value;
            if (!modeStatus) return;
            modeStatus.textContent = '正在重启到' + (mode === 'desktop' ? '桌面' : '网页') + '模式...';
            modeStatus.className = 'status-text';
            try {
                const resp = await fetch('/api/app/relaunch', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: JSON.stringify({ mode: mode })
                });
                const data = await resp.json();
                if (!resp.ok) {
                    modeStatus.textContent = '✗ ' + (data.error || '切换失败');
                    modeStatus.className = 'status-text error';
                }
            } catch (e) {
                modeStatus.textContent = '✗ ' + e.message;
                modeStatus.className = 'status-text error';
            }
        });
    }

    // ---- 明暗主题切换 ----

    function setupTheme() { MemoDashboard.setupTheme(function() { ChartManager.renderAll(); }); }

    // ---- 代理服务器检查 ----
    
    async function checkProxyServer() {
        const el = document.getElementById('serverStatus');
        if (el) el.className = 'server-status checking';
        try {
            const resp = await fetch('/index.html', { method: 'HEAD' });
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
        document.getElementById('aiProviderSelect').value = aiConfig.provider;
        document.getElementById('aiEndpointInput').value = aiConfig.endpoint;
        document.getElementById('aiKeyInput').value = aiConfig.apiKey;
        document.getElementById('aiModelInput').value = aiConfig.model;
        const uiStyleSelect = document.getElementById('uiStyleSelect');
        if (uiStyleSelect) uiStyleSelect.value = window.MemoUIStyle.name;

        const providerSelect = document.getElementById('aiProviderSelect');
        const codexBox = document.getElementById('codexAuthBox');
        const apiKeyFields = document.getElementById('aiApiKeyFields');
        const codexStatus = document.getElementById('codexStatus');
        const codexLoginBtn = document.getElementById('codexLoginBtn');
        const codexLogoutBtn = document.getElementById('codexLogoutBtn');
        let codexPollTimer = null;

        function syncProviderFields() {
            const codex = providerSelect.value === 'codex';
            codexBox.style.display = codex ? '' : 'none';
            apiKeyFields.style.display = codex ? 'none' : '';
            if (codex && (!document.getElementById('aiModelInput').value || document.getElementById('aiModelInput').value === 'deepseek-chat')) {
                document.getElementById('aiModelInput').value = 'gpt-5.6-terra';
            }
            if (codex) refreshCodexStatus();
        }

        async function refreshCodexStatus() {
            try {
                const resp = await fetch('/api/codex/status');
                const status = await resp.json();
                if (status.connected) {
                    codexStatus.textContent = '✓ 已登录' + (status.email ? ' · ' + status.email : '') + (status.plan ? ' · ' + status.plan : '');
                    codexStatus.className = 'status-text success';
                    codexLoginBtn.style.display = 'none';
                    codexLogoutBtn.style.display = '';
                    if (codexPollTimer) { clearInterval(codexPollTimer); codexPollTimer = null; }
                } else {
                    codexStatus.textContent = status.error ? '✗ ' + status.error : (status.pending ? '请在浏览器中完成登录...' : '尚未登录');
                    codexStatus.className = status.error ? 'status-text error' : 'hint';
                    codexLoginBtn.style.display = '';
                    codexLogoutBtn.style.display = 'none';
                }
            } catch (e) {
                codexStatus.textContent = '✗ ' + e.message;
                codexStatus.className = 'status-text error';
            }
        }

        providerSelect.addEventListener('change', syncProviderFields);
        codexLoginBtn.addEventListener('click', async function() {
            this.disabled = true;
            codexStatus.textContent = '正在启动登录...';
            try {
                const resp = await fetch('/api/codex/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                    body: '{}'
                });
                const data = await resp.json();
                if (!resp.ok) throw new Error(data.error || ('HTTP ' + resp.status));
                if (!data.opened) window.open(data.authorization_url, '_blank', 'noopener');
                codexStatus.textContent = '请在浏览器中完成登录...';
                if (codexPollTimer) clearInterval(codexPollTimer);
                codexPollTimer = setInterval(refreshCodexStatus, 1500);
            } catch (e) {
                codexStatus.textContent = '✗ ' + e.message;
                codexStatus.className = 'status-text error';
            }
            this.disabled = false;
        });
        codexLogoutBtn.addEventListener('click', async function() {
            await fetch('/api/codex/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
                body: '{}'
            });
            refreshCodexStatus();
        });
        syncProviderFields();
        
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
            alert('已清除 ' + count + ' 条派生缓存；本地学习数据保持不变');
        });
        
        document.getElementById('saveSettingsBtn').addEventListener('click', function() {
            const token = document.getElementById('tokenInput').value.trim();
            const oldToken = MaimemoAPI.getToken();
            const nextStyle = uiStyleSelect ? uiStyleSelect.value : window.MemoUIStyle.name;
            MaimemoAPI.setToken(token);
            AIAPI.setConfig({
                provider: document.getElementById('aiProviderSelect').value,
                endpoint: document.getElementById('aiEndpointInput').value.trim(),
                apiKey: document.getElementById('aiKeyInput').value.trim(),
                model: document.getElementById('aiModelInput').value.trim()
            });
            if (nextStyle !== window.MemoUIStyle.name) {
                window.MemoUIStyle.save(nextStyle);
                location.replace('index.html');
                return;
            }
            closeSettings();
            if (token) {
                hideWelcome();
                if (token !== oldToken) {
                    resetStudyDataForProfileChange();
                    StudySyncUI.refreshStatus();
                    loadAllData();
                }
            } else {
                showWelcome();
            }
        });
    }
    
    function openSettings() {
        document.getElementById('settingsPanel').classList.add('show');
        if (typeof StudySyncUI !== 'undefined' && StudySyncUI) StudySyncUI.refreshStatus();
    }
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

                // 朗读 AI 分类结果
                const speakBtn = document.getElementById('aiSpeakBtn');
                const summaryText = `AI 单词分类完成，共 ${words.length} 个单词${dataSource === 'study' ? '' : '（云词本）'}`;
                if (window.TTS && TTS.isReady()) {
                    if (speakBtn) {
                        speakBtn.style.display = '';
                        speakBtn.onclick = function() { TTS.speak(summaryText); };
                    }
                    if (localStorage.getItem('tts_auto_read') === 'true') TTS.speak(summaryText);
                } else if (speakBtn) {
                    speakBtn.style.display = 'none';
                }
                
            } catch (e) {
                if (statusEl) statusEl.textContent = '✗ ' + e.message;
                console.error('AI 分类失败:', e);
            }
            
            btn.disabled = false;
        });
    }

    // ---- 语音功能设置 ----

    function setupTTSSettings() {
        // tts.js 未加载时跳过语音功能，避免阻断 App.init()
        if (!window.TTS) {
            const el = document.getElementById('ttsStatusText');
            if (el) el.textContent = '语音功能组件未加载（tts.js）';
            return;
        }
        const statusEl = document.getElementById('ttsStatusText');
        const actionEl = document.getElementById('ttsActionStatus');
        const enableBtn = document.getElementById('ttsEnableBtn');
        const preloadBtn = document.getElementById('ttsPreloadBtn');
        const repairBtn = document.getElementById('ttsRepairBtn');
        const voiceSelect = document.getElementById('ttsVoiceSelect');
        const speedRange = document.getElementById('ttsSpeedRange');
        const speedValue = document.getElementById('ttsSpeedValue');
        const autoRead = document.getElementById('ttsAutoRead');
        const companionRead = document.getElementById('ttsCompanionRead');

        let savedSpeed = parseFloat(localStorage.getItem('tts_speed') || '1.0');
        if (!Number.isFinite(savedSpeed) || savedSpeed < 0.5 || savedSpeed > 1.5) savedSpeed = 1.0;
        if (speedRange) speedRange.value = savedSpeed;
        if (speedValue) speedValue.textContent = savedSpeed.toFixed(1);
        if (autoRead) autoRead.checked = localStorage.getItem('tts_auto_read') === 'true';
        if (companionRead) {
            const savedCompanionRead = localStorage.getItem('tts_companion_enabled');
            // A freshly upgraded installation should not look fully enabled
            // while every character touch is intentionally silent.  Preserve
            // an explicit user opt-out, but enable companion speech by default.
            companionRead.checked = savedCompanionRead === null ? true : savedCompanionRead === 'true';
            if (savedCompanionRead === null) localStorage.setItem('tts_companion_enabled', 'true');
        }

        if (speedRange) speedRange.addEventListener('input', function() {
            const v = parseFloat(speedRange.value).toFixed(1);
            localStorage.setItem('tts_speed', v);
            if (speedValue) speedValue.textContent = v;
        });
        if (autoRead) autoRead.addEventListener('change', function() {
            localStorage.setItem('tts_auto_read', autoRead.checked ? 'true' : 'false');
        });
        if (companionRead) companionRead.addEventListener('change', function() {
            localStorage.setItem('tts_companion_enabled', companionRead.checked ? 'true' : 'false');
        });
        const fragRange = document.getElementById('ttsFragRange');
        const fragValue = document.getElementById('ttsFragValue');
        const topK = document.getElementById('ttsTopK');
        const splitSelect = document.getElementById('ttsSplitSelect');
        const seedInput = document.getElementById('ttsSeed');
        const cudaGraph = document.getElementById('ttsCudaGraph');
        const parallelInfer = document.getElementById('ttsParallelInfer');

        let savedFrag = Number(localStorage.getItem('tts_fragment_interval') || '0.5');
        if (!Number.isFinite(savedFrag) || savedFrag < 0 || savedFrag > 3) savedFrag = 0.5;
        if (fragRange) fragRange.value = savedFrag;
        if (fragValue) fragValue.textContent = savedFrag.toFixed(1);
        if (topK) topK.value = localStorage.getItem('tts_top_k') || '15';
        if (splitSelect) splitSelect.value = localStorage.getItem('tts_text_split_method') || 'cut0';
        if (seedInput) seedInput.value = localStorage.getItem('tts_seed') || '-1';
        if (cudaGraph) cudaGraph.checked = localStorage.getItem('tts_cuda_graph') === 'true';
        if (parallelInfer) parallelInfer.checked = localStorage.getItem('tts_parallel_infer') === 'true';

        if (fragRange) fragRange.addEventListener('input', function() {
            const v = parseFloat(fragRange.value).toFixed(1);
            localStorage.setItem('tts_fragment_interval', v);
            if (fragValue) fragValue.textContent = v;
        });
        if (topK) topK.addEventListener('change', function() {
            let v = parseInt(topK.value, 10);
            if (!Number.isFinite(v)) v = 15;
            v = Math.max(1, Math.min(100, v));
            topK.value = v;
            localStorage.setItem('tts_top_k', String(v));
        });
        if (splitSelect) splitSelect.addEventListener('change', function() {
            localStorage.setItem('tts_text_split_method', splitSelect.value);
        });
        if (seedInput) seedInput.addEventListener('change', function() {
            let v = parseInt(seedInput.value, 10);
            if (!Number.isFinite(v)) v = -1;
            seedInput.value = v;
            localStorage.setItem('tts_seed', String(v));
        });
        if (cudaGraph) cudaGraph.addEventListener('change', function() {
            localStorage.setItem('tts_cuda_graph', cudaGraph.checked ? 'true' : 'false');
        });
        if (parallelInfer) parallelInfer.addEventListener('change', function() {
            localStorage.setItem('tts_parallel_infer', parallelInfer.checked ? 'true' : 'false');
        });

        // ---- Explicit character role packages (TTS + reference + Live2D) ----
        let roleList = [], activeRoleId = '';
        const roleStatus = document.getElementById('ttsRoleStatus');
        const roleSelectionHint = document.getElementById('ttsRoleSelectionHint');
        const roleEditor = document.getElementById('ttsRoleEditor');
        const roleEditorContext = document.getElementById('ttsRoleEditorContext');
        const roleFileStatus = document.getElementById('ttsRoleFileStatus');
        const roleId = document.getElementById('ttsRoleId');
        const roleName = document.getElementById('ttsRoleName');
        const roleLive2D = document.getElementById('ttsRoleLive2D');
        const roleLanguage = document.getElementById('ttsRoleLanguage');
        const roleText = document.getElementById('ttsRoleReferenceText');
        const roleSaveButton = document.getElementById('ttsRoleSaveBtn');
        const roleFileInputIds = ['ttsRoleGptFile', 'ttsRoleSovitsFile', 'ttsRoleIndexFile', 'ttsRoleAudioFile'];
        const roleSaveLockIds = ['ttsRoleNewBtn', 'ttsRoleEditBtn', 'ttsRoleActivateBtn', 'ttsRoleDeleteBtn', 'ttsRoleCancelBtn',
            'ttsRoleName', 'ttsRoleLive2D', 'ttsRoleLanguage', 'ttsRoleReferenceText'].concat(roleFileInputIds);
        let roleSaveInFlight = false;
        let roleEditorOpen = false;
        let roleEditorRevision = 0;
        function roleHeaders(json) {
            const out = { 'X-Requested-With': 'XMLHttpRequest' };
            if (json) out['Content-Type'] = 'application/json';
            const token = window.MaimemoAPI && MaimemoAPI.getToken ? MaimemoAPI.getToken() : '';
            if (token) out.Authorization = 'Bearer ' + token;
            return out;
        }
        function roleMessage(text, error) {
            if (!roleStatus) return;
            roleStatus.textContent = text || '';
            roleStatus.className = error ? 'hint error' : 'hint';
        }
        function clearRoleFileInputs() {
            roleFileInputIds.forEach(function(inputId) {
                const input = document.getElementById(inputId);
                if (input) input.value = '';
            });
        }
        function setRoleSaveLock(locked) {
            roleSaveLockIds.forEach(function(controlId) {
                const control = document.getElementById(controlId);
                if (control) control.disabled = !!locked;
            });
            if (roleSaveButton) roleSaveButton.disabled = !!locked;
            setRoleEditorSelectionLock(roleEditorOpen || !!locked);
        }
        function setRoleEditorSelectionLock(locked) {
            ['ttsRoleNewBtn', 'ttsRoleEditBtn', 'ttsRoleActivateBtn', 'ttsRoleDeleteBtn'].forEach(function(controlId) {
                const control = document.getElementById(controlId);
                if (control) control.disabled = !!locked;
            });
            if (voiceSelect) voiceSelect.disabled = !!locked;
        }
        function closeRoleEditor() {
            roleEditorRevision += 1;
            roleEditorOpen = false;
            clearRoleFileInputs();
            if (roleEditor) roleEditor.hidden = true;
            setRoleEditorSelectionLock(false);
        }
        function activeRole() {
            return roleList.find(function(role) { return role.role_id === activeRoleId; }) || null;
        }
        function updateRoleSelectionHint(role) {
            if (!roleSelectionHint) return;
            const active = activeRole();
            if (!role) {
                roleSelectionHint.textContent = active ? ('当前启用：' + active.name + '。') : '尚未选择或启用角色。';
                return;
            }
            if (role.role_id === activeRoleId) {
                roleSelectionHint.textContent = '已选中：' + role.name + '；它当前已启用，语音与 Live2D 均使用此角色。';
                return;
            }
            roleSelectionHint.textContent = '已选中：' + role.name + '（编辑 / 上传目标）；当前启用：' + (active ? active.name : '无') + '（语音与 Live2D 使用）。';
        }
        function updateRoleEditorDetails(role) {
            if (roleEditorContext) {
                if (role) {
                    const active = activeRole();
                    roleEditorContext.textContent = '正在编辑：' + role.name + '（角色 ID：' + role.role_id + '）。' +
                        (role.role_id === activeRoleId ? '它当前已启用。' : ('当前启用：' + (active ? active.name : '无') + '。'));
                } else {
                    roleEditorContext.textContent = '正在新建角色。首次保存时会创建独立角色资料包。';
                }
            }
            if (roleFileStatus) {
                if (!role) {
                    roleFileStatus.textContent = '保存角色后可上传模型与参考音频；不选择新文件时不会覆盖已有资料。';
                } else {
                    roleFileStatus.textContent = '现有资料：GPT ' + (role.gpt_file ? '已配置' : '未上传') +
                        ' · SoVITS ' + (role.sovits_file ? '已配置' : '未上传') +
                        ' · 兼容索引 ' + (role.index_file ? '已保留（当前引擎不使用）' : '未上传（可选）') +
                        ' · 参考音频 ' + (role.audio_file ? '已配置' : '未上传') + '。';
                }
            }
        }
        async function loadRoleLive2DOptions(selected, revision) {
            if (!roleLive2D) return;
            try {
                const response = await fetch('/api/live2d/models', { headers: roleHeaders(false) });
                const data = await response.json();
                if (revision !== roleEditorRevision || !roleEditorOpen) return;
                roleLive2D.innerHTML = '<option value="">请选择已安装模型</option>' + (data.models || []).map(function(model) {
                    return '<option value="' + String(model.model_id).replace(/"/g, '&quot;') + '">' + String(model.display_name || model.model_id).replace(/</g, '&lt;') + '</option>';
                }).join('');
                roleLive2D.value = selected || '';
            } catch (error) {
                if (revision === roleEditorRevision && roleEditorOpen) roleMessage('读取 Live2D 模型失败：' + error.message, true);
            }
        }
        function selectedRole() { return roleList.find(function(role) { return role.role_id === (voiceSelect && voiceSelect.value); }) || null; }
        function renderRoles(data) {
            roleList = data.roles || [];
            activeRoleId = data.active_role_id || '';
            if (!voiceSelect) return;
            const selected = voiceSelect.value || localStorage.getItem('tts_role_selected') || activeRoleId;
            voiceSelect.innerHTML = '';
            if (roleList.length) {
                roleList.forEach(function(role) {
                    const option = document.createElement('option');
                    option.value = role.role_id;
                    option.textContent = role.name + (role.complete ? '' : '（资料未配齐）');
                    voiceSelect.appendChild(option);
                });
            } else {
                const option = document.createElement('option');
                option.value = '';
                option.textContent = '尚未创建角色';
                voiceSelect.appendChild(option);
            }
            voiceSelect.value = roleList.some(function(role) { return role.role_id === selected; }) ? selected : (activeRoleId || (roleList[0] && roleList[0].role_id) || '');
            localStorage.setItem('tts_role_selected', voiceSelect.value);
            localStorage.setItem('tts_active_role_id', activeRoleId);
            const role = selectedRole();
            updateRoleSelectionHint(role);
            roleMessage(role ? (role.complete ? (role.role_id === activeRoleId ? '资料完整，已启用。' : '资料完整；请选择“启用选中角色”后切换语音与 Live2D。') : '资料未配齐：' + role.missing.join('、')) : '请添加角色。', !!(role && !role.complete));
        }
        async function loadRoles() {
            const response = await fetch('/api/tts/roles');
            const data = await response.json();
            if (!response.ok || data.error) throw new Error(data.error || '读取角色失败');
            renderRoles(data);
            return data;
        }
        async function openRoleEditor(role) {
            if (!roleEditor) return;
            const revision = ++roleEditorRevision;
            roleEditorOpen = true;
            setRoleEditorSelectionLock(true);
            clearRoleFileInputs();
            roleEditor.hidden = false;
            if (roleId) roleId.value = role ? role.role_id : '';
            if (roleName) roleName.value = role ? role.name : '';
            if (roleLanguage) roleLanguage.value = role ? (role.reference_language || '') : '';
            if (roleText) roleText.value = role ? (role.reference_text || '') : '';
            updateRoleEditorDetails(role);
            await loadRoleLive2DOptions(role && role.live2d_model_id, revision);
        }
        function newRoleId(name) {
            const normalized = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            const base = (normalized || ('role-' + Date.now())).slice(0, 64);
            let candidate = base;
            let suffix = 2;
            // A new editor must never turn an identically named role into an
            // accidental overwrite of an existing package.
            while (roleList.some(function(role) { return role.role_id === candidate; })) {
                const tail = '-' + suffix++;
                candidate = base.slice(0, 64 - tail.length) + tail;
            }
            return candidate;
        }
        async function uploadRoleAsset(id, input, kind, batchId) {
            const file = input && input.files && input.files[0];
            if (!file) return;
            const query = '?kind=' + encodeURIComponent(kind) + '&name=' + encodeURIComponent(file.name) + (batchId ? '&batch=' + encodeURIComponent(batchId) : '');
            const response = await fetch('/api/tts/roles/' + encodeURIComponent(id) + '/upload' + query, {
                method: 'POST', headers: Object.assign(roleHeaders(false), { 'Content-Type': 'application/octet-stream' }), body: await file.arrayBuffer()
            });
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || ('上传失败：' + file.name));
        }
        async function postRoleJson(path, payload) {
            const response = await fetch(path, { method: 'POST', headers: roleHeaders(true), body: JSON.stringify(payload || {}) });
            const data = await response.json().catch(function() { return {}; });
            if (!response.ok || data.error) throw new Error(data.error || '角色资料保存失败');
            return data;
        }
        async function discardRoleUpdate(id, batchId) {
            if (!batchId) return;
            try { await postRoleJson('/api/tts/roles/' + encodeURIComponent(id) + '/discard-update', { batch_id: batchId }); }
            catch (error) { console.warn('清理未提交角色资料失败：', error); }
        }
        async function refreshActiveRoleRuntime() {
            await TTS.refresh();
            renderStatus();
            if (window.Live2DModelManager && typeof window.Live2DModelManager.loadModels === 'function') {
                await window.Live2DModelManager.loadModels();
            }
            if (window.Live2DCompanion && typeof window.Live2DCompanion.reloadModel === 'function') {
                return window.Live2DCompanion.reloadModel();
            }
            return { ok: true, pending: true };
        }
        async function saveRoleEditor() {
            if (roleSaveInFlight) return;
            roleSaveInFlight = true;
            setRoleSaveLock(true);
            try {
                // Assign this once before the metadata request.  A retry after a
                // failed asset upload must keep writing to the same role package.
                const id = (roleId && roleId.value) || newRoleId(roleName && roleName.value);
                if (roleId) roleId.value = id;
                const body = { role_id: id, name: roleName && roleName.value, reference_language: roleLanguage && roleLanguage.value,
                    reference_text: roleText && roleText.value, live2d_model_id: roleLive2D && roleLive2D.value };

                // Uploads have a stable order.  Existing roles use an isolated
                // staging batch, so the old package remains intact until all
                // selected files, text, language and Live2D binding can commit
                // together.
                const assets = [
                    { inputId: 'ttsRoleGptFile', kind: 'ckpt', label: 'GPT 模型' },
                    { inputId: 'ttsRoleSovitsFile', kind: 'pth', label: 'SoVITS 模型' },
                    { inputId: 'ttsRoleIndexFile', kind: 'index', label: '检索索引' },
                    { inputId: 'ttsRoleAudioFile', kind: 'audio', label: '参考音频' }
                ];
                const selectedAssets = assets.filter(function(asset) {
                    const input = document.getElementById(asset.inputId);
                    return !!(input && input.files && input.files[0]);
                });
                async function uploadSelectedAssets(batchId) {
                    for (const asset of assets) {
                        try {
                            await uploadRoleAsset(id, document.getElementById(asset.inputId), asset.kind, batchId);
                        } catch (error) {
                            const suffix = batchId ? '本次暂存不会影响原角色资料。' : '已完成上传的草稿资料会保留，可直接重试。';
                            throw new Error(asset.label + '上传失败：' + error.message + '。' + suffix);
                        }
                    }
                }
                const existing = roleList.find(function(role) { return role.role_id === id; }) || null;
                const editingActiveRole = !!(existing && existing.role_id === activeRoleId);
                const editingExistingRole = !!existing;
                let savedRole = null;
                if (editingExistingRole && selectedAssets.length) {
                    let batchId = '';
                    try {
                        roleMessage(editingActiveRole ? '正在暂存已启用角色的全部新资料…' : '正在暂存该角色的全部新资料…');
                        const begin = await postRoleJson('/api/tts/roles/' + encodeURIComponent(id) + '/begin-update', {});
                        batchId = begin.batch_id;
                        await uploadSelectedAssets(batchId);
                        const committed = await postRoleJson('/api/tts/roles/' + encodeURIComponent(id) + '/commit-update', Object.assign({}, body, { batch_id: batchId }));
                        savedRole = committed.role || body;
                    } catch (error) {
                        await discardRoleUpdate(id, batchId);
                        throw error;
                    }
                } else {
                    // A new/inactive role is a draft until explicitly enabled,
                    // so it may safely receive assets after its metadata exists.
                    const saved = await postRoleJson('/api/tts/roles', body);
                    savedRole = saved.role || body;
                    await uploadSelectedAssets();
                }
                updateRoleEditorDetails(savedRole);
                await loadRoles();
                if (voiceSelect) voiceSelect.value = id;
                localStorage.setItem('tts_role_selected', id);
                renderRoles({ roles: roleList, active_role_id: activeRoleId });
                closeRoleEditor();
                const roleLabel = roleName && roleName.value ? roleName.value : id;
                if (editingActiveRole) {
                    const renderer = await refreshActiveRoleRuntime();
                    if (renderer && renderer.ok === false) {
                        roleMessage('角色资料已原子保存并启用；Live2D 当前回退为备用图（' + (renderer.code || '加载失败') + '），可在陪伴页查看诊断。', true);
                    } else {
                        roleMessage('角色资料已原子保存；语音与 Live2D 已刷新为 ' + roleLabel + '。');
                    }
                } else {
                    roleMessage('角色资料已保存；选中角色已切换为 ' + roleLabel + '。');
                }
            } finally {
                roleSaveInFlight = false;
                setRoleSaveLock(false);
            }
        }
        document.getElementById('ttsRoleNewBtn').addEventListener('click', function() { openRoleEditor(null); });
        document.getElementById('ttsRoleEditBtn').addEventListener('click', function() { const role = selectedRole(); if (role) openRoleEditor(role); });
        document.getElementById('ttsRoleCancelBtn').addEventListener('click', function() { if (roleSaveInFlight) return; closeRoleEditor(); });
        document.getElementById('ttsRoleSaveBtn').addEventListener('click', function() { saveRoleEditor().catch(function(error) { roleMessage(error.message, true); }); });
        document.getElementById('ttsRoleActivateBtn').addEventListener('click', function() {
            const role = selectedRole(); if (!role) return;
            fetch('/api/tts/roles/' + encodeURIComponent(role.role_id) + '/activate', { method: 'POST', headers: roleHeaders(true), body: '{}' }).then(function(response) { return response.json().then(function(data) { if (!response.ok || data.error) throw new Error(data.error || '启用失败'); return data; }); }).then(async function() {
                await loadRoles();
                try {
                    const renderer = await refreshActiveRoleRuntime();
                    if (renderer && renderer.ok === false) {
                        roleMessage('已启用 ' + role.name + '；语音已切换，Live2D 当前回退为备用图（' + (renderer.code || '加载失败') + '），可在陪伴页查看诊断。', true);
                    } else if (renderer && renderer.pending) {
                        roleMessage('已启用 ' + role.name + '；语音已切换，进入陪伴页时会加载对应 Live2D。');
                    } else {
                        roleMessage('已启用 ' + role.name + '；语音与 Live2D 已切换到此角色。');
                    }
                } catch (error) {
                    console.warn('角色已启用，但 Live2D 刷新失败：', error);
                    roleMessage('已启用 ' + role.name + '，但 Live2D 刷新失败：' + error.message + '。重新进入陪伴学习即可再次加载。', true);
                }
            }).catch(function(error) { roleMessage(error.message, true); });
        });
        document.getElementById('ttsRoleDeleteBtn').addEventListener('click', function() {
            const role = selectedRole(); if (!role || !confirm('删除角色“' + role.name + '”及其 TTS 资料？')) return;
            fetch('/api/tts/roles/' + encodeURIComponent(role.role_id), { method: 'DELETE', headers: roleHeaders(false) }).then(function(response) { return response.json().then(function(data) { if (!response.ok || data.error) throw new Error(data.error || '删除失败'); return data; }); }).then(loadRoles).catch(function(error) { roleMessage(error.message, true); });
        });
        if (voiceSelect) voiceSelect.addEventListener('change', function() { localStorage.setItem('tts_role_selected', voiceSelect.value); renderRoles({ roles: roleList, active_role_id: activeRoleId }); });
        loadRoles().catch(function(error) { roleMessage(error.message, true); });

        function renderStatus() {
            if (!statusEl) return;
            const st = TTS.getStatus();
            if (!st.pack_ready) {
                statusEl.textContent = '未检测到语音资源包（data/tts_pack/）';
                if (enableBtn) enableBtn.textContent = '开启语音';
                if (preloadBtn) preloadBtn.style.display = 'none';
                if (repairBtn) repairBtn.style.display = 'none';
                return;
            }
            if (!st.engine_ready) {
                statusEl.textContent = '资源包已检测到，语音环境未就绪：' + (st.install_error || '请修复语音环境');
                if (enableBtn) enableBtn.textContent = '开启语音';
                if (preloadBtn) preloadBtn.style.display = 'none';
                if (repairBtn) repairBtn.style.display = '';
                return;
            }
            const dev = st.device ? ' · ' + st.device : '';
            const roleIssue = st.role_error || (!st.role_ready ? '尚未启用资料完整的角色' : '');
            const runtimeIssue = st.runtime_error || (st.enabled && st.runtime_ready === false ? '语音运行时未就绪' : '');
            const companionIssue = companionRead && !companionRead.checked ? '陪伴朗读未开启（触摸不会发声）' : '陪伴朗读已开启';
            statusEl.textContent = (st.enabled ? '✓ 已开启' : '未开启') + ' · 引擎就绪' + dev +
                (st.loaded ? ' · 模型已加载' : '') + (st.busy ? ' · 合成中' : '') +
                (roleIssue ? ' · ' + roleIssue : '') + (runtimeIssue ? ' · ' + runtimeIssue : '') +
                ' · ' + companionIssue;
            if (enableBtn) enableBtn.textContent = st.enabled ? '关闭语音' : '开启语音';
            if (preloadBtn) preloadBtn.style.display = (st.enabled && st.role_ready && st.runtime_ready !== false) ? '' : 'none';
            if (repairBtn) repairBtn.style.display = 'none';
        }

        if (enableBtn) enableBtn.addEventListener('click', async function() {
            const target = !TTS.getStatus().enabled;
            if (actionEl) { actionEl.textContent = target ? '正在开启...' : '正在关闭...'; actionEl.className = 'status-text'; }
            const result = await TTS.setEnabled(target);
            if (actionEl) {
                if (result.ok) {
                    actionEl.textContent = target ? '✓ 语音已开启' : '已关闭语音';
                    actionEl.className = 'status-text success';
                } else {
                    actionEl.textContent = '✗ ' + (result.error || '操作失败');
                    actionEl.className = 'status-text error';
                }
            }
            await TTS.refresh();
            renderStatus();
        });

        if (preloadBtn) preloadBtn.addEventListener('click', async function() {
            if (actionEl) { actionEl.textContent = '正在预加载当前已启用角色的模型（首次较慢）...'; actionEl.className = 'status-text'; }
            try {
                const resp = await fetch('/api/tts/preload', {
                    method: 'POST',
                    headers: roleHeaders(true),
                    // The server resolves the active role.  The dropdown is only
                    // an editing/upload target and must not select a voice here.
                    body: JSON.stringify({})
                });
                const data = await resp.json();
                if (actionEl) {
                    if (resp.ok) {
                        actionEl.textContent = '✓ 当前已启用角色的模型已加载';
                        actionEl.className = 'status-text success';
                    } else {
                        actionEl.textContent = '✗ ' + (data.error || '加载失败');
                        actionEl.className = 'status-text error';
                    }
                }
                await TTS.refresh();
                renderStatus();
            } catch (e) {
                if (actionEl) { actionEl.textContent = '✗ ' + e.message; actionEl.className = 'status-text error'; }
            }
        });

        if (repairBtn) repairBtn.addEventListener('click', async function() {
            repairBtn.disabled = true;
            if (actionEl) { actionEl.textContent = '正在修复语音环境（首次可能需要数分钟）...'; actionEl.className = 'status-text'; }
            try {
                const resp = await fetch('/api/tts/repair', {
                    method: 'POST', headers: roleHeaders(true), body: JSON.stringify({})
                });
                const data = await resp.json().catch(function() { return {}; });
                if (!resp.ok || data.error) throw new Error(data.error || '修复失败');
                if (actionEl) { actionEl.textContent = '✓ ' + (data.message || '语音环境已修复'); actionEl.className = 'status-text success'; }
            } catch (error) {
                if (actionEl) { actionEl.textContent = '✗ ' + error.message; actionEl.className = 'status-text error'; }
            } finally {
                repairBtn.disabled = false;
                await TTS.refresh();
                renderStatus();
            }
        });

        TTS.refresh().then(renderStatus).catch(function() { renderStatus(); });
    }

    // ---- 本地数据更新、刷新与图表重绘 ----

    function resetStudyDataForProfileChange() {
        pendingRecords = null;
        notepadDataLoaded = false;
        notepadDataPromise = null;
        StudySyncUI.reset();
    }

    function restoreAICache() {
        const aiCache = localStorage.getItem('ai_classification_cache');
        if (!aiCache) return;
        try {
            const cached = JSON.parse(aiCache);
            if (Date.now() - cached.timestamp < 7 * 24 * 60 * 60 * 1000) {
                ChartManager.setAIClassification(cached.data);
            }
        } catch (e) {}
    }

    function queueDailySnapshot(records) {
        if (!Array.isArray(records) || !records.length) return;
        const today = MemoDashboard.todayBeijing();
        if (localStorage.getItem('memo_snapshot_date') === today) return;
        RecommendAPI.saveSnapshot(records, false).then(function() {
            localStorage.setItem('memo_snapshot_date', today);
        }).catch(function(e) {
            console.warn('快照保存失败:', e);
        });
    }

    function loadSupplementalData() {
        if (notepadDataLoaded) return Promise.resolve();
        if (notepadDataPromise) return notepadDataPromise;
        notepadDataPromise = MaimemoAPI.getAllNotepadWords().then(function(notepadWords) {
            ChartManager.setNotepadWords(notepadWords);
            notepadDataLoaded = true;
            // 词书进度图依赖词本数据；只在它到达后补渲染一次。
            ChartManager.renderVisibleFromSelectors(false);
        }).catch(function(e) {
            console.warn('加载云词本失败:', e.message);
        }).finally(function() {
            notepadDataPromise = null;
        });
        return notepadDataPromise;
    }

    function renderStudyRecords(records) {
        ChartManager.setRecords(records);
        queueDailySnapshot(records);
        restoreAICache();
        if (records.length) loadSupplementalData();
        setTimeout(function() {
            ChartManager.renderVisibleFromSelectors(false);
        }, 100);
    }

    // StudySyncUI 只在 SQLite 提交的记录指纹变化时调用此函数；无变化刷新不会重绘图表。
    function handleStudyRecordsChanged(records) {
        if (LayoutManager.isDragging()) {
            pendingRecords = records;
            return;
        }
        renderStudyRecords(records);
    }

    // ---- 刷新按钮 ----
    
    function setupRefreshButton() {
        document.getElementById('refreshBtn').addEventListener('click', function() {
            checkProxyServer().then(function(online) {
                if (!online) {
                    alert('代理服务器未启动！\n\n请在项目目录下运行：\n  python server.py');
                    return null;
                }
                return StudySyncUI.manualRefresh();
            }).catch(function(e) {
                console.error('手动更新失败:', e);
            });
        });
    }
    
    // ---- 自动刷新 ----
    
    function setupAutoRefresh() {
        // 拖拽期间不改写图表；释放后先应用已完成的数据，再补一次跳过的增量更新。
        LayoutManager.setDragEndCallback(function() {
            if (pendingRecords) {
                const records = pendingRecords;
                pendingRecords = null;
                renderStudyRecords(records);
            }
            if (pendingSyncAfterDrag) {
                pendingSyncAfterDrag = false;
                doAutoRefresh();
            }
        });
        
        const toggle = document.getElementById('autoRefreshToggle');
        const select = document.getElementById('autoRefreshInterval');
        
        toggle.classList.toggle('active', autoRefreshEnabled);
        select.value = String(autoRefreshInterval);
        
        toggle.addEventListener('click', function() {
            autoRefreshEnabled = !autoRefreshEnabled;
            localStorage.setItem('auto_refresh_enabled', autoRefreshEnabled ? 'true' : 'false');
            toggle.classList.toggle('active', autoRefreshEnabled);
            if (autoRefreshEnabled) startAutoRefresh();
            else stopAutoRefresh();
        });
        
        select.addEventListener('change', function() {
            autoRefreshInterval = parseInt(this.value, 10);
            localStorage.setItem('auto_refresh_interval', String(autoRefreshInterval));
            if (autoRefreshEnabled) startAutoRefresh();
        });
        
        if (autoRefreshEnabled) startAutoRefresh();
        else updateCountdown();
    }
    
    function startAutoRefresh() {
        stopAutoRefresh();
        nextRefreshTime = Date.now() + autoRefreshInterval * 60 * 1000;
        autoRefreshTimer = setInterval(function() {
            if (LayoutManager.isDragging()) {
                pendingSyncAfterDrag = true;
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

    async function doAutoRefresh() {
        if (isLoading || !proxyOnline || StudySyncUI.isSyncing()) return;
        if (LayoutManager.isDragging()) {
            pendingSyncAfterDrag = true;
            return;
        }
        try {
            await StudySyncUI.runIncremental('auto-refresh');
        } catch (e) {
            console.warn('自动刷新失败:', e);
        } finally {
            nextRefreshTime = Date.now() + autoRefreshInterval * 60 * 1000;
            updateCountdown();
        }
    }
    
    function updateCountdown() {
        const el = document.getElementById('autoRefreshCountdown');
        if (!el) return;
        const syncText = StudySyncUI.getCountdownText();
        if (syncText) {
            el.textContent = syncText;
            el.classList.remove('paused');
            return;
        }
        if (!autoRefreshEnabled) {
            el.textContent = '已暂停';
            el.classList.add('paused');
            return;
        }
        el.classList.remove('paused');
        const remaining = Math.max(0, nextRefreshTime - Date.now());
        const mins = Math.floor(remaining / 60000);
        const secs = Math.floor((remaining % 60000) / 1000);
        el.textContent = mins + ':' + String(secs).padStart(2, '0');
    }

    // 启动时优先显示 SQLite 中的已提交数据；有数据时后台增量更新，无数据才等待首次建库。
    async function loadAllData(forceRefresh = false) {
        if (isLoading) return;
        isLoading = true;
        try {
            await StudySyncUI.loadInitialData(forceRefresh ? 'manual-refresh' : null);
        } catch (e) {
            console.error('加载数据失败:', e);
            alert('加载数据失败: ' + e.message + '\n\n请检查：\n1. 代理服务器是否已启动\n2. Token 是否正确');
        } finally {
            isLoading = false;
        }
    }
    
    return { init };
})();

document.addEventListener('DOMContentLoaded', function() { App.init(); });
