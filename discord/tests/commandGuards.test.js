const assert = require("node:assert/strict");
const test = require("node:test");

const {
    hasPermission,
    requireMemberPermission,
    requireBotPermission,
    checkRoleHierarchy,
    safeReply,
    safeDefer,
    sanitizeUserMessage,
    isVoicePanelControl
} = require("../guards/commandGuards");
const { IDS, PREFIXES } = require("../commands/customIds");

function permissionTarget(allowed = []) {
    const set = new Set(allowed);
    return {
        permissions: {
            has(permission) {
                return set.has(permission);
            }
        }
    };
}

function createInteraction(overrides = {}) {
    const calls = [];

    return {
        calls,
        deferred: false,
        replied: false,
        user: { id: "user-1" },
        member: permissionTarget(["VIEW_CHANNEL"]),
        guild: {
            ownerId: "owner-1",
            members: {
                me: permissionTarget(["SEND_MESSAGES"])
            }
        },
        reply(payload) {
            calls.push(["reply", payload]);
            this.replied = true;
            return Promise.resolve(payload);
        },
        followUp(payload) {
            calls.push(["followUp", payload]);
            return Promise.resolve(payload);
        },
        editReply(payload) {
            calls.push(["editReply", payload]);
            return Promise.resolve(payload);
        },
        deferReply(payload) {
            calls.push(["deferReply", payload]);
            this.deferred = true;
            return Promise.resolve(payload);
        },
        ...overrides
    };
}

test("hasPermission supports all and any matching modes", () => {
    const target = permissionTarget(["SEND_MESSAGES", "VIEW_CHANNEL"]);

    assert.equal(hasPermission(target, "SEND_MESSAGES"), true);
    assert.equal(hasPermission(target, ["SEND_MESSAGES", "VIEW_CHANNEL"]), true);
    assert.equal(hasPermission(target, ["SEND_MESSAGES", "MANAGE_MESSAGES"]), false);
    assert.equal(hasPermission(target, ["MANAGE_MESSAGES", "SEND_MESSAGES"], "any"), true);
    assert.equal(hasPermission(null, "SEND_MESSAGES"), false);
});

test("safeReply chooses reply, followUp, or editReply from interaction state", async () => {
    const fresh = createInteraction();
    await safeReply(fresh, { content: "fresh" });
    assert.equal(fresh.calls[0][0], "reply");

    const replied = createInteraction({ replied: true });
    await safeReply(replied, { content: "again" });
    assert.equal(replied.calls[0][0], "followUp");

    const deferred = createInteraction({ deferred: true });
    await safeReply(deferred, { content: "deferred" });
    assert.equal(deferred.calls[0][0], "editReply");
});

test("safeDefer does not defer already handled interactions", async () => {
    const fresh = createInteraction();
    assert.equal(await safeDefer(fresh, { ephemeral: true }), true);
    assert.deepEqual(fresh.calls[0], ["deferReply", { ephemeral: true }]);

    const replied = createInteraction({ replied: true });
    assert.equal(await safeDefer(replied), false);
    assert.equal(replied.calls.length, 0);

    const failing = createInteraction({
        deferReply() {
            this.calls.push(["deferReply"]);
            return Promise.reject(new Error("interaction expired"));
        }
    });
    assert.equal(await safeDefer(failing), false);
    assert.deepEqual(failing.calls[0], ["deferReply"]);
});

test("member and bot permission guards reply on missing permissions", async () => {
    const memberInteraction = createInteraction({
        member: permissionTarget(["VIEW_CHANNEL"])
    });
    assert.equal(await requireMemberPermission(memberInteraction, "ADMINISTRATOR", "need admin"), false);
    assert.equal(memberInteraction.calls[0][0], "reply");
    assert.equal(memberInteraction.calls[0][1].content, "need admin");

    const botInteraction = createInteraction({
        guild: {
            ownerId: "owner-1",
            members: {
                me: {
                    permissionsIn() {
                        return permissionTarget(["VIEW_CHANNEL"]);
                    }
                }
            }
        }
    });
    assert.equal(await requireBotPermission(botInteraction, "SEND_MESSAGES", "need bot send", {}), false);
    assert.equal(botInteraction.calls[0][1].content, "need bot send");
});

test("checkRoleHierarchy rejects protected targets and allows lower targets", () => {
    const config = { emojis: { no_entry: "NO", warning: "WARN", error: "ERR" } };
    const interaction = {
        user: { id: "moderator-1" },
        member: { roles: { highest: { position: 10 } } },
        guild: {
            ownerId: "owner-1",
            members: {
                me: { roles: { highest: { position: 20 } } }
            }
        }
    };
    const client = { user: { id: "bot-1" } };

    assert.equal(checkRoleHierarchy({ interaction, target: { id: "moderator-1" }, client, config }).ok, false);
    assert.equal(checkRoleHierarchy({ interaction, target: { id: "owner-1" }, client, config }).ok, false);
    assert.equal(checkRoleHierarchy({
        interaction,
        target: { id: "target-1", roles: { highest: { position: 5 } } },
        client,
        config
    }).ok, true);
});

test("sanitizeUserMessage neutralizes mentions and blocks risky links", () => {
    const clean = sanitizeUserMessage("@everyone join discord.gg/test run https://x.test/file.exe");

    assert.match(clean, /@\u200beveryone/);
    assert.equal(clean.includes("discord.gg/test"), false);
    assert.equal(clean.includes("file.exe"), false);
});

test("voice panel control matcher uses shared custom IDs and prefixes", () => {
    assert.equal(isVoicePanelControl(IDS.BTN_START, IDS, PREFIXES), true);
    assert.equal(isVoicePanelControl(`${PREFIXES.STATUS_STOP}vc_1`, IDS, PREFIXES), true);
    assert.equal(isVoicePanelControl(`${PREFIXES.STATUS_PAGE}2`, IDS, PREFIXES), true);
    assert.equal(isVoicePanelControl("rolebtn_1", IDS, PREFIXES), false);
    assert.equal(isVoicePanelControl(null, IDS, PREFIXES), false);
});
