const mongoose = require("mongoose");

function getModel(name, schema) {
    return mongoose.models[name] || mongoose.model(name, schema);
}

const auditLogEventSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    eventId: { type: String, required: true },
    source: { type: String, default: "audit", index: true },
    category: { type: String, default: "server", index: true },
    severity: { type: String, default: "info", index: true },
    actionType: { type: String, default: "UNKNOWN", index: true },
    actorId: { type: String, default: null, index: true },
    targetId: { type: String, default: null, index: true },
    channelId: { type: String, default: null, index: true },
    messageId: { type: String, default: null },
    roleId: { type: String, default: null, index: true },
    reason: String,
    summary: String,
    evidence: [String],
    metadata: mongoose.Schema.Types.Mixed,
    createdAt: { type: Number, default: Date.now, index: true },
    storedAt: { type: Number, default: Date.now, index: true }
});

auditLogEventSchema.index({ guildId: 1, eventId: 1 }, { unique: true });
auditLogEventSchema.index({ guildId: 1, createdAt: -1 });
auditLogEventSchema.index({ guildId: 1, category: 1, createdAt: -1 });
auditLogEventSchema.index({ guildId: 1, actionType: 1, createdAt: -1 });
auditLogEventSchema.index({ guildId: 1, actorId: 1, createdAt: -1 });
auditLogEventSchema.index({ guildId: 1, targetId: 1, createdAt: -1 });

const AuditLogEventModel = getModel("AuditLogEvent", auditLogEventSchema);

async function saveRecord(record) {
    await AuditLogEventModel.updateOne(
        { guildId: record.guildId, eventId: record.eventId },
        { $set: { ...record, storedAt: record.storedAt || Date.now() } },
        { upsert: true }
    );
    return record;
}

async function getRecord(guildId, eventId) {
    return AuditLogEventModel.findOne({ guildId: String(guildId), eventId: String(eventId) }).lean();
}

function buildListQuery(guildId, filters = {}) {
    const query = { guildId: String(guildId) };
    for (const key of ["category", "severity", "actionType", "actorId", "targetId", "channelId", "roleId"]) {
        if (filters[key]) query[key] = String(filters[key]);
    }
    return query;
}

async function listRecords(guildId, limit = 50, filters = {}) {
    return AuditLogEventModel.find(buildListQuery(guildId, filters))
        .sort({ createdAt: -1 })
        .limit(Math.max(1, Math.min(500, Number(limit) || 50)))
        .lean();
}

module.exports = {
    AuditLogEventModel,
    auditLogEventSchema,
    saveRecord,
    getRecord,
    listRecords,
    buildListQuery
};
