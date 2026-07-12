#!/usr/bin/env node
"use strict";

const mongoose = require("mongoose");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const MigrationArchive = require("../discord/verification/models/VerificationMigrationArchive");

const APPLY = process.argv.includes("--apply");
const RESTORE_ALL = process.argv.includes("--all");
const SOURCE_ID_ARG = process.argv.find(arg => arg.startsWith("--source-id="));
const SOURCE_ID = SOURCE_ID_ARG ? SOURCE_ID_ARG.slice("--source-id=".length).trim() : "";

function restoreFilter() {
    if (RESTORE_ALL) return { migrationVersion: 2, sourceCollection: "oauthusers" };
    if (SOURCE_ID) {
        if (!/^[a-f\d]{24}$/i.test(SOURCE_ID)) throw new Error("source id must be a 24-character MongoDB ObjectId");
        return { migrationVersion: 2, sourceCollection: "oauthusers", sourceId: SOURCE_ID };
    }
    const error = new Error("Use --source-id=ID or --all; add --apply to restore data");
    error.code = "restore_scope_required";
    throw error;
}

async function restoreCursor({ cursor, apply = false, replaceOne = (filter, payload, options) => OAuthUser.collection.replaceOne(filter, payload, options) }) {
    const summary = { mode: apply ? "apply" : "dry-run", found: 0, restored: 0, skipped: 0 };
    for await (const archive of cursor) {
        summary.found++;
        if (!archive?.payload?._id) {
            summary.skipped++;
            continue;
        }
        if (!apply) continue;
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
    const summary = await restoreCursor({ cursor, apply: APPLY });
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

module.exports = { restoreFilter, restoreCursor };
