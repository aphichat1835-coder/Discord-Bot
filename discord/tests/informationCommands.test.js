"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { Collection, PermissionFlagsBits } = require("discord.js");
const information = require("../commands/information");

const SECOND_MS = 1000;
const DAY_MS = 24 * 60 * 60 * SECOND_MS;
const SAMPLE_UPTIME_SECONDS = 24 * 60 * 60 + 60 * 60 + 60 + 1;

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
        createdTimestamp: Date.now() - DAY_MS,
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

test("information commands use distinct truthful loading embeds before the final result", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const interaction = {
        guild: { name: "Test Server", iconURL: () => null },
        user: { username: "caller", displayAvatarURL: () => null },
        options: { getUser: () => ({ username: "target", displayAvatarURL: () => null }) },
        reply: async payload => payload
    };
    const server = information._test.buildLoadingEmbed("serverinfo", interaction).toJSON();
    const user = information._test.buildLoadingEmbed("userinfo", interaction).toJSON();
    const ping = information._test.buildLoadingEmbed("ping", interaction).toJSON();
    const sent = await information._test.sendLoadingState(interaction, "ping");

    assert.match(server.title, /กำลังสำรวจเซิร์ฟเวอร์/);
    assert.match(server.fields[0].value, /MEMBERS/);
    assert.match(user.title, /กำลังเปิดแฟ้มข้อมูลสมาชิก/);
    assert.match(user.fields[0].value, /โปรไฟล์และอายุบัญชี/);
    assert.match(ping.title, /กำลังจับสัญญาณระบบ/);
    assert.match(ping.description, /LATENCY/);
    assert.notEqual(server.color, user.color);
    assert.notEqual(user.color, ping.color);
    assert.doesNotMatch(JSON.stringify([server, user, ping]), /\d+%|progress/i);
    assert.equal(sent.fetchReply, true);
    assert.deepEqual(sent.allowedMentions, { parse: [] });
    assertEmbedWithinDiscordLimits(information._test.buildLoadingEmbed("serverinfo", interaction));
    assertEmbedWithinDiscordLimits(information._test.buildLoadingEmbed("userinfo", interaction));
    assertEmbedWithinDiscordLimits(information._test.buildLoadingEmbed("ping", interaction));
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
        permissions: { has: permission => permission === PermissionFlagsBits.ManageMessages },
        communicationDisabledUntilTimestamp: null,
        pending: false,
        premiumSinceTimestamp: null
    };
    const user = {
        id: "user",
        username: "tester",
        discriminator: "0",
        globalName: "Tester",
        createdTimestamp: Date.now() - 2 * DAY_MS,
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
        startedAt: Date.now() - SAMPLE_UPTIME_SECONDS * SECOND_MS,
        uptimeSeconds: SAMPLE_UPTIME_SECONDS,
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
    assert.equal(information._test.formatDuration(SAMPLE_UPTIME_SECONDS), "1 วัน 1 ชม. 1 นาที 1 วินาที");
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
