"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const testDir = path.join(os.tmpdir(), "temp-jc-modal-test-" + Date.now());
fs.mkdirSync(testDir, { recursive: true });
const testDbPath = path.join(testDir, "test.sqlite");
process.env.SQLITE_DB_PATH = testDbPath;

const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const testDb = openDatabase({ path: testDbPath });
runMigrations(testDb);

const { CUSTOM_IDS } = require("../features/joinCampaign/ui/modals");
const { IDS: PANEL_IDS } = require("../features/joinCampaign/ui/panelBuilder");
const { IDS: CONFIRM_IDS } = require("../features/joinCampaign/ui/confirmationBuilder");
const { isJoinCampaignInteraction, handleJoinCampaignInteraction } = require("../features/joinCampaign/handlers/interactionRouter");
const { handleModalSubmit } = require("../features/joinCampaign/handlers/modalSubmitHandler");
const joinCampaignService = require("../features/joinCampaign/services/joinCampaignService");
const campaignWorker = require("../features/joinCampaign/worker/campaignWorker");
const oauthTokenManager = require("../tokens/oauthTokenManager");
const database = require("../../database/index");
const config = require("../config.json");

const originalListCandidates = oauthTokenManager.listAccessTokenCandidates;

test.before(() => {
    oauthTokenManager.listAccessTokenCandidates = async () => ({
        candidates: [{ userId: "100", tokenField: "oauth", scope: "identify guilds.join" }],
        hasMore: false,
        nextCursor: null
    });
});

test.after(() => {
    oauthTokenManager.listAccessTokenCandidates = originalListCandidates;
    closeDatabase();
    delete process.env.SQLITE_DB_PATH;
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch (_) {}
});

