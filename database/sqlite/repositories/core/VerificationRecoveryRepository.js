"use strict";

const { getDatabase } = require("../../connection");

class VerificationRecoveryRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    create(data) {
        const now = Date.now();
        const persistenceJson = typeof data.persistence === "string"
            ? data.persistence
            : JSON.stringify(data.persistence || {});

        const stmt = this.db.prepare(`
            INSERT INTO verification_recovery (
                request_id, guild_id, user_id, role_id, result, status,
                persistence_json, role_applied, rollback_attempted, rollback_succeeded,
                reason, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const info = stmt.run(
            String(data.requestId),
            String(data.guildId),
            String(data.userId),
            data.roleId ? String(data.roleId) : null,
            String(data.result),
            String(data.status || "pending"),
            persistenceJson,
            data.roleApplied ? 1 : 0,
            data.rollbackAttempted ? 1 : 0,
            data.rollbackSucceeded ? 1 : 0,
            data.reason ? String(data.reason) : null,
            Number(data.createdAt) || now,
            Number(data.updatedAt) || now
        );

        return this.findById(info.lastInsertRowid);
    }

    findById(id) {
        const row = this.db.prepare("SELECT * FROM verification_recovery WHERE id = ?").get(id);
        return row ? this._hydrate(row) : null;
    }

    findOne(filter = {}) {
        if (filter.requestId) {
            const row = this.db.prepare("SELECT * FROM verification_recovery WHERE request_id = ?").get(String(filter.requestId));
            return row ? this._hydrate(row) : null;
        }
        return null;
    }

    updateOne(filter = {}, updateData = {}) {
        const requestId = filter.requestId;
        if (!requestId) return { matchedCount: 0, modifiedCount: 0 };

        const set = updateData.$set ? { ...updateData.$set, ...updateData } : updateData;
        delete set.$set;
        delete set.$setOnInsert;

        const setClauses = [];
        const values = [];

        if (set.status !== undefined) {
            setClauses.push("status = ?");
            values.push(String(set.status));
        }
        if (set.result !== undefined) {
            setClauses.push("result = ?");
            values.push(String(set.result));
        }
        if (set.roleId !== undefined) {
            setClauses.push("role_id = ?");
            values.push(set.roleId ? String(set.roleId) : null);
        }
        if (set.roleApplied !== undefined) {
            setClauses.push("role_applied = ?");
            values.push(set.roleApplied ? 1 : 0);
        }
        if (set.rollbackAttempted !== undefined) {
            setClauses.push("rollback_attempted = ?");
            values.push(set.rollbackAttempted ? 1 : 0);
        }
        if (set.rollbackSucceeded !== undefined) {
            setClauses.push("rollback_succeeded = ?");
            values.push(set.rollbackSucceeded ? 1 : 0);
        }
        if (set.reason !== undefined) {
            setClauses.push("reason = ?");
            values.push(set.reason ? String(set.reason) : null);
        }
        if (set.persistence !== undefined) {
            setClauses.push("persistence_json = ?");
            values.push(typeof set.persistence === "string" ? set.persistence : JSON.stringify(set.persistence || {}));
        }

        const now = Date.now();
        setClauses.push("updated_at = ?");
        values.push(now);

        // Check if existing record exists
        const existing = this.findOne({ requestId });
        if (!existing) {
            // Upsert insert
            return this.create({
                requestId,
                guildId: set.guildId || filter.guildId,
                userId: set.userId || filter.userId,
                roleId: set.roleId,
                result: set.result || "unknown",
                status: set.status || "pending",
                persistence: set.persistence,
                roleApplied: set.roleApplied,
                rollbackAttempted: set.rollbackAttempted,
                rollbackSucceeded: set.rollbackSucceeded,
                reason: set.reason,
                createdAt: now,
                updatedAt: now
            });
        }

        values.push(String(requestId));
        const res = this.db.prepare(`UPDATE verification_recovery SET ${setClauses.join(", ")} WHERE request_id = ?`).run(...values);
        return { matchedCount: res.changes, modifiedCount: res.changes };
    }

    deleteMany(filter = {}) {
        const conditions = [];
        const params = [];

        if (filter.guildId) {
            conditions.push("guild_id = ?");
            params.push(String(filter.guildId));
        }
        if (filter.userId) {
            conditions.push("user_id = ?");
            params.push(String(filter.userId));
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const res = this.db.prepare(`DELETE FROM verification_recovery ${whereClause}`).run(...params);
        return { deletedCount: res.changes };
    }

    countDocuments(filter = {}) {
        const conditions = [];
        const params = [];

        if (filter.guildId) {
            conditions.push("guild_id = ?");
            params.push(String(filter.guildId));
        }
        if (filter.userId) {
            conditions.push("user_id = ?");
            params.push(String(filter.userId));
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const row = this.db.prepare(`SELECT count(*) as count FROM verification_recovery ${whereClause}`).get(...params);
        return row ? row.count : 0;
    }

    _hydrate(row) {
        let persistence = {};
        try {
            persistence = JSON.parse(row.persistence_json);
        } catch (_) {}

        return {
            _id: String(row.id),
            id: row.id,
            requestId: row.request_id,
            guildId: row.guild_id,
            userId: row.user_id,
            roleId: row.role_id,
            result: row.result,
            status: row.status,
            persistence,
            roleApplied: Boolean(row.role_applied),
            rollbackAttempted: Boolean(row.rollback_attempted),
            rollbackSucceeded: Boolean(row.rollback_succeeded),
            reason: row.reason,
            createdAt: row.created_at,
            updatedAt: row.updated_at
        };
    }
}

module.exports = VerificationRecoveryRepository;
