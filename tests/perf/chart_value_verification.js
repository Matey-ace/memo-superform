// 图表数值正确性核对：把实际渲染出的 ECharts 数据，与用未缓存换算独立算出的
// 参考值逐项对比。用于证明日期缓存只改变耗时、不改变统计结果。
// 使用：node tests/perf/chart_value_verification.js --count 20000
//
// 判定规则（与 charts.js 真实业务逻辑一致，参考值在 Node 侧独立计算）：
//   热力图：渲染当月每一天（含 0），逐点等于 last_study_date 落日计数，
//           数据长度必须等于当月天数（拒绝空数据与截断）。
//   趋势图：新学 = add_date 落日计数；复习 = last 落日且 study_count>1 且
//           add_date !== last_study_date（北京日期）；总计 = last 落日计数。
//           三条序列都必须存在、长度等于天数、逐日逐序列一致。
// 任何差异、缺失或未完成的比较都会以非零退出码结束，并保存具体失败证据。
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '../..');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function arg(name, fallback) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const COUNT = parseInt(arg('count', '20000'), 10);
const SEED = parseInt(arg('seed', '20261008'), 10);
const OUT = arg('out', path.join(ROOT, '_verification/workbuddy-acceptance', 'chart-value-verification.json'));

// 未缓存的北京时间换算：与 MemoDashboard.toBeijingDate 语义相同，但独立实现。
function refDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function beijingToday() {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function dateRange(days, today) {
  const base = today || beijingToday();
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const t = new Date(Date.UTC(
      +base.slice(0, 4), +base.slice(5, 7) - 1, +base.slice(8, 10) - i)).toISOString().slice(0, 10);
    out.push(t);
  }
  return out;
}

