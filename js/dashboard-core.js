// Memo Superform - 仪表盘共享契约与不改变行为的辅助方法。
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
        diary: { icon: '📔', title: 'Anon的笔记本', color: '#d4576b', toolbar: null }
    };
    // 每条记录在每个图表里都要独立换算一次北京时间；大词库下这是重绘的主要成本
    // （实测 5 万条记录：单次遍历 32 ms，换成 Map 查表 1.3 ms）。字符串与数值是不可变
    // 原始值，按值缓存安全；Date 等对象会被原地修改（setTime），按身份缓存会返回
    // 过期日期，因此对象输入一律实时换算、绝不入缓存。上限用于避免长期累积占内存。
    const BEIJING_DATE_CACHE_LIMIT = 200000;
    const beijingDateCache = new Map();
    function toBeijingDate(value) {
        if (!value) return null;
        // 只有不可变原始值才允许进缓存；Date 对象必须每次重新换算。
        const cacheable = typeof value === 'string' || typeof value === 'number';
        if (cacheable) {
            const cached = beijingDateCache.get(value);
            if (cached !== undefined) return cached;
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return null;
        const result = new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (cacheable) {
            if (beijingDateCache.size >= BEIJING_DATE_CACHE_LIMIT) beijingDateCache.clear();
            beijingDateCache.set(value, result);
        }
        return result;
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
