"use strict";

const fs = require("node:fs");
const oauthRoute = require("../discord/verification/routes/oauth");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const VerifyLog = require("../discord/verification/models/VerifyLog");
const snapshotStore = require("../discord/verification/services/oauthSnapshotStore");
const snapshots = require("../discord/verification/utils/verificationSnapshots");
const {
    extractDevice,
    compactLookupRaw,
    _test: ipUtilsTest
} = require("../discord/verification/utils/ipUtils");

const {
    decodeUserBadgeFlags,
    normalizeConnections,
    normalizeGuilds,
    compactMemberInfo,
    compactDiscordProfile,
    saveOAuthUserSafe,
    saveVerifyLogSafe,
    safeNullableString,
    sanitizeDiscordPayload,
    memberFetchQualityStatus
} = oauthRoute._test;

describe("unified verification data contract", () => {
    test("stores every returned connection without arbitrary truncation", () => {
        const input = Array.from({ length: 75 }, (_, index) => ({
            type: "service",
            id: String(index),
            name: `account-${index}`,
            verified: index % 2 === 0,
            visibility: 1
        }));
        expect(normalizeConnections(input)).toHaveLength(75);
    });

    test("preserves future Discord fields while redacting token-shaped fields", () => {
        const sanitized = sanitizeDiscordPayload({
            id: "123456789012345678",
            future_profile_field: { enabled: true, label: "value\u0000" },
            access_token: "must-not-persist",
            accessToken: "must-not-persist-camel-case",
            nested: {
                refresh_token: "must-not-persist-either",
                token: "must-not-persist-generic-token"
            }
        });

        expect(sanitized.future_profile_field).toEqual({ enabled: true, label: "value" });
        expect(sanitized.access_token).toBe("[stored-encrypted-separately]");
        expect(sanitized.accessToken).toBe("[stored-encrypted-separately]");
        expect(sanitized.nested.refresh_token).toBe("[stored-encrypted-separately]");
        expect(sanitized.nested.token).toBe("[stored-encrypted-separately]");
        expect(JSON.stringify(sanitized)).not.toContain("must-not-persist");
    });

    test("keeps all connection integrations and accepted metadata", () => {
        const integrations = Array.from({ length: 30 }, (_, index) => ({
            id: String(index),
            label: `integration-${index}`
        }));
        const metadata = { value: "x".repeat(12 * 1024) };
        const [connection] = normalizeConnections([{
            type: "service",
            id: "account",
            name: "account",
            integrations,
            metadata
        }]);
        expect(connection.integrations).toHaveLength(30);
        expect(connection.metadata.value).toHaveLength(12 * 1024);
    });

    test("stores all 200 Discord user guilds with permission metadata", () => {
        const input = Array.from({ length: 200 }, (_, index) => ({
            id: String(10000000000000000n + BigInt(index)),
            name: `guild-${index}`,
            owner: index === 0,
            permissions: index === 0 ? "8" : "0",
            features: []
        }));
        const guilds = normalizeGuilds(input);
        expect(guilds).toHaveLength(200);
        expect(guilds[0]).toMatchObject({
            owner: true,
            isOwner: true,
            isAdmin: true
        });
    });

    test("stores more than 80 target-guild roles without truncation", () => {
        const roles = Array.from({ length: 125 }, (_, index) => String(index + 1));
        const member = compactMemberInfo({
            user: { id: "12345678901234567" },
            roles
        });
        expect(member.roles).toEqual(roles);
        expect(member.roleCount).toBe(125);
    });

    test("decodes Discord badge flags while preserving raw flags", () => {
        const profile = {
            id: "12345678901234567",
            flags: (1 << 0) | (1 << 17),
            public_flags: (1 << 0) | (1 << 17)
        };
        expect(decodeUserBadgeFlags(profile)).toEqual(["STAFF", "VERIFIED_DEVELOPER"]);
        expect(compactDiscordProfile(profile)).toMatchObject({
            flags: profile.flags,
            publicFlags: profile.public_flags,
            badgeFlags: ["STAFF", "VERIFIED_DEVELOPER"]
        });
    });

    test("preserves unavailable global name as null and valid zero-valued Discord fields", () => {
        expect(compactDiscordProfile({
            id: "12345678901234567",
            username: "modern",
            discriminator: "0",
            global_name: null,
            accent_color: 0,
            premium_type: 0
        })).toMatchObject({
            globalName: null,
            accentColor: 0,
            premiumType: 0
        });
    });

    test("safe nullable strings enforce caller-provided length limits", () => {
        expect(safeNullableString("abcdef", 3)).toBe("abc");
        expect(safeNullableString("a\u0000b\u007Fc", 10)).toBe("abc");
        expect(safeNullableString("", 3)).toBeNull();
    });

    test("member fetch data quality status is per-attempt and explicit", () => {
        expect(memberFetchQualityStatus({ memberFetchAttempted: false }, null)).toBe("not_attempted");
        expect(memberFetchQualityStatus({ memberFetchAttempted: true }, { roles: [] })).toBe("success");
        expect(memberFetchQualityStatus({ memberFetchAttempted: true }, null)).toBe("failed");
    });

    test("schemas retain encrypted tokens, encrypted IP, and additive quality fields", () => {
        expect(OAuthUser.schema.path("oauth.encryptedAccessToken")).toBeDefined();
        expect(OAuthUser.schema.path("oauth.encryptedRefreshToken")).toBeDefined();
        expect(OAuthUser.schema.path("snapshotMeta")).toBeDefined();
        expect(OAuthUser.schema.path("discord.badgeFlags")).toBeDefined();
        expect(VerifyLog.schema.path("ipInfo.encryptedRawIp")).toBeDefined();
        expect(VerifyLog.schema.path("dataQuality")).toBeDefined();
        expect(VerifyLog.schema.path("sensitiveAccessLog")).toBeDefined();
    });

    test("failed optional fetches update quality only and do not write empty snapshots", async () => {
        const previousStore = process.env.STORE_OAUTH_TOKENS;
        process.env.STORE_OAUTH_TOKENS = "false";
        const query = {
            where: jest.fn(),
            equals: jest.fn(),
            select: jest.fn(),
            lean: jest.fn().mockResolvedValue({
                    snapshotRefs: {
                        connections: { version: "old-connections", complete: true },
                        guilds: { version: "old-guilds", complete: true },
                        member: { version: "old-member", complete: true }
                    },
                    snapshotMeta: {
                        connections: { fetchedAt: 10, storedCount: 4 },
                        guilds: { fetchedAt: 20, storedCount: 8 },
                        member: { fetchedAt: 30, storedCount: 1 }
                    }
            })
        };
        query.where.mockReturnValue(query);
        query.equals.mockReturnValue(query);
        query.select.mockReturnValue(query);
        const findOne = jest.spyOn(OAuthUser, "findOne").mockReturnValue(query);
        const write = jest.spyOn(OAuthUser, "findOneAndUpdate").mockResolvedValue({});
        jest.spyOn(snapshotStore, "storeOAuthSnapshots").mockResolvedValue({
            version: "new-profile",
            profile: {
                kind: "profile", version: "new-profile", returnedCount: 1,
                storedCount: 1, chunkCount: 1, complete: true
            }
        });
        try {
            await saveOAuthUserSafe({
                profile: {
                    id: "12345678901234567",
                    username: "test",
                    discriminator: "0"
                },
                tokenData: {},
                connections: [],
                guilds: [],
                memberInfo: null,
                guildId: "76543210987654321",
                roleId: "76543210987654322",
                result: "failed",
                riskScore: 0,
                riskFlags: [],
                trackingSnapshot: null,
                fetchMetadata: {
                    connectionsFetchFailed: true,
                    connectionsFailureReason: "discord_http_503",
                    guildsFetchFailed: true,
                    guildsFailureReason: "discord_request_timeout",
                    memberFetchAttempted: true,
                    memberFetchFailed: true,
                    memberFailureReason: "discord_http_404",
                    memberFetchSource: "discord_oauth"
                }
            });
            expect(findOne).toHaveBeenCalled();
            const set = write.mock.calls[0][1].$set;
            expect(Object.hasOwn(set, "connections")).toBe(false);
            expect(Object.hasOwn(set, "guilds")).toBe(false);
            expect(Object.hasOwn(set, "lastMember")).toBe(false);
            expect(set.snapshotRefs).toMatchObject({
                connections: { version: "old-connections", complete: true },
                guilds: { version: "old-guilds", complete: true },
                member: { version: "old-member", complete: true }
            });
            expect(set.snapshotMeta.connections).toMatchObject({
                status: "failed",
                fetchedAt: 10,
                storedCount: 4,
                failureReason: "discord_http_503"
            });
            expect(set.snapshotMeta.guilds).toMatchObject({
                status: "failed",
                fetchedAt: 20,
                storedCount: 8,
                failureReason: "discord_request_timeout"
            });
            expect(set.snapshotMeta.member).toMatchObject({
                status: "failed",
                fetchedAt: 30,
                storedCount: 1,
                failureReason: "discord_http_404"
            });
        } finally {
            jest.restoreAllMocks();
            if (previousStore === undefined) delete process.env.STORE_OAUTH_TOKENS;
            else process.env.STORE_OAUTH_TOKENS = previousStore;
        }
    });

    test("completed chunk references survive an OAuthUser core write failure", async () => {
        const previousStore = process.env.STORE_OAUTH_TOKENS;
        process.env.STORE_OAUTH_TOKENS = "false";
        const query = {
            where: jest.fn().mockReturnThis(),
            equals: jest.fn().mockReturnThis(),
            select: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue({ snapshotMeta: {}, snapshotRefs: {} })
        };
        jest.spyOn(OAuthUser, "findOne").mockReturnValue(query);
        jest.spyOn(OAuthUser, "findOneAndUpdate").mockRejectedValue(new Error("core write failed"));
        jest.spyOn(snapshotStore, "storeOAuthSnapshots").mockResolvedValue({
            version: "v-complete",
            guilds: {
                kind: "guilds", version: "v-complete", returnedCount: 1,
                storedCount: 1, chunkCount: 1, complete: true
            },
            connections: {
                kind: "connections", version: "v-complete", returnedCount: 1,
                storedCount: 1, chunkCount: 1, complete: true
            }
        });
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});

        try {
            const result = await saveOAuthUserSafe({
                profile: { id: "12345678901234567", username: "test", discriminator: "0" },
                tokenData: {},
                connections: [{ type: "github", id: "1" }],
                guilds: [{ id: "76543210987654321", name: "Guild", permissions: "8" }],
                memberInfo: null,
                guildId: "76543210987654321",
                roleId: "76543210987654322",
                result: "success",
                riskScore: 0,
                riskFlags: [],
                trackingSnapshot: null,
                fetchMetadata: {}
            });

            expect(result.saved).toBe(false);
            expect(result.snapshotVersion).toBe("v-complete");
            expect(result.snapshotRefs.guilds.complete).toBe(true);
            expect(result.snapshotRefs.connections.complete).toBe(true);
            expect(errorLog).toHaveBeenCalled();
        } finally {
            jest.restoreAllMocks();
            if (previousStore === undefined) delete process.env.STORE_OAUTH_TOKENS;
            else process.env.STORE_OAUTH_TOKENS = previousStore;
        }
    });

    test("VerifyLog stores core audit fields and chunk references instead of large arrays", async () => {
        const create = jest.spyOn(VerifyLog, "create").mockResolvedValue({});
        try {
            await saveVerifyLogSafe({
                guildId: "guild",
                userId: "user",
                result: "success",
                snapshotVersion: "version-1",
                snapshotRef: {
                    version: "version-1",
                    connections: { version: "version-1", storedCount: 1, complete: true },
                    guilds: { version: "version-1", storedCount: 1, complete: true }
                },
                discordSnapshot: {
                    userId: "user",
                    username: "test",
                    connections: [{ metadata: { value: "x".repeat(13 * 1024 * 1024) } }],
                    guilds: [{ name: "guild" }]
                },
                dataQuality: {}
            });
            expect(create).toHaveBeenCalledTimes(1);
            const saved = create.mock.calls[0][0];
            expect(saved.discordSnapshot.connections).toBeUndefined();
            expect(saved.discordSnapshot.guilds).toBeUndefined();
            expect(saved.discordSnapshot.connectionsCount).toBe(1);
            expect(saved.discordSnapshot.guildsCount).toBe(1);
            expect(saved.snapshotVersion).toBe("version-1");
            expect(saved.snapshotRef.connections.complete).toBe(true);
        } finally {
            jest.restoreAllMocks();
        }
    });

    test("normal member detail serializer does not expose encrypted or raw OAuth tokens", () => {
        const { serializeMemberDetail } = require("../discord/verification/serializers/memberDetailSerializer");
        const detail = serializeMemberDetail({
            guildId: "guild",
            userId: "user",
            oauthUser: {
                discord: { userId: "user" },
                oauth: {
                    encryptedAccessToken: "encrypted-access",
                    encryptedRefreshToken: "encrypted-refresh",
                    scope: "identify guilds.join"
                }
            }
        });
        const serialized = JSON.stringify(detail);
        expect(serialized).not.toContain("encrypted-access");
        expect(serialized).not.toContain("encrypted-refresh");
        expect(serialized).not.toContain("access_token");
        expect(detail.oauthTokens.oauth.hasAccessToken).toBe(true);
    });

    test("normal owner serializers never decrypt or expose raw IP", () => {
        const serialized = snapshots.buildVerifyLogCommon(
            snapshots.buildVerifyLogParts({
                ipInfo: {
                    rawIp: "203.0.113.10",
                    ip: "203.0.113.10",
                    encryptedRawIp: "encrypted"
                }
            }, true),
            { canViewSensitive: true }
        );
        expect(serialized.rawIp).toBeNull();
        expect(serialized.ip).toBeNull();
        expect(serialized.ipInfo.rawIp).toBeNull();
    });

    test("normal serializers retain all returned guilds, connections, and member roles", () => {
        const connections = Array.from({ length: 75 }, (_, i) => ({ id: String(i) }));
        const guilds = Array.from({ length: 200 }, (_, i) => ({ id: String(i) }));
        const roles = Array.from({ length: 125 }, (_, i) => String(i));
        const discord = snapshots.safeDiscordSnapshot({ connections, guilds }, true);
        const member = snapshots.safeMemberSnapshot({ roles });
        expect(discord.connections).toHaveLength(75);
        expect(discord.guilds).toHaveLength(200);
        expect(member.roles).toHaveLength(125);
    });

    test("bounds the untrusted browser language list", () => {
        const previousEncryptionKey = process.env.ENCRYPTION_KEY;
        const previousApiSecret = process.env.API_SECRET;
        process.env.ENCRYPTION_KEY = "device-contract-test-key-at-least-32-bytes";
        process.env.API_SECRET = "device-contract-test-api-secret";
        const languages = Array.from({ length: 40 }, (_, index) => `lang-${index}`);
        try {
            const device = extractDevice({
                headers: { "user-agent": "Mozilla/5.0", "accept-language": "th" },
                body: { languages },
                socket: {}
            });
            expect(device.languages).toEqual(languages.slice(0, 8));
        } finally {
            if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
            else process.env.ENCRYPTION_KEY = previousEncryptionKey;
            if (previousApiSecret === undefined) delete process.env.API_SECRET;
            else process.env.API_SECRET = previousApiSecret;
        }
    });

    test("retains provider payload fields while redacting duplicate plaintext IP", () => {
        const raw = compactLookupRaw({
            provider: "provider.example",
            status: "success",
            raw: {
                query: "203.0.113.25",
                country: "Thailand",
                regionName: "Bangkok",
                customNested: {
                    confidence: 0.91,
                    note: "source 203.0.113.25"
                }
            }
        }, "203.0.113.25");
        expect(raw.response).toMatchObject({
            query: "[stored-encrypted-separately]",
            country: "Thailand",
            regionName: "Bangkok",
            customNested: {
                confidence: 0.91,
                note: "source [redacted-ip]"
            }
        });
        expect(JSON.stringify(raw)).not.toContain("203.0.113.25");
    });

    test("source/header IP metadata stores hashes instead of plaintext", () => {
        const previousEncryptionKey = process.env.ENCRYPTION_KEY;
        const previousApiSecret = process.env.API_SECRET;
        process.env.ENCRYPTION_KEY = "header-hash-test-key-at-least-32-bytes";
        process.env.API_SECRET = "header-hash-test-api-secret";
        try {
            const stored = ipUtilsTest.storedHeaderIpMetadata({
                cfConnectingIp: "203.0.113.25",
                trueClientIp: "198.51.100.8",
                xRealIp: "192.0.2.4",
                xClientIp: null,
                xForwardedForFirst: "203.0.113.90",
                xForwardedForChainLength: 2
            });

            expect(stored.cfConnectingIpHash).toEqual(expect.any(String));
            expect(stored.trueClientIpHash).toEqual(expect.any(String));
            expect(stored.xRealIpHash).toEqual(expect.any(String));
            expect(stored.xForwardedForFirstHash).toEqual(expect.any(String));
            expect(stored.xForwardedForChainLength).toBe(2);
            expect(JSON.stringify(stored)).not.toContain("203.0.113.25");
            expect(JSON.stringify(stored)).not.toContain("198.51.100.8");
        } finally {
            if (previousEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
            else process.env.ENCRYPTION_KEY = previousEncryptionKey;
            if (previousApiSecret === undefined) delete process.env.API_SECRET;
            else process.env.API_SECRET = previousApiSecret;
        }
    });
});
