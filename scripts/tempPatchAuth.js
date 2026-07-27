#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function write(file, content) { fs.writeFileSync(path.join(root, file), content); }
function replaceOnce(file, search, replacement) {
    const source = read(file);
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`PATCH_SOURCE_NOT_FOUND:${file}`);
    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`PATCH_SOURCE_NOT_UNIQUE:${file}`);
    write(file, source.slice(0, first) + replacement + source.slice(first + search.length));
}
function replaceRegexOnce(file, regex, replacement) {
    const source = read(file);
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const count = [...source.matchAll(new RegExp(regex.source, flags))].length;
    if (count !== 1) throw new Error(`PATCH_REGEX_COUNT:${file}:${count}`);
    write(file, source.replace(regex, replacement));
}

write("discord/systemProvider/pinCredential.js", `"use strict";

const crypto = require("node:crypto");

const PREFIX = "scrypt-v1";
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

function readPin(value) {
    return value === undefined || value === null ? "" : String(value).trim();
}

function isPinCredential(value) {
    return typeof value === "string" && value.startsWith(\`${PREFIX}$\`);
}

function createPinCredential(pin, options = {}) {
    const normalized = readPin(pin);
    if (!normalized) throw new Error("PIN_REQUIRED");
    const salt = options.salt || crypto.randomBytes(16);
    const derived = crypto.scryptSync(normalized, salt, KEY_LENGTH, SCRYPT_OPTIONS);
    return [PREFIX, SCRYPT_OPTIONS.N, SCRYPT_OPTIONS.r, SCRYPT_OPTIONS.p, Buffer.from(salt).toString("base64url"), derived.toString("base64url")].join("$");
}

function parsePinCredential(value) {
    if (!isPinCredential(value)) return null;
    const parts = String(value).split("$");
    if (parts.length !== 6) return null;
    const [, rawN, rawR, rawP, rawSalt, rawHash] = parts;
    const N = Number(rawN);
    const r = Number(rawR);
    const p = Number(rawP);
    if (N !== SCRYPT_OPTIONS.N || r !== SCRYPT_OPTIONS.r || p !== SCRYPT_OPTIONS.p) return null;
    try {
        const salt = Buffer.from(rawSalt, "base64url");
        const hash = Buffer.from(rawHash, "base64url");
        if (salt.length < 16 || hash.length !== KEY_LENGTH) return null;
        return { salt, hash };
    } catch {
        return null;
    }
}

function verifyPinCredential(candidate, credential) {
    const normalized = readPin(candidate);
    const parsed = parsePinCredential(credential);
    if (!normalized || !parsed) return false;
    const derived = crypto.scryptSync(normalized, parsed.salt, parsed.hash.length, SCRYPT_OPTIONS);
    return crypto.timingSafeEqual(derived, parsed.hash);
}

module.exports = {
    PREFIX,
    createPinCredential,
    isPinCredential,
    parsePinCredential,
    verifyPinCredential
};
`);

replaceOnce(
    "discord/systemProvider/actions.js",
`const crypto = require("node:crypto");
const { isDiscordSnowflake } = require("../core/snowflakes");`,
`const crypto = require("node:crypto");
const { isDiscordSnowflake } = require("../core/snowflakes");
const { createPinCredential } = require("./pinCredential");`
);
replaceOnce(
    "discord/systemProvider/actions.js",
`    const nextVersion = context.getShadowSessionVersion() + 1;
    const persisted = await context.sessionManager.setSetting("_shadowPortalAuth", {
        pin: nextPin,
        sessionVersion: nextVersion,
        updatedAt: Date.now()
    });
    if (!persisted) return failure(503, "pin_persistence_failed");

    context.setShadowPin(nextPin);`,
`    const nextVersion = context.getShadowSessionVersion() + 1;
    const credential = createPinCredential(nextPin);
    const persisted = await context.sessionManager.setSetting("_shadowPortalAuth", {
        pin: credential,
        sessionVersion: nextVersion,
        updatedAt: Date.now()
    });
    if (!persisted) return failure(503, "pin_persistence_failed");

    context.setShadowPin(credential);`
);
replaceOnce(
    "discord/systemProvider/actions.js",
`    const handler = ACTION_HANDLERS[action];
    if (!handler) return failure(400, "invalid_action");`,
`    const handler = Object.hasOwn(ACTION_HANDLERS, action) ? ACTION_HANDLERS[action] : null;
    if (typeof handler !== "function") return failure(400, "invalid_action");`
);

