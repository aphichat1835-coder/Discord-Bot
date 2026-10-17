"use strict";

const { getDatabase } = require("../../connection");

function mapLockRow(row) {
    if (!row) return null;
    return {
        guildId: String(row.guild_id),
        userId: String(row.user_id),
        muteLocked: row.mute_locked === 1,
        deafLocked: row.deaf_locked === 1,
        muteLockedBy: row.mute_locked_by ? String(row.mute_locked_by) : null,
        deafLockedBy: row.deaf_locked_by ? String(row.deaf_locked_by) : null,
        muteLockedAt: row.mute_locked_at ? Number(row.mute_locked_at) : null,
        deafLockedAt: row.deaf_locked_at ? Number(row.deaf_locked_at) : null,
        muteVersion: row.mute_version ? String(row.mute_version) : null,
        deafVersion: row.deaf_version ? String(row.deaf_version) : null,
        muteOwnerForced: row.mute_owner_forced === 1,
        lockedBy: row.locked_by ? String(row.locked_by) : null,
        updatedAt: Number(row.updated_at || 0)
    };
}

function mapNoticeRow(row) {
    if (!row) return null;
    return {
        guildId: String(row.guild_id),
        actorId: String(row.actor_id),
        targetId: String(row.target_id),
        channelId: String(row.channel_id),
        messageId: String(row.message_id),
        notifiedAt: new Date(Number(row.notified_at))
    };
}

class VoiceAdminRepository {
    constructor(db = null) {
        this.getDb = () => db || getDatabase();
    }

    listActiveLocks() {
        const db = this.getDb();
        const rows = db.prepare(`
            SELECT * FROM voice_admin_locks 
            WHERE mute_locked = 1 OR deaf_locked = 1
        `).all();
        return rows.map(mapLockRow);
    }

    getLock(guildId, userId) {
        if (!guildId || !userId) return null;
        const db = this.getDb();
        const row = db.prepare(`
            SELECT * FROM voice_admin_locks 
            WHERE guild_id = ? AND user_id = ?
        `).get(String(guildId), String(userId));
        return mapLockRow(row);
    }

    writeLock(params) {
        const {
            guildId,
            userId,
            type,
            actorId,
            expectedVersion,
            ownerForced = false,
            lockedAt = Date.now(),
            version,
            now = Date.now()
        } = params;

        const db = this.getDb();
        const isMute = type === "mute";

        if (expectedVersion === undefined) {
            // Upsert write
            const stmt = isMute
                ? db.prepare(`
                    INSERT INTO voice_admin_locks (
                        guild_id, user_id, mute_locked, deaf_locked,
                        mute_locked_by, deaf_locked_by, mute_locked_at, deaf_locked_at,
                        mute_version, deaf_version, mute_owner_forced, locked_by, updated_at
                    ) VALUES (
                        ?, ?, 1, 0,
                        ?, NULL, ?, NULL,
                        ?, NULL, ?, ?, ?
                    )
                    ON CONFLICT(guild_id, user_id) DO UPDATE SET
                        mute_locked = 1,
                        mute_locked_by = excluded.mute_locked_by,
                        mute_locked_at = excluded.mute_locked_at,
                        mute_version = excluded.mute_version,
                        mute_owner_forced = excluded.mute_owner_forced,
                        locked_by = excluded.locked_by,
                        updated_at = excluded.updated_at
                `)
                : db.prepare(`
                    INSERT INTO voice_admin_locks (
                        guild_id, user_id, mute_locked, deaf_locked,
                        mute_locked_by, deaf_locked_by, mute_locked_at, deaf_locked_at,
                        mute_version, deaf_version, mute_owner_forced, locked_by, updated_at
                    ) VALUES (
                        ?, ?, 0, 1,
                        NULL, ?, NULL, ?,
                        NULL, ?, 0, ?, ?
                    )
                    ON CONFLICT(guild_id, user_id) DO UPDATE SET
                        deaf_locked = 1,
                        deaf_locked_by = excluded.deaf_locked_by,
                        deaf_locked_at = excluded.deaf_locked_at,
                        deaf_version = excluded.deaf_version,
                        locked_by = excluded.locked_by,
                        updated_at = excluded.updated_at
                `);

            const result = isMute
                ? stmt.run(
                    String(guildId), String(userId),
                    String(actorId), lockedAt,
                    String(version), ownerForced ? 1 : 0, String(actorId), now
                )
                : stmt.run(
                    String(guildId), String(userId),
                    String(actorId), lockedAt,
                    String(version), String(actorId), now
                );

            return {
                acknowledged: true,
                matchedCount: result.changes > 0 ? 1 : 0,
                upsertedCount: result.changes > 0 ? 1 : 0,
                changes: result.changes
            };
        }

        // Version-bound update
        const verCol = isMute ? "mute_version" : "deaf_version";
        const lockCol = isMute ? "mute_locked" : "deaf_locked";
        const byCol = isMute ? "mute_locked_by" : "deaf_locked_by";
        const atCol = isMute ? "mute_locked_at" : "deaf_locked_at";

        const sql = isMute
            ? `UPDATE voice_admin_locks SET 
                ${lockCol} = 1, ${byCol} = ?, ${atCol} = ?, ${verCol} = ?, 
                mute_owner_forced = ?, locked_by = ?, updated_at = ? 
               WHERE guild_id = ? AND user_id = ? AND ${verCol} = ?`
            : `UPDATE voice_admin_locks SET 
                ${lockCol} = 1, ${byCol} = ?, ${atCol} = ?, ${verCol} = ?, 
                locked_by = ?, updated_at = ? 
               WHERE guild_id = ? AND user_id = ? AND ${verCol} = ?`;

        const stmt = db.prepare(sql);
        const result = isMute
            ? stmt.run(
                String(actorId), lockedAt, String(version),
                ownerForced ? 1 : 0, String(actorId), now,
                String(guildId), String(userId), String(expectedVersion)
            )
            : stmt.run(
                String(actorId), lockedAt, String(version),
                String(actorId), now,
                String(guildId), String(userId), String(expectedVersion)
            );

        return {
            acknowledged: true,
            matchedCount: result.changes,
            upsertedCount: 0,
            changes: result.changes
        };
    }