test("Join Campaign: Interaction Router and Modal Submit Handlers Suite", async (t) => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const ownerId = config.system?.ownerId || "123456789012345678";

    function createMockInteraction(overrides = {}) {
        return {
            customId: "",
            channelId: "chan_jc_1",
            guildId: "guild_jc_1",
            user: { id: ownerId },
            replied: false,
            deferred: false,
            replyPayload: null,
            deferOptions: null,
            modalShown: null,
            updatePayload: null,
            editReplyPayload: null,
            fields: {
                getTextInputValue: () => ""
            },
            isStringSelectMenu: () => false,
            isButton: () => false,
            isModalSubmit: () => false,
            async reply(payload) {
                this.replied = true;
                this.replyPayload = payload;
            },
            async deferReply(opts) {
                this.deferred = true;
                this.deferOptions = opts;
            },
            async editReply(payload) {
                this.editReplyPayload = payload;
            },
            async showModal(modal) {
                this.modalShown = modal;
            },
            async update(payload) {
                this.updatePayload = payload;
            },
            ...overrides
        };
    }

    await t.test("1. isJoinCampaignInteraction matches valid customIds", () => {
        assert.equal(isJoinCampaignInteraction({ customId: "other_button" }), false);
        assert.equal(isJoinCampaignInteraction({ customId: PANEL_IDS.SELECT_MODE }), true);
        assert.equal(isJoinCampaignInteraction({ customId: PANEL_IDS.BTN_START }), true);
        assert.equal(isJoinCampaignInteraction({ customId: `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}stage_1` }), true);
        assert.equal(isJoinCampaignInteraction({ customId: `${CUSTOM_IDS.MODAL_SETUP_PREFIX}all_to_target` }), true);
        assert.equal(isJoinCampaignInteraction({ customId: CUSTOM_IDS.MODAL_START }), true);
    });

    await t.test("2. Non-owner interaction is rejected with ephemeral error", async () => {
        const interaction = createMockInteraction({
            customId: PANEL_IDS.BTN_START,
            user: { id: "not_the_owner" },
            isButton: () => true
        });

        const handled = await handleJoinCampaignInteraction(interaction, {});
        assert.equal(handled, true);
        assert.ok(interaction.replied);
        assert.match(interaction.replyPayload.content, /เจ้าของบอท/);
    });

    await t.test("3. Mode select interaction shows setup modal", async () => {
        const interaction = createMockInteraction({
            customId: PANEL_IDS.SELECT_MODE,
            values: ["all_to_target"],
            isStringSelectMenu: () => true
        });

        const handled = await handleJoinCampaignInteraction(interaction, {});
        assert.equal(handled, true);
        assert.ok(interaction.modalShown);
    });

    await t.test("4. Start button interaction handling", async () => {
        // When already running
        campaignWorker._activeWorkerPromise = Promise.resolve();
        const interactionRunning = createMockInteraction({
            customId: PANEL_IDS.BTN_START,
            isButton: () => true
        });
        await handleJoinCampaignInteraction(interactionRunning, {});
        assert.ok(interactionRunning.replied);
        assert.match(interactionRunning.replyPayload.content, /กำลังทำงานอยู่/);
        campaignWorker._activeWorkerPromise = null;

        // When panel has no targetGuildId, shows setup modal
        const interactionNoTarget = createMockInteraction({
            customId: PANEL_IDS.BTN_START,
            isButton: () => true
        });
        await handleJoinCampaignInteraction(interactionNoTarget, {});
        assert.ok(interactionNoTarget.modalShown);

        // When panel has targetGuildId, shows start options modal
        const repo = database.repositories.joinCampaign;
        repo.savePanel({
            channelId: interactionNoTarget.channelId,
            guildId: "guild_jc_1",
            mode: "all_to_target",
            targetGuildId: "999888777666555444"
        });

        const interactionReady = createMockInteraction({
            customId: PANEL_IDS.BTN_START,
            isButton: () => true
        });
        await handleJoinCampaignInteraction(interactionReady, {});
        assert.ok(interactionReady.modalShown);
    });

    await t.test("5. Confirm button interaction handling (success and failure)", async () => {
        const mockTargetGuild = {
            id: "999888777666555444",
            name: "Target Server",
            memberCount: 10,
            members: {
                me: { permissions: { has: () => true } },
                fetch: async () => new Map()
            }
        };

        const mockClient = {
            channels: { fetch: async () => null },
            guilds: {
                cache: new Map([["999888777666555444", mockTargetGuild]]),
                fetch: async () => mockTargetGuild
            }
        };

        // Failure case
        const interactionFail = createMockInteraction({
            customId: `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}missing_stage_id`,
            isButton: () => true
        });
        await handleJoinCampaignInteraction(interactionFail, mockClient);
        assert.ok(interactionFail.updatePayload);
        assert.match(interactionFail.updatePayload.content, /ไม่สามารถเริ่มงานได้/);

        // Success case using service.stageCampaign
        const { getMode } = require("../features/joinCampaign/modes/modeRegistry");
        const stageRes = await joinCampaignService.stageCampaign({
            client: mockClient,
            repository: database.repositories.joinCampaign,
            mode: getMode("all_to_target"),
            baseConfig: { targetGuildId: "999888777666555444" },
            requestedAmount: 5,
            startedByUserId: ownerId,
            channelId: "chan_jc_1"
        });
        assert.equal(stageRes.ok, true);

        const interactionSuccess = createMockInteraction({
            customId: `${CONFIRM_IDS.BTN_CONFIRM_PREFIX}${stageRes.stageId}`,
            isButton: () => true
        });
        await handleJoinCampaignInteraction(interactionSuccess, mockClient);
        assert.ok(interactionSuccess.updatePayload);
        assert.match(interactionSuccess.updatePayload.content, /เริ่มดึงสมาชิก/);
    });

    await t.test("6. handleModalSubmit: Setup modal submit handling", async () => {
        let editedMessage = null;
        const mockTargetGuild = {
            id: "999888777666555444",
            name: "Target Server",
            memberCount: 10,
            members: {
                me: { permissions: { has: () => true } },
                fetch: async () => new Map()
            }
        };

        const mockClient = {
            channels: {
                fetch: async () => ({
                    messages: {
                        fetch: async () => ({
                            edit: async (payload) => { editedMessage = payload; }
                        })
                    }
                })
            },
            guilds: {
                cache: new Map([["999888777666555444", mockTargetGuild]]),
                fetch: async () => mockTargetGuild
            }
        };

        // Validation failure (invalid guild id)
        const interactionBadGuild = createMockInteraction({
            customId: `${CUSTOM_IDS.MODAL_SETUP_PREFIX}all_to_target`,
            isModalSubmit: () => true,
            fields: {
                getTextInputValue: (field) => field === CUSTOM_IDS.FIELD_TARGET ? "invalid_guild" : ""
            }
        });
        await handleModalSubmit(interactionBadGuild, mockClient);
        assert.ok(interactionBadGuild.deferred);
        assert.match(interactionBadGuild.editReplyPayload.content, /ไม่สามารถตั้งค่าได้/);

        // Validation success
        const interactionGood = createMockInteraction({
            customId: `${CUSTOM_IDS.MODAL_SETUP_PREFIX}all_to_target`,
            isModalSubmit: () => true,
            message: { id: "msg_panel_1" },
            fields: {
                getTextInputValue: (field) => field === CUSTOM_IDS.FIELD_TARGET ? "999888777666555444" : ""
            }
        });
        await handleModalSubmit(interactionGood, mockClient);
        assert.ok(interactionGood.editReplyPayload);
        assert.match(interactionGood.editReplyPayload.content, /บันทึกการตั้งค่าเรียบร้อยแล้ว/);
        assert.ok(editedMessage);
    });

    await t.test("7. handleModalSubmit: Start modal submit handling", async () => {
        // No panel configured
        const interactionNoPanel = createMockInteraction({
            customId: CUSTOM_IDS.MODAL_START,
            channelId: "unconfigured_channel_99",
            isModalSubmit: () => true
        });
        await handleModalSubmit(interactionNoPanel, {});
        assert.ok(interactionNoPanel.replied);
        assert.match(interactionNoPanel.replyPayload.content, /กำหนดเซิร์ฟเวอร์ก่อนเริ่ม/);

        // Panel configured - staging execution
        const repo = database.repositories.joinCampaign;
        repo.savePanel({
            channelId: "chan_jc_1",
            guildId: "guild_jc_1",
            mode: "all_to_target",
            targetGuildId: "999888777666555444"
        });

        const mockTargetGuild = {
            id: "999888777666555444",
            name: "Target Server",
            memberCount: 10,
            members: {
                me: { permissions: { has: () => true } },
                fetch: async () => new Map()
            }
        };

        const mockClient = {
            guilds: {
                cache: new Map([["999888777666555444", mockTargetGuild]]),
                fetch: async () => mockTargetGuild
            }
        };

        const interactionStart = createMockInteraction({
            customId: CUSTOM_IDS.MODAL_START,
            channelId: "chan_jc_1",
            isModalSubmit: () => true,
            fields: {
                getTextInputValue: (field) => field === CUSTOM_IDS.FIELD_AMOUNT ? "10" : ""
            }
        });

        await handleModalSubmit(interactionStart, mockClient);
        assert.ok(interactionStart.deferred);
        assert.ok(interactionStart.editReplyPayload);
    });
});
