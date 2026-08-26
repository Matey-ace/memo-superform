// ==========================================
// Memo Superform - SQLite 学习数据同步界面
// 仅编排本地数据服务，不直接全量请求墨墨学习记录。
// ==========================================

const StudySyncUI = (function() {
    const POLL_INTERVAL = 550;
    const MAX_WAIT_MS = 2 * 60 * 60 * 1000;
    let onRecordsChanged = null;
    let recordsFingerprint = null;
    let recordsDelivered = false;
    let syncInProgress = false;
    let activeSyncPromise = null;
    let currentStatus = null;
    let transientMessage = '';
    let transientTimer = null;

    function recordSignature(records) {
        return (Array.isArray(records) ? records : []).map(function(record) {
            return JSON.stringify([
                record && record.voc_id,
                record && record.voc_spelling,
                record && record.add_date,
                record && record.first_study_date,
                record && record.last_study_date,
                record && record.next_study_date,
                record && record.last_response,
                record && record.study_count,
                record && record.tags
            ]);
        }).sort().join('\u001e');
    }

    function number(value) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }

    function unwrapStatus(value) {
        if (value && value.status && typeof value.status === 'object') return value.status;
        if (value && value.sync && typeof value.sync === 'object') return value.sync;
        return value || {};
    }

    function isActive(status) {
        const state = String((status && status.status) || '').toLowerCase();
        return !!(status && (status.active === true || ['active', 'queued', 'running', 'starting'].includes(state)));
    }

    function hasChanges(status) {
        if (!status) return false;
        return status.changed === true || number(status.changed) > 0 ||
            number(status.added) > 0 || number(status.updated) > 0;
    }

    function messageFor(status) {
        if (!status) return '读取本地数据状态...';
        if (status.error) return '更新失败';
        const state = String(status.status || '').toLowerCase();
        if (state === 'cancelled') return '更新已取消';
        if (state === 'failed') return '更新失败';
        if (isActive(status)) {
            const phase = {
                queued: '等待更新', starting: '准备更新', bootstrap: '初始化数据',
                checking: '检查更新', fetching: '获取更新', syncing: '更新数据',
                reconcile: '完整核验', reconciling: '完整核验', finalizing: '整理数据'
            }[String(status.phase || state).toLowerCase()] || '正在更新';
            const progress = status.progress || {};
            if (number(progress.total) > 0) {
                const percent = progress.percent !== undefined ? Math.round(number(progress.percent)) :
                    Math.round(number(progress.current) / number(progress.total) * 100);
                return phase + ' ' + Math.max(0, Math.min(100, percent)) + '%';
            }
            return phase;
        }
        if (status.needs_reconcile) return '建议完整核验';
        if (hasChanges(status)) {
            const count = number(status.added) + number(status.updated) || number(status.changed);
            return '已更新 ' + count + ' 条';
        }
        if (state === 'completed' || state === 'idle' || !state) return '已是最新';
        return '数据状态：' + state;
    }

    function formatTime(value) {
        if (!value) return '--';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString('zh-CN', { hour12: false });
    }

    function coverageFor(status) {
        if (!status) return '加载中...';
        const coverage = status.coverage || status.covered_range || status.ranges;
        if (typeof coverage === 'string' && coverage) return coverage;
        if (coverage && typeof coverage === 'object') {
            const start = coverage.start || coverage.from || coverage.min_date;
            const end = coverage.end || coverage.to || coverage.max_date;
            if (start || end) return '已覆盖：' + (start || '--') + ' 至 ' + (end || '--');
        }
        if (status.records_count !== undefined) {
            return '本地当前记录：' + number(status.records_count) + ' 条；历史统计保持冻结';
        }
        return '历史统计保持冻结，日常仅更新变化数据';
    }

    function renderStatus(status) {
        currentStatus = status || currentStatus;
        const active = syncInProgress || isActive(currentStatus);
        const stateEl = document.getElementById('studySyncStatus');
        const metaEl = document.getElementById('studySyncMeta');
        const coverageEl = document.getElementById('studySyncCoverage');
        const reconcileBtn = document.getElementById('runReconcileBtn');
        const cancelBtn = document.getElementById('cancelStudySyncBtn');
        const refreshBtn = document.getElementById('refreshBtn');
        const autoToggle = document.getElementById('autoRefreshToggle');
        const message = messageFor(currentStatus);

        if (stateEl) {
            stateEl.textContent = message;
            stateEl.className = currentStatus && (currentStatus.error || currentStatus.status === 'failed') ?
                'status-text error' : (currentStatus && currentStatus.status === 'completed' ? 'status-text success' : 'hint');
        }
        if (metaEl) {
            const last = currentStatus && (currentStatus.last_incremental_at || currentStatus.last_sync_at ||
                currentStatus.finished_at || currentStatus.completed_at || currentStatus.updated_at);
            const counts = currentStatus ? '新增 ' + number(currentStatus.added) + ' · 更新 ' +
                number(currentStatus.updated) + ' · 未变 ' + number(currentStatus.unchanged) : '';
            metaEl.textContent = (last ? '上次更新：' + formatTime(last) : '上次更新：--') +
                (counts ? '（' + counts + '）' : '');
        }
        if (coverageEl) coverageEl.textContent = coverageFor(currentStatus);
        if (reconcileBtn) reconcileBtn.disabled = active;
        if (cancelBtn) cancelBtn.disabled = !active;
        if (refreshBtn) {
            refreshBtn.title = active ? '取消当前数据更新' : '刷新数据';
            refreshBtn.setAttribute('aria-label', refreshBtn.title);
        }
        if (autoToggle) autoToggle.classList.toggle('refreshing', active);
        notifyCountdownChanged();
    }

    function notifyCountdownChanged() {
        if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function' || typeof Event === 'undefined') return;
        window.dispatchEvent(new Event('memo-study-sync-status'));
    }

    function setTransientMessage(message) {
        transientMessage = message || '';
        if (transientTimer) clearTimeout(transientTimer);
        notifyCountdownChanged();
        if (!transientMessage) return;
        transientTimer = setTimeout(function() {
            transientMessage = '';
            transientTimer = null;
            notifyCountdownChanged();
        }, 3500);
    }

    function setChartsLoading(enabled) {
        document.querySelectorAll('.chart-container').forEach(function(element) {
            element.classList.toggle('loading', !!enabled);
        });
    }

    function deliverRecords(records, source, force) {
        const normalized = Array.isArray(records) ? records : [];
        const signature = recordSignature(normalized);
        const changed = !!force || !recordsDelivered || signature !== recordsFingerprint;
        recordsDelivered = true;
        recordsFingerprint = signature;
        if (changed && typeof onRecordsChanged === 'function') {
            onRecordsChanged(normalized, { source: source || 'sync' });
        }
        return changed;
    }

    function sleep(milliseconds) {
        return new Promise(function(resolve) { setTimeout(resolve, milliseconds); });
    }

    async function reloadRecordsIfNeeded(status, force) {
        if (!force && !hasChanges(status) && recordsDelivered) return false;
        const records = await MaimemoAPI.getAllStudyRecords(false);
        return deliverRecords(records, 'sync', force);
    }

    async function sync(mode, reason) {
        if (syncInProgress) return activeSyncPromise || Promise.resolve(currentStatus);
        syncInProgress = true;
        currentStatus = { status: 'active', active: true, phase: mode, mode: mode };
        renderStatus(currentStatus);

        const work = (async function() {
            let status = currentStatus;
            try {
                const started = await MaimemoAPI.startStudySync(mode, { reason: reason });
                status = unwrapStatus(started);
                if (!status.status && started && started.task_id) {
                    status = { status: 'active', active: true, phase: mode, mode: mode, task_id: started.task_id };
                }
                renderStatus(status);

                const deadline = Date.now() + MAX_WAIT_MS;
                while (isActive(status)) {
                    if (Date.now() > deadline) throw new Error('数据更新等待超时，请稍后重试');
                    await sleep(POLL_INTERVAL);
                    status = unwrapStatus(await MaimemoAPI.getStudySyncStatus());
                    renderStatus(status);
                }
                if (String(status.status || '').toLowerCase() === 'failed') {
                    throw new Error(status.error || '数据更新失败');
                }
                if (String(status.status || '').toLowerCase() !== 'cancelled') {
                    await reloadRecordsIfNeeded(status, mode === 'bootstrap');
                }
                renderStatus(status || { status: 'completed' });
                setTransientMessage(messageFor(status || { status: 'completed' }));
                return status;
            } catch (error) {
                status = Object.assign({}, status || {}, { status: 'failed', active: false, error: error.message });
                renderStatus(status);
                setTransientMessage(messageFor(status));
                throw error;
            } finally {
                syncInProgress = false;
                activeSyncPromise = null;
                renderStatus(status || { status: 'idle' });
            }
        })();
        activeSyncPromise = work;
        return work;
    }

    async function refreshStatus() {
        if (!MaimemoAPI.hasToken()) {
            renderStatus({ status: 'idle', records_count: 0 });
            const stateEl = document.getElementById('studySyncStatus');
            if (stateEl) stateEl.textContent = '请先配置墨墨 API Token';
            return null;
        }
        try {
            const status = unwrapStatus(await MaimemoAPI.getStudySyncStatus());
            renderStatus(status);
            return status;
        } catch (error) {
            const stateEl = document.getElementById('studySyncStatus');
            if (stateEl) { stateEl.textContent = '本地数据服务待连接'; stateEl.className = 'hint'; }
            return null;
        }
    }

    // 周核验只能在仪表盘空闲时由启动期请求触发。StudyWeb 会在真正的背词页
    // 挂载时写入 data-study-screen-active，设置页和全屏图表也不算空闲状态。
    function dashboardIsIdleForWeeklyCheck() {
        if (document.visibilityState && document.visibilityState !== 'visible') return false;
        if (window.LayoutManager && LayoutManager.isDragging && LayoutManager.isDragging()) return false;
        if (document.querySelector('#settingsPanel.show, .fullscreen-modal.show')) return false;
        return !document.querySelector('.study-web-container[data-study-screen-active="true"]');
    }

    async function loadInitialData(reason) {
        const records = await MaimemoAPI.getAllStudyRecords(true);
        const hadLocalRecords = records.length > 0;
        if (!hadLocalRecords) setChartsLoading(true);
        try {
            deliverRecords(records, 'startup', true);
            refreshStatus();
            if (hadLocalRecords) {
                const startupReason = reason || (dashboardIsIdleForWeeklyCheck() ? 'startup-idle' : 'startup');
                sync('incremental', startupReason).catch(function(error) {
                    console.warn('后台数据更新失败:', error);
                });
            } else {
                await sync('bootstrap', reason || 'startup-bootstrap');
            }
            return { records: records, hadLocalRecords: hadLocalRecords };
        } finally {
            if (!hadLocalRecords) setChartsLoading(false);
        }
    }

    async function manualRefresh() {
        if (syncInProgress || isActive(currentStatus)) return cancelCurrent();
        return sync('incremental', 'manual-refresh');
    }

    async function runReconcile() {
        if (syncInProgress) return activeSyncPromise;
        const confirmed = window.confirm('完整核验会重新核对历史单词的当前学习状态，可能需要较长时间。历史统计不会被重建。现在开始吗？');
        if (!confirmed) return null;
        return sync('reconcile', 'settings-reconcile');
    }

    async function cancelCurrent() {
        if (!syncInProgress && !isActive(currentStatus)) return null;
        const stateEl = document.getElementById('studySyncStatus');
        if (stateEl) { stateEl.textContent = '正在取消更新...'; stateEl.className = 'hint'; }
        try {
            const status = unwrapStatus(await MaimemoAPI.cancelStudySync());
            renderStatus(status || { status: 'cancelled', active: false });
            return status;
        } catch (error) {
            if (stateEl) { stateEl.textContent = '取消失败：' + error.message; stateEl.className = 'status-text error'; }
            throw error;
        }
    }

    function bindControls() {
        const reconcileBtn = document.getElementById('runReconcileBtn');
        const cancelBtn = document.getElementById('cancelStudySyncBtn');
        if (reconcileBtn) reconcileBtn.addEventListener('click', function() {
            runReconcile().catch(function(error) { console.error('完整核验失败:', error); });
        });
        if (cancelBtn) cancelBtn.addEventListener('click', function() {
            cancelCurrent().catch(function(error) { console.error('取消数据更新失败:', error); });
        });
    }

    function init(options) {
        options = options || {};
        onRecordsChanged = typeof options.onRecordsChanged === 'function' ? options.onRecordsChanged : null;
        bindControls();
        refreshStatus();
    }

    function reset() {
        recordsFingerprint = null;
        recordsDelivered = false;
        currentStatus = null;
        transientMessage = '';
    }

    function getCountdownText() {
        return syncInProgress ? messageFor(currentStatus) : transientMessage;
    }

    return {
        init: init,
        loadInitialData: loadInitialData,
        manualRefresh: manualRefresh,
        runIncremental: function(reason) { return sync('incremental', reason || 'auto-refresh'); },
        runReconcile: runReconcile,
        cancelCurrent: cancelCurrent,
        refreshStatus: refreshStatus,
        isSyncing: function() { return syncInProgress; },
        getCountdownText: getCountdownText,
        reset: reset
    };
})();
