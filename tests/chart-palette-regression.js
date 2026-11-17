'use strict';

// 图表配色：六套预设必须保持名称与实际颜色一致，普通版按模块各记一套，
// 笔记本主题保持原有行为。
//
// 历史说明：tests/redesign/chart-theme-isolation.js 曾把"主图表统一使用构成主义
// 固定调色"写成合同（断言 palette = ['#B8321F', '#1A1714', ...]）。那个合同已被
// 新需求取代：用户明确选择的数据色板不能再被通用主题绘制覆盖。那个历史文件保留
// 在原处作为当时的验收记录，不修改；本文件是与当前需求对应的正向测试。
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const read = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const charts = read('js/charts.js');
const layout = read('js/layout.js');

// ---- 1. 六套预设的名称与颜色语义 ----
// 只断言"名称与其色系相符"的可判定特征，不锁死具体色值，允许后续微调色号。
const EXPECTED = {
    'GitHub绿': { hue: 'green', peakNot: ['#B8321F', '#1A1714'] },
    '樱粉': { hue: 'pink', peakNot: ['#1A1714'] },
    '紫韵': { hue: 'purple' },
    '暖橙': { hue: 'orange' },
    '玫红': { hue: 'rose' },
    '靛蓝': { hue: 'indigo' }
};

function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const l = (max + min) / 2;
    let h = 0, s = 0;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0));
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
    }
    return { h, s, l };
}

const sandbox = {
    console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
        documentElement: { getAttribute: n => (n === 'data-ui-style' ? 'notebook' : null) },
        body: { classList: { contains: () => false } },
        getElementById: () => ({ offsetParent: {}, getClientRects: () => [{}], querySelector: () => null }),
        querySelector: () => null, querySelectorAll: () => [],
        createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
        addEventListener() {}
    },
    echarts: null, setTimeout, clearTimeout, setInterval, clearInterval
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(read('js/dashboard-core.js'), sandbox);
vm.runInContext(charts, sandbox);
const ChartManager = vm.runInContext('ChartManager', sandbox);

// 笔记本分支下 getHeatmapPalettes() 返回原始六套（这是笔记本不受影响的依据）
const palettes = ChartManager.getHeatmapPalettes();
assert.strictEqual(palettes.length, 6, 'there must be six palettes');
// vm 里造出来的数组原型属于另一个 realm，deepStrictEqual 会因原型不同而失败，
// 所以用 join 比较内容。
const names = palettes.map(p => p.name);
assert.strictEqual(names.join('|'), 'GitHub绿|樱粉|紫韵|暖橙|玫红|靛蓝',
    'palette names must keep their original order and spelling');

