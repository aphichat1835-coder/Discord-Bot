#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const SKIPPED_PREFIXES = [
    "discord/tests/",
    "verification-tests/",
    "coverage/",
    "node_modules/"
];

const PATTERNS = [
    {
        code: "DISCORD_TOKEN_LITERAL",
        regex: /(?<![\w-])[\w-]{20,30}\.[\w-]{6}\.[\w-]{25,50}(?![\w-])/g
    },
    {
        code: "GITHUB_TOKEN_LITERAL",
        regex: /(?:github_pat_\w{20,255}|gh[pousr]_[A-Za-z0-9]{30,255})/g
    },
    {
        code: "AWS_ACCESS_KEY_LITERAL",
        regex: /AKIA[0-9A-Z]{16}/g
    },
    {
        code: "MONGODB_CREDENTIAL_LITERAL",
        regex: /mongodb(?:\+srv)?:\/\/[^\s"'@:/]{1,256}:[^\s"'@/]{1,256}@/gi
    },
    {
        code: "DISCORD_WEBHOOK_LITERAL",
        regex: /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d{5,25}\/[A-Za-z0-9._-]{20,255}/gi
    },
    {
        code: "PRIVATE_KEY_LITERAL",
        regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
    }
];

const ASSIGNMENT_NAME_PATTERN = /\b(?:token|secret|password|pin|api[_-]?key|webhook(?:url)?)\b/gi;
const MAX_ASSIGNMENT_LINE_LENGTH = 4096;
const MAX_SCANNED_FILE_BYTES = 2 * 1024 * 1024;
const REPOSITORY_ROOT = path.resolve(__dirname, "..");
const GIT_BINARY = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
const PLACEHOLDER_PATTERN = /(?:example|placeholder|redacted|dummy|changeme|replace[-_ ]?me|<[^>]+>|\$\{|\$[A-Z_][A-Z0-9_]*|process\.env)/i;

function resolveTrackedPath(root, relativePath) {
    const repositoryRoot = path.resolve(root);
    const resolved = path.resolve(repositoryRoot, String(relativePath || ""));
    const relative = path.relative(repositoryRoot, resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("tracked path escaped repository root");
    }
    return resolved;
}

function extractAssignmentValue(line, match) {
    const tail = line.slice(match.index + match[0].length);
    const assignment = /^\s*[:=]\s*(["'])/.exec(tail);
    if (!assignment) return null;
    const valueStart = match.index + match[0].length + assignment[0].length;
    const valueEnd = line.indexOf(assignment[1], valueStart);
    return valueEnd === -1 ? null : line.slice(valueStart, valueEnd);
}

function isSecretCandidate(value) {
    return value !== null &&
        value.length >= 12 &&
        value.length <= 512 &&
        !PLACEHOLDER_PATTERN.test(value);
}

function assignmentFindings(source, filePath) {
    const findings = [];
    let offset = 0;
    for (const line of source.split(/\r?\n/)) {
        if (line.length <= MAX_ASSIGNMENT_LINE_LENGTH) {
            ASSIGNMENT_NAME_PATTERN.lastIndex = 0;
            for (const match of line.matchAll(ASSIGNMENT_NAME_PATTERN)) {
                const value = extractAssignmentValue(line, match);
                if (!isSecretCandidate(value)) continue;
                findings.push({
                    code: "HARDCODED_SECRET_ASSIGNMENT",
                    filePath,
                    line: lineNumber(source, offset + match.index)
                });
            }
        }
        offset += line.length + 1;
    }
    return findings;
}

function shouldScanPath(filePath) {
    const normalized = String(filePath || "").replaceAll("\\", "/");
    return normalized && !SKIPPED_PREFIXES.some(prefix => normalized.startsWith(prefix));
}

function lineNumber(text, index) {
    return text.slice(0, index).split("\n").length;
}

function analyzeText(text, filePath = "fixture") {
    const source = String(text || "");
    const findings = [];

    for (const { code, regex } of PATTERNS) {
        regex.lastIndex = 0;
        for (const match of source.matchAll(regex)) {
            findings.push({ code, filePath, line: lineNumber(source, match.index) });
        }
    }

    findings.push(...assignmentFindings(source, filePath));
    return findings;
}

function trackedFiles(root = REPOSITORY_ROOT) {
    const result = spawnSync(GIT_BINARY, ["ls-files", "-z"], {
        cwd: path.resolve(root),
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error("unable to enumerate tracked files for secret scanning");
    }
    return result.stdout.split("\0").filter(Boolean);
}

function scanRepository(root = REPOSITORY_ROOT) {
    const repositoryRoot = path.resolve(root);
    const findings = [];
    for (const relativePath of trackedFiles(repositoryRoot)) {
        if (!shouldScanPath(relativePath)) continue;
        let absolutePath;
        try {
            absolutePath = resolveTrackedPath(repositoryRoot, relativePath);
        } catch {
            continue;
        }
        let buffer;
        try {
            buffer = fs.readFileSync(absolutePath);
        } catch {
            continue;
        }
        if (buffer.length > MAX_SCANNED_FILE_BYTES || buffer.includes(0)) continue;
        findings.push(...analyzeText(buffer.toString("utf8"), relativePath));
    }
    return findings;
}

function main() {
    const findings = scanRepository();
    if (findings.length === 0) {
        console.log("[SECRET-GUARD] no tracked production credential literals detected");
        return;
    }

    console.error(`[SECRET-GUARD] detected ${findings.length} possible credential literal(s)`);
    for (const finding of findings) {
        console.error(`${finding.code} ${finding.filePath}:${finding.line}`);
    }
    process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
    analyzeText,
    resolveTrackedPath,
    scanRepository,
    shouldScanPath
};
