"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const config = require("../config.json");
const { IDS } = require("../commands/customIds");
const dm = require("../voiceWorker/dm");
const {
    buildVoiceLogEmbed,
    buildVoiceLogButtonRow,
    buildTerminalAlertEmbed,
    groupSessionsByToken,
    resolveTroubleStatus,
    categorizeSessions,
    TERMINAL_TITLES,
    flushVoiceLogDM,
    syncVoiceLogDM,
    ownerLogTrackers
} = dm;

test("Voice Worker DM Renovation: buildVoiceLogEmbed structure & formatting", () => {
    const online = [
        {
            sessionId: "s1",
            accountId: "acc1",
            accountTag: "deklnwfreefrie",
            serverId: "1370552846457634856",
            voiceId: "1463423755383472253",
            tokenHash: "token-hash-A"
        },
        {
            sessionId: "s2",
            accountId: "acc1",
            accountTag: "deklnwfreefrie",
            serverId: "1370552846457634856",
            voiceId: "1370552853948661882",
            voiceName: "✩ Vc 3 ✩",
            tokenHash: "token-hash-A"
        }
    ];

    const embed = buildVoiceLogEmbed(online, []).toJSON();
    assert.ok(embed.description.includes("# <a:bell_pmt:1559247893343248438> Logระบบออนช่องเสียง"));
    assert.ok(embed.description.includes("<a:g03_pmt:1553832998468714516> บัญชีที่กำลังออนอยู่"));
    assert.ok(embed.description.includes("<:Grej_pmt:1560405771978547340> ชื่อบัญชี deklnwfreefrie<a:Grep_pmt:1560411233214009454> https://discord.com/channels/1370552846457634856/1463423755383472253"));
    assert.ok(embed.description.includes("<:Grej_pmt:1560405771978547340> ชื่อบัญชี deklnwfreefrie<a:Grep_pmt:1560411233214009454> [✩ Vc 3 ✩](https://discord.com/channels/1370552846457634856/1370552853948661882)"));
    // Trouble section should be hidden when troubled list is empty
    assert.ok(!embed.description.includes("บัญชีที่กำลังเกิดปัญหา"));
});

test("Voice Worker DM Renovation: troubled sessions display problem statuses and hide when empty", () => {
    const troubled = [
        {
            sessionId: "s3",
            accountTag: "deklnwfreefrie",
            tokenHash: "token-hash-A",
            recoveryState: { phase: "attempt", attempts: 4, maxAttempts: 15 },
            reconnecting: true
        },
        {
            sessionId: "s4",
            accountTag: "deklnwfreefrie",
            tokenHash: "token-hash-A",
            recoveryState: { phase: "hibernate", attempts: 15 }
        },
        {
            sessionId: "s5",
            accountTag: "deklnwfreefrie",
            tokenHash: "token-hash-A",
            recoveryState: { phase: "attempt", attempts: 11, maxAttempts: 15 },
            reconnecting: true
        },
        {
            sessionId: "s6",
            accountTag: "deklnwfreefrie",
            tokenHash: "token-hash-A",
            recoveryState: { phase: "degraded", delayed: true, attempts: 2 }
        }
    ];

    const embed = buildVoiceLogEmbed([], troubled).toJSON();
    assert.ok(embed.description.includes("<a:r04fpt_pmt:1553833007532474519> บัญชีที่กำลังเกิดปัญหา"));
    assert.ok(embed.description.includes("กำลังกู้คืน <a:Loadingg_pmt:1553844457856827393> (4/15)"));
    assert.ok(embed.description.includes("ช่วงพักก่อนลองพยามเชื่อมต่อใหม่"));
    assert.ok(embed.description.includes("กำลังกู้คืน <a:Loadingg_pmt:1553844457856827393> (11/15)"));
    assert.ok(embed.description.includes("ระยะเวลาที่รอพยายามเชื่อมต่อ"));
});

