// 北京时间换算记忆化的行为回归：验证缓存不改变任何换算结果。
// 只断言实际返回值，不检查源码字符串。
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/dashboard-core.js'), 'utf8');
const escaper = {
  style: {},
  set textContent(value) {
    this.innerHTML = String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  },
  get textContent() { return this.innerHTML || ''; },
  innerHTML: ''
};
// 沙箱内仪表化 Map：只替换测试上下文的全局构造器，生产源码零改动，
// 用于观测缓存真实写入量、峰值尺寸与清空次数（F7 需要证明上限路径确实执行）。
const mapStats = { sets: 0, gets: 0, clears: 0, maxSize: 0 };
const context = vm.createContext({
  window: {}, document: { getElementById: () => null, createElement: () => Object.create(escaper) },
  localStorage: { getItem: () => null, setItem: () => {} }, console,
  Map: class extends Map {
    get(key) { mapStats.gets++; return super.get(key); }
    set(key, value) {
      mapStats.sets++;
      const result = super.set(key, value);
      if (this.size > mapStats.maxSize) mapStats.maxSize = this.size;
      return result;
    }
    clear() { mapStats.clears++; return super.clear(); }
  }
});
// MemoDashboard 由 const 声明，只存在于脚本词法环境；追加一句导出到全局以便断言。
vm.runInContext(source + '\n;globalThis.__MemoDashboard = MemoDashboard;', context);
const MemoDashboard = context.__MemoDashboard;
assert.ok(MemoDashboard && typeof MemoDashboard.toBeijingDate === 'function', 'MemoDashboard.toBeijingDate 必须可用');
const convert = MemoDashboard.toBeijingDate;