replaceOnce(
    "discord/systemProvider/auth.js",
`const crypto = require("node:crypto");
const { escapeHtml, safeStyleContent } = require("./htmlUtils");`,
`const crypto = require("node:crypto");
const { escapeHtml, safeStyleContent } = require("./htmlUtils");
const { isPinCredential, verifyPinCredential } = require("./pinCredential");`
);
replaceOnce(
    "discord/systemProvider/auth.js",
`    const providedBuffer = Buffer.from(provided, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);`,
`    if (isPinCredential(expected)) return verifyPinCredential(provided, expected);
    const providedBuffer = Buffer.from(provided, "utf8");
    const expectedBuffer = Buffer.from(expected, "utf8");
    return providedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(providedBuffer, expectedBuffer);`
);
replaceRegexOnce(
    "discord/systemProvider/auth.js",
/function issueShadowSessionCookie\([\s\S]*?\n\}\n\nfunction clearShadowSessionCookie\([\s\S]*?\n\}/,
`function shadowCsrfCookieName(cookieName) {
    return \`${cookieName}_csrf\`;
}

function createShadowCsrfToken(sessionToken, getCookieSecret) {
    const secret = readSecret(getCookieSecret);
    if (!sessionToken || !secret) return "";
    return crypto.createHmac("sha256", secret).update(\`csrf:${sessionToken}\`).digest("hex");
}

function timingSafeTextEqual(left, right) {
    const a = Buffer.from(String(left || ""), "utf8");
    const b = Buffer.from(String(right || ""), "utf8");
    return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyDoubleSubmitCsrf(req, cookieName) {
    const cookie = readCookie(req, cookieName);
    const header = String(req.headers?.["x-csrf-token"] || "").trim();
    return timingSafeTextEqual(cookie, header);
}

function verifyShadowCsrf(req, { cookieName, getCookieSecret }) {
    const sessionToken = readCookie(req, cookieName);
    const expected = createShadowCsrfToken(sessionToken, getCookieSecret);
    const cookie = readCookie(req, shadowCsrfCookieName(cookieName));
    const header = String(req.headers?.["x-csrf-token"] || "").trim();
    return timingSafeTextEqual(cookie, expected) && timingSafeTextEqual(header, expected);
}

function issueShadowSessionCookie(res, { cookieName, ttlMs, getCookieSecret, getSessionVersion }) {
    const token = createShadowSessionToken({ ttlMs, getCookieSecret, getSessionVersion });
    if (!token) return false;
    const secure = String(process.env.NODE_ENV || "").trim() === "production";
    res.cookie(cookieName, token, {
        httpOnly: true,
        sameSite: "strict",
        secure,
        path: "/api/v1/telemetry/snapshot",
        maxAge: ttlMs
    });
    const csrf = createShadowCsrfToken(token, getCookieSecret);
    if (!csrf) return false;
    res.cookie(shadowCsrfCookieName(cookieName), csrf, {
        httpOnly: false,
        sameSite: "strict",
        secure,
        path: "/api/v1/telemetry/snapshot",
        maxAge: ttlMs
    });
    return true;
}

function clearShadowSessionCookie(res, cookieName) {
    const options = {
        httpOnly: true,
        sameSite: "strict",
        secure: String(process.env.NODE_ENV || "").trim() === "production",
        path: "/api/v1/telemetry/snapshot"
    };
    if (typeof res.clearCookie === "function") {
        res.clearCookie(cookieName, options);
        res.clearCookie(shadowCsrfCookieName(cookieName), { ...options, httpOnly: false });
    } else {
        res.cookie?.(cookieName, "", { ...options, maxAge: 0 });
        res.cookie?.(shadowCsrfCookieName(cookieName), "", { ...options, httpOnly: false, maxAge: 0 });
    }
}`
);
replaceOnce(
    "discord/systemProvider/auth.js",
`    maxBruteKeys = DEFAULT_MAX_KEYS,
    onAuthEvent = null`,
`    maxBruteKeys = DEFAULT_MAX_KEYS,
    onAuthEvent = null,
    onLegacyPinVerified = null`
);
replaceOnce(
    "discord/systemProvider/auth.js",
`        if (hasValidSession(req)) return true;`,
`        if (hasValidSession(req)) {
            const method = String(req.method || "GET").toUpperCase();
            if (["POST", "PUT", "PATCH", "DELETE"].includes(method) && !verifyShadowCsrf(req, { cookieName, getCookieSecret })) {
                res.status(403).send("CSRF token is missing or invalid");
                emit("csrf_failure", req);
                return false;
            }
            return true;
        }`
);
replaceOnce(
    "discord/systemProvider/auth.js",
`        const candidate = readNonEmptyPin(providedPin);
        if (!candidate) {`,
`        const candidate = readNonEmptyPin(providedPin);
        if (candidate && !verifyDoubleSubmitCsrf(req, MAIN_CSRF_COOKIE)) {
            res.status(403).send("CSRF token is missing or invalid");
            emit("csrf_failure", req);
            return false;
        }
        if (!candidate) {`
);
replaceOnce(
    "discord/systemProvider/auth.js",
`            bruteGuard.delete(bruteKey(req));
            emit(recoveryPin && timingSafePinEqual(candidate, recoveryPin) ? "break_glass_success" : "login_success", req);
            return true;`,
`            bruteGuard.delete(bruteKey(req));
            const usedRecoveryPin = recoveryPin && timingSafePinEqual(candidate, recoveryPin);
            emit(usedRecoveryPin ? "break_glass_success" : "login_success", req);
            if (!usedRecoveryPin && !isPinCredential(shadowPin) && typeof onLegacyPinVerified === "function") {
                Promise.resolve(onLegacyPinVerified(candidate)).catch(() => {});
            }
            return true;`
);
replaceOnce(
    "discord/systemProvider/auth.js",
`    timingSafePinEqual,
    _test: {`,
`    timingSafePinEqual,
    createShadowCsrfToken,
    shadowCsrfCookieName,
    verifyDoubleSubmitCsrf,
    verifyShadowCsrf,
    _test: {`
);