for (const palette of palettes) {
    const spec = EXPECTED[palette.name];
    assert.ok(spec, 'unexpected palette name ' + palette.name);
    assert.ok(Array.isArray(palette.colors) && palette.colors.length === 4,
        palette.name + ' must keep four light levels');
    assert.ok(Array.isArray(palette.darkColors) && palette.darkColors.length === 4,
        palette.name + ' must keep four dark levels');
    for (const hex of palette.colors.concat(palette.darkColors)) {
        assert.ok(/^#[0-9a-fA-F]{6}$/.test(hex), palette.name + ' has a malformed colour: ' + hex);
    }
    // 名称的色系必须与颜色相符：取最深一级（第 4 级）判断色相
    const peak = hexToHsl(palette.colors[3]);
    if (spec.hue === 'green') assert.ok(peak.h > 80 && peak.h < 170,
        'GitHub绿 的最高等级必须是绿色系（实测色相 ' + Math.round(peak.h) + '°）');
    if (spec.hue === 'pink') assert.ok(peak.h > 320 || peak.h < 10,
        '樱粉 的最高等级必须是粉色系（实测色相 ' + Math.round(peak.h) + '°）');
    if (spec.hue === 'orange') assert.ok(peak.h > 15 && peak.h < 45,
        '暖橙 的最高等级必须是橙色系（实测色相 ' + Math.round(peak.h) + '°）');
    if (spec.hue === 'indigo') assert.ok(peak.h > 210 && peak.h < 260,
        '靛蓝 的最高等级必须是蓝靛色系（实测色相 ' + Math.round(peak.h) + '°）');
    if (spec.hue === 'purple') assert.ok(peak.h > 260 && peak.h < 310,
        '紫韵 的最高等级必须是紫色系（实测色相 ' + Math.round(peak.h) + '°）');
    if (spec.hue === 'rose') assert.ok(peak.h > 310 || peak.h < 360,
        '玫红 的最高等级必须是玫红色系（实测色相 ' + Math.round(peak.h) + '°）');
    for (const banned of spec.peakNot || []) {
        assert.notStrictEqual(palette.colors[3].toUpperCase(), banned.toUpperCase(),
            palette.name + ' must not peak at the old constructivist colour ' + banned);
    }
}

// ---- 2. 通用主题绘制不得再覆盖用户色板 ----
// paintMainChart 仍可处理文字/背景/边框/字体，但不能把 heatmap 的格子颜色改掉。
assert.ok(/function paintMainChart/.test(charts), 'paintMainChart must still exist (it owns shared styling)');
const paint = /function paintMainChart\(option, C\) \{([\s\S]*?)\n    \}/.exec(charts);
assert.ok(paint, 'paintMainChart body must be readable');
const paintBody = paint[1];
assert.ok(!/itemStyle\.color\s*=\s*newColors/.test(paintBody),
    'paintMainChart must not replace heatmap cell colours with a theme remap');
assert.ok(!/mainHeatmapPalettes/.test(paintBody) || /\/\//.test(paintBody),
    'paintMainChart must not remap the user palette');

// ---- 3. 逐模块作用域与旧偏好兼容 ----
assert.ok(/standard_heatmap_palette/.test(charts) || /standard_heatmap_palette/.test(layout),
    'per-module palette preferences need a standard-only storage key');
assert.ok(/'heatmap_palette'/.test(charts),
    "the legacy global key must still be read as the initial default (old choices must not be lost)");
// 写入不得再只写那个全局键，否则多模块必然不同步
assert.ok(!/setPaletteIndex[\s\S]{0,200}localStorage\.setItem\('heatmap_palette'/.test(charts) ||
    /standard_heatmap_palette/.test(charts),
    'setting a palette must not only write the single global key');

// ---- 4. 色点、选中态与实际图表使用同一份有效色板 ----
// 注意：layout.js 里是 class="swatch-dot"（HTML 字符串），没有 CSS 那个前导点
assert.ok(/swatch-dot/.test(layout), 'the toolbar must still render swatch dots');
assert.ok(/colors\[/.test(layout), 'the swatch dots must be painted from the preset colours');
assert.ok(/getPaletteIndexFor|getPaletteIndex|paletteIndexFor|getTilePaletteIndex/.test(layout),
    'the toolbar must read the per-module palette state, not a stale global');

// ---- 5. 零值格与非零等级必须区分 ----
assert.ok(/count === 0/.test(charts), 'zero-count cells must be handled explicitly');
assert.ok(/getHeatColor/.test(charts), 'the graded colour function must remain the single source of cell colours');

// ---- 6. 笔记本不受影响：标准模式下才启用主图表主题 ----
assert.ok(/isMainChartTheme/.test(charts), 'the main-chart theme gate must remain');
assert.ok(/data-ui-style.*standard|=== 'standard'/.test(charts),
    'the main chart theme must still be gated on the standard theme');

// ---- 7. 数据与统计逻辑不变 ----
for (const fn of ['aggregateDailyData', 'generateMonthHeatmapData', 'getHeatColor']) {
    assert.ok(new RegExp('function ' + fn).test(charts), fn + ' must remain (data/statistics must not change)');
}

console.log('CHART_PALETTE_REGRESSION_PASS');
