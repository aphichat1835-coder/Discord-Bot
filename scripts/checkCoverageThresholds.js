#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readFiniteNumber } = require("../discord/core/numbers");

const DEFAULT_THRESHOLDS = Object.freeze({
    lines: 35,
    functions: 30,
    branches: 25
});

const CRITICAL_FILE_THRESHOLDS = Object.freeze({
    "discord.lcov": Object.freeze({
        "discord/commands/utility.js": Object.freeze({ lines: 40, functions: 74, branches: 65 })
    }),
    "voice.lcov": Object.freeze({
        "discord/voiceWorker/lifecycle.js": Object.freeze({ lines: 18, functions: 13, branches: 36 })
    }),
    "verification.lcov": Object.freeze({
        "discord/verification/services/privacyDeletion.js": Object.freeze({ lines: 89, functions: 80, branches: 68 }),
        "discord/verification/services/verificationStateNonce.js": Object.freeze({ lines: 98, functions: 98, branches: 42 }),
        "discord/verification/utils/oauthTokenLifecycle.js": Object.freeze({ lines: 51, functions: 56, branches: 52 }),
        "discord/verification/routes/guild.js": Object.freeze({ lines: 21, functions: 18, branches: 34 }),
        "discord/verification/routes/oauth.js": Object.freeze({ lines: 40, functions: 66, branches: 67 }),
        "discord/verification/routes/oauthStart.js": Object.freeze({ lines: 95, functions: 98, branches: 68 })
    })
});

function emptyTotals() {
    return {
        sourceFiles: 0,
        lines: { found: 0, hit: 0 },
        functions: { found: 0, hit: 0 },
        branches: { found: 0, hit: 0 }
    };
}

