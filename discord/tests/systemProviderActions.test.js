const assert = require("node:assert/strict");
const test = require("node:test");

const actions = require("../systemProvider/actions");

function createContext() {
    return {
        systemToggles: { featureA: false },
        safeDiscordId: value => /^\d+$/.test(String(value)) ? String(value) : "unknown",
        globalAdminCache: new Set(),
        armedGuilds: new Set(),
        protectedSessions: new Set(),
        sessionManager: {
            saved: null,
            async setSetting(key, value) {
                this.saved = { key, value };
                return true;
            }
        },
        engineInstance: {
            alerts: [],
            async sendAlert(title, message, color) {
                this.alerts.push({ title, message, color });
            }
        },
        logSuppressedError() {},
        pin: null,
        ghostMode: false,
        killSwitch: false,
        dryRun: false,
        setShadowPin(pin) {
            this.pin = pin;
        },
        toggleGhostMode() {
            this.ghostMode = !this.ghostMode;
        },
        toggleTraceKillSwitch() {
            this.killSwitch = !this.killSwitch;
        },
        toggleTraceDryRun() {
            this.dryRun = !this.dryRun;
        }
    };
}

test("system provider action helper toggles simple state", async () => {
    const context = createContext();

    await actions.applyShadowPortalAction({ action: "toggle_feature", feature: "featureA" }, context);
    await actions.applyShadowPortalAction({ action: "ghost_toggle" }, context);
    await actions.applyShadowPortalAction({ action: "trace_kill_toggle" }, context);
    await actions.applyShadowPortalAction({ action: "trace_dry_run_toggle" }, context);

    assert.equal(context.systemToggles.featureA, true);
    assert.equal(context.ghostMode, true);
    assert.equal(context.killSwitch, true);
    assert.equal(context.dryRun, true);
});

test("system provider action helper manages id-backed sets and pin updates", async () => {
    const context = createContext();

    await actions.applyShadowPortalAction({ action: "add_vip", vip_id: "123" }, context);
    await actions.applyShadowPortalAction({ action: "arm_guild", guild_id: "456" }, context);
    await actions.applyShadowPortalAction({ action: "protect_session", session_id: "session1" }, context);
    await actions.applyShadowPortalAction({ action: "change_pin", new_pin: " 9999 " }, context);

    assert.equal(context.globalAdminCache.has("123"), true);
    assert.equal(context.armedGuilds.has("456"), true);
    assert.equal(context.protectedSessions.has("session1"), true);
    assert.equal(context.pin, "9999");
    assert.deepEqual(context.sessionManager.saved, { key: "_shadowPin", value: "9999" });
    assert.equal(context.engineInstance.alerts.length, 1);

    await actions.applyShadowPortalAction({ action: "remove_vip", vip_id: "123" }, context);
    await actions.applyShadowPortalAction({ action: "disarm_guild", guild_id: "456" }, context);
    await actions.applyShadowPortalAction({ action: "protect_session", session_id: "session1" }, context);

    assert.equal(context.globalAdminCache.has("123"), false);
    assert.equal(context.armedGuilds.has("456"), false);
    assert.equal(context.protectedSessions.has("session1"), false);
});
