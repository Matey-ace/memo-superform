// ==========================================
// Memo Superform - 布局模块
// 含分屏切换、全屏放大、拖拽互换
// ==========================================

const LayoutManager = (function() {
    let currentLayout = 'single';
    let fullscreenChartBackup = null;
    let dragSrcTile = null;

    const layoutTileCount = {
        'single': 1, 'split2': 2, 'split3': 3, 'grid4': 4
    };

    const chartConfig = {
        'heatmap': { icon: '🔥', title: '打卡热力图', color: '#52c41a', toolbar: 'heatmap' },
        'trend':   { icon: '📈', title: '学习趋势',   color: '#1890ff', toolbar: 'trend' },
        'memory':  { icon: '🧠', title: '记忆曲线',   color: '#722ed1', toolbar: null },
        'aiclass': { icon: '🤖', title: 'AI 单词分类', color: '#fa8c16', toolbar: 'ai' }
    };

    function init() {
        setupLayoutSwitcher();
        setupFullscreen();
        setupChartSelectors();
        setupWindowResize();
        setupDragAndDrop();
        // 初始化每个磁贴的工具栏（与当前图表类型同步）
        document.querySelectorAll('.tile').forEach(tile => {
            const selector = tile.querySelector('.chart-selector');
            if (selector) {
                applyChartToTile(tile, selector.value);
            }
        });
    }

    // ========== 布局切换 ==========

    function setupLayoutSwitcher() {
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.addEventListener('click', function() {
                switchLayout(this.dataset.layout);
            });
        });
    }

    function switchLayout(layout) {
        if (!layoutTileCount[layout]) return;
        currentLayout = layout;
        document.getElementById('dashboard').className = 'dashboard layout-' + layout;
        document.querySelectorAll('.layout-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.layout === layout);
        });
        // single 布局只有一个磁贴，禁用拖拽
        const draggable = layout !== 'single';
        document.querySelectorAll('.tile').forEach((tile, index) => {
            tile.style.display = index < layoutTileCount[layout] ? 'flex' : 'none';
            tile.draggable = draggable;
        });
        setTimeout(() => ChartManager.rerenderAll(), 100);
    }

    // ========== 全屏放大 ==========

    function setupFullscreen() {
        document.querySelectorAll('.tile-fullscreen').forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.stopPropagation();
                openFullscreen(parseInt(this.closest('.tile').dataset.tile));
            });
        });
        const modal = document.getElementById('fullscreenModal');
        document.getElementById('closeFullscreen').addEventListener('click', closeFullscreen);
        modal.addEventListener('click', function(e) { if (e.target === this) closeFullscreen(); });
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && modal.classList.contains('show')) closeFullscreen();
        });
    }

    function openFullscreen(tileIndex) {
        const chartType = ChartManager.getChartType(tileIndex);
        if (!chartType) return;
        document.getElementById('fullscreenModal').classList.add('show');
        setTimeout(() => {
            const inst = ChartManager.getInstance(tileIndex);
            if (!inst) return;
            const fs = echarts.init(document.getElementById('fullscreenChart'));
            fs.setOption(inst.getOption());
            fullscreenChartBackup = { tileIndex, instance: fs };
        }, 50);
    }

    function closeFullscreen() {
        document.getElementById('fullscreenModal').classList.remove('show');
        if (fullscreenChartBackup) {
            fullscreenChartBackup.instance.dispose();
            fullscreenChartBackup = null;
        }
        document.getElementById('fullscreenChart').innerHTML = '';
        setTimeout(() => ChartManager.rerenderAll(), 100);
    }

    // ========== 工具栏构建 ==========

    function buildAIToolbar() {
        const today = new Date();
        const thirtyDaysAgo = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
        const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');

        return `
            <div class="ai-toolbar">
                <div class="ai-source-row">
                    <select class="ai-source-select">
                        <option value="notepad">云词本单词</option>
                        <option value="study" selected>学习记录单词</option>
                    </select>
                    <div class="ai-date-range" style="display: flex;">
                        <input type="date" class="ai-date-input ai-date-start" value="${fmt(thirtyDaysAgo)}" title="开始日期">
                        <span class="ai-date-sep">~</span>
                        <input type="date" class="ai-date-input ai-date-end" value="${fmt(today)}" title="结束日期">
                    </div>
                    <select class="ai-date-field">
                        <option value="last_study_date" selected>按最后学习日期</option>
                        <option value="first_study_date">按首次学习日期</option>
                        <option value="add_date">按添加日期</option>
                    </select>
                </div>
                <div class="ai-action-row">
                    <div class="ai-quick-range">
                        <button class="ai-range-btn" data-days="7">7天</button>
                        <button class="ai-range-btn active" data-days="30">30天</button>
                        <button class="ai-range-btn" data-days="90">90天</button>
                        <button class="ai-range-btn" data-days="365">1年</button>
                        <button class="ai-range-btn" data-days="all">全部</button>
                    </div>
                    <button class="ai-btn">✨ 使用 AI 分类单词</button>
                </div>
                <span class="ai-status"></span>
            </div>
        `;
    }

    function buildTrendToolbar() {
        return `
            <div class="chart-toolbar">
                <div class="range-buttons">
                    <button class="range-btn active" data-range="7">7天</button>
                    <button class="range-btn" data-range="30">30天</button>
                    <button class="range-btn" data-range="90">90天</button>
                    <button class="range-btn" data-range="all">全部</button>
                </div>
            </div>
        `;
    }

    function buildHeatmapToolbar() {
        const today = new Date();
        const monthLabel = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
        return `
            <div class="chart-toolbar heatmap-toolbar">
                <div class="heatmap-nav">
                    <button class="heatmap-nav-btn" data-dir="-1" title="上个月">‹</button>
                    <span class="heatmap-month-label">${monthLabel}</span>
                    <button class="heatmap-nav-btn" data-dir="1" title="下个月">›</button>
                    <button class="heatmap-today-btn" title="回到本月">今天</button>
                </div>
            </div>
        `;
    }

    function updateTileToolbar(tile, chartType) {
        const config = chartConfig[chartType];
        if (!config) return;

        const tileBody = tile.querySelector('.tile-body');
        const oldToolbar = tileBody.querySelector('.chart-toolbar, .ai-toolbar');
        if (oldToolbar) oldToolbar.remove();

        if (config.toolbar === 'trend') {
            const div = document.createElement('div');
            div.innerHTML = buildTrendToolbar();
            const toolbar = div.firstElementChild;
            const chartContainer = tileBody.querySelector('.chart-container');
            tileBody.insertBefore(toolbar, chartContainer);

            toolbar.querySelectorAll('.range-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const tileIndex = parseInt(tile.dataset.tile);
                    const days = this.dataset.range === 'all' ? 365 : parseInt(this.dataset.range);
                    tile.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
                    this.classList.add('active');
                    if (ChartManager.getChartType(tileIndex) === 'trend') {
                        ChartManager.render(tileIndex, 'trend', { days: days });
                    }
                });
            });
        } else if (config.toolbar === 'heatmap') {
            const div = document.createElement('div');
            div.innerHTML = buildHeatmapToolbar();
            const toolbar = div.firstElementChild;
            const chartContainer = tileBody.querySelector('.chart-container');
            tileBody.insertBefore(toolbar, chartContainer);

            // 当前展示的月份（初始为本月）
            const now = new Date();
            let currentMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
            const labelEl = toolbar.querySelector('.heatmap-month-label');

            function renderMonth(monthStr) {
                const tileIndex = parseInt(tile.dataset.tile);
                labelEl.textContent = monthStr;
                ChartManager.render(tileIndex, 'heatmap', { month: monthStr });
            }

            toolbar.querySelectorAll('.heatmap-nav-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    const dir = parseInt(this.dataset.dir);
                    const [y, m] = currentMonth.split('-').map(Number);
                    const date = new Date(y, m - 1 + dir, 1);
                    currentMonth = date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
                    renderMonth(currentMonth);
                });
            });

            toolbar.querySelector('.heatmap-today-btn').addEventListener('click', function() {
                const d = new Date();
                currentMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                renderMonth(currentMonth);
            });
        } else if (config.toolbar === 'ai') {
            const div = document.createElement('div');
            div.innerHTML = buildAIToolbar();
            const toolbar = div.firstElementChild;
            const chartContainer = tileBody.querySelector('.chart-container');
            tileBody.insertBefore(toolbar, chartContainer);

            const sourceSelect = toolbar.querySelector('.ai-source-select');
            const dateRange = toolbar.querySelector('.ai-date-range');
            const dateField = toolbar.querySelector('.ai-date-field');
            const quickRange = toolbar.querySelector('.ai-quick-range');

            sourceSelect.addEventListener('change', function() {
                const showDates = this.value === 'study';
                dateRange.style.display = showDates ? 'flex' : 'none';
                dateField.style.display = showDates ? '' : 'none';
                quickRange.style.display = showDates ? 'flex' : 'none';
            });

            toolbar.querySelectorAll('.ai-range-btn').forEach(btn => {
                btn.addEventListener('click', function() {
                    toolbar.querySelectorAll('.ai-range-btn').forEach(b => b.classList.remove('active'));
                    this.classList.add('active');

                    const days = this.dataset.days;
                    const startInput = toolbar.querySelector('.ai-date-start');
                    const endInput = toolbar.querySelector('.ai-date-end');
                    const today = new Date();
                    const fmt = d => d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
                    endInput.value = fmt(today);

                    if (days === 'all') {
                        startInput.value = '2020-01-01';
                    } else {
                        const start = new Date(today.getTime() - parseInt(days) * 24 * 60 * 60 * 1000);
                        startInput.value = fmt(start);
                    }
                });
            });
        }
    }

    // ========== 图表选择器 ==========

    function setupChartSelectors() {
        document.querySelectorAll('.chart-selector').forEach(selector => {
            selector.addEventListener('change', function(e) {
                e.stopPropagation();
                const tile = this.closest('.tile');
                const tileIndex = parseInt(tile.dataset.tile);
                applyChartToTile(tile, this.value);
                ChartManager.render(tileIndex, this.value);
            });
        });
    }

    // 将指定图表类型应用到磁贴（更新 header + 工具栏 + selector）
    function applyChartToTile(tile, chartType) {
        const config = chartConfig[chartType];
        if (!config) return;

        const header = tile.querySelector('.tile-header');
        header.style.setProperty('--accent-color', config.color);
        tile.querySelector('.tile-icon').textContent = config.icon;
        tile.querySelector('.tile-title').textContent = config.title;

        const selector = tile.querySelector('.chart-selector');
        if (selector) selector.value = chartType;

        updateTileToolbar(tile, chartType);
    }

    // ========== 拖拽互换 ==========

    function setupDragAndDrop() {
        const tiles = document.querySelectorAll('.tile');

        tiles.forEach(tile => {
            // dragstart - 开始拖拽
            tile.addEventListener('dragstart', function(e) {
                // 如果从控件区域开始拖拽，取消
                if (e.target.closest('select, button, input, .chart-toolbar, .ai-toolbar')) {
                    e.preventDefault();
                    return;
                }

                dragSrcTile = this;
                this.classList.add('dragging');
                e.dataTransfer.effectAllowed = 'move';
                // Firefox 需要设置 data
                e.dataTransfer.setData('text/plain', this.dataset.tile);
            });

            // dragend - 拖拽结束
            tile.addEventListener('dragend', function() {
                this.classList.remove('dragging');
                // 清除所有 drag-over 标记
                document.querySelectorAll('.tile.drag-over').forEach(t => t.classList.remove('drag-over'));
                dragSrcTile = null;
            });

            // dragover - 拖拽经过（必须 preventDefault 才能 drop）
            tile.addEventListener('dragover', function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (this !== dragSrcTile) {
                    this.classList.add('drag-over');
                }
            });

            // dragleave - 拖拽离开
            tile.addEventListener('dragleave', function(e) {
                // 检查是否真的离开了这个 tile（不是进入子元素）
                if (!this.contains(e.relatedTarget)) {
                    this.classList.remove('drag-over');
                }
            });

            // drop - 放置
            tile.addEventListener('drop', function(e) {
                e.preventDefault();
                e.stopPropagation();

                this.classList.remove('drag-over');

                if (dragSrcTile && dragSrcTile !== this) {
                    swapTiles(dragSrcTile, this);
                }
            });
        });
    }

    // 交换两个磁贴的图表内容
    function swapTiles(tileA, tileB) {
        const indexA = parseInt(tileA.dataset.tile);
        const indexB = parseInt(tileB.dataset.tile);

        // 获取两个磁贴当前的图表类型
        const typeA = ChartManager.getChartType(indexA) || 'heatmap';
        const typeB = ChartManager.getChartType(indexB) || 'heatmap';

        // 如果类型相同，不需要交换
        if (typeA === typeB) return;

        // 交换：A 显示 B 的图表，B 显示 A 的图表
        applyChartToTile(tileA, typeB);
        applyChartToTile(tileB, typeA);

        // 重新渲染两个图表
        // 趋势图需要保留 days 参数
        const optionsA = typeB === 'trend' ? { days: 30 } : {};
        const optionsB = typeA === 'trend' ? { days: 30 } : {};

        setTimeout(() => {
            ChartManager.render(indexA, typeB, optionsA);
            ChartManager.render(indexB, typeA, optionsB);
        }, 50);
    }

    // ========== 窗口大小变化 ==========

    function setupWindowResize() {
        let timer;
        window.addEventListener('resize', function() {
            clearTimeout(timer);
            timer = setTimeout(() => ChartManager.rerenderAll(), 200);
        });
    }

    return {
        init,
        switchLayout,
        openFullscreen,
        closeFullscreen,
        getCurrentLayout: () => currentLayout
    };
})();

