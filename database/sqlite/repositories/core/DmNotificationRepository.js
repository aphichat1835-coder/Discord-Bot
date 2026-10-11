"use strict";

const { getDatabase } = require("../../connection");

class DmNotificationRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    create(recordData) {
        const now = Date.now();
        const payloadJson = typeof recordData.payload === "string"
            ? recordData.payload
            : JSON.stringify(recordData.payload || {});

        const expiresAt = recordData.expiresAt instanceof Date
            ? recordData.expiresAt.getTime()
            : (Number(recordData.expiresAt) || (now + 7 * 24 * 60 * 60 * 1000));

        const stmt = this.db.prepare(`
            INSERT INTO dm_notifications (
                event_key, recipient_id, category, priority, priority_rank,
                payload_json, status, attempts, next_attempt_at, last_error,
                sent_at, created_at, updated_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        try {
            const info = stmt.run(
                String(recordData.eventKey),
                String(recordData.recipientId),
                String(recordData.category),
                String(recordData.priority || "normal"),
                parseInt(recordData.priorityRank, 10) || 2,
                payloadJson,
                String(recordData.status || "pending"),
                parseInt(recordData.attempts, 10) || 0,
                Number(recordData.nextAttemptAt) || now,
                recordData.lastError ? String(recordData.lastError) : null,
                recordData.sentAt ? Number(recordData.sentAt) : null,
                Number(recordData.createdAt) || now,
                Number(recordData.updatedAt) || now,
                expiresAt
            );
            return this.findById(info.lastInsertRowid);
        } catch (err) {
            if (err.message && err.message.includes("UNIQUE constraint failed")) {
                const dupErr = new Error(`E11000 duplicate key error collection: dm_notifications index: eventKey_1 dup key: { eventKey: "${recordData.eventKey}" }`);
                dupErr.code = 11000;
                dupErr.keyPattern = { eventKey: 1 };
                dupErr.keyValue = { eventKey: recordData.eventKey };
                throw dupErr;
            }
            throw err;
        }
    }

    findById(id) {
        const row = this.db.prepare("SELECT * FROM dm_notifications WHERE id = ?").get(id);
        return row ? this._hydrate(row) : null;
    }

    findOne(filter = {}) {
        if (filter._id) {
            return this.findById(filter._id);
        }
        if (filter.eventKey) {
            const row = this.db.prepare("SELECT * FROM dm_notifications WHERE event_key = ?").get(String(filter.eventKey));
            return row ? this._hydrate(row) : null;
        }
        return null;
    }

    claimRecord(record, now = Date.now()) {
        const id = record.id || record._id;
        if (!id) return null;

        const stmt = this.db.prepare(`
            UPDATE dm_notifications
            SET status = 'sending', updated_at = ?
            WHERE id = ? AND status IN ('pending', 'retrying') AND next_attempt_at <= ?
        `);

        const info = stmt.run(now, id, now);
        if (info.changes === 1) {
            return this.findById(id);
        }
        return null;
    }

    claimDueCandidates(limit = 25, now = Date.now()) {
        const claimTx = this.db.transaction(() => {
            const candidates = this.db.prepare(`
                SELECT id FROM dm_notifications
                WHERE status IN ('pending', 'retrying') AND next_attempt_at <= ? AND expires_at > ?
                ORDER BY priority_rank ASC, created_at ASC
                LIMIT ?
            `).all(now, now, limit);

            const claimed = [];
            const updateStmt = this.db.prepare(`
                UPDATE dm_notifications
                SET status = 'sending', updated_at = ?
                WHERE id = ?
            `);

            for (const cand of candidates) {
                updateStmt.run(now, cand.id);
                claimed.push(this.findById(cand.id));
            }
            return claimed;
        });

        return claimTx();
    }

    updateOne(filter, updateData = {}) {
        const id = filter._id || filter.id;
        const eventKey = filter.eventKey;

        const setClauses = [];
        const values = [];

        const updateFields = updateData.$set ? { ...updateData.$set, ...updateData } : updateData;
        delete updateFields.$set;
        delete updateFields.$setOnInsert;

        if (updateFields.status !== undefined) {
            setClauses.push("status = ?");
            values.push(String(updateFields.status));
        }
        if (updateFields.attempts !== undefined) {
            setClauses.push("attempts = ?");
            values.push(parseInt(updateFields.attempts, 10) || 0);
        }
        if (updateFields.nextAttemptAt !== undefined) {
            setClauses.push("next_attempt_at = ?");
            values.push(Number(updateFields.nextAttemptAt));
        }
        if (updateFields.lastError !== undefined) {
            setClauses.push("last_error = ?");
            values.push(updateFields.lastError ? String(updateFields.lastError) : null);
        }
        if (updateFields.sentAt !== undefined) {
            setClauses.push("sent_at = ?");
            values.push(updateFields.sentAt ? Number(updateFields.sentAt) : null);
        }
        if (updateFields.priority !== undefined) {
            setClauses.push("priority = ?");
            values.push(String(updateFields.priority));
        }
        if (updateFields.priorityRank !== undefined) {
            setClauses.push("priority_rank = ?");
            values.push(parseInt(updateFields.priorityRank, 10));
        }

        setClauses.push("updated_at = ?");
        values.push(Date.now());

        if (id) {
            values.push(id);
            const res = this.db.prepare(`UPDATE dm_notifications SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
            return { matchedCount: res.changes, modifiedCount: res.changes };
        } else if (eventKey) {
            values.push(String(eventKey));
            const res = this.db.prepare(`UPDATE dm_notifications SET ${setClauses.join(", ")} WHERE event_key = ?`).run(...values);
            return { matchedCount: res.changes, modifiedCount: res.changes };
        }

