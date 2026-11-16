/* eslint-disable */
/**
 * study-event-bridge.js 回归测试（node，无框架）。
 *
 * 重点不是「能发出去」，而是三条硬要求不被后续改动破坏：
 * 幂等 event_id、有界队列、失败不静默丢弃。
 *
 * 用法： node tests/study-event-bridge-regression.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const bridgeModule = require(path.join(__dirname, '..', 'js', 'study-event-bridge.js'));

let passed = 0;
const failures = [];

// 断言必须按顺序执行，因为异步用例会改变队列状态；因此全部串行 await。
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

function session(overrides) {
    return Object.assign({
        session_id: 'ses_test_1',
        state: 'active',
        goal_kind: 'session_goal',
        target_count: 10,
        confirmed_count: 0,
        role_id: 'role-a',
        revision: 1,
        goal_revision: 1,
        can_settle: false
    }, overrides || {});
}

async function main() {
    // ------------------------------------------------------------ 模块形状
    group('module shape');
    await check('导出 createBridge', () => {
        assert.strictEqual(typeof bridgeModule.createBridge, 'function');
    });
    await check('导出 stableId', () => {
        assert.strictEqual(typeof bridgeModule.stableId, 'function');
    });

    // ------------------------------------------------------------ 幂等 ID
    group('stable event id');
    await check('相同输入产出相同 ID', () => {
        const a = bridgeModule.stableId(['s', 'i', 'observed_ack', 'w1', '', 'answer']);
        const b = bridgeModule.stableId(['s', 'i', 'observed_ack', 'w1', '', 'answer']);
        assert.strictEqual(a, b);
    });
    await check('不同 item 产出不同 ID', () => {
        const a = bridgeModule.stableId(['s', 'i', 'observed_ack', 'w1', '', 'answer']);
        const b = bridgeModule.stableId(['s', 'i', 'observed_ack', 'w2', '', 'answer']);
        assert.notStrictEqual(a, b);
    });
    await check('同一事件重复 observe 只入队一次', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        const first = bridge.observe({ item_key: 'w1', type: 'answer' });
        const second = bridge.observe({ item_key: 'w1', type: 'answer' });
        assert.ok(first, '首次应入队');
        assert.strictEqual(second, null, '重复不应入队');
        assert.strictEqual(bridge.getState().queued, 1);
        assert.strictEqual(bridge.getState().duplicates, 1);
    });
    await check('event_id 跨实例稳定（刷新后不产生重复事件）', () => {
        const one = bridgeModule.createBridge({ instanceId: 'fixed' });
        one.attach(session());
        const a = one.observe({ item_key: 'w1', type: 'answer' });
        const two = bridgeModule.createBridge({ instanceId: 'fixed' });
        two.attach(session());
        const b = two.observe({ item_key: 'w1', type: 'answer' });
        assert.strictEqual(a.event_id, b.event_id);
    });
    await check('round_key 变化视为新事件', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        assert.ok(bridge.observe({ item_key: 'w1', round_key: 'r1' }));
        assert.ok(bridge.observe({ item_key: 'w1', round_key: 'r2' }));
        assert.strictEqual(bridge.getState().queued, 2);
    });

    // ------------------------------------------------------------ source 约束
    group('source discipline');
    await check('observe 强制 observed_ack（不能自称官方快照）', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        const record = bridge.observe({ item_key: 'w1', source: 'official_snapshot' });
        assert.strictEqual(record.source, 'observed_ack');
    });
    await check('intent 强制 intent', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        const record = bridge.intent({ item_key: 'w1', source: 'observed_ack' });
        assert.strictEqual(record.source, 'intent');
    });

    // ------------------------------------------------------------ 有界队列
    group('bounded queue');
    await check('超过上限后丢弃最旧且永不超界', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        for (let i = 0; i < bridgeModule.MAX_QUEUE + 50; i += 1) {
            bridge.observe({ item_key: 'w' + i, type: 'answer' });
        }
        const state = bridge.getState();
        assert.strictEqual(state.queued, bridgeModule.MAX_QUEUE);
        assert.ok(state.dropped >= 50, '丢弃应被记录，实为 ' + state.dropped);
    });
    await check('缺少 item_key 不计入队列', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        assert.strictEqual(bridge.observe({ type: 'answer' }), null);
        assert.strictEqual(bridge.getState().queued, 0);
        assert.strictEqual(bridge.getState().dropped, 1);
    });

    // ------------------------------------------------------------ 生命周期
    group('lifecycle');
    await check('未 attach 时不入队', () => {
        const bridge = bridgeModule.createBridge({});
        assert.strictEqual(bridge.observe({ item_key: 'w1' }), null);
        assert.strictEqual(bridge.getState().enabled, false);
    });
    await check('paused 时不入队但已入队的保留', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        bridge.observe({ item_key: 'w1' });
        bridge.setPaused(true);
        assert.strictEqual(bridge.observe({ item_key: 'w2' }), null);
        assert.strictEqual(bridge.getState().queued, 1);
    });
    await check('detach 后停止接收', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        bridge.detach();
        assert.strictEqual(bridge.observe({ item_key: 'w1' }), null);
    });
    await check('destroy 清空队列', () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        bridge.observe({ item_key: 'w1' });
        bridge.destroy();
        assert.strictEqual(bridge.getState().queued, 0);
        assert.strictEqual(bridge.getState().enabled, false);
    });

    // ------------------------------------------------------------ 发送与重试
    group('flush and retry');
    await check('无 sender 时保留队列而非丢弃', async () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        bridge.observe({ item_key: 'w1' });
        const result = await bridge.flush();
        assert.strictEqual(result.skipped, true);
        assert.strictEqual(bridge.getState().queued, 1);
    });
    await check('成功发送后队列清空', async () => {
        const sent = [];
        const bridge = bridgeModule.createBridge({
            send: (sessionId, batch) => {
                sent.push({ sessionId: sessionId, batch: batch });
                return { accepted: batch.length };
            }
        });
        bridge.attach(session());
        bridge.observe({ item_key: 'w1' });
        bridge.observe({ item_key: 'w2' });
        await bridge.flush();
        assert.strictEqual(bridge.getState().queued, 0);
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0].batch.length, 2);
        assert.strictEqual(bridge.getState().sent, 2);
    });
    await check('部分接受时剩余回队', async () => {
        const bridge = bridgeModule.createBridge({
            send: () => ({ accepted: 1 })
        });
        bridge.attach(session());
        bridge.observe({ item_key: 'w1' });
        bridge.observe({ item_key: 'w2' });
        await bridge.flush();
        assert.strictEqual(bridge.getState().queued, 1, '未接受的那条必须留在队列');
        assert.strictEqual(bridge.getState().failed, 1);
    });
    await check('发送失败时回队并记录错误（绝不丢事件）', async () => {
        const bridge = bridgeModule.createBridge({
            send: () => { throw new Error('offline'); }
        });
        bridge.attach(session());
        bridge.observe({ item_key: 'w1' });
        await bridge.flush();
        assert.strictEqual(bridge.getState().queued, 1);
        assert.strictEqual(bridge.getState().failed, 1);
        assert.ok(bridge.getState().lastError.indexOf('offline') >= 0);
    });
    await check('单批不超过 MAX_BATCH', async () => {
        const sizes = [];
        const bridge = bridgeModule.createBridge({
            send: (sessionId, batch) => {
                sizes.push(batch.length);
                return { accepted: batch.length };
            }
        });
        bridge.attach(session());
        for (let i = 0; i < bridgeModule.MAX_BATCH + 10; i += 1) {
            bridge.observe({ item_key: 'w' + i });
        }
        await bridge.flush();
        assert.strictEqual(sizes[0], bridgeModule.MAX_BATCH);
        assert.strictEqual(bridge.getState().queued, 10);
    });

    // ------------------------------------------------------------ 心跳
    group('heartbeat');
    await check('无心跳通道时安全跳过', async () => {
        const bridge = bridgeModule.createBridge({});
        bridge.attach(session());
        const result = await bridge.heartbeat();
        assert.strictEqual(result.skipped, true);
    });
    await check('心跳携带 instance 标识', async () => {
        let seen = null;
        const bridge = bridgeModule.createBridge({
            instanceId: 'inst-xyz',
            heartbeat: (sessionId, instanceId) => {
                seen = { sessionId: sessionId, instanceId: instanceId };
                return { ok: true };
            }
        });
        bridge.attach(session());
        await bridge.heartbeat();
        assert.deepStrictEqual(seen, { sessionId: 'ses_test_1', instanceId: 'inst-xyz' });
    });

    // ------------------------------------------------------------ 汇总
    const failed = failures.length;
    console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项');
    if (failed) {
        failures.forEach((item) => {
            console.log('  - ' + item.name + ' :: ' + item.message);
        });
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