"use strict";

const { getDatabase } = require("../../connection");

class VerificationStateNonceRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    create(data) {
        const now = Date.now();
        const expiresAt = data.expiresAt instanceof Date
            ? data.expiresAt.getTime()
            : Number(data.expiresAt);

        const stmt = this.db.prepare(`
            INSERT INTO verification_state_nonce (
                nonce_hash, guild_id, role_id, expected_user_id,
                panel_revision, status, created_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        try {
            const info = stmt.run(
                String(data.nonceHash),
                String(data.guildId),
                String(data.roleId),
                data.expectedUserId ? String(data.expectedUserId) : null,
                data.panelRevision ? String(data.panelRevision) : null,
                String(data.status || "pending"),
                data.createdAt instanceof Date ? data.createdAt.getTime() : (Number(data.createdAt) || now),
                expiresAt
            );
            return this.findById(info.lastInsertRowid);
        } catch (err) {
            if (err.message && err.message.includes("UNIQUE constraint failed")) {
                const dupErr = new Error(`E11000 duplicate key error collection: verification_state_nonces index: nonceHash_1 dup key: { nonceHash: "${data.nonceHash}" }`);
                dupErr.code = 11000;
                dupErr.keyPattern = { nonceHash: 1 };
                dupErr.keyValue = { nonceHash: data.nonceHash };
                throw dupErr;
            }
            throw err;
        }
    }

    findById(id) {
        const row = this.db.prepare("SELECT * FROM verification_state_nonce WHERE id = ?").get(id);
        return row ? this._hydrate(row) : null;
    }

    findByNonceHash(nonceHash) {
        if (!nonceHash) return null;
        const row = this.db.prepare("SELECT * FROM verification_state_nonce WHERE nonce_hash = ?").get(String(nonceHash));
        return row ? this._hydrate(row) : null;
    }

    exists(filter = {}) {
        return this.countDocuments(filter) > 0;
    }

    countDocuments(filter = {}) {
        const conditions = [];
        const params = [];

        if (filter.nonceHash) {
            conditions.push("nonce_hash = ?");
            params.push(String(filter.nonceHash));
        }
        if (filter.guildId) {
            conditions.push("guild_id = ?");
            params.push(String(filter.guildId));
        }
        if (filter.roleId) {
            conditions.push("role_id = ?");
            params.push(String(filter.roleId));
        }
        if (filter.status) {
            conditions.push("status = ?");
            params.push(String(filter.status));
        }
        if (filter.expiresAt && filter.expiresAt.$gt) {
            const gtVal = filter.expiresAt.$gt instanceof Date
                ? filter.expiresAt.$gt.getTime()
                : Number(filter.expiresAt.$gt);
            conditions.push("expires_at > ?");
            params.push(gtVal);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const query = `SELECT COUNT(*) AS count FROM verification_state_nonce ${whereClause}`;
        const row = this.db.prepare(query).get(...params);
        return row ? Number(row.count) : 0;
    }

    count(filter = {}) {
        return this.countDocuments(filter);
    }

    consume({ nonceHash, guildId, roleId, now = Date.now() }) {
        const stmt = this.db.prepare(`
            UPDATE verification_state_nonce
            SET status = 'consumed', consumed_at = ?
            WHERE nonce_hash = ?
              AND guild_id = ?
              AND role_id = ?
              AND status = 'pending'
              AND expires_at > ?
        `);

        const info = stmt.run(now, String(nonceHash), String(guildId), String(roleId), now);
        return info.changes === 1;
    }

    cleanExpired(now = Date.now(), limit = 500) {
        const stmt = this.db.prepare(`
            DELETE FROM verification_state_nonce
            WHERE id IN (
                SELECT id FROM verification_state_nonce
                WHERE expires_at <= ?
                LIMIT ?
            )
        `);
        const info = stmt.run(now, limit);
        return info.changes;
    }

    deleteExpired(now = Date.now(), limit = 500) {
        return this.cleanExpired(now, limit);
    }

    _hydrate(row) {
        return {
            _id: String(row.id),
            id: row.id,
            nonceHash: row.nonce_hash,
            guildId: row.guild_id,
            roleId: row.role_id,
            expectedUserId: row.expected_user_id,
            panelRevision: row.panel_revision,
            status: row.status,
            createdAt: new Date(row.created_at),
            consumedAt: row.consumed_at ? new Date(row.consumed_at) : null,
            expiresAt: new Date(row.expires_at)
        };
    }
}

module.exports = VerificationStateNonceRepository;