function daysInMonth(monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

// 依据 charts.js aggregateDailyData 的真实业务规则独立计算参考值。
function buildReference(records) {
  const lastCount = {}, addCount = {}, reviewCount = {};
  for (const r of records || []) {
    const last = refDate(r.last_study_date);
    const add = refDate(r.add_date);
    const studyCount = Number(r.study_count) || 0;
    if (last) lastCount[last] = (lastCount[last] || 0) + 1;
    if (add) addCount[add] = (addCount[add] || 0) + 1;
    if (last && studyCount > 1 && add && add !== last) reviewCount[last] = (reviewCount[last] || 0) + 1;
  }
  return { lastCount, addCount, reviewCount };
}

function judgeHeatmap(data, refLast, expectedMonth) {
  const failures = [];
  if (!Array.isArray(data) || data.length === 0) {
    failures.push({ check: 'heatmap-empty', detail: '热力图渲染数据为空' });
    return failures;
  }
  const month = String(data[0][0]).slice(0, 7);
  if (month !== expectedMonth) {
    failures.push({ check: 'heatmap-month', detail: `渲染月份 ${month} 与预期 ${expectedMonth} 不符` });
  }
  const expectedDays = daysInMonth(month);
  if (data.length !== expectedDays) {
    failures.push({ check: 'heatmap-length', detail: `热力图数据 ${data.length} 天 != 当月 ${expectedDays} 天（疑似空数据或截断）` });
  }
  const seen = new Set(data.map(d => String(d[0])));
  if (seen.size !== data.length) {
    failures.push({ check: 'heatmap-duplicate', detail: `渲染日期存在重复：${data.length} 项只有 ${seen.size} 个唯一日期` });
  }
  let mismatchCount = 0;
  const mismatches = [];
  let renderedSum = 0;
  for (const [day, count] of data) {
    const want = refLast[String(day)] || 0;
    renderedSum += Number(count) || 0;
    if (want !== Number(count)) {
      mismatchCount++;
      if (mismatches.length < 10) mismatches.push({ day, rendered: count, expected: want });
    }
  }
  if (mismatchCount) failures.push({ check: 'heatmap-mismatch', count: mismatchCount, samples: mismatches });
  const missing = [];
  for (let d = 1; d <= expectedDays; d++) {
    const day = month + '-' + String(d).padStart(2, '0');
    if ((refLast[day] || 0) > 0 && !seen.has(day)) missing.push({ day, expected: refLast[day] });
  }
  if (missing.length) failures.push({ check: 'heatmap-missing', count: missing.length, samples: missing.slice(0, 10) });
  const expectedSum = Object.keys(refLast)
    .filter(day => day.slice(0, 7) === month)
    .reduce((a, day) => a + refLast[day], 0);
  if (renderedSum !== expectedSum) {
    failures.push({ check: 'heatmap-sum', detail: `当月渲染总数 ${renderedSum} != 参考总数 ${expectedSum}` });
  }
  return failures;
}

const TREND_SERIES = ['新学', '复习', '总计'];

function judgeTrend(series, ref, range) {
  const failures = [];
  const names = (series || []).map(s => s.name);
  const missing = TREND_SERIES.filter(n => !names.includes(n));
  if (missing.length) {
    failures.push({ check: 'trend-series', detail: '趋势图缺少序列：' + missing.join('、'), rendered: names });
    return failures;
  }
  const expectedFor = {
    '新学': day => ref.addCount[day] || 0,
    '复习': day => ref.reviewCount[day] || 0,
    '总计': day => ref.lastCount[day] || 0,
  };
  for (const s of series) {
    if (!TREND_SERIES.includes(s.name)) continue;
    const data = (s.data || []).map(Number);
    if (data.length !== range.length) {
      failures.push({ check: 'trend-length', series: s.name, detail: `序列长度 ${data.length} != ${range.length} 天（疑似截断）` });
    }
    let mismatchCount = 0;
    const mismatches = [];
    for (let i = 0; i < range.length && i < data.length; i++) {
      const want = expectedFor[s.name](range[i]);
      if (want !== data[i]) {
        mismatchCount++;
        if (mismatches.length < 10) mismatches.push({ day: range[i], rendered: data[i], expected: want });
      }
    }
    if (mismatchCount) failures.push({ check: 'trend-mismatch', series: s.name, count: mismatchCount, samples: mismatches });
  }
  return failures;
}

module.exports = { refDate, beijingToday, dateRange, daysInMonth, buildReference, judgeHeatmap, judgeTrend, TREND_SERIES };

async function main() {
  const child = spawn('python', [path.join(__dirname, 'bench_server.py'), '--count', String(COUNT), '--seed', String(SEED)],
    { cwd: ROOT, windowsHide: true });
  let browser = null;
  try {
    const meta = await new Promise((resolve, reject) => {
      let text = '';
      let settled = false;
      const t = setTimeout(() => { if (!settled) { settled = true; reject(new Error('server timeout')); } }, 180000);
      child.on('exit', code => { if (!settled) { settled = true; clearTimeout(t); reject(new Error('bench server 提前退出：' + code)); } });
      child.on('error', err => { if (!settled) { settled = true; clearTimeout(t); reject(err); } });
      child.stdout.on('data', c => {
        text += c;
        const m = text.match(/BENCH_URL=(\S+)/); const s = text.match(/BENCH_SEEDED=(\d+)/);
        if (m && !settled) { settled = true; clearTimeout(t); resolve({ url: m[1], seeded: s ? +s[1] : 0 }); }
      });
      child.stderr.on('data', c => process.stderr.write('[server] ' + c));
    });
    let records = null;
    for (let i = 0; i < 8; i++) {
      try {
        const r = await fetch(meta.url + '/api/study-records'); const j = await r.json();
        if (r.ok && j.count === meta.seeded && Array.isArray(j.records) && j.records.length === meta.seeded) {
          records = j.records;
          break;
        }
      } catch (e) { /* retry */ }
      await new Promise(r => setTimeout(r, 800));
    }
    if (!records) throw new Error('学习记录就绪检查失败：数量与 BENCH_SEEDED 不符或接口不可用');

    const expectedMonth = beijingToday().slice(0, 7);
    const ref = buildReference(records);
    const range = dateRange(30);

    browser = await chromium.launch({ headless: true, executablePath: EDGE });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.route('**://*.maimemo.com/**', r => r.abort());
    await page.route('**://*.github.com/**', r => r.abort());
    await page.route('**/memo-**', r => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body>offline</body></html>' }));
    await page.route('**/api/app/update-status*', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ current_version: '0.89', update_available: false, can_download: false, download: { state: 'idle' } }) }));
    await page.route('**/api/study-sync', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, status: 'idle', active: false }) }));
    await page.route('**/api/study-sync/status', r => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ status: 'idle', active: false }) }));
    await page.route('**/proxy/**', r => r.abort());
    await page.goto(meta.url + '/index.html', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => {
      try { return typeof ChartManager !== 'undefined' && (ChartManager.getRecords() || []).length === n; } catch (e) { return false; }
    }, COUNT, { timeout: 120000 });
    await page.waitForTimeout(600);

    // 热力图：只取回渲染数据，判定全部在 Node 侧用独立参考完成。
    await page.evaluate(() => { ChartManager.render(0, 'heatmap', {}); });
    await page.waitForTimeout(200);
    const heatData = await page.evaluate(() => {
      const inst = echarts.getInstanceByDom(document.getElementById('chart-0'));
      return (inst.getOption().series[0].data || []).map(d => [d.value[0], d.value[1]]);
    });
    const heatFailures = judgeHeatmap(heatData, ref.lastCount, expectedMonth);

    // 趋势图 30 天：取回全部序列，逐日逐序列与参考对比。
    await page.evaluate(() => { ChartManager.render(0, 'trend', { days: 30 }); });
    await page.waitForTimeout(200);
    const trendSeries = await page.evaluate(() => {
      const inst = echarts.getInstanceByDom(document.getElementById('chart-0'));
      return (inst.getOption().series || []).map(s => ({ name: s.name, data: s.data }));
    });
    const trendFailures = judgeTrend(trendSeries, ref, range);

    const heat = {
      chart: 'heatmap', month: expectedMonth, dataLength: heatData.length,
      expectedDays: daysInMonth(expectedMonth), compared: heatData.length,
    };
    const trend = {
      chart: 'trend30', seriesNames: trendSeries.map(s => s.name),
      compared: range.length, expectedDays: range.length,
      perSeriesLength: trendSeries.map(s => ({ name: s.name, length: (s.data || []).length })),
    };
    const failures = heatFailures.concat(trendFailures);
    const report = {
      count: COUNT, seed: SEED, generatedAt: new Date().toISOString(),
      passed: failures.length === 0, failures, checks: [heat, trend],
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log('CHART_VALUE_DONE ' + OUT);
    console.log(JSON.stringify(report.checks, null, 1));
    if (failures.length) {
      console.error('CHART_VALUE_FAILED: ' + failures.length + ' 项不一致');
      for (const f of failures) console.error('  - ' + JSON.stringify(f));
      process.exitCode = 1;
    } else {
      console.log('CHART_VALUE_PASS: 热力图与趋势图逐点一致，长度与序列完整');
    }
  } catch (e) {
    console.error(e);
    try {
      fs.writeFileSync(OUT, JSON.stringify({
        count: COUNT, seed: SEED, generatedAt: new Date().toISOString(),
        passed: false, fatal: String((e && e.stack) || e),
      }, null, 2));
    } catch (_) { /* 证据写不出时至少保留退出码 */ }
    process.exitCode = 1;
  } finally {
    if (browser) { try { await browser.close(); } catch (_) { /* 尽力释放 */ } }
    await new Promise(resolve => {
      const t = setTimeout(() => { try { child.kill(); } catch (_) {} resolve(); }, 4000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      try { child.stdin.end('exit\n'); } catch (e) { try { child.kill(); } catch (_) {} resolve(); }
    });
  }
}

if (require.main === module) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
}
