/* eslint-disable */
/**
 * companion-settlement.js 回归测试（node，无框架）。
 *
 * 重点保护结算演出的四条契约：
 * 1. **零可选依赖可用**：不传 speak/playMotion/requestAi 也能完整显示；
 * 2. **AI 严格一次**：同一 settlement_id 只请求一次，失败静默降级；
 * 3. **重看不重放**：refresh 绝不触发语音/动作/AI；
 * 4. **废弃可识别**：换了结算对象必须提示并停掉对应语音。
 *
 * 用法： node tests/companion-settlement-regression.js
 */
'use strict';

const path = require('path');
const assert = require('assert');

const mod = require(path.join(__dirname, '..', 'js', 'companion-settlement.js'));

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

function settlement(overrides) {
    return Object.assign({
        available: true,
        settlement_id: 'set_1',
        session_id: 'ses_1',
        role_id: 'role-a',
        role_name: '安和',
        confirmed_new: 6,
        confirmed_review: 2,
        confirmed_total: 8,
        active_seconds: 1500,
        weak_words: ['apple', 'banana'],
        evidence_refs: {},
        goal: { goal_kind: 'session_goal', target_count: 8 },
        message: '这一轮完成 8 词，用了 25 分钟。',
        ai_state: 'idle',
        ai_message: null,
        rewards: [
            {
                reward_id: 'rwd_1', type: 'memorial_card', period_key: '2026-11-16',
                payload: {
                    study_day: '2026-11-16', role_name: '安和', confirmed_total: 8,
                    weak_words: ['apple', 'banana']
                },
                created_at: '2026-11-16T10:00:00+00:00'
            },
            {
                reward_id: 'rwd_2', type: 'first_completion', period_key: 'first',
                payload: { study_day: '2026-11-16', role_name: '安和' },
                created_at: '2026-11-16T10:00:00+00:00'
            }
        ],
        created_at: '2026-11-16T10:00:00+00:00'
    }, overrides || {});
}

