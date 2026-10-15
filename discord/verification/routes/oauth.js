"use strict";

const router = require("express").Router();
const path = require("node:path");
const crypto = require("node:crypto");

const discord = require("../utils/discordAPI");
const { decodeCallbackState } = require("../utils/state");
const { normalizeVerificationConfig, normalizeSecurityRules } = require("../utils/verifyMode");
const { resolvePublicBaseUrl } = require("../../core/publicUrl");
const { consumeVerificationState } = require("../services/verificationStateNonce");
const verificationOrchestrator = require("../services/verificationOrchestrator");

const BASE_URL = resolvePublicBaseUrl(process.env, "http://localhost:3000");
const REDIRECT_URI = `${BASE_URL}/auth/callback`;

function makeRequestId(prefix = "req") {
    return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}

function jsonFail(res, userMessage, debugCode, httpStatus = 200, requestId = null) {
    return res.status(httpStatus).json({
        success: false,
        userMessage,
        message: userMessage,
        code: debugCode,
        requestId
    });
}

function sanitizeSideEffectError(err) {
    if (!err) return null;
    return {
        message: String(err?.message || err),
        name: err?.name,
        code: err?.code,
        status: err?.status || err?.statusCode
    };
}

async function validateCallbackStateNonce(body, res, requestId) {
    const { code, state } = body || {};

    if (!code) {
        return {
            ok: false,
            response: jsonFail(
                res,
                "ยกเลิกการยืนยันตัวตน หรือไม่พบรหัส OAuth",
                "missing_oauth_code",
                200,
                requestId
            )
        };
    }

    const stateObj = decodeCallbackState(state);
    if (!stateObj) {
        return {
            ok: false,
            response: jsonFail(
                res,
                "ลิงก์ยืนยันไม่ถูกต้อง กรุณากดปุ่มใหม่อีกครั้ง",
                "invalid_callback_state",
                200,
                requestId
            )
        };
    }

    if (stateObj?.nonce) {
        const consumed = await consumeVerificationState(stateObj);
        if (!consumed) {
            return {
                ok: false,
                response: jsonFail(
                    res,
                    "คำขอยืนยันนี้หมดอายุหรือถูกใช้ไปแล้ว กรุณากดปุ่มใหม่",
                    "callback_state_replayed",
                    200,
                    requestId
                )
            };
        }
    }

    return { ok: true, code, stateObj };
}

function buildPolicySnapshot(v = {}) {
    const normalized = normalizeVerificationConfig(v || {});
    const securityRules = normalizeSecurityRules(normalized.securityRules || {});

    let minConnections = normalized.requireConnections ? 1 : 0;
    const parsedMin = Number(normalized.minConnections);
    if (Number.isFinite(parsedMin) && parsedMin > 0) {
        minConnections = parsedMin;
    }

    return {
        enabled: normalized.enabled !== false,
        blockVPN: normalized.blockVPN !== false,
        blockHosting: normalized.blockHosting === true,
        minAccountAgeDays: Number.isFinite(Number(normalized.minAccountAgeDays)) ? Number(normalized.minAccountAgeDays) : 0,
        requireEmail: Boolean(normalized.requireEmail),
        requireEmailVerified: Boolean(normalized.requireEmailVerified),
        requireConnections: Boolean(normalized.requireConnections),
        minConnections,
        securityRules
    };
}

function checkAccountEligibilityRequirements({
    accountAgeDays,
    policySnapshot,
    emailOk,
    connectionOk,
    connectionCount
}) {
    if (policySnapshot?.minAccountAgeDays && accountAgeDays < policySnapshot.minAccountAgeDays) {
        return {
            result: "blocked",
            reason: `new_account:${accountAgeDays}`,
            userError: `บัญชีของคุณยังใหม่อยู่ (เปิดมาแล้ว ${accountAgeDays} วัน เซิร์ฟเวอร์ต้องการอย่างน้อย ${policySnapshot.minAccountAgeDays} วัน)`
        };
    }

    if (!emailOk) {
        return {
            result: "blocked",
            reason: "email_requirement_failed",
            userError: "บัญชี Discord ของคุณต้องผูกอีเมลและยืนยันอีเมลก่อนเข้าสู่ระบบ"
        };
    }

    if (!connectionOk) {
        return {
            result: "blocked",
            reason: `connection_requirement_failed:${connectionCount}`,
            userError: `เซิร์ฟเวอร์นี้ต้องการให้บัญชี Discord ของคุณเชื่อมต่อกับบริการภายนอกอย่างน้อย ${policySnapshot?.minConnections || 1} บัญชีก่อนยืนยันตัวตน`
        };
    }

    return null;
}

function checkAccountEligibility({ profile, policySnapshot, connections }) {
    const createdAt = profile?.id ? Number((BigInt(profile.id) >> 22n) + 1420070400000n) : null;
    const accountAgeDays = createdAt ? Math.floor((Date.now() - createdAt) / (24 * 60 * 60 * 1000)) : 9999;

    const emailOk = (!policySnapshot?.requireEmail || profile?.email) &&
        (!policySnapshot?.requireEmailVerified || profile?.verified);

    const connectionCount = Array.isArray(connections) ? connections.length : 0;
    const requiredMinConnections = Number.isFinite(Number(policySnapshot?.minConnections))
        ? Math.floor(Number(policySnapshot.minConnections))
        : (policySnapshot?.requireConnections ? 1 : 0);
    const connectionOk = !policySnapshot?.requireConnections || (connectionCount >= requiredMinConnections);

    return checkAccountEligibilityRequirements({
        accountAgeDays,
        policySnapshot,
        emailOk,
        connectionOk,
        connectionCount
    });
}

router.get('/auth/callback', (req, res) => {
    res.sendFile(path.join(__dirname, "../views/callback.html"));
});

router.post('/auth/callback', async (req, res) => {
    const requestId = makeRequestId("verify");

    const validation = await validateCallbackStateNonce(req.body, res, requestId);
    if (!validation.ok) {
        return validation.response;
    }
    const { code, stateObj } = validation;

    try {
        const outcome = await verificationOrchestrator.executeVerification({
            req,
            code,
            stateObj,
            redirectUri: REDIRECT_URI
        });
        return res.status(outcome.statusCode || 200).json(outcome.body);
    } catch (err) {
        if (discord.isOAuthInvalidGrantError(err)) {
            console.warn(`[VERIFY] OAuth code expired or already used (${requestId})`);
            return jsonFail(
                res,
                "ลิงก์ยืนยันถูกใช้ไปแล้วหรือหมดอายุ กรุณากดปุ่มยืนยันใหม่ใน Discord",
                'oauth_code_expired_or_used',
                200,
                requestId
            );
        }

        console.error("[VERIFY] callback failed:", JSON.stringify(sanitizeSideEffectError(err)));

        return jsonFail(
            res,
            "เกิดข้อผิดพลาดระหว่างยืนยันตัวตน กรุณาลองใหม่อีกครั้ง",
            err?.message || "verify_callback_failed",
            200,
            requestId
        );
    }
});

module.exports = router;
module.exports._test = {
    REDIRECT_URI,
    makeRequestId,
    jsonFail,
    sanitizeSideEffectError,
    validateCallbackStateNonce,
    buildPolicySnapshot,
    checkAccountEligibilityRequirements,
    checkAccountEligibility
};
