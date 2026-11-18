/* 四六级仔细阅读练习 · 回归
 *
 * 全部离线：AI 用注入的 stub，存储用内存实现，不联网、不碰真实数据。
 * 覆盖结构校验的每一条失败分支、判分确定性、冻结答案、证据定位、
 * 目标词子串误判、账号隔离、防重复提交、取消与迟到响应。
 */
'use strict';
const path = require('path');
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const REPO = path.resolve(__dirname, '..');

function load(rootObj) {
  const src = fs.readFileSync(path.join(REPO, 'js', 'reading-practice.js'), 'utf8');
  const sandbox = { console, Date, Math, JSON, Object, Array, String, Number, Boolean,
    Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    encodeURIComponent, decodeURIComponent, isFinite, isNaN, RegExp, Error, Map, Set,
    AbortController: global.AbortController, fetch: global.fetch, localStorage: undefined };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'reading-practice.js' });
  return sandbox.MemoReadingPractice;
}

const P = load({});
const groups = [];
function group(name, fn) { groups.push({ name, fn }); }
function asyncGroup(name, fn) { groups.push({ name, fn, async: true }); }

/* ---------------- 构造合法练习 ---------------- */

// 305 词，落在四级 300~350 区间内（由 _verification/r5-reading/gen-fixture.js 实测）。
const ARTICLE_PARAS = [
  'Across many campuses a quiet experiment is now under way. Instead of urging students to reinvent their ' +
    'entire routine in a single week, advisers ask them to adopt one small sustainable habit and to repeat it ' +
    'until the action stops feeling like a decision. The reasoning behind this shift is not sentimental. Studies ' +
    'of behaviour change suggest that a repeated action, anchored to a cue that already exists in the day, is far ' +
    'easier to keep than a dramatic resolution made in a moment of enthusiasm and quietly dropped three weeks later.',
  'One university put the idea to a deliberately modest test. Freshmen arriving for their first term were asked ' +
    'to record a single resilient routine each day, such as a ten minute walk after the last lecture, a fixed hour ' +
    'of reading before dinner, or a short review of notes before bed. No grades depended on it, no one monitored ' +
    'the entries closely, and no student was penalised for missing a day. The organisers wanted to know whether a ' +
    'routine would survive when nothing external forced it. After a full term, the participants who had kept the ' +
    'habit reported lower stress and steadier attention than their peers, and they were noticeably less likely to ' +
    'abandon their study schedule during the crowded weeks of examinations.',
  'Critics remain unconvinced. They call such programmes too modest to matter and argue that small routines cannot ' +
    'possibly compensate for an overloaded curriculum, crowded housing or the ordinary pressures of student life. ' +
    'Advocates answer that the aim is not a single triumph but a durable change in how students direct their ' +
    'attention from one task to the next. If a routine survives the pressure of a whole term, they say, it has ' +
    'already taught the skill that matters most: keeping a quiet promise to oneself when nobody else is watching.'
];

