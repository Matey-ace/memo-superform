// ==========================================
// Memo Superform - 布局模块
// 含分屏切换、全屏放大、拖拽互换
// ==========================================

const LayoutManager = (function() {
    let currentLayout = 'single';
    let fullscreenChartBackup = null;

    const layoutTileCount = {
        'single': 1, 'split2': 2, 'split3': 3, 'grid4': 4
    };

    const chartConfig = {
        'heatmap': { icon: '🔥', title: '打卡热力图', color: '#52c41a', toolbar: 'heatmap' },
        'trend':   { icon: '📈', title: '学习趋势',   color: '#1890ff', toolbar: 'trend' },
        'memory':  { icon: '🧠', title: '记忆曲线',   color: '#722ed1', toolbar: null },
        'aiclass': { icon: '🤖', title: 'AI 单词分类', color: '#fa8c16', toolbar: 'ai' },
        'notepad': { icon: '📚', title: '词书进度',   color: '#13c2c2', toolbar: null },
        'growth':  { icon: '📊', title: '词汇量增长', color: '#eb2f96', toolbar: null }
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
        const palettes = ChartManager.getHeatmapPalettes();
        const currentIdx = ChartManager.getPaletteIndex();
        let swatchesHtml = '';
        palettes.forEach(function(p, i) {
            const isActive = i === currentIdx ? ' active' : '';
            swatchesHtml += '<button class="palette-swatch' + isActive + '" data-palette="' + i + '" title="' + p.name + '">'
                + '<span class="swatch-dot" style="background:' + p.colors[2] + '"></span>'
                + '<span class="swatch-dot" style="background:' + p.colors[3] + '"></span>'
                + '<span class="swatch-name">' + p.name + '</span>'
                + '</button>';
        });
        return `
            <div class="chart-toolbar heatmap-toolbar">
                <div class="heatmap-nav">
                    <button class="heatmap-nav-btn" data-dir="-1" title="上个月">‹</button>
                    <span class="heatmap-month-label">${monthLabel}</span>
                    <button class="heatmap-nav-btn" data-dir="1" title="下个月">›</button>
                    <button class="heatmap-today-btn" title="回到本月">今天</button>
                </div>
                <div class="palette-row">
                    <span class="palette-label">配色</span>
                    <div class="palette-swatches">${swatchesHtml}</div>
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
            // 配色切换
            toolbar.querySelectorAll('.palette-swatch').forEach(sw => {
                sw.addEventListener('click', function() {
                    const idx = parseInt(this.dataset.palette);
                    ChartManager.setPaletteIndex(idx);
                    toolbar.querySelectorAll('.palette-swatch').forEach(s => s.classList.remove('active'));
                    this.classList.add('active');
                    const tileIndex = parseInt(tile.dataset.tile);
                    const ct = ChartManager.getChartType(tileIndex);
                    if (ct === 'heatmap') {
                        ChartManager.render(tileIndex, 'heatmap', { month: currentMonth });
                    }
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

    // ========== 拖拽互换（自定义指针拖拽 + 平滑吸附） ==========

    // 拖拽状态
    let dragState = null;
    let dragEndCallback = null;

    // 是否正在拖拽（供自动刷新模块查询，拖拽期间暂停刷新）
    function isDragging() { return dragState !== null; }

    // 注册拖拽结束回调（拖拽完成后触发，用于补刷被跳过的自动刷新）
    function setDragEndCallback(fn) { dragEndCallback = fn; }

    function setupDragAndDrop() {
        // 整块磁贴都可作为拖拽手柄（图表容器和控件区域除外，留给图表交互）
        document.querySelectorAll('.tile').forEach(tileEl => {
            tileEl.addEventListener('pointerdown', function(e) {
                // 单格布局或磁贴未显示时禁用
                if (currentLayout === 'single') return;
                // 从控件区域 / 工具栏按钮开始不触发拖拽（图表容器可拖，磁贴整块都能拖）
                if (e.target.closest('select, button, input, .chart-toolbar, .ai-toolbar')) return;
                // 只响应鼠标主键
                if (e.button !== 0) return;

                const tile = this;
                if (!tile || tile.style.display === 'none') return;

                const rect = tile.getBoundingClientRect();
                dragState = {
                    tile: tile,
                    pointerId: e.pointerId,
                    startX: e.clientX,
                    startY: e.clientY,
                    startRect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
                    dx: 0,
                    dy: 0,
                    moved: false,
                    target: null
                };

                tile.setPointerCapture(e.pointerId);
                tile.classList.add('dragging');
                document.body.classList.add('no-select');
            }, true);
        });

        // 拖动中：磁贴跟手 + 更新吸附目标
        document.addEventListener('pointermove', function(e) {
            if (!dragState) return;
            // 只处理当前拖拽的指针
            if (e.pointerId !== dragState.pointerId) return;

            const dx = e.clientX - dragState.startX;
            const dy = e.clientY - dragState.startY;

            // 移动超过阈值才视为拖动（避免误触）
            if (!dragState.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
            dragState.moved = true;
            dragState.dx = dx;
            dragState.dy = dy;

            const tile = dragState.tile;
            // 拖拽期间不要 transition，保证跟手
            tile.style.transform = 'translate(' + dx + 'px, ' + dy + 'px) scale(1.03)';

            // 更新吸附目标高亮
            updateDragTarget(e.clientX, e.clientY);
        }, true);

        // 松开：先平滑吸附，再交换图表
        document.addEventListener('pointerup', function(e) {
            if (!dragState) return;
            if (e.pointerId !== dragState.pointerId) return;
            finishDrag(e.clientX, e.clientY);
        }, true);

        document.addEventListener('pointercancel', function() {
            if (dragState) finishDrag(dragState.startX, dragState.startY);
        }, true);
    }

    // 判断指针当前位置吸附到哪个磁贴
    function updateDragTarget(x, y) {
        const tile = dragState.tile;
        let target = null;
        const margin = 12; // 吸附余量，磁贴外 12px 内也算命中

        document.querySelectorAll('.tile').forEach(t => {
            if (t === tile || t.style.display === 'none') return;
            const r = t.getBoundingClientRect();
            if (x >= r.left - margin && x <= r.right + margin &&
                y >= r.top - margin && y <= r.bottom + margin) {
                target = t;
            }
        });

        // 更新高亮
        if (dragState.target !== target) {
            if (dragState.target) dragState.target.classList.remove('drag-over');
            if (target) target.classList.add('drag-over');
            dragState.target = target;
        }
    }

    function clearDragTarget() {
        if (dragState && dragState.target) {
            dragState.target.classList.remove('drag-over');
            dragState.target = null;
        }
        document.querySelectorAll('.tile.drag-over').forEach(t => t.classList.remove('drag-over'));
    }

    // 结束拖拽：有目标平滑滑到位后换位，否则弹回原位
    function finishDrag(x, y) {
        const state = dragState;
        const tile = state.tile;
        const target = state.target;
        dragState = null;

        tile.classList.remove('dragging');
        document.body.classList.remove('no-select');

        // 未实际拖动：直接复位
        if (!state.moved) {
            tile.style.transform = '';
            clearDragTarget();
            return;
        }

        clearDragTarget();

        if (target && target !== tile) {
            // 平滑滑到目标格子（无回弹），动画结束后再互换 DOM 位置，视觉无缝
            animateSwapTo(tile, target, state);
        } else {
            // 未对准目标：平滑弹回原位（带惯性减速）
            tile.style.transition = 'transform 0.32s cubic-bezier(0.22, 1, 0.36, 1)';
            tile.style.transform = '';
            setTimeout(() => {
                tile.style.transition = '';
                if (dragEndCallback) dragEndCallback();
            }, 340);
        }
    }

    // 平滑交换：FLIP 技术——先滑动到目标位置，再无跳变交换 DOM，最后平滑过渡到最终位置
    function animateSwapTo(tile, target, state) {
        var tileRect = tile.getBoundingClientRect();
        var targetRect = target.getBoundingClientRect();
        var originLeft = state.startRect.left;
        var originTop = state.startRect.top;
        var glideDuration = 260;
        var glideEase = 'cubic-bezier(0.22, 1, 0.36, 1)';

        // 阶段1：两块磁贴同时滑动到对方位置
        var tx = targetRect.left - originLeft;
        var ty = targetRect.top - originTop;
        var bx = tileRect.left - targetRect.left;
        var by = tileRect.top - targetRect.top;

        tile.style.transition = 'transform ' + glideDuration + 'ms ' + glideEase;
        tile.style.transform = 'translate(' + tx + 'px, ' + ty + 'px) scale(1)';
        target.style.transition = 'transform ' + glideDuration + 'ms ' + glideEase;
        target.style.transform = 'translate(' + bx + 'px, ' + by + 'px)';

        var finalized = false;
        function finalize() {
            if (finalized) return;
            finalized = true;

            // === FLIP 技术核心 ===
            // First: 记录 DOM 交换前的视觉位置
            var tileFirst = tile.getBoundingClientRect();
            var targetFirst = target.getBoundingClientRect();

            // 清除动画 transform，让磁贴回到 transform 为空的视觉状态
            tile.style.transition = 'none';
            tile.style.transform = '';
            target.style.transition = 'none';
            target.style.transform = '';

            // 交换 DOM 位置（此时视觉上磁贴在原位，但 DOM 已换位）
            tile.classList.add('settling');
            target.classList.add('settling');
            swapPositions(tile, target);

            // Last: DOM 交换后磁贴的新位置
            var tileLast = tile.getBoundingClientRect();
            var targetLast = target.getBoundingClientRect();

            // Invert: 计算位置差，用 transform 反转回交换前的视觉位置
            var tileDx = tileFirst.left - tileLast.left;
            var tileDy = tileFirst.top - tileLast.top;
            var targetDx = targetFirst.left - targetLast.left;
            var targetDy = targetFirst.top - targetLast.top;

            tile.style.transform = 'translate(' + tileDx + 'px, ' + tileDy + 'px)';
            target.style.transform = 'translate(' + targetDx + 'px, ' + targetDy + 'px)';

            // 强制浏览器同步计算（消除 Invert 状态）
            void tile.offsetWidth;
            void target.offsetWidth;

            // Play: 平滑过渡到最终位置（transform 归零）
            var settleDuration = 200;
            var settleEase = 'cubic-bezier(0.22, 1, 0.36, 1)';
            tile.classList.remove('settling');
            target.classList.remove('settling');
            tile.style.transition = 'transform ' + settleDuration + 'ms ' + settleEase;
            target.style.transition = 'transform ' + settleDuration + 'ms ' + settleEase;
            tile.style.transform = '';
            target.style.transform = '';

            setTimeout(function() {
                tile.style.transition = '';
                target.style.transition = '';
            }, settleDuration + 50);

            if (dragEndCallback) dragEndCallback();
        }

        // 监听滑动动画结束
        tile.addEventListener('transitionend', function handler(e) {
            if (e.propertyName === 'transform' && e.target === tile) {
                tile.removeEventListener('transitionend', handler);
                finalize();
            }
        });

        // 兜底
        setTimeout(finalize, glideDuration + 300);
    }

    // 互换两个磁贴在网格中的位置（内容跟随磁贴一起移动）
    function swapPositions(tileA, tileB) {
        const parent = tileA.parentNode;
        if (!parent) return;

        // 真正交换两个磁贴的 DOM 位置，保持其他磁贴顺序不变。
        // 只交换 A、B 两个节点；中间磁贴不受影响，避免连锁移位。
        // 算法：记下 A 原位置的锚点，先搬 A 到 B 前，再把 B 搬到锚点前。
        const aNext = tileA.nextSibling === tileB ? tileA : tileA.nextSibling;
        parent.insertBefore(tileA, tileB);
        parent.insertBefore(tileB, aNext);

        // 换位只做纯 DOM 操作；图表尺寸适配延后，避免与换位同帧造成卡顿
        const indexA = parseInt(tileA.dataset.tile);
        const indexB = parseInt(tileB.dataset.tile);
        setTimeout(function() {
            const instA = ChartManager.getInstance(indexA);
            const instB = ChartManager.getInstance(indexB);
            if (instA) instA.resize();
            if (instB) instB.resize();
        }, 120);
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
        getCurrentLayout: () => currentLayout,
        isDragging,
        setDragEndCallback
    };
})();

