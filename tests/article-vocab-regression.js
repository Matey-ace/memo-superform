/* eslint-disable */
/**
 * js/article-vocab.js 回归测试（node，无框架）。
 *
 * 重点保护五条不能退让的行为：
 * 1. **不打开就不干活**：没 mount/没 start 时不请求网络、不轮询；
 * 2. **自动添加默认关闭**，开启必须由用户显式动作，且可关闭；
 * 3. **空结果/失败/取消/部分结果**都有明确状态，不静默吞掉；
 * 4. **uncertain 不自动重试**（写请求可能已生效，重试会重复写入）；
 * 5. 候选勾选/删除真实影响提交集合，destroy 后可重建。
 *
 * 用法: node tests/article-vocab-regression.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const JS_PATH = path.join(__dirname, '..', 'js', 'article-vocab.js');
const mod = require(JS_PATH);

let passed = 0;
const failures = [];

async function check(name, fn) {
    try {
        await fn();
        passed += 1;
        console.log('  ok  ' + name);
    } catch (error) {
        failures.push({ name: name, message: error.message });
        console.log('  FAIL ' + name + ' :: ' + error.message);
    }
}

function group(title) {
    console.log('\n[' + title + ']');
}

/**
 * 极简 fake DOM。故意不完整（与 companion-progress-regression.js 一致）：
 * 组件必须对缺失能力做防御，否则 pywebview 早期页面会直接抛错。
 */
function fakeElement() {
    const attrs = {};
    const node = {
        innerHTML: '',
        textContent: '',
        value: '',
        checked: false,
        className: '',
        children: [],
        _attrs: attrs,
        setAttribute: (name, value) => { attrs[name] = String(value); },
        getAttribute: (name) => (name in attrs ? attrs[name] : null),
        removeAttribute: (name) => { delete attrs[name]; },
        appendChild: (child) => { node.children.push(child); return child; },
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
        querySelectorAll: () => [],
        focus: () => {},
        classList: { add: () => {}, remove: () => {}, toggle: () => {} }
    };
    return node;
}

/** 记录所有网络调用，用来断言"没接线就不发请求"。 */
function recorder(handler) {
    const calls = [];
    const fn = (payload) => {
        calls.push(payload);
        if (typeof handler === 'function') return handler(payload, calls.length);
        return null;
    };
    fn.calls = calls;
    return fn;
}

function selectionPayload(items, extra) {
    return Object.assign({ ok: true, items: items, rejected: [], candidate_count: items.length }, extra || {});
}

const NORMAL_ITEMS = [
    {
        lemma: 'council', surface: 'council', pos: 'n', gloss_zh: '委员会',
        context: 'The city council approved a plan', reason: '估计约 B1，常见于新闻',
        learned_local: false, official_status: 'matched', voc_id: '100'
    },
    {
        lemma: 'wetland', surface: 'wetlands', pos: 'n', gloss_zh: '湿地',
        context: 'restore wetlands that had been drained', reason: '语境价值高',
        learned_local: true, official_status: 'missing'
    },
    {
        lemma: 'silt', surface: 'silt', pos: 'n', gloss_zh: '淤泥',
        context: 'carried silt past the mill', reason: '估计约 C1',
        learned_local: false, official_status: 'ambiguous'
    }
];

function freshInstance(overrides) {
    return mod.create(Object.assign({}, overrides || {}));
}

/* 自动添加授权是**设备级偏好**（设计如此：记住授权），所以它会在实例之间
 * 持久化。测试之间必须显式清掉，否则"默认关闭"这类断言会被前一条用例污染。
 * 真实页面切换账号时也应调用同一个导出函数。 */
function clearAutoAdd() {
    if (typeof mod.resetAutoAddPref === 'function') mod.resetAutoAddPref();
}

