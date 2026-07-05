"use strict";

const { serializeMemberDetail } = require("../discord/verification/serializers/memberDetailSerializer");
const verifiedMemberService = require("../discord/verification/services/verifiedMemberService");
const snapshotBudget = require("../discord/verification/services/snapshotBudget");

describe("member detail serialization and leak guards", () => {
    test("normal member detail exposes rich metadata but not raw or encrypted secrets", () => {
        const detail = serializeMemberDetail({
            guildId: "guild",
            userId: "user",
            oauthUser: {
                discord: {
                    userId: "user",
                    username: "name",
                    email: "owner@example.test",
                    badgeFlags: ["HYPESQUAD"]
                },
                oauth: {
                    encryptedAccessToken: "encrypted-access",
                    encryptedRefreshToken: "encrypted-refresh",
                    scope: "identify guilds.join"
                },
                connections: [{ type: "github", name: "octo", verified: true }],
                guilds: [{ id: "guild", name: "Guild", permissions: "8", owner: true }],
                lastVerify: { guildId: "guild", result: "success" }
            },
            latestLog: {
                guildId: "guild",
                userId: "user",
                result: "success",
                ipInfo: {
                    rawIp: "203.0.113.10",
                    encryptedRawIp: "encrypted-ip",
                    isp: "Example ISP"
                }
            },
            canViewSensitive: true
        });

        expect(detail.identity.username).toBe("name");
        expect(detail.connections).toHaveLength(1);
        expect(detail.guilds).toHaveLength(1);
        expect(detail.oauthTokens.oauth.hasAccessToken).toBe(true);
        expect(detail.oauthTokens.oauth.scope).toBe("identify guilds.join");

        const serialized = JSON.stringify(detail);
        expect(serialized).not.toContain("encrypted-access");
        expect(serialized).not.toContain("encrypted-refresh");
        expect(serialized).not.toContain("encrypted-ip");
        expect(serialized).not.toContain("203.0.113.10");
    });

    test("member detail redacts email, connections, and guilds when sensitive view is disabled", () => {
        const detail = serializeMemberDetail({
            guildId: "guild",
            userId: "user",
            oauthUser: {
                discord: {
                    userId: "user",
                    username: "name",
                    email: "owner@example.test"
                },
                connections: [{ type: "github", name: "octo", verified: true }],
                guilds: [{ id: "guild", name: "Guild", permissions: "8", owner: true }]
            },
            latestLog: null,
            canViewSensitive: false
        });

        expect(detail.sensitiveRedacted).toBe(true);
        expect(detail.identity.email).toBeNull();
        expect(detail.account.email).toBeNull();
        expect(detail.connections).toEqual([]);
        expect(detail.guilds).toEqual([]);
    });

    test("legacy verified member serializer marks OAuthUser-only records as read-only legacy", () => {
        const member = verifiedMemberService._test.fromOAuthUser({
            discord: { userId: "user", username: "legacy" },
            lastVerify: { guildId: "guild", result: "success", verifiedAt: 1000 },
            connections: [{ type: "steam" }],
            guilds: [{ id: "guild" }]
        });

        expect(member.source).toBe("oauth_user_last_verify");
        expect(member.status).toBe("legacy_verified");
        expect(member.canSyncRole).toBe(false);
        expect(member.connectionsCount).toBe(1);
        expect(member.guildsCount).toBe(1);
    });

    test("snapshot budget reports payload too large without mutating caller data", () => {
        const payload = { data: "x".repeat(128) };
        expect(() => snapshotBudget.assertSnapshotBudget(payload, { maxBytes: 20 })).toThrow(/payload too large/);
        expect(snapshotBudget.failureMeta({ code: "payload_too_large", bytes: 128, maxBytes: 20 })).toMatchObject({
            status: "failed",
            truncated: true,
            failureReason: "payload_too_large"
        });
    });
});
