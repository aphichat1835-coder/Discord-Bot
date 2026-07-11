"use strict";

const GuildConfig = require("../discord/verification/models/GuildConfig");
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
});
