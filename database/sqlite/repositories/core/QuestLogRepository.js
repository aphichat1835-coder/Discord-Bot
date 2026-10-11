"use strict";

const { getDatabase } = require("../../connection");

class QuestLogRepository {
    constructor(db = null) {
        this._db = db;
    }

    get db() {
        return this._db || getDatabase();
    }

    create(logData) {
        const now = Date.now();
        const createTx = this.db.transaction(() => {
            const logStmt = this.db.prepare(`
                INSERT INTO quest_logs (
                    invoker_id, invoker_tag, guild_id, channel_id,
                    total_tokens, overall_status, dm_delivered, dm_error,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);

            const logInfo = logStmt.run(
                String(logData.invokerId || ""),
                String(logData.invokerTag || ""),
                logData.guildId ? String(logData.guildId) : null,
                logData.channelId ? String(logData.channelId) : null,
                parseInt(logData.totalTokens, 10) || 0,
                String(logData.overallStatus || "in_progress"),
                logData.dmDelivered ? 1 : 0,
                logData.dmError ? String(logData.dmError) : null,
                now,
                now
            );

            const logId = logInfo.lastInsertRowid;

            if (Array.isArray(logData.accounts) && logData.accounts.length > 0) {
                const accStmt = this.db.prepare(`
                    INSERT INTO quest_accounts (
                        log_id, account_index, target_user_id, target_username,
                        masked_token, encrypted_token, status, quests_found,
                        quests_completed, error_message, started_at, finished_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                const detStmt = this.db.prepare(`
                    INSERT INTO quest_details (
                        account_id, detail_index, quest_id, quest_name,
                        event_name, progress, target, completed, claimed, error
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `);

                logData.accounts.forEach((acc, idx) => {
                    const accInfo = accStmt.run(
                        logId,
                        idx,
                        acc.targetUserId ? String(acc.targetUserId) : null,
                        acc.targetUsername ? String(acc.targetUsername) : null,
                        String(acc.maskedToken || ""),
                        String(acc.encryptedToken || ""),
                        String(acc.status || "pending"),
                        parseInt(acc.questsFound, 10) || 0,
                        parseInt(acc.questsCompleted, 10) || 0,
                        acc.errorMessage ? String(acc.errorMessage) : null,
                        acc.startedAt ? new Date(acc.startedAt).getTime() : now,
                        acc.finishedAt ? new Date(acc.finishedAt).getTime() : null
                    );

                    const accId = accInfo.lastInsertRowid;

                    if (Array.isArray(acc.details) && acc.details.length > 0) {
                        acc.details.forEach((det, dIdx) => {
                            detStmt.run(
                                accId,
                                dIdx,
                                String(det.questId || ""),
                                String(det.questName || ""),
                                String(det.eventName || ""),
                                parseInt(det.progress, 10) || 0,
                                parseInt(det.target, 10) || 0,
                                det.completed ? 1 : 0,
                                det.claimed ? 1 : 0,
                                det.error ? String(det.error) : null
                            );
                        });
                    }
                });
            }

            return this.findById(logId);
        });

        return createTx();
    }

    findById(id) {
        const row = this.db.prepare("SELECT * FROM quest_logs WHERE id = ?").get(id);
        if (!row) return null;
        return this._hydrateLog(row);
    }

    findRecent(limit = 50) {
        const boundedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
        const rows = this.db.prepare(`
            SELECT * FROM quest_logs
            ORDER BY created_at DESC
            LIMIT ?
        `).all(boundedLimit);

        return rows.map(r => this._hydrateLog(r));
    }

    update(id, updates = {}) {
        const setClauses = [];
        const values = [];

        if (updates.overallStatus !== undefined) {
            setClauses.push("overall_status = ?");
            values.push(String(updates.overallStatus));
        }
        if (updates.dmDelivered !== undefined) {
            setClauses.push("dm_delivered = ?");
            values.push(updates.dmDelivered ? 1 : 0);
        }
        if (updates.dmError !== undefined) {
            setClauses.push("dm_error = ?");
            values.push(updates.dmError ? String(updates.dmError) : null);
        }

        if (setClauses.length === 0) return this.findById(id);

        setClauses.push("updated_at = ?");
        values.push(Date.now());
        values.push(id);

        this.db.prepare(`UPDATE quest_logs SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
        return this.findById(id);
    }

    count() {
        const row = this.db.prepare("SELECT count(*) as count FROM quest_logs").get();
        return row ? row.count : 0;
    }

    _hydrateLog(row) {
        const accounts = this.db.prepare(`
            SELECT * FROM quest_accounts
            WHERE log_id = ?
            ORDER BY account_index ASC
        `).all(row.id);

        const hydratedAccounts = accounts.map(acc => {
            const details = this.db.prepare(`
                SELECT * FROM quest_details
                WHERE account_id = ?
                ORDER BY detail_index ASC
            `).all(acc.id);

            return {
                targetUserId: acc.target_user_id,
                targetUsername: acc.target_username,
                maskedToken: acc.masked_token,
                encryptedToken: acc.encrypted_token,
                status: acc.status,
                questsFound: acc.quests_found,
                questsCompleted: acc.quests_completed,
                errorMessage: acc.error_message,
                startedAt: acc.started_at ? new Date(acc.started_at) : null,
                finishedAt: acc.finished_at ? new Date(acc.finished_at) : null,
                details: details.map(d => ({
                    questId: d.quest_id,
                    questName: d.quest_name,
                    eventName: d.event_name,
                    progress: d.progress,
                    target: d.target,
                    completed: Boolean(d.completed),
                    claimed: Boolean(d.claimed),
                    error: d.error
                }))
            };
        });

        return {
            _id: String(row.id),
            id: row.id,
            invokerId: row.invoker_id,
            invokerTag: row.invoker_tag,
            guildId: row.guild_id,
            channelId: row.channel_id,
            totalTokens: row.total_tokens,
            overallStatus: row.overall_status,
            dmDelivered: Boolean(row.dm_delivered),
            dmError: row.dm_error,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at),
            accounts: hydratedAccounts
        };
    }
}

module.exports = QuestLogRepository;
