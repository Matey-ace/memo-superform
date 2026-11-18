/* eslint-disable */
/**
 * companion-progress.js 回归测试（node，无框架）。
 *
 * 重点保护三条不能退让的行为：
 * 1. ``known=false`` 时**不设** aria-valuemax，也不伪造百分比；
 * 2. 今日数字绝不能冒充本轮数字（反之亦然）；
 * 3. mount 幂等、destroy 后可重建。
 *
 * 用法： node tests/companion-progress-regression.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const mod = require(path.join(__dirname, '..', 'js', 'companion-progress.js'));

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
 * 极简 fake DOM。故意不完整：组件必须对缺失能力做防御，
 * 否则真实浏览器之外的宿主（如 pywebview 早期页面）会直接抛错。
 */
function fakeElement() {
    const attrs = {};
    const node = {
        innerHTML: '',
        textContent: '',
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
        classList: {
            add: () => {},
            remove: () => {},
            toggle: () => {}
        }
    };
    return node;
}

function view(overrides) {
    return Object.assign({
        session_id: 'ses_1',
        state: 'active',
        goal_kind: 'session_goal',
        target_count: 20,
        confirmed_count: 8,
        progress: { done: 8, total: 20, known: true },
        role_id: 'role-a',
        role_name: '安和',
        active_seconds: 1500,
        study_day: '2026-11-16',
        revision: 3,
        goal_revision: 1,
        can_settle: false
    }, overrides || {});
}

async function main() {
    group('module shape');
    await check('导出 create', () => {
        assert.strictEqual(typeof mod.create, 'function');
    });
    await check('create({}) 不抛异常', () => {
        const instance = mod.create({});
        assert.ok(instance);
        instance.destroy();
    });

    group('mount');
    await check('mount 幂等（两次挂载同一容器不报错）', () => {
        const instance = mod.create({});
        const host = fakeElement();
        instance.mount(host);
        instance.mount(host);
        assert.strictEqual(instance.getState().mounted, true);
        instance.destroy();
    });
    await check('mount 后 update 反映数值', () => {
        const instance = mod.create({});
        instance.mount(fakeElement());
        instance.update(view());
        const state = instance.getState();
        assert.strictEqual(state.done, 8);
        assert.strictEqual(state.total, 20);
        assert.ok(state.progressText.indexOf('8') >= 0, state.progressText);
        assert.ok(state.progressText.indexOf('20') >= 0, state.progressText);
        instance.destroy();
    });

    group('known=false 不伪造进度');
    await check('aria-valuemax 未被设置', () => {
        const instance = mod.create({});
        instance.mount(fakeElement());
        instance.update(view({
            goal_kind: 'today_plan',
            target_count: null,
            progress: { done: 3, total: null, known: false }
        }));
        const state = instance.getState();
        assert.strictEqual(state.known, false);
        // 关键断言：分母不可信时不得给出 max，否则读屏会播报一个假进度。
        assert.strictEqual(state.aria.valuemax, null);
        assert.strictEqual(state.aria.valuetext, '目标待确认');
        instance.destroy();
    });
    await check('文本含「待确认」', () => {
        const instance = mod.create({});
        instance.mount(fakeElement());
        instance.update(view({
            goal_kind: 'today_plan', target_count: null,
            progress: { done: 3, total: null, known: false }
        }));
        const state = instance.getState();
        const text = (state.labelText || '') + (state.todayText || '');
        assert.ok(text.indexOf('待确认') >= 0, text);
        instance.destroy();
    });
    await check('setPending 给出明确原因', () => {
        const instance = mod.create({});
        instance.mount(fakeElement());
        instance.setPending('今日目标尚未同步');
        const state = instance.getState();
        assert.strictEqual(state.pending, true);
        assert.ok(state.pendingReason.indexOf('尚未同步') >= 0, state.pendingReason);
        instance.destroy();
    });

    group('本轮与今日不互相冒充');
    await check('session_goal 时今日显示待确认', () => {
        const instance = mod.create({});
        instance.mount(fakeElement());
        instance.update(view({ progress: { done: 8, total: 20, known: true } }));
        const state = instance.getState();
        assert.ok(state.progressText.indexOf('本轮') >= 0, state.progressText);
        assert.ok(state.todayText.indexOf('待确认') >= 0, state.todayText);
        instance.destroy();
    });
    await check('today_plan + known 时今日显示真实数字', () => {
        const instance = mod.create({});
        instance.mount(fakeElement());
        instance.update(view({
            goal_kind: 'today_plan',
            progress: { done: 12, total: 40, known: true }
        }));
        const state = instance.getState();
        const combined = state.todayText + '|' + state.progressText;
        assert.ok(combined.indexOf('12') >= 0, combined);
        assert.ok(combined.indexOf('40') >= 0, combined);
        instance.destroy();
    });

    group('生命周期');
    await check('destroy 后可重新 create', () => {
        const first = mod.create({});
        first.mount(fakeElement());
        first.destroy();
        assert.strictEqual(first.getState().mounted, false);
        const second = mod.create({});
        second.mount(fakeElement());
        assert.strictEqual(second.getState().mounted, true);
        second.destroy();
    });
    await check('未 mount 时 update 不抛异常', () => {
        const instance = mod.create({});
        instance.update(view());
        instance.destroy();
    });
    await check('无容器时也给出可读文本', () => {
        const instance = mod.create({});
        instance.update(view());
        assert.ok(instance.getState().progressText.length > 0);
        instance.destroy();
    });

    group('定时器');
    await check('start/stop 不抛异常', () => {
        const instance = mod.create({});
        assert.strictEqual(typeof mod.minutesText, 'function');
        assert.strictEqual(mod.minutesText(1500), '25 分钟');
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