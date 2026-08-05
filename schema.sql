-- MemoSuperform T-SQL 架构
-- 由 db.py init_db() 在 MemoSuperform 数据库中执行（幂等）

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'study_records')
CREATE TABLE study_records (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    snapshot_date DATE NOT NULL,
    word NVARCHAR(200) NOT NULL,
    definition NVARCHAR(1000) NULL,
    add_date DATE NULL,
    last_study_date DATE NULL,
    next_study_date DATE NULL,
    last_response NVARCHAR(50) NULL,
    created_at DATETIME NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'daily_stats')
CREATE TABLE daily_stats (
    stat_date DATE PRIMARY KEY,
    total_words INT NOT NULL DEFAULT 0,
    new_words INT NOT NULL DEFAULT 0,
    reviewed_words INT NOT NULL DEFAULT 0,
    familiar_count INT NOT NULL DEFAULT 0,
    vague_count INT NOT NULL DEFAULT 0,
    forget_count INT NOT NULL DEFAULT 0,
    overdue_count INT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'recommendations')
CREATE TABLE recommendations (
    id BIGINT IDENTITY(1,1) PRIMARY KEY,
    recommend_date DATE NOT NULL,
    word NVARCHAR(200) NOT NULL,
    definition NVARCHAR(1000) NULL,
    risk_score INT NOT NULL DEFAULT 0,
    overdue_days INT NOT NULL DEFAULT 0,
    gap_days INT NOT NULL DEFAULT 0,
    last_response NVARCHAR(50) NULL,
    next_study_date DATE NULL,
    status NVARCHAR(20) NOT NULL DEFAULT 'pending',
    reviewed_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'settings')
CREATE TABLE settings (
    key_name NVARCHAR(100) PRIMARY KEY,
    value_text NVARCHAR(MAX) NULL,
    updated_at DATETIME NOT NULL DEFAULT GETDATE()
);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_study_snapshot' AND object_id = OBJECT_ID('study_records'))
CREATE INDEX idx_study_snapshot ON study_records(snapshot_date);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_study_word' AND object_id = OBJECT_ID('study_records'))
CREATE INDEX idx_study_word ON study_records(word);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_recommend_date' AND object_id = OBJECT_ID('recommendations'))
CREATE INDEX idx_recommend_date ON recommendations(recommend_date);

IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_recommend_status' AND object_id = OBJECT_ID('recommendations'))
CREATE INDEX idx_recommend_status ON recommendations(recommend_date, status);