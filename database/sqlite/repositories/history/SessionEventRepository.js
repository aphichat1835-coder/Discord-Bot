"use strict";

const BaseBufferedEventRepository = require("./BaseBufferedEventRepository");
const { resolvePriority } = require("./bufferPolicy");
const { sanitizeDetails } = require("./CommandEventRepository");

class SessionEventRepository extends BaseBufferedEventRepository {
    constructor(db = null) {
        super({
            tableName: "session_events",
            repoName: "SessionEventRepository",
            logPrefix: "[SESSION_EVENT_BUFFER]",
            db
        });
    }

    record(event, critical = false) {
        let metadataJson = null;
        if (event.metadata !== undefined && event.metadata !== null) {
            try {
                const cleaned = sanitizeDetails(event.metadata);
                metadataJson = JSON.stringify(cleaned).slice(0, 4096);
            } catch (_) {
                metadataJson = null;
            }
        }

        const priority = resolvePriority(event, critical);
        const item = {
            priority,
            occurredAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
            sessionId: String(event.sessionId || "global").slice(0, 128),
            accountId: event.accountId ? String(event.accountId).slice(0, 64) : null,
            eventType: String(event.eventType || "unknown").slice(0, 64),
            metadataJson
        };

        this.enqueueItem(item);
    }

    getInsertStatement() {
        return this.db.prepare(`
            INSERT INTO session_events (
                occurred_at, session_id, account_id,
                event_type, metadata_json
            ) VALUES (?, ?, ?, ?, ?)
        `);
    }

    runInsertStatement(stmt, item) {
        stmt.run(
            item.occurredAt,
            item.sessionId,
            item.accountId,
            item.eventType,
            item.metadataJson
        );
    }

    findRecent(limit = 100) {
        this.flush();
        const bounded = Math.min(500, Math.max(1, parseInt(limit, 10) || 100));
        const rows = this.db.prepare(`
            SELECT * FROM session_events
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(bounded);

        return rows.map(r => this._hydrate(r));
    }

    findBySession(sessionId, limit = 50) {
        this.flush();
        const rows = this.db.prepare(`
            SELECT * FROM session_events
            WHERE session_id = ?
            ORDER BY occurred_at DESC
            LIMIT ?
        `).all(String(sessionId), limit);

        return rows.map(r => this._hydrate(r));
    }

    _hydrate(row) {
        let metadata = null;
        try {
            if (row.metadata_json) metadata = JSON.parse(row.metadata_json);
        } catch (_) {}

        return {
            id: row.id,
            occurredAt: new Date(row.occurred_at),
            sessionId: row.session_id,
            accountId: row.account_id,
            eventType: row.event_type,
            metadata
        };
    }
}

let defaultSessionEventRepo = null;
function getSessionEventRepository() {
    if (!defaultSessionEventRepo) {
        defaultSessionEventRepo = new SessionEventRepository();
    }
    return defaultSessionEventRepo;
}

module.exports = {
    SessionEventRepository,
    getSessionEventRepository
};
