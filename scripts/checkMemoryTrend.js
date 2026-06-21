#!/usr/bin/env node
"use strict";

function numberEnv(name, fallback, min = 0) {
    const value = Number(process.env[name]);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, value);
}

const LIMITS = {
    heapGrowthMb: numberEnv("MEMORY_TREND_HEAP_GROWTH_MB", 40, 0),
    rssGrowthMb: numberEnv("MEMORY_TREND_RSS_GROWTH_MB", 80, 0),
    listenerGrowth: numberEnv("MEMORY_TREND_LISTENER_GROWTH", 5, 0),
    handleGrowth: numberEnv("MEMORY_TREND_HANDLE_GROWTH", 20, 0),
    cacheGrowth: numberEnv("MEMORY_TREND_CACHE_GROWTH", 500, 0)
};

function usage() {
    console.error("Usage: node scripts/checkMemoryTrend.js < diagnostics.json");
    console.error("Expected JSON shape: /api/diagnostics response with memoryMonitor.trend, or a direct { trend: [...] } object.");
}

function readJsonFromStdin() {
    return new Promise((resolve, reject) => {
        let input = "";

        process.stdin.setEncoding("utf8");
        process.stdin.on("data", chunk => {
            input += chunk;
        });
        process.stdin.on("error", err => {
            reject(new Error(`Failed to read JSON: ${err.message}`));
        });
        process.stdin.on("end", () => {
            try {
                resolve(JSON.parse(input));
            } catch (err) {
                reject(new Error(`Failed to read JSON: ${err.message}`));
            }
        });
    });
}

function getTrend(input) {
    if (Array.isArray(input)) return input;
    if (Array.isArray(input?.trend)) return input.trend;
    if (Array.isArray(input?.memoryMonitor?.trend)) return input.memoryMonitor.trend;
    throw new Error("No memory trend found. Expected trend or memoryMonitor.trend.");
}

function asNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function delta(first, last, key) {
    return Math.round((asNumber(last[key]) - asNumber(first[key])) * 10) / 10;
}

function checkGrowth(findings, first, last, key, label, limit) {
    const growth = delta(first, last, key);
    if (growth > limit) {
        findings.push(`${label} grew by ${growth}, limit ${limit}`);
    }
    return growth;
}

function checkCacheGrowth(findings, first, last, keys) {
    for (const key of keys) {
        checkGrowth(findings, first, last, key, key, LIMITS.cacheGrowth);
    }
}

function evaluateTrend(input) {
    const trend = getTrend(input).filter(Boolean);

    if (trend.length < 2) {
        throw new Error(`Need at least 2 trend samples, got ${trend.length}.`);
    }

    const first = trend[0];
    const last = trend[trend.length - 1];
    const findings = [];
    const summary = {
        samples: trend.length,
        from: first.at || null,
        to: last.at || null,
        heapGrowthMb: checkGrowth(findings, first, last, "heapUsed", "heapUsedMB", LIMITS.heapGrowthMb),
        rssGrowthMb: checkGrowth(findings, first, last, "rss", "rssMB", LIMITS.rssGrowthMb),
        listenerGrowth: checkGrowth(findings, first, last, "discordListeners", "discordListeners", LIMITS.listenerGrowth),
        selfClientListenerGrowth: checkGrowth(findings, first, last, "selfClientListeners", "selfClientListeners", LIMITS.listenerGrowth),
        handleGrowth: checkGrowth(findings, first, last, "activeHandles", "activeHandles", LIMITS.handleGrowth),
        limits: LIMITS
    };

    checkCacheGrowth(findings, first, last, [
        "selfClientMessages",
        "selfClientUsers",
        "discordMessages",
        "discordUsers"
    ]);

    return { summary, findings };
}

async function main() {
    if (process.argv[2]) {
        usage();
        process.exit(2);
    }

    const input = await readJsonFromStdin();
    const { summary, findings } = evaluateTrend(input);

    console.log(JSON.stringify(summary, null, 2));

    if (findings.length) {
        console.error("[MEMORY-TREND] unstable:");
        for (const finding of findings) {
            console.error(`- ${finding}`);
        }
        process.exit(1);
    }

    console.log("[MEMORY-TREND] stable within configured thresholds.");
}

if (require.main === module) {
    main().catch(err => {
        console.error(`[MEMORY-TREND] ${err.message}`);
        process.exit(1);
    });
}

module.exports = {
    LIMITS,
    evaluateTrend,
    getTrend
};
