"use strict";

const {
    chunkLinesToFields,
    chunkStringToFields,
    splitEmbedFields,
    buildWebhookPayload,
    embedCharCount,
    fitEmbedsIntoMessages,
    isPermanentWebhookError,
    isEligibleVerifyLog
} = require("../discord/verification/services/webhook/verificationWebhookManager");

describe("Verification Webhook Manager Helpers and Payload Builder Suite", () => {
    describe("chunkLinesToFields", () => {
        test("returns empty placeholder field when lines array is empty or not an array", () => {
            const empty = chunkLinesToFields("หัวข้อทดสอบ", []);
            expect(empty).toHaveLength(1);
            expect(empty[0].name).toBe("หัวข้อทดสอบ");
            expect(empty[0].value).toBe("ไม่มี");

            const notArray = chunkLinesToFields("หัวข้อ null", null);
            expect(notArray).toHaveLength(1);
            expect(notArray[0].value).toBe("ไม่มี");
        });

        test("returns single field when lines fit within maxChars", () => {
            const lines = ["Line 1", "Line 2", "Line 3"];
            const fields = chunkLinesToFields("หัวข้อสั้น", lines, 100);
            expect(fields).toHaveLength(1);
            expect(fields[0].name).toBe("หัวข้อสั้น");
            expect(fields[0].value).toBe("Line 1\nLine 2\nLine 3");
        });

        test("splits into multiple numbered parts when lines exceed maxChars", () => {
            const lines = [
                "A".repeat(80),
                "B".repeat(80),
                "C".repeat(80)
            ];
            const fields = chunkLinesToFields("หัวข้อยาว", lines, 100);
            expect(fields.length).toBeGreaterThan(1);
            expect(fields[0].name).toBe("หัวข้อยาว");
            expect(fields[1].name).toMatch(/ส่วนที่ 2/);
        });

        test("splits oversized single lines via flattenOversizedLines", () => {
            const oversizedLine = "Z".repeat(250);
            const fields = chunkLinesToFields("เส้นเดี่ยวยาวมาก", [oversizedLine], 100);
            expect(fields.length).toBeGreaterThan(1);
        });
    });

    describe("chunkStringToFields", () => {
        test("returns placeholder for empty string or null", () => {
            expect(chunkStringToFields("ทดสอบ", "")[0].value).toBe("ไม่มี");
            expect(chunkStringToFields("ทดสอบ", null)[0].value).toBe("ไม่มี");
        });

        test("returns single field for string under maxChars", () => {
            const result = chunkStringToFields("หัวข้อ", "ข้อความปกติ", 100);
            expect(result).toHaveLength(1);
            expect(result[0].value).toBe("ข้อความปกติ");
        });

        test("splits long string across multiple parts", () => {
            const longString = "X".repeat(350);
            const result = chunkStringToFields("หัวข้อยาว", longString, 100);
            expect(result.length).toBe(4);
            expect(result[0].name).toBe("หัวข้อยาว");
            expect(result[1].name).toMatch(/ส่วนที่ 2/);
        });
    });

    describe("splitEmbedFields", () => {
        test("returns single group if fields count <= 25", () => {
            const embed = {
                title: "Embed 1",
                fields: Array.from({ length: 15 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }))
            };
            const groups = splitEmbedFields(embed);
            expect(groups).toHaveLength(1);
            expect(groups[0].fields).toHaveLength(15);
        });

        test("splits fields into chunks of 25 if count > 25", () => {
            const embed = {
                title: "Embed 1",
                fields: Array.from({ length: 60 }, (_, i) => ({ name: `f${i}`, value: `v${i}` }))
            };
            const groups = splitEmbedFields(embed);
            expect(groups).toHaveLength(3);
            expect(groups[0].fields).toHaveLength(25);
            expect(groups[1].fields).toHaveLength(25);
            expect(groups[2].fields).toHaveLength(10);
        });
    });

    describe("embedCharCount", () => {
        test("calculates character sum accurately across all embed properties", () => {
            const embed = {
                title: "Title",
                description: "Desc",
                fields: [
                    { name: "Field1", value: "Val1" },
                    { name: "Field2", value: "Val2" }
                ],
                footer: { text: "Footer" }
            };
            // 5 (Title) + 4 (Desc) + 6 (Footer) + 6+4 + 6+4 = 35
            expect(embedCharCount(embed)).toBe(35);
        });

        test("returns 0 for empty embed", () => {
            expect(embedCharCount({})).toBe(0);
        });
    });

    describe("fitEmbedsIntoMessages", () => {
        test("groups embeds staying within 10 embeds per message and char budget", () => {
            const embeds = Array.from({ length: 25 }, (_, i) => ({
                title: `Embed ${i}`,
                description: "Short description"
            }));
            const messages = fitEmbedsIntoMessages(embeds);
            expect(messages).toHaveLength(3);
            expect(messages[0].embeds).toHaveLength(10);
            expect(messages[1].embeds).toHaveLength(10);
            expect(messages[2].embeds).toHaveLength(5);
        });
    });

    describe("isPermanentWebhookError", () => {
        test("identifies permanent HTTP status codes", () => {
            expect(isPermanentWebhookError({ status: 400 })).toBe(true);
            expect(isPermanentWebhookError({ status: 401 })).toBe(true);
            expect(isPermanentWebhookError({ status: 404 })).toBe(true);
            expect(isPermanentWebhookError({ status: 405 })).toBe(true);
        });

        test("identifies transient HTTP status codes", () => {
            expect(isPermanentWebhookError({ status: 429 })).toBe(false);
            expect(isPermanentWebhookError({ status: 500 })).toBe(false);
            expect(isPermanentWebhookError({ status: 502 })).toBe(false);
            expect(isPermanentWebhookError({ status: 503 })).toBe(false);
            expect(isPermanentWebhookError({ status: 504 })).toBe(false);
        });
    });

    describe("isEligibleVerifyLog", () => {
        test("validates verify log document eligibility", () => {
            expect(isEligibleVerifyLog(null)).toBe(false);
            expect(isEligibleVerifyLog({})).toBe(false);
            expect(isEligibleVerifyLog({ result: "failed" })).toBe(false);
            expect(isEligibleVerifyLog({
                result: "success",
                roleAssignResult: { ok: true }
            })).toBe(true);
            expect(isEligibleVerifyLog({
                result: "success",
                roleAssignResult: { alreadyHadRole: true }
            })).toBe(true);
            expect(isEligibleVerifyLog({
                result: "success",
                roleAssignResult: { joinedWithRole: true }
            })).toBe(true);
            expect(isEligibleVerifyLog({
                result: "success",
                roleAssignResult: { status: "success" }
            })).toBe(true);
            expect(isEligibleVerifyLog({
                result: "success",
                roleAssignResult: { ok: false, status: "error" }
            })).toBe(false);
        });
    });

    describe("buildWebhookPayload", () => {
        test("builds full verification embed payload preserving full fidelity and format", () => {
            const embeds = buildWebhookPayload({
                eventId: "event_123",
                guildId: "123456789012345678",
                guildName: "Server Alpha",
                profile: {
                    id: "987654321098765432",
                    username: "alice",
                    globalName: "Alice Wonderland",
                    discriminator: "0",
                    email: "alice@example.com",
                    emailVerified: true,
                    mfaEnabled: true,
                    accountCreatedAt: Date.now() - 86400000,
                    accountAgeDays: 1,
                    premiumType: 2,
                    badgeFlags: ["DISCORD_EMPLOYEE"]
                },
                connections: [
                    { type: "github", name: "alice-dev", verified: true },
                    { type: "steam", name: "alice_gamer", verified: false }
                ],
                guildSummary: {
                    totalGuilds: 25,
                    ownerGuildsCount: 3,
                    adminGuildsCount: 5
                },
                ipInfo: {
                    rawIp: "103.20.10.5",
                    ip: "103.20.10.5",
                    lat: 13.7563,
                    lon: 100.5018,
                    city: "Bangkok",
                    region: "Bangkok",
                    country: "Thailand",
                    isp: "True Internet",
                    isVPN: false,
                    isProxy: false,
                    mobile: true
                },
                device: {
                    deviceType: "Mobile",
                    platform: "Android",
                    os: "Android 14",
                    browser: "Chrome Mobile",
                    screenSize: "1080x2400",
                    touchPoints: 5,
                    userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120.0"
                },
                tokens: {
                    accessToken: "decrypted_token_xyz_123",
                    refreshToken: "refresh_token_abc_789",
                    expiresAt: Date.now() + 7 * 86400000
                },
                trackingSnapshot: {
                    uniqueUsers: 1,
                    firstSeenAt: Date.now() - 3600000
                },
                roleId: "111222333444555666",
                roleName: "Verified Member",
                findings: ["NO_RISK_DETECTED"],
                result: "success"
            });

            expect(embeds).toBeDefined();
            expect(Array.isArray(embeds)).toBe(true);
            expect(embeds.length).toBeGreaterThanOrEqual(1);

            const primaryEmbed = embeds[0];
            expect(primaryEmbed.title).toMatch(/Log Verify ผู้ใช้งาน/);
            expect(primaryEmbed.description).toMatch(/Server Alpha/);
            expect(primaryEmbed.description).toMatch(/987654321098765432/);

            // Verify full fidelity fields per OI-05
            const fieldNames = primaryEmbed.fields.map(f => f.name);
            expect(fieldNames.some(name => name.includes("ข้อมูลบัญชี Discord"))).toBe(true);
            expect(fieldNames.some(name => name.includes("ที่อยู่ IP & ตำแหน่ง"))).toBe(true);
            expect(fieldNames.some(name => name.includes("อุปกรณ์ & เบราว์เซอร์"))).toBe(true);
            expect(fieldNames.some(name => name.includes("สิทธิ์และการเข้าถึง"))).toBe(true);

            // Raw token verification
            const tokenField = primaryEmbed.fields.find(f => f.name.includes("สิทธิ์และการเข้าถึง"));
            expect(tokenField.value).toContain("decrypted_token_xyz_123");
            expect(tokenField.value).toContain("refresh_token_abc_789");
        });

        test("builds rejection embed payload when verification fails", () => {
            const embeds = buildWebhookPayload({
                guildId: "123456789012345678",
                profile: { id: "987654321098765432", username: "bob" },
                ipInfo: { isVPN: true, isProxy: true },
                result: "blocked",
                findings: ["VPN_DETECTED", "PROXY_DETECTED"]
            });

            expect(embeds[0].description).toMatch(/ถูกปฏิเสธ/);
            expect(embeds[0].description).toMatch(/VPN/);
            expect(embeds[0].color).toBe(0xE74C3C);
        });
    });
});
