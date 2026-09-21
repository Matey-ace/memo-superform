'use strict';

// Exercise fullscreen behavior with a tiny DOM so CI catches the two failures
// that matter for a live study iframe: cloning a second browsing context and a
// delayed open callback mutating a modal that has already closed.
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('js/layout.js', 'utf8');

function makeClassList() {
    const values = new Set();
    return {
        add: function(value) { values.add(value); },
        remove: function(value) { values.delete(value); },
        contains: function(value) { return values.has(value); },
        toggle: function(value, force) { if (force === false) values.delete(value); else values.add(value); }
    };
}

function makeHarness() {
    let nextTimer = 1;
    const timers = new Map();
    let cloneCalls = 0;
    let echartInitializations = 0;
    const nodes = {};

    function node(id) {
        const attributes = {};
        const result = {
            id: id,
            childNodes: [],
            parentNode: null,
            hidden: false,
            inert: false,
            style: {},
            classList: makeClassList(),
            appendChild: function(child) {
                if (child.parentNode) child.parentNode.removeChild(child);
                result.childNodes.push(child);
                child.parentNode = result;
                return child;
            },
            insertBefore: function(child, reference) {
                if (child.parentNode) child.parentNode.removeChild(child);
                const index = result.childNodes.indexOf(reference);
                result.childNodes.splice(index < 0 ? result.childNodes.length : index, 0, child);
                child.parentNode = result;
                return child;
            },
            replaceChild: function(next, previous) {
                const index = result.childNodes.indexOf(previous);
                assert(index >= 0, 'replacement placeholder must remain in the original parent');
                if (next.parentNode) next.parentNode.removeChild(next);
                result.childNodes[index] = next;
                next.parentNode = result;
                previous.parentNode = null;
                return previous;
            },
            removeChild: function(child) {
                const index = result.childNodes.indexOf(child);
                if (index >= 0) result.childNodes.splice(index, 1);
                child.parentNode = null;
                return child;
            },
            querySelectorAll: function() { return []; },
            setAttribute: function(name, value) { attributes[name] = String(value); },
            getAttribute: function(name) { return attributes[name]; },
            contains: function(child) {
                if (child === result) return true;
                return result.childNodes.some(function(node) { return node.contains && node.contains(child); });
            },
            focus: function() { document.activeElement = result; }
        };
        Object.defineProperty(result, 'innerHTML', {
            get: function() { return ''; },
            set: function(value) {
                if (value === '') result.childNodes.slice().forEach(function(child) { result.removeChild(child); });
            }
        });
        return result;
    }

    const topbar = node('topbar');
    const dashboard = node('dashboard');
    const companionStudy = node('companionStudy');
    const modal = node('fullscreenModal');
    const fullscreenChart = node('fullscreenChart');
    const closeButton = node('closeFullscreen');
    const opener = node('opener');
    modal.appendChild(closeButton);
    modal.appendChild(fullscreenChart);
    const chartContainer = node('chart-0');
    const studyRoot = node('studyRoot');
    studyRoot.classList.add('study-web-container');
    studyRoot.cloneNode = function() { cloneCalls += 1; throw new Error('study iframe container must not be cloned'); };
    const iframe = node('studyIframe');
    iframe.classList.add('study-web-iframe');
    studyRoot.appendChild(iframe);
    chartContainer.appendChild(studyRoot);
    const studyTile = node('tile-0');
    studyTile.dataset = { tile: '0' };
    studyTile.querySelector = function(selector) {
        return selector === '.study-web-container' ? studyRoot : null;
    };
    const chartTile = node('tile-1');
    chartTile.dataset = { tile: '1' };

    const document = {
        activeElement: opener,
        getElementById: function(id) {
            return {
                fullscreenModal: modal,
                fullscreenChart: fullscreenChart,
                closeFullscreen: closeButton,
                dashboard: dashboard,
                companionStudy: companionStudy
            }[id] || null;
        },
        querySelector: function(selector) {
            if (selector === '.topbar') return topbar;
            if (selector === '.tile[data-tile="0"]') return studyTile;
            if (selector === '.tile[data-tile="1"]') return chartTile;
            return null;
        },
        querySelectorAll: function() { return []; },
        createComment: function() { return node('placeholder'); },
        contains: function(target) { return !!target; }
    };

    const chartTypes = { 0: 'study-web', 1: 'heatmap' };
    const chartInstances = {
        0: { resize: function() {} },
        1: { getOption: function() { return { series: [] }; }, resize: function() {} }
    };
    const context = {
        document: document,
        console: console,
        MemoDashboard: { layoutTileCount: { single: 1 }, chartConfig: {} },
        ChartManager: {
            getChartType: function(index) { return chartTypes[index]; },
            getInstance: function(index) { return chartInstances[index]; },
            rerenderAll: function() {}
        },
        echarts: {
            init: function() {
                echartInitializations += 1;
                return { setOption: function() {}, dispose: function() {} };
            }
        },
        setTimeout: function(callback, delay) {
            const id = nextTimer++;
            timers.set(id, { callback: callback, delay: delay || 0 });
            return id;
        },
        clearTimeout: function(id) { timers.delete(id); }
    };

    function runTimersThrough(delay) {
        while (true) {
            const due = Array.from(timers.entries())
                .filter(function(entry) { return entry[1].delay <= delay; })
                .sort(function(a, b) { return a[1].delay - b[1].delay; });
            if (!due.length) return;
            const entry = due[0];
            timers.delete(entry[0]);
            entry[1].callback();
        }
    }

    vm.createContext(context);
    vm.runInContext(source, context, { filename: 'js/layout.js' });
    return {
        layout: vm.runInContext('LayoutManager', context),
        nodes: { modal: modal, fullscreenChart: fullscreenChart, chartContainer: chartContainer, studyRoot: studyRoot, opener: opener },
        runTimersThrough: runTimersThrough,
        getCloneCalls: function() { return cloneCalls; },
        getEchartInitializations: function() { return echartInitializations; }
    };
}

