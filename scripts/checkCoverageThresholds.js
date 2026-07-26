#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { readFiniteNumber } = require("../discord/core/numbers");

const DEFAULT_THRESHOLDS = Object.freeze({
    statements: 35,
    lines: 35,
    functions: 30,
    branches: 25
});

function percentage(covered, total) {
    if (!Number.isFinite(total) || total <= 0) return 100;
    return (covered / total) * 100;
}

function parseLcov(source) {
    const totals = {
        lines: { found: 0, hit: 0 },
        functions: { found: 0, hit: 0 },
        branches: { found: 0, hit: 0 }
    };
    for (const rawLine of String(source || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        const [key, rawValue] = line.split(":", 2);
        const value = Number(rawValue);
        if (!Number.isFinite(value)) continue;
        if (key === "LF") totals.lines.found += value;
        else if (key === "LH") totals.lines.hit += value;
        else if (key === "FNF") totals.functions.found += value;
        else if (key === "FNH") totals.functions.hit += value;
        else if (key === "BRF") totals.branches.found += value;
        else if (key === "BRH") totals.branches.hit += value;
    }
    return totals;
}

function resolveThreshold(name, env = process.env) {
    return readFiniteNumber(env[`COVERAGE_${name.toUpperCase()}_MIN`], {
        fallback: DEFAULT_THRESHOLDS[name],
        min: 0,
        max: 100
    });
}

function evaluateCoverage(totals, env = process.env) {
    const metrics = {
        statements: percentage(totals.lines.hit, totals.lines.found),
        lines: percentage(totals.lines.hit, totals.lines.found),
        functions: percentage(totals.functions.hit, totals.functions.found),
        branches: percentage(totals.branches.hit, totals.branches.found)
    };
    const thresholds = Object.fromEntries(
        Object.keys(DEFAULT_THRESHOLDS).map(name => [name, resolveThreshold(name, env)])
    );
    const failures = Object.keys(metrics).filter(name => metrics[name] + Number.EPSILON < thresholds[name]);
    return { metrics, thresholds, failures };
}

function formatPercent(value) {
    return `${value.toFixed(2)}%`;
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
        const result = evaluateCoverage(parseLcov(fs.readFileSync(normalized, "utf8")));
        const summary = Object.keys(result.metrics)
            .map(name => `${name}=${formatPercent(result.metrics[name])} (min ${formatPercent(result.thresholds[name])})`)
            .join(", ");
        console.log(`[COVERAGE] ${file}: ${summary}`);
        if (result.failures.length) {
            console.error(`[COVERAGE] ${file} below threshold: ${result.failures.join(", ")}`);
            failed = true;
        }
    }

    if (failed) process.exitCode = 1;
}

if (require.main === module) runCli();

module.exports = {
    DEFAULT_THRESHOLDS,
    evaluateCoverage,
    parseLcov,
    percentage,
    resolveThreshold
};
