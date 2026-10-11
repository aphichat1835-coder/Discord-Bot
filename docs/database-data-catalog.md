# Database Data Catalog

Updated: 2026-09-23

This document lists the schema catalog across both MongoDB Atlas and local SQLite stores.

---

## 1. MongoDB Models (Authoritative & Security Core)

All 17 models are centralized in `database/mongo/models/`.

| Model Name | Category | Primary Function | Retention Policy |
| :--- | :--- | :--- | :--- |
| `GuildConfig` | Verification | Per-guild verification settings, role bindings, and policies. | Permanent |
| `VerifyLog` | Verification | Audit trail of member verification attempts, decisions, and evidence. | 90 days / Permanent |
| `OAuthUser` | Identity | OAuth access/refresh tokens and primary Discord user identity. | Permanent / Revocation |
| `OAuthMemberSnapshot` | Snapshots | Complete guild member state capture at verification time. | Configurable snapshot retention |
| `OAuthMemberRoleSnapshot` | Snapshots | Role assignments recorded during verification. | Configurable snapshot retention |
| `OAuthUserProfileSnapshot` | Snapshots | Detailed profile data (avatar, banner, bio, nitro) snapshot. | Configurable snapshot retention |
| `OAuthUserGuildSnapshot` | Snapshots | Mutual guilds and membership state snapshot. | Configurable snapshot retention |
| `OAuthUserConnectionSnapshot`| Snapshots | Connected third-party accounts (Steam, GitHub, etc.). | Configurable snapshot retention |
| `OAuthObjectChunkSnapshot` | Snapshots | Chunked payload storage for large snapshot payloads. | Matched to parent snapshot |
| `OAuthSnapshotRecovery` | Snapshots | Recovery checkpoints for multipart snapshot processing. | Transient / 7 days |
| `IpIdentityLink` | Security | Association mapping between IP address and Discord accounts. | Permanent security audit |
| `IpIdentityUserHistory` | Security | Historical timeline of IP addresses used per user. | Permanent security audit |
| `IpIdentityDeviceHistory` | Security | Device fingerprints and user agents seen per IP. | Permanent security audit |
| `IpIdentityRoleHistory` | Security | Role escalations and changes correlated with IP. | Permanent security audit |
| `PrivacyDeletionJob` | Compliance | GDPR / owner data deletion jobs with execution proof. | Permanent audit log |
| `VerificationMigrationArchive`| Migration | Archive storage for pre-migration verification snapshots. | 180 days |
| `VerificationMigrationState` | Migration | Tracking state for active/completed verification migrations. | Permanent |

---

## 2. SQLite Tables (Local Operational & High-Frequency Store)

All tables are defined in `database/sqlite/migrations/` and accessed via `database/repositories/`.

### Core Operational Tables (`001_initial_core.sql` & `004_session_runtime_and_assets.sql`)
| Table Name | Entity / Subsystem | Description | Indexes / Constraints |
| :--- | :--- | :--- | :--- |
| `schema_migrations` | System | Tracks executed migration versions and checksums. | `PRIMARY KEY (version)` |
| `database_meta` | System | Key-value store for internal database engine state. | `PRIMARY KEY (key)` |
| `maintenance_runs` | Maintenance | History of vacuum, cleanup, and quota evaluation runs. | `idx_maintenance_runs_type_started` |
| `quest_logs` | Quests | Quest execution records, run state, and metadata. | `idx_quest_logs_created_at`, `idx_quest_logs_status` |
| `quest_accounts` | Quests | Per-account run details within a quest execution. | Foreign key to `quest_logs(id)` ON DELETE CASCADE |
| `quest_details` | Quests | Step-by-step progress tracking for quest accounts. | Foreign key to `quest_accounts(id)` ON DELETE CASCADE |
| `scheduled_runners` | Quests | Cron/interval schedules for automated quest execution. | `UNIQUE (name)`, `idx_scheduled_runners_status` |
| `dm_notifications` | Notification Queue | Queue worker for DM dispatch with atomic leasing. | `idx_dm_notifications_queue`, `idx_dm_notifications_recipient`, `idx_dm_notifications_expires_at`, `UNIQUE (event_key)` |
| `verification_recovery`| Verification Temp | Multi-stage verification session recovery state. | `idx_verification_recovery_status_updated`, `idx_verification_recovery_guild_user`, `UNIQUE (request_id)` |
| `verification_state_nonce`| Ephemeral Auth | Short-lived nonces validating OAuth callback authenticity. | `idx_verification_nonce_expires`, `idx_verification_nonce_guild`, `UNIQUE (nonce_hash)` |
| `voice_session_runtime`| Voice Runtime | Offloads 60s heartbeats and active runtime state from Atlas. | `PRIMARY KEY (session_id)`, `idx_voice_session_runtime_server_owner`, `idx_voice_session_runtime_heartbeat` |