test("Voice Worker DM Renovation: groupSessionsByToken keeps same token adjacent", () => {
    const sessions = [
        { sessionId: "s1", tokenHash: "token-B", serverId: "guild-1" },
        { sessionId: "s2", tokenHash: "token-A", serverId: "guild-2" },
        { sessionId: "s3", tokenHash: "token-C", serverId: "guild-3" },
        { sessionId: "s4", tokenHash: "token-A", serverId: "guild-1" },
        { sessionId: "s5", tokenHash: "token-B", serverId: "guild-4" },
        { sessionId: "s6", tokenHash: "token-A", serverId: "guild-3" }
    ];

    const sorted = groupSessionsByToken(sessions);
    const tokens = sorted.map(s => s.tokenHash);
    // All token-A should be consecutive, then all token-B, then token-C
    assert.deepEqual(tokens, [
        "token-A", "token-A", "token-A",
        "token-B", "token-B",
        "token-C"
    ]);
});

test("Voice Worker DM Renovation: buildVoiceLogButtonRow has Status button with correct ID and emoji", () => {
    const row = buildVoiceLogButtonRow().toJSON();
    assert.equal(row.components.length, 1);
    const btn = row.components[0];
    assert.equal(btn.custom_id, IDS.BTN_STATUS);
    assert.equal(btn.label, "สถานะ & จัดการ");
    assert.equal(btn.style, 1); // PRIMARY
});

test("Voice Worker DM Renovation: buildTerminalAlertEmbed covers all 10 terminal events", () => {
    const expected = {
        TOKEN_INVALID: "ระบบไม่สามารถล็อคอินได้ กรุณาลองใหม่เเละตรวจสอบToken",
        LOGIN_FAILED: "ระบบไม่สามารถล็อคอินได้ กรุณาลองใหม่เเละตรวจสอบToken",
        GUILD_NOT_FOUND: "บัญชีไม่พบเซิฟเวอร์ที่กำหนด กรุณาเช็คเเละลองใหม่",
        CHANNEL_NOT_FOUND: "บัญชีไม่พบช่องเสียงที่กำหนด กรุณาเช็คเเละลองใหม่",
        VOICE_PERMISSION_DENIED: "เกิดข้อผิดพลาด เชื่อมต่อช่องเสียงไม่สำเร็จ",
        VOICE_CONNECTION_FAILED: "เกิดข้อผิดพลาด เชื่อมต่อช่องเสียงไม่สำเร็จ",
        SESSION_STOPPED_IDLE: "เกินกำหนดเวลาที่ระบบออนให้เเล้ว",
        SESSION_STOPPED_MANUAL: "ระบบได้ทำการออกจากช่องเสียงเเล้ว จากคำสั่งหยุดของผู้ใช้",
        STOP_FAILED: "เกิดข้อผิดพลาดของToken โปรดตรวจเช็คว่าระบบได้ออกจากช่องเสียงยัง",
        RECOVERY_EXHAUSTED: "กู้คืนไม่สำเร็จ สิ้นสุดความพยายามเชื่อมต่อ"
    };

    for (const [type, expectedTitle] of Object.entries(expected)) {
        const embed = buildTerminalAlertEmbed(type).toJSON();
        assert.ok(embed.title.includes(expectedTitle), `Event ${type} did not include expected title: ${expectedTitle}`);
        assert.ok(embed.title.includes("<a:CROSS_pmt:1553833049135906816>"));
        assert.equal(embed.color, parseInt("E74C3C", 16));
    }
});

test("Voice Worker DM Renovation: flushVoiceLogDM deletes message when active sessions count reaches 0", async () => {
    let deleted = false;
    const fakeMessage = {
        async delete() {
            deleted = true;
        }
    };
    ownerLogTrackers.set("owner-empty", {
        ownerId: "owner-empty",
        message: fakeMessage
    });

    const res = await flushVoiceLogDM("owner-empty", { allSessions: new Map() });
    assert.equal(res.status, "deleted");
    assert.equal(deleted, true);
    assert.equal(ownerLogTrackers.has("owner-empty"), false);
});

test("Voice Worker DM Renovation: syncVoiceLogDM debounces multiple calls and settles all awaiting promises", async () => {
    const keepAlive = setInterval(() => {}, 1000);
    try {
        const p1 = syncVoiceLogDM("owner-multi-call", { allSessions: new Map() });
        const p2 = syncVoiceLogDM("owner-multi-call", { allSessions: new Map() });
        const p3 = syncVoiceLogDM("owner-multi-call", { allSessions: new Map(), immediate: true });

        const results = await Promise.all([p1, p2, p3]);
        assert.equal(results.length, 3);
        for (const r of results) {
            assert.ok(r);
            assert.equal(r.status, "deleted");
        }
    } finally {
        clearInterval(keepAlive);
    }
});
