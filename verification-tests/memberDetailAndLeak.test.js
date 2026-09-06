"use strict";

const fs = require("node:fs");
const { serializeMemberDetail } = require("../discord/verification/serializers/memberDetailSerializer");
const verifiedMemberService = require("../discord/verification/services/verifiedMemberService");
const snapshotBudget = require("../discord/verification/services/snapshotBudget");

describe("member detail serialization and leak guards", () => {
    test("owner member detail exposes full network metadata but not encrypted credential storage", () => {
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
                    accessToken: "raw-access-token",
                    refreshToken: "raw-refresh-token",
                    access_token: "raw-access-token-snake",
                    refresh_token: "raw-refresh-token-snake",
                    scope: "identify guilds.join",
                    expiresAt: 7000,
                    rawTokenMeta: { receivedAt: 1000 }
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
        expect(detail.oauthTokens.oauth.issuedAt).toBe(1000);
        expect(detail.oauthTokens.oauth.expiresAt).toBe(7000);
        expect(detail.oauthTokens.oauth.lifetimeMs).toBe(6000);

        const serialized = JSON.stringify(detail);
        expect(serialized).not.toContain("encrypted-access");
        expect(serialized).not.toContain("encrypted-refresh");
        expect(serialized).not.toContain("raw-access-token");
        expect(serialized).not.toContain("raw-refresh-token");
        expect(serialized).not.toContain("access_token");
        expect(serialized).not.toContain("refresh_token");
        expect(serialized).not.toContain("encrypted-ip");
        expect(serialized).toContain("203.0.113.10");
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
        expect(detail.oauthTokens).toEqual({ oauth: null, adminOAuth: null });
    });

    test("legacy verified member serializer marks OAuthUser-only records as read-only legacy", () => {
        const member = verifiedMemberService._test.fromOAuthUser({
            discord: { userId: "user", username: "legacy", email: "legacy@example.test" },
            lastVerify: { guildId: "guild", result: "success", verifiedAt: 1000 },
            connections: [{ type: "steam" }],
            guilds: [{ id: "guild" }]
        });

        expect(member.source).toBe("oauth_user_last_verify");
        expect(member.status).toBe("legacy_verified");
        expect(member.canSyncRole).toBe(false);
        expect(member.connectionsCount).toBe(1);
        expect(member.guildsCount).toBe(1);
        expect(member.email).toBeNull();
        expect(member.connections).toEqual([]);
        expect(member.guilds).toEqual([]);
    });

    test("legacy verified member serializer can include sensitive fields for detail-only owner views", () => {
        const member = verifiedMemberService._test.fromOAuthUser({
            discord: { userId: "user", username: "legacy", email: "legacy@example.test" },
            connections: [{ type: "steam" }],
            guilds: [{ id: "guild" }]
        }, true);

        expect(member.email).toBe("legacy@example.test");
        expect(member.connections).toHaveLength(1);
        expect(member.guilds).toHaveLength(1);
    });

    test("member merge keeps fallback badges when the primary list is empty", () => {
        const merged = verifiedMemberService._test.mergeMembers(
            { userId: "user", badgeFlags: [] },
            { userId: "user", badgeFlags: ["HYPESQUAD"] },
            true
        );
        expect(merged.badgeFlags).toEqual(["HYPESQUAD"]);
    });

    test("list serializer never returns full legacy guild or connection snapshots", () => {
        const member = verifiedMemberService._test.listSafeMember({
            userId: "123",
            connectionsCount: 2,
            guildsCount: 3,
            connections: [{ type: "github", name: "private" }],
            guilds: [{ id: "456", name: "private" }]
        });

        expect(member.connections).toBeUndefined();
        expect(member.guilds).toBeUndefined();
        expect(member.connectionsCount).toBe(2);
        expect(member.guildsCount).toBe(3);
        expect(member.detailsAvailable).toBe(true);
        expect(member.sensitiveRedacted).toBe(true);
    });

    test("member aggregation paginates after database-side union and deduplication", () => {
        const pipeline = verifiedMemberService._test.verifiedMemberAggregation("123", {
            page: 2,
            limit: 25,
            includeLegacy: true
        });
        expect(pipeline.some(stage => stage.$unionWith)).toBe(true);
        expect(pipeline.at(-1)).toEqual(expect.objectContaining({
            $facet: expect.objectContaining({
                rows: [{ $skip: 50 }, { $limit: 25 }]
            })
        }));
        expect(pipeline.slice(0, -1).some(stage => stage.$limit)).toBe(false);
    });

    test("empty capped member pages never advertise another page", () => {
        expect(verifiedMemberService._test.hasMoreMembers(0, 25, false, true)).toBe(false);
        expect(verifiedMemberService._test.hasMoreMembers(25, 25, false, true)).toBe(true);
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

    test("snapshot budget makes a too-small configured limit explicit", () => {
        const warning = jest.spyOn(process, "emitWarning").mockImplementation(() => {});
        expect(snapshotBudget.resolveDefaultMaxBytes(1024)).toBe(snapshotBudget.MIN_MAX_BYTES);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("below the safe minimum"),
            expect.objectContaining({ code: "VERIFICATION_SNAPSHOT_MAX_BYTES_FLOORED" })
        );
    });

    test("snapshot budget caps an unsafe oversized configured limit", () => {
        const warning = jest.spyOn(process, "emitWarning").mockImplementation(() => {});
        expect(snapshotBudget.resolveDefaultMaxBytes(snapshotBudget.MAX_MAX_BYTES * 10))
            .toBe(snapshotBudget.MAX_MAX_BYTES);
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining("exceeds the safe maximum"),
            expect.objectContaining({ code: "VERIFICATION_SNAPSHOT_MAX_BYTES_CAPPED" })
        );
    });

    test("snapshot budget preserves configured values inside the safe range", () => {
        const configured = 2 * 1024 * 1024;
        expect(snapshotBudget.resolveDefaultMaxBytes(configured)).toBe(configured);
    });

    test("snapshot budget defaults invalid or missing values to 12 MB", () => {
        expect(snapshotBudget.resolveDefaultMaxBytes(undefined)).toBe(snapshotBudget.MAX_MAX_BYTES);
        expect(snapshotBudget.resolveDefaultMaxBytes("not-a-number")).toBe(snapshotBudget.MAX_MAX_BYTES);
        expect(snapshotBudget.resolveDefaultMaxBytes(0)).toBe(snapshotBudget.MAX_MAX_BYTES);
    });

    test("dashboard only presents Nitro after identify.premium was granted", () => {
        const source = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");

        expect(source).toContain('scopes.includes("identify.premium")');
        expect(source).toContain('account.premiumType != null');
        expect(source).toContain('Nitro Basic');
    });

    test("dashboard member detail renders connection, guild permission, and token metadata", () => {
        const source = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");

        expect(source).toContain('"Account ID"');
        expect(source).toContain('"Metadata"');
        expect(source).toContain('"Permission bitfield"');
        expect(source).toContain('"สิทธิ์ที่พบ"');
        expect(source).toContain("Admin OAuth access/refresh");
        expect(source).toContain("Join result");
        expect(source).toContain("Role assignment");
        expect(source).toContain("function roleChipElement");
        expect(source).toContain("คลิกเพื่อคัดลอก Role ID");
        expect(source).toContain("อายุ Token ปัจจุบัน");
        expect(source).toContain("เวลาคงเหลือ");
        expect(source).toContain("Snapshot ล่าสุดจากตอนยืนยัน");
        expect(source).toContain('"User-Agent"');
        expect(source).toContain("User-Agent อาจถูกปลอมแปลง");
        expect(source).toContain("แหล่งข้อมูลที่ตรวจ");
        expect(source).toContain("รัศมีความคลาดเคลื่อน");
        expect(source).toContain("ความมั่นใจตำแหน่ง");
        expect(source).toContain("เหตุผลการประเมิน");
        expect(source).toContain("ตำแหน่งนี้เป็นตำแหน่งทางออกของเครือข่าย");
        expect(source).toContain("securitySignalsAvailable === false");
        expect(source).toContain('createElement("button", "btn btn-soft btn-sm btn-inline", "ซ่อน")');
    });

    test("dashboard has an owner-only OAuth recovery center without messaging members", () => {
        const page = fs.readFileSync("discord/verification/guildPage.js", "utf8");
        const source = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");

        expect(page).toContain('id="oauth-recovery-count"');
        expect(page).toContain('id="btn-oauth-recovery-revoke-all"');
        expect(source).toContain("/oauth-recovery");
        expect(source).toContain("/revoke-role");
        expect(source).toContain("/revoke-all-roles");
        expect(page).toContain("จะไม่ส่ง DM หรือข้อความแจ้งสมาชิก");
    });

    test("dashboard log table and detail modal avoid HTML injection sinks", () => {
        const source = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");
        const markers = [
            "async function loadLogs",
            "function openDetailModal",
            "function closeDetailModal",
            "function renderEmbedPreview",
            "function bindPreviewInputs"
        ];
        for (const marker of markers) expect(source.indexOf(marker)).toBeGreaterThan(-1);
        const loadLogsSource = source.slice(
            source.indexOf("async function loadLogs"),
            source.indexOf("function openDetailModal")
        );
        const modalSource = source.slice(
            source.indexOf("function openDetailModal"),
            source.indexOf("function closeDetailModal")
        );
        const previewSource = source.slice(
            source.indexOf("function renderEmbedPreview"),
            source.indexOf("function bindPreviewInputs")
        );
        expect(loadLogsSource).not.toContain("innerHTML");
        expect(loadLogsSource).toContain("replaceChildren");
        expect(modalSource).not.toContain("innerHTML");
        expect(modalSource).toContain("replaceChildren");
        expect(previewSource).not.toContain("innerHTML");
        expect(previewSource).toContain("replaceChildren");
    });

    test("dashboard avoids HTML injection sinks globally and constrains API requests", () => {
        const source = fs.readFileSync("discord/verification/public/js/guild-dashboard.js", "utf8");

        expect(source).not.toMatch(/\b(?:innerHTML|outerHTML)\b|document\.write/);
        expect(source).toContain('target.origin !== window.location.origin');
        expect(source).toContain('target.pathname.startsWith("/api/guild/")');
        expect(source).toContain("const safePath = `${target.pathname}${target.search}`");
    });
});
