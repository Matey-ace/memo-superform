-- Memo Superform SQLite schema (v0.70)
-- This file is the runtime source of truth.  schema.sql is retained only for
-- read-only imports from the legacy SQL Server database.

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

-- The current state of a word.  The stable upstream voc_id, not its spelling,
-- is the identity so that duplicate spellings remain distinct.
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

-- Daily snapshots are append-only once their date has passed.  They allow old
-- charts/statistics to stay stable while study_records keeps the current state.
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

-- A marker makes an empty array a valid, completed daily snapshot.
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

-- Hashes and metadata of records returned by the cheap "today" probe.
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
