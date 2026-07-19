"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Collection } = require("discord.js");
const information = require("../commands/information");

function field(embed, name) {
    return embed.toJSON().fields.find(item => item.name === name)?.value || "";
}

function assertEmbedWithinDiscordLimits(embed) {
    const json = embed.toJSON();
    assert.ok((json.title || "").length <= 256);
    assert.ok((json.description || "").length <= 4096);
    assert.ok((json.fields || []).length <= 25);
    for (const item of json.fields || []) {
        assert.ok(item.name.length <= 256);
        assert.ok(item.value.length <= 1024);
    }
    const total = (json.title || "").length + (json.description || "").length +
        (json.footer?.text || "").length + (json.fields || []).reduce((sum, item) => sum + item.name.length + item.value.length, 0);
    assert.ok(total <= 6000);
}

test("serverinfo groups current Discord data into readable Thai sections", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const channels = new Collection([
        ["text", { type: "GUILD_TEXT" }],
        ["voice", { type: "GUILD_VOICE" }],
        ["category", { type: "GUILD_CATEGORY" }],
        ["news", { type: "GUILD_NEWS" }],
        ["stage", { type: "GUILD_STAGE_VOICE" }]
    ]);
    const guild = {
        id: "123456789012345678",
        name: "Test **Server**",
        ownerId: "223456789012345678",
        createdTimestamp: Date.now() - 86400000,
        preferredLocale: "th",
        available: true,
        description: "พื้นที่ทดสอบ",
        memberCount: 25,
        channels: { cache: channels },
        roles: { cache: new Collection([["everyone", {}], ["role", {}]]) },
        emojis: { cache: new Collection([["emoji", {}]]) },
        stickers: { cache: new Collection() },
        verificationLevel: 4,
        explicitContentFilter: 2,
        mfaLevel: 1,
        premiumTier: 2,
        premiumSubscriptionCount: 8,
        vanityURLCode: "test",
        rulesChannelId: "rules",
        systemChannelId: "system",
        afkChannelId: "afk",
        afkTimeout: 300,
        features: ["COMMUNITY", "BANNER"],
        iconURL: () => null,
        me: { user: { tag: "Bot#0001" } }
    };
    const embed = information._test.buildServerInfoEmbed(guild, null, {
        total: 25,
        human: 20,
        bots: 5,
        source: "ข้อมูลล่าสุดจาก Discord"
    });
    const json = embed.toJSON();

    assertEmbedWithinDiscordLimits(embed);
    assert.match(json.title, /ข้อมูลเซิร์ฟเวอร์/);
    assert.equal(json.fields.length, 9);
    assert.match(field(embed, "👥 สมาชิก"), /คน \*\*20\*\* • บอท \*\*5\*\*/);
    assert.match(field(embed, "🛡️ การป้องกันสมาชิก"), /ยืนยันหมายเลขโทรศัพท์/);
    assert.match(field(embed, "🚀 Boost"), /ระดับ 2/);
    assert.match(field(embed, "🧭 ช่องระบบ"), /ย้ายเมื่อเงียบ \*\*5 นาที 0 วินาที\*\*/);
    assert.doesNotMatch(JSON.stringify(json), /Server Information|Enterprise Architecture/);
});

test("userinfo resolves the selected user instead of silently falling back to the caller", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const selected = { id: "333456789012345678", username: "selected" };
    const fetchedMember = { id: selected.id, user: selected };
    let fetchedMemberId = null;
    let fetchedUserId = null;
    const interaction = {
        user: { id: "caller", username: "caller" },
        member: { id: "caller" },
        options: {
            getUser: () => selected,
            getMember: () => null
        },
        guild: {
            members: {
                fetch: async id => { fetchedMemberId = id; return fetchedMember; }
            }
        },
        client: {
            users: {
                fetch: async id => { fetchedUserId = id; return selected; }
            }
        }
    };

    const result = await information._test.resolveUserInfoTarget(interaction);
    assert.equal(fetchedMemberId, selected.id);
    assert.equal(fetchedUserId, selected.id);
    assert.equal(result.user, selected);
    assert.equal(result.member, fetchedMember);
});

