"use strict";

const { getDatabase } = require("../../connection");

class VoiceSessionRuntimeRepository {
    constructor(db = null) {
        this.getDb = () => db || getDatabase();
    }

    upsertSessionRuntime(data) {
        if (!data || !data.sessionId) throw new TypeError("sessionId is required");
        const db = this.getDb();
        const now = Date.now();

        const stmt = db.prepare(`
            INSERT INTO voice_session_runtime (
                session_id, server_id, owner_id, state, 
                last_heartbeat, last_activity, reconnect_count, 
                status_label, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                server_id = excluded.server_id,
                owner_id = excluded.owner_id,
                state = excluded.state,
                last_heartbeat = excluded.last_heartbeat,
                last_activity = excluded.last_activity,
                reconnect_count = excluded.reconnect_count,
                status_label = excluded.status_label,
                updated_at = excluded.updated_at
        `);

        stmt.run(
            String(data.sessionId),
            String(data.serverId || ""),
            String(data.ownerId || ""),
            String(data.state || "active"),
            data.lastHeartbeat || now,
            data.lastActivity || now,
            data.reconnectCount || 0,
            data.statusLabel || "ready",
            now
        );

        return this.getSessionRuntime(data.sessionId);
    }

    recordHeartbeat(sessionId, timestamp = Date.now()) {
        if (!sessionId) return false;
        const db = this.getDb();
        const stmt = db.prepare(`
            UPDATE voice_session_runtime 
            SET last_heartbeat = ?, updated_at = ? 
            WHERE session_id = ?
        `);
        const result = stmt.run(timestamp, timestamp, String(sessionId));
        return result.changes > 0;
    }

    getSessionRuntime(sessionId) {
        if (!sessionId) return null;
        const db = this.getDb();
        return db.prepare("SELECT * FROM voice_session_runtime WHERE session_id = ?").get(String(sessionId)) || null;
    }

    listActiveSessionRuntimes() {
        const db = this.getDb();
        return db.prepare("SELECT * FROM voice_session_runtime ORDER BY updated_at DESC").all();
    }

    deleteSessionRuntime(sessionId) {
        if (!sessionId) return false;
        const db = this.getDb();
        const result = db.prepare("DELETE FROM voice_session_runtime WHERE session_id = ?").run(String(sessionId));
        return result.changes > 0;
    }
}

module.exports = VoiceSessionRuntimeRepository;
