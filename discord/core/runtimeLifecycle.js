"use strict";

async function runCleanupStep(name, action, state) {
    if (typeof action !== "function") return true;
    try {
        await action();
        state.completed.push(name);
        return true;
    } catch (error) {
        state.failures.push({ name, error });
        state.logger.warn(`[SHUTDOWN] ⚠️ ${name} failed: ${error?.message || error}`);
        return false;
    }
}

async function closeHttpServer(server, options = {}) {
    if (!server || typeof server.close !== "function") return;
    const setTimer = options.setTimer || setTimeout;
    const clearTimer = options.clearTimer || clearTimeout;
    const timeoutMs = Math.max(1, Number(options.timeoutMs) || 3000);

    await new Promise((resolve) => {
        let resolved = false;
        const done = () => {
            if (resolved) return;
            resolved = true;
            resolve();
        };
        const fallback = setTimer(done, timeoutMs);
        fallback?.unref?.();

        try {
            server.close(() => {
                clearTimer(fallback);
                done();
            });
        } catch (error) {
            clearTimer(fallback);
            throw error;
        }
    });
}

function normalizeExitCode(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 1;
    return Math.max(0, Math.trunc(parsed));
}

function createShutdownCoordinator(options = {}) {
    const {
        system = {},
        sessionManager = {},
        voiceWorker = {},
        client = null,
        memoryMonitor = null,
        verificationRuntime = null,
        dmService = null,
        runtimeCleanups = [],
        flushWebhookQueue = async () => true,
        shutdownWebhookDispatcher = async () => {},
        processRef = process,
        getServer = () => global.server,
        setTimer = setTimeout,
        clearTimer = clearTimeout,
        logger = console,
        forceTimeoutMs = 10000,
        httpCloseTimeoutMs = 3000
    } = options;

    let shutdownPromise = null;
    let highestRequestedExitCode = 0;

    function shutdown(signal, requestedExitCode = 0) {
        highestRequestedExitCode = Math.max(highestRequestedExitCode, normalizeExitCode(requestedExitCode));
        if (shutdownPromise) return shutdownPromise;

        shutdownPromise = (async () => {
            const state = { completed: [], failures: [], logger };
            system.markAppShuttingDown?.();
            const forceTimer = setTimer(() => {
                logger.error("[SHUTDOWN] ⏱️ Timeout — forcing exit");
                processRef.exit(1);
            }, forceTimeoutMs);
            forceTimer?.unref?.();

            logger.log(`\n⛔ [SHUTDOWN] ${signal} — graceful shutdown starting...`);

            await runCleanupStep("cron stop", () => system.stopCronJobs?.(), state);
            await runCleanupStep("DM stop", () => dmService?.stop?.(), state);
            await runCleanupStep("runtime cleanups", async () => {
                if (typeof system.stopRuntimeCleanups === "function") {
                    const result = system.stopRuntimeCleanups(runtimeCleanups);
                    if (Number(result?.failed || 0) > 0) {
                        throw new Error(`${result.failed} runtime cleanup(s) failed`);
                    }
                    return;
                }
                for (const cleanup of runtimeCleanups) await cleanup?.stop?.();
            }, state);
            await runCleanupStep("verification stop", () => verificationRuntime?.stopVerificationRuntime?.(), state);
            await runCleanupStep("voice intake stop", () => voiceWorker?.setShuttingDown?.(true), state);
            await runCleanupStep("voice pause", () => voiceWorker?.pauseAll?.(), state);
            await runCleanupStep("database save", () => sessionManager?.saveDatabase?.(), state);
            await runCleanupStep("Discord destroy", () => client?.destroy?.(), state);
            await runCleanupStep("memory monitor stop", () => memoryMonitor?.stopMemoryMonitor?.(), state);
            await runCleanupStep("HTTP close", () => closeHttpServer(getServer(), {
                setTimer,
                clearTimer,
                timeoutMs: httpCloseTimeoutMs
            }), state);
            await runCleanupStep("webhook flush", async () => {
                const flushed = await flushWebhookQueue(2500);
                if (flushed === false) logger.warn("[SHUTDOWN] ⚠️ Webhook queue did not fully drain before timeout");
            }, state);
            await runCleanupStep("webhook dispatcher stop", () => shutdownWebhookDispatcher(500), state);
            await runCleanupStep("database disconnect", () => sessionManager?.disconnectDB?.(), state);

            clearTimer(forceTimer);
            const finalExitCode = state.failures.length > 0 ? Math.max(1, highestRequestedExitCode) : highestRequestedExitCode;
            processRef.exit(finalExitCode);
            return {
                signal,
                requestedExitCode: highestRequestedExitCode,
                exitCode: finalExitCode,
                completed: state.completed,
                failures: state.failures.map(item => ({
                    name: item.name,
                    message: item.error?.message || String(item.error)
                }))
            };
        })();

        return shutdownPromise;
    }

    shutdown.isShutdownStarted = () => shutdownPromise !== null;
    shutdown.getRequestedExitCode = () => highestRequestedExitCode;
    return shutdown;
}

let installed = false;

function installShutdownCoordinator() {
    if (installed) return false;

    const system = require("../index/system");
    const { flushWebhookQueue, shutdownWebhookDispatcher } = require("./webhooks");
    if (system.initShutdown?.__bestEffortCoordinator === true) {
        installed = true;
        return false;
    }

    function initShutdown(options = {}) {
        const shutdown = createShutdownCoordinator({
            ...options,
            system,
            flushWebhookQueue,
            shutdownWebhookDispatcher,
            processRef: process,
            getServer: () => global.server
        });
        system.setFatalShutdownHandler?.(shutdown);
        process.on("SIGTERM", () => shutdown("SIGTERM", 0));
        process.on("SIGINT", () => shutdown("SIGINT", 0));
        return shutdown;
    }

    Object.defineProperty(initShutdown, "__bestEffortCoordinator", { value: true });
    system.initShutdown = initShutdown;
    installed = true;
    return true;
}

module.exports = {
    runCleanupStep,
    closeHttpServer,
    createShutdownCoordinator,
    installShutdownCoordinator,
    normalizeExitCode
};