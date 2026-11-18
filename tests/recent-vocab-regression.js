/* 近期学习词汇获取 · 回归
 *
 * 全部离线：用注入的假 api / 假时钟，不联网、不碰真实数据目录。
 * 覆盖北京时间跨日、去重、规范化、完整性判定、无数据、账号切换隔离。
 */
'use strict';
const path = require('path');
const assert = require('assert');

const REPO = path.resolve(__dirname, '..');
const Module = require('module');

// 在沙箱里加载 recent-vocab.js（它用 IIFE 挂到传入的 root）
function loadModule(rootObj) {
  const fs = require('fs');
  const src = fs.readFileSync(path.join(REPO, 'js', 'recent-vocab.js'), 'utf8');
  const vm = require('vm');
  const sandbox = { console, Date, Math, JSON, Object, Array, String, Number, Boolean,
    Promise, setTimeout, clearTimeout, encodeURIComponent, decodeURIComponent, isFinite, isNaN, RegExp };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'recent-vocab.js' });
  return sandbox.MemoRecentVocab;
}

const V = loadModule({});
const groups = [];
function group(name, fn) { groups.push({ name, fn }); }

/* ---------------- 北京时间与日期工具 ---------------- */

group('北京时间日期键', () => {
  // 2026-11-18 00:30 北京时间 = 2026-11-17 16:30 UTC
  const ms = Date.UTC(2026, 10, 17, 16, 30);
  assert.strictEqual(V.beijingDateKey(ms), '2026-11-18',
    'UTC 16:30 必须是北京次日');
  // 2026-11-18 07:59 北京时间 = 2026-11-17 23:59 UTC
  assert.strictEqual(V.beijingDateKey(Date.UTC(2026, 10, 17, 23, 59)), '2026-11-18');
  // 2026-11-18 02:00 北京时间 = 2026-11-17 18:00 UTC
  assert.strictEqual(V.beijingDateKey(Date.UTC(2026, 10, 17, 18, 0)), '2026-11-18');
});

group('日期解析兼容多种来源格式', () => {
  assert.strictEqual(V.toBeijingDateKey('2026-11-18'), '2026-11-18');
  assert.strictEqual(V.toBeijingDateKey('2026/11/18'), '2026-11-18');
  assert.strictEqual(V.toBeijingDateKey('2026-11-18T00:30:00+08:00'), '2026-11-18');
  // 带 Z 的 UTC 时间要换算到北京
  assert.strictEqual(V.toBeijingDateKey('2026-11-17T16:30:00Z'), '2026-11-18');
  // 空值不抛异常
  assert.strictEqual(V.toBeijingDateKey(''), null);
  assert.strictEqual(V.toBeijingDateKey(null), null);
});

group('范围窗口（含今天）', () => {
  const now = Date.UTC(2026, 10, 18, 4, 0); // 北京 2026-11-18 12:00
  assert.strictEqual(V.rangeWindow('d7', now).start, '2026-11-12', '最近 7 天含今天共 7 天');
  assert.strictEqual(V.rangeWindow('d7', now).end, '2026-11-18');
  assert.strictEqual(V.rangeWindow('d3', now).start, '2026-11-16');
  assert.strictEqual(V.rangeWindow('d14', now).start, '2026-11-05');
  assert.strictEqual(V.rangeWindow('today', now).start, '2026-11-18');
  assert.strictEqual(V.rangeWindow('today', now).days, 1);
});

/* ---------------- 去重与规范化 ---------------- */

group('拼写规范化', () => {
  assert.strictEqual(V.normalizeSpelling('  Hello  '), 'Hello', '仅去首尾空白，保留原始大小写');
  assert.strictEqual(V.normalizeSpelling('take   off'), 'take off', '连续空白合一');
  assert.strictEqual(V.normalizeSpelling(''), '');
});

group('按 voc_id 去重，保留最近学习日期与来源', () => {
  const rows = [
    { vocId: 'v1', spelling: 'apple', lastStudyDate: '2026-11-10', source: 'study-records' },
    { vocId: 'v1', spelling: 'apple', lastStudyDate: '2026-11-17', source: 'study-records' },
    { vocId: 'v2', spelling: 'banana', lastStudyDate: '2026-11-16', source: 'study-records' }
  ];
  const out = V.dedupe(rows);
  assert.strictEqual(out.length, 2, '重复 voc_id 只保留一条，实际 ' + out.length);
  const apple = out.filter(r => r.vocId === 'v1')[0];
  assert.strictEqual(apple.lastStudyDate, '2026-11-17', '保留更近的学习日期');
  assert.ok(apple.spelling === 'apple' && apple.source === 'study-records');
});

group('无 voc_id 时用规范化拼写去重', () => {
  const rows = [
    { vocId: '', spelling: 'Apple', lastStudyDate: '2026-11-10' },
    { vocId: '', spelling: 'Apple', lastStudyDate: '2026-11-15' }
  ];
  assert.strictEqual(V.dedupe(rows).length, 1, '无 id 时按拼写去重');
});

