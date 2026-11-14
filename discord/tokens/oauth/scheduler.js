"use strict";

const OAuthUser = require("../../verification/models/OAuthUser");
const { safeError } = require("../../core/safeLogger");
const { getOAuthRefreshConfig, DEFAULT_REFRESH_INTERVAL_MS } = require("./config");
const state = require("./state");
const { refreshDueTokens } = require("./refreshService");

async function runScheduledSweep() {
    if (state.refreshInFlight) return;
    const model = state.backgroundOptions.OAuthUserModel || OAuthUser;
    if (model?.db && typeof model.db.readyState === "number" && model.db.readyState !== 1 && !state.backgroundOptions.forceSweep) {
        return;
    }
    state.refreshInFlight = true;
    try {
        state.inFlightRefreshPromise = refreshDueTokens(state.backgroundOptions);
        await state.inFlightRefreshPromise;
    } catch (err) {
        state.diagnosticStats.lastError = safeError(err);
        console.error("[OAUTH_MANAGER] background sweep error:", safeError(err));
        state.dispatchOAuthAlert({
            code: "oauth.background_sweep_error",
            severity: "CRITICAL",
            state: "OPEN",
            title: "OAUTH BACKGROUND SWEEP FAILED",
            description: "ตรวจพบข้อผิดพลาดร้ายแรงระหว่างการรัน Background Sweep สำหรับต่ออายุ OAuth Token อัตโนมัติ",
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "Error Code", value: err?.code || "SWEEP_FAILED" },
                { name: "สาเหตุ", value: safeError(err) || "Unknown sweep error" },
                { name: "ผลกระทบ", value: "การต่ออายุโทเคนเบื้องหลังอาจหยุดชะงัก โทเคนที่ใกล้หมดอายุอาจไม่ได้รับการรีเฟรชทันเวลา" },
                { name: "สิ่งที่ควรทำ", value: "ตรวจสอบการเชื่อมต่อฐานข้อมูล MongoDB หรือตรวจสอบ Error Log ในเซิร์ฟเวอร์" }
            ],
            dedupeKey: "oauth-sweep-error",
            dedupeMs: 15 * 60 * 1000
        });
    } finally {
        state.refreshInFlight = false;
        state.inFlightRefreshPromise = null;
    }
}

async function start(options = {}) {
    if (state.startPromise) return state.startPromise;
    if (state.isStarted) return state.getDiagnostics();

    state.backgroundOptions = { ...options };
    const env = options.env || process.env;
    const config = getOAuthRefreshConfig(env);
    state.backgroundIntervalMs = options.intervalMs || config.intervalMs || DEFAULT_REFRESH_INTERVAL_MS;

    state.startPromise = (async () => {
        state.isStarted = true;
        state.diagnosticStats.startedAt = Date.now();
        state.diagnosticStats.stoppedAt = null;

        try {
            await runScheduledSweep();
        } catch (err) {
            state.diagnosticStats.lastError = safeError(err);
        }

        if (!state.isStarted) {
            return state.getDiagnostics();
        }

        if (!state.backgroundTimer) {
            state.backgroundTimer = setInterval(() => {
                runScheduledSweep().catch(err => {
                    state.diagnosticStats.lastError = safeError(err);
                });
            }, state.backgroundIntervalMs);
            if (typeof state.backgroundTimer.unref === "function") state.backgroundTimer.unref();
        }

        return state.getDiagnostics();
    })();

    return state.startPromise;
}

async function stop() {
    state.isStarted = false;
    state.startPromise = null;
    if (state.backgroundTimer) {
        clearInterval(state.backgroundTimer);
        state.backgroundTimer = null;
    }
    if (state.inFlightRefreshPromise) {
        try {
            await state.inFlightRefreshPromise;
        } catch {}
    }
    state.diagnosticStats.stoppedAt = Date.now();
    return state.getDiagnostics();
}

module.exports = {
    runScheduledSweep,
    start,
    stop,
    getDiagnostics: state.getDiagnostics
};
