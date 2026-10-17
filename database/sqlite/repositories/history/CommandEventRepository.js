"use strict";

const BaseBufferedEventRepository = require("./BaseBufferedEventRepository");
const { resolvePriority, sanitizeDetails } = require("./bufferPolicy");

class CommandEventRepository extends BaseBufferedEventRepository {
    constructor(db = null) {
        super({
            tableName: "command_events",
            repoName: "CommandEventRepository",
            logPrefix: "[COMMAND_EVENT_BUFFER]",
            db
        });
    }

    record(event, critical = false) {
        let detailJson = null;
        if (event.details !== undefined && event.details !== null) {
            try {
                const cleaned = sanitizeDetails(event.details);
                detailJson = JSON.stringify(cleaned).slice(0, 4096);
            } catch (err) {
                console.warn(`[COMMAND_EVENT_BUFFER] ⚠️ Failed to serialize command event details: ${err.message}`);
                detailJson = null;
            }
        }

        const priority = resolvePriority(event, critical);
        const item = {
            priority,
            occurredAt: event.occurredAt ? new Date(event.occurredAt).getTime() : Date.now(),
            commandName: String(event.commandName || "unknown").slice(0, 64),
            actorId: String(event.actorId || "unknown"),
            guildId: event.guildId ? String(event.guildId) : null,
            channelId: event.channelId ? String(event.channelId) : null,
            status: String(event.status || "success"),
            durationMs: Number.isFinite(event.durationMs) ? Math.max(0, Math.round(event.durationMs)) : null,
            detailJson
        };

        this.enqueueItem(item);
    }

    getInsertStatement() {
        return this.db.prepare(`
            INSERT INTO command_events (
                occurred_at, command_name, actor_id, guild_id,
                channel_id, status, duration_ms, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
    }

    runInsertStatement(stmt, item) {
        stmt.run(
            item.occurredAt,
            item.commandName,
            item.actorId,
            item.guildId,
            item.channelId,
            item.status,
            item.durationMs,
            item.detailJson
        );
    }

    _hydrate(row) {
        let details = null;
        try {
            if (row.detail_json) details = JSON.parse(row.detail_json);
        } catch (_err) {
            // Best-effort JSON details parse fallback
        }

        return {
            id: row.id,
            occurredAt: new Date(row.occurred_at),
            commandName: row.command_name,
            actorId: row.actor_id,
            guildId: row.guild_id,
            channelId: row.channel_id,
            status: row.status,
            durationMs: row.duration_ms,
            details
        };
    }
}

let defaultCommandEventRepo = null;
function getCommandEventRepository() {
    if (!defaultCommandEventRepo) {
        defaultCommandEventRepo = new CommandEventRepository();
    }
    return defaultCommandEventRepo;
}

module.exports = {
    CommandEventRepository,
    getCommandEventRepository,
    sanitizeDetails
};
