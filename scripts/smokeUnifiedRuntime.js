#!/usr/bin/env node
"use strict";

const DEFAULT_TIMEOUT_MS = Math.max(
    1000,
    Number(process.env.SMOKE_TIMEOUT_MS || 8000) || 8000
);

function usage() {
    return [
        "Usage: node scripts/smokeUnifiedRuntime.js <https://domain>",
        "",
        "Checks the unified single-port runtime after deploy without requiring secrets.",
        "Expected:",
        "- /ping returns 200 OK",
        "- /health returns JSON with 200 or startup/degraded 503",
        "- /auth/callback serves the public callback page",
        "- / and /verification are reachable and may redirect to Owner PIN"
    ].join("\n");
}

function trimTrailingSlashes(value) {
    let text = String(value || "");
    while (text.endsWith("/")) text = text.slice(0, -1);
    return text;
}

function normalizeBaseUrl(input) {
    const raw = String(input || process.env.SMOKE_BASE_URL || "").trim();
    if (!raw) {
        throw new Error("missing base URL\n" + usage());
    }
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) {
        throw new Error("base URL must start with http:// or https://");
    }
    url.pathname = trimTrailingSlashes(url.pathname);
    url.search = "";
    url.hash = "";
    return trimTrailingSlashes(url.toString());
}

async function request(baseUrl, path, { redirect = "manual" } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
    try {
        const response = await fetch(`${baseUrl}${path}`, {
            method: "GET",
            redirect,
            signal: controller.signal,
            headers: {
                "user-agent": "phomueangtai-unified-smoke/1.0"
            }
        });
        const text = await response.text();
        return {
            path,
            status: response.status,
            ok: response.ok,
            contentType: response.headers.get("content-type") || "",
            location: response.headers.get("location") || "",
            text: text.slice(0, 500)
        };
    } finally {
        clearTimeout(timeout);
    }
}

function assert(condition, message, details) {
    if (!condition) {
        const err = new Error(message);
        err.details = details;
        throw err;
    }
}

function isOwnerReachable(result) {
    if ([200, 401, 403, 503].includes(result.status)) return true;
    if ([301, 302, 303, 307, 308].includes(result.status)) {
        return /\/auth\/pin(?:\?|$)/.test(result.location || "");
    }
    return false;
}

function looksLikeHtml(result) {
    return /html/i.test(result.contentType) || /<!doctype html|<html|callback|ยืนยัน/i.test(result.text || "");
}

async function main() {
    const baseUrl = normalizeBaseUrl(process.argv[2]);
    const results = [];

    const ping = await request(baseUrl, "/ping");
    results.push(ping);
    assert(ping.status === 200 && /^OK\b/.test(ping.text), "/ping did not return 200 OK", ping);

    const health = await request(baseUrl, "/health");
    results.push(health);
    assert([200, 503].includes(health.status), "/health should return ready 200 or degraded 503", health);
    assert(/json/i.test(health.contentType) || /^\s*\{/.test(health.text), "/health did not look like JSON", health);

    const callback = await request(baseUrl, "/auth/callback");
    results.push(callback);
    assert(callback.status === 200 && looksLikeHtml(callback), "/auth/callback did not serve callback HTML", callback);

    for (const path of ["/", "/verification"]) {
        const result = await request(baseUrl, path);
        results.push(result);
        assert(isOwnerReachable(result), `${path} was not reachable through Owner boundary`, result);
    }

    console.log("[UNIFIED-SMOKE] ok");
    for (const result of results) {
        const location = result.location ? " location=" + result.location : "";
        console.log(`${result.path} -> ${result.status}${location}`);
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error("[UNIFIED-SMOKE] failed:", err.message);
        if (err.details) {
            console.error(JSON.stringify(err.details, null, 2));
        }
        process.exitCode = 1;
    });
}

module.exports = {
    normalizeBaseUrl,
    trimTrailingSlashes,
    isOwnerReachable,
    looksLikeHtml
};
