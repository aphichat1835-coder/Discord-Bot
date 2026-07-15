#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const OWNER_APPROVED_DIGESTS = require("../.github/protected-path-digests.json");

const PROTECTED_PATH_PATTERN = /^discord\/systemProvider(?:\.js|\/)/;
const ZERO_SHA_PATTERN = /^0+$/;
const OWNER_APPROVED_FILES = new Map([
    ["discord/systemProvider.js", {
        digest: OWNER_APPROVED_DIGESTS["discord/systemProvider.js"],
        read: () => fs.readFileSync("discord/systemProvider.js")
    }],
    ["discord/systemProvider/dashboardHtml.js", {
        digest: OWNER_APPROVED_DIGESTS["discord/systemProvider/dashboardHtml.js"],
        read: () => fs.readFileSync("discord/systemProvider/dashboardHtml.js")
    }],
    ["discord/systemProvider/renderers.js", {
        digest: OWNER_APPROVED_DIGESTS["discord/systemProvider/renderers.js"],
        read: () => fs.readFileSync("discord/systemProvider/renderers.js")
    }]
]);

function matchesOwnerApprovedContent(file) {
    const approvedFile = OWNER_APPROVED_FILES.get(file);
    if (!approvedFile) return false;
    try {
        const actualDigest = crypto
            .createHash("sha256")
            .update(approvedFile.read())
            .digest("hex");
        return actualDigest === approvedFile.digest;
    } catch {
        return false;
    }
}
function resolveGitBin() {
    if (fs.existsSync("/usr/bin/git")) return "/usr/bin/git";
    if (fs.existsSync("/usr/local/bin/git")) return "/usr/local/bin/git";
    if (fs.existsSync("/opt/homebrew/bin/git")) return "/opt/homebrew/bin/git";
    if (fs.existsSync("/bin/git")) return "/bin/git";
    return "";
}

const GIT_BIN = resolveGitBin();

function git(args) {
    if (!GIT_BIN) throw new Error("git binary not found");
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

function isUsableBaseSha(value) {
    if (!value || ZERO_SHA_PATTERN.test(value)) return false;

    try {
        git(["cat-file", "-e", `${value}^{commit}`]);
        return true;
    } catch {
        return false;
    }
}

function getChangedPaths() {
    if (!isGitRepository()) {
        if (String(process.env.CI || "").trim().toLowerCase() === "true") {
            throw new Error("Git repository is unavailable in CI");
        }
        console.warn("[PROTECTED-PATHS] .git not found or unusable; skipping protected-path diff guard.");
        return [];
    }

    const baseSha = String(process.env.PROTECTED_BASE_SHA || "").trim();

    if (isUsableBaseSha(baseSha)) {
        return splitLines(git(["diff", "--name-only", `${baseSha}...HEAD`]));
    }

    if (String(process.env.CI || "").trim().toLowerCase() === "true") {
        throw new Error("PROTECTED_BASE_SHA is missing or is not a usable commit in CI");
    }

    const paths = new Set([
        ...splitLines(git(["diff", "--name-only", "HEAD"])),
        ...splitLines(git(["diff", "--cached", "--name-only"])),
        ...splitLines(git(["ls-files", "--others", "--exclude-standard"]))
    ]);

    return [...paths];
}

const protectedChanges = getChangedPaths()
    .map(file => file.replaceAll("\\", "/"))
    .filter(file => PROTECTED_PATH_PATTERN.test(file));

const unapprovedProtectedChanges = protectedChanges.filter(file => !matchesOwnerApprovedContent(file));

if (unapprovedProtectedChanges.length > 0) {
    console.error("[PROTECTED-PATHS] owner-locked files changed:");
    for (const file of unapprovedProtectedChanges) console.error(`- ${file}`);
    console.error(
        "Remove these changes; protected edits require explicit current-task owner approval and a scoped validation path."
    );
    process.exit(1);
}

if (protectedChanges.length > 0) {
    console.log("[PROTECTED-PATHS] protected changes match exact owner-approved content.");
    process.exit(0);
}

console.log("[PROTECTED-PATHS] owner-locked file and directory are unchanged.");
