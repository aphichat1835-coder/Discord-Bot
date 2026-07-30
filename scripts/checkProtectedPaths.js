#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const { execFileSync } = require("node:child_process");
const PROTECTED_DIGESTS = require("../.github/protected-path-digests.json");

const PROTECTED_ROOT_FILE = "discord/systemProvider.js";
const PROTECTED_DIRECTORY = "discord/systemProvider";
const PROTECTED_PATH_PATTERN = /^discord\/systemProvider(?:\.js|\/[^/].*)$/;
const ZERO_SHA_PATTERN = /^0+$/;
const APPROVAL_MARKER_PREFIX = "<!-- protected-owner-approval:";
const APPROVAL_PAGE_SIZE = 100;
const APPROVAL_MAX_PAGES = 100;
const APPROVAL_RESPONSE_MAX_BYTES = 512 * 1024;
const APPROVAL_REQUEST_TIMEOUT_MS = 10_000;
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

function isUsableBaseSha(value) {
    if (!/^[a-f0-9]{40}$/i.test(String(value || "")) || ZERO_SHA_PATTERN.test(value)) return false;
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
    if (!eventPath) return null;
    // nosemgrep -- GitHub supplies GITHUB_EVENT_PATH; basename and RUNNER_TEMP containment are checked before reading.
    const resolved = path.resolve(eventPath);
    if (path.basename(resolved) !== "event.json") return null;
    const runnerTemp = String(process.env.RUNNER_TEMP || "").trim();
    if (process.env.CI && runnerTemp) {
        // nosemgrep -- both paths are normalized and the event file must remain within GitHub's runner temp directory.
        const relative = path.relative(path.resolve(runnerTemp), resolved);
        if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    }
    // nosemgrep -- resolved passed the fixed basename and runner-temp containment checks above.
    if (!fs.existsSync(resolved)) return null;
    try {
        // nosemgrep -- only GitHub's validated event.json file is parsed.
        return JSON.parse(fs.readFileSync(resolved, "utf8"));
    } catch {
        return null;
    }
}

function validateRepositorySlug(repository) {
    const value = String(repository || "").trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
        throw new Error("invalid GitHub repository slug");
    }
    return value;
}

function ownerApprovalRequestOptions(repository, pullNumber, page, token) {
    const safeRepository = validateRepositorySlug(repository);
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("invalid pull request number");
    if (!Number.isSafeInteger(page) || page <= 0 || page > APPROVAL_MAX_PAGES) throw new Error("invalid approval page");
    const query = new URLSearchParams({
        per_page: String(APPROVAL_PAGE_SIZE),
        page: String(page),
        sort: "created",
        direction: "desc"
    });
    return {
        protocol: "https:",
        hostname: "api.github.com",
        port: 443,
        method: "GET",
        path: `/repos/${safeRepository}/issues/${pullNumber}/comments?${query}`,
        headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "user-agent": "discord-bot-protected-path-guard",
            "x-github-api-version": "2022-11-28"
        }
    };
}

function requestGitHubComments(options) {
    return new Promise((resolve, reject) => {
        const request = https.request(options, response => {
            const chunks = [];
            let bytes = 0;
            response.on("data", chunk => {
                bytes += chunk.length;
                if (bytes > APPROVAL_RESPONSE_MAX_BYTES) {
                    request.destroy(new Error("GitHub approval lookup response exceeded the size limit"));
                    return;
                }
                chunks.push(chunk);
            });
            response.once("end", () => {
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    reject(new Error(`GitHub approval lookup failed with HTTP ${response.statusCode}`));
                    return;
                }
                try {
                    resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                } catch {
                    reject(new Error("GitHub approval lookup returned invalid JSON"));
                }
            });
        });
        request.once("error", reject);
        request.setTimeout(APPROVAL_REQUEST_TIMEOUT_MS, () => {
            request.destroy(new Error("GitHub approval lookup timed out"));
        });
        request.end();
    });
}

async function fetchOwnerApproval({ repository, owner, pullNumber, headSha, token, requestComments = requestGitHubComments }) {
    validateRepositorySlug(repository);
    if (!String(owner || "").trim()) throw new Error("invalid repository owner");
    if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("invalid pull request number");
    if (!/^[a-f0-9]{40}$/i.test(String(headSha || ""))) throw new Error("invalid protected head SHA");
    if (!String(token || "").trim()) throw new Error("missing GitHub token");
    const marker = `${APPROVAL_MARKER_PREFIX}${headSha} -->`;
    for (let page = 1; page <= APPROVAL_MAX_PAGES; page++) {
        const comments = await requestComments(ownerApprovalRequestOptions(repository, pullNumber, page, token));
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
        .sort((a, b) => a.localeCompare(b));

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
    APPROVAL_REQUEST_TIMEOUT_MS,
    APPROVAL_RESPONSE_MAX_BYTES,
    GIT_BLOB_PREFIX,
    fetchOwnerApproval,
    gitBlobSha,
    isProtectedPath,
    listTrackedProtectedFiles,
    manifestEntryMatches,
    normalizeRepositoryPath,
    ownerApprovalRequestOptions,
    requestGitHubComments,
    validateManifest
};