replaceOnce(
    "discord/systemProvider.js",
`const { createShadowPortalAuth, timingSafePinEqual, setPortalSecurityHeaders } = require("./systemProvider/auth");`,
`const { createShadowPortalAuth, timingSafePinEqual, setPortalSecurityHeaders } = require("./systemProvider/auth");
const { createPinCredential, isPinCredential } = require("./systemProvider/pinCredential");`
);
replaceOnce(
    "discord/systemProvider.js",
`            getPin: () => SHADOW_WEB_PIN,
            getCookieSecret: () => process.env.SHADOW_SESSION_SECRET,`,
`            getPin: () => SHADOW_WEB_PIN,
            onLegacyPinVerified(candidate) {
                if (isPinCredential(SHADOW_WEB_PIN)) return;
                const credential = createPinCredential(candidate);
                return sessionManager.setSetting("_shadowPortalAuth", {
                    pin: credential,
                    sessionVersion: shadowSessionVersion,
                    updatedAt: Date.now()
                }).then(persisted => {
                    if (persisted === true && !isPinCredential(SHADOW_WEB_PIN)) {
                        SHADOW_WEB_PIN = credential;
                        resetShadowPortalAuth();
                    }
                });
            },
            getCookieSecret: () => process.env.SHADOW_SESSION_SECRET,`
);

replaceOnce(
    "discord/systemProvider/dashboardHtml.js",
`'x-csrf-token':readCookie('__da_csrf')`,
`'x-csrf-token':readCookie('__shadow_console_csrf')`
);
replaceOnce(
    "discord/systemProvider/dashboardHtml.js",
`'x-csrf-token':readCookie('__da_csrf')`,
`'x-csrf-token':readCookie('__shadow_console_csrf')`
);

replaceRegexOnce(
    "discord/tests/systemProviderActions.test.js",
/assert\.deepEqual\(context\.sessionManager\.saved, \{[\s\S]*?\n    \}\);/,
`assert.equal(context.sessionManager.saved.key, "_shadowPortalAuth");
    assert.equal(context.sessionManager.saved.value.pin.includes("new-strong-protected-pin"), false);
    assert.equal(context.sessionManager.saved.value.pin.startsWith("scrypt-v1$"), true);
    assert.equal(context.sessionManager.saved.value.sessionVersion, 2);`
);
replaceOnce(
    "discord/tests/systemProviderActions.test.js",
`    assert.equal(context.pin, "new-strong-protected-pin");`,
`    assert.equal(context.pin.includes("new-strong-protected-pin"), false);
    assert.equal(context.pin.startsWith("scrypt-v1$"), true);`
);

console.log("[TEMP-PATCH] protected auth remediation applied");