        return { matchedCount: 0, modifiedCount: 0 };
    }

    find(filter = {}, options = {}) {
        const conditions = [];
        const params = [];

        if (filter.status) {
            if (filter.status.$in) {
                if (filter.status.$in.length === 0) return [];
                const placeholders = filter.status.$in.map(() => "?").join(", ");
                conditions.push(`status IN (${placeholders})`);
                params.push(...filter.status.$in);
            } else {
                conditions.push("status = ?");
                params.push(String(filter.status));
            }
        }

        if (filter.category) {
            if (filter.category.$nin) {
                if (filter.category.$nin.length > 0) {
                    const placeholders = filter.category.$nin.map(() => "?").join(", ");
                    conditions.push(`category NOT IN (${placeholders})`);
                    params.push(...filter.category.$nin);
                }
            } else if (filter.category.$in) {
                if (filter.category.$in.length === 0) return [];
                const placeholders = filter.category.$in.map(() => "?").join(", ");
                conditions.push(`category IN (${placeholders})`);
                params.push(...filter.category.$in);
            } else {
                conditions.push("category = ?");
                params.push(String(filter.category));
            }
        }

        if (filter.nextAttemptAt && filter.nextAttemptAt.$lte !== undefined) {
            conditions.push("next_attempt_at <= ?");
            params.push(Number(filter.nextAttemptAt.$lte));
        }

        if (filter.expiresAt && filter.expiresAt.$gt !== undefined) {
            conditions.push("expires_at > ?");
            params.push(Number(filter.expiresAt.$gt));
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const limitClause = options.limit ? `LIMIT ${parseInt(options.limit, 10)}` : "";
        const orderClause = "ORDER BY priority_rank ASC, created_at ASC";

        const rows = this.db.prepare(`SELECT * FROM dm_notifications ${whereClause} ${orderClause} ${limitClause}`).all(...params);
        return rows.map(r => this._hydrate(r));
    }

    deleteMany(filter = {}) {
        const conditions = [];
        const params = [];

        if (filter.category && filter.category.$in) {
            if (filter.category.$in.length === 0) return { deletedCount: 0 };
            const placeholders = filter.category.$in.map(() => "?").join(", ");
            conditions.push(`category IN (${placeholders})`);
            params.push(...filter.category.$in);
        }
        if (filter.status && filter.status.$in) {
            if (filter.status.$in.length === 0) return { deletedCount: 0 };
            const placeholders = filter.status.$in.map(() => "?").join(", ");
            conditions.push(`status IN (${placeholders})`);
            params.push(...filter.status.$in);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const res = this.db.prepare(`DELETE FROM dm_notifications ${whereClause}`).run(...params);
        return { deletedCount: res.changes };
    }

    countDocuments(filter = {}) {
        const conditions = [];
        const params = [];
        if (filter.status) {
            conditions.push("status = ?");
            params.push(String(filter.status));
        }
        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
        const row = this.db.prepare(`SELECT count(*) as count FROM dm_notifications ${whereClause}`).get(...params);
        return row ? row.count : 0;
    }

    _hydrate(row) {
        let payload = {};
        try {
            payload = JSON.parse(row.payload_json);
        } catch (_) {}

        return {
            _id: String(row.id),
            id: row.id,
            eventKey: row.event_key,
            recipientId: row.recipient_id,
            category: row.category,
            priority: row.priority,
            priorityRank: row.priority_rank,
            payload,
            status: row.status,
            attempts: row.attempts,
            nextAttemptAt: row.next_attempt_at,
            lastError: row.last_error,
            sentAt: row.sent_at,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            expiresAt: new Date(row.expires_at)
        };
    }
}

module.exports = DmNotificationRepository;