async function main() {
    group('module shape');
    await check('导出 create / version / DEFAULT_WORD_COUNT', () => {
        assert.strictEqual(typeof mod.create, 'function');
        assert.ok(mod.version);
        assert.strictEqual(mod.DEFAULT_WORD_COUNT, 20);
    });
    await check('create({}) 不抛异常且初始 idle', () => {
        const instance = freshInstance();
        assert.strictEqual(instance.getState().phase, 'idle');
        instance.destroy();
    });
    await check('导出状态机常量', () => {
        ['idle', 'extracting', 'selecting', 'preview', 'submitting', 'done', 'error'].forEach((phase) => {
            assert.strictEqual(Object.values(mod.STATE).indexOf(phase) >= 0, true, phase);
        });
    });

    group('不打开就不干活');
    await check('create 后不 mounted、不请求、不轮询', () => {
        const requestAi = recorder();
        const requestQuery = recorder();
        const instance = freshInstance({ requestAi: requestAi, requestQuery: requestQuery });
        const state = instance.getState();
        assert.strictEqual(state.mounted, false);
        assert.strictEqual(state.polling, false);
        assert.strictEqual(requestAi.calls.length, 0);
        assert.strictEqual(requestQuery.calls.length, 0);
        instance.destroy();
    });
    await check('mount 不自动开始选词', () => {
        const requestAi = recorder();
        const instance = freshInstance({ requestAi: requestAi });
        instance.mount(fakeElement());
        assert.strictEqual(requestAi.calls.length, 0);
        assert.strictEqual(instance.getState().phase, 'idle');
        assert.strictEqual(instance.getState().polling, false);
        instance.destroy();
    });
    await check('mount 幂等', () => {
        const instance = freshInstance();
        const host = fakeElement();
        instance.mount(host);
        instance.mount(host);
        assert.strictEqual(instance.getState().mounted, true);
        instance.destroy();
    });
    await check('空文章不发起请求', () => {
        const requestAi = recorder(() => selectionPayload([]));
        const instance = freshInstance({ requestAi: requestAi });
        instance.mount(fakeElement());
        instance.start();
        assert.strictEqual(requestAi.calls.length, 0);
        assert.strictEqual(instance.getState().phase, 'error');
        instance.destroy();
    });

    group('默认词数');
    await check('wordCount 默认 20', () => {
        const instance = freshInstance();
        assert.strictEqual(instance.getState().wordCount, 20);
        instance.destroy();
    });
    await check('超出范围会被夹住', () => {
        assert.strictEqual(mod.clampWordCount(0), 1);
        assert.strictEqual(mod.clampWordCount(9999), 100);
        assert.strictEqual(mod.clampWordCount('abc'), 20);
    });

    group('正常流程');
    await check('start 走 extracting → selecting → preview', async () => {
        const requestAi = () => Promise.resolve(selectionPayload(NORMAL_ITEMS));
        const instance = freshInstance({ requestAi: requestAi });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan to restore wetlands. Carried silt past the mill.');
        await instance.start();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'preview');
        assert.deepStrictEqual(state.history, ['extracting', 'selecting', 'preview']);
        assert.strictEqual(state.items.length, 3);
        instance.destroy();
    });
    await check('默认所有候选都被勾选', async () => {
        const instance = freshInstance({ requestAi: () => selectionPayload(NORMAL_ITEMS) });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        instance.start();
        const state = instance.getState();
        assert.strictEqual(state.selectedCount, 3);
        instance.destroy();
    });
    await check('未接线 requestAi 时报错而非假装成功', () => {
        const instance = freshInstance();
        instance.mount(fakeElement());
        instance.setInput('text', 'Some article text.');
        instance.start();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'error');
        assert.strictEqual(state.items.length, 0);
        instance.destroy();
    });

    group('空结果');
    await check('空结果进入 preview 且给出明确文案', async () => {
        const instance = freshInstance({
            requestAi: () => selectionPayload([], { candidate_count: 0 })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'An article with nothing worth learning.');
        await instance.start();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'preview');
        assert.strictEqual(state.items.length, 0);
        assert.ok(state.message.indexOf('没有找到') >= 0, state.message);
        instance.destroy();
    });
    await check('空结果不触发提交', async () => {
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload([]),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setAutoAdd(true, 'user');
        instance.setInput('text', 'Nothing here.');
        await instance.start();
        assert.strictEqual(requestAdd.calls.length, 0);
        instance.destroy();
    });

    group('失败');
    await check('选词失败进入 error 且保留原因', async () => {
        const instance = freshInstance({
            requestAi: () => Promise.reject({ code: 'rate_limited', message: '请求过于频繁', retryable: true })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'Some article.');
        // await 必须不抛：start 内部已收口，否则宿主会停在"处理中"。
        await instance.start();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'error');
        assert.strictEqual(state.error.code, 'rate_limited');
        assert.ok(state.message.indexOf('频繁') >= 0, state.message);
        assert.strictEqual(state.uncertain, false);
        instance.destroy();
    });
    await check('同步抛异常也被捕获', async () => {
        const instance = freshInstance({
            requestAi: () => { throw new Error('boom'); }
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'Some article.');
        instance.start();
        assert.strictEqual(instance.getState().phase, 'error');
        instance.destroy();
    });
    await check('返回格式异常时报错而非伪造条目', async () => {
        const instance = freshInstance({ requestAi: () => 'not an object' });
        instance.mount(fakeElement());
        instance.setInput('text', 'Some article.');
        await instance.start();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'error');
        assert.strictEqual(state.items.length, 0);
        instance.destroy();
    });

    group('取消');
    await check('取消等待返回 preview 并说明已取消', async () => {
        let release = null;
        const pending = new Promise((resolve) => { release = resolve; });
        const instance = freshInstance({ requestAi: () => pending });
        instance.mount(fakeElement());
        instance.setInput('text', 'Some article.');
        instance.start();
        instance.cancel();
        const state = instance.getState();
        assert.strictEqual(state.busy, false);
        assert.ok(state.message.indexOf('取消') >= 0, state.message);
        release(selectionPayload(NORMAL_ITEMS));
        await pending;
        // 取消后晚到的回复必须被丢弃，不能又跳回 preview。
        assert.strictEqual(instance.getState().phase, 'preview');
        assert.strictEqual(instance.getState().items.length, 0);
        instance.destroy();
    });

    group('自动添加开关');
    await check('默认关闭', () => {
        clearAutoAdd();
        const instance = freshInstance();
        assert.strictEqual(instance.getState().autoAdd, false);
        instance.destroy();
    });
    await check('显式开启后被记住（设备级授权）', () => {
        clearAutoAdd();
        const first = freshInstance();
        assert.strictEqual(first.getState().autoAdd, false);
        first.setAutoAdd(true, 'user');
        assert.strictEqual(first.getState().autoAdd, true);
        first.destroy();
        const second = freshInstance();
        assert.strictEqual(second.getState().autoAdd, true);
        second.destroy();
        clearAutoAdd();
    });
    await check('可以关闭并撤销授权', () => {
        clearAutoAdd();
        const instance = freshInstance();
        instance.setAutoAdd(true, 'user');
        instance.setAutoAdd(false, 'user');
        assert.strictEqual(instance.getState().autoAdd, false);
        instance.destroy();
    });
    await check('只改 state 不算授权：未显式开启不自动提交', async () => {
        clearAutoAdd();
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        assert.strictEqual(requestAdd.calls.length, 0);
        instance.destroy();
    });
    await check('开启后 preview 自动提交一次', async () => {
        clearAutoAdd();
        const requestAdd = recorder(() => ({ ok: true, status: 'all', submitted: 3, added_count: 3 }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setAutoAdd(true, 'user');
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        assert.strictEqual(requestAdd.calls.length, 1);
        assert.strictEqual(requestAdd.calls[0].automatic, true);
        assert.strictEqual(instance.getState().phase, 'done');
        instance.destroy();
        clearAutoAdd();
    });
    await check('自动提交只发生一次（不重复写云端）', async () => {
        clearAutoAdd();
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setAutoAdd(true, 'user');
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        instance.setSelected('council', false);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.strictEqual(requestAdd.calls.length, 1);
        instance.destroy();
        clearAutoAdd();
    });
    await check('关闭时不自动提交', async () => {
        clearAutoAdd();
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        assert.strictEqual(requestAdd.calls.length, 0);
        assert.strictEqual(instance.getState().phase, 'preview');
        instance.destroy();
    });

    group('候选勾选影响提交集合');
    await check('取消勾选的词不进提交集合', async () => {
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        instance.setSelected('wetland', false);
        instance.setSelected('silt', false);
        assert.strictEqual(instance.getState().selectedCount, 1);
        await instance.submit();
        const submitted = requestAdd.calls[0].items.map((item) => item.lemma);
        assert.deepStrictEqual(submitted, ['council']);
        instance.destroy();
    });
    await check('全不勾选时不提交', async () => {
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        NORMAL_ITEMS.forEach((item) => instance.setSelected(item.lemma, false));
        assert.strictEqual(instance.getState().selectedCount, 0);
        await instance.submit();
        assert.strictEqual(requestAdd.calls.length, 0);
        instance.destroy();
    });
    await check('删除候选后不再出现在列表里', async () => {
        const instance = freshInstance({ requestAi: () => selectionPayload(NORMAL_ITEMS) });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        instance.removeItem('wetland');
        const state = instance.getState();
        assert.strictEqual(state.items.length, 2);
        assert.strictEqual(state.items.filter((item) => item.lemma === 'wetland').length, 0);
        instance.destroy();
    });
    await check('重新挑选清空旧结果', async () => {
        const instance = freshInstance({ requestAi: () => selectionPayload(NORMAL_ITEMS) });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        instance.reset();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'idle');
        assert.strictEqual(state.items.length, 0);
        instance.destroy();
    });

    group('提交与部分结果');
    await check('提交带 confirm:true 与 advance:false', async () => {
        const requestAdd = recorder(() => ({ ok: true, status: 'all', submitted: 3, added_count: 3 }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        await instance.submit();
        const payload = requestAdd.calls[0];
        assert.strictEqual(payload.confirm, true);
        assert.strictEqual(payload.advance, false);
        assert.ok(payload.operation_id, '缺少 operation_id');
        instance.destroy();
    });
    await check('全部成功进入 done', async () => {
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: () => ({ ok: true, status: 'all', submitted: 3, added_count: 3, note: '已提交 3 个词' })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        await instance.submit();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'done');
        assert.strictEqual(state.partial, false);
        assert.strictEqual(state.uncertain, false);
        instance.destroy();
    });
    await check('部分结果标记 partial 并保留 note', async () => {
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: () => ({
                ok: true, status: 'partial', submitted: 3, added_count: 1,
                shortfall: 2, note: '已提交 3 个词，云端报告计入 1 个'
            })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        await instance.submit();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'done');
        assert.strictEqual(state.partial, true);
        assert.ok(state.message.indexOf('1 个') >= 0, state.message);
        instance.destroy();
    });
    await check('0 个计入也算部分结果，不声称成功', async () => {
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: () => ({ ok: true, status: 'none', submitted: 3, added_count: 0, note: '云端报告 0 个计入' })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        await instance.submit();
        const state = instance.getState();
        assert.strictEqual(state.partial, true);
        assert.ok(state.message.indexOf('0 个') >= 0, state.message);
        instance.destroy();
    });
    await check('结果里不出现逐词成功状态', async () => {
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: () => ({ ok: true, status: 'partial', submitted: 3, added_count: 2 })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        await instance.submit();
        const blob = JSON.stringify(instance.getState().result);
        ['per_word', 'success', 'failed_words'].forEach((key) => {
            assert.strictEqual(blob.indexOf('"' + key + '"'), -1, key + ' 不应出现在结果里');
        });
        instance.destroy();
    });

    group('uncertain 不自动重试');
    await check('uncertain 进入 error 并标 uncertain', async () => {
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: () => ({ code: 'uncertain', uncertain: true, note: '连接中断' })
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        await instance.submit();
        const state = instance.getState();
        assert.strictEqual(state.phase, 'error');
        assert.strictEqual(state.uncertain, true);
        assert.ok(state.message.indexOf('待核实') >= 0, state.message);
        instance.destroy();
    });
    await check('uncertain 后只提交过一次（绝不自动重试）', async () => {
        clearAutoAdd();
        const requestAdd = recorder(() => ({ code: 'uncertain', uncertain: true }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setAutoAdd(true, 'user');
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        // 留一段时间让异步尾巴跑完：如果代码里有自动重试，这里会捕获第 2 次调用。
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.strictEqual(requestAdd.calls.length, 1);
        assert.strictEqual(instance.getState().uncertain, true);
        instance.destroy();
        clearAutoAdd();
    });
    await check('uncertain 被标记为不可重试', () => {
        const info = mod.classifyError({ code: 'uncertain', retryable: true });
        assert.strictEqual(info.uncertain, true);
        assert.strictEqual(info.retryable, false);
    });
    await check('普通限流错误允许重试', () => {
        const info = mod.classifyError({ code: 'rate_limited', retryable: true });
        assert.strictEqual(info.uncertain, false);
        assert.strictEqual(info.retryable, true);
    });
    await check('提交中取消会提示结果待核实', async () => {
        let release = null;
        const pending = new Promise((resolve) => { release = resolve; });
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestAdd: () => pending
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        instance.submit();
        instance.cancel();
        const state = instance.getState();
        assert.strictEqual(state.uncertain, true);
        assert.ok(state.message.indexOf('核对') >= 0 || state.message.indexOf('待核实') >= 0, state.message);
        release({ ok: true, status: 'all' });
        await pending;
        instance.destroy();
    });

    group('官方收录状态');
    await check('requestQuery 展示 matched/missing/ambiguous', async () => {
        const requestQuery = recorder(() => ({
            matched: { council: { id: '100', spelling: 'council' } },
            missing: ['wetland'],
            ambiguous: { silt: { ids: ['1', '2'] } }
        }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestQuery: requestQuery
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        const byLemma = {};
        instance.getState().items.forEach((item) => { byLemma[item.lemma] = item; });
        assert.strictEqual(byLemma.council.official_status, 'matched');
        assert.strictEqual(byLemma.wetland.official_status, 'missing');
        assert.strictEqual(byLemma.silt.official_status, 'ambiguous');
        // ambiguous 绝不能随便挑一个 id
        assert.strictEqual(byLemma.silt.voc_id, undefined);
        instance.destroy();
    });
    await check('未接线 requestQuery 时保持未知，不编造', async () => {
        const items = [
            { lemma: 'alpha', surface: 'alpha', pos: 'n', gloss_zh: '甲', context: 'alpha appears here', reason: 'r' },
            { lemma: 'bravo', surface: 'bravo', pos: 'n', gloss_zh: '乙', context: 'bravo appears here', reason: 'r' }
        ];
        const instance = freshInstance({ requestAi: () => selectionPayload(items) });
        instance.mount(fakeElement());
        instance.setInput('text', 'alpha appears here and bravo appears here.');
        await instance.start();
        const state = instance.getState();
        assert.strictEqual(state.items.length, 2);
        // 官方结果已给出时按服务端标注；没给的一律 unknown，绝不凭空写 matched/missing。
        const byLemma = {};
        state.items.forEach((item) => { byLemma[item.lemma] = item; });
        assert.strictEqual(byLemma.alpha.official_status, 'unknown', 'alpha');
        assert.strictEqual(byLemma.bravo.official_status, 'unknown', 'bravo');
        assert.strictEqual(byLemma.alpha.voc_id, undefined, 'alpha 不应有 voc_id');
        instance.destroy();
    });
    await check('官方查询失败不阻塞提交', async () => {
        const requestAdd = recorder(() => ({ ok: true, status: 'all' }));
        const instance = freshInstance({
            requestAi: () => selectionPayload(NORMAL_ITEMS),
            requestQuery: () => Promise.reject(new Error('network down')),
            requestAdd: requestAdd
        });
        instance.mount(fakeElement());
        instance.setInput('text', 'The city council approved a plan.');
        await instance.start();
        assert.strictEqual(instance.getState().phase, 'preview');
        await instance.submit();
        assert.strictEqual(requestAdd.calls.length, 1);
        instance.destroy();
    });

    group('生命周期');
    await check('destroy 后不再渲染，getState 仍可读', () => {
        const instance = freshInstance();
        instance.mount(fakeElement());
        instance.destroy();
        const state = instance.getState();
        assert.strictEqual(state.mounted, false);
        assert.strictEqual(state.polling, false);
    });
    await check('destroy 后可重建', async () => {
        const first = freshInstance({ requestAi: () => selectionPayload(NORMAL_ITEMS) });
        first.mount(fakeElement());
        first.setInput('text', 'The city council approved a plan.');
        await first.start();
        first.destroy();

        const second = freshInstance({ requestAi: () => selectionPayload(NORMAL_ITEMS) });
        second.mount(fakeElement());
        assert.strictEqual(second.getState().phase, 'idle');
        assert.strictEqual(second.getState().items.length, 0);
        second.setInput('text', 'The city council approved a plan.');
        await second.start();
        assert.strictEqual(second.getState().phase, 'preview');
        second.destroy();
    });
    await check('destroy 后晚到的回复不复活组件', async () => {
        let release = null;
        const pending = new Promise((resolve) => { release = resolve; });
        const instance = freshInstance({ requestAi: () => pending });
        instance.mount(fakeElement());
        instance.setInput('text', 'Some article.');
        instance.start();
        instance.destroy();
        release(selectionPayload(NORMAL_ITEMS));
        await pending;
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.strictEqual(instance.getState().items.length, 0);
    });
    await check('没有容器时 start 也不抛异常', () => {
        const instance = freshInstance({ requestAi: () => selectionPayload([]) });
        instance.setInput('text', 'Some article.');
        instance.start();
        instance.destroy();
    });
    await check('onStateChange 被调用', () => {
        let calls = 0;
        const instance = freshInstance({ onStateChange: () => { calls += 1; } });
        instance.mount(fakeElement());
        assert.ok(calls > 0, 'mount 后应至少通知一次');
        instance.destroy();
    });

    const failed = failures.length;
    console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    if (failed) {
        failures.forEach((item) => console.log('  - ' + item.name + ' :: ' + item.message));
        console.log('FAILED');
        process.exitCode = 1;
        return;
    }
    console.log('ALL CHECKS PASSED');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