test("userinfo presents age as context rather than declaring a person high risk", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const guild = { id: "guild", ownerId: "owner" };
    const roles = new Collection([
        ["guild", { id: "guild", position: 0, toString: () => "@everyone" }],
        ["role", { id: "role", position: 1, toString: () => "<@&role>" }]
    ]);
    const member = {
        id: "user",
        guild,
        nickname: "ชื่อเล่น",
        joinedTimestamp: Date.now() - 3600000,
        displayHexColor: "#57F287",
        roles: { cache: roles },
        permissions: { has: permission => permission === "MANAGE_MESSAGES" },
        communicationDisabledUntilTimestamp: null,
        pending: false,
        premiumSinceTimestamp: null
    };
    const user = {
        id: "user",
        username: "tester",
        discriminator: "0",
        globalName: "Tester",
        createdTimestamp: Date.now() - 2 * 86400000,
        bot: false,
        system: false,
        flags: { toArray: () => ["ACTIVE_DEVELOPER"] },
        displayAvatarURL: () => null,
        bannerURL: () => null
    };
    const embed = information._test.buildUserInfoEmbed({ user: { tag: "Caller#0001" } }, user, member);
    const serialized = JSON.stringify(embed.toJSON());

    assertEmbedWithinDiscordLimits(embed);
    assert.match(field(embed, "🎂 อายุบัญชี"), /ควรตรวจสอบบริบท/);
    assert.match(field(embed, "🔐 สิทธิ์สำคัญในเซิร์ฟเวอร์"), /จัดการข้อความ/);
    assert.match(field(embed, "🧭 สถานะสมาชิก"), /ไม่ได้ถูกหมดเวลา/);
    assert.doesNotMatch(serialized, /HIGH RISK|MEDIUM RISK|Wick Informations/);
});

test("ping labels process RSS, V8 heap, CPU sample and session states precisely", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const embed = information._test.buildPingEmbed({
        interactionLatency: 25,
        websocketLatency: 40,
        shardId: 0,
        shardCount: 1,
        startedAt: Date.now() - 90061000,
        uptimeSeconds: 90061,
        rssMB: 180.25,
        heapUsedMB: 55.5,
        heapTotalMB: 64,
        externalMB: 30,
        cpuPercent: 12.34,
        guildCount: 3,
        reportedMemberCount: 120,
        sessions: { active: 2, recovering: 1, failed: 1, total: 4 },
        databaseReady: true,
        requests: 10,
        errors: 2,
        reconnects: 1
    });

    assertEmbedWithinDiscordLimits(embed);
    assert.match(field(embed, "🧠 หน่วยความจำของ Process"), /RAM \(RSS\) \*\*180\.3 MB\*\*/);
    assert.match(field(embed, "⚙️ การประมวลผล"), /CPU ระหว่างการวัด \*\*12\.3%\*\*/);
    assert.match(field(embed, "🎙️ Voice Sessions"), /ใช้งาน \*\*2\*\*/);
    assert.equal(information._test.formatDuration(90061), "1 วัน 1 ชม. 1 นาที 1 วินาที");
    assert.equal(information._test.cpuPercent({ user: 0, system: 0 }, { user: 250, system: 250 }, 1000), 50);
    assert.equal(information._test.buildPingEmbed({
        interactionLatency: 25,
        websocketLatency: null,
        shardId: 0,
        shardCount: 1,
        startedAt: Date.now(),
        uptimeSeconds: 0,
        rssMB: 1,
        heapUsedMB: 1,
        heapTotalMB: 1,
        externalMB: 1,
        cpuPercent: 0,
        guildCount: 0,
        reportedMemberCount: 0,
        sessions: { active: 0, recovering: 0, failed: 0, total: 0 },
        databaseReady: false,
        requests: 0,
        errors: 0,
        reconnects: 0
    }).toJSON().fields[0].value.includes("WebSocket **ไม่ทราบ**"), true);
});