function reference(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// 1) 空值与非法值维持原语义，且不会被缓存污染成有效日期
for (const bad of ['', null, undefined, 0, 'not-a-date']) {
  assert.strictEqual(convert(bad), reference(bad), '空/非法输入语义必须一致: ' + String(bad));
  assert.strictEqual(convert(bad), reference(bad), '重复调用结果必须稳定: ' + String(bad));
}

// 2) 常见日期形状与参考实现逐项一致（含跨 UTC/北京午夜与月末）
const samples = [
  '2026-08-29', '2026-08-29T00:00:00Z', '2026-08-29T23:59:59Z', '2026-08-30T16:00:00Z',
  '2023-03-01T00:00:00.000Z', '2024-02-29T12:00:00Z', '2026-01-01T00:00:00+08:00',
  '2026-12-31T23:59:59+08:00', 1760217600000, 1760217600, 20260829
];
for (const value of samples) {
  assert.strictEqual(convert(value), reference(value), '换算结果必须与参考实现一致: ' + String(value));
}

// 2b) 北京时间午夜边界：15:59:59Z 仍属前一天，16:00:00Z 进入次日
assert.strictEqual(convert('2026-08-30T15:59:59Z'), '2026-08-30', '午夜前一秒必须仍属当日');
assert.strictEqual(convert('2026-08-30T16:00:00Z'), '2026-08-31', 'UTC 16:00 必须进入北京次日');

// 2c) 秒级与毫秒级时间戳
for (const stamp of [0, 1, 1000000000, 1760217600, 1760217600000, 1893456000000]) {
  assert.strictEqual(convert(stamp), reference(stamp), '时间戳换算必须一致: ' + stamp);
}

// 2d) 紧凑日期与畸形输入只保证“与参考实现一致”，不额外猜测语义
for (const value of ['20260829', '2026-08-29T99:99:99Z', 'null', 'undefined', '0', '2026-13-45']) {
  assert.strictEqual(convert(value), reference(value), '紧凑/畸形输入语义必须一致: ' + String(value));
  assert.strictEqual(convert(value), reference(value), '紧凑/畸形输入重复调用必须稳定: ' + String(value));
}

// 2e) Date 对象：可变对象绝不入缓存，必须每次实时换算（F6 回归）。
const dateObject = new Date(Date.UTC(2026, 7, 29, 17, 0, 0));
assert.strictEqual(convert(dateObject), reference(dateObject), 'Date 对象换算必须一致');
assert.strictEqual(convert(dateObject), reference(dateObject), '未修改时重复调用必须稳定');
// F6：同一对象 setTime 跨日后，不得再返回旧日期。
dateObject.setTime(Date.parse('2026-09-01T17:00:00Z'));
assert.strictEqual(convert(dateObject), reference(dateObject), 'setTime 跨日后必须按新值换算');
assert.strictEqual(convert(dateObject), '2026-09-02', 'setTime 到 2026-09-01T17:00:00Z 必须得到北京 2026-09-02');
// F6：变为 Invalid Date 后必须返回 null，而不是残留旧结果。
dateObject.setTime(NaN);
assert.strictEqual(convert(dateObject), null, 'Invalid Date 必须返回 null');
assert.strictEqual(reference(dateObject), null, '参考实现对 Invalid Date 同样返回 null');
// F6：两个同值 Date 对象互不影响（对象一律实时换算，不存在跨对象污染）。
const dateA = new Date(Date.UTC(2026, 7, 29, 17, 0, 0));
const dateB = new Date(Date.UTC(2026, 7, 29, 17, 0, 0));
assert.strictEqual(convert(dateA), reference(dateA));
dateA.setTime(Date.parse('2026-10-01T17:00:00Z'));
assert.strictEqual(convert(dateB), reference(dateB), '另一对象的值不得被前一对象的修改影响');
assert.strictEqual(convert(dateB), '2026-08-30');

// 3) 同一值反复调用结果稳定（缓存命中与未命中返回一致）
const repeated = '2026-08-29T16:00:00Z';
const first = convert(repeated);
for (let i = 0; i < 5; i++) assert.strictEqual(convert(repeated), first, '重复调用必须返回同一值');
assert.strictEqual(first, reference(repeated));

// 4) 大量取值后仍与参考实现一致（覆盖缓存增长/淘汰路径）
for (let day = 0; day < 900; day++) {
  const value = new Date(Date.UTC(2024, 0, 1 + day, 17, 30, 0)).toISOString();
  assert.strictEqual(convert(value), reference(value), '批量换算必须与参考实现一致: ' + value);
}

// 4b) 上限：200500 个**有效且唯一**的日期输入真正填满缓存（F7 回归）。
//     旧实现用 '2020-01-01T00:00:00Z-<i>' 之类的非法串，全部返回 null，缓存从未被
//     填充，上限与清空路径形同虚设；这里改用唯一 ISO 时间戳逐项与参考比较。
const LIMIT_PLUS = 200500;
const mapBefore4b = { ...mapStats };
let firstBatchInput = '';
for (let i = 0; i < LIMIT_PLUS; i++) {
  const value = new Date(Date.UTC(2020, 0, 1) + i).toISOString();
  if (i === 0) firstBatchInput = value;
  assert.strictEqual(convert(value), reference(value), '填满上限期间换算必须逐项正确: ' + value);
}
const mapAfter4b = { ...mapStats };
const setsDuring4b = mapAfter4b.sets - mapBefore4b.sets;
const clearsDuring4b = mapAfter4b.clears - mapBefore4b.clears;
assert.strictEqual(setsDuring4b, LIMIT_PLUS, '每个有效输入都必须真实写入缓存一次');
assert.ok(clearsDuring4b >= 1, '达到上限后必须实际触发清空路径');
assert.ok(mapAfter4b.maxSize >= 200000, '缓存峰值必须达到上限（观测到 ' + mapAfter4b.maxSize + '）');
// 清空后：最早写入的键已被淘汰，重新查询必须重新计算且结果一致。
assert.strictEqual(convert(firstBatchInput), reference(firstBatchInput),
  '淘汰后的旧值重查必须与参考一致');
// 上限之后对象输入仍然实时换算（与 F6 一致）。
const postLimitDate = new Date(Date.UTC(2026, 7, 29, 17, 0, 0));
assert.strictEqual(convert(postLimitDate), '2026-08-30');
postLimitDate.setTime(Date.parse('2026-09-01T17:00:00Z'));
assert.strictEqual(convert(postLimitDate), '2026-09-02', '上限触发后对象修改仍必须按新值换算');

// 4c) 缓存只以输入值为键：不同取值互不污染（含形似但不同的字符串）
assert.strictEqual(convert('2026-08-29'), reference('2026-08-29'));
assert.strictEqual(convert('2026-08-29 '), reference('2026-08-29 '));
assert.strictEqual(convert(' 2026-08-29'), reference(' 2026-08-29'));
assert.notStrictEqual(convert('2026-08-29T15:59:59Z'), convert('2026-08-29T16:00:00Z'),
  '相邻日期必须得到不同结果');

// 5) 其它共享契约未被改动
assert.strictEqual(typeof MemoDashboard.todayBeijing, 'function');
assert.strictEqual(typeof MemoDashboard.shiftDate, 'function');
assert.strictEqual(MemoDashboard.shiftDate('2026-03-01', -1), '2026-02-28', 'shiftDate 跨月必须正确');
assert.deepStrictEqual(MemoDashboard.dateRange(3).length, 3, 'dateRange 长度必须正确');
assert.strictEqual(MemoDashboard.escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;', 'escapeHtml 必须保持转义');
assert.deepStrictEqual(Object.keys(MemoDashboard.layoutTileCount).sort(),
  ['grid4', 'single', 'split2', 'split3'], '布局契约必须保持');

console.log('DASHBOARD_DATE_CACHE_REGRESSION_PASS: 空值/非法值/时间戳/批量与参考实现逐项一致；' +
  'Date 对象实时换算（setTime 跨日与 Invalid 均正确）；上限路径经有效唯一输入真实触发 ' +
  '(sets=' + mapAfter4b.sets + ', maxSize=' + mapAfter4b.maxSize + ', clears=' + mapAfter4b.clears + ')；共享契约保留');
