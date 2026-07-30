#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const PROTECTED_DIGESTS = require("../.github/protected-path-digests.json");

const PROTECTED_ROOT_FILE = "discord/systemProvider.js";
const PROTECTED_DIRECTORY = "discord/systemProvider";
const PROTECTED_PATH_PATTERN = /^discord\/systemProvider(?:\.js|\/[^/].*)$/;
const GIT_BLOB_PREFIX = "git:";
const GIT_BIN = process.platform === "win32" ? "git.exe" : "git";

function git(args) {
    return execFileSync(GIT_BIN, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
    }).trim();
}

function isGitRepository() {
    if (!fs.existsSync(".git")) return false;
    try {
        return git(["rev-parse", "--is-inside-work-tree"]) === "true";
    } catch {
        return false;
    }
}

function splitLines(value) {
    return String(value || "")
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);
}

function normalizeRepositoryPath(value) {
    return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function isProtectedPath(value) {
    return PROTECTED_PATH_PATTERN.test(normalizeRepositoryPath(value));
}

function listTrackedProtectedFiles() {
    if (!isGitRepository()) throw new Error("Git repository is unavailable");
    return splitLines(git(["ls-files", PROTECTED_ROOT_FILE, PROTECTED_DIRECTORY]))
        .map(normalizeRepositoryPath)
        .filter(isProtectedPath)
        .sort((a, b) => a.localeCompare(b));
}

function gitBlobSha(file) {
    const normalized = normalizeRepositoryPath(file);
    if (!isProtectedPath(normalized)) throw new Error(`Unsafe protected path: ${normalized}`);
    return git(["hash-object", "--", normalized]);
}

function manifestEntryMatches(file, expected) {
    const value = String(expected || "").trim();
    const expectedBlob = value.slice(GIT_BLOB_PREFIX.length);
    return value.startsWith(GIT_BLOB_PREFIX) &&
        /^[a-f0-9]{40}$/i.test(expectedBlob) &&
        gitBlobSha(file) === expectedBlob;
}

function validateManifest() {
    const tracked = listTrackedProtectedFiles();
    const manifestFiles = Object.keys(PROTECTED_DIGESTS)
        .map(normalizeRepositoryPath)
        .sort((a, b) => a.localeCompare(b));
    const missing = tracked.filter(file => !manifestFiles.includes(file));
    const extra = manifestFiles.filter(file => !tracked.includes(file));
    const malformed = manifestFiles.filter(file => {
        const value = String(PROTECTED_DIGESTS[file] || "");
        return !/^git:[a-f0-9]{40}$/i.test(value);
    });
    const mismatched = tracked.filter(file => !malformed.includes(file) && !manifestEntryMatches(file, PROTECTED_DIGESTS[file]));

    if (missing.length || extra.length || malformed.length || mismatched.length) {
        console.error("[PROTECTED-PATHS] protected manifest is incomplete or does not match the current files.");
        for (const file of missing) console.error(`- missing manifest entry: ${file}`);
        for (const file of extra) console.error(`- stale manifest entry: ${file}`);
        for (const file of malformed) console.error(`- malformed manifest entry: ${file}`);
        for (const file of mismatched) console.error(`- digest mismatch: ${file}`);
        return false;
    }

    console.log(`[PROTECTED-PATHS] manifest covers ${tracked.length} protected files.`);
    return true;
}

function main() {
    if (!validateManifest()) process.exitCode = 1;
    if (!process.exitCode) console.log("[PROTECTED-PATHS] manifest verified; external owner approval is disabled.");
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`[PROTECTED-PATHS] ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    GIT_BLOB_PREFIX,
    gitBlobSha,
    isProtectedPath,
    listTrackedProtectedFiles,
    manifestEntryMatches,
    normalizeRepositoryPath,
    validateManifest
};
