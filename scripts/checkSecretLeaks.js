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
        regex: /(?<![A-Za-z0-9_])[A-Za-z\d]{20,30}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{25,50}(?![A-Za-z0-9_])/g
    },
    {
        code: "GITHUB_TOKEN_LITERAL",
        regex: /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})/g
    },
    {
        code: "AWS_ACCESS_KEY_LITERAL",
        regex: /AKIA[0-9A-Z]{16}/g
    },
    {
        code: "MONGODB_CREDENTIAL_LITERAL",
        regex: /mongodb(?:\+srv)?:\/\/[^\s"']+:[^\s"']+@/gi
    },
    {
        code: "DISCORD_WEBHOOK_LITERAL",
        regex: /https:\/\/(?:discord(?:app)?\.com)\/api\/webhooks\/\d+\/[A-Za-z0-9._-]{20,}/gi
    },
    {
        code: "PRIVATE_KEY_LITERAL",
        regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g
    }
];

const ASSIGNMENT_PATTERN = /\b(token|secret|password|pin|api[_-]?key|webhook(?:url)?)\b\s*[:=]\s*["']([^"']{12,})["']/gi;
const PLACEHOLDER_PATTERN = /(?:example|placeholder|redacted|dummy|changeme|replace[-_ ]?me|<[^>]+>|\$\{|process\.env)/i;

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

    ASSIGNMENT_PATTERN.lastIndex = 0;
    for (const match of source.matchAll(ASSIGNMENT_PATTERN)) {
        const value = String(match[2] || "");
        if (PLACEHOLDER_PATTERN.test(value)) continue;
        findings.push({
            code: "HARDCODED_SECRET_ASSIGNMENT",
            filePath,
            line: lineNumber(source, match.index)
        });
    }

    return findings;
}

function trackedFiles() {
    const result = spawnSync("git", ["ls-files", "-z"], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024
    });
    if (result.status !== 0) {
        throw new Error("unable to enumerate tracked files for secret scanning");
    }
    return result.stdout.split("\0").filter(Boolean);
}

function scanRepository(root = process.cwd()) {
    const findings = [];
    for (const relativePath of trackedFiles()) {
        if (!shouldScanPath(relativePath)) continue;
        const absolutePath = path.join(root, relativePath);
        let buffer;
        try {
            buffer = fs.readFileSync(absolutePath);
        } catch {
            continue;
        }
        if (buffer.length > 2 * 1024 * 1024 || buffer.includes(0)) continue;
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
    scanRepository,
    shouldScanPath
};