function normalizeCoveragePath(value) {
    const normalized = String(value || "").replaceAll("\\", "/").replace(/^file:\/\//, "");
    for (const marker of ["discord/", "scripts/", "verification-tests/"]) {
        const index = normalized.indexOf(marker);
        if (index >= 0) return normalized.slice(index);
    }
    return normalized.replace(/^\.\//, "");
}

function percentage(covered, total) {
    if (!Number.isFinite(covered) || !Number.isFinite(total) || total <= 0) return Number.NaN;
    return (covered / total) * 100;
}

function addMetric(target, key, value) {
    if (key === "LF") target.lines.found += value;
    else if (key === "LH") target.lines.hit += value;
    else if (key === "FNF") target.functions.found += value;
    else if (key === "FNH") target.functions.hit += value;
    else if (key === "BRF") target.branches.found += value;
    else if (key === "BRH") target.branches.hit += value;
}

function parseLcov(source) {
    const totals = emptyTotals();
    const files = Object.create(null);
    let current = null;
    for (const rawLine of String(source || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith("SF:") && line.slice(3).trim()) {
            const sourcePath = normalizeCoveragePath(line.slice(3).trim());
            current = files[sourcePath] || (files[sourcePath] = emptyTotals());
            current.sourceFiles++;
            totals.sourceFiles++;
            continue;
        }
        const [key, rawValue] = line.split(":", 2);
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        addMetric(totals, key, value);
        if (current) addMetric(current, key, value);
    }
    return { ...totals, files };
}

function resolveThreshold(name, env = process.env) {
    return readFiniteNumber(env[`COVERAGE_${name.toUpperCase()}_MIN`], {
        fallback: DEFAULT_THRESHOLDS[name],
        min: 0,
        max: 100
    });
}

function coverageMetrics(totals) {
    return {
        lines: percentage(totals?.lines?.hit, totals?.lines?.found),
        functions: percentage(totals?.functions?.hit, totals?.functions?.found),
        branches: percentage(totals?.branches?.hit, totals?.branches?.found)
    };
}

function evaluateCoverage(totals, env = process.env) {
    const metrics = coverageMetrics(totals);
    const thresholds = Object.fromEntries(
        Object.keys(DEFAULT_THRESHOLDS).map(name => [name, resolveThreshold(name, env)])
    );
    const invalid = [];
    if (!Number.isFinite(Number(totals?.sourceFiles)) || Number(totals.sourceFiles) <= 0) invalid.push("sourceFiles");
    for (const name of Object.keys(metrics)) {
        if (!Number.isFinite(metrics[name])) invalid.push(name);
    }
    const failures = Object.keys(metrics).filter(name =>
        !Number.isFinite(metrics[name]) || metrics[name] + Number.EPSILON < thresholds[name]
    );
    return { metrics, thresholds, invalid, failures };
}

function evaluateCriticalFiles(parsed, thresholds = {}) {
    const results = [];
    const failures = [];
    for (const [sourcePath, required] of Object.entries(thresholds)) {
        const totals = parsed?.files?.[normalizeCoveragePath(sourcePath)] || null;
        if (!totals) {
            const item = { sourcePath, missing: true, metrics: {}, thresholds: required, failures: ["missing"] };
            results.push(item);
            failures.push(item);
            continue;
        }
        const metrics = coverageMetrics(totals);
        const failedMetrics = Object.keys(required).filter(name =>
            !Number.isFinite(metrics[name]) || metrics[name] + Number.EPSILON < Number(required[name])
        );
        const item = { sourcePath, missing: false, metrics, thresholds: required, failures: failedMetrics };
        results.push(item);
        if (failedMetrics.length) failures.push(item);
    }
    return { results, failures };
}

function formatPercent(value) {
    return Number.isFinite(value) ? `${value.toFixed(2)}%` : "n/a";
}

function runCli(args = process.argv.slice(2)) {
    const files = args.length ? args : [
        "coverage/discord.lcov",
        "coverage/voice.lcov",
        "coverage/verification.lcov"
    ];
    let failed = false;

    for (const file of files) {
        const normalized = path.normalize(file);
        if (!fs.existsSync(normalized) || fs.statSync(normalized).size === 0) {
            console.error(`[COVERAGE] missing or empty report: ${file}`);
            failed = true;
            continue;
        }
        const parsed = parseLcov(fs.readFileSync(normalized, "utf8"));
        const result = evaluateCoverage(parsed);
        const summary = Object.keys(result.metrics)
            .map(name => `${name}=${formatPercent(result.metrics[name])} (min ${formatPercent(result.thresholds[name])})`)
            .join(", ");
        console.log(`[COVERAGE] ${file}: ${summary}`);
        if (result.invalid.length) {
            console.error(`[COVERAGE] ${file} has missing coverage data: ${result.invalid.join(", ")}`);
            failed = true;
        }
        if (result.failures.length) {
            console.error(`[COVERAGE] ${file} below threshold: ${result.failures.join(", ")}`);
            failed = true;
        }

        const critical = evaluateCriticalFiles(parsed, CRITICAL_FILE_THRESHOLDS[path.basename(normalized)] || {});
        for (const item of critical.results) {
            if (item.missing) {
                console.error(`[COVERAGE] critical file missing from ${file}: ${item.sourcePath}`);
                continue;
            }
            const details = Object.keys(item.thresholds)
                .map(name => `${name}=${formatPercent(item.metrics[name])} (min ${formatPercent(item.thresholds[name])})`)
                .join(", ");
            console.log(`[COVERAGE] critical ${item.sourcePath}: ${details}`);
            if (item.failures.length) {
                console.error(`[COVERAGE] critical ${item.sourcePath} below threshold: ${item.failures.join(", ")}`);
            }
        }
        if (critical.failures.length) failed = true;
    }

    if (failed) process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
    CRITICAL_FILE_THRESHOLDS,
    DEFAULT_THRESHOLDS,
    coverageMetrics,
    evaluateCoverage,
    evaluateCriticalFiles,
    formatPercent,
    normalizeCoveragePath,
    parseLcov,
    percentage,
    resolveThreshold
};