function makePractice(overrides) {
  const base = {
    schema: 'memo-reading-v1',
    id: 'prac-test',
    createdAt: '2026-11-18T08:00:00+08:00',
    level: 'cet4',
    levelLabel: '四级',
    title: 'Small Habits, Lasting Change',
    paragraphs: ARTICLE_PARAS.slice(),
    wordCount: 305,   // 冻结词数，必须与 paragraphs 实际词数一致
    source: { rangeKey: 'd7', rangeLabel: '最近 7 天', days: 7, completeness: 'complete',
      syncedAt: '2026-11-18T07:20:00+08:00' },
    targetWords: [
      { vocId: 'v1', spelling: 'sustainable', surface: 'sustainable', paragraphIndex: 0 },
      // surface 必须是该段里真实出现的词形（initiative/advocate 在这版正文里不含独立词形）
      { vocId: 'v2', spelling: 'deliberately', surface: 'deliberately', paragraphIndex: 1 },
      { vocId: 'v3', spelling: 'resilient', surface: 'resilient', paragraphIndex: 1 },
      { vocId: 'v4', spelling: 'advocate', surface: 'Advocates', paragraphIndex: 2 }
    ],
    questions: [
      { id: 'q1', stem: 'What do the designers claim about a repeated action?',
        options: [ { key: 'A', text: 'It is easier to keep than a dramatic resolution.' },
                   { key: 'B', text: 'It demands more willpower than a single decision.' },
                   { key: 'C', text: 'It only works for first-year students.' },
                   { key: 'D', text: 'It rarely survives a whole term.' } ],
        answer: 'A',
        evidence: { paragraphIndex: 0, quote: 'a repeated action, anchored to a cue that already exists in the day, is far easier to keep than a dramatic resolution' },
        explanation: '第一段把重复动作与戏剧性决心对比，前者更易保持。',
        distractors: [ { key: 'B', why: '原文没有比较意志力高低。' },
                       { key: 'C', why: '原文没有限定适用人群。' },
                       { key: 'D', why: '原文倾向相反。' } ],
        type: 'detail' },
      { id: 'q2', stem: 'What were freshmen asked to do in the initiative?',
        options: [ { key: 'A', text: 'Join a weekly stress workshop.' },
                   { key: 'B', text: 'Record one resilient routine each day.' },
                   { key: 'C', text: 'Compare attention with older students.' },
                   { key: 'D', text: 'Abandon their previous habits entirely.' } ],
        answer: 'B',
        evidence: { paragraphIndex: 1, quote: 'to record a single resilient routine each day' },
        explanation: '第二段说明要求新生每天记录一条可持续惯例。',
        distractors: [ { key: 'A', why: '原文提到压力下降，但没有工作坊。' },
                       { key: 'C', why: '原文没有与高年级比较。' },
                       { key: 'D', why: '原文主张小改变而非全部替换。' } ],
        type: 'detail' },
      { id: 'q3', stem: 'How do advocates answer the critics?',
        options: [ { key: 'A', text: 'By conceding the programmes rarely work.' },
                   { key: 'B', text: 'By redefining the goal as durable attention change.' },
                   { key: 'C', text: 'By requesting larger research budgets.' },
                   { key: 'D', text: 'By proposing a stricter grading rule.' } ],
        answer: 'B',
        evidence: { paragraphIndex: 2, quote: 'the aim is not a single triumph but a durable change in how students direct their attention' },
        explanation: '末段引述支持者重新界定目标。',
        distractors: [ { key: 'A', why: '支持者并未承认无效。' },
                       { key: 'C', why: '原文没有提到预算。' },
                       { key: 'D', why: '原文没有涉及评分。' } ],
        type: 'infer' },
      { id: 'q4', stem: 'The word "modest" in paragraph 3 is closest in meaning to',
        options: [ { key: 'A', text: 'unambitious in scale' },
                   { key: 'B', text: 'inexpensive to run' },
                   { key: 'C', text: 'poorly documented' },
                   { key: 'D', text: 'carefully worded' } ],
        answer: 'A',
        evidence: { paragraphIndex: 2, quote: 'They call such programmes too modest to matter' },
        explanation: 'modest 指规模不大。',
        distractors: [ { key: 'B', why: '与花费无关。' },
                       { key: 'C', why: '没有讨论记录质量。' },
                       { key: 'D', why: '不是在说措辞。' } ],
        type: 'vocab' },
      { id: 'q5', stem: 'What is the main idea of the passage?',
        options: [ { key: 'A', text: 'Campuses should abandon habit programmes.' },
                   { key: 'B', text: 'Small sustained routines can yield lasting benefits.' },
                   { key: 'C', text: 'Freshman stress cannot be reduced.' },
                   { key: 'D', text: 'Dramatic resolutions work fastest.' } ],
        answer: 'B',
        evidence: { paragraphIndex: 0, quote: 'a repeated action, anchored to a cue that already exists in the day' },
        explanation: '全文围绕小而持续的习惯带来长期收益。',
        distractors: [ { key: 'A', why: '文章整体支持这类项目。' },
                       { key: 'C', why: '第二段说明压力下降。' },
                       { key: 'D', why: '文章反对戏剧性决心更有效。' } ],
        type: 'main' }
    ],
    generation: {
        provider: 'stub', model: 'stub', promptVersion: 'v1',
        reviewed: true, reviewNotes: [],
        // isSubmittable 现在要求审题元数据自洽：时间可解析、无遗留问题、
        // 逐题结论覆盖每一道题。缺任何一项都不可提交。
        reviewedAt: '2026-11-18T08:10:00+08:00',
        reviewOverall: 'ok',
        reviewProblems: [],
        reviewPerQuestion: [
            { id: 'q1', unique: true, bestAnswer: 'A', evidenceSupported: true, distractorsReasonable: true },
            { id: 'q2', unique: true, bestAnswer: 'B', evidenceSupported: true, distractorsReasonable: true },
            { id: 'q3', unique: true, bestAnswer: 'B', evidenceSupported: true, distractorsReasonable: true },
            { id: 'q4', unique: true, bestAnswer: 'A', evidenceSupported: true, distractorsReasonable: true },
            { id: 'q5', unique: true, bestAnswer: 'B', evidenceSupported: true, distractorsReasonable: true }
        ]
    },
    accountScope: 'profile:test'
  };
  // 产品要求：判分只认冻结答案，校验必须能看到 frozenAnswers。
  base.frozenAnswers = base.questions.map(q => ({ id: q.id, answer: q.answer }));
  // 递归覆盖
  if (overrides) {
    for (const key of Object.keys(overrides)) base[key] = overrides[key];
  }
  return base;
}

