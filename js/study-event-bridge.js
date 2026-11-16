/*!
 * study-event-bridge.js —— 浏览器侧学习事件观察桥。
 *
 * 为什么需要它：服务端只能看到「答题结果」这类最终事实，看不到「这个词在页面上
 * 被翻过、被朗读、被标记」的过程。但过程**不能**单独决定完成——因此本桥只上报
 * ``observed_ack``（观察到的确认）与 ``intent``（意图），绝不产生
 * ``official_snapshot``；完成与否仍由服务端用完整官方计划判定。
 *
 * 三条硬要求：
 * 1. **幂等**：同一事件重复上报由服务端按 event_id 去重，所以本地必须生成稳定
 *    event_id（而不是随机 UUID），否则刷新即产生重复。
 * 2. **有界**：内部队列有上限，永不无限增长；页面隐藏/离线时暂停发送。
 * 3. **只读**：绝不修改被观察的 DOM、不阻止原事件、不改变学习流程的判定。
 *
 * UMD：浏览器挂 ``window.StudyEventBridge``，Node 可直接 require 做回归测试。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.StudyEventBridge = factory();
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    var VERSION = '1.0.0';
    var MAX_QUEUE = 200;
    var MAX_BATCH = 50;
    var HEARTBEAT_MS = 15000;
    var FLUSH_MS = 4000;

    function nowIso(clock) {
        var date = typeof clock === 'function' ? clock() : new Date();
        if (date instanceof Date) { return date.toISOString(); }
        return new Date().toISOString();
    }

    // 稳定 event_id：同样的「谁/在哪/何时/做了什么」永远得到同一个 ID，
    // 因此重试与刷新都不会在服务端产生第二条事件。
    function stableId(parts) {
        var text = parts.join('|');
        var hash = 2166136261;
        for (var i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = (hash * 16777619) >>> 0;
        }
        var second = 5381;
        for (var j = text.length - 1; j >= 0; j -= 1) {
            second = ((second << 5) + second + text.charCodeAt(j)) >>> 0;
        }
        return 'sb_' + hash.toString(36) + '_' + second.toString(36);
    }

    function createBridge(options) {
        var opts = options || {};
        var send = typeof opts.send === 'function' ? opts.send : null;
        var clock = typeof opts.now === 'function' ? opts.now : null;
        var queue = [];
        var inFlight = null;
        var destroyed = false;
        var lastFlushAt = 0;
        var flushTimer = null;
        var heartbeatTimer = null;
        var seen = {};

        var state = {
            sessionId: '',
            instanceId: opts.instanceId || '',
            frameGeneration: 0,
            bindingRevision: 1,
            goalRevision: 1,
            enabled: false,
            paused: false,
            seq: 0,
            sent: 0,
            dropped: 0,
            failed: 0,
            duplicates: 0,
            lastError: '',
            lastSentAt: ''
        };

        function newInstanceId() {
            // 只需要在「同一页面实例」内唯一；服务端把它当活动租约的来源。
            return 'inst_' + Math.random().toString(36).slice(2, 10) +
                Date.now().toString(36);
        }

        if (!state.instanceId) { state.instanceId = newInstanceId(); }

        function remember(key) {
            if (seen[key]) { return true; }
            seen[key] = true;
            return false;
        }

        function enqueue(event) {
            if (destroyed || state.paused || !state.enabled) {
                state.dropped += 1;
                return null;
            }
            if (!event || !event.item_key) {
                state.dropped += 1;
                return null;
            }
            var key = [state.sessionId, event.source, event.item_key,
                event.round_key || '', event.type].join('|');
            if (remember(key)) {
                state.duplicates += 1;
                return null;
            }
            if (queue.length >= MAX_QUEUE) {
                // 有界队列：丢最旧的，保留最近的学习过程而不是让内存无上限增长。
                queue.shift();
                state.dropped += 1;
            }
            state.seq += 1;
            var record = {
                // source 只允许 observed_ack / intent：official_snapshot 只能由
                // 服务端从官方接口取得，浏览器不能自称官方事实。
                event_id: stableId([state.sessionId, state.instanceId, event.source,
                    event.item_key, event.round_key || '', event.type || 'answer']),
                type: event.type || 'answer',
                source: event.source || 'intent',
                item_key: String(event.item_key),
                round_key: event.round_key ? String(event.round_key) : '',
                task_key: event.task_key ? String(event.task_key) : '',
                action: event.action ? String(event.action) : '',
                observed_at: event.observed_at || nowIso(clock),
                source_instance_id: state.instanceId,
                frame_generation: state.frameGeneration,
                binding_revision: state.bindingRevision,
                goal_revision: state.goalRevision,
                seq: state.seq
            };
            queue.push(record);
            return record;
        }

        function drain() {
            if (!queue.length) { return []; }
            var batch = queue.slice(0, MAX_BATCH);
            queue = queue.slice(batch.length);
            return batch;
        }

        function requeue(batch) {
            // 失败回滚：把这一批放回队首，但要重新受上限约束。
            queue = batch.concat(queue).slice(-MAX_QUEUE);
        }

        function flush() {
            if (destroyed) { return Promise.resolve({ skipped: true }); }
            // 自动触发的 flush 与显式 flush 会并发：返回同一个在途 Promise，
            // 否则同一批事件会被发送两次、队列计数也会错乱。
            if (inFlight) { return inFlight; }
            if (!send) {
                // 没有传输通道时保留队列，等注入 sender 后继续；绝不静默丢弃。
                return Promise.resolve({ skipped: true, reason: 'no_sender' });
            }
            if (!state.enabled || !state.sessionId) {
                return Promise.resolve({ skipped: true, reason: 'no_session' });
            }
            var batch = drain();
            if (!batch.length) { return Promise.resolve({ sent: 0 }); }
            lastFlushAt = Date.now();
            var task = Promise.resolve()
                .then(function () {
                    // send 可能同步抛错；放进 then 里才不会逃出 Promise 链。
                    return send(state.sessionId, batch);
                })
                .then(function (result) {
                    state.sent += batch.length;
                    state.lastSentAt = nowIso(clock);
                    state.lastError = '';
                    var accepted = result && typeof result.accepted === 'number'
                        ? result.accepted : batch.length;
                    if (accepted < batch.length) {
                        // 服务端只接受了一部分：剩余事件不能算已发送。
                        var leftover = batch.slice(accepted);
                        if (leftover.length) { requeue(leftover); }
                        state.failed += leftover.length;
                    }
                    return result || { accepted: accepted };
                }, function (error) {
                    requeue(batch);
                    state.failed += batch.length;
                    state.lastError = (error && error.message) || String(error);
                    return { error: state.lastError };
                })
                .then(function (result) {
                    inFlight = null;
                    return result;
                });
            inFlight = task;
            return task;
        }

        function maybeFlush() {
            // 由定时器与心跳调用：批量阈值够了就立刻发，否则按 FLUSH_MS 节流。
            // 单次 observe 不直接调用它，避免一次观察就产生隐式网络请求。
            if (queue.length >= MAX_BATCH) { return flush(); }
            if (Date.now() - lastFlushAt >= FLUSH_MS) { return flush(); }
            return Promise.resolve({ queued: queue.length });
        }

        var api = {
            version: VERSION,

            attach: function (sessionView) {
                if (!sessionView) {
                    throw new Error('attach 需要服务端会话视图');
                }
                state.sessionId = String(sessionView.session_id || '');
                state.enabled = !!state.sessionId;
                state.paused = false;
                state.goalRevision = Number(sessionView.goal_revision) || 1;
                return api.getState();
            },

            detach: function () {
                state.enabled = false;
                state.sessionId = '';
                return api.getState();
            },

            setFrame: function (info) {
                var data = info || {};
                if (typeof data.frame_generation === 'number') {
                    state.frameGeneration = data.frame_generation;
                }
                if (typeof data.binding_revision === 'number') {
                    state.bindingRevision = data.binding_revision;
                }
                return api.getState();
            },

            setPaused: function (paused) {
                state.paused = !!paused;
                return api.getState();
            },

            // observed_ack：用户/页面确实确认过的动作（翻面、朗读、点击确认）。
            // 不自动 flush：传输时机由 start() 的定时器与调用方显式 flush 决定，
            // 否则单次观察会在测试与离线场景里产生隐式网络请求。
            observe: function (payload) {
                return enqueue(Object.assign({}, payload, { source: 'observed_ack' }));
            },

            // intent：只是「想做什么」，不构成完成证据，仅供体验与调试。
            intent: function (payload) {
                return enqueue(Object.assign({}, payload, { source: 'intent' }));
            },

            flush: flush,

            heartbeat: function () {
                if (destroyed || !state.enabled || !state.sessionId) {
                    return Promise.resolve({ skipped: true });
                }
                var transport = typeof opts.heartbeat === 'function' ? opts.heartbeat : null;
                if (!transport) { return Promise.resolve({ skipped: true }); }
                return Promise.resolve(transport(state.sessionId, state.instanceId))
                    .catch(function () { return { error: 'heartbeat_failed' }; });
            },

            start: function () {
                if (destroyed) { return api.getState(); }
                if (flushTimer === null && typeof setInterval === 'function') {
                    // 用 maybeFlush 而不是无条件 flush：空队列时不应每 4 秒打一次空请求。
                    flushTimer = setInterval(function () { maybeFlush(); }, FLUSH_MS);
                }
                if (heartbeatTimer === null && typeof setInterval === 'function') {
                    heartbeatTimer = setInterval(function () { api.heartbeat(); },
                        HEARTBEAT_MS);
                }
                api.setPaused(false);
                return api.getState();
            },

            stop: function () {
                if (flushTimer !== null && typeof clearInterval === 'function') {
                    clearInterval(flushTimer);
                }
                if (heartbeatTimer !== null && typeof clearInterval === 'function') {
                    clearInterval(heartbeatTimer);
                }
                flushTimer = null;
                heartbeatTimer = null;
                return flush().then(function () { return api.getState(); });
            },

            destroy: function () {
                destroyed = true;
                state.enabled = false;
                queue = [];
                seen = {};
                if (flushTimer !== null && typeof clearInterval === 'function') {
                    clearInterval(flushTimer);
                }
                if (heartbeatTimer !== null && typeof clearInterval === 'function') {
                    clearInterval(heartbeatTimer);
                }
                flushTimer = null;
                heartbeatTimer = null;
                return api.getState();
            },

            getState: function () {
                return {
                    version: VERSION,
                    sessionId: state.sessionId,
                    instanceId: state.instanceId,
                    enabled: state.enabled,
                    paused: state.paused,
                    queued: queue.length,
                    sent: state.sent,
                    dropped: state.dropped,
                    failed: state.failed,
                    duplicates: state.duplicates,
                    seq: state.seq,
                    frameGeneration: state.frameGeneration,
                    bindingRevision: state.bindingRevision,
                    goalRevision: state.goalRevision,
                    lastError: state.lastError,
                    lastSentAt: state.lastSentAt,
                    hasSender: !!send
                };
            },

            peekQueue: function () {
                return queue.map(function (item) { return Object.assign({}, item); });
            },

            _reset: function () {
                queue = [];
                seen = {};
                state.seq = 0;
                state.sent = 0;
                state.dropped = 0;
                state.failed = 0;
                state.duplicates = 0;
                state.lastError = '';
                return api.getState();
            }
        };

        // 页面隐藏时暂停上报，避免把「切后台挂机」算成在场时间；
        // 恢复可见时继续。这只是时间语义，不是完成判定。
        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', function () {
                state.paused = !!(document.hidden || document.visibilityState === 'hidden');
                if (!state.paused) { flush(); }
            });
        }

        return api;
    }

    return {
        version: VERSION,
        MAX_QUEUE: MAX_QUEUE,
        MAX_BATCH: MAX_BATCH,
        HEARTBEAT_MS: HEARTBEAT_MS,
        FLUSH_MS: FLUSH_MS,
        stableId: stableId,
        createBridge: createBridge,
        create: createBridge
    };
}));