"use strict";

const { PermissionFlagsBits } = require("discord.js");
const discordAPI = require("../discord/verification/utils/discordAPI");

describe("Discord API Permissions and Channel Validation Helpers Suite", () => {
    describe("Permission BigInt conversion and checks", () => {
        test("toBigIntPermission handles numbers, strings, and falsy inputs", () => {
            expect(discordAPI.toBigIntPermission(null)).toBe(0n);
            expect(discordAPI.toBigIntPermission(undefined)).toBe(0n);
            expect(discordAPI.toBigIntPermission("")).toBe(0n);
            expect(discordAPI.toBigIntPermission(8)).toBe(8n);
            expect(discordAPI.toBigIntPermission("8")).toBe(8n);
            expect(discordAPI.toBigIntPermission("invalid_bits")).toBe(0n);
        });

        test("hasPermission checks bitwise inclusion", () => {
            const adminBits = PermissionFlagsBits.Administrator;
            const viewBits = PermissionFlagsBits.ViewChannel;

            // Direct match
            expect(discordAPI.hasPermission(adminBits, adminBits)).toBe(true);
            // Admin flag implicitly grants all permissions
            expect(discordAPI.hasPermission(adminBits, viewBits)).toBe(true);
            // Non-admin without permission
            expect(discordAPI.hasPermission(viewBits, adminBits)).toBe(false);
            expect(discordAPI.hasPermission(0n, viewBits)).toBe(false);
        });

        test("snowflake validates snowflake format", () => {
            expect(discordAPI.snowflake(null)).toBeNull();
            expect(discordAPI.snowflake("abc")).toBeNull();
            expect(discordAPI.snowflake("123456789012345678")).toBe("123456789012345678");
        });
    });

    describe("Role and Channel Normalization and Sorting", () => {
        test("normalizeRole and sortRolesForDashboard", () => {
            const roles = [
                { id: "1", name: "@everyone", position: 0 },
                { id: "2", name: "Member", position: 2 },
                { id: "3", name: "Admin", position: 5 }
            ];

            const sorted = discordAPI.sortRolesForDashboard(roles);
            expect(sorted).toHaveLength(3);
            expect(sorted[0].position).toBe(5);
            expect(sorted[1].position).toBe(2);
            expect(sorted[2].position).toBe(0);

            const normalized = discordAPI.normalizeRole(roles[1]);
            expect(normalized.id).toBe("2");
            expect(normalized.name).toBe("Member");
        });

        test("normalizeChannel and sortChannelsForDashboard", () => {
            const channels = [
                { id: "c1", name: "welcome", position: 1, type: 0 },
                { id: "c2", name: "verify", position: 0, type: 0 }
            ];
            const sorted = discordAPI.sortChannelsForDashboard(channels);
            expect(sorted).toHaveLength(2);
            expect(sorted[0].id).toBe("c2");
            expect(sorted[1].id).toBe("c1");
        });
    });

    describe("Permission Computation and Overwrites", () => {
        test("resolveMemberHighestRole finds role with greatest position", () => {
            const roles = [
                { id: "r1", name: "Role 1", position: 1 },
                { id: "r2", name: "Role 2", position: 10 },
                { id: "r3", name: "Role 3", position: 5 }
            ];
            const member = { roles: ["r1", "r3"] };
            const highest = discordAPI.resolveMemberHighestRole(member, roles);
            expect(highest.id).toBe("r3");

            expect(discordAPI.resolveMemberHighestRole(null, roles)).toBeNull();
        });

        test("computeMemberGuildPermissions combines roles bitwise", () => {
            const roles = [
                { id: "everyone", name: "@everyone", permissions: "1" },
                { id: "r1", name: "Role 1", permissions: "2" },
                { id: "r2", name: "Role 2", permissions: "4" }
            ];
            const member = { roles: ["r1", "r2"] };
            const combined = discordAPI.computeMemberGuildPermissions(member, roles);
            expect(combined).toBe("7"); // 1 | 2 | 4 = 7
        });

        test("applyChannelOverwrites evaluates permissions with channel overrides", () => {
            const basePerms = "1024"; // ViewChannel
            const member = { id: "u1", roles: ["r1"] };
            const channel = {
                guildId: "g1",
                permissionOverwrites: [
                    {
                        type: 0, // role overwrite
                        id: "r1",
                        allow: "2048", // SendMessages
                        deny: "0"
                    },
                    {
                        type: 1, // member overwrite
                        id: "u1",
                        allow: "16384", // EmbedLinks
                        deny: "0"
                    }
                ]
            };

            const result = discordAPI.applyChannelOverwrites(basePerms, member, channel);
            const bigResult = BigInt(result);
            expect(discordAPI.hasPermission(bigResult, PermissionFlagsBits.ViewChannel)).toBe(true);
            expect(discordAPI.hasPermission(bigResult, PermissionFlagsBits.SendMessages)).toBe(true);
            expect(discordAPI.hasPermission(bigResult, PermissionFlagsBits.EmbedLinks)).toBe(true);
        });
    });

    describe("validateBotCanManageRole", () => {
        const botRoles = [
            { id: "bot_role", name: "Bot Role", position: 10, permissions: String(PermissionFlagsBits.ManageRoles) }
        ];
        const botMember = {
            roles: ["bot_role"]
        };

        test("fails when target role does not exist", () => {
            const res = discordAPI.validateBotCanManageRole({
                botMember,
                roles: botRoles,
                targetRoleId: "missing_role"
            });
            expect(res.ok).toBe(false);
            expect(res.errors).toContain("ไม่พบ role เป้าหมายในเซิร์ฟเวอร์");
        });

        test("fails when target role is higher than bot in hierarchy", () => {
            const roles = [
                ...botRoles,
                { id: "higher_role", name: "Higher Role", position: 20, managed: false }
            ];
            const res = discordAPI.validateBotCanManageRole({
                botMember,
                roles,
                targetRoleId: "higher_role"
            });
            expect(res.ok).toBe(false);
            expect(res.errors).toContain("ยศบอทต้องอยู่สูงกว่า role ที่จะให้");
        });

        test("fails when target role is managed", () => {
            const roles = [
                ...botRoles,
                { id: "managed_role", name: "Managed Role", position: 5, managed: true }
            ];
            const res = discordAPI.validateBotCanManageRole({
                botMember,
                roles,
                targetRoleId: "managed_role"
            });
            expect(res.ok).toBe(false);
            expect(res.errors).toContain("Role เป้าหมายเป็น managed role ไม่สามารถให้ด้วยบอทได้");
        });

        test("succeeds when bot has manage permissions and higher hierarchy", () => {
            const roles = [
                ...botRoles,
                { id: "member_role", name: "Member Role", position: 5, managed: false }
            ];
            const res = discordAPI.validateBotCanManageRole({
                botMember,
                roles,
                targetRoleId: "member_role"
            });
            expect(res.ok).toBe(true);
            expect(res.errors).toHaveLength(0);
        });
    });

    describe("validateBotCanUseChannel", () => {
        test("fails when channel is missing", () => {
            const res = discordAPI.validateBotCanUseChannel({
                botMember: { roles: [] },
                roles: [],
                channel: null
            });
            expect(res.ok).toBe(false);
            expect(res.errors).toContain("ไม่พบ channel เป้าหมาย");
        });

        test("succeeds when bot has all required permissions in channel", () => {
            const adminRole = {
                id: "admin_role",
                name: "Admin",
                position: 10,
                permissions: String(PermissionFlagsBits.Administrator)
            };
            const res = discordAPI.validateBotCanUseChannel({
                botMember: { roles: ["admin_role"] },
                roles: [adminRole],
                channel: { id: "c1", name: "verify-channel" }
            });
            expect(res.ok).toBe(true);
            expect(res.errors).toHaveLength(0);
        });
    });

    describe("verificationDmCopy", () => {
        test("returns alreadyVerified copy", () => {
            const copy = discordAPI.verificationDmCopy({ alreadyVerified: true });
            expect(copy.title).toMatch(/ยืนยันตัวตนไว้แล้ว/);
            expect(copy.tone).toBe("info");
        });

        test("returns success copy", () => {
            const copy = discordAPI.verificationDmCopy({ ok: true });
            expect(copy.title).toMatch(/ยืนยันตัวตนสำเร็จ/);
            expect(copy.tone).toBe("success");
        });

        test("returns blocked copy", () => {
            const copy = discordAPI.verificationDmCopy({ blocked: true });
            expect(copy.title).toMatch(/ยังไม่ผ่านการยืนยัน/);
            expect(copy.tone).toBe("warning");
        });

        test("returns failed copy with stale panel guidance", () => {
            const copy = discordAPI.verificationDmCopy({ ok: false, reasonCode: "panel_revision_mismatch" });
            expect(copy.title).toMatch(/ยืนยันตัวตนไม่สำเร็จ/);
            expect(copy.nextAction).toMatch(/แผงยืนยันล่าสุด/);
            expect(copy.tone).toBe("danger");
        });
    });

    describe("Discord API Requests and Payload Preparation", () => {
        test("addMemberToGuild validates parameters and bot token", async () => {
            const res1 = await discordAPI.addMemberToGuild(null, "123", "token");
            expect(res1.ok).toBe(false);
            expect(res1.status).toBe(400);

            const res2 = await discordAPI.addMemberToGuild("123", null, "token");
            expect(res2.ok).toBe(false);
            expect(res2.status).toBe(400);

            const res3 = await discordAPI.addMemberToGuild("123", "456", null);
            expect(res3.ok).toBe(false);
            expect(res3.status).toBe(400);
        });

        test("addRoleToMember and removeRoleFromMember validate parameters", async () => {
            const resAdd = await discordAPI.addRoleToMember(null, "123", "456");
            expect(resAdd.ok).toBe(false);
            expect(resAdd.status).toBe(400);

            const resRem = await discordAPI.removeRoleFromMember("invalid_guild", "123", "456");
            expect(resRem.ok).toBe(false);
            expect(resRem.status).toBe(400);
        });

        test("moderateVerificationMember validates action and snowflake IDs", async () => {
            const resBadAction = await discordAPI.moderateVerificationMember("123456789012345678", "987654321098765432", "promote");
            expect(resBadAction.ok).toBe(false);
            expect(resBadAction.status).toBe(400);

            const resBadGid = await discordAPI.moderateVerificationMember("bad_id", "987654321098765432", "kick");
            expect(resBadGid.ok).toBe(false);
            expect(resBadGid.status).toBe(400);
        });

        test("fetchChannelMessage and getChannel validate snowflake IDs", async () => {
            const resMsg = await discordAPI.fetchChannelMessage("bad_cid", "bad_mid");
            expect(resMsg.ok).toBe(false);
            expect(resMsg.status).toBe(400);

            const resChan = await discordAPI.getChannel("invalid_cid");
            expect(resChan).toBeNull();
        });

        test("prepareMessagePayload builds application/json for standard payloads", () => {
            const { prepareMessagePayload } = discordAPI._test;
            const payload = { content: "Hello Discord!", embeds: [{ title: "Welcome" }] };
            const prepared = prepareMessagePayload(payload);

            expect(prepared.contentType).toBe("application/json");
            expect(JSON.parse(prepared.requestBody)).toEqual(payload);
        });

        test("prepareMessagePayload and buildMultipartFormData construct multipart body when files are provided", () => {
            const { prepareMessagePayload } = discordAPI._test;
            const payload = {
                content: "Message with attachments",
                files: [
                    { name: "test.webp", path: "/tmp/nonexistent_sample.webp" }
                ]
            };
            const prepared = prepareMessagePayload(payload);

            expect(prepared.contentType).toMatch(/^multipart\/form-data; boundary=/);
            expect(Buffer.isBuffer(prepared.requestBody)).toBe(true);
            expect(prepared.requestBody.toString()).toContain("Content-Disposition: form-data; name=\"payload_json\"");
        });
    });
});