    clearLockField(guildId, userId, type, expectedVersion, newVersion, now = Date.now()) {
        const db = this.getDb();
        const isMute = type === "mute";
        const verCol = isMute ? "mute_version" : "deaf_version";
        const lockCol = isMute ? "mute_locked" : "deaf_locked";
        const byCol = isMute ? "mute_locked_by" : "deaf_locked_by";
        const atCol = isMute ? "mute_locked_at" : "deaf_locked_at";

        const sql = `UPDATE voice_admin_locks SET 
            ${lockCol} = 0, ${byCol} = NULL, ${atCol} = NULL, 
            ${verCol} = ?, updated_at = ? 
            ${isMute ? ", mute_owner_forced = 0" : ""}
            WHERE guild_id = ? AND user_id = ? AND ${verCol} = ?`;

        const result = db.prepare(sql).run(
            String(newVersion), now,
            String(guildId), String(userId), String(expectedVersion)
        );

        return {
            acknowledged: true,
            matchedCount: result.changes,
            changes: result.changes
        };
    }

    clearBothLocks(guildId, userId, expected, versions, now = Date.now()) {
        const db = this.getDb();
        let sql = `UPDATE voice_admin_locks SET 
            mute_locked = 0, deaf_locked = 0, 
            mute_locked_by = NULL, deaf_locked_by = NULL, 
            mute_locked_at = NULL, deaf_locked_at = NULL, 
            mute_version = ?, deaf_version = ?, 
            mute_owner_forced = 0, updated_at = ? 
            WHERE guild_id = ? AND user_id = ?`;

        const params = [String(versions.mute), String(versions.deaf), now, String(guildId), String(userId)];

        if (expected?.mute !== undefined) {
            sql += " AND mute_version = ?";
            params.push(String(expected.mute));
        }
        if (expected?.deaf !== undefined) {
            sql += " AND deaf_version = ?";
            params.push(String(expected.deaf));
        }

        const result = db.prepare(sql).run(...params);
        return {
            acknowledged: true,
            matchedCount: result.changes,
            changes: result.changes
        };
    }

    deleteLock(guildId, userId, expectedVersion = null, type = "mute") {
        const db = this.getDb();
        let sql = "DELETE FROM voice_admin_locks WHERE guild_id = ? AND user_id = ?";
        const params = [String(guildId), String(userId)];
        if (expectedVersion) {
            const verCol = type === "mute" ? "mute_version" : "deaf_version";
            sql += ` AND ${verCol} = ?`;
            params.push(String(expectedVersion));
        }
        const result = db.prepare(sql).run(...params);
        return {
            acknowledged: true,
            deletedCount: result.changes
        };
    }

    deleteGuildLocks(guildId) {
        const db = this.getDb();
        const result = db.prepare("DELETE FROM voice_admin_locks WHERE guild_id = ?").run(String(guildId));
        return {
            acknowledged: true,
            deletedCount: result.changes
        };
    }

    upsertNotice(notice) {
        const db = this.getDb();
        const notifiedAtMs = notice.notifiedAt instanceof Date ? notice.notifiedAt.getTime() : Number(notice.notifiedAt || Date.now());
        const stmt = db.prepare(`
            INSERT INTO voice_admin_notices (
                guild_id, actor_id, target_id, channel_id, message_id, notified_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(guild_id, actor_id, target_id) DO UPDATE SET
                channel_id = excluded.channel_id,
                message_id = excluded.message_id,
                notified_at = excluded.notified_at
        `);
        const result = stmt.run(
            String(notice.guildId),
            String(notice.actorId),
            String(notice.targetId),
            String(notice.channelId),
            String(notice.messageId),
            notifiedAtMs
        );
        return {
            acknowledged: true,
            changes: result.changes,
            matchedCount: result.changes > 0 ? 1 : 0,
            upsertedCount: result.changes > 0 ? 1 : 0
        };
    }

    listRecentNotices(cutoffTimestamp) {
        const db = this.getDb();
        const rows = db.prepare(`
            SELECT * FROM voice_admin_notices 
            WHERE notified_at >= ?
        `).all(Number(cutoffTimestamp));
        return rows.map(mapNoticeRow);
    }

    deleteNotice(guildId, actorId, targetId) {
        const db = this.getDb();
        const result = db.prepare(`
            DELETE FROM voice_admin_notices 
            WHERE guild_id = ? AND actor_id = ? AND target_id = ?
        `).run(String(guildId), String(actorId), String(targetId));
        return {
            acknowledged: true,
            deletedCount: result.changes
        };
    }

    deleteMemberNotices(guildId, userId) {
        const db = this.getDb();
        const result = db.prepare(`
            DELETE FROM voice_admin_notices 
            WHERE guild_id = ? AND (actor_id = ? OR target_id = ?)
        `).run(String(guildId), String(userId), String(userId));
        return {
            acknowledged: true,
            deletedCount: result.changes
        };
    }

    deleteGuildNotices(guildId) {
        const db = this.getDb();
        const result = db.prepare("DELETE FROM voice_admin_notices WHERE guild_id = ?").run(String(guildId));
        return {
            acknowledged: true,
            deletedCount: result.changes
        };
    }
}

module.exports = VoiceAdminRepository;
