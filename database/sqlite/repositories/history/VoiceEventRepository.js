"use strict";

const BaseBufferedEventRepository = require("./BaseBufferedEventRepository");
const { resolvePriority, sanitizeDetails } = require("./bufferPolicy");

class VoiceEventRepository extends BaseBufferedEventRepository {
    constructor(db = null) {
        super({
            tableName: "voice_events",
            repoName: "VoiceEventRepository",
            logPrefix: "[VOICE_EVENT_BUFFER]",
            db
        });
    }

    record(event, critical = false) {
        const priority = resolvePriority(event, critical);
        let cleanMetadataJson = null;
        if (event.metadata && typeof event.metadata === "object") {
            const sanitized = sanitizeDetails(event.metadata);
            cleanMetadataJson = JSON.stringify(sanitized).slice(0, 4096);
        } else if (typeof event.metadataJson === "string") {
            cleanMetadataJson = event.metadataJson.slice(0, 4096);
        }

        const item = {
            priority,
            occurredAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
            eventType: String(event.eventType || "voice_event"),
            sessionId: event.sessionId ? String(event.sessionId) : null,
            accountId: event.accountId ? String(event.accountId) : null,
            guildId: event.guildId ? String(event.guildId) : null,
            voiceId: event.voiceId ? String(event.voiceId) : null,
            detail: event.detail ? String(event.detail).slice(0, 1000) : null,
            metadataJson: cleanMetadataJson
        };

        this.enqueueItem(item);
    }

    getInsertStatement() {
        return this.db.prepare(`
            INSERT INTO voice_events (
                occurred_at, event_type, session_id, account_id,
                guild_id, voice_id, detail, metadata_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
    }

    runInsertStatement(stmt, item) {
        stmt.run(
            item.occurredAt,
            item.eventType,
            item.sessionId,
            item.accountId,
            item.guildId,
            item.voiceId,
            item.detail,
            item.metadataJson
        );
    }

    _hydrate(row) {
        let metadata = null;
        try {
            if (row.metadata_json) metadata = JSON.parse(row.metadata_json);
        } catch (_err) {
            // Best-effort JSON metadata parse fallback
        }

        return {
            id: row.id,
            occurredAt: new Date(row.occurred_at),
            eventType: row.event_type,
            sessionId: row.session_id,
            accountId: row.account_id,
            guildId: row.guild_id,
            voiceId: row.voice_id,
            detail: row.detail,
            metadata
        };
    }
}

let defaultVoiceEventRepo = null;
function getVoiceEventRepository() {
    if (!defaultVoiceEventRepo) {
        defaultVoiceEventRepo = new VoiceEventRepository();
    }
    return defaultVoiceEventRepo;
}

module.exports = {
    VoiceEventRepository,
    getVoiceEventRepository
};
