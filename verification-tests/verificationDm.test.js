"use strict";

const dmService = require("../discord/dm");
const discordAPI = require("../discord/verification/utils/discordAPI");

describe("Verification DM experience", () => {
    const sent = [];
    const user = {
        id: "111111111111111111",
        username: "verified-user",
        globalName: "ผู้ใช้ยืนยัน",
        discriminator: "0",
        displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/1.png",
        send: jest.fn(async payload => {
            sent.push(payload);
            return { id: String(sent.length), payload };
        })
    };

    beforeAll(() => {
        dmService.configure({
            client: {
                users: {
                    cache: new Map([[user.id, user]]),
                    fetch: jest.fn(async () => user)
                },
                isReady: () => true
            }
        });
    });

    beforeEach(() => {
        sent.length = 0;
        user.send.mockClear();
    });

    test("already verified copy does not claim a newly granted role", async () => {
        const delivered = await discordAPI.sendVerificationDM(user.id, {
            ok: true,
            result: "success",
            reasonCode: "already_verified_has_role",
            reason: "บัญชีนี้มียศอยู่แล้ว",
            roleName: "สมาชิก",
            guildId: "222222222222222222",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง",
            guildIconUrl: "https://cdn.discordapp.com/icons/222222222222222222/iconhash.png?size=128",
            requestId: "already-role-test"
        });
        const serialized = JSON.stringify(sent[0]);

        expect(delivered).toBe(true);
        expect(serialized).toContain("คุณเคยทำการ Verification ไว้เเล้ว");
        expect(serialized).toContain("ระบบจึงไม่สามารถเพิ่มยศให้คุณได้");
        expect(serialized).not.toContain("ได้รับยศใหม่");
        expect(serialized).not.toContain("บัญชีที่เกี่ยวข้อง");
        expect(serialized).not.toContain("already-role-test");
        expect(sent[0].embeds[0].thumbnail.url).toBe("https://cdn.discordapp.com/icons/222222222222222222/iconhash.png?size=128");
        expect(sent[0].components[0].components[0].url).toBe("https://discord.com/channels/222222222222222222");
    });

    test("all verification outcomes have distinct concise presentation", () => {
        const success = discordAPI.buildVerificationDmEmbed({
            ok: true,
            result: "success",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง",
            roleName: "สมาชิก"
        }).toJSON();
        const alreadyVerified = discordAPI.buildVerificationDmEmbed({
            ok: true,
            result: "success",
            reasonCode: "already_verified_has_role",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง"
        }).toJSON();
        const blocked = discordAPI.buildVerificationDmEmbed({
            ok: false,
            result: "blocked",
            reasonCode: "new_account:1",
            reason: "บัญชีอายุน้อยเกินไป",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง"
        }).toJSON();
        const failed = discordAPI.buildVerificationDmEmbed({
            ok: false,
            result: "failed",
            reason: "Discord ตอบกลับไม่สำเร็จ",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง"
        }).toJSON();

        expect(success.title).toContain("คุณได้ทำการ Verification สำเร็จแล้ว");
        expect(success.description).toContain("คุณผ่านการตรวจสอบเเล้วเเละได้รับยศเเล้ว");
        expect(alreadyVerified.title).toContain("คุณเคยทำการ Verification ไว้เเล้ว");
        expect(alreadyVerified.description).toContain("ระบบจึงไม่สามารถเพิ่มยศให้คุณได้");
        expect(blocked.title).toContain("ไม่ผ่านการ Verification ของเซิร์ฟเวอร์");
        expect(blocked.description).toContain("บัญชีของคุณไม่ผ่านเงื่อนไขความปลอดภัยของเซิร์ฟเวอร์");
        expect(failed.title).toContain("คุณ Verification ไม่สำเร็จ");
        expect(failed.description).toContain("ระบบทำการตรวจสอบไม่สำเร็จ โปรดลองใหม่อีกครั้ง");
        expect(success.color).toBe(parseInt("2ECC71", 16));
        expect(alreadyVerified.color).toBe(parseInt("2ECC71", 16));
        expect(blocked.color).toBe(parseInt("E74C3C", 16));
        expect(failed.color).toBe(parseInt("E74C3C", 16));
    });

    test("verification link button directs to guild or verification channel", () => {
        const successComps = discordAPI.buildVerificationDmComponents({
            ok: true,
            guildId: "123456789012345678"
        });
        expect(successComps.length).toBe(1);
        expect(successComps[0].components[0].data.url).toBe("https://discord.com/channels/123456789012345678");
        expect(successComps[0].components[0].data.emoji.id).toBe("1553835220912840814");

        const blockedCompsWithChannel = discordAPI.buildVerificationDmComponents({
            ok: false,
            guildId: "123456789012345678",
            channelId: "987654321098765432"
        });
        expect(blockedCompsWithChannel[0].components[0].data.url).toBe("https://discord.com/channels/123456789012345678/987654321098765432");

        const failedCompsFallback = discordAPI.buildVerificationDmComponents({
            ok: false,
            guildId: "123456789012345678"
        });
        expect(failedCompsFallback[0].components[0].data.url).toBe("https://discord.com/channels/123456789012345678");
    });

    test("verification DM never contains OAuth or network secrets", async () => {
        await discordAPI.sendVerificationDM(user.id, {
            ok: true,
            result: "success",
            reasonCode: "verified",
            reason: "ยืนยันสำเร็จ",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง",
            roleName: "สมาชิก",
            requestId: "secret-test",
            accessToken: "access-secret-value",
            refreshToken: "refresh-secret-value",
            rawIp: "203.0.113.10"
        });
        const serialized = JSON.stringify(sent[0]);

        expect(serialized).not.toContain("access-secret-value");
        expect(serialized).not.toContain("refresh-secret-value");
        expect(serialized).not.toContain("203.0.113.10");
        expect(serialized).not.toContain("secret-test");
        expect(sent[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
    });

    test("verification DM still sends without a server icon", async () => {
        const delivered = await discordAPI.sendVerificationDM(user.id, {
            ok: false,
            result: "failed",
            reason: "เชื่อมต่อ Discord ไม่สำเร็จ",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง",
            guildIconUrl: "https://example.com/not-a-discord-icon.png",
            requestId: "no-icon-test"
        });

        expect(delivered).toBe(true);
        expect(sent[0].embeds[0].thumbnail).toBeUndefined();
    });
});
