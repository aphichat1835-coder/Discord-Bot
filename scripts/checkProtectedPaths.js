#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const PROTECTED_PATH_PATTERN = /^discord\/systemProvider(?:\.js|\/)/;
const ZERO_SHA_PATTERN = /^0+$/;

function git(args) {
    return execFileSync("git", args, {
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

function readEventBaseSha() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || !fs.existsSync(eventPath)) return "";

    try {
        const event = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        return String(event.pull_request?.base?.sha || event.before || "").trim();
    } catch {
        return "";
    }
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
        console.warn("[PROTECTED-PATHS] .git not found or unusable; skipping protected-path diff guard.");
        return [];
    }

    const configuredBase = String(process.env.PROTECTED_BASE_SHA || "").trim();
    const baseSha = configuredBase || readEventBaseSha();

    if (isUsableBaseSha(baseSha)) {
        return splitLines(git(["diff", "--name-only", `${baseSha}...HEAD`]));
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

if (protectedChanges.length > 0) {
    console.error("[PROTECTED-PATHS] owner-locked files changed:");
    for (const file of protectedChanges) console.error(`- ${file}`);
    console.error(
        "Remove these changes; protected edits require explicit current-task owner approval and a scoped validation path."
    );
    process.exit(1);
}

console.log("[PROTECTED-PATHS] owner-locked file and directory are unchanged.");
