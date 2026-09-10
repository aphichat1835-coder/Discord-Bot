const crypto = require("node:crypto");

const DEFAULT_CALLBACK_STATE_MAX_AGE_MS = 10 * 60 * 1000;

function getStateSecret() {
    return String(process.env.VERIFY_STATE_SECRET || "").trim();
}

function requireStateSecret() {
    const secret = getStateSecret();

    if (!secret) {
        throw new Error("Missing VERIFY_STATE_SECRET");
    }

    return secret;
}

function safeEqual(a, b) {
    const aa = Buffer.from(String(a || ""), "utf8");
    const bb = Buffer.from(String(b || ""), "utf8");

    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function signEncodedPayload(encodedPayload) {
    return crypto
        .createHmac("sha256", requireStateSecret())
        .update(encodedPayload)
        .digest("base64url");
}

function signCompactStateData(data) {
    return crypto
        .createHmac("sha256", requireStateSecret())
        .update(data)
        .digest("base64url")
        .slice(0, 22);
}

function encodeSignedState(payload) {
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const sig = signEncodedPayload(encoded);

    return `${encoded}.${sig}`;
}

function decodeSignedState(token) {
    try {
        const [encoded, sig] = String(token || "").split(".");

        if (!encoded || !sig) return null;

        const expected = signEncodedPayload(encoded);

        if (!safeEqual(sig, expected)) return null;

        return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    } catch {
        return null;
    }
}

function normalizePanelRevision(panelRevision) {
    return String(panelRevision || "legacy")
        .replace(/[^a-zA-Z0-9_-]/g, "_")
        .slice(0, 80) || "legacy";
}

function createCompactCallbackState({
    guildId,
    roleId,
    expectedUserId = null,
    panelRevision = null,
    expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10
}) {
    const user = expectedUserId || "0";
    const revision = normalizePanelRevision(panelRevision);
    const ts = Number(expiresAt || Date.now()).toString(36);
    const nonce = crypto.randomBytes(6).toString("base64url");

    const data = `4|${guildId}|${roleId}|${user}|${revision}|${ts}|${nonce}`;
    const sig = signCompactStateData(data);

    return `4.${guildId}.${roleId}.${user}.${revision}.${ts}.${nonce}.${sig}`;
}

function decodeCompactCallbackStateV4(parts) {
    if (parts.length !== 8) return null;

    const [version, guildId, roleId, user, panelRevision, ts36, nonce, sig] = parts;

    if (
        version !== "4" ||
        !guildId ||
        !roleId ||
        !user ||
        !panelRevision ||
        !ts36 ||
        !nonce ||
        !sig
    ) {
        return null;
    }

    const data = `${version}|${guildId}|${roleId}|${user}|${panelRevision}|${ts36}|${nonce}`;
    const expected = signCompactStateData(data);

    if (!safeEqual(sig, expected)) return null;

    const ts = Number.parseInt(ts36, 36);

    if (!Number.isFinite(ts)) return null;

    return {
        v: 4,
        type: "verify-callback",
        guildId,
        roleId,
        expectedUserId: user === "0" ? null : user,
        panelRevision,
        ts,
        nonce,
        mode: "compact-direct-oauth-panel-revision"
    };
}

function decodeCompactCallbackStateV3(parts) {
    if (parts.length !== 7) return null;

    const [version, guildId, roleId, user, ts36, nonce, sig] = parts;

    if (version !== "3" || !guildId || !roleId || !user || !ts36 || !nonce || !sig) {
        return null;
    }

    const data = `${version}|${guildId}|${roleId}|${user}|${ts36}|${nonce}`;
    const expected = signCompactStateData(data);

    if (!safeEqual(sig, expected)) return null;

    const ts = Number.parseInt(ts36, 36);

    if (!Number.isFinite(ts)) return null;

    return {
        v: 3,
        type: "verify-callback",
        guildId,
        roleId,
        expectedUserId: user === "0" ? null : user,
        panelRevision: null,
        ts,
        nonce,
        mode: "compact-direct-oauth-long-lived"
    };
}

function decodeCompactCallbackState(token) {
    try {
        const parts = String(token || "").split(".");

        if (parts[0] === "4") return decodeCompactCallbackStateV4(parts);
        if (parts[0] === "3") return decodeCompactCallbackStateV3(parts);

        return null;
    } catch {
        return null;
    }
}

function isCompactCallbackStateExpired(compact) {
    const expiresAt = Number(compact?.ts);

    if (!Number.isFinite(expiresAt)) return true;

    return Date.now() > expiresAt;
}

function decodeCallbackState(state, options = {}) {
    const compact = decodeCompactCallbackState(state);

    if (compact) {
        if ((compact.v === 4 || compact.v === 3) && isCompactCallbackStateExpired(compact)) {
            return null;
        }

        return compact;
    }

    const parsed = decodeSignedState(state);

    if (!parsed || parsed.type !== "verify-callback") return null;
    if (!parsed.guildId || !parsed.roleId || !parsed.ts) return null;

    const maxAgeMs = Number(options.maxAgeMs || DEFAULT_CALLBACK_STATE_MAX_AGE_MS);
    if (Date.now() - Number(parsed.ts) > maxAgeMs) return null;

    return {
        ...parsed,
        expectedUserId: parsed.expectedUserId || parsed.userId || null,
        panelRevision: parsed.panelRevision || null,
        mode: "legacy-json-oauth"
    };
}

module.exports = {
    DEFAULT_CALLBACK_STATE_MAX_AGE_MS,
    getStateSecret,
    requireStateSecret,
    safeEqual,
    signCompactStateData,
    encodeSignedState,
    decodeSignedState,
    createCompactCallbackState,
    decodeCompactCallbackState,
    isCompactCallbackStateExpired,
    decodeCallbackState
};
