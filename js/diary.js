/* ============================================================
   记忆手账 · Memory Diary（借鉴 Love Diary 状态栏）
   用每日背词数据当"好感度"：数量分等级、达标日飘爱心
   数据来源：ChartManager.getRecords()
   ============================================================ */
'use strict';
var DiaryChart = (function () {
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  // 北京时区日期 -> 'YYYY-MM-DD'
  function toDay(d) {
    const b = new Date(d.getTime() + 8 * 3600 * 1000);
    return b.toISOString().slice(0, 10);
  }
  // 安全解析：缺失/非法日期返回 null，不会抛 RangeError
  function safeDay(value) {
    if (value == null || value === '') return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return toDay(d);
  }
  function fmtCN(dateStr) {
    const p = dateStr.split('-');
    if (p.length !== 3) return dateStr;
    const dt = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
    return p[1] + '月' + p[2] + '日 · 周' + WEEK[dt.getUTCDay()];
  }

  function shiftDay(dateStr, delta) {
    const p = dateStr.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + delta)).toISOString().slice(0, 10);
  }

  // 最近 N 天日期（含今天）
  function range(n) {
    const out = [];
    const today = toDay(new Date());
    for (let i = n - 1; i >= 0; i--) {
      out.push(shiftDay(today, -i));
    }
    return out;
  }

  function aggregate(records, days) {
    const dates = range(days);
    const map = {};
    dates.forEach(d => { map[d] = { total: 0, fresh: 0, review: 0, correct: 0 }; });
    (records || []).forEach(r => {
      const last = safeDay(r.last_study_date);
      const add = safeDay(r.add_date);
      if (last && map[last]) {
        map[last].total++;
        if (r.last_response === 'FAMILIAR' || r.last_response === 'WELL_FAMILIAR') map[last].correct++;
      }
      if (add && map[add]) map[add].fresh++;
      if (last && add && map[last] && add !== last && r.study_count > 1) map[last].review++;
    });
    return dates.map(d => ({ date: d, ...map[d] }));
  }

  function level(total) {
    if (total <= 0) return { key: 'empty', label: '空白' };
    if (total < 10) return { key: 'slack', label: '摸鱼' };
    if (total < 30) return { key: 'daily', label: '日常' };
    if (total < 60) return { key: 'focus', label: '努力' };
    return { key: 'grind', label: '爆肝' };
  }
  const cap = 60;
  function pct(total) { return Math.min(100, Math.round(total / cap * 100)); }

  function heartChars() { return ['♥', '♡', '❤', '💗']; }
  function spawnHearts(cardEl, state) {
    const t = setInterval(function () {
      if (!cardEl || !document.contains(cardEl)) { clearInterval(t); return; }
      const h = document.createElement('span');
      h.className = 'md-heart';
      h.textContent = heartChars()[Math.floor(Math.random() * heartChars().length)];
      h.style.left = (8 + Math.random() * 82) + '%';
      h.style.fontSize = (9 + Math.random() * 6) + 'px';
      cardEl.appendChild(h);
      setTimeout(function () { h.remove(); }, 2600);
    }, 700);
    state.heartTimers.push(t);
  }
  function clearHearts(state) {
    state.heartTimers.forEach(clearInterval);
    state.heartTimers = [];
  }

  function stampHtml(s) { return '<span class="md-stamp ' + s.key + '">' + s.label + '</span>'; }

  function buildList(state) {
    const cards = state.dayData.map(function (d, i) {
      const s = level(d.total);
      const empty = s.key === 'empty';
      return '<div class="md-day-card' + (empty ? ' empty' : '') + '" data-i="' + i + '">'
        + '<div class="md-day-date"><div class="md-day-d">' + (+d.date.slice(8)) + '</div><div class="md-day-w">' + fmtCN(d.date).slice(-2) + '</div></div>'
        + '<div class="md-day-main">'
        +   '<div class="md-day-num">' + d.total + ' <small>词</small></div>'
        +   '<div class="md-day-meta">新 ' + d.fresh + ' · 复 ' + d.review + ' · 对 ' + d.correct + '</div>'
        +   '<div class="md-track"><div class="md-fill" style="width:' + pct(d.total) + '%"></div></div>'
        + '</div>'
        + stampHtml(s)
        + '<span class="md-arrow">›</span>'
        + '</div>';
    }).join('');
    return '<div class="mydiary-head"><span class="md-title"><img class="md-title-gif" src="img/gifs/rana-sleep.gif" alt=""> 记忆手账 · MEMORY DIARY</span><span class="md-tape"></span></div>'
      + '<div class="mydiary-ticker"><div class="mydiary-ticker-scroll">'
      +   '<span class="mydiary-ticker-item">— tap a day to open — 点击日期查看详情 —</span>'
      +   '<span class="mydiary-ticker-item">— tap a day to open — 点击日期查看详情 —</span>'
      + '</div></div>'
      + '<div class="md-ruled"><div class="md-cards">' + cards + '</div></div>';
  }

  function buildDetail(state, idx) {
    const d = state.dayData[idx];
    if (!d) return buildList(state);
    const s = level(d.total);
    const rate = d.total > 0 ? Math.round(d.correct / d.total * 100) : 0;
    const dots = state.dayData.map(function (x, i) {
      if (level(x.total).key === 'empty') return '';
      return '<span class="md-dot' + (i === idx ? ' active' : '') + '" data-i="' + i + '"></span>';
    }).join('');
    const note = d.total > 0
      ? '这一天背了 <b>' + d.total + '</b> 个单词：新学 ' + d.fresh + '、复习 ' + d.review + '，回答正确 ' + d.correct + ' 个（正确率 ' + rate + '%）。'
      + (s.key === 'grind' ? ' 状态「爆肝」—— 满屏爱心为努力喝彩！' : '')
      : '这一天没有留下学习记录，休息也是计划的一部分。';
    return '<div class="md-detail-top">'
      + '<button class="md-back" data-back="1">← 返回</button>'
      + '<div class="md-dot-nav">' + dots + '</div>'
      + '</div>'
      + '<div class="md-hero">'
      +   '<div class="md-hero-tape"></div>'
      +   '<div><div class="md-hero-date">' + fmtCN(d.date) + '</div>'
      +   '<div class="md-hero-sub">' + s.label + ' · ' + d.total + ' 词</div></div>'
      + '</div>'
      + '<div class="md-stats">'
      +   statRow('总词数', pct(d.total), d.total, '#d4576b')
      +   statRow('新学', d.total ? Math.round(d.fresh / d.total * 100) : 0, d.fresh, '#6bb5d6')
      +   statRow('复习', d.total ? Math.round(d.review / d.total * 100) : 0, d.review, '#d4a843')
      +   statRow('正确率', rate, rate + '%', '#a8dbc5')
      + '</div>'
      + '<div class="md-note">' + note + '</div>';
  }

  function statRow(label, p, val, color) {
    return '<div class="md-stat-row">'
      + '<span class="md-stat-lbl">' + label + '</span>'
      + '<div class="md-stat-track"><div class="md-stat-fill" style="width:' + p + '%;background:linear-gradient(90deg,' + color + '88,' + color + ')"></div></div>'
      + '<span class="md-stat-val">' + val + '</span>'
      + '</div>';
  }

  function refresh(state) {
    if (!state.root) return;
    state.root.classList.toggle('is-detail', state.curIdx >= 0);
    const list = state.root.querySelector('.mydiary-list');
    const detail = state.root.querySelector('.mydiary-detail');
    if (list) list.innerHTML = state.curIdx < 0 ? buildList(state) : list.innerHTML;
    if (detail) detail.innerHTML = state.curIdx >= 0 ? buildDetail(state, state.curIdx) : detail.innerHTML;
    clearHearts(state);
    // 给"爆肝"日卡片飘爱心
    state.root.querySelectorAll('.md-day-card').forEach(function (c) {
      const i = +c.dataset.i;
      if (level(state.dayData[i].total).key === 'grind') spawnHearts(c, state);
    });
    if (state.curIdx >= 0 && level(state.dayData[state.curIdx].total).key === 'grind') {
      const hero = state.root.querySelector('.md-hero');
      if (hero) spawnHearts(hero, state);
    }
  }

  function bind(state) {
    state.root.addEventListener('click', function (e) {
      const card = e.target.closest('.md-day-card');
      if (card) { state.curIdx = +card.dataset.i; refresh(state); return; }
      const back = e.target.closest('[data-back]');
      if (back) { state.curIdx = -1; refresh(state); return; }
      const dot = e.target.closest('.md-dot');
      if (dot) { state.curIdx = +dot.dataset.i; refresh(state); }
    });
  }

  function render(containerId, options) {
    const container = document.getElementById(containerId);
    if (!container) return null;
    const days = (options && options.days) || 30;
    const records = (typeof ChartManager !== 'undefined' && ChartManager.getRecords) ? ChartManager.getRecords() : null;
    const state = {
      root: null,
      dayData: aggregate(records, days),
      curIdx: -1,
      heartTimers: []
    };
    container.innerHTML = '<div class="mydiary" id="' + containerId + '-diary">'
      + '<div class="mydiary-stage">'
      +   '<div class="mydiary-list"></div>'
      +   '<div class="mydiary-detail"></div>'
      + '</div>'
      + '</div>';
    state.root = container.querySelector('.mydiary');
    bind(state);
    refresh(state);
    return {
      dispose: function () { clearHearts(state); container.innerHTML = ''; state.root = null; },
      resize: function () {}
    };
  }

  return { render: render };
})();
