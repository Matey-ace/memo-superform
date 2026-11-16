// 汇总 frontend-b-baseline.js 的输出为可读表格（纯分析，不测量）。
// 用法: node tests/perf/summarize-frontend.js <json> [json2 ...]
const fs = require('fs');
const path = require('path');

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node summarize-frontend.js <json> [...]'); process.exit(1); }

function fmt(v, unit) {
  if (v === null || v === undefined || Number.isNaN(v)) return 'n/a';
  return (Math.round(v * 10) / 10) + (unit || '');
}
function med(rows, key) {
  const v = rows.map(r => r[key]).filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return { n: 0 };
  const pick = p => v[Math.min(v.length - 1, Math.max(0, Math.round(p * (v.length - 1))))];
  return { n: v.length, min: v[0], med: pick(0.5), max: v[v.length - 1], all: v };
}
function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

for (const file of files) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  console.log('');
  console.log('=== ' + path.basename(file) + '  variant=' + report.variant + '  rounds=' + report.environment.rounds + '  browser=' + (report.environment.browserVersion || '?'));
  console.log('=== node ' + report.environment.node + ' | ' + report.environment.platform + ' | viewport ' + report.environment.viewport.width + 'x' + report.environment.viewport.height);
  console.log('');
  console.log(pad('config', 20) + pad('metric', 18) + pad('n', 4) + pad('min', 9) + pad('median', 9) + pad('max', 9) + 'raw samples');
  console.log('-'.repeat(120));
  for (const config of report.configs) {
    for (const theme of Object.keys(config.summary || {})) {
      const rows = config.samples.filter(s => s.theme === theme);
      const key = theme + '/' + config.count;
      for (const metric of ['fcp', 'domContentLoaded', 'recordsReady', 'chartsReady', 'lcp']) {
        const m = med(rows, metric);
        if (!m.n) { console.log(pad(key, 20) + pad(metric, 18) + '0'); continue; }
        console.log(pad(key, 20) + pad(metric, 18) + pad(m.n, 4) + pad(fmt(m.min), 9) + pad(fmt(m.med), 9) + pad(fmt(m.max), 9) +
          m.all.map(x => Math.round(x)).join(','));
      }
      const bytes = med(rows, 'staticDecoded');
      console.log(pad(key, 20) + pad('staticKB', 18) + pad(bytes.n, 4) + pad(Math.round(bytes.min / 1024), 9) + pad(Math.round(bytes.med / 1024), 9) + pad(Math.round(bytes.max / 1024), 9));
      const api = med(rows, 'apiDecoded');
      console.log(pad(key, 20) + pad('apiKB', 18) + pad(api.n, 4) + pad(Math.round(api.min / 1024), 9) + pad(Math.round(api.med / 1024), 9) + pad(Math.round(api.max / 1024), 9));
      const lt = med(rows, 'longestTask');
      console.log(pad(key, 20) + pad('longestTaskMs', 18) + pad(lt.n, 4) + pad(fmt(lt.min), 9) + pad(fmt(lt.med), 9) + pad(fmt(lt.max), 9));
      console.log('-'.repeat(120));
    }
  }
  // 资源分组
  for (const config of report.configs) {
    for (const theme of Object.keys(config.groups || {})) {
      const g = config.groups[theme];
      const parts = Object.keys(g).map(k => k + '=' + Math.round(g[k].decoded / 1024) + 'KB/' + g[k].count).join('  ');
      console.log('groups ' + theme + '/' + config.count + ': ' + parts);
    }
  }
  // 首个错误/失败请求
  const problems = [];
  for (const config of report.configs) {
    for (const s of config.samples) {
      if ((s.errors || []).length) problems.push(s.config + ' errors=' + JSON.stringify(s.errors));
      const bad = (s.failedRequests || []).filter(x => !/\/proxy\/memo\//.test(x) && !/index\.html net::ERR_ABORTED/.test(x));
      if (bad.length) problems.push(s.config + ' failed=' + JSON.stringify(bad));
    }
  }
  console.log('');
  console.log('problems: ' + (problems.length ? '\n  ' + problems.slice(0, 12).join('\n  ') : 'none'));
}
