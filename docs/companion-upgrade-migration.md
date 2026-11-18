# 陪伴升级迁移与回滚说明

更新：2026-11-16。适用于 `D:\MeMo1` 当前工作副本。

## 1. 改动性质

**全部是加法。** 没有任何既有表被改结构、没有任何既有列被重命名或删除、没有任何
既有数据行被更新。具体来说：

- `sqlite_schema.sql` 新增 14 张 `companion_*` 表 + 7 个部分唯一索引。
- 既有表（`profiles`、`study_records`、`study_record_snapshots`、`daily_stats`、
  `recommendations`、`sync_runs`、`sync_segments`、`live2d_models`、
  `live2d_preferences`）的结构与内容未动。
- `schema_migrations` 未新增版本行。因此**旧版本程序仍能打开新库**——它只是不认识
  那 14 张表。

这意味着升级是"打开即用"，回滚是"换回旧程序"，都不需要数据转换。

## 2. 升级步骤

1. 停止应用。
2. 备份数据目录（见 §3）。
3. 替换程序文件。
4. 启动。首次访问陪伴功能时数据库会自动建出 14 张新表（`CREATE TABLE IF NOT EXISTS`）。

无需手工执行 SQL。`db.init_db()` 会在既有库上幂等执行 schema。

## 3. 备份与恢复

### 备份

```powershell
cd D:\MeMo1
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
Copy-Item data\memo-superform.db "data\memo-superform.db.bak-$stamp"
# 角色包与语音资源也建议一起备份
Copy-Item data\role_packages "data\role_packages.bak-$stamp" -Recurse -ErrorAction SilentlyContinue
Copy-Item data\tts_pack "data\tts_pack.bak-$stamp" -Recurse -ErrorAction SilentlyContinue
```

SQLite 在 WAL 模式下，`memo-superform.db` 旁边可能有 `-wal` / `-shm`。**应用运行时**
直接复制 `.db` 可能拿到不完整状态。两种安全做法：

- 停应用后复制；或
- 运行 `sqlite3 data\memo-superform.db ".backup 'data\backup.db'"`。

### 恢复

1. 停止应用。
2. 删除 `memo-superform.db` 及同目录 `-wal` / `-shm`。
3. 把备份文件改回 `memo-superform.db`。
4. 启动。

`companion_*` 表缺失时陪伴功能会视为"从未使用"，学习数据本身不受影响。

## 4. 回滚

因为改动是加法：

1. 停止应用。
2. 换回旧程序文件。
3. 启动。

旧程序不会读 `companion_*` 表，也不会因为它们的**存在**而出错（SQLite 允许无关表）。
如果希望彻底清干净：

```sql
DROP TABLE IF EXISTS companion_context_tickets;
DROP TABLE IF EXISTS companion_memory_deletion_log;
DROP TABLE IF EXISTS companion_memory_settings;
DROP TABLE IF EXISTS companion_memories;
DROP TABLE IF EXISTS companion_outbox;
DROP TABLE IF EXISTS companion_rewards;
DROP TABLE IF EXISTS companion_settlements;
DROP TABLE IF EXISTS companion_activity_leases;
DROP TABLE IF EXISTS companion_events;
DROP TABLE IF EXISTS companion_role_segments;
DROP TABLE IF EXISTS companion_sessions;
DROP TABLE IF EXISTS companion_plan_snapshots;
DROP TABLE IF EXISTS companion_role_state;
DROP TABLE IF EXISTS companion_account_state;
```

删除顺序按外键依赖排列（先子表后父表）。**不要把这一步当默认操作**：它会让全部
长期记忆与结算历史永久消失。

角色包资源可以单独回滚：删除 `data/role_packages/`（安装来源记录与暂存）与
`data/tts_pack/roles/<新角色>/`；`roles.json` 中的既有角色条目不受影响。

## 5. 数据重置的两种语义（重要）

系统区分三个独立的代次，删除屏障不同：

| 代次 | 何时推进 | 影响 |
| --- | --- | --- |
| `data_epoch` | 用户删除本机学习数据 | 全部会话、结算、奖励、记忆快照失效 |
| `account_epoch` | 换绑/重连账号 | 归属该账号的派生数据失效 |
| `role_epoch` | 重置**单个角色**的记忆 | 只影响该角色的记忆，不影响奖励 |

推进代次是**软删除**：旧行留在表里但被过滤掉，因此误删后仍可由后续版本实现"恢复"。
`companion_memory_deletion_log` 记录每次删除的时机与范围。

## 6. 三套学习库的隔离

以下三个目录**始终独立**，任何测试与代码路径都不得交叉写入：

- `D:\MeMo1\data`
- `D:\MeMo1\dist\data`
- `D:\MeMo1\MemoSuperform-v0.75-portable\data`

本轮所有测试都使用 `_verification/` 下的临时 `MEMO_DATA_DIR`。运行测试时务必显式设置：

```powershell
$env:MEMO_DATA_DIR = "D:\MeMo1\_verification\companion-upgrade\agents\M\manual"
```

漏设会让测试初始化真实库。本轮发生过一次，随后用
`_verification/companion-upgrade/audit_real_db.py` 确认：原有 12 张表计数全部未变，
只多出 14 张空的 `companion_*` 表。

## 7. 角色包回滚

角色包安装是**逐角色事务**：

- 一个角色失败只回滚该角色（`roles.json`、`persona.json`、角色目录文件全部复原），
  其余角色照常提交。
- 新建角色失败时会删掉本次创建的目录；升级失败时恢复原清单与原资源。
- 升级沿用同一 `role_id`，因此**长期记忆不会因为升级丢失**。

作业日志在 `data/role_packages/journals/<job_id>.json`。启动时
`role_package_service.recover_pending()` 会把中断的作业标记为 `recovering`，
已提交的角色保留，由用户决定是否重装。