/* ---------------- 结构校验 ---------------- */

group('合法练习通过校验', () => {
  const r = P.validate(makePractice());
  assert.strictEqual(r.ok, true, '合法练习应通过，实际错误：' + (r.errors || []).join('; '));
});

group('缺题目 / 题目数不是 5', () => {
  const four = makePractice();
  four.questions = four.questions.slice(0, 4);
  const r1 = P.validate(four);
  assert.strictEqual(r1.ok, false, '4 道题必须被拒绝');
  assert.ok(r1.errors.some(e => /5/.test(e)), '错误信息应指出题目数量，实际 ' + r1.errors.join('; '));

  const six = makePractice();
  six.questions = six.questions.concat([six.questions[0]]);
  assert.strictEqual(P.validate(six).ok, false, '6 道题必须被拒绝');

  const none = makePractice({ questions: [] });
  assert.strictEqual(P.validate(none).ok, false, '没有题目必须被拒绝');
});

group('选项数量不是 4', () => {
  const three = makePractice();
  three.questions[0].options = three.questions[0].options.slice(0, 3);
  const r = P.validate(three);
  assert.strictEqual(r.ok, false, '3 个选项必须被拒绝');
  assert.ok(r.errors.some(e => /4/.test(e)), '应指出选项数量，实际 ' + r.errors.join('; '));

  const five = makePractice();
  five.questions[1].options = five.questions[1].options.concat([{ key: 'E', text: 'extra' }]);
  assert.strictEqual(P.validate(five).ok, false, '5 个选项必须被拒绝');
});

group('答案不在 A-D', () => {
  const bad = makePractice();
  bad.questions[0].answer = 'E';
  const r = P.validate(bad);
  assert.strictEqual(r.ok, false, 'answer=E 必须被拒绝');
  assert.ok(r.errors.some(e => /A/.test(e) || /答案/.test(e)), '应指出答案非法，实际 ' + r.errors.join('; '));

  const empty = makePractice();
  empty.questions[2].answer = '';
  assert.strictEqual(P.validate(empty).ok, false, '空答案必须被拒绝');
});

