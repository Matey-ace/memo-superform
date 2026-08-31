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

    async function init() {
        setupSettingsPanel();
        setupModeSettings();
        if (window.AppUpdate && typeof window.AppUpdate.init === 'function') window.AppUpdate.init();
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
        
        try {
            await MaimemoAPI.bootstrap();
        } catch (e) {
            console.warn('墨墨账号初始化失败:', e.message);
        }
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
        
        const aiConfig = AIAPI.getConfig();
        document.getElementById('aiProviderSelect').value = aiConfig.provider;
        document.getElementById('aiEndpointInput').value = aiConfig.endpoint;
        document.getElementById('aiKeyInput').value = aiConfig.apiKey;
        document.getElementById('aiModelInput').value = aiConfig.model;
        const uiStyleSelect = document.getElementById('uiStyleSelect');
        if (uiStyleSelect) uiStyleSelect.value = window.MemoUIStyle.name;
        const companionLanguageSelect = document.getElementById('companionLanguageSelect');
        if (companionLanguageSelect) {
            // 陪伴回复语言与上方服务商/模型配置一样，是浏览器本地 AI 偏好。
            // 旧安装和畸形值统一回退为中文。
            companionLanguageSelect.value = localStorage.getItem('companion_language') === 'ja' ? 'ja' : 'zh';
            companionLanguageSelect.addEventListener('change', function() {
                localStorage.setItem('companion_language', companionLanguageSelect.value === 'ja' ? 'ja' : 'zh');
            });
        }

        const companionReminderEnabled = document.getElementById('companionReminderEnabled');
        const companionReminderMinutes = document.getElementById('companionReminderMinutes');
        const COMPANION_REMINDER_MINUTES = { min: 1, max: 180, default: 30 };

        function normalizeCompanionReminderMinutes(value) {
            const rawValue = String(value == null ? '' : value).trim();
            if (!/^\d+$/.test(rawValue)) return COMPANION_REMINDER_MINUTES.default;
            const minutes = Number.parseInt(rawValue, 10);
            return Math.min(COMPANION_REMINDER_MINUTES.max, Math.max(COMPANION_REMINDER_MINUTES.min, minutes));
        }

        function saveCompanionReminderSettings() {
            if (!companionReminderEnabled || !companionReminderMinutes) return null;
            const minutes = normalizeCompanionReminderMinutes(companionReminderMinutes.value);
            companionReminderMinutes.value = String(minutes);
            const settings = { enabled: companionReminderEnabled.checked, minutes: minutes };
            localStorage.setItem('companion_reminder_enabled', settings.enabled ? 'true' : 'false');
            localStorage.setItem('companion_reminder_minutes', String(settings.minutes));
            return settings;
        }

        function updateCompanionReminderControls() {
            if (!companionReminderEnabled || !companionReminderMinutes) return;
            const disabled = !companionReminderEnabled.checked;
            companionReminderMinutes.disabled = disabled;
            companionReminderMinutes.setAttribute('aria-disabled', String(disabled));
        }

        function notifyCompanionReminderSettingsChanged(settings) {
            if (!settings) return;
            window.dispatchEvent(new CustomEvent('companion-reminder-settings-changed', { detail: settings }));
        }

        if (companionReminderEnabled && companionReminderMinutes) {
            companionReminderEnabled.checked = localStorage.getItem('companion_reminder_enabled') === 'true';
            companionReminderMinutes.value = String(normalizeCompanionReminderMinutes(
                localStorage.getItem('companion_reminder_minutes') || COMPANION_REMINDER_MINUTES.default
            ));
            updateCompanionReminderControls();

            companionReminderEnabled.addEventListener('change', function() {
                updateCompanionReminderControls();
                notifyCompanionReminderSettingsChanged(saveCompanionReminderSettings());
            });
            companionReminderMinutes.addEventListener('change', function() {
                notifyCompanionReminderSettingsChanged(saveCompanionReminderSettings());
            });
        }

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
        
        const maimemoStatus = document.getElementById('maimemoAccountStatus');
        const maimemoConnectBtn = document.getElementById('maimemoConnectBtn');
        const maimemoReconnectBtn = document.getElementById('maimemoReconnectBtn');
        const maimemoDisconnectBtn = document.getElementById('maimemoDisconnectBtn');
        const maimemoManualSaveBtn = document.getElementById('maimemoManualSaveBtn');
        const maimemoManualToken = document.getElementById('maimemoManualToken');
        const maimemoDeleteDataBtn = document.getElementById('maimemoDeleteDataBtn');
        let maimemoPollTimer = null;

        function stopMaimemoPolling() {
            if (maimemoPollTimer) { clearInterval(maimemoPollTimer); maimemoPollTimer = null; }
        }
        async function refreshMaimemoAccount() {
            try {
                const wasConnected = MaimemoAPI.hasToken();
                const status = await MaimemoAPI.refreshConnection();
                const connected = Boolean(status.connected);
                if (connected) {
                    const label = status.mode === 'oauth'
                        ? ('✓ 已连接' + (status.display_name ? ' · ' + status.display_name : ''))
                        : '✓ 已连接 · 手动 Token';
                    maimemoStatus.textContent = label;
                    maimemoStatus.className = 'status-text success';
                    maimemoConnectBtn.style.display = 'none';
                    maimemoReconnectBtn.style.display = status.configured ? '' : 'none';
                    maimemoDisconnectBtn.style.display = '';
                    maimemoDeleteDataBtn.style.display = '';
                    stopMaimemoPolling();
                    // OAuth 回调在外部浏览器完成后只会更新本机凭据。这里检测到
                    // 状态转换后主动刷新仪表盘，不要求用户再手动保存设置。
                    if (!wasConnected) {
                        resetStudyDataForProfileChange();
                        hideWelcome();
                        loadAllData();
                    }
                } else {
                    maimemoStatus.textContent = status.error ? ('✗ ' + status.error)
                        : (status.pending ? '请在浏览器中完成墨墨授权...' : '尚未连接墨墨账号');
                    maimemoStatus.className = status.error ? 'status-text error' : 'hint';
                    maimemoConnectBtn.style.display = status.configured ? '' : 'none';
                    maimemoReconnectBtn.style.display = 'none';
                    maimemoDisconnectBtn.style.display = 'none';
                    maimemoDeleteDataBtn.style.display = 'none';
                    if (!status.configured && !status.pending) {
                        maimemoStatus.textContent = '一键授权将在开放平台 client_id 配置后可用；可先使用下方手动 Token。';
                    }
                }
                return status;
            } catch (e) {
                maimemoStatus.textContent = '✗ ' + e.message;
                maimemoStatus.className = 'status-text error';
                return null;
            }
        }
        async function startMaimemoLogin() {
            try {
                const result = await MaimemoAPI.connect();
                maimemoStatus.textContent = '正在打开浏览器授权...';
                maimemoStatus.className = 'hint';
                if (!result.opened && result.authorization_url) window.open(result.authorization_url, '_blank', 'noopener');
                stopMaimemoPolling();
                maimemoPollTimer = setInterval(refreshMaimemoAccount, 1500);
            } catch (e) {
                maimemoStatus.textContent = '✗ ' + e.message;
                maimemoStatus.className = 'status-text error';
            }
        }
        maimemoConnectBtn.addEventListener('click', startMaimemoLogin);
        maimemoReconnectBtn.addEventListener('click', startMaimemoLogin);
        maimemoDisconnectBtn.addEventListener('click', async function() {
            try {
                await MaimemoAPI.disconnect();
                resetStudyDataForProfileChange();
                await refreshMaimemoAccount();
                showWelcome();
            } catch (e) {
                maimemoStatus.textContent = '✗ ' + e.message;
                maimemoStatus.className = 'status-text error';
            }
        });
        maimemoManualSaveBtn.addEventListener('click', async function() {
            const value = maimemoManualToken.value.trim();
            if (!value) { maimemoStatus.textContent = '请输入 Token'; maimemoStatus.className = 'status-text error'; return; }
            this.disabled = true;
            try {
                await MaimemoAPI.saveManualToken(value);
                maimemoManualToken.value = '';
                const progress = await MaimemoAPI.getStudyProgress(false);
                const p = progress.progress || progress;
                maimemoStatus.textContent = '✓ Token 已保存并连接成功' + (p && p.total !== undefined ? (' · 今日 ' + (p.finished || 0) + '/' + p.total) : '');
                maimemoStatus.className = 'status-text success';
                resetStudyDataForProfileChange();
                await refreshMaimemoAccount();
                hideWelcome();
                loadAllData();
            } catch (e) {
                maimemoStatus.textContent = '✗ ' + e.message;
                maimemoStatus.className = 'status-text error';
            }
            this.disabled = false;
        });
        maimemoDeleteDataBtn.addEventListener('click', async function() {
            if (!confirm('删除当前墨墨账号在本机保存的学习记录、同步状态和统计？此操作不会删除墨墨云端数据。')) return;
            try {
                await MaimemoAPI.deleteLocalData();
                resetStudyDataForProfileChange();
                alert('本机墨墨学习数据已删除。');
            } catch (e) {
                alert('删除失败：' + e.message);
            }
        });
        refreshMaimemoAccount();
        
        document.getElementById('clearCacheBtn').addEventListener('click', function() {
            const count = MaimemoAPI.clearCache();
            const aiCache = localStorage.getItem('ai_classification_cache');
            if (aiCache) localStorage.removeItem('ai_classification_cache');
            alert('已清除 ' + count + ' 条派生缓存；本地学习数据保持不变');
        });
        
        document.getElementById('saveSettingsBtn').addEventListener('click', function() {
            const nextStyle = uiStyleSelect ? uiStyleSelect.value : window.MemoUIStyle.name;
            AIAPI.setConfig({
                provider: document.getElementById('aiProviderSelect').value,
                endpoint: document.getElementById('aiEndpointInput').value.trim(),
                apiKey: document.getElementById('aiKeyInput').value.trim(),
                model: document.getElementById('aiModelInput').value.trim()
            });
            if (companionLanguageSelect) {
                localStorage.setItem('companion_language', companionLanguageSelect.value === 'ja' ? 'ja' : 'zh');
            }
            notifyCompanionReminderSettingsChanged(saveCompanionReminderSettings());
            if (nextStyle !== window.MemoUIStyle.name) {
                window.MemoUIStyle.save(nextStyle);
                location.replace('index.html');
                return;
            }
            closeSettings();
            if (MaimemoAPI.hasToken()) {
                hideWelcome();
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
        const packMountDropzone = document.getElementById('ttsPackMountDropzone');
        const packMountInput = document.getElementById('ttsPackMountInput');
        const packMountBrowseBtn = document.getElementById('ttsPackMountBrowseBtn');
        const packMountStatus = document.getElementById('ttsPackMountStatus');
        const packMountMissing = document.getElementById('ttsPackMountMissing');

        let savedSpeed = parseFloat(localStorage.getItem('tts_speed') || '1.0');
        if (!Number.isFinite(savedSpeed) || savedSpeed < 0.5 || savedSpeed > 1.5) savedSpeed = 1.0;
        if (speedRange) speedRange.value = savedSpeed;
        if (speedValue) speedValue.textContent = savedSpeed.toFixed(1);
        if (autoRead) autoRead.checked = localStorage.getItem('tts_auto_read') === 'true';
        if (companionRead) {
            const savedCompanionRead = localStorage.getItem('tts_companion_enabled');
            // 刚升级的安装不应显示为全部启用，却让所有角色触摸刻意静音。保留用户
            // 明确关闭的选择，其余情况默认启用陪伴朗读。
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

        // ---- 显式角色资料包（TTS + 参考资料 + Live2D）----
        let roleList = [], activeRoleId = '';
        let packMountInFlight = false;
        const roleStatus = document.getElementById('ttsRoleStatus');
        const roleSelectionHint = document.getElementById('ttsRoleSelectionHint');
        const roleEditor = document.getElementById('ttsRoleEditor');
        const roleEditorContext = document.getElementById('ttsRoleEditorContext');
        const roleFileStatus = document.getElementById('ttsRoleFileStatus');
        const roleId = document.getElementById('ttsRoleId');
        const rolePersonaName = document.getElementById('ttsRolePersonaName');
        const rolePersonaBackground = document.getElementById('ttsRolePersonaBackground');
        const rolePersonaTone = document.getElementById('ttsRolePersonaTone');
        const rolePersonaAvoid = document.getElementById('ttsRolePersonaAvoid');
        const rolePersonaExamples = document.getElementById('ttsRolePersonaExamples');
        const rolePersonaTotalCount = document.getElementById('ttsRolePersonaTotalCount');
        const rolePersonaStatus = document.getElementById('ttsRolePersonaStatus');
        const rolePersonaImportInput = document.getElementById('ttsRolePersonaImportInput');
        const rolePersonaImportBtn = document.getElementById('ttsRolePersonaImportBtn');
        const rolePersonaExportBtn = document.getElementById('ttsRolePersonaExportBtn');
        const rolePersonaResetBtn = document.getElementById('ttsRolePersonaResetBtn');
        const roleLive2D = document.getElementById('ttsRoleLive2D');
        const roleLanguage = document.getElementById('ttsRoleLanguage');
        const roleText = document.getElementById('ttsRoleReferenceText');
        const roleSaveButton = document.getElementById('ttsRoleSaveBtn');
        const roleFileInputIds = ['ttsRoleGptFile', 'ttsRoleSovitsFile', 'ttsRoleIndexFile', 'ttsRoleAudioFile'];
        const rolePersonaFields = [
            { key: 'name', label: '角色', input: rolePersonaName, countId: 'ttsRolePersonaNameCount', limit: 64 },
            { key: 'background', label: '背景', input: rolePersonaBackground, countId: 'ttsRolePersonaBackgroundCount', limit: 8000 },
            { key: 'tone', label: '语气', input: rolePersonaTone, countId: 'ttsRolePersonaToneCount', limit: 2000 },
            { key: 'avoid', label: '禁忌', input: rolePersonaAvoid, countId: 'ttsRolePersonaAvoidCount', limit: 2000 },
            { key: 'examples', label: '示例', input: rolePersonaExamples, countId: 'ttsRolePersonaExamplesCount', limit: 2000 }
        ];
        const ROLE_PERSONA_TOTAL_LIMIT = 12000;
        const ROLE_PERSONA_JSON_KEYS = ['版本', '角色', '语气', '背景', '禁忌', '示例'];
        const roleSaveLockIds = ['ttsRoleNewBtn', 'ttsRoleEditBtn', 'ttsRoleActivateBtn', 'ttsRoleDeleteBtn', 'ttsRoleCancelBtn',
            'ttsRolePersonaName', 'ttsRolePersonaBackground', 'ttsRolePersonaTone', 'ttsRolePersonaAvoid', 'ttsRolePersonaExamples',
            'ttsRolePersonaImportInput', 'ttsRolePersonaImportBtn', 'ttsRolePersonaExportBtn', 'ttsRolePersonaResetBtn',
            'ttsRoleLive2D', 'ttsRoleLanguage', 'ttsRoleReferenceText'].concat(roleFileInputIds);
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
        function setPackMountMessage(message, error) {
            if (!packMountStatus) return;
            packMountStatus.textContent = message || '';
            packMountStatus.className = error ? 'hint error' : 'hint';
        }
        function renderPackMountMissing(data) {
            if (!packMountMissing) return;
            const lines = [];
            const runtime = Array.isArray(data && data.runtime_missing) ? data.runtime_missing
                : (Array.isArray(data && data.runtime_missing_files) ? data.runtime_missing_files : []);
            if (runtime.length) lines.push('运行环境缺少：' + runtime.join('、'));
            const roles = Array.isArray(data && data.incomplete_roles) ? data.incomplete_roles : [];
            roles.forEach(function(role) {
                const label = String(role && (role.name || role.role_id) || '未命名角色');
                const missing = Array.isArray(role && role.missing_paths) && role.missing_paths.length
                    ? role.missing_paths
                    : (Array.isArray(role && role.missing) ? role.missing : []);
                if (missing.length) lines.push(label + ' 缺少：' + missing.join('、'));
            });
            packMountMissing.hidden = !lines.length;
            packMountMissing.textContent = lines.length ? ('当前语音包待补齐：\n' + lines.join('\n')) : '';
        }
        function setPackMountBusy(busy) {
            if (packMountDropzone) {
                packMountDropzone.classList.toggle('is-uploading', !!busy);
                packMountDropzone.setAttribute('aria-busy', busy ? 'true' : 'false');
                packMountDropzone.tabIndex = busy ? -1 : 0;
            }
            if (packMountInput) packMountInput.disabled = !!busy;
            if (packMountBrowseBtn) packMountBrowseBtn.disabled = !!busy;
        }
        function describePackSize(bytes) {
            const size = Number(bytes) || 0;
            if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
            if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(1) + ' MB';
            return Math.max(0, Math.round(size / 1024)) + ' KB';
        }
        async function mountTtsPack(file) {
            if (packMountInFlight || !file) return;
            if (!/\.zip$/i.test(String(file.name || ''))) {
                setPackMountMessage('请选择语音包 ZIP 文件。', true);
                return;
            }
            if (!file.size) {
                setPackMountMessage('这个语音包 ZIP 是空的。', true);
                return;
            }
            if (roleSaveInFlight) {
                setPackMountMessage('角色资料正在保存，请完成后再挂载语音包。', true);
                return;
            }
            if (roleEditorOpen) {
                const proceed = window.confirm('挂载会替换当前完整语音包。未保存的角色编辑内容会被丢弃，继续吗？');
                if (!proceed) return;
                closeRoleEditor();
            }

            packMountInFlight = true;
            setPackMountBusy(true);
            setRoleEditorSelectionLock(true);
            const label = String(file.name || '语音包.zip');
            renderPackMountMissing(null);
            setPackMountMessage('正在传输并校验 ' + label + '（' + describePackSize(file.size) + '），大包需要一些时间…');
            if (actionEl) { actionEl.textContent = '正在挂载语音包…'; actionEl.className = 'status-text'; }
            try {
                // 直接以 File 作为请求体。与 arrayBuffer() 不同，WebView 可流式
                // 传输数 GB 的运行包，不在浏览器内存中再复制一份。
                const response = await fetch('/api/tts/mount-pack?name=' + encodeURIComponent(label), {
                    method: 'POST',
                    headers: Object.assign(roleHeaders(false), { 'Content-Type': 'application/zip' }),
                    body: file
                });
                const data = await response.json().catch(function() { return {}; });
                if (!response.ok || data.error) throw new Error(data.error || '语音包挂载失败');
                await TTS.refresh();
                renderStatus();
                await loadRoles();
                const imported = Array.isArray(data.voice_ready_role_ids) ? data.voice_ready_role_ids.length : 0;
                renderPackMountMissing(data);
                if (data.complete) {
                    setPackMountMessage('✓ 已挂载“' + (data.pack_name || label) + '”。已识别 ' + imported + ' 套完整语音资料；请确认角色的 Live2D 绑定后再开启语音。');
                    if (actionEl) { actionEl.textContent = '✓ 语音包已挂载，旧 worker 已关闭'; actionEl.className = 'status-text success'; }
                } else {
                    const runtimeMissing = Array.isArray(data.runtime_missing) && data.runtime_missing.length;
                    const usableRoles = !runtimeMissing && imported > 0;
                    setPackMountMessage(usableRoles
                        ? ('✓ 已挂载“' + (data.pack_name || label) + '”。已识别 ' + imported + ' 套完整语音资料；其余待补齐内容见下方清单。')
                        : ('✓ 已挂载“' + (data.pack_name || label) + '”，但还有待补齐内容；请按下方清单补充后再开启语音。'));
                    if (actionEl) {
                        actionEl.textContent = usableRoles ? '✓ 语音包已挂载，部分角色待补齐' : '✓ 语音包已挂载，等待补齐资料';
                        actionEl.className = usableRoles ? 'status-text success' : 'status-text';
                    }
                }
            } catch (error) {
                console.error('语音包挂载失败：', error);
                setPackMountMessage('✗ ' + (error.message || '语音包挂载失败'), true);
                if (actionEl) { actionEl.textContent = '✗ 语音包挂载失败'; actionEl.className = 'status-text error'; }
            } finally {
                packMountInFlight = false;
                setPackMountBusy(false);
                setRoleEditorSelectionLock(false);
                if (packMountInput) packMountInput.value = '';
            }
        }
        function selectTtsPack(files) {
            const file = files && files[0];
            if (!file) return;
            mountTtsPack(file);
        }
        if (packMountBrowseBtn) packMountBrowseBtn.addEventListener('click', function() {
            if (!packMountInFlight && packMountInput) packMountInput.click();
        });
        if (packMountInput) packMountInput.addEventListener('change', function() { selectTtsPack(packMountInput.files); });
        if (packMountDropzone) {
            packMountDropzone.addEventListener('click', function() {
                if (!packMountInFlight && packMountInput) packMountInput.click();
            });
            packMountDropzone.addEventListener('keydown', function(event) {
                if (packMountInFlight || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                if (packMountInput) packMountInput.click();
            });
            packMountDropzone.addEventListener('dragover', function(event) {
                if (packMountInFlight) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                packMountDropzone.classList.add('is-dragover');
            });
            packMountDropzone.addEventListener('dragleave', function(event) {
                if (!packMountDropzone.contains(event.relatedTarget)) packMountDropzone.classList.remove('is-dragover');
            });
            packMountDropzone.addEventListener('drop', function(event) {
                event.preventDefault();
                packMountDropzone.classList.remove('is-dragover');
                if (!packMountInFlight) selectTtsPack(event.dataTransfer && event.dataTransfer.files);
            });
        }
        function roleMessage(text, error) {
            if (!roleStatus) return;
            roleStatus.textContent = text || '';
            roleStatus.className = error ? 'hint error' : 'hint';
        }
        function setRolePersonaStatus(text, error) {
            if (!rolePersonaStatus) return;
            rolePersonaStatus.textContent = text || '';
            rolePersonaStatus.className = error ? 'hint error' : 'hint';
        }
        function defaultRolePersona(name) {
            return {
                name: String(name || '陪伴角色').trim() || '陪伴角色',
                background: '你是背词学习中的陪伴角色，观察学习节奏并给出简短、真诚的鼓励。',
                tone: '自然、友好、克制，不打扰学习节奏。',
                avoid: '不要只说单个语气词，不要说教过长，不要编造成绩或使用冒犯表达。',
                examples: '这一题记下来就很好。\n保持节奏，下一题继续。'
            };
        }
        function normalizePersonaExamples(value) {
            // 旧资料使用 | 分隔示例；新 persona.json 统一用一行一条，打开旧资料时
            // 无损地转换为更易编辑的形式。
            return String(value || '').replace(/\s*\|\s*/g, '\n');
        }
        function rolePersonaFromInputs() {
            return {
                name: String(rolePersonaName && rolePersonaName.value || '').trim(),
                background: String(rolePersonaBackground && rolePersonaBackground.value || '').trim(),
                tone: String(rolePersonaTone && rolePersonaTone.value || '').trim(),
                avoid: String(rolePersonaAvoid && rolePersonaAvoid.value || '').trim(),
                examples: String(rolePersonaExamples && rolePersonaExamples.value || '').trim()
            };
        }
        function setRolePersonaInputs(persona, fallbackName) {
            const source = persona && typeof persona === 'object' ? persona : {};
            const values = {
                name: source.name || fallbackName || '',
                background: source.background || '',
                tone: source.tone || '',
                avoid: source.avoid || '',
                examples: normalizePersonaExamples(source.examples || '')
            };
            rolePersonaFields.forEach(function(field) {
                if (field.input) field.input.value = String(values[field.key] || '');
            });
            updateRolePersonaCounters();
        }
        function updateRolePersonaCounters() {
            let total = 0;
            rolePersonaFields.forEach(function(field) {
                const value = String(field.input && field.input.value || '');
                total += value.length;
                const counter = document.getElementById(field.countId);
                if (counter) {
                    counter.textContent = value.length + ' / ' + field.limit;
                    counter.classList.toggle('is-limit', value.length > field.limit);
                }
            });
            if (rolePersonaTotalCount) {
                rolePersonaTotalCount.textContent = '角色资料共 ' + total + ' / ' + ROLE_PERSONA_TOTAL_LIMIT + ' 字';
                rolePersonaTotalCount.classList.toggle('is-limit', total > ROLE_PERSONA_TOTAL_LIMIT);
            }
        }
        function validateRolePersona(persona) {
            const values = persona || rolePersonaFromInputs();
            let total = 0;
            for (const field of rolePersonaFields) {
                const value = String(values[field.key] || '').trim();
                total += value.length;
                if (value.length > field.limit) {
                    return { valid: false, error: field.label + '不能超过 ' + field.limit + ' 字。', persona: values, missing: [] };
                }
            }
            if (total > ROLE_PERSONA_TOTAL_LIMIT) {
                return { valid: false, error: '角色资料总字数不能超过 ' + ROLE_PERSONA_TOTAL_LIMIT + ' 字。', persona: values, missing: [] };
            }
            if (!String(values.name || '').trim()) {
                return { valid: false, error: '请填写角色名称；它会作为角色资料包的唯一显示名称。', persona: values, missing: [] };
            }
            const missing = rolePersonaFields.filter(function(field) {
                return field.key !== 'name' && !String(values[field.key] || '').trim();
            }).map(function(field) { return field.label; });
            return { valid: true, persona: values, missing: missing, total: total };
        }
        function describePersonaDraft(validation) {
            if (!validation || !validation.valid) return;
            if (validation.missing.length) {
                setRolePersonaStatus('人设尚未完整：缺少' + validation.missing.join('、') + '。可以先保存为草稿，补齐后才能启用角色。');
            } else {
                setRolePersonaStatus('角色档案完整；保存后会写入当前角色的 persona.json。');
            }
        }
        function personaJsonFromLegacy(persona) {
            return {
                '版本': 1,
                '角色': String(persona.name || ''),
                '语气': String(persona.tone || ''),
                '背景': String(persona.background || ''),
                '禁忌': String(persona.avoid || ''),
                '示例': String(persona.examples || '')
            };
        }
        function legacyPersonaFromJson(value) {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('人设 JSON 必须是一个对象。');
            const keys = Object.keys(value);
            const missing = ROLE_PERSONA_JSON_KEYS.filter(function(key) { return !Object.prototype.hasOwnProperty.call(value, key); });
            const unexpected = keys.filter(function(key) { return ROLE_PERSONA_JSON_KEYS.indexOf(key) === -1; });
            if (missing.length) throw new Error('人设 JSON 缺少字段：' + missing.join('、') + '。');
            if (unexpected.length) throw new Error('人设 JSON 包含不支持的字段：' + unexpected.join('、') + '。');
            if (value['版本'] !== 1) throw new Error('目前只支持“版本”为 1 的人设 JSON。');
            const persona = {
                name: value['角色'],
                tone: value['语气'],
                background: value['背景'],
                avoid: value['禁忌'],
                examples: value['示例']
            };
            rolePersonaFields.forEach(function(field) {
                if (typeof persona[field.key] !== 'string') throw new Error('人设 JSON 的“' + field.label + '”必须是文本。');
            });
            const validation = validateRolePersona(persona);
            if (!validation.valid) throw new Error(validation.error);
            return validation.persona;
        }
        function importRolePersonaJson(file) {
            if (!file) return;
            if (file.size > 256 * 1024) {
                setRolePersonaStatus('人设 JSON 不能超过 256 KB。', true);
                return;
            }
            const reader = new FileReader();
            reader.onerror = function() { setRolePersonaStatus('读取人设 JSON 失败。', true); };
            reader.onload = function() {
                try {
                    const persona = legacyPersonaFromJson(JSON.parse(String(reader.result || '')));
                    setRolePersonaInputs(persona);
                    describePersonaDraft(validateRolePersona());
                    setRolePersonaStatus('已导入“' + persona.name + '”的人设 JSON；保存角色资料后才会写入资料包。');
                } catch (error) {
                    setRolePersonaStatus(error.message || '人设 JSON 格式无效。', true);
                } finally {
                    if (rolePersonaImportInput) rolePersonaImportInput.value = '';
                }
            };
            reader.readAsText(file, 'utf-8');
        }
        function exportRolePersonaJson() {
            const validation = validateRolePersona();
            if (!validation.valid) {
                setRolePersonaStatus(validation.error, true);
                return;
            }
            const contents = JSON.stringify(personaJsonFromLegacy(validation.persona), null, 2) + '\n';
            const blob = new Blob([contents], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            const safeName = String(validation.persona.name || '角色资料').replace(/[\\/:*?"<>|]/g, '_').slice(0, 64) || '角色资料';
            link.href = url;
            link.download = safeName + '-persona.json';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(function() { URL.revokeObjectURL(url); }, 0);
            setRolePersonaStatus('已导出“' + validation.persona.name + '”的人设 JSON。');
        }
        function resetRolePersona() {
            const current = rolePersonaFromInputs();
            if (!window.confirm('恢复通用默认人设会覆盖当前编辑中的角色档案，继续吗？')) return;
            setRolePersonaInputs(defaultRolePersona(current.name));
            describePersonaDraft(validateRolePersona());
            setRolePersonaStatus('已恢复通用默认人设；保存角色资料后才会写入资料包。');
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
                    roleEditorContext.textContent = '正在编辑：' + role.name + '。' +
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
            setRolePersonaInputs(role && role.persona, role && role.name);
            describePersonaDraft(validateRolePersona());
            if (roleLanguage) roleLanguage.value = role ? (role.reference_language || '') : '';
            if (roleText) roleText.value = role ? (role.reference_text || '') : '';
            updateRoleEditorDetails(role);
            await loadRoleLive2DOptions(role && role.live2d_model_id, revision);
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
                const personaValidation = validateRolePersona();
                if (!personaValidation.valid) throw new Error(personaValidation.error);
                describePersonaDraft(personaValidation);

                // 新角色的内部 ID 只由服务端生成。浏览器只在已经存在的角色包
                // 上携带 ID，因而角色名称始终只来自 persona.json 的“角色”。
                let id = String(roleId && roleId.value || '').trim();
                const body = {
                    persona: personaValidation.persona,
                    reference_language: roleLanguage && roleLanguage.value,
                    reference_text: roleText && roleText.value,
                    live2d_model_id: roleLive2D && roleLive2D.value
                };
                if (id) body.role_id = id;

                // 上传顺序固定。已有角色使用隔离暂存批次，所有所选文件、文本、语言
                // 和 Live2D 绑定能一起提交前，旧资料包保持完整。
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
                const existing = id ? (roleList.find(function(role) { return role.role_id === id; }) || null) : null;
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
                    // 新建或未启用角色在明确启用前都是草稿，因此元数据建立后可安全接收资源。
                    const saved = await postRoleJson('/api/tts/roles', body);
                    savedRole = saved.role || body;
                    id = String(savedRole.role_id || '').trim();
                    if (!id) throw new Error('服务端没有返回新角色资料包标识。');
                    if (roleId) roleId.value = id;
                    await uploadSelectedAssets();
                }
                updateRoleEditorDetails(savedRole);
                await loadRoles();
                if (voiceSelect) voiceSelect.value = id;
                localStorage.setItem('tts_role_selected', id);
                renderRoles({ roles: roleList, active_role_id: activeRoleId });
                closeRoleEditor();
                const roleLabel = personaValidation.persona.name || id;
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
        rolePersonaFields.forEach(function(field) {
            if (!field.input) return;
            field.input.addEventListener('input', function() {
                updateRolePersonaCounters();
                const validation = validateRolePersona();
                if (validation.valid) describePersonaDraft(validation);
                else setRolePersonaStatus(validation.error, true);
            });
        });
        if (rolePersonaImportBtn) rolePersonaImportBtn.addEventListener('click', function() {
            if (!roleSaveInFlight && rolePersonaImportInput) rolePersonaImportInput.click();
        });
        if (rolePersonaImportInput) rolePersonaImportInput.addEventListener('change', function() {
            importRolePersonaJson(rolePersonaImportInput.files && rolePersonaImportInput.files[0]);
        });
        if (rolePersonaExportBtn) rolePersonaExportBtn.addEventListener('click', function() {
            if (!roleSaveInFlight) exportRolePersonaJson();
        });
        if (rolePersonaResetBtn) rolePersonaResetBtn.addEventListener('click', function() {
            if (!roleSaveInFlight) resetRolePersona();
        });
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
            renderPackMountMissing(st);
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
                    // 当前角色由服务端解析；下拉框只用于选择编辑/上传目标，不能在此选音色。
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
