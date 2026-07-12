"use strict";

const crypto = require("node:crypto");
const OAuthUser = require("../models/OAuthUser");
const MigrationArchive = require("../models/VerificationMigrationArchive");

function contentHash(document) {
    return crypto.createHash("sha256").update(JSON.stringify(document)).digest("hex");
}

async function archiveSourceDocument(sourceId, options = {}) {
    const OAuthUserModel = options.OAuthUserModel || OAuthUser;
    const ArchiveModel = options.ArchiveModel || MigrationArchive;
    const migrationVersion = Number(options.migrationVersion || 2);
    const source = await OAuthUserModel.findById(sourceId).lean();
    if (!source) {
        const error = new Error("migration source document disappeared before backup");
        error.code = "migration_source_missing";
        throw error;
    }
    const hash = contentHash(source);
    // First backup wins: sourceId intentionally excludes contentHash so a retry
    // can never overwrite the original document with partially migrated state.
    const result = await ArchiveModel.updateOne({
        migrationVersion,
        sourceCollection: OAuthUserModel.collection?.name || "oauthusers",
        sourceId: String(source._id)
    }, {
        $setOnInsert: { contentHash: hash, payload: source, backedUpAt: Date.now() }
    }, { upsert: true });
    return { hash, created: Number(result?.upsertedCount || 0) > 0 };
}

module.exports = { contentHash, archiveSourceDocument };
