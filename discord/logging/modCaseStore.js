/*
 * Mongo-backed moderation case store.
 * Uses the same mongoose default connection established by sessionManager.connectDB().
 */

const mongoose = require("mongoose");

function getModel(name, schema) {
    return mongoose.models[name] || mongoose.model(name, schema);
}

const modCaseSchema = new mongoose.Schema({
    guildId: { type: String, required: true, index: true },
    caseNumber: { type: Number, required: true },
    action: String,
    type: String,
    userId: { type: String, index: true },
    moderatorId: String,
    reason: String,
    durationMs: Number,
    evidence: [String],
    source: String,
    status: { type: String, default: "active", index: true },
    createdAt: { type: Number, default: Date.now, index: true },
    updatedAt: { type: Number, default: Date.now },
    expiresAt: { type: Number, default: null, index: true },
    amendedBy: String,
    amendedAt: Number,
    metadata: mongoose.Schema.Types.Mixed
});
modCaseSchema.index({ guildId: 1, caseNumber: 1 }, { unique: true });
modCaseSchema.index({ guildId: 1, userId: 1, caseNumber: -1 });

const modCaseCounterSchema = new mongoose.Schema({
    guildId: { type: String, required: true, unique: true },
    seq: { type: Number, default: 0 },
    updatedAt: { type: Number, default: Date.now }
});

const ModCaseModel = getModel("ModCase", modCaseSchema);
const ModCaseCounterModel = getModel("ModCaseCounter", modCaseCounterSchema);

async function nextCaseNumber(guildId) {
    const doc = await ModCaseCounterModel.findOneAndUpdate(
        { guildId: String(guildId) },
        { $inc: { seq: 1 }, $set: { updatedAt: Date.now() } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    return doc.seq;
}

async function getMaxCaseNumber(guildId) {
    const safeGuildId = String(guildId);
    const [latestCase, counter] = await Promise.all([
        ModCaseModel.findOne({ guildId: safeGuildId }).sort({ caseNumber: -1 }).select("caseNumber").lean(),
        ModCaseCounterModel.findOne({ guildId: safeGuildId }).select("seq").lean()
    ]);
    return Math.max(Number(latestCase?.caseNumber || 0), Number(counter?.seq || 0));
}

async function saveCase(caseDoc) {
    await ModCaseModel.updateOne(
        { guildId: caseDoc.guildId, caseNumber: caseDoc.caseNumber },
        { $set: caseDoc },
        { upsert: true }
    );
    return caseDoc;
}

async function getCase(guildId, caseNumber) {
    return ModCaseModel.findOne({ guildId: String(guildId), caseNumber: Number(caseNumber) }).lean();
}

async function listUserCases(guildId, userId, limit = 10) {
    return ModCaseModel.find({ guildId: String(guildId), userId: String(userId) })
        .sort({ caseNumber: -1 })
        .limit(Math.max(1, Math.min(50, Number(limit) || 10)))
        .lean();
}

async function updateCase(guildId, caseNumber, patch = {}) {
    const updated = await ModCaseModel.findOneAndUpdate(
        { guildId: String(guildId), caseNumber: Number(caseNumber) },
        { $set: { ...patch, updatedAt: Date.now() } },
        { new: true }
    ).lean();
    return updated;
}

module.exports = {
    ModCaseModel,
    ModCaseCounterModel,
    nextCaseNumber,
    getMaxCaseNumber,
    saveCase,
    getCase,
    listUserCases,
    updateCase
};
