'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { chromium } = require('playwright');
const outArg = process.argv.indexOf('--out');
if (outArg < 0 || !process.argv[outArg + 1]) throw new Error('Required: --out <new evidence directory>');
const out = path.resolve(process.argv[outArg + 1]);
if (fs.existsSync(out)) throw new Error('Refusing to overwrite evidence: ' + out);
fs.mkdirSync(out, { recursive: true });
const before = fs.readFileSync(path.resolve('docs/redesign/source-before/js/charts.js'), 'utf8');
const after = fs.readFileSync(path.resolve('js/charts.js'), 'utf8');
const palette = ['#B8321F', '#1A1714', '#6B6258', '#9C6B30', '#1F3A4D', '#D8CCB2'];
const types = ['heatmap', 'trend', 'memory', 'aiclass', 'notepad', 'growth'];
const states = [
    { name: 'notebook-light', attr: 'notebook' },
    { name: 'notebook-dark', attr: 'notebook', dark: true },
    { name: 'missing-light', attr: null },
    { name: 'missing-dark', attr: null, dark: true },
    { name: 'companion-light', attr: 'standard', companion: true },
    { name: 'companion-dark', attr: 'standard', companion: true, dark: true },
    { name: 'main-light', attr: 'standard', main: true },
    { name: 'main-dark', attr: 'standard', main: true, dark: true }
];
// This factory runs unchanged in Node VM and a fresh, unauthenticated browser page.
function fixture(state, browser) {
    const NativeDate = Date;
    class FixedDate extends NativeDate {
        constructor(...args) { super(...(args.length ? args : ['2026-11-16T04:00:00Z'])); }
        static now() { return new NativeDate('2026-11-16T04:00:00Z').getTime(); }
    }
    globalThis.Date = FixedDate;
    const store = {};
    const element = { offsetParent: {}, getClientRects: () => [{}], querySelector: () => null };
    if (!browser) {
        globalThis.document = {
            documentElement: { getAttribute: () => state.attr },
            body: { classList: { contains: name => name === 'dark' ? !!state.dark : name === 'companion-mode' && !!state.companion } },
            getElementById: () => element
        };
        globalThis.localStorage = { getItem: key => store[key] || null, setItem: (key, value) => { store[key] = value; } };
        globalThis.window = globalThis;
    } else {
        if (state.attr === null) document.documentElement.removeAttribute('data-ui-style');
        else document.documentElement.setAttribute('data-ui-style', state.attr);
        document.body.className = (state.dark ? 'dark ' : '') + (state.companion ? 'companion-mode' : '');
    }
    const dateString = date => date.toISOString().slice(0, 10);
    globalThis.MemoDashboard = {
        toBeijingDate: value => value ? String(value).slice(0, 10) : null,
        todayBeijing: () => '2026-11-16',
        shiftDate: (value, days) => { const date = new NativeDate(value + 'T00:00:00Z'); date.setUTCDate(date.getUTCDate() + days); return dateString(date); },
        dateRange: days => Array.from({ length: days }, (_, i) => { const date = new NativeDate('2026-11-16T00:00:00Z'); date.setUTCDate(date.getUTCDate() - days + i + 1); return dateString(date); }),
        escapeHtml: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    };
    globalThis.captured = [];
    globalThis.echarts = {
        graphic: { LinearGradient: function(x, y, x2, y2, colorStops) { Object.assign(this, { type: 'linear', x, y, x2, y2, colorStops }); } },
        init: () => ({ setOption: option => captured.push(option), dispose() {}, resize() {} })
    };
}
function runFixture() {
    const responses = ['WELL_FAMILIAR', 'FAMILIAR', 'VAGUE', 'FORGET', 'UNKNOWN'];
    const intervals = [1, 5, 10, 20, 40, 80];
    const records = Array.from({ length: 48 }, (_, i) => ({
        voc_spelling: 'word' + i,
        add_date: ['2026-09-02', '2026-10-09', '2026-11-14'][i % 3],
        last_study_date: MemoDashboard.shiftDate('2026-11-16', intervals[i % 6]),
        last_response: responses[i % 5], study_count: i % 4 + 1
    }));
    ChartManager.setRecords(records);
    ChartManager.setAIClassification({ 'A<&"': ['one<&', 'two', 'three', 'four', 'five', 'six'], B: ['a'], C: ['b', 'c'], Empty: [] });
    ChartManager.setNotepadWords(Array.from({ length: 50 }, (_, i) => ({ word: 'word' + i, notepad: i % 2 ? 'Z<&' : 'A', notepad_id: i % 2 + 1 })));
    const types = ['heatmap', 'trend', 'memory', 'aiclass', 'notepad', 'growth'];
    const encode = value => {
        if (typeof value === 'function') return { functionSource: String(value) };
        if (Array.isArray(value)) return value.map(encode);
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).map(key => [key, encode(value[key])]));
        return value;
    };
    const results = [];
    for (let p = 0; p < 6; p++) {
        ChartManager.setPaletteIndex(p);
        const options = {};
        for (let i = 0; i < types.length; i++) {
            ChartManager.render(i, types[i], { month: '2026-11', days: 30 });
            const option = captured[captured.length - 1];
            const params = types[i] === 'heatmap' ? { value: ['2026-11-15', 8] } :
                types[i] === 'aiclass' ? { name: 'A<&"', value: 6, percent: 66.67 } : [{ dataIndex: 0 }];
            options[types[i]] = { option: encode(option), tooltip: typeof option.tooltip.formatter === 'function' ? option.tooltip.formatter(params) : null };
        }
        results.push({ palettes: encode(ChartManager.getHeatmapPalettes()), index: ChartManager.getPaletteIndex(), options });
    }
    ChartManager.setAIClassification(null);
    ChartManager.render(3, 'aiclass');
    const emptyAI = encode(captured[captured.length - 1]);
    ChartManager.setNotepadWords([]);
    ChartManager.render(4, 'notepad');
    return { results, emptyAI, emptyNotepad: encode(captured[captured.length - 1]), records: encode(ChartManager.getRecords()) };
}
function captureVM(source, state) {
    const context = vm.createContext({});
    vm.runInContext('(' + fixture + ')(' + JSON.stringify(state) + ', false);', context);
    vm.runInContext(source, context);
    return JSON.parse(vm.runInContext('JSON.stringify((' + runFixture + ')())', context));
}
let checks = 0;
const equal = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const paintKey = /^(?:color|backgroundColor|borderColor|textBorderColor|shadowColor|borderRadius|shadowBlur|shadowOffsetX|shadowOffsetY|textBorderWidth|fontFamily|borderWidth|opacity|extraCssText|confine)$/;
function comparePaint(oldValue, newValue, keyPath = '') {
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) return;
    const key = keyPath.split('.').pop();
    if (paintKey.test(key)) { checks++; return; }
    // The memory tooltip wrapper is paint-only; its evaluated text is checked separately.
    if (key === 'functionSource' && keyPath === 'tooltip.formatter.functionSource') return;
    if (oldValue === undefined && /^(textStyle|itemStyle)$/.test(key)) oldValue = {};
    assert.ok(oldValue && newValue && typeof oldValue === 'object' && typeof newValue === 'object', 'Non-paint changed: ' + keyPath);
    for (const child of new Set([...Object.keys(oldValue), ...Object.keys(newValue)])) {
        comparePaint(oldValue[child], newValue[child], keyPath ? keyPath + '.' + child : child);
    }
}
function assertFlat(value) {
    if (!value || typeof value !== 'object') return;
    assert.ok(!value.colorStops, 'No main gradient'); checks++;
    for (const [key, child] of Object.entries(value)) {
        if (key === 'borderRadius' || key === 'shadowBlur') equal(child, 0, 'flat ' + key);
        if (key === 'fontFamily') assert.ok(child.includes('Microsoft YaHei') && !child.includes('http'));
        assertFlat(child);
    }
}
function validate(oldCapture, newCapture, state) {
    if (!state.main) { equal(newCapture, oldCapture, state.name + ' complete deep equality including function source'); return; }
    equal(newCapture.records, oldCapture.records, 'cached records unchanged');
    comparePaint(oldCapture.emptyAI, newCapture.emptyAI);
    comparePaint(oldCapture.emptyNotepad, newCapture.emptyNotepad);
    const heatSignatures = [];
    for (let i = 0; i < 6; i++) {
        const oldResult = oldCapture.results[i], result = newCapture.results[i];
        equal(result.index, i, 'palette persistence');
        equal(result.palettes.map(p => p.name), oldResult.palettes.map(p => p.name), 'palette names');
        for (const type of types) {
            const old = oldResult.options[type], now = result.options[type];
            comparePaint(old.option, now.option);
            equal(now.tooltip && now.tooltip.replace(/color:#[a-f0-9]{6}/gi, 'color:PAINT'), old.tooltip && old.tooltip.replace(/color:#[a-f0-9]{6}/gi, 'color:PAINT'), 'formatter content and escaping');
            equal(now.option.color, palette, 'hard palette ordered');
            equal(now.option.tooltip.extraCssText, 'border-radius:0;box-shadow:none;backdrop-filter:none;');
            assertFlat(now.option);
            for (let s = 0; s < now.option.series.length; s++) {
                if (type !== 'heatmap') equal(now.option.series[s].data, old.option.series[s].data, type + ' data/sort unchanged');
                if (type !== 'heatmap' && type !== 'aiclass') equal(now.option.series[s].itemStyle.color, palette[s], 'explicit series palette');
            }
            if (type === 'heatmap') equal(now.option.series[0].data.map(d => d.value), old.option.series[0].data.map(d => d.value), 'dates/counts unchanged');
            if (state.dark && type !== 'heatmap') equal(now.option.series[0].itemStyle.borderColor, '#ECE3CF', 'dark ink outline');
            if (type === 'notepad') {
                const luminance = hex => {
                    const rgb = [1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16) / 255)
                        .map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
                    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
                };
                now.option.series.filter(s => s.label.show).forEach(s => {
                    const a = luminance(s.itemStyle.color), b = luminance(s.label.color);
                    equal((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, true, 'visible nonempty notepad label contrast');
                });
            }
            if (type === 'aiclass') equal(now.option.series[0].label.color, state.dark ? '#ECE3CF' : '#1A1714', 'pie label semantic ink');
        }
        heatSignatures.push(JSON.stringify(result.options.heatmap.option.series[0].data.map(d => d.itemStyle.color)));
    }
    equal(new Set(heatSignatures).size, 6, 'all six heatmap choices distinguishable');
}
(async () => {
    const evidence = { fixture: 'synthetic, fixed 2026-11-16; no account/DB/model access', vm: {}, browser: {} };
    for (const state of states) {
        const old = captureVM(before, state), now = captureVM(after, state);
        validate(old, now, state);
        evidence.vm[state.name] = { before: old, after: now };
    }
    const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
    try {
        const context = await browser.newContext();
        await context.route('**/*', route => route.request().url() === 'http://127.0.0.1:55395/sa7-fixture' ?
            route.fulfill({ contentType: 'text/html', body: '<!doctype html><body>' + types.map((_, i) => '<div id="chart-' + i + '" style="width:500px;height:300px"></div>').join('') }) : route.abort());
        const captureBrowser = async (source, state) => {
            const page = await context.newPage();
            try {
                await page.goto('http://127.0.0.1:55395/sa7-fixture');
                // Pass both parameters explicitly rather than serializing browser globals.
                await page.evaluate(({ code, state }) => (0, eval)('(' + code + ')(' + JSON.stringify(state) + ',true)'), { code: String(fixture), state });
                await page.addScriptTag({ content: source + '\nwindow.ChartManager = ChartManager;' });
                return await page.evaluate('(' + runFixture + ')()');
            } finally { await page.close(); }
        };
        for (const state of states) {
            const old = await captureBrowser(before, state), now = await captureBrowser(after, state);
            validate(old, now, state);
            equal(now, evidence.vm[state.name].after, 'VM/browser parity');
            evidence.browser[state.name] = { before: old, after: now };
        }
        evidence.render = [];
        const echartsSource = fs.readFileSync(path.resolve('vendor/echarts.min.js'), 'utf8');
        for (const state of states.filter(s => s.main)) {
            for (const width of [1280, 390]) {
                const page = await context.newPage({ viewport: { width, height: 900 } });
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                try {
                    await page.goto('http://127.0.0.1:55395/sa7-fixture');
                    await page.evaluate(({ code, state }) => (0, eval)('(' + code + ')(' + JSON.stringify(state) + ',true)'), { code: String(fixture), state });
                    await page.addScriptTag({ content: echartsSource });
                    await page.evaluate(() => {
                        const init = echarts.init;
                        echarts.init = function(...args) {
                            const chart = init.apply(this, args);
                            const set = chart.setOption;
                            chart.setOption = function(option) { captured.push(option); return set.call(this, option); };
                            return chart;
                        };
                    });
                    await page.addScriptTag({ content: after + '\nwindow.ChartManager = ChartManager;' });
                    await page.addStyleTag({ content: 'body{margin:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,390px),1fr));gap:12px;background:' + (state.dark ? '#16130F' : '#EFE7D6') + '}body>div{width:100%!important;height:300px}' });
                    await page.evaluate('(' + runFixture + ')()');
                    await page.evaluate(() => {
                        ChartManager.setAIClassification({ Alpha: ['a', 'b', 'c'], Beta: ['d'], Gamma: ['e', 'f'] });
                        ChartManager.setNotepadWords(Array.from({ length: 48 }, (_, i) => ({ word: 'word' + i, notepad: i % 2 ? 'Z' : 'A', notepad_id: i % 2 + 1 })));
                        ['heatmap', 'trend', 'memory', 'aiclass', 'notepad', 'growth'].forEach((type, i) => ChartManager.render(i, type, { month: '2026-11', days: 30 }));
                    });
                    await page.waitForTimeout(1200);
                    const pixels = await page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map(canvas => {
                        const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
                        let painted = 0;
                        for (let i = 3; i < data.length; i += 4) if (data[i]) painted++;
                        return { width: canvas.width, height: canvas.height, painted };
                    }));
                    equal(pixels.length, 6, 'six real ECharts canvases');
                    equal(pixels.every(p => p.painted > 100 && p.width > 0 && p.height > 0), true, 'nonblank canvas pixels');
                    equal(errors, [], 'real ECharts no page errors');
                    const image = state.name + '-' + width + '.png';
                    await page.screenshot({ path: path.join(out, image), fullPage: true });
                    evidence.render.push({ state: state.name, width, pixels, errors, image, note: 'synthetic fixture; automated nonblank checks, no claimed visual review' });
                } finally { await page.close(); }
            }
        }
        await context.close();
    } finally { await browser.close(); }
    evidence.checks = checks;
    fs.writeFileSync(path.join(out, 'options-evidence.json'), JSON.stringify(evidence, null, 2));
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ status: 'pass', checks, states: states.map(s => s.name), types, browser: 'isolated headless Edge; route-fulfilled synthetic page at 55395 only', limits: 'Captured actual setOption inputs with ECharts stub; not rendered-pixel or true-model evidence' }, null, 2));
    console.log('CHART_THEME_ISOLATION_PASS', checks);
})().catch(error => { fs.writeFileSync(path.join(out, 'failure.txt'), error.stack); console.error(error); process.exitCode = 1; });
