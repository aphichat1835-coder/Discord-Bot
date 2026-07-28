#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const PROTECTED_DIGESTS = require("../.github/protected-path-digests.json");

const PROTECTED_ROOT_FILE = "discord/systemProvider.js";
const PROTECTED_DIRECTORY = "discord/systemProvider";
const PROTECTED_PATH_PATTERN = /^discord\/systemProvider(?:\.js|\/[^/].*)$/;
const ZERO_SHA_PATTERN = /^0+$/;
const APPROVAL_MARKER_PREFIX = "<!-- protected-owner-approval:";
const APPROVAL_PAGE_SIZE = 100;
const APPROVAL_MAX_PAGES = 100;

function resolveGitBin() {
    for (const candidate of ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git", "/bin/git"]) {
        if (fs.existsSync(candidate)) return candidate;
    }
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

function normalizeRepositoryPath(value) {
    return String(value || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function isProtectedPath(value) {
    return PROTECTED_PATH_PATTERN.test(normalizeRepositoryPath(value));
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

function listTrackedProtectedFiles() {
    if (!isGitRepository()) throw new Error("Git repository is unavailable");
    return splitLines(git(["ls-files", PROTECTED_ROOT_FILE, PROTECTED_DIRECTORY]))
        .map(normalizeRepositoryPath)
        .filter(isProtectedPath)
        .sort();
}

function readProtectedFile(file) {
    const normalized = normalizeRepositoryPath(file);
    if (!isProtectedPath(normalized)) throw new Error(`Unsafe protected path: ${normalized}`);

    const repositoryRoot = fs.realpathSync(process.cwd());
    const resolved = fs.realpathSync(path.resolve(repositoryRoot, normalized));
    const protectedRoot = path.resolve(repositoryRoot, PROTECTED_DIRECTORY);
    const protectedFile = path.resolve(repositoryRoot, PROTECTED_ROOT_FILE);
    if (resolved !== protectedFile && !resolved.startsWith(`${protectedRoot}${path.sep}`)) {
        throw new Error(`Protected path escaped its boundary: ${normalized}`);
    }
    return fs.readFileSync(resolved);
}

function sha256(content) {
    return crypto.createHash("sha256").update(content).digest("hex");
}

function validateManifest() {
    const tracked = listTrackedProtectedFiles();
    const manifestFiles = Object.keys(PROTECTED_DIGESTS).map(normalizeRepositoryPath).sort();
    const missing = tracked.filter(file => !manifestFiles.includes(file));
    const extra = manifestFiles.filter(file => !tracked.includes(file));
    const mismatched = tracked.filter(file => sha256(readProtectedFile(file)) !== PROTECTED_DIGESTS[file]);

    if (missing.length || extra.length || mismatched.length) {
        console.error("[PROTECTED-PATHS] protected manifest is incomplete or does not match the current files.");
        for (const file of missing) console.error(`- missing manifest entry: ${file}`);
        for (const file of extra) console.error(`- stale manifest entry: ${file}`);
        for (const file of mismatched) console.error(`- digest mismatch: ${file}`);
        return false;
    }

    console.log(`[PROTECTED-PATHS] manifest covers ${tracked.length} protected files.`);
    return true;
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

    return [...new Set([
        ...splitLines(git(["diff", "--name-only", "HEAD"])),
        ...splitLines(git(["diff", "--cached", "--name-only"])),
        ...splitLines(git(["ls-files", "--others", "--exclude-standard"]))
    ])];
}

function readEventPayload() {
    const eventPath = String(process.env.GITHUB_EVENT_PATH || "").trim();
    if (!eventPath || !fs.existsSync(eventPath)) return null;
    try {
        return JSON.parse(fs.readFileSync(eventPath, "utf8"));
    } catch {
        return null;
    }
}

function ownerApprovalUrl(repository, pullNumber, page) {
    const params = new URLSearchParams({
        per_page: String(APPROVAL_PAGE_SIZE),
        page: String(page),
        sort: "created",
        direction: "desc"
    });
    return `https://api.github.com/repos/${repository}/issues/${pullNumber}/comments?${params}`;
}

async function fetchOwnerApproval({ repository, owner, pullNumber, headSha, token }) {
    const marker = `${APPROVAL_MARKER_PREFIX}${headSha} -->`;
    for (let page = 1; page <= APPROVAL_MAX_PAGES; page++) {
        const response = await fetch(ownerApprovalUrl(repository, pullNumber, page), {
            headers: {
                accept: "application/vnd.github+json",
                authorization: `Bearer ${token}`,
                "user-agent": "discord-bot-protected-path-guard",
                "x-github-api-version": "2022-11-28"
            }
        });
        if (!response.ok) throw new Error(`GitHub approval lookup failed with HTTP ${response.status}`);
        const comments = await response.json();
        if (!Array.isArray(comments)) throw new Error("GitHub approval lookup returned an invalid response");
        if (comments.some(comment =>
            String(comment?.user?.login || "").toLowerCase() === owner.toLowerCase() &&
            String(comment?.body || "").includes(marker)
        )) return true;
        if (comments.length < APPROVAL_PAGE_SIZE) return false;
    }
    throw new Error(`GitHub approval lookup exceeded ${APPROVAL_MAX_PAGES} pages`);
}

async function hasExternalOwnerApproval() {
    if (String(process.env.PROTECTED_OWNER_APPROVAL || "").trim() === "1" && !process.env.CI) {
        console.warn("[PROTECTED-PATHS] local explicit owner approval override is active.");
        return true;
    }

    const eventName = String(process.env.GITHUB_EVENT_NAME || "").trim();
    const event = readEventPayload();
    const repository = String(process.env.GITHUB_REPOSITORY || event?.repository?.full_name || "").trim();
    const owner = String(event?.repository?.owner?.login || repository.split("/")[0] || "").trim();
    const pullNumber = Number(event?.pull_request?.number);
    const headSha = String(event?.pull_request?.head?.sha || "").trim();
    const token = String(process.env.GITHUB_TOKEN || "").trim();

    if (eventName !== "pull_request" || !repository || !owner || !Number.isSafeInteger(pullNumber) || !headSha || !token) {
        console.error("[PROTECTED-PATHS] protected edits require a pull-request owner approval bound to the exact head SHA.");
        return false;
    }

    const approved = await fetchOwnerApproval({ repository, owner, pullNumber, headSha, token });
    if (!approved) {
        console.error(`[PROTECTED-PATHS] missing owner approval marker for protected head ${headSha}.`);
    }
    return approved;
}

async function main() {
    if (!validateManifest()) process.exitCode = 1;
    if (process.exitCode) return;

    const protectedChanges = getChangedPaths()
        .map(normalizeRepositoryPath)
        .filter(isProtectedPath)
        .sort();

    if (!protectedChanges.length) {
        console.log("[PROTECTED-PATHS] owner-locked file and directory are unchanged.");
        return;
    }

    if (!await hasExternalOwnerApproval()) {
        console.error("[PROTECTED-PATHS] owner-locked files changed without external current-head approval:");
        for (const file of protectedChanges) console.error(`- ${file}`);
        process.exitCode = 1;
        return;
    }

    console.log(`[PROTECTED-PATHS] external owner approval verified for ${protectedChanges.length} protected changes.`);
}

if (require.main === module) {
    main().catch(error => {
        console.error(`[PROTECTED-PATHS] ${error.message}`);
        process.exitCode = 1;
    });
}

module.exports = {
    APPROVAL_MARKER_PREFIX,
    APPROVAL_MAX_PAGES,
    APPROVAL_PAGE_SIZE,
    fetchOwnerApproval,
    isProtectedPath,
    listTrackedProtectedFiles,
    normalizeRepositoryPath,
    ownerApprovalUrl,
    sha256,
    validateManifest
};