### History & Telemetry Tables (`002_history_events.sql`)
| Table Name | Entity / Subsystem | Description | Retention |
| :--- | :--- | :--- | :--- |
| `voice_events` | Voice Subsystem | Voice worker transitions, join/leave, AutoDeaf events. | Dynamic: `SQLITE_HISTORY_RETENTION_DAYS` (default 30 days) |
| `command_events` | Slash Commands | Execution metrics and timing of slash interactions. | Dynamic: `SQLITE_HISTORY_RETENTION_DAYS` (default 30 days) |
| `session_events` | Token Coordinator | Concurrency, backoff, and quarantine lifecycle events. | Dynamic: `SQLITE_HISTORY_RETENTION_DAYS` (default 30 days) |
| `runtime_events` | System Lifecycle | Startup, shutdown, shard resumes, and health alerts. | Dynamic: `SQLITE_HISTORY_RETENTION_DAYS` (default 30 days) |

### Cache Subsystem Tables (`003_cache_subsystem.sql` & `004_session_runtime_and_assets.sql`)
| Table Name | Namespace | Description | Retention / Quota Policy |
| :--- | :--- | :--- | :--- |
| `cache_entries` | Generic Cache | Fast key-value store with namespace isolation & priority. | Policy-based (1h - 24h, maxRows bounded) |
| `asset_cache` | Assets & Files | Filesystem metadata for binary assets stored in `SQLITE_ASSET_DIR`. | **Avatar**: 3 days<br>**Server Icon**: 14 days<br>**Default**: 7 days<br>**Max Directory Size**: 500 MB (LRU evicted when exceeding limit) |

---

## 3. Data Integrity & Migration Principles

1. **Schema Migrations**:
   - Sequential, idempotent SQL files evaluated inside a single transaction per migration.
   - Guarded by `PRAGMA user_version`.
2. **Error Code Emulation**:
   - `DmNotificationRepository` and `VerificationStateNonceRepository` translate SQLite unique constraint violations (`SQLITE_CONSTRAINT_UNIQUE`) into Mongoose-compatible error objects (`code: 11000`) to guarantee drop-in compatibility.
3. **Write-Behind History Buffer**:
   - High-throughput history events (`voice_events`, etc.) are held in RAM and flushed in transactions every 10 seconds or on process shutdown.
4. **P0 Durability Emergency Journal**:
   - Critical operational events (P0) feature out-of-band disk journaling (`p0Journal.js` / `data/p0-emergency.journal`) guaranteeing zero data loss if SQLite is locked or facing storage backpressure.
5. **Telemetry Sanitization & Credential Shield**:
   - `command_events` and `session_events` pass through recursive sanitization that redacts tokens/credentials and truncates object depth at `>= 5` (`[REDACTED_NESTED]`).
6. **Asset Cache Orphan File Prevention**:
   - `asset_cache` uses atomic disk file writes accompanied by an immediate `unlinkSync` rollback if SQLite metadata insertion fails, ensuring no unreferenced binary files accumulate in `SQLITE_ASSET_DIR`.