function testStudyFullscreenMovesTheLiveNode() {
    const harness = makeHarness();
    harness.layout.openFullscreen(0);
    harness.runTimersThrough(50);
    assert.strictEqual(harness.nodes.fullscreenChart.childNodes.length, 1, 'fullscreen should contain one study root');
    assert.strictEqual(harness.nodes.fullscreenChart.childNodes[0], harness.nodes.studyRoot, 'fullscreen must keep the original study node and iframe state');
    assert.strictEqual(harness.getCloneCalls(), 0, 'fullscreen must not clone an iframe browsing context');
    assert.strictEqual(harness.nodes.studyRoot.parentNode, harness.nodes.fullscreenChart, 'original study node should move into fullscreen');

    harness.layout.closeFullscreen();
    assert.strictEqual(harness.nodes.studyRoot.parentNode, harness.nodes.chartContainer, 'close must restore the original study node to its tile');
    assert.strictEqual(harness.nodes.fullscreenChart.childNodes.length, 0, 'fullscreen container should be empty after close');
    assert.strictEqual(harness.nodes.modal.classList.contains('show'), false, 'close should hide the fullscreen modal');
}

function testClosedModalIgnoresPendingOpen() {
    const harness = makeHarness();
    harness.layout.openFullscreen(1);
    harness.layout.closeFullscreen();
    harness.runTimersThrough(100);
    assert.strictEqual(harness.getEchartInitializations(), 0, 'a delayed callback must not initialize ECharts after close');
    assert.strictEqual(harness.nodes.fullscreenChart.childNodes.length, 0, 'a delayed callback must not repopulate a closed modal');
}

function testSecondOpenInvalidatesFirstTimer() {
    const harness = makeHarness();
    harness.layout.openFullscreen(1);
    harness.layout.openFullscreen(1);
    harness.runTimersThrough(50);
    assert.strictEqual(harness.getEchartInitializations(), 1, 'reopening before the delay should create exactly one fullscreen chart');
}

testStudyFullscreenMovesTheLiveNode();
testClosedModalIgnoresPendingOpen();
testSecondOpenInvalidatesFirstTimer();
console.log('LAYOUT_FULLSCREEN_REGRESSION_PASS');