async function main() {
    group('module shape');
    await check('导出 create', () => {
        assert.strictEqual(typeof mod.create, 'function');
    });
    await check('create({}) 不抛异常（所有回调都可选）', () => {
        const instance = mod.create({});
        assert.ok(instance);
        instance.destroy();
    });
    await check('MAX_WEAK_WORDS 为 10', () => {
        assert.strictEqual(mod.MAX_WEAK_WORDS, 10);
    });

    group('零可选依赖可用');
    await check('show 渲染本地 message', () => {
        const instance = mod.create({});
        instance.show(settlement());
        const state = instance.getState();
        assert.strictEqual(state.open, true);
        assert.ok(state.localText.indexOf('8 词') >= 0, state.localText);
        instance.destroy();
    });
    await check('纪念卡与徽章都出现', () => {
        const instance = mod.create({});
        instance.show(settlement());
        const state = instance.getState();
        assert.strictEqual(state.cardVisible, true);
        assert.strictEqual(state.badgeVisible, true);
        assert.deepStrictEqual(state.rewardTypes,
            ['memorial_card', 'first_completion']);
        instance.destroy();
    });
    await check('weak_words 不超过 10 条', () => {
        const many = [];
        for (let i = 0; i < 25; i += 1) { many.push('w' + i); }
        const instance = mod.create({});
        const payload = settlement();
        payload.weak_words = many;
        payload.rewards[0].payload.weak_words = many;
        instance.show(payload);
        assert.ok(instance.getState().weakWords.length <= mod.MAX_WEAK_WORDS);
        instance.destroy();
    });
    await check('无 reward 时也不崩', () => {
        const instance = mod.create({});
        instance.show(settlement({ rewards: [] }));
        const state = instance.getState();
        assert.strictEqual(state.open, true);
        assert.strictEqual(state.cardVisible, false);
        instance.destroy();
    });

    group('AI 严格一次');
    await check('同一 settlement 只请求一次', () => {
        let calls = 0;
        const instance = mod.create({
            requestAi: () => { calls += 1; return '好的'; }
        });
        instance.show(settlement());
        instance.show(settlement());
        assert.strictEqual(calls, 1, 'AI 请求次数为 ' + calls);
        instance.destroy();
    });
    await check('AI 抛错静默降级', () => {
        const instance = mod.create({
            requestAi: () => { throw new Error('upstream down'); }
        });
        instance.show(settlement());
        const state = instance.getState();
        // 关键：本地文字必须仍在，不能因为 AI 失败让弹层变空。
        assert.ok(state.localText.indexOf('8 词') >= 0, state.localText);
        instance.destroy();
    });
    await check('未提供 requestAi 时 also 正常', () => {
        const instance = mod.create({});
        instance.show(settlement());
        assert.strictEqual(instance.getState().aiRequested, false);
        instance.destroy();
    });

    group('重看不重放');
    await check('refresh 不调 speak / playMotion / requestAi', () => {
        let spoken = 0;
        let motioned = 0;
        let ai = 0;
        const instance = mod.create({
            speak: () => { spoken += 1; },
            playMotion: () => { motioned += 1; },
            requestAi: () => { ai += 1; return ''; }
        });
        instance.show(settlement());
        const beforeShow = { spoken: spoken, motioned: motioned, ai: ai };
        instance.refresh(settlement());
        assert.strictEqual(spoken, beforeShow.spoken, 'refresh 不应再朗读');
        assert.strictEqual(motioned, beforeShow.motioned, 'refresh 不应再播放动作');
        assert.strictEqual(ai, beforeShow.ai, 'refresh 不应再请求 AI');
        instance.destroy();
    });
    await check('show 各调用一次 speak 与 playMotion', () => {
        let spoken = 0;
        let motioned = 0;
        const instance = mod.create({
            speak: () => { spoken += 1; },
            playMotion: () => { motioned += 1; }
        });
        instance.show(settlement());
        assert.strictEqual(spoken, 1);
        assert.strictEqual(motioned, 1);
        instance.destroy();
    });

    group('废弃判定');
    await check('不同 settlement_id 触发 stopSpeak 并提示', () => {
        let stopped = 0;
        const instance = mod.create({ stopSpeak: () => { stopped += 1; } });
        instance.show(settlement());
        instance.refresh(settlement({ settlement_id: 'set_2' }));
        const state = instance.getState();
        assert.strictEqual(stopped, 1, '必须停掉旧结算的语音');
        const indicated = state.isOpen === false ||
            (state.notice || '').indexOf('记录已更新') >= 0;
        assert.ok(indicated, '必须提示或关闭，实为 notice=' + state.notice);
        instance.destroy();
    });
    await check('available=false 判定为废弃', () => {
        const instance = mod.create({});
        instance.show(settlement());
        instance.refresh({ available: false });
        const state = instance.getState();
        const indicated = state.isOpen === false || state.stale === true;
        assert.ok(indicated, 'available=false 必须被识别');
        instance.destroy();
    });
    await check('role_id 变化判定为废弃', () => {
        const instance = mod.create({});
        instance.show(settlement());
        instance.refresh(settlement({ role_id: 'role-b' }));
        assert.strictEqual(instance.getState().stale, true);
        instance.destroy();
    });

    group('生命周期');
    await check('hide 后 isOpen=false', () => {
        const instance = mod.create({});
        instance.show(settlement());
        instance.hide();
        assert.strictEqual(instance.isOpen(), false);
        instance.destroy();
    });
    await check('destroy 不抛异常且后不可开', () => {
        const instance = mod.create({});
        instance.show(settlement());
        instance.destroy();
        assert.strictEqual(instance.isOpen(), false);
    });
    await check('hide 触发 onClose', () => {
        let closed = 0;
        const instance = mod.create({ onClose: () => { closed += 1; } });
        instance.show(settlement());
        instance.hide();
        assert.strictEqual(closed, 1);
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