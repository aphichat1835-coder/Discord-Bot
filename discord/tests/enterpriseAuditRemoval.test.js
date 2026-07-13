const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const { slashCommandsData } = require("../commands/registry");
const compatibilityStorage = require("../logging/auditStorage");

test("Enterprise Audit command, web, runtime, and storage surfaces stay removed", () => {
    const commandNames = slashCommandsData.map(command => command.name);
    const runtimeSource = fs.readFileSync("discord/index.js", "utf8");
    const serverSource = fs.readFileSync("discord/index/server.js", "utf8");
    const systemSource = fs.readFileSync("discord/index/system.js", "utf8");
    const memorySource = fs.readFileSync("discord/index/memoryMonitor.js", "utf8");
    const commandRouterSource = fs.readFileSync("discord/commands.js", "utf8");
    const utilitySource = fs.readFileSync("discord/commands/utility.js", "utf8");
    const moderationSource = fs.readFileSync("discord/commands/moderation.js", "utf8");
    const moderationWorkflowSource = fs.readFileSync("discord/commands/moderationWorkflow.js", "utf8");
    const panelInteractionsSource = fs.readFileSync("discord/commands/panelInteractions.js", "utf8");
    const sessionSource = fs.readFileSync("discord/sessionManager.js", "utf8");

    assert.equal(commandNames.length, 16);
    assert.equal(commandNames.includes("setup-log"), false);
    assert.equal(fs.existsSync("discord/auditLogger.js"), false);
    assert.equal(fs.existsSync("discord/commands/setupLog.js"), false);
    assert.equal(fs.existsSync("discord/index/auditWebBundle.js"), false);
    assert.doesNotMatch(runtimeSource, /auditLogger|startAuditRuntime|auditReconciler/);
    assert.doesNotMatch(runtimeSource, /GUILD_BANS|GUILD_MESSAGE_REACTIONS|GUILD_INVITES/);
    assert.doesNotMatch(runtimeSource, /partials\s*:/);
    assert.doesNotMatch(serverSource, /\/audit-logs|\/api\/audit|auditLogger|getAuditStats/);
    assert.doesNotMatch(systemSource, /stopAuditCleanup|auditReconcilerScheduler/);
    assert.doesNotMatch(memorySource, /auditLogger|auditQueues|getAuditStats/);
    assert.doesNotMatch(commandRouterSource, /setupLog|getLogChannel|logChannelMapExtra_/);
    assert.doesNotMatch(utilitySource, /sendUtilLog|getLogChannel|LogChannelMap|routeAndSendLog/);
    assert.doesNotMatch(moderationSource, /getLogChannel|LogChannelMap|routeAndSendLog/);
    assert.doesNotMatch(moderationWorkflowSource, /sendModerationCaseLog|routeAndSendLog|buildModerationCaseEmbed/);
    assert.doesNotMatch(panelInteractionsSource, /logStartedSession|getLogChannel/);
    assert.doesNotMatch(sessionSource, /AuditLogEvent|LogChannelMap/);
    assert.doesNotMatch(sessionSource, /BotSettingsModel\.find\(\{\}\)/);
    assert.match(sessionSource, /RETIRED_ENTERPRISE_AUDIT_SETTINGS/);
});

test("protected compatibility storage does not reopen Enterprise Audit models or keys", () => {
    const compatibilitySource = fs.readFileSync("discord/logging/auditStorage.js", "utf8");
    const internalSource = fs.readFileSync("discord/logging/internalEventStorage.js", "utf8");
    const key = compatibilityStorage.storageKey("guild", "event");

    assert.equal(compatibilityStorage.canUseMongoStore(), false);
    assert.match(key, /^internal_event_/);
    assert.equal(key.startsWith("audit_event_"), false);
    assert.match(compatibilitySource, /require\("\.\/internalEventStorage"\)/);
    assert.doesNotMatch(internalSource, /require\("mongoose"\)|require\("\.\/auditLogStore"\)|mongoose\.connection|auditLogStore\./);
});

test("separate operational and Verification audit systems remain available", () => {
    const webhooks = require("../core/webhooks");
    const sensitiveAudit = require("../verification/services/sensitiveAuditService");

    assert.equal(typeof webhooks.sendLogWebhook, "function");
    assert.equal(typeof webhooks.sendAlertWebhook, "function");
    assert.equal(typeof sensitiveAudit.auditGuildConfigUpdate, "function");
});
