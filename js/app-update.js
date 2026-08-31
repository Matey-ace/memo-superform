// Memo Superform - 应用内更新 UI。
// 版本比较、Release 来源和完整性校验全部在本地 Python 服务完成；浏览器只渲染
// 已收口的状态，并在用户明确点击后请求下载或安装。
(function () {
    'use strict';

    const REMINDER_PREFIX = 'memo_app_update_reminder_';
    const REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000;
    let initialized = false;
    let checkInFlight = false;
    let actionInFlight = false;
    let pollTimer = null;
    let lastInfo = null;
    let previousFocus = null;

    function byId(id) { return document.getElementById(id); }

    function bytes(value) {
        const number = Number(value || 0);
        if (!Number.isFinite(number) || number <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(number) / Math.log(1024)));
        const amount = number / Math.pow(1024, index);
        return (index === 0 ? String(Math.round(amount)) : amount.toFixed(amount >= 10 ? 0 : 1)) + ' ' + units[index];
    }

    function escapedVersion(info, field) {
        return 'v' + String((info && info[field]) || '--').replace(/^v/i, '');
    }

    function downloadText(info) {
        const download = (info && info.download) || {};
        if (download.state === 'downloading') {
            return '正在下载并校验：' + Number(download.progress || 0) + '%（' + bytes(download.downloaded_bytes) + ' / ' + bytes(download.total_bytes) + '）';
        }
        if (download.state === 'ready') return '下载完成，已通过 SHA-256 校验，可以安装。';
        if (download.state === 'applying') return '正在关闭当前应用并交给更新器安装…';
        if (download.state === 'error') return String(download.message || '下载更新失败，请重试');
        return '';
    }

    function primaryLabel(info) {
        const download = (info && info.download) || {};
        if (download.state === 'downloading') return '正在下载 ' + Number(download.progress || 0) + '%';
        if (download.state === 'applying') return '正在安装…';
        if (download.state === 'ready') return '立即重启并安装';
        if (!info || !info.can_download) return '前往下载页';
        return '下载并安装';
    }

    function actionDisabled(info) {
        const state = ((info && info.download) || {}).state;
        return actionInFlight || state === 'downloading' || state === 'applying';
    }

    function setStatus(text, type) {
        const node = byId('appUpdateStatus');
        if (!node) return;
        node.textContent = text;
        node.className = type === 'error' ? 'status-text error' : (type === 'success' ? 'status-text success' : 'hint');
    }

    function setButtonState(button, info) {
        if (!button) return;
        const available = Boolean(info && info.update_available);
        button.hidden = !available;
        button.textContent = primaryLabel(info);
        button.disabled = actionDisabled(info);
    }

    function render(info) {
        if (!info) return;
        const current = byId('appUpdateCurrentVersion');
        if (current) current.textContent = escapedVersion(info, 'current_version');

        const progress = downloadText(info);
        if (progress) {
            const state = ((info.download || {}).state);
            setStatus(progress, state === 'error' ? 'error' : (state === 'ready' ? 'success' : ''));
        } else if (info.update_available) {
            setStatus('发现 ' + escapedVersion(info, 'latest_version') + (info.important ? '（重要更新）' : ' 可用'), info.important ? 'error' : '');
        } else {
            setStatus(String(info.message || '已是最新版本'), info.check_error ? 'error' : 'success');
        }

        setButtonState(byId('appUpdateInstallBtn'), info);
        updateModalContents(info);
    }

    function updateModalContents(info) {
        const modal = byId('appUpdateModal');
        if (!modal || !info) return;
        const title = byId('appUpdateModalTitle');
        const description = byId('appUpdateModalDescription');
        const current = byId('appUpdateModalCurrent');
        const latest = byId('appUpdateModalLatest');
        const notes = byId('appUpdateModalNotes');
        const progress = byId('appUpdateModalProgress');
        if (title) title.textContent = info.important ? '发现重要更新' : '发现可用更新';
        if (description) {
            description.textContent = info.install_supported
                ? '新版本 ' + escapedVersion(info, 'latest_version') + ' 已准备好。下载完成后会校验文件，再关闭并重启应用安装。'
                : '新版本 ' + escapedVersion(info, 'latest_version') + ' 已发布；当前环境不能原地替换 EXE，可打开官方发布页下载。';
        }
        if (current) current.textContent = escapedVersion(info, 'current_version');
        if (latest) latest.textContent = escapedVersion(info, 'latest_version');
        if (notes) notes.textContent = String(info.release_notes || '本次 Release 没有填写版本说明。');
        if (progress) progress.textContent = downloadText(info);
        setButtonState(byId('appUpdateModalPrimaryBtn'), info);
    }

    function reminderKey(version) {
        return REMINDER_PREFIX + String(version || '').replace(/[^0-9A-Za-z._-]/g, '_');
    }

    function isReminderActive(info) {
        if (!info || !info.latest_version) return false;
        try {
            const saved = Number(localStorage.getItem(reminderKey(info.latest_version)) || 0);
            if (Date.now() - saved < REMINDER_WINDOW_MS) return true;
            localStorage.removeItem(reminderKey(info.latest_version));
        } catch (e) {}
        return false;
    }

    function rememberLater() {
        if (lastInfo && lastInfo.latest_version) {
            try { localStorage.setItem(reminderKey(lastInfo.latest_version), String(Date.now())); } catch (e) {}
        }
    }

    function isOpen() {
        const modal = byId('appUpdateModal');
        return Boolean(modal && modal.classList.contains('show'));
    }

    function openModal(info) {
        const modal = byId('appUpdateModal');
        if (!modal || !info || !info.update_available) return;
        previousFocus = document.activeElement;
        updateModalContents(info);
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
        window.setTimeout(function () {
            const primary = byId('appUpdateModalPrimaryBtn');
            if (primary && !primary.disabled) primary.focus();
            else {
                const close = byId('appUpdateCloseBtn');
                if (close) close.focus();
            }
        }, 0);
    }

    function closeModal(remind) {
        const modal = byId('appUpdateModal');
        if (!modal) return;
        if (remind) rememberLater();
        modal.classList.remove('show');
        modal.setAttribute('aria-hidden', 'true');
        if (previousFocus && typeof previousFocus.focus === 'function') {
            previousFocus.focus();
        }
        previousFocus = null;
    }

    async function fetchStatus(force) {
        const response = await fetch('/api/app/update-status' + (force ? '?force=1' : ''), { cache: 'no-store' });
        let data = null;
        try { data = await response.json(); } catch (e) {}
        if (!response.ok || !data) throw new Error((data && data.error) || '暂时无法检查更新');
        return data;
    }

    async function check(options) {
        const settings = Object.assign({ force: false, automatic: false, prompt: false, silent: false }, options || {});
        if (checkInFlight) return lastInfo;
        checkInFlight = true;
        if (!settings.silent) setStatus('正在检查更新…');
        try {
            const info = await fetchStatus(settings.force);
            lastInfo = info;
            render(info);
            if (info.update_available && info.important && (settings.automatic || settings.prompt) && !isReminderActive(info)) {
                openModal(info);
            }
            return info;
        } catch (error) {
            if (!settings.silent) setStatus('暂时无法检查更新', 'error');
            return null;
        } finally {
            checkInFlight = false;
        }
    }

    function stopPolling() {
        if (pollTimer) {
            window.clearTimeout(pollTimer);
            pollTimer = null;
        }
    }

    function pollDownload() {
        stopPolling();
        const poll = async function () {
            const info = await check({ silent: true });
            const state = ((info && info.download) || {}).state;
            if (state === 'downloading' || state === 'applying') {
                pollTimer = window.setTimeout(poll, 700);
            }
        };
        pollTimer = window.setTimeout(poll, 450);
    }

    function openReleasePage() {
        const url = lastInfo && lastInfo.release_url;
        if (!url) {
            setStatus('未取得官方发布页地址，请稍后重新检查', 'error');
            return;
        }
        const opened = window.open(url, '_blank', 'noopener');
        if (opened) opened.opener = null;
    }

    async function post(path) {
        const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: '{}',
        });
        let data = null;
        try { data = await response.json(); } catch (e) {}
        if (!response.ok || !data || data.ok === false) throw new Error((data && data.error) || '更新操作失败');
        return data;
    }

    async function handlePrimary() {
        const info = lastInfo;
        if (!info || !info.update_available || actionInFlight) return;
        const state = ((info.download) || {}).state;
        if (!info.can_download) {
            openReleasePage();
            return;
        }
        if (state === 'downloading' || state === 'applying') return;
        if (state === 'ready') {
            if (!window.confirm('即将关闭 Memo Superform 并安装 ' + escapedVersion(info, 'latest_version') + '。请确认已保存正在编辑的设置或内容。')) return;
            actionInFlight = true;
            render(info);
            try {
                await post('/api/app/update/apply');
                info.download = Object.assign({}, info.download, { state: 'applying', message: '正在交给更新器安装…' });
                render(info);
            } catch (error) {
                setStatus(error.message || '启动更新器失败', 'error');
                await check({ silent: true });
            } finally {
                actionInFlight = false;
            }
            return;
        }

        actionInFlight = true;
        render(info);
        try {
            const result = await post('/api/app/update/download');
            info.download = result.download || { state: 'downloading', progress: 0 };
            render(info);
            pollDownload();
        } catch (error) {
            setStatus(error.message || '下载更新失败', 'error');
        } finally {
            actionInFlight = false;
            render(info);
        }
    }

    function bindEvents() {
        const checkButton = byId('appUpdateCheckBtn');
        if (checkButton) checkButton.addEventListener('click', function () { check({ force: true, prompt: true }); });
        const installButton = byId('appUpdateInstallBtn');
        if (installButton) installButton.addEventListener('click', handlePrimary);
        const modalPrimary = byId('appUpdateModalPrimaryBtn');
        if (modalPrimary) modalPrimary.addEventListener('click', handlePrimary);
        const later = byId('appUpdateLaterBtn');
        if (later) later.addEventListener('click', function () { closeModal(true); });
        const close = byId('appUpdateCloseBtn');
        if (close) close.addEventListener('click', function () { closeModal(true); });
        const modal = byId('appUpdateModal');
        if (modal) modal.addEventListener('click', function (event) {
            if (event.target === modal) closeModal(true);
        });
        // 捕获阶段截获 Escape，避免下层的设置面板或全屏图表也收到同一次按键。
        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && isOpen()) {
                event.preventDefault();
                event.stopPropagation();
                closeModal(true);
            }
        }, true);
    }

    function init() {
        if (initialized) return;
        initialized = true;
        bindEvents();
        // 与数据加载并行，不依赖 Token，也不阻塞用户开始背词。
        check({ automatic: true });
    }

    window.AppUpdate = { init: init, check: check, isOpen: isOpen };
})();
