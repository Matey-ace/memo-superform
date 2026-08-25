// Memo Superform - shared dashboard contracts and behavior-neutral helpers.
const MemoDashboard = (function() {
    const layoutTileCount = { single: 1, split2: 2, split3: 3, grid4: 4 };
    const chartConfig = {
        heatmap: { icon: '🔥', title: '打卡热力图', color: '#52c41a', toolbar: 'heatmap' },
        trend: { icon: '📈', title: '学习趋势', color: '#1890ff', toolbar: 'trend' },
        memory: { icon: '🧠', title: '记忆曲线', color: '#722ed1', toolbar: null },
        aiclass: { icon: '🤖', title: 'AI 单词分类', color: '#fa8c16', toolbar: 'ai' },
        notepad: { icon: '📚', title: '词书进度', color: '#13c2c2', toolbar: null },
        growth: { icon: '📊', title: '词汇量增长', color: '#eb2f96', toolbar: null },
        recommend: { icon: '🎯', title: '智能复习推荐', color: '#e74c3c', toolbar: null },
        'study-web': { icon: '📖', title: '背单词', color: '#1677ff', toolbar: null },
        diary: { icon: '📔', title: '记忆手账', color: '#d4576b', toolbar: null }
    };
    function toBeijingDate(value) {
        if (!value) return null;
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    }
    function todayBeijing() { return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10); }
    function shiftDate(dateStr, deltaDays) {
        const parts = dateStr.split('-').map(Number);
        return new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + deltaDays)).toISOString().slice(0, 10);
    }
    function dateRange(days) {
        const today = todayBeijing(), dates = [];
        for (let i = days - 1; i >= 0; i--) dates.push(shiftDate(today, -i));
        return dates;
    }
    function escapeHtml(value) {
        const div = document.createElement('div'); div.textContent = value == null ? '' : String(value); return div.innerHTML;
    }
    function setupTheme(renderCharts) {
        const notebook = !!(window.MemoUIStyle && window.MemoUIStyle.isNotebook);
        const button = document.getElementById('themeBtn');
        const saved = localStorage.getItem('theme') || 'light';
        document.body.classList.toggle('dark', !notebook && saved === 'dark');
        if (button) { button.hidden = notebook; button.setAttribute('aria-hidden', notebook ? 'true' : 'false'); }
        updateThemeIcon();
        if (!button) return;
        button.addEventListener('click', function() {
            if (window.MemoUIStyle && window.MemoUIStyle.isNotebook) { document.body.classList.remove('dark'); updateThemeIcon(); return; }
            const dark = document.body.classList.toggle('dark');
            localStorage.setItem('theme', dark ? 'dark' : 'light'); updateThemeIcon(); renderCharts();
        });
    }
    function updateThemeIcon() {
        const dark = document.body.classList.contains('dark');
        const sun = document.getElementById('iconSun'), moon = document.getElementById('iconMoon');
        if (sun) sun.style.display = dark ? '' : 'none';
        if (moon) moon.style.display = dark ? 'none' : '';
    }
    return { layoutTileCount, chartConfig, toBeijingDate, todayBeijing, shiftDate, dateRange, escapeHtml, setupTheme };
})();
