const assert = require("node:assert/strict");
const test = require("node:test");

const actions = require("../systemProvider/actions");
const { isPinCredential, verifyPinCredential } = require("../systemProvider/pinCredential");

const OWNER_ID = "111111111111111111";
const VIP_ID = "222222222222222222";
const GUILD_ID = "333333333333333333";

function createContext(overrides = {}) {
    const auditEvents = [];
    const context = {
        ownerId: OWNER_ID,
        actorId: OWNER_ID,
        actorCapability: "owner_only",
        systemToggles: { featureA: false, cmdNuke: false },
        safeDiscordId: value => /^\d{17,22}$/.test(String(value)) ? String(value) : "unknown",
        globalAdminCache: new Set(),
        armedGuilds: new Map(),
        protectedSessions: new Set(),
        mainClient: {
            guilds: { cache: new Map([[GUILD_ID, { id: GUILD_ID, name: "Test Guild", memberCount: 5 }]]) }
        },
        sessionManager: {
            saved: null,
            getSession(sessionId) {
                return sessionId === "session1" ? { sessionId } : null;
            },
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
        armTtlMs: 5 * 60_000,
        verifyStepUpPin(pin) {
            return pin === "correct-step-up";
        },
        async auditOwnerAction(event) {
            auditEvents.push(event);
            return true;
        },
        auditEvents,
        scheduledArm: null,
        scheduleArmTimer(guildId, generation, expiresAt) {
            this.scheduledArm = { guildId, generation, expiresAt };
        },
        cancelArmTimer() {},
        pin: "old-protected-pin",
        sessionVersion: 1,
        setShadowPin(pin) {
            this.pin = pin;
        },
        getShadowSessionVersion() {
            return this.sessionVersion;
        },
        setShadowSessionVersion(version) {
            this.sessionVersion = version;
        },
        resetShadowAuth() {},
        ghostMode: false,
        getGhostMode() {
            return this.ghostMode;
        },
        toggleGhostMode() {
            this.ghostMode = !this.ghostMode;
        },
        killSwitch: false,
        getTraceKillSwitch() {
            return this.killSwitch;
        },
        toggleTraceKillSwitch() {
            this.killSwitch = !this.killSwitch;
        },
        dryRun: false,
        getTraceDryRun() {
            return this.dryRun;
        },
        toggleTraceDryRun() {
            this.dryRun = !this.dryRun;
        }
    };
    return Object.assign(context, overrides);
}

function actionBody(action, extra = {}) {
    return {
        action,
        reason: "owner approved test action",
        step_up_pin: "correct-step-up",
        request_id: `test-${action}`,
        ...extra
    };
}

test("protected actions require owner capability but no reason or repeated PIN", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = createContext();

    const noCapability = await actions.applyShadowPortalAction(
        { action: "toggle_feature", feature: "featureA" },
        { ...context, actorCapability: "operator" }
    );
    assert.equal(noCapability.status, 403);
    assert.equal(context.systemToggles.featureA, false);

    const applied = await actions.applyShadowPortalAction(
        { action: "toggle_feature", feature: "featureA" },
        context
    );
    assert.equal(applied.ok, true);
    assert.equal(context.systemToggles.featureA, true);
    assert.deepEqual(context.auditEvents.map(event => event.phase), ["intent", "result"]);
    assert.equal(context.auditEvents[0].reason, "owner_dashboard");
});

test("permanently disabled destructive features cannot be armed through the portal", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = createContext();
    const response = await actions.applyShadowPortalAction(
        actionBody("toggle_feature", { feature: "cmdNuke" }),
        context
    );
    assert.equal(response.ok, false);
    assert.equal(response.status, 403);
    assert.equal(response.code, "feature_permanently_disabled");
    assert.equal(context.systemToggles.cmdNuke, false);
});

test("owner capability manages VIP, ARM generation, and session protection", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = createContext();

    const vipResult = await actions.applyShadowPortalAction(
        actionBody("add_vip", { vip_id: VIP_ID }),
        context
    );
    assert.equal(vipResult.ok, true);
    assert.equal(context.globalAdminCache.has(VIP_ID), true);

    const armResult = await actions.applyShadowPortalAction(
        actionBody("arm_guild", { guild_id: GUILD_ID }),
        context
    );
    assert.equal(armResult.ok, true);
    assert.equal(context.armedGuilds.has(GUILD_ID), true);
    assert.ok(context.armedGuilds.get(GUILD_ID).expiresAt > Date.now());
    assert.equal(context.scheduledArm.guildId, GUILD_ID);
    assert.equal(context.scheduledArm.generation, armResult.generation);

    const protectResult = await actions.applyShadowPortalAction({
        action: "protect_session",
        session_id: "session1",
        reason: "protect active owner session",
        request_id: "test-protect-session"
    }, context);
    assert.equal(protectResult.ok, true);
    assert.equal(context.protectedSessions.has("session1"), true);
});

test("PIN changes persist a scrypt credential before rotating memory and sessions", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const plaintext = "new-strong-protected-pin";
    const context = createContext();
    const result = await actions.applyShadowPortalAction(
        actionBody("change_pin", { new_pin: plaintext }),
        context
    );

    assert.equal(result.ok, true);
    assert.equal(context.sessionVersion, 2);
    assert.equal(context.sessionManager.saved.key, "_shadowPortalAuth");
    const saved = context.sessionManager.saved.value;
    assert.equal(saved.credentialVersion, 1);
    assert.equal(saved.sessionVersion, 2);
    assert.equal(saved.pin.includes(plaintext), false);
    assert.equal(isPinCredential(saved.pin), true);
    assert.equal(verifyPinCredential(plaintext, saved.pin), true);
    assert.equal(verifyPinCredential("wrong-protected-pin", saved.pin), false);
    assert.equal(context.pin, saved.pin);
    assert.equal(context.engineInstance.alerts.length, 1);
});

test("PIN persistence failure leaves in-memory credentials and session version unchanged", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = createContext({
        sessionManager: {
            async setSetting() {
                return false;
            }
        }
    });
    const result = await actions.applyShadowPortalAction(
        actionBody("change_pin", { new_pin: "new-strong-protected-pin" }),
        context
    );

    assert.equal(result.ok, false);
    assert.equal(result.status, 503);
    assert.equal(result.code, "pin_persistence_failed");
    assert.equal(context.pin, "old-protected-pin");
    assert.equal(context.sessionVersion, 1);
});

test("audit failure does not block an authenticated owner action", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const context = createContext({
        async auditOwnerAction() {
            return false;
        }
    });
    const result = await actions.applyShadowPortalAction(
        { action: "toggle_feature", feature: "featureA" },
        context
    );
    assert.equal(result.ok, true);
    assert.equal(context.systemToggles.featureA, true);
});

test("prototype-chain action names are rejected before dispatch or audit", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    for (const action of ["constructor", "Constructor", "toString", "valueOf", "__proto__"]) {
        const context = createContext();
        const response = await actions.applyShadowPortalAction({ action }, context);
        assert.equal(response.ok, false, action);
        assert.equal(response.status, 400, action);
        assert.equal(response.code, "invalid_action", action);
        assert.deepEqual(context.auditEvents, [], action);
    }
});