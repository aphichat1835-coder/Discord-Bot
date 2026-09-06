"use strict";

const GuildConfig = require("../models/GuildConfig");
const { resolvePublicBaseUrl } = require("../../core/publicUrl");
const { normalizeDiscordSnowflake } = require("../../core/snowflakes");
const { normalizeVerificationConfig } = require("../utils/verifyMode");
const { createCompactCallbackState, decodeCallbackState } = require("../utils/state");
const { isDuplicateNonceError, registerVerificationState } = require("../services/verificationStateNonce");

const VERIFY_SCOPE = "identify email connections guilds guilds.members.read guilds.join";
const EXECUTION_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_REGISTRATION_ATTEMPTS = 2;

function authorizeUrl({ clientId, redirectUri, state, scope = VERIFY_SCOPE }) {
    const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope,
        state,
        prompt: "consent"
    });
    return `https://discord.com/oauth2/authorize?${params.toString()}`;
}


async function createRegisteredExecutionState(payload, options = {}) {
    const createState = options.createState;
    const decodeState = options.decodeState;
    const registerState = options.registerState;
    const duplicateError = options.isDuplicateStateError || isDuplicateNonceError;
    const attempts = Math.max(1, Math.min(3, Number(options.attempts) || STATE_REGISTRATION_ATTEMPTS));
    let lastDuplicate = null;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        const state = createState(payload);
        const stateObj = decodeState(state);
        if (!stateObj) return null;
        try {
            if (await registerState(stateObj)) return { state, stateObj, attempt };
            return null;
        } catch (error) {
            if (!duplicateError(error)) throw error;
            lastDuplicate = error;
        }
    }
    throw lastDuplicate || Object.assign(new Error("Verification state registration failed"), {
        code: "VERIFICATION_STATE_REGISTRATION_FAILED"
    });
}

function createOAuthStartHandler(options = {}) {
    const {
        GuildConfigModel = GuildConfig,
        decodeState = decodeCallbackState,
        createState = createCompactCallbackState,
        registerState = registerVerificationState,
        isDuplicateStateError = isDuplicateNonceError,
        stateRegistrationAttempts = STATE_REGISTRATION_ATTEMPTS,
        normalizeConfig = normalizeVerificationConfig,
        now = Date.now,
        env = process.env,
        logger = console
    } = options;

    return async function oauthStartHandler(req, res) {
        res.set("Cache-Control", "no-store");
        try {
            const panelState = decodeState(req.query?.state);
            const guildId = normalizeDiscordSnowflake(panelState?.guildId);
            const roleId = normalizeDiscordSnowflake(panelState?.roleId);
            if (!guildId || !roleId) {
                return res.status(400).send("ลิงก์ยืนยันไม่ถูกต้อง");
            }

            const guildConfig = await GuildConfigModel.findOne()
                .where("guildId").equals(guildId)
                .lean();
            const verification = normalizeConfig(guildConfig?.verification || {});
            if (!verification.enabled || String(verification.roleId || "") !== roleId) {
                return res.status(409).send("แผงยืนยันนี้ไม่พร้อมใช้งาน");
            }
            if (panelState.panelRevision && verification.panelRevision &&
                String(panelState.panelRevision) !== String(verification.panelRevision)) {
                return res.status(409).send("แผงยืนยันนี้ถูกแทนที่แล้ว กรุณาใช้แผงล่าสุด");
            }

            const registered = await createRegisteredExecutionState({
                guildId,
                roleId,
                expectedUserId: normalizeDiscordSnowflake(panelState.expectedUserId) || null,
                panelRevision: verification.panelRevision || panelState.panelRevision || null,
                expiresAt: now() + EXECUTION_STATE_TTL_MS
            }, {
                createState,
                decodeState,
                registerState,
                isDuplicateStateError,
                attempts: stateRegistrationAttempts
            });
            if (!registered) {
                return res.status(503).send("ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่");
            }
            const executionState = registered.state;

            const clientId = normalizeDiscordSnowflake(env.DISCORD_CLIENT_ID);
            if (!clientId) throw Object.assign(new Error("Discord client ID is unavailable"), {
                code: "DISCORD_CLIENT_ID_UNAVAILABLE"
            });
            const baseUrl = resolvePublicBaseUrl(env, "http://localhost:3000");
            const redirectUri = `${baseUrl}/auth/callback`;
            return res.redirect(302, authorizeUrl({
                clientId,
                redirectUri,
                state: executionState
            }));
        } catch (error) {
            logger.error("[VERIFY] OAuth start failed:", {
                code: String(error?.code || error?.name || "oauth_start_failed").slice(0, 80)
            });
            return res.status(503).send("ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่อีกครั้ง");
        }
    };
}

module.exports = {
    EXECUTION_STATE_TTL_MS,
    STATE_REGISTRATION_ATTEMPTS,
    VERIFY_SCOPE,
    authorizeUrl,
    createOAuthStartHandler,
    createRegisteredExecutionState
};
