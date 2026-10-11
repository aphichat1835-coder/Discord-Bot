"use strict";

async function runBootLifecycle(options = {}) {
    if (typeof options.runStage !== "function") throw new TypeError("runStage must be a function");
    const degradedStages = [];
    const stageOrder = [];
    const shouldAbort = options.shouldAbort || (() => false);
    const stage = async (category, label, task, stageOptions = {}) => {
        stageOrder.push(label);
        return options.runStage(category, label, task, stageOptions);
    };

    await stage("HTTP", options.connectSqlite ? "01/07 Start HTTP server" : "01/06 Start HTTP server", options.startHttpServer, {
        successMessage: options.connectSqlite ? "01/07 HTTP server listening" : "01/06 HTTP server listening", details: value => value
    });
    await stage("DATABASE", options.connectSqlite ? "02/07 Connect MongoDB" : "02/06 Connect MongoDB", options.connectDatabase, {
        successMessage: options.connectSqlite ? "02/07 MongoDB connected" : "02/06 MongoDB connected"
    });
    if (shouldAbort("MongoDB connect")) return { aborted: true, abortedAt: "MongoDB connect", degradedStages, stageOrder, discordReady: false };

    if (options.connectSqlite) {
        await stage("DATABASE", "03/07 Open and validate SQLite", options.connectSqlite, {
            successMessage: "03/07 SQLite operational database ready", details: value => value
        });
        if (shouldAbort("SQLite open")) return { aborted: true, abortedAt: "SQLite open", degradedStages, stageOrder, discordReady: false };
    }

    await stage("DATABASE", options.connectSqlite ? "04/07 Load application data" : "03/06 Load application data", options.loadDatabase, {
        successMessage: options.connectSqlite ? "04/07 Application data loaded" : "03/06 Application data loaded"
    });
    if (shouldAbort("database load")) return { aborted: true, abortedAt: "database load", degradedStages, stageOrder, discordReady: false };

    if (options.verificationEnabled) {
        const result = await stage("VERIFICATION", options.connectSqlite ? "05/07 Start verification lifecycle" : "04/06 Start verification lifecycle", options.startVerification, {
            required: false, successMessage: options.connectSqlite ? "05/07 Verification lifecycle started" : "04/06 Verification lifecycle started"
        });
        if (!result?.ok) degradedStages.push("verification");
    } else options.onVerificationSkipped?.();

    const commandResult = await stage("COMMANDS", options.connectSqlite ? "06/07 Load disabled commands" : "05/06 Load disabled commands", options.loadDisabledCommands, {
        required: false, successMessage: options.connectSqlite ? "06/07 Disabled commands loaded" : "05/06 Disabled commands loaded", details: value => value
    });
    if (!commandResult?.ok) degradedStages.push("command_settings");
    if (shouldAbort("before Discord login")) return { aborted: true, abortedAt: "before Discord login", degradedStages, stageOrder, discordReady: false };

    const discordResult = await stage("DISCORD", options.connectSqlite ? "07/07 Login Discord client" : "06/06 Login Discord client", options.loginDiscord, {
        required: false, successMessage: options.connectSqlite ? "07/07 Discord client connected" : "06/06 Discord client connected", details: value => value
    });
    if (!discordResult?.ok) degradedStages.push("discord");
    if (shouldAbort("Discord login")) return { aborted: true, abortedAt: "Discord login", degradedStages, stageOrder, discordReady: false };
    return { aborted: false, abortedAt: null, degradedStages, stageOrder, discordReady: Boolean(discordResult?.ok) };
}

module.exports = { runBootLifecycle };
