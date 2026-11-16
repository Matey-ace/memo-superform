-- Memo Superform SQLite 架构（v0.70）。
-- 本文件是运行时唯一事实来源；schema.sql 仅为旧 SQL Server 数据库的只读导入保留。

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
    profile_id INTEGER PRIMARY KEY AUTOINCREMENT,
    token_hash TEXT NOT NULL UNIQUE,
    display_name TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 单词当前状态。以稳定的上游 voc_id 而非拼写作为身份，确保相同拼写仍可区分。
CREATE TABLE IF NOT EXISTS study_records (
    profile_id INTEGER NOT NULL,
    voc_id TEXT NOT NULL,
    voc_spelling TEXT NOT NULL,
    definition TEXT,
    add_date TEXT,
    first_study_date TEXT,
    last_study_date TEXT,
    next_study_date TEXT,
    last_response TEXT,
    study_count INTEGER,
    tags_json TEXT,
    record_hash TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    missing_reconcile_count INTEGER NOT NULL DEFAULT 0,
    last_missing_reconcile_run_id INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, voc_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 日期过去后每日快照只追加不改写，使旧图表/统计保持稳定，而 study_records 保留当前状态。
CREATE TABLE IF NOT EXISTS study_record_snapshots (
    profile_id INTEGER NOT NULL,
    snapshot_date TEXT NOT NULL,
    voc_id TEXT NOT NULL,
    voc_spelling TEXT NOT NULL,
    definition TEXT,
    add_date TEXT,
    first_study_date TEXT,
    last_study_date TEXT,
    next_study_date TEXT,
    last_response TEXT,
    study_count INTEGER,
    tags_json TEXT,
    record_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, snapshot_date, voc_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 使用标记使空数组也能成为有效且已完成的每日快照。
CREATE TABLE IF NOT EXISTS snapshot_runs (
    profile_id INTEGER NOT NULL,
    snapshot_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, snapshot_date),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS daily_stats (
    profile_id INTEGER NOT NULL,
    stat_date TEXT NOT NULL,
    total_words INTEGER NOT NULL DEFAULT 0,
    new_words INTEGER NOT NULL DEFAULT 0,
    reviewed_words INTEGER NOT NULL DEFAULT 0,
    familiar_count INTEGER NOT NULL DEFAULT 0,
    vague_count INTEGER NOT NULL DEFAULT 0,
    forget_count INTEGER NOT NULL DEFAULT 0,
    overdue_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, stat_date),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS recommendations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    recommend_date TEXT NOT NULL,
    voc_id TEXT NOT NULL,
    word TEXT NOT NULL,
    definition TEXT,
    risk_score INTEGER NOT NULL DEFAULT 0,
    overdue_days INTEGER NOT NULL DEFAULT 0,
    gap_days INTEGER NOT NULL DEFAULT 0,
    last_response TEXT,
    next_study_date TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reviewed_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(profile_id, recommend_date, voc_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS settings (
    key_name TEXT PRIMARY KEY,
    value_text TEXT,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_state (
    profile_id INTEGER PRIMARY KEY,
    bootstrap_complete INTEGER NOT NULL DEFAULT 0,
    last_remote_count INTEGER,
    last_incremental_at TEXT,
    last_incremental_date TEXT,
    last_reconcile_at TEXT,
    last_today_probe_at TEXT,
    last_success_at TEXT,
    last_status TEXT NOT NULL DEFAULT 'never',
    needs_reconcile INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    local_record_count INTEGER NOT NULL DEFAULT 0,
    coverage_start TEXT,
    coverage_end TEXT,
    extra_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL,
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_runs (
    run_id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('bootstrap', 'incremental', 'reconcile')),
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    started_at TEXT NOT NULL,
    finished_at TEXT,
    fetched_count INTEGER NOT NULL DEFAULT 0,
    inserted_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    unchanged_count INTEGER NOT NULL DEFAULT 0,
    error_text TEXT,
    details_json TEXT,
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sync_segments (
    profile_id INTEGER NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    source TEXT NOT NULL,
    complete INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, start_date, end_date, source),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 轻量“今日”探测返回记录的哈希与元数据。
CREATE TABLE IF NOT EXISTS sync_today_items (
    profile_id INTEGER NOT NULL,
    sync_date TEXT NOT NULL,
    voc_id TEXT NOT NULL,
    record_hash TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    PRIMARY KEY (profile_id, sync_date, voc_id),
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS legacy_imports (
    import_key TEXT PRIMARY KEY,
    source_name TEXT NOT NULL,
    status TEXT NOT NULL,
    imported_at TEXT,
    details_json TEXT,
    error_text TEXT
);

-- 模型二进制仅存于 data/live2d/models；SQLite 保存已校验注册表和每个资料的选定模型。
CREATE TABLE IF NOT EXISTS live2d_models (
    model_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    character_id TEXT,
    display_name TEXT NOT NULL,
    catalog_name TEXT,
    model_format TEXT NOT NULL CHECK (model_format IN ('cubism2', 'cubism3')),
    relative_path TEXT NOT NULL UNIQUE,
    entry_file TEXT NOT NULL,
    manifest_json TEXT NOT NULL,
    byte_size INTEGER NOT NULL DEFAULT 0,
    complete INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS live2d_preferences (
    profile_id INTEGER PRIMARY KEY,
    active_model_id TEXT,
    companion_enabled INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- ===================== 陪伴升级：长期记忆 / 会话证据 / 结算 =====================
-- 契约版本 v1（见 docs/companion-upgrade-contracts.md 与
-- _verification/companion-upgrade/p0-baseline.md）。所有表由执行主代理 M 落库；
-- 业务模块只经 db.get_connection()/db._write_connection() 访问，不自建第二套存储。

-- 账号级持久删除屏障。session/片段/快照/事件/结算/奖励/outbox 均带创建时 data_epoch；
-- 清理学习数据时推进此值，旧代次的写入与晚到回调一律拒绝。
CREATE TABLE IF NOT EXISTS companion_account_state (
    profile_pk INTEGER PRIMARY KEY,
    data_epoch INTEGER NOT NULL DEFAULT 1,
    account_epoch INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 角色级记忆代次。清空某角色记忆时推进，阻断该角色的晚到润色与旧上下文。
CREATE TABLE IF NOT EXISTS companion_role_state (
    profile_pk INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    role_epoch INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_pk, role_id),
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 严格官方计划快照。items_json 保留三态字段（present/absent/invalid），
-- completeness 非 complete 时 total 必须为 NULL。
CREATE TABLE IF NOT EXISTS companion_plan_snapshots (
    snapshot_id TEXT PRIMARY KEY,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    study_day TEXT NOT NULL,
    task_key TEXT NOT NULL,
    plan_version INTEGER NOT NULL DEFAULT 1,
    plan_fingerprint TEXT NOT NULL,
    fetch_seq INTEGER NOT NULL DEFAULT 0,
    requested_at TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    completeness TEXT NOT NULL CHECK (completeness IN
        ('complete', 'truncated', 'missing_fields', 'plan_unknown', 'limit_reached')),
    total INTEGER,
    item_count INTEGER NOT NULL DEFAULT 0,
    items_json TEXT NOT NULL,
    source TEXT NOT NULL,
    binding_revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS companion_sessions (
    session_id TEXT PRIMARY KEY,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    study_day TEXT NOT NULL,
    canonical_task_key TEXT NOT NULL,
    run_generation INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'completed', 'abandoned')),
    goal_kind TEXT NOT NULL CHECK (goal_kind IN ('session_goal', 'today_plan')),
    target_count INTEGER,
    goal_revision INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    baseline_completed INTEGER NOT NULL DEFAULT 0,
    baseline_snapshot_id TEXT,
    plan_fingerprint TEXT,
    completion_role_id TEXT,
    active_seconds INTEGER NOT NULL DEFAULT 0,
    confirmed_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 同基键只允许一条未终结会话；终态后由服务端分配新的 run_generation。
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_sessions_open
    ON companion_sessions(profile_pk, data_epoch, study_day, canonical_task_key)
    WHERE state IN ('active', 'paused');
CREATE INDEX IF NOT EXISTS idx_companion_sessions_day
    ON companion_sessions(profile_pk, data_epoch, study_day, updated_at DESC);

-- 角色片段：换角色封存旧片段并新建；换服装不换 role_id，因此不产生新片段。
CREATE TABLE IF NOT EXISTS companion_role_segments (
    segment_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    role_name TEXT,
    role_epoch INTEGER NOT NULL DEFAULT 1,
    seq INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    sealed_at TEXT,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_segments_open
    ON companion_role_segments(session_id) WHERE sealed_at IS NULL;

CREATE TABLE IF NOT EXISTS companion_events (
    event_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    role_id TEXT NOT NULL DEFAULT '',
    segment_id TEXT,
    source_instance_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    frame_generation INTEGER NOT NULL DEFAULT 0,
    binding_revision INTEGER NOT NULL DEFAULT 1,
    goal_revision INTEGER NOT NULL DEFAULT 1,
    type TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('intent', 'observed_ack', 'official_snapshot')),
    task_key TEXT,
    item_key TEXT,
    round_key TEXT,
    action TEXT,
    observed_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_companion_events_session
    ON companion_events(session_id, event_pk);
CREATE INDEX IF NOT EXISTS idx_companion_events_evidence
    ON companion_events(session_id, source, type, item_key);

-- 有效时间租约：多窗口按区间并集统计，不信任客户端累计秒数。
CREATE TABLE IF NOT EXISTS companion_activity_leases (
    lease_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    profile_pk INTEGER NOT NULL,
    instance_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_companion_leases_session
    ON companion_activity_leases(session_id, last_seen_at);

CREATE TABLE IF NOT EXISTS companion_settlements (
    settlement_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    completion_role_id TEXT,
    completion_role_name TEXT,
    confirmed_new INTEGER NOT NULL DEFAULT 0,
    confirmed_review INTEGER NOT NULL DEFAULT 0,
    confirmed_total INTEGER NOT NULL DEFAULT 0,
    active_seconds INTEGER NOT NULL DEFAULT 0,
    verified_weak_words_json TEXT NOT NULL DEFAULT '[]',
    evidence_refs_json TEXT NOT NULL DEFAULT '{}',
    goal_snapshot_json TEXT NOT NULL DEFAULT '{}',
    local_message TEXT NOT NULL DEFAULT '',
    ai_state TEXT NOT NULL DEFAULT 'idle',
    ai_message TEXT,
    reward_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_settlements_session
    ON companion_settlements(profile_pk, data_epoch, session_id);

CREATE TABLE IF NOT EXISTS companion_rewards (
    reward_id TEXT PRIMARY KEY,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    session_id TEXT NOT NULL,
    reward_type TEXT NOT NULL,
    period_key TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES companion_sessions(session_id) ON DELETE CASCADE,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_rewards_session
    ON companion_rewards(profile_pk, data_epoch, session_id, reward_type);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_rewards_period
    ON companion_rewards(profile_pk, data_epoch, reward_type, period_key);

-- 记忆派生队列：与奖励同事务入队，消费失败只重试本队列，绝不重复领奖。
CREATE TABLE IF NOT EXISTS companion_outbox (
    outbox_id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    account_epoch INTEGER NOT NULL DEFAULT 1,
    role_epoch INTEGER NOT NULL DEFAULT 1,
    session_id TEXT NOT NULL,
    segment_id TEXT,
    role_id TEXT NOT NULL DEFAULT '',
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    consumed_at TEXT,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_outbox_key
    ON companion_outbox(profile_pk, data_epoch, session_id, COALESCE(segment_id, ''), event_type);
CREATE INDEX IF NOT EXISTS idx_companion_outbox_pending
    ON companion_outbox(profile_pk, data_epoch, status, outbox_id);

CREATE TABLE IF NOT EXISTS companion_memories (
    memory_id TEXT PRIMARY KEY,
    profile_pk INTEGER NOT NULL,
    data_epoch INTEGER NOT NULL,
    role_id TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL,
    source_session_id TEXT,
    source_segment_id TEXT,
    source_revision INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    account_epoch INTEGER NOT NULL DEFAULT 1,
    role_epoch INTEGER NOT NULL DEFAULT 1,
    fact_json TEXT NOT NULL DEFAULT '{}',
    local_text TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    valid INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);
-- 来源唯一：同一账号/代次/角色/来源片段/类型只保留一条派生事实。
-- 用户主动偏好没有来源片段（两者归一到空串），因此每类偏好每角色只有一条。
CREATE UNIQUE INDEX IF NOT EXISTS ux_companion_memory_source
    ON companion_memories(profile_pk, data_epoch, role_id,
        COALESCE(source_session_id, ''), COALESCE(source_segment_id, ''), kind);
CREATE INDEX IF NOT EXISTS idx_companion_memories_role
    ON companion_memories(profile_pk, data_epoch, role_id, valid, occurred_at DESC);

CREATE TABLE IF NOT EXISTS companion_memory_settings (
    profile_pk INTEGER PRIMARY KEY,
    data_epoch INTEGER NOT NULL DEFAULT 1,
    account_epoch INTEGER NOT NULL DEFAULT 1,
    settings_revision INTEGER NOT NULL DEFAULT 1,
    use_enabled INTEGER NOT NULL DEFAULT 1,
    outbound_enabled INTEGER NOT NULL DEFAULT 0,
    retention_days INTEGER NOT NULL DEFAULT 90,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 删除界线：清空之后到达的 outbox / AI 润色结果必须晚于界线才可落库。
CREATE TABLE IF NOT EXISTS companion_memory_deletion_log (
    deletion_id TEXT PRIMARY KEY,
    profile_pk INTEGER NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('role', 'account')),
    role_id TEXT NOT NULL DEFAULT '',
    account_epoch INTEGER NOT NULL,
    role_epoch INTEGER NOT NULL,
    deleted_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

-- 受控上下文票据：出站授权关闭或在途期间撤销后，服务端在转发前核验即拒。
CREATE TABLE IF NOT EXISTS companion_context_tickets (
    ticket_id TEXT PRIMARY KEY,
    profile_pk INTEGER NOT NULL,
    role_id TEXT NOT NULL,
    data_epoch INTEGER NOT NULL,
    account_epoch INTEGER NOT NULL,
    role_epoch INTEGER NOT NULL,
    settings_revision INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (profile_pk) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_records_due
    ON study_records(profile_id, is_active, next_study_date);
CREATE INDEX IF NOT EXISTS idx_records_last_study
    ON study_records(profile_id, last_study_date);
CREATE INDEX IF NOT EXISTS idx_snapshots_day
    ON study_record_snapshots(profile_id, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_recommend_day
    ON recommendations(profile_id, recommend_date, status);
CREATE INDEX IF NOT EXISTS idx_sync_runs_profile
    ON sync_runs(profile_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_segments_run
    ON sync_segments(profile_id, source, complete, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_live2d_models_character
    ON live2d_models(character_id, complete, updated_at DESC);