/* ---------------- 范围筛选 ---------------- */

group('按 last_study_date 筛选范围', () => {
  const records = [
    { voc_id: 'a', voc_spelling: 'alpha', last_study_date: '2026-11-18T00:30:00+08:00' },
    { voc_id: 'b', voc_spelling: 'beta', last_study_date: '2026-11-16T22:00:00+08:00' },
    { voc_id: 'c', voc_spelling: 'gamma', last_study_date: '2026-11-01T10:00:00+08:00' }
  ];
  const window = V.rangeWindow('d3', Date.UTC(2026, 10, 18, 4, 0));
  const out = V.candidatesFromRecords(records, window);
  const ids = out.map(r => r.vocId).sort();
  // vm 跨 realm 的数组原型不同，deepStrictEqual 必然失败，用 join 比对
  assert.strictEqual(ids.join('|'), 'a|b', '只保留 3 天窗口内的词，实际 ' + ids.join(','));
  assert.strictEqual(out.length, 2, '窗口外的旧词必须被排除');
});

group('日期级时间戳不被当成逐词答题时间', () => {
  const records = [{ voc_id: 'a', voc_spelling: 'alpha', last_study_date: '2026-11-18' }];
  const window = V.rangeWindow('today', Date.UTC(2026, 10, 18, 4, 0));
  const out = V.candidatesFromRecords(records, window);
  assert.strictEqual(out.length, 1, '纯日期也能匹配当天');
  // 不能凭空产出分钟级时间
  assert.ok(!/T\d\d:/.test(String(out[0].lastStudyDate)) || out[0].lastStudyDate.length === 10,
    '日期级输入不应被伪造成具体时刻');
});

/* ---------------- 完整性判定 ---------------- */

group('完整性：正常 / 未同步 / 过旧 / 部分', () => {
  const now = Date.UTC(2026, 10, 18, 4, 0);
  const fresh = V.evaluateCompleteness({
    sync: { bootstrap_complete: true, needs_verify: false },
    syncedAt: '2026-11-18T06:00:00+08:00', nowMs: now,
    window: V.rangeWindow('d7', now), candidateCount: 5, recordCount: 100,
    todayError: null, todayTruncated: false, todayLimit: 1000
  });
  assert.strictEqual(fresh.completeness, 'complete', '刚同步完应为完整，实际 ' + fresh.completeness);

  const notSynced = V.evaluateCompleteness({
    sync: { bootstrap_complete: false },
    syncedAt: null, nowMs: now, window: V.rangeWindow('d7', now),
    candidateCount: 0, recordCount: 0, todayError: null, todayTruncated: false, todayLimit: 1000
  });
  assert.strictEqual(notSynced.partial, true, '未完成初次同步应判 partial');

  const stale = V.evaluateCompleteness({
    sync: { bootstrap_complete: true, needs_verify: false },
    syncedAt: '2026-11-10T06:00:00+08:00', nowMs: now,
    window: V.rangeWindow('d7', now), candidateCount: 5, recordCount: 100,
    todayError: null, todayTruncated: false, todayLimit: 1000
  });
  assert.strictEqual(stale.completeness, 'stale', '同步超过 24h 应为 stale，实际 ' + stale.completeness);

  const truncated = V.evaluateCompleteness({
    sync: { bootstrap_complete: true, needs_verify: false },
    syncedAt: '2026-11-18T06:00:00+08:00', nowMs: now,
    window: V.rangeWindow('today', now), candidateCount: 5, recordCount: 100,
    todayError: null, todayTruncated: true, todayLimit: 1000
  });
  assert.strictEqual(truncated.completeness, 'partial', '今日列表取满上限应判 partial');
});

/* ---------------- collect：主流程 ---------------- */

function fakeApi(opts) {
  opts = opts || {};
  return {
    hasToken: () => opts.connected !== false,
    connectionStatus: () => ({ connected: opts.connected !== false, profile_id: opts.profileId || 'p-1' }),
    // 真实字段名见 db.py:410 _SYNC_COLUMNS（last_success_at / last_incremental_at 等）
    getStudySyncStatus: async () => opts.sync ||
      { bootstrap_complete: true, needs_reconcile: false, last_success_at: '2026-11-18T06:00:00+08:00' },
    getAllStudyRecords: async () => opts.records || [],
    request: async () => opts.todayPayload || { today_items: [] }
  };
}

async function asyncGroup(name, fn) { groups.push({ name, fn, async: true }); }

asyncGroup('collect：无账号', async () => {
  V.resetDeps();
  const out = await V.collect('d7', { deps: {
    api: fakeApi({ connected: false }), now: () => Date.UTC(2026, 10, 18, 4, 0)
  } });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'no-account', '未连接应返回 no-account');
  assert.strictEqual(out.candidates.length, 0);
});

