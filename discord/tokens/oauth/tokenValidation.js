"use strict";

const { decryptToken } = require("../../verification/utils/crypto");
const { TOKEN_FIELDS, REQUIRED_USER_SCOPES, resolveFailMax } = require("./config");

function assertValidTokenField(tokenField) {
    if (!tokenField || typeof tokenField !== "string" || !TOKEN_FIELDS.includes(tokenField)) {
        const error = new Error(`Invalid tokenField "${tokenField}". Allowed values: ${TOKEN_FIELDS.join(", ")}`);
        error.code = "oauth_invalid_token_field";
        throw error;
    }
    return tokenField;
}

function validateTokenData(tokenData) {
    if (!tokenData || typeof tokenData !== "object") {
        const error = new Error("Invalid token payload: expected an object");
        error.code = "oauth_token_invalid_payload";
        throw error;
    }
    const accessToken = String(tokenData.access_token || "").trim();
    if (!accessToken || typeof tokenData.access_token !== "string") {
        const error = new Error("Invalid token payload: missing or invalid access_token");
        error.code = "oauth_token_missing_access_token";
        throw error;
    }
    const refreshToken = String(tokenData.refresh_token || "").trim();
    if (!refreshToken || typeof tokenData.refresh_token !== "string") {
        const error = new Error("Invalid token payload: missing or invalid refresh_token");
        error.code = "oauth_token_missing_refresh_token";
        throw error;
    }
    const expiresIn = Number(tokenData.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
        const error = new Error("Invalid token payload: expires_in must be a positive number");
        error.code = "oauth_token_invalid_expires_in";
        throw error;
    }
    if (tokenData.scope !== undefined && typeof tokenData.scope !== "string") {
        const error = new Error("Invalid token payload: scope must be a string");
        error.code = "oauth_token_invalid_scope";
        throw error;
    }
    if (tokenData.token_type !== undefined && tokenData.token_type !== null && typeof tokenData.token_type !== "string") {
        const error = new Error("Invalid token payload: token_type must be a string");
        error.code = "oauth_token_invalid_token_type";
        throw error;
    }
    return true;
}

function hasAllRequiredScopes(tokenScope, normalizedRequired) {
    const scopes = new Set(String(tokenScope || "").split(/\s+/).filter(Boolean));
    for (const req of normalizedRequired) {
        if (!scopes.has(req)) return false;
    }
    return true;
}

function checkTokenCryptoReasons(token, now, failMax = null, env = process.env) {
    const effectiveFailMax = resolveFailMax(failMax, env);
    const reasons = [];

    let accessToken = null;
    if (token.encryptedAccessToken) {
        try {
            accessToken = decryptToken(token.encryptedAccessToken);
        } catch {
            accessToken = null;
        }
    }

    let refreshToken = null;
    if (token.encryptedRefreshToken) {
        try {
            refreshToken = decryptToken(token.encryptedRefreshToken);
        } catch {
            refreshToken = null;
        }
    }

    if (!token.encryptedAccessToken) reasons.push("missing_access_token");
    else if (!accessToken) reasons.push("access_token_decrypt_failed");

    if (!token.encryptedRefreshToken) reasons.push("missing_refresh_token");
    else if (!refreshToken) reasons.push("refresh_token_decrypt_failed");

    if (token.revokedAt) reasons.push("token_revoked");

    if (Number(token.refreshFailCount || 0) >= effectiveFailMax) {
        reasons.push("refresh_exhausted");
    }

    const isExpired = Number(token.expiresAt || 0) > 0 && Number(token.expiresAt) <= now;
    if (isExpired && !refreshToken) {
        reasons.push("access_token_expired_without_refresh");
    }
    return reasons;
}

function collectMissingScopeReasons(tokenScope, requiredScopes = REQUIRED_USER_SCOPES) {
    const scopes = new Set(String(tokenScope || "").split(/\s+/).filter(Boolean));
    const missing = [];
    for (const scope of requiredScopes) {
        if (!scopes.has(scope)) missing.push(`missing_scope:${scope}`);
    }
    return missing;
}

function recoveryReasonLabel(reason) {
    const labels = {
        missing_access_token: "ไม่มี Access Token",
        access_token_decrypt_failed: "ถอดรหัส Access Token ไม่สำเร็จ",
        missing_refresh_token: "ไม่มี Refresh Token",
        refresh_token_decrypt_failed: "ถอดรหัส Refresh Token ไม่สำเร็จ",
        token_revoked: "Token ถูกยกเลิก",
        refresh_exhausted: "Refresh ล้มเหลวถึงจำนวนสูงสุด",
        record_missing: "ไม่พบข้อมูลผู้ใช้ในระบบ",
        user_deleted: "ข้อมูลผู้ใช้ถูกลบ",
        access_token_expired_without_refresh: "Access Token หมดอายุและต่ออายุไม่ได้"
    };
    if (String(reason).startsWith("missing_scope:")) return `ขาด Scope ${String(reason).slice(14)}`;
    return labels[reason] || String(reason);
}

function tokenRecoveryReasons(token = {}, now = Date.now(), requiredScopes = REQUIRED_USER_SCOPES, failMax = null, env = process.env) {
    let resolvedNow = now;
    let resolvedScopes = requiredScopes;
    let resolvedFailMax = failMax;
    let resolvedEnv = env;

    if (now && typeof now === "object" && !(now instanceof Date)) {
        resolvedNow = now.now !== undefined ? now.now : Date.now();
        resolvedScopes = now.requiredScopes !== undefined ? now.requiredScopes : REQUIRED_USER_SCOPES;
        resolvedFailMax = now.failMax !== undefined ? now.failMax : null;
        resolvedEnv = now.env !== undefined ? now.env : process.env;
    }

    const effectiveFailMax = resolveFailMax(resolvedFailMax, resolvedEnv);
    const reasons = [
        ...checkTokenCryptoReasons(token, resolvedNow, effectiveFailMax, resolvedEnv),
        ...collectMissingScopeReasons(token?.scope, resolvedScopes)
    ];
    return [...new Set(reasons)];
}

module.exports = {
    assertValidTokenField,
    validateTokenData,
    hasAllRequiredScopes,
    checkTokenCryptoReasons,
    collectMissingScopeReasons,
    recoveryReasonLabel,
    tokenRecoveryReasons
};
