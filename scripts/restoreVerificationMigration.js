#!/usr/bin/env node
"use strict";

const mongoose = require("mongoose");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const MigrationArchive = require("../discord/verification/models/VerificationMigrationArchive");

const APPLY = process.argv.includes("--apply");
const RESTORE_ALL = process.argv.includes("--all");
const FORCE = process.argv.includes("--force");
const SOURCE_ID_ARG = process.argv.find(arg => arg.startsWith("--source-id="));
const SOURCE_ID = SOURCE_ID_ARG ? SOURCE_ID_ARG.slice("--source-id=".length).trim() : "";

function restoreFilter({ restoreAll = RESTORE_ALL, sourceId = SOURCE_ID } = {}) {
    if (restoreAll) return { migrationVersion: 2, sourceCollection: "oauthusers" };
    if (sourceId) {
        if (!/^[a-f\d]{24}$/i.test(sourceId)) throw new Error("source id must be a 24-character MongoDB ObjectId");
        return { migrationVersion: 2, sourceCollection: "oauthusers", sourceId };
    }
    const error = new Error("Use --source-id=ID or --all; add --apply to restore data");
    error.code = "restore_scope_required";
    throw error;
}

function timestamp(value) {
    if (value instanceof Date) return value.getTime();
    const parsed = Number(value || 0);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function restoreCursor({
    cursor,
    apply = false,
    force = false,
    findOne = filter => OAuthUser.collection.findOne(filter, { projection: { updatedAt: 1 } }),
    replaceOne = (filter, payload, options) => OAuthUser.collection.replaceOne(filter, payload, options)
}) {
    const summary = {
        mode: apply ? "apply" : "dry-run",
        found: 0,
        restored: 0,
        skipped: 0,
        newerSkipped: 0
    };
    for await (const archive of cursor) {
        summary.found++;
        if (!archive?.payload?._id) {
            summary.skipped++;
            continue;
        }
        if (!apply) continue;
        if (!force) {
            const current = await findOne({ _id: archive.payload._id });
            const archiveTime = timestamp(archive.backedUpAt || archive.payload.updatedAt);
            if (timestamp(current?.updatedAt) > archiveTime) {
                summary.skipped++;
                summary.newerSkipped++;
                continue;
            }
        }
        const result = await replaceOne({ _id: archive.payload._id }, archive.payload, { upsert: true });
        if (result?.acknowledged === false) summary.skipped++;
        else summary.restored++;
    }
    return summary;
}

async function run() {
    const mongoUri = String(process.env.MONGO_URI || "").trim();
    if (!mongoUri) throw new Error("MONGO_URI is required");
    const filter = restoreFilter();
    await mongoose.connect(mongoUri, { maxPoolSize: 2 });
    const cursor = MigrationArchive.find(filter)
        .select("sourceId payload backedUpAt")
        .sort({ backedUpAt: 1, _id: 1 })
        .lean()
        .cursor();
    const summary = await restoreCursor({ cursor, apply: APPLY, force: FORCE });
    console.log("[VERIFICATION-RESTORE]", JSON.stringify(summary));
}

if (require.main === module) {
    run()
        .catch(err => {
            console.error("[VERIFICATION-RESTORE] failed:", err?.message || "unknown error");
            process.exitCode = 1;
        })
        .finally(async () => mongoose.connection.close(false).catch(() => {}));
}

module.exports = { restoreFilter, restoreCursor, timestamp };