asyncGroup('collect：未同步（无记录）', async () => {
  V.resetDeps();
  const out = await V.collect('d7', { deps: {
    api: fakeApi({ records: [], sync: { bootstrap_complete: false } }),
    now: () => Date.UTC(2026, 10, 18, 4, 0)
  } });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'not-synced', '无记录且未 bootstrap 应为 not-synced，实际 ' + out.reason);
});

asyncGroup('collect：范围为空但已同步', async () => {
  V.resetDeps();
  const out = await V.collect('d7', { deps: {
    api: fakeApi({ records: [{ voc_id: 'x', voc_spelling: 'old', last_study_date: '2020-01-01' }] }),
    now: () => Date.UTC(2026, 10, 18, 4, 0)
  } });
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.reason, 'empty', '窗口内无词应为 empty，实际 ' + out.reason);
  assert.strictEqual(out.candidates.length, 0, '空结果绝不能编造候选词');
});

asyncGroup('collect：正常返回候选词', async () => {
  V.resetDeps();
  const out = await V.collect('d7', { deps: {
    api: fakeApi({ records: [
      { voc_id: 'a', voc_spelling: 'alpha', last_study_date: '2026-11-17T10:00:00+08:00' },
      { voc_id: 'b', voc_spelling: 'beta', last_study_date: '2026-11-16T10:00:00+08:00' }
    ] }),
    now: () => Date.UTC(2026, 10, 18, 4, 0)
  } });
  assert.strictEqual(out.ok, true, '应有候选词');
  assert.strictEqual(out.candidates.length, 2);
  assert.strictEqual(out.completeness, 'complete');
  assert.strictEqual(out.accountScope, 'profile:p-1', '账号作用域取 profile_id');
  assert.ok(out.start === '2026-11-12' && out.end === '2026-11-18', '带出日期范围');
});

asyncGroup('collect：今天已完成走 get_today_items', async () => {
  V.resetDeps();
  let requested = null;
  const api = fakeApi({
    records: [{ voc_id: 'a', voc_spelling: 'alpha', last_study_date: '2026-11-18' }],
    todayPayload: { today_items: [
      { voc_id: 'a', voc_spelling: 'alpha', order: 1, is_new: false, is_finished: true }
    ] }
  });
  api.request = async (p, o) => { requested = { p, o }; return { today_items: [
    { voc_id: 'a', voc_spelling: 'alpha', order: 1, is_new: false, is_finished: true }
  ] }; };
  const out = await V.collect('today', { deps: { api, now: () => Date.UTC(2026, 10, 18, 4, 0) } });
  assert.ok(requested, '必须调用 get_today_items');
  assert.strictEqual(requested.p, '/study/get_today_items');
  assert.strictEqual(requested.o.method, 'POST');
  assert.strictEqual(requested.o.body.is_finished, true, '必须只要已完成的词');
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.candidates.length, 1);
});

asyncGroup('collect：账号切换返回不同作用域', async () => {
  V.resetDeps();
  const now = () => Date.UTC(2026, 10, 18, 4, 0);
  const records = [{ voc_id: 'a', voc_spelling: 'alpha', last_study_date: '2026-11-17' }];
  const one = await V.collect('d7', { deps: { api: fakeApi({ records, profileId: 'p-1' }), now } });
  const two = await V.collect('d7', { deps: { api: fakeApi({ records, profileId: 'p-2' }), now } });
  assert.strictEqual(one.accountScope, 'profile:p-1');
  assert.strictEqual(two.accountScope, 'profile:p-2');
  assert.notStrictEqual(one.accountScope, two.accountScope, '不同账号必须有不同作用域');
});

asyncGroup('collect：接口异常不抛出，返回 error', async () => {
  V.resetDeps();
  const api = fakeApi({ connected: true });
  api.getAllStudyRecords = async () => { throw new Error('boom'); };
  const out = await V.collect('d7', { deps: { api, now: () => Date.UTC(2026, 10, 18, 4, 0) } });
  assert.strictEqual(typeof out, 'object', '异常也必须返回对象');
  assert.ok(Array.isArray(out.candidates), '即使出错也要有 candidates 数组');
});

/* ---------------- 运行 ---------------- */

(async () => {
  let pass = 0, fail = 0;
  const failures = [];
  for (const g of groups) {
    try {
      await g.fn();
      pass += 1;
      console.log('  ok  ' + g.name);
    } catch (error) {
      fail += 1;
      failures.push(g.name + ' -> ' + error.message);
      console.log('  FAIL ' + g.name + ' -> ' + error.message);
    }
  }
  console.log('');
  console.log('recent-vocab: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach(f => console.log('  ! ' + f)); process.exit(1); }
  console.log('RECENT_VOCAB_PASS');
})();
