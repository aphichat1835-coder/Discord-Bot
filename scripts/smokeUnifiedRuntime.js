#!/usr/bin/env node
"use strict";

const dns = require("node:dns").promises;
const { BlockList, isIP } = require("node:net");

const DEFAULT_TIMEOUT_MS = Math.max(
    1000,
    Number(process.env.SMOKE_TIMEOUT_MS || 8000) || 8000
);
const RESERVED_IPV4 = new BlockList();
const RESERVED_IPV6 = new BlockList();

[
    ["0.0.0.0", 8],
    ["10.0.0.0", 8], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["100.64.0.0", 10], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["127.0.0.0", 8],
    ["169.254.0.0", 16], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["172.16.0.0", 12], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["192.0.0.0", 24], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["192.0.2.0", 24],
    ["192.88.99.0", 24], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["192.168.0.0", 16], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["198.18.0.0", 15], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["240.0.0.0", 4] // NOSONAR -- reserved CIDR used only as an SSRF denylist.
].forEach(([address, prefix]) => RESERVED_IPV4.addSubnet(address, prefix, "ipv4"));

[
    ["::", 128],
    ["::1", 128],
    ["::ffff:0:0", 96], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["64:ff9b:1::", 48], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["100::", 64], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["2001::", 23], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["2001:2::", 48], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["2001:db8::", 32],
    ["2002::", 16], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["fc00::", 7], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["fe80::", 10], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["fec0::", 10], // NOSONAR -- reserved CIDR used only as an SSRF denylist.
    ["ff00::", 8] // NOSONAR -- reserved CIDR used only as an SSRF denylist.
].forEach(([address, prefix]) => RESERVED_IPV6.addSubnet(address, prefix, "ipv6"));

function usage() {
    return [
        "Usage: node scripts/smokeUnifiedRuntime.js <https://domain>",
        "Requires: SMOKE_ALLOWED_HOSTS=domain.example[,other.example]",
        "",
        "Checks the unified single-port runtime after deploy without requiring secrets.",
        "Expected:",
        "- /ping returns 200 OK",
        "- /health returns JSON with 200 or startup/degraded 503",
        "- /auth/callback serves the public callback page",
        "- / and /verification are reachable and may redirect to Owner PIN"
    ].join("\n");
}

function allowedSmokeHosts() {
    return new Set(
        String(process.env.SMOKE_ALLOWED_HOSTS || "")
            .split(",")
            .map(value => value.trim().toLowerCase())
            .filter(Boolean)
    );
}

function trimTrailingSlashes(value) {
    let text = String(value || "");
    while (text.endsWith("/")) text = text.slice(0, -1);
    return text;
}

function stripHostBrackets(value) {
    const host = String(value || "").toLowerCase();
    return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function isBlockedSmokeHost(hostname) {
    const host = stripHostBrackets(hostname);
    if (host === "localhost" || host.endsWith(".localhost")) return true;
    const family = isIP(host);
    if (family === 4) return RESERVED_IPV4.check(host, "ipv4");
    if (family === 6) return RESERVED_IPV6.check(host, "ipv6");
    return false;
}

async function assertSafeResolvedHost(hostname, lookup = dns.lookup) {
    const host = stripHostBrackets(hostname);
    if (isBlockedSmokeHost(host)) throw new Error("smoke hostname resolves to a reserved address");
    if (isIP(host)) return [{ address: host, family: isIP(host) }];
    let records;
    try {
        records = await lookup(host, { all: true, verbatim: true });
    } catch {
        throw new Error("smoke hostname DNS resolution failed");
    }
    if (!Array.isArray(records) || records.length === 0) {
        throw new Error("smoke hostname DNS resolution returned no addresses");
    }
    if (records.some(record => !isIP(String(record?.address || "")) || isBlockedSmokeHost(record.address))) {
        throw new Error("smoke hostname resolves to a reserved address");
    }
    return records;
}

function normalizeBaseUrl(input) {
    const raw = String(input || process.env.SMOKE_BASE_URL || "").trim();
    if (!raw) {
        throw new Error("missing base URL\n" + usage());
    }
    const url = new URL(raw);
    if (url.protocol !== "https:") {
        throw new Error("base URL must start with https://");
    }
    if (isBlockedSmokeHost(url.hostname)) {
        throw new Error("base URL hostname is not allowed for remote smoke checks");
    }
    const hostname = url.hostname.toLowerCase();
    if (!allowedSmokeHosts().has(hostname)) {
        throw new Error("smoke hostname is not allowlisted in SMOKE_ALLOWED_HOSTS");
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
        const target = new URL(path, `${baseUrl}/`);
        await assertSafeResolvedHost(target.hostname);
        // nosemgrep -- HTTPS and the exact host allowlist are validated by normalizeBaseUrl.
        const response = await fetch(target, {
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
    await assertSafeResolvedHost(new URL(baseUrl).hostname);
    const results = [];

    const ping = await request(baseUrl, "/ping");
    results.push(ping);
    assert(ping.status === 200 && /^OK\b/.test(ping.text), "/ping did not return 200 OK", ping);

    const health = await request(baseUrl, "/health");
    results.push(health);
    assert([200, 503].includes(health.status), "/health should return ready 200 or degraded 503", health);
    assert(/json/i.test(health.contentType) || /^\s*\{/.test(health.text), "/health did not look like JSON", health);

    const ready = await request(baseUrl, "/ready");
    results.push(ready);
    assert([200, 503].includes(ready.status), "/ready alias should return ready 200 or degraded 503", ready);
    assert(/json/i.test(ready.contentType) || /^\s*\{/.test(ready.text), "/ready did not look like JSON", ready);

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
    allowedSmokeHosts,
    normalizeBaseUrl,
    assertSafeResolvedHost,
    trimTrailingSlashes,
    isBlockedSmokeHost,
    isOwnerReachable,
    looksLikeHtml
};
