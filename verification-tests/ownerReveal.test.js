"use strict";

const VerifyLog = require("../discord/verification/models/VerifyLog");
const cryptoUtils = require("../discord/verification/utils/crypto");
const ownerService = require("../discord/verification/ownerService");

describe("audited Owner raw-IP reveal", () => {
    const previousKey = process.env.ENCRYPTION_KEY;

    beforeAll(() => {
        process.env.ENCRYPTION_KEY = "owner-reveal-test-key-at-least-32-bytes";
    });

    afterAll(() => {
        if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = previousKey;
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("requires a non-empty reason before querying data", async () => {
        const find = jest.spyOn(VerifyLog, "findOne");
        await expect(ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: " "
        })).rejects.toMatchObject({ code: "reason_required" });
        expect(find).not.toHaveBeenCalled();
    });

    test("rejects an oversized reason instead of silently truncating audit data", async () => {
        await expect(ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: "x".repeat(501)
        })).rejects.toMatchObject({ code: "reason_too_long" });
    });

    test("decrypts only for the response and appends an audit event", async () => {
        const encryptedRawIp = cryptoUtils.encryptIP("203.0.113.25");
        jest.spyOn(VerifyLog, "findOne").mockReturnValue({
            sort: jest.fn().mockResolvedValue({
                _id: "log-id",
                ipInfo: {
                    encryptedRawIp,
                    country: "Thailand",
                    countryCode: "TH",
                    city: "Bangkok",
                    isp: "Example",
                    isVPN: false,
                    isProxy: false,
                    isTOR: false,
                    hosting: false
                }
            })
        });
        const update = jest.spyOn(VerifyLog, "updateOne").mockResolvedValue({
            modifiedCount: 1
        });

        const result = await ownerService.revealRawIp({
            guildId: "guild",
            userId: "user",
            reason: "investigate duplicate account",
            actor: "owner-dashboard"
        });

        expect(result.rawIp).toBe("203.0.113.25");
        expect(update).toHaveBeenCalledWith(
            { _id: "log-id" },
            {
                $push: {
                    sensitiveAccessLog: expect.objectContaining({
                        action: "owner_reveal_raw_ip",
                        actor: "owner-dashboard",
                        reason: "investigate duplicate account",
                        viewedAt: expect.any(Number)
                    })
                }
            }
        );
    });
});
