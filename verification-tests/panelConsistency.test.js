"use strict";

const guildRoutes = require("../discord/verification/routes/guild");
const discordAPI = require("../discord/verification/utils/discordAPI");

describe("verification panel DB/Discord consistency", () => {
    afterEach(() => jest.restoreAllMocks());

    test("builds a safe rollback payload from the original Discord message", () => {
        expect(guildRoutes._test.panelRollbackPayload({
            content: "old",
            embeds: [{ title: "Old" }],
            components: [{ type: 1 }]
        })).toEqual({
            content: "old",
            embeds: [{ title: "Old" }],
            components: [{ type: 1 }],
            allowed_mentions: { parse: [] }
        });
    });

    test("reports the real Discord rollback result", async () => {
        jest.spyOn(discordAPI, "editChannelMessage")
            .mockResolvedValueOnce({ ok: true, status: 200 })
            .mockResolvedValueOnce({ ok: false, status: 500 });
        await expect(guildRoutes._test.rollbackDiscordPanel("1", "2", {}))
            .resolves.toEqual({ complete: true, status: 200, code: null });
        await expect(guildRoutes._test.rollbackDiscordPanel("1", "2", {}))
            .resolves.toEqual({ complete: false, status: 500, code: "discord_panel_rollback_failed" });
    });

    test("compares the live Discord message with the saved panel fields", () => {
        const live = guildRoutes._test.panelConfigFromDiscordMessage({
            content: "ก่อนเริ่ม",
            embeds: [{ title: "ยืนยัน", description: "กดปุ่ม", color: 0x5865F2, footer: { text: "Discord Verification System" } }],
            components: [{ components: [{ type: 2, label: "ยืนยันตอนนี้", url: "https://example.test" }] }]
        });
        const expected = guildRoutes._test.comparablePanel({
            content: "ก่อนเริ่ม",
            title: "ยืนยัน",
            description: "กดปุ่ม",
            color: "#5865F2",
            buttonText: "ยืนยันตอนนี้",
            verifyType: "oauth"
        });
        const actual = guildRoutes._test.comparablePanel(live);

        expect(guildRoutes._test.panelDifferences(expected, actual)).toEqual([]);
        expect(guildRoutes._test.panelDifferences(expected, { ...actual, title: "เปลี่ยนแล้ว" }))
            .toEqual(["title"]);
    });


    test("confirms an ambiguous config save from the database before rolling Discord back", async () => {
        const GuildConfig = require("../discord/verification/models/GuildConfig");
        const query = {
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue({
                verification: { channelId: "1", messageId: "2", panelRevision: "rev-2" }
            })
        };
        jest.spyOn(GuildConfig, "findOne").mockReturnValue(query);
        await expect(guildRoutes._test.persistedPanelMatches("guild", {
            channelId: "1", messageId: "2", panelRevision: "rev-2"
        })).resolves.toEqual({ status: "matched", errorCode: null });
        await expect(guildRoutes._test.persistedPanelMatches("guild", {
            channelId: "1", messageId: "2", panelRevision: "rev-old"
        })).resolves.toEqual({ status: "mismatched", errorCode: null });
    });

    test("keeps Discord untouched when persistence cannot be read", async () => {
        const GuildConfig = require("../discord/verification/models/GuildConfig");
        jest.spyOn(GuildConfig, "findOne").mockImplementation(() => {
            throw Object.assign(new Error("database unavailable"), { code: "db_unavailable" });
        });
        await expect(guildRoutes._test.persistedPanelMatches("guild", {
            channelId: "1", messageId: "2", panelRevision: "rev-2"
        })).resolves.toEqual({ status: "unknown", errorCode: "db_unavailable" });
    });

});
