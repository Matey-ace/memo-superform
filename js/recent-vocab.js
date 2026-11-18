/* Memo Superform - 近期学习词汇候选（只读）
 * ==========================================
 * 从「墨墨学习记录」里挑出最近学过、可用于出阅读理解题的真实单词。
 *
 * 五条不能退让的约束，改代码前请先读：
 *
 * 1. **只读**：这里绝不调用 study/add_words，不写学习记录，不标记官方完成。
 *    唯一的写操作是零个 —— 本模块只读本地 SQLite 与官方只读接口。
 * 2. **不编造查询参数**：服务端白名单（server.py _official_api_allowed）只放行
 *    不带查询参数的 study/get_today_items 与 study/query_study_records。
 *    因此「今天」走 body {is_finished:true}，历史区间完全在本地筛选，
 *    绝不给官方接口加 last_study_date 之类的参数。
 * 3. **日期是日期级的**：last_study_date 只表示「某一天学过」，不是逐词答题
 *    时间，也不是精确顺序。所有比较都在北京时间（UTC+8）的「日」粒度上做。
 * 4. **四种状态要分开**：真正无数据 / 同步不完整(partial) / 缓存过旧(stale) /
 *    正常。无数据时返回 reason，绝不用示例词冒充真实学习记录。
 * 5. **账号隔离**：候选集合的存储键和返回值都带 accountScope；切号后读不到
 *    上一账号的练习。
 *
 * 依赖全部可注入（见 setDeps / collect(rangeKey, {deps})）：
 *   api        MaimemoAPI（浏览器里是 js/api.js 的顶层 const，不是 window 属性）
 *   fetchImpl  fetch（只在探测 /api/app/current-mode 时用）
 *   now        () => 毫秒时间戳（测试用来钉住「今天」）
 *   accountScope 直接指定账号标识（测试用）
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.MemoRecentVocab = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = '20261118-recent-vocab-v0.92';
    var BJ_OFFSET_MINUTES = 480;                 // 北京时间固定 UTC+8，无夏令时
    var DAY_MS = 24 * 60 * 60 * 1000;
    // 「缓存过旧」的门槛：上一次成功同步距今超过 24 小时就认为数据可能过期。
    var STALE_AFTER_MS = DAY_MS;
    var TODAY_ITEMS_LIMIT = 1000;                // 官方上限
    var FEEDBACK_VALUES = ['FAMILIAR', 'VAGUE', 'FORGET', 'WELL_FAMILIAR', 'CANCEL_WELL_FAMILIAR'];

    var RANGES = [
        { key: 'today', label: '今天', days: 0 },
        { key: 'd3', label: '最近 3 天', days: 3 },
        { key: 'd7', label: '最近 7 天', days: 7 },
        { key: 'd14', label: '最近 14 天', days: 14 }
    ];

    var REASONS = ['no-account', 'not-synced', 'partial', 'empty', 'error'];

    /* ---------------- 时间：一律按北京时间取「日期键」 ---------------- */

    function pad2(value) { return (value < 10 ? '0' : '') + value; }

    function beijingParts(ms) {
        var date = new Date(ms + BJ_OFFSET_MINUTES * 60000);
        return {
            year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate(),
            hour: date.getUTCHours(), minute: date.getUTCMinutes()
        };
    }

    function beijingDateKey(ms) {
        var parts = beijingParts(ms);
        return parts.year + '-' + pad2(parts.month) + '-' + pad2(parts.day);
    }

    function beijingToday(nowMs) {
        var ms = typeof nowMs === 'number' && isFinite(nowMs) ? nowMs : Date.now();
        return beijingDateKey(ms);
    }

    /* 北京日期的 00:00 对应的 UTC 毫秒。用于做日期加减。 */
    function dateKeyToUtcMs(dateKey) {
        var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
        if (!match) return NaN;
        return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) -
            BJ_OFFSET_MINUTES * 60000;
    }

    function addDays(dateKey, delta) {
        var ms = dateKeyToUtcMs(dateKey);
        if (!isFinite(ms)) return null;
        return beijingDateKey(ms + delta * DAY_MS);
    }

    /* 把任意来源的日期值归一成北京日期键 'YYYY-MM-DD'。
     *
     * 优先级（与 db._parse_date 的语义保持一致）：
     *   'YYYY-MM-DD'            已经是北京日期（本地服务已按北京时区归一化）→ 原样
     *   'YYYYMMDD'              紧凑日期 → 补连字符
     *   带时区标记的 ISO 时间    → 换算到 UTC+8 后取日期
     *   不带时区的 ISO 时间      → 官方文档声明字段是北京时区，按墙上时间取日期
     *   number                  秒/毫秒时间戳
     */
    function toBeijingDateKey(value) {
        if (value === null || value === undefined) return null;
        if (value instanceof Date) {
            return isFinite(value.getTime()) ? beijingDateKey(value.getTime()) : null;
        }
        if (typeof value === 'number') {
            if (!isFinite(value)) return null;
            return beijingDateKey(value > 1e11 ? value : value * 1000);
        }
        var text = String(value).replace(/\s+$/, '').replace(/^\s+/, '');
        if (!text) return null;
        if (/^\d{8}$/.test(text)) return text.slice(0, 4) + '-' + text.slice(4, 6) + '-' + text.slice(6, 8);
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        var slashed = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
        if (slashed) return slashed[1] + '-' + pad2(Number(slashed[2])) + '-' + pad2(Number(slashed[3]));
        var iso = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(text);
        if (iso) {
            var wallDate = iso[1] + '-' + iso[2] + '-' + iso[3];
            var zone = iso[7];
            if (!zone) return wallDate;         // 无时区标记：按北京墙上时间
            var asUtc = Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]),
                Number(iso[4]) || 0, Number(iso[5]) || 0, Number(iso[6]) || 0);
            if (!isFinite(asUtc)) return wallDate;
            var offsetMinutes = 0;
            if (!/^z$/i.test(zone)) {
                var sign = zone.charAt(0) === '-' ? -1 : 1;
                var digits = zone.slice(1).replace(':', '');
                offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
            }
            return beijingDateKey(asUtc - offsetMinutes * 60000);
        }
        var parsed = new Date(text);
        if (!isNaN(parsed.getTime())) return beijingDateKey(parsed.getTime());
        return null;
    }

    /* ---------------- 范围 ---------------- */

    function findRange(rangeKey) {
        for (var i = 0; i < RANGES.length; i += 1) {
            if (RANGES[i].key === rangeKey) return RANGES[i];
        }
        return null;
    }

    /* 区间窗口：'today' 是 1 天（今天），'d3' 是今天 + 前 2 天，闭区间两端。 */
    function rangeWindow(rangeKey, nowMs) {
        var range = findRange(rangeKey);
        if (!range) return null;
        var today = beijingToday(nowMs);
        var span = range.days > 0 ? range.days : 1;
        var start = addDays(today, -(span - 1));
        if (!start) return null;
        return { start: start, end: today, days: span, label: range.label, rangeKey: range.key };
    }

    /* ---------------- 拼写规范化 ---------------- */

    /* 去首尾空白、连续空白（含全角空格/不换行空格）合一；原始大小写保留在
     * spelling 里，用于展示与出题；spellingKey 是小写形态，用于匹配与去重。 */
    function normalizeSpelling(value) {
        if (value === null || value === undefined) return '';
        return String(value)
            .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
            .replace(/[\s\u00a0\u3000]+/g, ' ')
            .trim();
    }

    function normalizeFeedback(value) {
        if (value === null || value === undefined) return '';
        if (typeof value === 'string') return value.trim();
        if (typeof value === 'object') {
            var name = value.response || value.value || value.name || '';
            return typeof name === 'string' ? name.trim() : '';
        }
        return '';
    }

    function toCount(value) {
        var num = Number(value);
        if (!isFinite(num) || num < 0) return null;
        return Math.floor(num);
    }

    /* 按 voc_id 去重。同一 voc_id 出现多次时：
     *   - 保留学习日期更晚的一条的 lastStudyDate/feedback/studyCount；
     *   - 来源全部记进 sources（today-items 与 study-records 都可能出现）；
     *   - 首次出现的 spelling 展示形态优先（保留原始大小写）。
     * 没有 voc_id 或拼写为空的记录直接丢弃：没有稳定 ID 就无法做词表复习。 */
    function dedupe(items) {
        var seen = Object.create(null);
        var out = [];
        (Array.isArray(items) ? items : []).forEach(function (item) {
            if (!item) return;
            var vocId = item.vocId === null || item.vocId === undefined ? '' : String(item.vocId).trim();
            var spelling = normalizeSpelling(item.spelling);
            if (!spelling) return;
            /* 没有 voc_id 时退化为按规范化拼写去重，而不是直接丢弃：
             * 直接 return 会让这些词在候选列表里静默消失，用户看到的是
             * "明明学过却不出现"。voc_id 优先，拼写兜底。 */
            var key = vocId ? ('id:' + vocId) : ('spell:' + spelling.toLowerCase());
            if (!vocId) vocId = '';
            var date = item.lastStudyDate ? String(item.lastStudyDate) : null;
            var existing = seen[key];
            if (existing) {
                if (date && (!existing.lastStudyDate || date > existing.lastStudyDate)) {
                    existing.lastStudyDate = date;
                }
                if (!existing.feedback && item.feedback) existing.feedback = item.feedback;
                var count = toCount(item.studyCount);
                if (count !== null) {
                    existing.studyCount = existing.studyCount === null ? count : Math.max(existing.studyCount, count);
                }
                if (item.source && existing.sources.indexOf(item.source) < 0) existing.sources.push(item.source);
                return;
            }
            var candidate = {
                vocId: vocId,
                spelling: spelling,
                spellingKey: spelling.toLowerCase(),
                lastStudyDate: date,
                feedback: normalizeFeedback(item.feedback),
                studyCount: toCount(item.studyCount),
                source: item.source || 'study-records',
                sources: [item.source || 'study-records']
            };
            seen[key] = candidate;
            out.push(candidate);
        });
        return out;
    }

    /* ---------------- 从两类数据源生成候选 ---------------- */

    /* /api/study-records 的投影字段以 snake_case 为准（db.get_records），但
     * 同步链路、旧缓存与测试替身都用过驼峰形态。这里统一两种都能读，
     * 免得接线层还要先翻译一遍。 */
    function pickField(record, snake, camel) {
        if (!record) return undefined;
        if (record[snake] !== undefined && record[snake] !== null) return record[snake];
        if (camel && record[camel] !== undefined && record[camel] !== null) return record[camel];
        return undefined;
    }

    function recordVocId(record) {
        var value = pickField(record, 'voc_id', 'vocId');
        return value === undefined || value === null ? '' : String(value).trim();
    }

    function recordSpelling(record) {
        var value = pickField(record, 'voc_spelling', 'vocSpelling');
        if (value === undefined || value === null) value = pickField(record, 'spelling', 'spelling');
        if (value === undefined || value === null) value = pickField(record, 'word', 'word');
        return value === undefined || value === null ? '' : String(value);
    }

    function recordLastStudyDate(record) {
        return pickField(record, 'last_study_date', 'lastStudyDate');
    }

    /* 本地学习记录：last_study_date 是日期级字段，落在窗口内就算「最近学过」。
     * 它不是逐词答题时间，也不能用来排精确顺序。 */
    function candidatesFromRecords(records, window) {
        var rows = [];
        (Array.isArray(records) ? records : []).forEach(function (record) {
            if (!record) return;
            var dateKey = toBeijingDateKey(recordLastStudyDate(record));
            if (!dateKey) return;
            if (window && (dateKey < window.start || dateKey > window.end)) return;
            rows.push({
                vocId: recordVocId(record),
                spelling: recordSpelling(record),
                lastStudyDate: dateKey,
                feedback: pickField(record, 'last_response', 'lastResponse'),
                studyCount: pickField(record, 'study_count', 'studyCount'),
                source: 'study-records'
            });
        });
        return rows;
    }

    /* 今日已完成：POST /study/get_today_items {is_finished:true}。
     * 官方只给当天的词与学习顺序，不给日期/次数；本地记录里存在同一 voc_id 时
     * 用本地值补齐 studyCount / feedback（不动来源标记）。 */
    function candidatesFromTodayItems(todayItems, todayKey, recordsById) {
        var rows = [];
        (Array.isArray(todayItems) ? todayItems : []).forEach(function (item) {
            if (!item || item.is_finished === false) return;   // 防御：只要已完成
            var vocId = item.voc_id === null || item.voc_id === undefined ? '' : String(item.voc_id);
            if (!vocId) return;
            var local = recordsById && recordsById[vocId] ? recordsById[vocId] : null;
            /* 今日项没有 last_study_date 字段。日期就是今天（北京时区），
             * first_response 只表示当天第一次反馈，不能反推逐词答题时间。 */
            rows.push({
                vocId: vocId,
                spelling: item.voc_spelling || (local ? recordSpelling(local) : '') || '',
                lastStudyDate: todayKey,
                feedback: local ? pickField(local, 'last_response', 'lastResponse') : (item.first_response || ''),
                studyCount: local ? pickField(local, 'study_count', 'studyCount') : null,
                source: 'today-items'
            });
        });
        return rows;
    }

    function indexRecordsById(records) {
        var map = Object.create(null);
        (Array.isArray(records) ? records : []).forEach(function (record) {
            if (!record) return;
            var id = recordVocId(record);
            if (id && !map[id]) map[id] = record;
        });
        return map;
    }

    /* ---------------- 账号隔离 ---------------- */

    /* accountScope 取值顺序：
     *   1. 显式注入（setDeps / collect 的 deps.accountScope）
     *   2. MaimemoAPI.connectionStatus().profile_id（服务端给的稳定档案键）
     *   3. GET /api/app/current-mode 若将来带回 profile_id/account/subject
     *   4. 'anonymous'
     * 形式为 'profile:<id>' 或 'anonymous'。 */
    async function resolveAccountScope(deps) {
        if (deps.accountScope) return String(deps.accountScope);
        try {
            var api = deps.api;
            if (api && typeof api.connectionStatus === 'function') {
                var status = api.connectionStatus() || {};
                if (status.profile_id) return 'profile:' + String(status.profile_id);
            }
        } catch (error) { /* 状态不可读就继续往下退 */ }
        if (deps.fetchImpl) {
            try {
                var response = await deps.fetchImpl('/api/app/current-mode', {
                    method: 'GET',
                    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }
                });
                var payload = await response.json();
                var value = payload && (payload.profile_id || payload.account_id || payload.account || payload.subject);
                if (value) return 'profile:' + String(value);
            } catch (error) { /* 老服务端没有这个字段，退到 anonymous */ }
        }
        return 'anonymous';
    }

    /* ---------------- 完整性判定 ---------------- */

    /* completeness 的四种取值：
     *   'empty'    真正没有可用数据（无候选，且同步链路上也没报「不完整」）
     *   'partial'  同步不完整（未完成初次同步 / 需要核验 / 覆盖范围不足 / 今日列表读不到）
     *   'stale'    结构完整但同步时间过旧（> 24h）
     *   'complete' 正常
     * 同时把命中的问题放进 issues，界面可以一次显示多条。 */
    function evaluateCompleteness(input) {
        var sync = input.sync && typeof input.sync === 'object' ? input.sync : null;
        var issues = [];
        var notes = [];
        var partial = false;
        var stale = false;
        var nowMs = input.nowMs;
        var syncedAt = input.syncedAt || null;

        function flagPartial(note) {
            partial = true;
            if (issues.indexOf('partial') < 0) issues.push('partial');
            if (note) notes.push(note);
        }

        if (!sync) {
            flagPartial('没有读到本地同步状态，无法确认学习记录是否完整');
        } else {
            if (sync.bootstrap_complete === false) flagPartial('本地学习记录尚未完成初次同步');
            if (sync.needs_reconcile) flagPartial('本地记录被标记为需要完整核验');
            if (sync.last_status && /fail|error/i.test(String(sync.last_status))) {
                flagPartial('最近一次同步没有成功');
            }
            if (sync.last_error) flagPartial('最近一次同步报告了错误：' + String(sync.last_error).slice(0, 120));
        }

        if (input.recordCount === 0 && sync && (toCount(sync.records_count) || 0) > 0) {
            flagPartial('本地记录条数与同步状态不一致');
        }

        /* 覆盖范围：窗口左端早于 coverage_start 时，那段日子根本没有本地数据。 */
        if (input.window) {
            var coverage = sync && (sync.coverage || null);
            var coverageStart = coverage && coverage.start ? toBeijingDateKey(coverage.start) : null;
            var coverageEnd = coverage && coverage.end ? toBeijingDateKey(coverage.end) : null;
            if (coverageStart && coverageStart > input.window.start) {
                flagPartial('本地记录只覆盖到 ' + coverageStart + '，' + input.window.start + ' 起的数据缺失');
            }
            if (coverageEnd && coverageEnd < input.window.end) {
                flagPartial('本地记录只覆盖到 ' + coverageEnd + '，' + input.window.end + ' 的数据缺失');
            }
        }

        if (input.todayError) {
            flagPartial('今日已完成列表读取失败：' + String(input.todayError).slice(0, 120));
        }
        /* 今日列表拿满 limit 条时官方可能已经截断，无法断言「今天全在这里」。 */
        if (input.todayTruncated) {
            flagPartial('今日已完成列表达到 ' + input.todayLimit + ' 条上限，可能还有未读取的词');
        }

        if (!syncedAt) {
            stale = true;
            notes.push('没有可用的同步时间');
        } else {
            var syncedMs = Date.parse(syncedAt);
            if (!isFinite(syncedMs)) {
                stale = true;
                notes.push('同步时间无法解析：' + String(syncedAt).slice(0, 40));
            } else if (nowMs - syncedMs > STALE_AFTER_MS) {
                stale = true;
                notes.push('学习记录同步于 ' + new Date(syncedMs).toISOString() + '，已经超过 24 小时');
            }
        }
        if (stale && issues.indexOf('stale') < 0) issues.push('stale');

        var empty = (input.candidateCount || 0) === 0;
        var level = 'complete';
        if (empty && !partial) level = 'empty';
        else if (partial) level = 'partial';
        else if (stale) level = 'stale';

        return { completeness: level, issues: issues, notes: notes, empty: empty, partial: partial, stale: stale };
    }

    function pickSyncedAt(sync) {
        if (!sync || typeof sync !== 'object') return null;
        var candidates = [sync.last_success_at, sync.last_incremental_at, sync.last_reconcile_at,
            sync.finished_at, sync.completed_at, sync.updated_at];
        for (var i = 0; i < candidates.length; i += 1) {
            if (candidates[i]) return String(candidates[i]);
        }
        return null;
    }

    /* ---------------- 依赖注入 ---------------- */

    var injected = {};

    function defaultDeps() {
        return {
            /* MaimemoAPI 是 js/api.js 里的顶层 const（全局词法绑定），
             * 不是 window 属性，所以只能写 typeof 判断。 */
            api: (typeof MaimemoAPI !== 'undefined' ? MaimemoAPI : null),
            fetchImpl: (typeof fetch === 'function' ? fetch : null),
            now: function () { return Date.now(); },
            accountScope: null
        };
    }

    function resolveDeps(options) {
        var override = Object.assign({}, injected, (options && options.deps) || {});
        var base = defaultDeps();
        return {
            api: override.api !== undefined ? override.api : base.api,
            fetchImpl: override.fetchImpl !== undefined ? override.fetchImpl : base.fetchImpl,
            now: typeof override.now === 'function' ? override.now : base.now,
            accountScope: override.accountScope !== undefined ? override.accountScope : base.accountScope
        };
    }

    function setDeps(partial) {
        injected = Object.assign({}, injected, partial || {});
        return Object.assign({}, injected);
    }

    function resetDeps() {
        injected = {};
        return {};
    }

    function getDeps() {
        var deps = resolveDeps();
        return {
            hasApi: !!deps.api,
            hasFetch: !!deps.fetchImpl,
            accountScope: deps.accountScope
        };
    }

    /* ---------------- 主入口 ---------------- */

    function emptyResult(range, deps, extra) {
        var rangeInfo = range || findRange('today');
        return Object.assign({
            ok: false,
            reason: 'empty',
            rangeKey: rangeInfo ? rangeInfo.key : null,
            rangeLabel: rangeInfo ? rangeInfo.label : '',
            days: rangeInfo ? rangeInfo.days : null,
            /* 界面要展示"日期范围"，而 rangeLabel 只是"最近 7 天"这种人话。
             * 真实的起止日期由 rangeWindow() 算出，这里一并带出来。 */
            start: extra && extra.start !== undefined ? extra.start : null,
            end: extra && extra.end !== undefined ? extra.end : null,
            syncedAt: null,
            completeness: 'empty',
            candidates: [],
            rawCount: 0,
            accountScope: 'anonymous',
            issues: [],
            notes: []
        }, extra || {});
    }

    async function collect(rangeKey, options) {
        var deps = resolveDeps(options);
        var range = findRange(rangeKey);
        if (!range) {
            var bad = emptyResult(null, deps, {
                reason: 'error',
                rangeKey: rangeKey === undefined ? null : rangeKey,
                rangeLabel: '',
                days: null
            });
            bad.error = '未知的时间范围：' + String(rangeKey);
            bad.notes = [bad.error];
            return bad;
        }
        var nowMs = deps.now();
        var window = rangeWindow(range.key, nowMs);
        var scope = await resolveAccountScope(deps);

        var api = deps.api;
        var connected = !!(api && typeof api.hasToken === 'function' && api.hasToken());
        if (!api || !connected) {
            return emptyResult(range, deps, {
                reason: 'no-account', accountScope: scope, start: window.start, end: window.end
            });
        }

        try {
            var sync = null;
            var syncError = null;
            if (typeof api.getStudySyncStatus === 'function') {
                try { sync = await api.getStudySyncStatus(); }
                catch (error) { syncError = error && error.message ? error.message : String(error); }
            }
            if (sync && sync.status && typeof sync.status === 'object') sync = sync.status;
            var syncedAt = pickSyncedAt(sync);

            var records = [];
            var recordsError = null;
            if (typeof api.getAllStudyRecords === 'function') {
                try { records = await api.getAllStudyRecords(false); }
                catch (error) { recordsError = error && error.message ? error.message : String(error); }
            }
            if (!Array.isArray(records)) records = [];

            var todayError = null;
            var todayItems = [];
            var todayTruncated = false;
            var todayLimit = TODAY_ITEMS_LIMIT;
            if (range.key === 'today') {
                if (typeof api.request !== 'function') {
                    todayError = '缺少墨墨接口封装';
                } else {
                    try {
                        /* 只读：body 里只有筛选条件。白名单要求「没有查询参数」，
                         * 所以这些字段只能放在 body，不能拼到 URL。 */
                        var payload = await api.request('/study/get_today_items', {
                            method: 'POST',
                            body: { is_finished: true, limit: TODAY_ITEMS_LIMIT }
                        });
                        var list = payload && (payload.today_items || payload.items);
                        todayItems = Array.isArray(list) ? list : [];
                        if (!Array.isArray(list)) todayError = '今日列表格式异常';
                        todayTruncated = todayItems.length >= todayLimit;
                    } catch (error) {
                        todayError = error && error.message ? error.message : String(error);
                    }
                }
            }

            var rawRows;
            if (range.key === 'today') {
                rawRows = candidatesFromTodayItems(todayItems, window.end, indexRecordsById(records));
            } else {
                rawRows = candidatesFromRecords(records, window);
            }
            var rawCount = rawRows.length;
            var candidates = dedupe(rawRows);

            var verdict = evaluateCompleteness({
                sync: sync, syncedAt: syncedAt, nowMs: nowMs, window: window,
                candidateCount: candidates.length, recordCount: records.length,
                todayError: todayError, todayTruncated: todayTruncated, todayLimit: todayLimit
            });

            var result = emptyResult(range, deps, {
                start: window.start,
                end: window.end,
                syncedAt: syncedAt,
                completeness: verdict.completeness,
                candidates: candidates,
                rawCount: rawCount,
                accountScope: scope,
                issues: verdict.issues,
                notes: verdict.notes
            });

            if (syncError) result.notes.push('同步状态读取失败：' + String(syncError).slice(0, 120));
            if (recordsError) result.notes.push('本地学习记录读取失败：' + String(recordsError).slice(0, 120));
            result.recordCount = records.length;
            result.todayItemCount = todayItems.length;
            result.todayTruncated = todayTruncated;

            if (candidates.length === 0) {
                var noBootstrap = !sync || sync.bootstrap_complete === false;
                if (noBootstrap && records.length === 0) {
                    result.reason = 'not-synced';
                    result.completeness = 'empty';
                    result.notes.push('本地还没有学习记录，请先完成一次数据同步');
                } else if (verdict.partial) {
                    result.reason = 'partial';
                } else {
                    result.reason = 'empty';
                    if (range.key === 'today') {
                        result.notes.push('今天还没有已完成的墨墨学习记录');
                    } else {
                        result.notes.push(range.label + '没有学习记录');
                    }
                }
                result.ok = false;
                return result;
            }

            result.ok = true;
            if (verdict.partial) result.reason = 'partial';
            return result;
        } catch (error) {
            var failure = emptyResult(range, deps, {
                reason: 'error',
                accountScope: scope
            });
            failure.error = error && error.message ? error.message : String(error);
            failure.notes = ['读取近期学习词汇失败：' + failure.error];
            return failure;
        }
    }

    return {
        VERSION: VERSION,
        RANGES: RANGES,
        REASONS: REASONS,
        STALE_AFTER_MS: STALE_AFTER_MS,
        TODAY_ITEMS_LIMIT: TODAY_ITEMS_LIMIT,
        FEEDBACK_VALUES: FEEDBACK_VALUES,
        collect: collect,
        resolveAccountScope: resolveAccountScope,
        setDeps: setDeps,
        resetDeps: resetDeps,
        getDeps: getDeps,
        // 纯函数导出，给接线层与测试直接用
        beijingDateKey: beijingDateKey,
        beijingToday: beijingToday,
        toBeijingDateKey: toBeijingDateKey,
        addDays: addDays,
        dateKeyToUtcMs: dateKeyToUtcMs,
        findRange: findRange,
        rangeWindow: rangeWindow,
        normalizeSpelling: normalizeSpelling,
        normalizeFeedback: normalizeFeedback,
        pickField: pickField,
        recordVocId: recordVocId,
        recordSpelling: recordSpelling,
        recordLastStudyDate: recordLastStudyDate,
        dedupe: dedupe,
        candidatesFromRecords: candidatesFromRecords,
        candidatesFromTodayItems: candidatesFromTodayItems,
        indexRecordsById: indexRecordsById,
        evaluateCompleteness: evaluateCompleteness,
        pickSyncedAt: pickSyncedAt
    };
});
