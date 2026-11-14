"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const { encryptToken, decryptTokenForMigration } = require("../../verification/utils/crypto");

function legacyValueFilter() {
    return {
        $exists: true,
        $type: "string",
        $ne: "",
        $not: /^v3:gcm:/
    };
}

function modelLegacyFilter(fields, afterId = null) {
    const filter = { $or: fields.map(field => ({ [field]: legacyValueFilter() })) };
    if (afterId) filter._id = { $gt: afterId };
    return filter;
}

function executeCandidateQuery(model, filter, targetFields, limit) {
    let query = model.find(filter);
    if (typeof query.select === "function") {
        query = query.select(["_id", ...targetFields].join(" "));
    }
    if (typeof query.sort === "function") query = query.sort({ _id: 1 });
    if (typeof query.limit === "function") query = query.limit(limit);
    if (typeof query.lean === "function") query = query.lean();
    return query;
}

async function fetchMigrationCandidates(model, targetFields, afterId, limit) {
    let queryFilter = modelLegacyFilter(targetFields, afterId);
    let docs = await executeCandidateQuery(model, queryFilter, targetFields, limit);
    let cursorWrapped = false;

    if (docs.length === 0 && afterId) {
        cursorWrapped = true;
        docs = await executeCandidateQuery(model, modelLegacyFilter(targetFields), targetFields, limit);
    }
    return { docs, cursorWrapped };
}

async function migrateSingleField(model, doc, field, dryRun) {
    const parts = field.split(".");
    const currentVal = doc[parts[0]]?.[parts[1]];
    if (typeof currentVal !== "string" || currentVal.length === 0 || currentVal.startsWith("v3:gcm:")) {
        return { eligible: false, migrated: false, failed: false };
    }

    let decrypted;
    try {
        decrypted = decryptTokenForMigration(currentVal);
    } catch {
        return { eligible: true, migrated: false, failed: true };
    }

    if (!decrypted?.plaintext || decrypted.needsMigration !== true) {
        return { eligible: true, migrated: false, failed: true };
    }

    if (dryRun) {
        return { eligible: true, migrated: false, failed: false };
    }

    try {
        const replacement = encryptToken(decrypted.plaintext);
        const result = await model.updateOne(
            { _id: doc._id, [field]: currentVal },
            { $set: { [field]: replacement } }
        );
        const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        return { eligible: true, migrated: modified === 1, failed: modified !== 1 };
    } catch {
        return { eligible: true, migrated: false, failed: true };
    }
}

async function migrateStoredTokenEncryption({
    dryRun = false,
    scanMax = 200,
    limit = scanMax,
    countRemaining = true,
    model = OAuthUser,
    afterId = null
} = {}) {
    const targetFields = [
        "oauth.encryptedAccessToken",
        "oauth.encryptedRefreshToken"
    ];

    const { docs, cursorWrapped } = await fetchMigrationCandidates(model, targetFields, afterId, limit);

    let eligibleFields = 0;
    let migratedFields = 0;
    let failedFields = 0;

    // Sequential execution is intentional to prevent MongoDB write races,
    // preserve predictable cursor advancement, and avoid connection pool exhaustion.
    const processItem = async (docIndex, fieldIndex) => {
        if (docIndex >= docs.length) return;
        const doc = docs[docIndex];
        const field = targetFields[fieldIndex];
        const outcome = await migrateSingleField(model, doc, field, dryRun);
        if (outcome.eligible) eligibleFields++;
        if (outcome.migrated) migratedFields++;
        if (outcome.failed) failedFields++;

        const nextFieldIndex = fieldIndex + 1;
        if (nextFieldIndex < targetFields.length) {
            await processItem(docIndex, nextFieldIndex);
        } else {
            await processItem(docIndex + 1, 0);
        }
    };

    if (docs.length > 0 && targetFields.length > 0) {
        await processItem(0, 0);
    }

    let remainingDocuments = null;
    if (countRemaining && typeof model.countDocuments === "function") {
        remainingDocuments = await model.countDocuments(modelLegacyFilter(targetFields));
    }

    const nextCursor = docs.length > 0 ? (docs.at(-1)?._id || null) : null;

    return {
        name: "oauth_tokens",
        scannedDocuments: docs.length,
        eligibleFields,
        migratedFields,
        failedFields,
        remainingDocuments,
        cursorWrapped,
        nextCursor,
        scanned: docs.length,
        updated: migratedFields,
        errors: failedFields
    };
}

module.exports = {
    legacyValueFilter,
    modelLegacyFilter,
    executeCandidateQuery,
    fetchMigrationCandidates,
    migrateSingleField,
    migrateStoredTokenEncryption
};
