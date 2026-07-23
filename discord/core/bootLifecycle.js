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

    await stage("HTTP", "01/06 Start HTTP server", options.startHttpServer, {
        successMessage: "01/06 HTTP server listening", details: value => value
    });
    await stage("DATABASE", "02/06 Connect MongoDB", options.connectDatabase, {
        successMessage: "02/06 MongoDB connected"
    });
    if (shouldAbort("MongoDB connect")) return { aborted: true, abortedAt: "MongoDB connect", degradedStages, stageOrder, discordReady: false };

    await stage("DATABASE", "03/06 Load application data", options.loadDatabase, {
        successMessage: "03/06 Application data loaded"
    });
    if (shouldAbort("database load")) return { aborted: true, abortedAt: "database load", degradedStages, stageOrder, discordReady: false };

    if (options.verificationEnabled) {
        const result = await stage("VERIFICATION", "04/06 Start verification lifecycle", options.startVerification, {
  required: false, successMessage: "04/06 Verification lifecycle started"
        });
        if (!result?.ok) degradedStages.push("verification");
    } else options.onVerificationSkipped?.();

    const commandResult = await stage("COMMANDS", "05/06 Load disabled commands", options.loadDisabledCommands, {
        required: false, successMessage: "05/06 Disabled commands loaded", details: value => value
    });
    if (!commandResult?.ok) degradedStages.push("command_settings");
    if (shouldAbort("before Discord login")) return { aborted: true, abortedAt: "before Discord login", degradedStages, stageOrder, discordReady: false };

    const discordResult = await stage("DISCORD", "06/06 Login Discord client", options.loginDiscord, {
        required: false, successMessage: "06/06 Discord client connected", details: value => value
    });
    if (!discordResult?.ok) degradedStages.push("discord");
    if (shouldAbort("Discord login")) return { aborted: true, abortedAt: "Discord login", degradedStages, stageOrder, discordReady: false };
    return { aborted: false, abortedAt: null, degradedStages, stageOrder, discordReady: Boolean(discordResult?.ok) };
}

module.exports = { runBootLifecycle };