group('选项文本为空或重复', () => {
  const blank = makePractice();
  blank.questions[0].options[1].text = '   ';
  assert.strictEqual(P.validate(blank).ok, false, '空白选项必须被拒绝');

  const dup = makePractice();
  dup.questions[0].options[1].text = dup.questions[0].options[0].text;
  assert.strictEqual(P.validate(dup).ok, false, '重复选项必须被拒绝');
});

group('证据引文必须真实出现在指定段落', () => {
  const fake = makePractice();
  fake.questions[0].evidence.quote = 'this sentence never appears in the article at all';
  const r = P.validate(fake);
  assert.strictEqual(r.ok, false, '不存在的引文必须被拒绝');
  assert.ok(r.errors.some(e => /依据|引文|evidence|quote/i.test(e)), '应指出证据问题，实际 ' + r.errors.join('; '));
});

group('证据段落索引越界', () => {
  const outOfRange = makePractice();
  outOfRange.questions[1].evidence.paragraphIndex = 9;
  const r = P.validate(outOfRange);
  assert.strictEqual(r.ok, false, '越界段落索引必须被拒绝');
});

group('目标词必须是真实出现，不能子串误判', () => {
  // art 不应匹配 heart
  const practice = makePractice();
  practice.targetWords = [{ vocId: 'x', spelling: 'art', surface: 'art', paragraphIndex: 0 }];
  const r = P.validate(practice);
  assert.strictEqual(r.ok, false, 'art 不应被 heart 误判为命中');
  assert.ok(r.errors.some(e => /目标词|target/i.test(e)), '应指出目标词未出现，实际 ' + r.errors.join('; '));
});

group('目标词按词形变化可匹配', () => {
  const practice = makePractice();
  practice.targetWords = [{ vocId: 'v4', spelling: 'advocate', surface: 'Advocates', paragraphIndex: 2 }];
  const r = P.validate(practice);
  assert.strictEqual(r.ok, true, '词形变化应被视为命中，实际 ' + (r.errors || []).join('; '));
});

group('文章长度区间', () => {
  const short = makePractice({ paragraphs: ['Too short to be a CET reading passage at all.'] });
  const r = P.validate(short);
  assert.strictEqual(r.ok, false, '过短文章必须被拒绝');
});

/* ---------------- 判分 ---------------- */

group('判分确定性：同一输入结果一致', () => {
  const p = makePractice();
  const answers = { q1: 'A', q2: 'B', q3: 'C', q4: 'A', q5: 'B' };
  const first = P.grade(p, answers);
  const second = P.grade(p, answers);
  assert.strictEqual(first.correct, second.correct, '重复判分必须一致');
  assert.strictEqual(first.total, 5);
  assert.strictEqual(first.correct, 4, 'q3 答 C 应错，实际对 ' + first.correct);
  const wrong = first.perQuestion.filter(x => !x.ok).map(x => x.id);
  assert.strictEqual(wrong.join(','), 'q3', '只有 q3 应判错，实际 ' + wrong.join(','));
});

group('未作答计为错', () => {
  const p = makePractice();
  const r = P.grade(p, { q1: 'A' });
  assert.strictEqual(r.correct, 1);
  assert.strictEqual(r.total, 5);
  assert.strictEqual(r.perQuestion.filter(x => !x.chosen).length, 4, '4 题未作答');
});

group('冻结答案：改 questions[].answer 不影响已冻结判分', () => {
  const p = makePractice();
  const answers = { q1: 'A', q2: 'B', q3: 'B', q4: 'A', q5: 'B' };
  const before = P.grade(p, answers);
  assert.strictEqual(before.correct, 5, '全对应为 5');
  // 篡改题目上展示用的 answer（冻结副本不动）
  p.questions.forEach(q => { q.answer = 'D'; });
  const after = P.grade(p, answers);
  assert.strictEqual(after.correct, before.correct,
    '判分必须使用冻结答案，不受 questions[].answer 影响（before=' + before.correct + ' after=' + after.correct + '）');
});

