"use strict";

function stageTag(total, num, action, pastAction) {
    const pad = n => String(n).padStart(2, "0");
    const prefix = `${pad(num)}/${pad(total)}`;
    return {
        label: `${prefix} ${action}`,
        successMessage: `${prefix} ${pastAction}`
    };
}

async function runStorageStages(stage, options, total, shouldAbort) {
    const s1 = stageTag(total, 1, "Start HTTP server", "HTTP server listening");
    await stage("HTTP", s1.label, options.startHttpServer, { successMessage: s1.successMessage, details: value => value });

    const s2 = stageTag(total, 2, "Connect MongoDB", "MongoDB connected");
    await stage("DATABASE", s2.label, options.connectDatabase, { successMessage: s2.successMessage });
    if (shouldAbort("MongoDB connect")) return "MongoDB connect";

    if (options.connectSqlite) {
        const s3 = stageTag(total, 3, "Open and validate SQLite", "SQLite operational database ready");
        await stage("DATABASE", s3.label, options.connectSqlite, { successMessage: s3.successMessage, details: value => value });
        if (shouldAbort("SQLite open")) return "SQLite open";
    }

    const dataIndex = options.connectSqlite ? 4 : 3;
    const sData = stageTag(total, dataIndex, "Load application data", "Application data loaded");
    await stage("DATABASE", sData.label, options.loadDatabase, { successMessage: sData.successMessage });
    if (shouldAbort("database load")) return "database load";

    return null;
}

async function runAppStages(stage, options, total, degradedStages, shouldAbort) {
    const verifyIndex = options.connectSqlite ? 5 : 4;
    if (options.verificationEnabled) {
        const sVerify = stageTag(total, verifyIndex, "Start verification lifecycle", "Verification lifecycle started");
        const result = await stage("VERIFICATION", sVerify.label, options.startVerification, {
            required: false,
            successMessage: sVerify.successMessage
        });
        if (!result?.ok) degradedStages.push("verification");
    } else {
        options.onVerificationSkipped?.();
    }

    const cmdIndex = options.connectSqlite ? 6 : 5;
    const sCmd = stageTag(total, cmdIndex, "Load disabled commands", "Disabled commands loaded");
    const commandResult = await stage("COMMANDS", sCmd.label, options.loadDisabledCommands, {
        required: false,
        successMessage: sCmd.successMessage,
        details: value => value
    });
    if (!commandResult?.ok) degradedStages.push("command_settings");
    if (shouldAbort("before Discord login")) return { aborted: true, abortedAt: "before Discord login" };

    const discordIndex = options.connectSqlite ? 7 : 6;
    const sDiscord = stageTag(total, discordIndex, "Login Discord client", "Discord client connected");
    const discordResult = await stage("DISCORD", sDiscord.label, options.loginDiscord, {
        required: false,
        successMessage: sDiscord.successMessage,
        details: value => value
    });
    if (!discordResult?.ok) degradedStages.push("discord");
    if (shouldAbort("Discord login")) return { aborted: true, abortedAt: "Discord login" };

    return { aborted: false, discordReady: Boolean(discordResult?.ok) };
}

async function runBootLifecycle(options = {}) {
    if (typeof options.runStage !== "function") throw new TypeError("runStage must be a function");
    const degradedStages = [];
    const stageOrder = [];
    const shouldAbort = options.shouldAbort || (() => false);
    const stage = async (category, label, task, stageOptions = {}) => {
        stageOrder.push(label);
        return options.runStage(category, label, task, stageOptions);
    };

    const total = options.connectSqlite ? 7 : 6;

    const storageAbort = await runStorageStages(stage, options, total, shouldAbort);
    if (storageAbort) {
        return { aborted: true, abortedAt: storageAbort, degradedStages, stageOrder, discordReady: false };
    }

    const appOutcome = await runAppStages(stage, options, total, degradedStages, shouldAbort);
    if (appOutcome.aborted) {
        return { aborted: true, abortedAt: appOutcome.abortedAt, degradedStages, stageOrder, discordReady: false };
    }

    return { aborted: false, abortedAt: null, degradedStages, stageOrder, discordReady: appOutcome.discordReady };
}

module.exports = { runBootLifecycle };
