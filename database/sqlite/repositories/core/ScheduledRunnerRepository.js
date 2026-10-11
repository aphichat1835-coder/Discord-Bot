"use strict";

const { getDatabase } = require("../../connection");

class ScheduledRunnerRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    create(data) {
        const now = Date.now();
        const stmt = this.db.prepare(`
            INSERT INTO scheduled_runners (
                owner_id, guild_id, channel_id, account_id, username,
                token_ciphertext, token_iv, token_tag, token_salt,
                mode, enabled, next_check_at, last_check_at, last_error,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const info = stmt.run(
            String(data.ownerId),
            data.guildId ? String(data.guildId) : null,
            String(data.channelId),
            String(data.accountId),
            String(data.username || ""),
            String(data.token_ciphertext),
            String(data.token_iv),
            String(data.token_tag),
            String(data.token_salt),
            String(data.mode || "scheduled"),
            data.enabled !== false ? 1 : 0,
            data.nextCheckAt ? new Date(data.nextCheckAt).getTime() : null,
            data.lastCheckAt ? new Date(data.lastCheckAt).getTime() : null,
            data.lastError ? String(data.lastError) : null,
            now,
            now
        );

        return this.findById(info.lastInsertRowid);
    }

    findById(id) {
        const row = this.db.prepare("SELECT * FROM scheduled_runners WHERE id = ?").get(id);
        return row ? this._hydrate(row) : null;
    }

    findOne(filter = {}) {
        const conditions = [];
        const params = [];

        if (filter.ownerId !== undefined) {
            conditions.push("owner_id = ?");
            params.push(String(filter.ownerId));
        }
        if (filter.accountId !== undefined) {
            conditions.push("account_id = ?");
            params.push(String(filter.accountId));
        }
        if (filter.enabled !== undefined) {
            conditions.push("enabled = ?");
            params.push(filter.enabled ? 1 : 0);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const row = this.db.prepare(`SELECT * FROM scheduled_runners ${whereClause} LIMIT 1`).get(...params);
        return row ? this._hydrate(row) : null;
    }

    find(filter = {}, options = {}) {
        const conditions = [];
        const params = [];

        if (filter.ownerId !== undefined) {
            conditions.push("owner_id = ?");
            params.push(String(filter.ownerId));
        }
        if (filter.enabled !== undefined) {
            conditions.push("enabled = ?");
            params.push(filter.enabled ? 1 : 0);
        }
        if (filter.guildId !== undefined) {
            conditions.push("guild_id = ?");
            params.push(String(filter.guildId));
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const orderBy = options.sort ? "ORDER BY created_at ASC" : "ORDER BY created_at ASC";
        const rows = this.db.prepare(`SELECT * FROM scheduled_runners ${whereClause} ${orderBy}`).all(...params);
        return rows.map(r => this._hydrate(r));
    }

    updateById(id, updates = {}) {
        const setClauses = [];
        const values = [];

        if (updates.username !== undefined) {
            setClauses.push("username = ?");
            values.push(String(updates.username));
        }
        if (updates.channelId !== undefined) {
            setClauses.push("channel_id = ?");
            values.push(String(updates.channelId));
        }
        if (updates.enabled !== undefined) {
            setClauses.push("enabled = ?");
            values.push(updates.enabled ? 1 : 0);
        }
        if (updates.nextCheckAt !== undefined) {
            setClauses.push("next_check_at = ?");
            values.push(updates.nextCheckAt ? new Date(updates.nextCheckAt).getTime() : null);
        }
        if (updates.lastCheckAt !== undefined) {
            setClauses.push("last_check_at = ?");
            values.push(updates.lastCheckAt ? new Date(updates.lastCheckAt).getTime() : null);
        }
        if (updates.lastError !== undefined) {
            setClauses.push("last_error = ?");
            values.push(updates.lastError ? String(updates.lastError) : null);
        }

        if (setClauses.length === 0) return this.findById(id);

        setClauses.push("updated_at = ?");
        values.push(Date.now());
        values.push(id);

        this.db.prepare(`UPDATE scheduled_runners SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
        return this.findById(id);
    }

    deleteById(id, ownerId = null) {
        if (ownerId != null) {
            const res = this.db.prepare("DELETE FROM scheduled_runners WHERE id = ? AND owner_id = ?").run(id, String(ownerId));
            return res.changes > 0;
        }
        const res = this.db.prepare("DELETE FROM scheduled_runners WHERE id = ?").run(id);
        return res.changes > 0;
    }

    deleteMany(filter = {}) {
        if (filter.ownerId) {
            const res = this.db.prepare("DELETE FROM scheduled_runners WHERE owner_id = ?").run(String(filter.ownerId));
            return res.changes;
        }
        const res = this.db.prepare("DELETE FROM scheduled_runners").run();
        return res.changes;
    }

    count(filter = {}) {
        if (filter.enabled !== undefined) {
            const row = this.db.prepare("SELECT count(*) as count FROM scheduled_runners WHERE enabled = ?").get(filter.enabled ? 1 : 0);
            return row ? row.count : 0;
        }
        const row = this.db.prepare("SELECT count(*) as count FROM scheduled_runners").get();
        return row ? row.count : 0;
    }

    _hydrate(row) {
        return {
            _id: String(row.id),
            id: row.id,
            ownerId: row.owner_id,
            guildId: row.guild_id,
            channelId: row.channel_id,
            accountId: row.account_id,
            username: row.username,
            token_ciphertext: row.token_ciphertext,
            token_iv: row.token_iv,
            token_tag: row.token_tag,
            token_salt: row.token_salt,
            mode: row.mode,
            enabled: Boolean(row.enabled),
            nextCheckAt: row.next_check_at ? new Date(row.next_check_at) : null,
            lastCheckAt: row.last_check_at ? new Date(row.last_check_at) : null,
            lastError: row.last_error,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at)
        };
    }
}

module.exports = ScheduledRunnerRepository;
