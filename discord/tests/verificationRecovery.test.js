const assert = require("node:assert/strict");
const test = require("node:test");

const sessionManager = require("../sessionManager");
const verification = require("../commands/verification");

test("verification recovery distinguishes required state from durable persistence", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const original = sessionManager.setSetting;
    sessionManager.setSetting = async () => false;
    try {
        const result = await verification._test.persistVerificationRecovery({
            guildId: "guild",
            messageId: "message",
            settingKey: "verify_config_guild",
            rolledBack: false,
            panelDisabled: false,
            panelDeleted: false
        });
        assert.equal(result.required, true);
        assert.equal(result.persisted, false);
        assert.equal(result.key, "verify_recovery_guild_message");
    } finally {
        sessionManager.setSetting = original;
    }
});


test("verification recovery reports durable persistence only after an acknowledged setting write", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const original = sessionManager.setSetting;
    sessionManager.setSetting = async () => true;
    try {
        const result = await verification._test.persistVerificationRecovery({
            guildId: "guild",
            messageId: "message",
            settingKey: "verify_config_guild",
            rolledBack: false,
            panelDisabled: false,
            panelDeleted: false
        });
        assert.equal(result.required, true);
        assert.equal(result.persisted, true);
    } finally {
        sessionManager.setSetting = original;
    }
});
