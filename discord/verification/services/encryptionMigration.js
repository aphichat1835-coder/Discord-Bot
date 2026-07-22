"use strict";

const OAuthUser = require("../models/OAuthUser");
const VerifyLog = require("../models/VerifyLog");
const IpIdentityLink = require("../models/IpIdentityLink");
const {
    encryptToken,
    encryptIP,
    decryptTokenForMigration,
    decryptIPForMigration
} = require("../utils/crypto");

const DEFAULT_SCAN_MAX = Math.max(
    10,
    Math.min(1000, Number(process.env.ENCRYPTION_MIGRATION_SCAN_MAX || 200) || 200)
);
const CURRENT_PREFIX = "v3:gcm:";
const migrationCursors = new Map();

const TOKEN_FIELDS = Object.freeze([
    "oauth.encryptedAccessToken",
    "oauth.encryptedRefreshToken",
    "adminOAuth.encryptedAccessToken",
    "adminOAuth.encryptedRefreshToken"
]);

function legacyValueFilter() {
    return {
        $exists: true,
        $type: "string",
        $ne: "",
        $not: /^v3:gcm:/
    };
}

function getPath(source, path) {
    return path.split(".").reduce((value, key) => value?.[key], source);
}

function resetMigrationCursors() {
    migrationCursors.clear();
}

function migrationSpecs(models) {
    return [
        {
            name: "oauth_tokens",
            model: models.OAuthUserModel,
            fields: TOKEN_FIELDS,
            decrypt: decryptTokenForMigration,
            encrypt: encryptToken
        },
        {
            name: "verify_log_ips",
            model: models.VerifyLogModel,
            fields: ["ipInfo.encryptedRawIp"],
            decrypt: decryptIPForMigration,
            encrypt: encryptIP
        },
        {
            name: "identity_link_ips",
            model: models.IpIdentityLinkModel,
            fields: ["encryptedRawIp"],
            decrypt: decryptIPForMigration,
            encrypt: encryptIP
        }
    ];
}

function modelLegacyFilter(fields, afterId = null) {
    const filter = { $or: fields.map(field => ({ [field]: legacyValueFilter() })) };
    if (afterId) filter._id = { $gt: afterId };
    return filter;
}

async function readMigrationBatch(spec, scanMax) {
    const afterId = migrationCursors.get(spec.name) || null;
    let docs = await spec.model.find(modelLegacyFilter(spec.fields, afterId))
        .select(["_id", ...spec.fields].join(" "))
        .sort({ _id: 1 })
        .limit(scanMax)
        .lean();
    let cursorWrapped = false;

    if (docs.length === 0 && afterId) {
        migrationCursors.delete(spec.name);
        cursorWrapped = true;
        docs = await spec.model.find(modelLegacyFilter(spec.fields))
            .select(["_id", ...spec.fields].join(" "))
            .sort({ _id: 1 })
            .limit(scanMax)
            .lean();
    }

    return { docs, cursorWrapped };
}

async function migrateField(spec, doc, field, dryRun) {
    const encrypted = getPath(doc, field);
    if (typeof encrypted !== "string" || encrypted.startsWith(CURRENT_PREFIX)) {
        return { eligible: 0, migrated: 0, failed: 0 };
    }

    let decrypted;
    try {
        decrypted = spec.decrypt(encrypted);
    } catch {
        return { eligible: 1, migrated: 0, failed: 1 };
    }
    if (!decrypted?.plaintext || decrypted.needsMigration !== true) {
        return { eligible: 1, migrated: 0, failed: 1 };
    }

    if (dryRun) return { eligible: 1, migrated: 0, failed: 0 };

    try {
        const replacement = spec.encrypt(decrypted.plaintext);
        const result = await spec.model.updateOne(
            { _id: doc._id, [field]: encrypted },
            { $set: { [field]: replacement } }
        );
        const migrated = Number(result?.modifiedCount || 0);
        return { eligible: 1, migrated, failed: migrated === 1 ? 0 : 1 };
    } catch {
        return { eligible: 1, migrated: 0, failed: 1 };
    }
}

function addFieldResult(summary, result) {
    summary.eligibleFields += result.eligible;
    summary.migratedFields += result.migrated;
    summary.failedFields += result.failed;
}

async function migrateSpec(spec, options) {
    const { docs, cursorWrapped } = await readMigrationBatch(spec, options.scanMax);
    const summary = {
        name: spec.name,
        scannedDocuments: docs.length,
        eligibleFields: 0,
        migratedFields: 0,
        failedFields: 0,
        remainingDocuments: 0,
        cursorWrapped
    };

    for (const doc of docs) {
        for (const field of spec.fields) {
            addFieldResult(summary, await migrateField(spec, doc, field, options.dryRun));
        }
    }

    if (!options.dryRun && docs.length > 0) {
        migrationCursors.set(spec.name, docs.at(-1)._id);
    }

    summary.remainingDocuments = await spec.model.countDocuments(modelLegacyFilter(spec.fields));
    return summary;
}

async function runEncryptionMigration(options = {}) {
    const models = {
        OAuthUserModel: options.OAuthUserModel || OAuthUser,
        VerifyLogModel: options.VerifyLogModel || VerifyLog,
        IpIdentityLinkModel: options.IpIdentityLinkModel || IpIdentityLink
    };
    const settings = {
        dryRun: options.dryRun === true,
        scanMax: Math.max(1, Math.min(1000, Number(options.scanMax || DEFAULT_SCAN_MAX) || DEFAULT_SCAN_MAX))
    };

    const collections = [];
    for (const spec of migrationSpecs(models)) {
        collections.push(await migrateSpec(spec, settings));
    }

    return {
        version: 3,
        dryRun: settings.dryRun,
        scanMax: settings.scanMax,
        scannedDocuments: collections.reduce((sum, item) => sum + item.scannedDocuments, 0),
        eligibleFields: collections.reduce((sum, item) => sum + item.eligibleFields, 0),
        migratedFields: collections.reduce((sum, item) => sum + item.migratedFields, 0),
        failedFields: collections.reduce((sum, item) => sum + item.failedFields, 0),
        remainingDocuments: collections.reduce((sum, item) => sum + item.remainingDocuments, 0),
        collections
    };
}

module.exports = {
    runEncryptionMigration,
    DEFAULT_SCAN_MAX,
    CURRENT_PREFIX,
    _test: {
        getPath,
        legacyValueFilter,
        modelLegacyFilter,
        migrateField,
        resetMigrationCursors
    }
};
