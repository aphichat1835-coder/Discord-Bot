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
        })).resolves.toBe(true);
        await expect(guildRoutes._test.persistedPanelMatches("guild", {
            channelId: "1", messageId: "2", panelRevision: "rev-old"
        })).resolves.toBe(false);
    });

    test("panel update route uses retry persistence and rolls Discord back on DB failure", () => {
        const fs = require("node:fs");
        const source = fs.readFileSync(require.resolve("../discord/verification/routes/guild"), "utf8");
        expect(source).toMatch(/await saveConfigWithRetry\(config\)/);
        expect(source).toMatch(/persistedPanelMatches\(guildId, verification\)/);
        expect(source).toMatch(/const previousPanelPayload = panelRollbackPayload\(existing\.message\)/);
        expect(source).toMatch(/rollbackDiscordPanel\(channelId, messageId, previousPanelPayload\)/);
        expect(source).toMatch(/recoveryRequired: !rollback\.complete/);
        expect(source).toMatch(/persistedPanelMatches\(sentPanel\.guildId, sentPanel\)/);
        expect(source).toMatch(/code: "panel_send_cleanup_failed"/);
    });
});
