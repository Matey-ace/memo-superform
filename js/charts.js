// ==========================================
// Memo Superform - 图表模块
// 使用 ECharts 渲染 4 个核心图表
// ==========================================

const ChartManager = (function() {
    // 存储所有图表实例 { tileIndex: { chartType, instance } }
    const chartInstances = {};
    // 缓存数据
    let cachedRecords = null;
    let cachedAIClassification = null;
    
    // ---- 数据处理工具 ----
    
    // 将 ISO 日期字符串转为北京时区的日期字符串 (YYYY-MM-DD)
    function toBeijingDate(isoString) {
        if (!isoString) return null;
        const date = new Date(isoString);
        // 转为北京时间 (UTC+8)
        const beijingTime = date.getTime() + 8 * 60 * 60 * 1000;
        const beijingDate = new Date(beijingTime);
        const year = beijingDate.getUTCFullYear();
        const month = String(beijingDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(beijingDate.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // 获取今天的日期 (北京时区)
    function getTodayBeijing() {
        const now = new Date();
        const beijingTime = now.getTime() + 8 * 60 * 60 * 1000 + (now.getTimezoneOffset() * 60 * 1000);
        const d = new Date(beijingTime);
        // 用本地方法格式化，因为已经加了偏移
        const year = d.getUTCFullYear();
        const month = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // 获取过去 N 天的日期数组
    function getDateRange(days) {
        const dates = [];
        const today = getTodayBeijing();
        const baseDate = new Date(today + 'T00:00:00+08:00');
        
        for (let i = days - 1; i >= 0; i--) {
            const d = new Date(baseDate.getTime() - i * 24 * 60 * 60 * 1000);
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            dates.push(`${year}-${month}-${day}`);
        }
        return dates;
    }
    
    // 从学习记录中聚合每日学习数据
    function aggregateDailyData(records, days) {
        const dateMap = {};
        const dates = getDateRange(days);
        
        // 初始化
        dates.forEach(d => {
            dateMap[d] = { newCount: 0, reviewCount: 0, totalCount: 0, correctCount: 0, studyTime: 0 };
        });
        
        // 根据 last_study_date 聚合（学习过的单词在那天有记录）
        // 注意：墨墨 API 每条记录是一个单词，不是每日记录
        // 我们用 study_count 来推断哪些天学过这个单词
        for (const record of records) {
            const lastDate = toBeijingDate(record.last_study_date);
            const addDate = toBeijingDate(record.add_date);
            
            // 统计最后一次学习
            if (lastDate && dateMap[lastDate]) {
                dateMap[lastDate].totalCount++;
                // 根据 response 判断是否正确
                if (record.last_response === 'FAMILIAR' || 
                    record.last_response === 'WELL_FAMILIAR') {
                    dateMap[lastDate].correctCount++;
                }
            }
            
            // 新学单词：add_date 在范围内
            if (addDate && dateMap[addDate]) {
                dateMap[addDate].newCount++;
            }
            
            // 对于历史学习，study_count 表示学习过多少次
            // 但我们没法精确知道每天学了多少，只能近似
            // 用 study_count > 0 且 last_study_date 在范围内的作为复习数
            if (lastDate && dateMap[lastDate] && record.study_count > 1) {
                // 这个单词在这天学过且不是第一次，算复习
                if (addDate !== lastDate) {
                    dateMap[lastDate].reviewCount++;
                }
            }
        }
        
        return { dates, dateMap };
    }
    
    // 格式化日期为 YYYY-MM
    function formatMonth(date) {
        return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0');
    }

    // 获取当月最后一天
    function getDaysInMonth(year, month) {
        return new Date(year, month, 0).getDate(); // month 是 1-12
    }

    // 生成月度热力图数据
    function generateMonthHeatmapData(records, monthStr) {
        // monthStr: 'YYYY-MM'
        const [year, month] = monthStr.split('-').map(Number);
        const daysInMonth = getDaysInMonth(year, month);
        const today = getTodayBeijing();

        // 初始化每天计数
        const dailyCount = {};
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            dailyCount[dateStr] = 0;
        }

        // 用 last_study_date 统计哪天学过单词
        for (const record of records) {
            const lastDate = toBeijingDate(record.last_study_date);
            if (lastDate && dailyCount[lastDate] !== undefined) {
                dailyCount[lastDate]++;
            }
        }

        // 统计信息
        let checkinDays = 0;
        let totalWords = 0;
        let maxCount = 0;
        for (const dateStr in dailyCount) {
            const c = dailyCount[dateStr];
            if (c > 0) { checkinDays++; totalWords += c; }
            if (c > maxCount) maxCount = c;
        }

        // 连续打卡天数（从今天往前数，今天没学则从昨天算）
        let streak = 0;
        const cursor = new Date();
        const todayStr = getTodayBeijing();
        if (dailyCount[todayStr] === 0) {
            cursor.setDate(cursor.getDate() - 1);
        }
        // 只在查看本月时计算连续打卡
        if (formatMonth(cursor) === monthStr) {
            while (true) {
                const y = cursor.getFullYear();
                const m = String(cursor.getMonth() + 1).padStart(2, '0');
                const d = String(cursor.getDate()).padStart(2, '0');
                const ds = y + '-' + m + '-' + d;
                if (dailyCount[ds] > 0) {
                    streak++;
                    cursor.setDate(cursor.getDate() - 1);
                } else {
                    break;
                }
            }
        }

        // ECharts 数据格式 [[date, count], ...]
        const heatmapData = [];
        for (let d = 1; d <= daysInMonth; d++) {
            const dateStr = year + '-' + String(month).padStart(2, '0') + '-' + String(d).padStart(2, '0');
            heatmapData.push([dateStr, dailyCount[dateStr]]);
        }

        return {
            data: heatmapData,
            maxCount,
            checkinDays,
            totalWords,
            streak,
            daysInMonth,
            monthStr,
            year,
            month
        };
    }
    
    // 生成记忆保持曲线数据
    // 理念：回答「学过的单词现在还记得多少」
    // 按「距上次学习的间隔」分组，用每个单词最近一次学习反馈计算该间隔下的记忆保持率
    function generateMemoryCurveData(records) {
        const buckets = [
            { label: '≤3天', min: 0, max: 3, total: 0, well: 0, familiar: 0, vague: 0, forget: 0 },
            { label: '4-7天', min: 4, max: 7, total: 0, well: 0, familiar: 0, vague: 0, forget: 0 },
            { label: '8-14天', min: 8, max: 14, total: 0, well: 0, familiar: 0, vague: 0, forget: 0 },
            { label: '15-30天', min: 15, max: 30, total: 0, well: 0, familiar: 0, vague: 0, forget: 0 },
            { label: '31-60天', min: 31, max: 60, total: 0, well: 0, familiar: 0, vague: 0, forget: 0 },
            { label: '>60天', min: 61, max: Infinity, total: 0, well: 0, familiar: 0, vague: 0, forget: 0 }
        ];

        const now = new Date();

        for (const record of records) {
            const lastDate = record.last_study_date;
            const response = record.last_response;
            if (!lastDate || !response) continue;

            const days = Math.floor((now.getTime() - new Date(lastDate).getTime()) / (24 * 60 * 60 * 1000));
            if (days < 0) continue;

            const bucket = buckets.find(b => days >= b.min && days <= b.max);
            if (!bucket) continue;

            switch (response) {
                case 'WELL_FAMILIAR': bucket.total++; bucket.well++; break;
                case 'FAMILIAR': bucket.total++; bucket.familiar++; break;
                case 'VAGUE': bucket.total++; bucket.vague++; break;
                case 'FORGET': bucket.total++; bucket.forget++; break;
                default: break; // 其他状态（如取消熟知）不计入
            }
        }

        // 每个分组的保持率（熟知 + 认识 视为「还记得」）
        const series = buckets.map(b => ({
            label: b.label,
            total: b.total,
            rate: b.total > 0 ? Math.round((b.well + b.familiar) / b.total * 100) : null,
            well: b.well,
            familiar: b.familiar,
            vague: b.vague,
            forget: b.forget
        }));

        // 总体保持率与记忆状态汇总
        let totalWithFeedback = 0;
        let remembered = 0;
        let wellTotal = 0;
        let familiarTotal = 0;
        let vagueTotal = 0;
        let forgetTotal = 0;
        for (const r of records) {
            switch (r.last_response) {
                case 'WELL_FAMILIAR': wellTotal++; remembered++; totalWithFeedback++; break;
                case 'FAMILIAR': familiarTotal++; remembered++; totalWithFeedback++; break;
                case 'VAGUE': vagueTotal++; totalWithFeedback++; break;
                case 'FORGET': forgetTotal++; totalWithFeedback++; break;
                default: break;
            }
        }

        return {
            series,
            overallRate: totalWithFeedback > 0 ? Math.round(remembered / totalWithFeedback * 100) : 0,
            totalWithFeedback,
            wellTotal,
            familiarTotal,
            vagueTotal,
            forgetTotal
        };
    }
    
    // ---- 图表渲染函数 ----
    
    // 1. 热力图 - 月度学习日历
    // 当月颜色（按学习量分级）
    function getHeatColor(count, maxCount) {
        if (count === 0) return '#ebedf0';
        const ratio = count / Math.max(maxCount, 1);
        if (ratio < 0.25) return '#c6e48b';
        if (ratio < 0.5) return '#7bc96f';
        if (ratio < 0.75) return '#239a3b';
        return '#216e39';
    }

    function renderHeatmap(containerId, records, options = {}) {
        const chart = echarts.init(document.getElementById(containerId));

        // 目标月份：options.month 或当前月
        const today = new Date();
        const currentMonth = formatMonth(today);
        const targetMonth = options.month || currentMonth;
        const [ty, tm] = targetMonth.split('-').map(Number);

        const result = generateMonthHeatmapData(records, targetMonth);

        // 统计数据文本
        const statsLine = `打卡 ${result.checkinDays} 天 · 学习 ${result.totalWords} 词次` +
            (result.streak > 0 ? ` · 连续 ${result.streak} 天` : '');

        // 格子数据带颜色
        // 每个数据项单独指定格子颜色和数字颜色，保证深色格子上数字清晰可见
        const coloredData = result.data.map(([dateStr, count]) => {
            const color = getHeatColor(count, result.maxCount);
            const isDark = count > 0 && (count / Math.max(result.maxCount, 1)) >= 0.5;
            return {
                value: [dateStr, count],
                itemStyle: {
                    color: color,
                    borderRadius: 6
                },
                label: {
                    color: count === 0 ? '#b0b7c3' : (isDark ? '#ffffff' : '#1a1a2e'),
                    textBorderColor: isDark ? '#0f3d1f' : '#ffffff',
                    textBorderWidth: isDark ? 2 : 1.5
                }
            };
        });

        const option = {
            title: {
                text: targetMonth + ' 学习日历',
                subtext: statsLine,
                left: 'center',
                top: 5,
                textStyle: { fontSize: 14, fontWeight: 600, color: '#1a1a2e' },
                subtextStyle: { fontSize: 11, color: '#6b7280' }
            },
            tooltip: {
                formatter: function(params) {
                    const count = params.value[1];
                    const dateStr = params.value[0];
                    const dayNum = parseInt(dateStr.slice(8), 10);
                    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(ty, tm - 1, dayNum).getDay()];
                    const todayStr = getTodayBeijing();
                    const isToday = dateStr === todayStr ? '（今天）' : '';
                    return `<strong>${dateStr} ${week}${isToday}</strong><br/>学习 ${count} 个单词`;
                }
            },
            visualMap: {
                show: false
            },
            calendar: {
                top: 70,
                left: 30,
                right: 30,
                bottom: 20,
                cellSize: ['auto', 22],
                range: targetMonth,
                itemStyle: {
                    borderWidth: 3,
                    borderColor: '#fff',
                    borderRadius: 6
                },
                yearLabel: { show: false },
                monthLabel: { show: false },
                dayLabel: {
                    firstDay: 1,
                    nameMap: ['日', '一', '二', '三', '四', '五', '六'],
                    fontSize: 11,
                    color: '#6b7280',
                    position: 'start',
                    margin: 8
                },
                splitLine: { show: false }
            },
            series: [{
                type: 'heatmap',
                coordinateSystem: 'calendar',
                data: coloredData,
                label: {
                    show: true,
                    formatter: function(params) {
                        return params.value[1] > 0 ? params.value[1] : '';
                    },
                    fontSize: 12,
                    fontWeight: 600
                },
                emphasis: {
                    itemStyle: {
                        borderColor: '#1890ff',
                        borderWidth: 2,
                        shadowBlur: 8,
                        shadowColor: 'rgba(24, 144, 255, 0.4)'
                    }
                }
            }]
        };

        chart.setOption(option);
        return chart;
    }
    
    // 2. 学习趋势图
    function renderTrendChart(containerId, records, days = 30) {
        const chart = echarts.init(document.getElementById(containerId));
        const { dates, dateMap } = aggregateDailyData(records, days);
        
        const newData = dates.map(d => dateMap[d].newCount);
        const reviewData = dates.map(d => dateMap[d].reviewCount);
        const totalData = dates.map(d => dateMap[d].totalCount);
        
        // 计算汇总
        const totalNew = newData.reduce((a, b) => a + b, 0);
        const totalReview = reviewData.reduce((a, b) => a + b, 0);
        const avgDaily = Math.round(totalData.reduce((a, b) => a + b, 0) / days);
        
        const option = {
            title: {
                text: `学习趋势（近 ${days} 天）`,
                subtext: `新学 ${totalNew} 词 · 复习 ${totalReview} 词 · 日均 ${avgDaily} 词`,
                left: 'center',
                top: 5,
                textStyle: { fontSize: 14, fontWeight: 600, color: '#1a1a2e' },
                subtextStyle: { fontSize: 11, color: '#6b7280' }
            },
            tooltip: {
                trigger: 'axis',
                axisPointer: { type: 'cross' }
            },
            legend: {
                data: ['新学', '复习', '总计'],
                bottom: 5,
                textStyle: { fontSize: 11, color: '#6b7280' }
            },
            grid: {
                left: 50,
                right: 30,
                top: 60,
                bottom: 45
            },
            xAxis: {
                type: 'category',
                data: dates,
                axisLabel: {
                    fontSize: 10,
                    color: '#9ca3af',
                    rotate: days > 30 ? 45 : 0,
                    formatter: function(value) {
                        if (days <= 7) return value.slice(5); // MM-DD
                        if (days <= 30) return value.slice(8); // DD
                        // 90天以上：显示月份
                        return value.slice(5);
                    }
                },
                axisLine: { lineStyle: { color: '#e5e7eb' } }
            },
            yAxis: {
                type: 'value',
                axisLabel: { fontSize: 10, color: '#9ca3af' },
                splitLine: { lineStyle: { color: '#f3f4f6' } }
            },
            series: [
                {
                    name: '新学',
                    type: 'bar',
                    stack: 'total',
                    data: newData,
                    itemStyle: { 
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: '#52c41a' },
                            { offset: 1, color: '#95de64' }
                        ]),
                        borderRadius: [0, 0, 0, 0]
                    }
                },
                {
                    name: '复习',
                    type: 'bar',
                    stack: 'total',
                    data: reviewData,
                    itemStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: '#1890ff' },
                            { offset: 1, color: '#69c0ff' }
                        ]),
                        borderRadius: [4, 4, 0, 0]
                    }
                },
                {
                    name: '总计',
                    type: 'line',
                    data: totalData,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 6,
                    lineStyle: { color: '#722ed1', width: 2 },
                    itemStyle: { color: '#722ed1' },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: 'rgba(114, 46, 209, 0.15)' },
                            { offset: 1, color: 'rgba(114, 46, 209, 0)' }
                        ])
                    }
                }
            ]
        };
        
        chart.setOption(option);
        return chart;
    }
    
    // 3. 记忆曲线图
    function renderMemoryChart(containerId, records) {
        const chart = echarts.init(document.getElementById(containerId));
        const result = generateMemoryCurveData(records);

        const consolidating = result.familiarTotal + result.vagueTotal + result.forgetTotal;
        const totalWords = result.totalWithFeedback || 0;

        // 记忆状态数据（过滤为 0 的状态，保持图表干净）
        const states = [
            { name: '已熟知', value: result.wellTotal, color: '#52c41a', desc: '掌握牢固，无需再复习' },
            { name: '认识', value: result.familiarTotal, color: '#1890ff', desc: '能认出，需要按计划复习' },
            { name: '模糊', value: result.vagueTotal, color: '#fa8c16', desc: '印象模糊，容易遗忘' },
            { name: '忘记', value: result.forgetTotal, color: '#f5222d', desc: '已遗忘，需要重新学习' }
        ].filter(s => s.value > 0);

        const pieData = states.map(s => ({
            name: s.name,
            value: s.value,
            itemStyle: { color: s.color }
        }));

        // 记忆健康度评级
        let rating = '';
        let ratingColor = '#52c41a';
        if (result.overallRate >= 80) rating = '记忆状态优秀';
        else if (result.overallRate >= 60) { rating = '记忆状态良好'; ratingColor = '#52c41a'; }
        else if (result.overallRate >= 40) { rating = '需要加强复习'; ratingColor = '#fa8c16'; }
        else { rating = '急需巩固'; ratingColor = '#f5222d'; }

        const option = {
            title: {
                text: '记忆掌握度',
                subtext: `共 ${totalWords} 词 · 待巩固 ${consolidating} 词 · ${rating}`,
                left: 'center',
                top: 5,
                textStyle: { fontSize: 14, fontWeight: 600, color: '#1a1a2e' },
                subtextStyle: { fontSize: 11, color: '#6b7280' }
            },
            tooltip: {
                trigger: 'item',
                formatter: function(params) {
                    const state = states.find(s => s.name === params.name);
                    const pct = totalWords > 0 ? (params.value / totalWords * 100).toFixed(1) : '0';
                    return `<strong>${params.name}</strong><br/>` +
                        `单词数：${params.value} 个（${pct}%）<br/>` +
                        `<span style="color:#6b7280;font-size:11px">${state ? state.desc : ''}</span>`;
                }
            },
            legend: {
                orient: 'vertical',
                right: 20,
                top: 'middle',
                textStyle: { fontSize: 12, color: '#1a1a2e' },
                formatter: function(name) {
                    const s = states.find(x => x.name === name);
                    const pct = totalWords > 0 ? Math.round(s.value / totalWords * 100) : 0;
                    return name + '  ' + s.value + '词 (' + pct + '%)';
                }
            },
            series: [{
                name: '记忆状态',
                type: 'pie',
                radius: ['48%', '72%'],
                center: ['40%', '56%'],
                avoidLabelOverlap: true,
                itemStyle: {
                    borderRadius: 8,
                    borderColor: '#fff',
                    borderWidth: 3
                },
                label: {
                    show: false
                },
                emphasis: {
                    scaleSize: 6,
                    label: {
                        show: true,
                        fontSize: 14,
                        fontWeight: 'bold',
                        formatter: '{b}\n{c}词 ({d}%)'
                    }
                },
                labelLine: { show: false },
                data: pieData
            }],
            graphic: [{
                type: 'group',
                left: '40%',
                top: '46%',
                children: [
                    {
                        type: 'text',
                        style: {
                            text: result.overallRate + '%',
                            fontSize: 34,
                            fontWeight: 700,
                            fill: ratingColor,
                            textAlign: 'center'
                        }
                    },
                    {
                        type: 'text',
                        top: 42,
                        style: {
                            text: '总体掌握率',
                            fontSize: 12,
                            fill: '#6b7280',
                            textAlign: 'center'
                        }
                    }
                ]
            }]
        };

        chart.setOption(option);
        return chart;
    }
    
    // 4. AI 单词分类图
    function renderAIClassificationChart(containerId, classificationData) {
        const chart = echarts.init(document.getElementById(containerId));
        
        if (!classificationData) {
            // 占位提示
            chart.setOption({
                title: {
                    text: 'AI 单词分类',
                    subtext: '点击上方按钮，使用 AI 分析你的单词分类',
                    left: 'center',
                    top: 'center',
                    textStyle: { fontSize: 14, fontWeight: 600, color: '#1a1a2e' },
                    subtextStyle: { fontSize: 11, color: '#6b7280' }
                }
            });
            return chart;
        }
        
        // 转换数据格式
        const pieData = Object.entries(classificationData).map(([name, words]) => ({
            name: name,
            value: Array.isArray(words) ? words.length : 0
        })).filter(d => d.value > 0).sort((a, b) => b.value - a.value);
        
        const totalWords = pieData.reduce((sum, d) => sum + d.value, 0);
        
        const option = {
            title: {
                text: 'AI 单词主题分类',
                subtext: `共分析 ${totalWords} 个单词 · ${pieData.length} 个类别`,
                left: 'center',
                top: 5,
                textStyle: { fontSize: 14, fontWeight: 600, color: '#1a1a2e' },
                subtextStyle: { fontSize: 11, color: '#6b7280' }
            },
            tooltip: {
                trigger: 'item',
                formatter: function(params) {
                    const words = classificationData[params.name] || [];
                    const sample = words.slice(0, 5).join(', ');
                    return `<strong>${params.name}</strong><br/>
                            单词数: ${params.value}<br/>
                            占比: ${params.percent}%<br/>
                            示例: ${sample}${words.length > 5 ? '...' : ''}`;
                }
            },
            legend: {
                type: 'scroll',
                orient: 'vertical',
                right: 10,
                top: 50,
                bottom: 20,
                textStyle: { fontSize: 11, color: '#6b7280' }
            },
            series: [
                {
                    name: '单词分类',
                    type: 'pie',
                    radius: ['40%', '70%'],
                    center: ['40%', '55%'],
                    avoidLabelOverlap: true,
                    itemStyle: {
                        borderRadius: 8,
                        borderColor: '#fff',
                        borderWidth: 2
                    },
                    label: {
                        show: false,
                        position: 'center'
                    },
                    emphasis: {
                        label: {
                            show: true,
                            fontSize: 14,
                            fontWeight: 'bold',
                            formatter: '{b}\n{c}词 ({d}%)'
                        }
                    },
                    labelLine: { show: false },
                    data: pieData
                }
            ]
        };
        
        chart.setOption(option);
        return chart;
    }
    
    // ---- 公共 API ----
    
    // 设置/更新学习记录数据
    function setRecords(records) {
        cachedRecords = records;
    }
    
    function getRecords() {
        return cachedRecords;
    }
    
    function setAIClassification(data) {
        cachedAIClassification = data;
    }
    
    function getAIClassification() {
        return cachedAIClassification;
    }
    
    // 渲染指定图表
    function render(tileIndex, chartType, options = {}) {
        const containerId = 'chart-' + tileIndex;
        const container = document.getElementById(containerId);
        if (!container) return null;
        
        // 销毁旧图表
        if (chartInstances[tileIndex]) {
            chartInstances[tileIndex].instance.dispose();
        }
        
        let chart = null;
        
        switch (chartType) {
            case 'heatmap':
                chart = renderHeatmap(containerId, cachedRecords || [], options);
                break;
            case 'trend':
                chart = renderTrendChart(containerId, cachedRecords || [], options.days || 30);
                break;
            case 'memory':
                chart = renderMemoryChart(containerId, cachedRecords || []);
                break;
            case 'aiclass':
                chart = renderAIClassificationChart(containerId, cachedAIClassification);
                break;
        }
        
        if (chart) {
            chartInstances[tileIndex] = {
                chartType: chartType,
                instance: chart,
                options: options
            };
        }
        
        return chart;
    }
    
    // 重新渲染所有可见图表
    function rerenderAll() {
        Object.keys(chartInstances).forEach(tileIndex => {
            const info = chartInstances[tileIndex];
            const tileEl = document.querySelector(`.tile[data-tile="${tileIndex}"]`);
            if (tileEl && tileEl.style.display !== 'none') {
                info.instance.resize();
            }
        });
    }
    
    // 获取指定 tile 的图表实例
    function getInstance(tileIndex) {
        return chartInstances[tileIndex]?.instance || null;
    }
    
    // 获取指定 tile 的图表类型
    function getChartType(tileIndex) {
        return chartInstances[tileIndex]?.chartType || null;
    }
    
    // 销毁所有图表
    function disposeAll() {
        Object.values(chartInstances).forEach(info => {
            info.instance.dispose();
        });
        Object.keys(chartInstances).forEach(k => delete chartInstances[k]);
    }
    
    return {
        setRecords,
        getRecords,
        setAIClassification,
        getAIClassification,
        render,
        rerenderAll,
        getInstance,
        getChartType,
        disposeAll
    };
})();
