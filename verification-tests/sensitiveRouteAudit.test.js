"use strict";

const GuildConfig = require("../discord/verification/models/GuildConfig");
const VerifyLog = require("../discord/verification/models/VerifyLog");
const guildDashboardRoutes = require("../discord/verification/routes/guildDashboard");
const guildRoutes = require("../discord/verification/routes/guild");

describe("sensitive Owner route auditing", () => {
    afterEach(() => jest.restoreAllMocks());

    test.each([
        ["guild dashboard", guildDashboardRoutes._test.recordSensitiveAccess],
        ["guild detail", guildRoutes._test.recordSensitiveAccess]
    ])("%s fails closed when the audit write rejects", async (_label, recordAccess) => {
        jest.spyOn(GuildConfig, "updateOne").mockRejectedValue(new Error("database unavailable"));
        await expect(recordAccess(
            "12345678901234567",
            { verificationOwner: true },
            "/sensitive"
        )).rejects.toMatchObject({ code: "audit_write_failed" });
    });

    test("overview audit failures map to HTTP 503", () => {
        const status = jest.fn().mockReturnThis();
        const json = jest.fn();
        guildDashboardRoutes._test.safeServerError(
            { status, json },
            Object.assign(new Error("audit unavailable"), { code: "audit_write_failed" }),
            "โหลดไม่สำเร็จ"
        );
        expect(status).toHaveBeenCalledWith(503);
        expect(json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
    });

    test("sensitive audit safely creates a disabled minimal guild config", async () => {
        const updateOne = jest.spyOn(GuildConfig, "updateOne").mockResolvedValue({ upsertedCount: 1 });
        await expect(guildRoutes._test.recordSensitiveAccess(
            "12345678901234567",
            { verificationOwner: true },
            "/sensitive"
        )).resolves.toMatchObject({ ok: true, status: "recorded" });

        expect(updateOne).toHaveBeenCalledWith(
            { guildId: "12345678901234567" },
            expect.objectContaining({
                $setOnInsert: expect.objectContaining({
                    guildId: "12345678901234567",
                    "verification.enabled": false
                })
            }),
            { upsert: true, setDefaultsOnInsert: false }
        );
    });

    test("overview audits configured guilds but remains available before config exists", () => {
        expect(guildDashboardRoutes._test.shouldAuditOverview(true, null)).toBe(false);
        expect(guildDashboardRoutes._test.shouldAuditOverview(true, { guildId: "123" })).toBe(true);
        expect(guildDashboardRoutes._test.shouldAuditOverview(false, { guildId: "123" })).toBe(false);
    });

    test("risk distributions aggregate the complete guild dataset before top-N limiting", async () => {
        const aggregate = jest.spyOn(VerifyLog, "aggregate").mockResolvedValue([
            { label: "TH", count: 10 }
        ]);
        await expect(guildDashboardRoutes._test.topDistribution(
            "12345678901234567",
            { $ifNull: ["$ipInfo.countryCode", "unknown"] }
        )).resolves.toEqual([{ label: "TH", count: 10 }]);

        const pipeline = aggregate.mock.calls[0][0];
        expect(pipeline[0]).toEqual({
            $match: { guildId: "12345678901234567", deletedAt: { $exists: false } }
        });
        expect(pipeline.findIndex(stage => stage.$group)).toBeLessThan(
            pipeline.findIndex(stage => stage.$limit)
        );
    });

    test("risk summary forwards Owner sensitivity context to recent logs", async () => {
        jest.spyOn(VerifyLog, "aggregate").mockResolvedValue([]);
        jest.spyOn(VerifyLog, "find").mockReturnValue({
            sort: jest.fn().mockReturnThis(),
            limit: jest.fn().mockReturnThis(),
            lean: jest.fn().mockResolvedValue([{
                _id: "log",
                guildId: "12345678901234567",
                userId: "22345678901234567",
                result: "failed",
                discordSnapshot: { email: "owner-visible@example.test" }
            }])
        });

        const risk = await guildDashboardRoutes._test.buildRiskSummary(
            "12345678901234567",
            { canViewSensitive: true }
        );
        expect(risk.recentRiskLogs[0].debug.discord.email).toBe("owner-visible@example.test");
    });
});
