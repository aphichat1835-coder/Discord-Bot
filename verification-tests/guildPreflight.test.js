"use strict";

const { runGuildPreflight } = require("../discord/verification/services/guildPreflightService");

describe("verification guild preflight", () => {
    test("reports Discord fetch failures instead of treating empty arrays as success", async () => {
        const preflight = await runGuildPreflight({
            guildId: "123",
            guild: { id: "123", name: "Guild" },
            config: {
                verification: {
                    enabled: true,
                    roleId: "456",
                    channelId: "789"
                }
            },
            env: {
                DISCORD_CLIENT_ID: "client",
                DISCORD_CLIENT_SECRET: "secret",
                PUBLIC_BASE_URL: "https://example.test",
                VERIFY_STATE_SECRET: "state",
                ENCRYPTION_KEY: "encryption"
            },
            discord: {
                getGuildRoles: jest.fn().mockRejectedValue(new Error("discord_http_403")),
                getGuildChannels: jest.fn().mockResolvedValue([{ id: "789" }])
            }
        });

        expect(preflight.ok).toBe(false);
        expect(preflight.checks.find(check => check.key === "roles_fetch")).toMatchObject({
            ok: false,
            detail: "discord_http_403"
        });
        expect(preflight.checks.find(check => check.key === "channels_fetch")).toMatchObject({ ok: true });
    });
});
