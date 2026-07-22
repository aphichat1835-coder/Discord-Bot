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
            guildName: "เซิร์ฟเวอร์ตัวอย่าง",
            requestId: "already-role-test"
        });
        const serialized = JSON.stringify(sent[0]);

        expect(delivered).toBe(true);
        expect(serialized).toContain("มียศยืนยันอยู่ก่อนแล้ว");
        expect(serialized).not.toContain("ได้รับยศใหม่");
        expect(serialized).toContain("บัญชีที่เกี่ยวข้อง");
    });

    test("blocked result is visually distinct from a system failure", async () => {
        await discordAPI.sendVerificationDM(user.id, {
            ok: false,
            result: "blocked",
            reasonCode: "new_account:1",
            reason: "บัญชีอายุน้อยเกินไป",
            guildName: "เซิร์ฟเวอร์ตัวอย่าง",
            requestId: "blocked-test"
        });
        const serialized = JSON.stringify(sent[0]);

        expect(serialized).toContain("ไม่ผ่านเงื่อนไขของเซิร์ฟเวอร์");
        expect(serialized).toContain("บัญชีอายุน้อยเกินไป");
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
        expect(sent[0].allowedMentions).toEqual({ parse: [], repliedUser: false });
    });
});