group('冻结答案：frozenAnswers 是判分唯一依据', () => {
  const p = makePractice();
  const answers = { q1: 'A', q2: 'B', q3: 'B', q4: 'A', q5: 'B' };
  assert.strictEqual(P.grade(p, answers).correct, 5);
  // 直接把冻结答案全改成 D —— 判分应当跟着变（说明确实在用冻结值）
  p.frozenAnswers = p.frozenAnswers.map(f => ({ id: f.id, answer: 'D' }));
  const after = P.grade(p, answers);
  assert.strictEqual(after.correct, 0,
    '改冻结答案必须改变判分结果，证明判分只用冻结值（实际 ' + after.correct + '）');
});

group('frozenAnswerMap 只认 A-D', () => {
  const map = P.frozenAnswerMap(makePractice());
  const keys = Object.keys(map).sort();
  assert.strictEqual(keys.join(','), 'q1,q2,q3,q4,q5');
  Object.values(map).forEach(v => assert.ok('ABCD'.indexOf(v) >= 0, '冻结答案必须是 A-D，实际 ' + v));
});

/* ---------------- 持久化与隔离 ---------------- */

function memoryStore() {
  const data = Object.create(null);
  return {
    getItem: k => (Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: k => { delete data[k]; },
    _data: data
  };
}

group('保存 / 读取草稿', () => {
  const store = memoryStore();
  const p = makePractice();
  const saved = P.save(p, { store, accountScope: 'profile:test' });
  assert.strictEqual(saved.ok, true, '合法练习应可保存');
  const loaded = P.load(p.id, { store, accountScope: 'profile:test' });
  assert.ok(loaded, '应能读回草稿');
  assert.strictEqual(loaded.id, p.id);
  assert.strictEqual(loaded.questions.length, 5, '草稿必须保留全部题目');
});

group('未通过校验的练习不能保存', () => {
  const store = memoryStore();
  const bad = makePractice();
  bad.questions = bad.questions.slice(0, 3);
  const r = P.save(bad, { store, accountScope: 'profile:test' });
  assert.strictEqual(r.ok, false, '不合规练习绝不能被保存为可提交状态');
});

group('账号隔离：换账号读不到别人的草稿', () => {
  const store = memoryStore();
  // 练习本身必须属于 alice；用 bob 保存会被"账号不一致"挡下（另有测试覆盖）。
  const p = makePractice({ accountScope: 'profile:alice' });
  const saved = P.save(p, { store, accountScope: 'profile:alice' });
  assert.strictEqual(saved.ok, true, 'alice 保存自己的练习应成功：' + (saved.errors || []).join('; '));
  const asBob = P.load(p.id, { store, accountScope: 'profile:bob' });
  assert.strictEqual(asBob, null, 'Bob 不应读到 Alice 的练习');
  const asAlice = P.load(p.id, { store, accountScope: 'profile:alice' });
  assert.ok(asAlice, 'Alice 应能读回自己的练习');
  assert.strictEqual(P.listDrafts({ store, accountScope: 'profile:bob' }).length, 0,
    'Bob 的草稿列表必须为空');
});

group('账号隔离：提交时账号不一致要拒绝', () => {
  const store = memoryStore();
  const p = makePractice();
  const r = P.submit(p, { q1: 'A' }, { store, accountScope: 'profile:bob' });
  assert.strictEqual(r.ok, false, '练习属于 profile:test，用 bob 提交必须被拒绝');
});

group('提交产生成绩记录，重复提交不新增', () => {
  const store = memoryStore();
  const p = makePractice();
  const answers = { q1: 'A', q2: 'B', q3: 'B', q4: 'A', q5: 'B' };
  const first = P.submit(p, answers, { store, accountScope: 'profile:test' });
  assert.strictEqual(first.ok, true, '提交应成功');
  assert.strictEqual(first.result.correct, 5);
  const second = P.submit(p, answers, { store, accountScope: 'profile:test' });
  assert.strictEqual(second.duplicate, true, '重复提交应返回已有记录而不是新增');
  assert.strictEqual(second.attempt.id, first.attempt.id, '重复提交必须复用同一条成绩');
  const attempts = P.listAttempts({ store, accountScope: 'profile:test' });
  assert.strictEqual(attempts.length, 1, '只应有 1 条成绩，实际 ' + attempts.length);
});

group('成绩里带"不换算分数"声明', () => {
  const store = memoryStore();
  const p = makePractice();
  const r = P.submit(p, { q1: 'A' }, { store, accountScope: 'profile:test' });
  assert.ok(/不代表|不换算|掌握率/.test(r.attempt.note || ''), '成绩记录应带口径声明，实际 ' + r.attempt.note);
});

group('未审题的练习不能提交', () => {
  const store = memoryStore();
  const p = makePractice();
  p.generation = { provider: 'stub', model: 'stub', promptVersion: 'v1', reviewed: false };
  const r = P.submit(p, { q1: 'A' }, { store, accountScope: 'profile:test' });
  assert.strictEqual(r.ok, false, '未通过独立审题的练习不能提交');
});

/* ---------------- 生成：取消与迟到 ---------------- */

asyncGroup('生成：AI 返回非法 JSON 时不抛出', async () => {
  P.resetDeps();
  const r = await P.generate({
    candidates: [{ vocId: 'v1', spelling: 'alpha' }],
    levelKey: 'cet4',
    aiCall: async () => ({ content: 'not json at all <<<>>>' })
  });
  assert.strictEqual(r.ok, false, '非法输出必须返回失败而不是抛异常');
  assert.ok(r.reason, '应给出原因');
});

asyncGroup('生成：校验不通过不返回 practice', async () => {
  P.resetDeps();
  const bad = makePractice();
  bad.questions = bad.questions.slice(0, 2);
  const r = await P.generate({
    candidates: [{ vocId: 'v1', spelling: 'alpha' }],
    levelKey: 'cet4',
    source: { rangeKey: 'd7', rangeLabel: '最近 7 天', days: 7, completeness: 'complete',
      syncedAt: '2026-11-18T07:20:00+08:00' },
    aiCall: async () => ({ content: JSON.stringify(bad) })
  });
  assert.strictEqual(r.ok, false, '题目数量不对必须生成失败');
  // 产品会把未通过的 practice 附在结果里供诊断，但 ok=false 意味着它不可提交；
  // 真正的保证是 isSubmittable 必须为 false。
  if (r.practice) {
    assert.strictEqual(P.isSubmittable(r.practice).ok, false,
      '校验失败的 practice 绝不能是可提交状态');
  }
});

asyncGroup('生成：迟到响应不得覆盖新任务', async () => {
  P.resetDeps();
  const slow = makePractice({ id: 'slow-one', title: 'SLOW TASK RESULT' });
  const fast = makePractice({ id: 'fast-two', title: 'FAST TASK RESULT' });
  let generateCall = 0;
  const results = [];
  // 生成与独立审题都走同一个 aiCall，必须按 purpose 区分，
  // 否则审题会收到一份"练习 JSON"并把它当成审题结论。
  // 审题返回结构以 normalizeReview 为准：overall + questions[]，
  // 每题要有 unique / evidenceSupported / bestAnswer（且须与冻结答案一致）。
  const REVIEW_OK = { overall: 'ok', notes: '', questions: [
    { id: 'q1', unique: true, bestAnswer: 'A', evidenceSupported: true, distractorsReasonable: true },
    { id: 'q2', unique: true, bestAnswer: 'B', evidenceSupported: true, distractorsReasonable: true },
    { id: 'q3', unique: true, bestAnswer: 'B', evidenceSupported: true, distractorsReasonable: true },
    { id: 'q4', unique: true, bestAnswer: 'A', evidenceSupported: true, distractorsReasonable: true },
    { id: 'q5', unique: true, bestAnswer: 'B', evidenceSupported: true, distractorsReasonable: true }
  ] };
  const aiCall = async (req) => {
    if (req && req.purpose === 'review') {
      return { content: JSON.stringify(REVIEW_OK) };
    }
    generateCall += 1;
    if (generateCall === 1) {
      await new Promise(r => setTimeout(r, 300));
      return { content: JSON.stringify(slow) };
    }
    return { content: JSON.stringify(fast) };
  };
  const src = { rangeKey: 'd7', rangeLabel: '最近 7 天', days: 7, completeness: 'complete',
    syncedAt: '2026-11-18T07:20:00+08:00' };
  const first = P.generate({ candidates: [{ vocId: 'v1', spelling: 'alpha' }], levelKey: 'cet4', aiCall, source: src });
  const second = P.generate({ candidates: [{ vocId: 'v1', spelling: 'alpha' }], levelKey: 'cet4', aiCall, source: src });
  const [r1, r2] = await Promise.all([first, second]);
  results.push(r1, r2);
  // 第二个必须成功；第一个必须被标记为 superseded/cancelled，不能带出 practice
  assert.strictEqual(r2.ok, true, '后发起的任务应当成功');
  assert.strictEqual(r1.ok, false, '被取代的任务不应返回成功');
  assert.ok(/superseded|cancelled/.test(r1.reason || ''), '被取代应有明确原因，实际 ' + r1.reason);
  // 产品会给生成的练习分配自己的 id（不接受外部传入），因此用标题区分两个任务。
  assert.strictEqual(r2.practice.title, fast.title, '最终结果必须是后一个任务');
  assert.notStrictEqual(r2.practice.title, slow.title, '不能是第一个（已作废）任务的产物');
});

asyncGroup('生成：支持取消', async () => {
  P.resetDeps();
  const REVIEW_OK = { overall: 'ok', notes: '', questions: makePractice().questions.map(function (q) {
    return { id: q.id, unique: true, bestAnswer: q.answer, evidenceSupported: true, distractorsReasonable: true };
  }) };
  const aiCall = async (req) => {
    if (req && req.purpose === 'review') return { content: JSON.stringify(REVIEW_OK) };
    await new Promise(r => setTimeout(r, 500));
    return { content: JSON.stringify(makePractice()) };
  };
  const pending = P.generate({
    candidates: [{ vocId: 'v1', spelling: 'alpha' }], levelKey: 'cet4', aiCall,
    source: { rangeKey: 'd7', rangeLabel: '最近 7 天', days: 7, completeness: 'complete',
      syncedAt: '2026-11-18T07:20:00+08:00' }
  });
  await new Promise(r => setTimeout(r, 60));
  const didCancel = P.cancel();
  const r = await pending;
  assert.strictEqual(didCancel, true, 'cancel() 应能中止在途生成');
  assert.strictEqual(r.ok, false, '取消后不应成功');
  // 取消会把代次前推，因此 reason 可能是 cancelled 或 superseded，两者都表示"这次作废"
  assert.ok(/cancel|superseded/.test(r.reason || ''), '取消应有明确原因，实际 ' + r.reason);
  assert.ok(!r.practice, '取消的生成不能带出 practice');
});

/* ---------------- 提示词：必须是 Section C 仔细阅读 ---------------- */

group('提示词明确是仔细阅读，并且显式禁止段落匹配', () => {
  const prompt = P.buildGenerationPrompt({
    level: { key: 'cet4', label: '四级', targetWords: 320, allowed: [300, 350] },
    words: [{ vocId: 'v1', spelling: 'alpha' }],
    theme: 'campus',
    targetWords: 320
  });
  assert.ok(/仔细阅读|careful reading|Section C/i.test(prompt), '提示词必须指明仔细阅读/Section C');
  assert.ok(/5/.test(prompt), '必须要求 5 道题');
  assert.ok(/A.*B.*C.*D|四个选项|four options/i.test(prompt), '必须要求四个选项');
  /* "段落匹配"只允许出现在**禁止**语境里。
   * 原来的写法里 every(...) 直接 return true，等于没判；这里改成真的看上下文：
   * 每一处"段落匹配"所在的那一行都必须带否定词，否则视为提示词在要求段落匹配。 */
  const NEGATIVE = /不是|禁止|不要|不得|而非|严禁/;
  const lines = prompt.split(/\r?\n/);
  const offenders = lines.filter(function (line) {
    return line.indexOf('段落匹配') >= 0 && !NEGATIVE.test(line);
  });
  assert.strictEqual(offenders.length, 0,
    '提示词里出现了未加否定的"段落匹配"：' + offenders.join(' / ').slice(0, 200));
  assert.ok(prompt.indexOf('不是 Section B 段落匹配') >= 0, '提示词必须明确"不是 Section B 段落匹配"');
  // 关键：不能要求出十道段落匹配题（禁止语境里的"禁止出十道段落匹配题"是允许的）
  assert.ok(!/(请出|生成|给出)\s*十道/.test(prompt), '不得要求生成十道题');
  assert.ok(prompt.indexOf('禁止') >= 0, '应以禁止形式列出旧格式');
});

group('两档难度不只是篇幅差异', () => {
  const mk = (level) => P.buildGenerationPrompt({
    level: level, words: [{ vocId: 'v1', spelling: 'alpha' }], theme: 'campus',
    targetWords: level.targetWords
  });
  const cet4 = mk({ key: 'cet4', label: '四级', targetWords: 320, allowed: [300, 350] });
  const cet6 = mk({ key: 'cet6', label: '六级', targetWords: 425, allowed: [400, 450] });
  assert.notStrictEqual(cet4, cet6, '两档提示词不能完全相同');
  assert.ok(/425|450|400/.test(cet6), '六级提示词应体现 400-450 词区间');
  assert.ok(/320|300|350/.test(cet4), '四级提示词应体现 300-350 词区间');
});

/* ---------------- 工具函数 ---------------- */

group('countEnglishWords', () => {
  assert.strictEqual(P.countEnglishWords('one two three'), 3);
  assert.strictEqual(P.countEnglishWords(''), 0);
  assert.strictEqual(P.countEnglishWords('hello, world!'), 2);
});

group('tokenize / containsTokens 不做子串误判', () => {
  // containsTokens 接的是词元数组，不是字符串
  assert.strictEqual(P.containsTokens(P.tokenize('she has a heart of gold'), P.tokenize('art')), false,
    'art 不应匹配 heart');
  assert.strictEqual(P.containsTokens(P.tokenize('modern art is fine'), P.tokenize('art')), true,
    '独立单词应匹配');
  // 多词短语必须连续出现
  assert.strictEqual(P.containsTokens(P.tokenize('the quick brown fox'), P.tokenize('quick brown')), true);
  assert.strictEqual(P.containsTokens(P.tokenize('the quick red brown fox'), P.tokenize('quick brown')), false,
    '不连续的词序列不算命中');
});

group('extractJson 处理包裹文本', () => {
  const wrapped = P.extractJson('here you go:\n```json\n{"a":1}\n```\ndone');
  assert.strictEqual(wrapped.ok, true, '应能从包裹文本里取出 JSON');
  assert.strictEqual(wrapped.value.a, 1);
  assert.strictEqual(P.extractJson('no json here').ok, false, '无 JSON 应失败');
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
  console.log('reading-practice: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) { failures.forEach(f => console.log('  ! ' + f)); process.exit(1); }
  console.log('READING_PRACTICE_PASS');
})();
