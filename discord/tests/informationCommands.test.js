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
    assert.equal(json.fields.length, 4);
    assert.match(field(embed, "🏠 ข้อมูลทั่วไป & สมาชิก"), /คนจริง: \*\*20\*\* คน/);
    assert.match(field(embed, "🏠 ข้อมูลทั่วไป & สมาชิก"), /บอท: \*\*5\*\* ตัว/);
    assert.match(field(embed, "🛡️ ความปลอดภัย & Boost"), /ยืนยันหมายเลขโทรศัพท์/);
    assert.match(field(embed, "🛡️ ความปลอดภัย & Boost"), /ระดับ 2/);
    assert.match(field(embed, "🛡️ ความปลอดภัย & Boost"), /อัปโหลดสูงสุด \*\*50 MB\*\*/);
    assert.match(field(embed, "🧭 ช่องระบบ & คุณสมบัติ"), /ย้ายเมื่อเงียบ \*\*5 นาที 0 วินาที\*\*/);
    assert.doesNotMatch(JSON.stringify(json), /Server Information|Enterprise Architecture/);

    // Test verified and unverified bot counting
    const memberCollection = new Collection([
        ["user-1", { user: { bot: false } }],
        ["user-2", { user: { bot: false } }],
        ["bot-verified", { user: { bot: true, flags: { has: flag => flag === 65536 } } }],
        ["bot-unverified", { user: { bot: true, flags: { has: () => false } } }]
    ]);
    const counts = information._test.countCachedMembers(memberCollection);
    assert.equal(counts.human, 2);
    assert.equal(counts.bots, 2);
    assert.equal(counts.verifiedBots, 1);
    assert.equal(counts.unverifiedBots, 1);

    const guildWithSpecial = {
        ...guild,
        safetyAlertsChannelId: "safety-ch",
        publicUpdatesChannelId: "updates-ch",
        iconURL: () => "https://cdn.discordapp.com/icons/123/icon.png",
        bannerURL: () => "https://cdn.discordapp.com/banners/123/banner.png"
    };
    const specialEmbed = information._test.buildServerInfoEmbed(guildWithSpecial, null, {
        total: 25,
        human: 20,
        bots: 5,
        verifiedBots: 3,
        unverifiedBots: 2,
        source: "Discord"
    }, { autoModSummary: "**3** กฎ (2 เปิดใช้)" });

    assert.match(field(specialEmbed, "🏠 ข้อมูลทั่วไป & สมาชิก"), /ยืนยันแล้ว: \*\*3\*\* • ยังไม่ยืนยัน: \*\*2\*\*/);
    assert.match(field(specialEmbed, "🛡️ ความปลอดภัย & Boost"), /กฎ AutoMod:\*\* \*\*3\*\* กฎ/);
    assert.match(field(specialEmbed, "🧭 ช่องระบบ & คุณสมบัติ"), /แจ้งเตือนความปลอดภัย <#safety-ch>/);
    assert.match(field(specialEmbed, "🧭 ช่องระบบ & คุณสมบัติ"), /ข่าวสารทางการ <#updates-ch>/);

    const rows = information._test.buildServerInfoActionRow(guildWithSpecial);
    assert.equal(rows.length, 1);
    const buttons = rows[0].components;
    assert.equal(buttons.length, 2); // Icon, Banner
    assert.equal(buttons[0].data.label, "รูปไอคอน");
    assert.equal(buttons[0].data.style, 5); // Link style
    assert.equal(buttons[1].data.label, "แบนเนอร์");
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
    assert.match(field(embed, "🪪 1. ข้อมูลบัญชี & อายุ (Account Details)"), /ควรตรวจสอบบริบท/);
    assert.match(field(embed, "🛡️ 3. ยศและสิทธิ์ในเซิร์ฟเวอร์ (Roles & Permissions)"), /จัดการข้อความ/);
    assert.match(field(embed, "🧭 4. สถานะสมาชิก & กิจกรรม (Member Status)"), /ไม่ได้ถูกหมดเวลา/);
    assert.doesNotMatch(serialized, /HIGH RISK|MEDIUM RISK|Wick Informations/);

    // Test Action Row buttons
    const userWithImages = {
        id: "1234567890",
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/123/avatar.png",
        bannerURL: () => "https://cdn.discordapp.com/banners/123/banner.png"
    };
    const memberWithAvatar = {
        avatarURL: () => "https://cdn.discordapp.com/guilds/guild/users/123/avatar.png"
    };
    const actionRows = information._test.buildUserInfoActionRow(userWithImages, memberWithAvatar);
    assert.equal(actionRows.length, 1);
    const buttons = actionRows[0].components;
    assert.equal(buttons.length, 4);
    assert.equal(buttons[0].data.label, "รูปโปรไฟล์");
    assert.equal(buttons[1].data.label, "รูปในเซิร์ฟเวอร์");
    assert.equal(buttons[2].data.label, "แบนเนอร์");
    assert.equal(buttons[3].data.label, "โปรไฟล์ Discord");
    assert.equal(buttons[3].data.url, "https://discord.com/users/1234567890");

    // Test Join Position
    const guildWithMembers = {
        members: {
            cache: new Collection([
                ["m1", { id: "m1", joinedTimestamp: 1000 }],
                ["m2", { id: "m2", joinedTimestamp: 3000 }],
                ["m3", { id: "m3", joinedTimestamp: 2000 }]
            ])
        }
    };
    assert.equal(information._test.getJoinPosition({ id: "m1", joinedTimestamp: 1000, guild: guildWithMembers }), 1);
    assert.equal(information._test.getJoinPosition({ id: "m3", joinedTimestamp: 2000, guild: guildWithMembers }), 2);
    assert.equal(information._test.getJoinPosition({ id: "m2", joinedTimestamp: 3000, guild: guildWithMembers }), 3);
    assert.equal(information._test.getJoinPosition(null), null);

    // Test User Type Label
    assert.equal(information._test.userTypeDetailLabel({ bot: true, flags: { has: flag => flag === 65536 } }), "บอทที่ได้รับการยืนยัน (Verified Bot ✔️)");
    assert.equal(information._test.userTypeDetailLabel({ bot: true, flags: { has: () => false } }), "บอททั่วไป (Bot)");
    assert.equal(information._test.userTypeDetailLabel({ bot: false, system: true }), "บัญชีระบบ Discord (System)");
    assert.equal(information._test.userTypeDetailLabel({ bot: false }), "ผู้ใช้งานทั่วไป (User)");

    // Test Staff Label
    assert.equal(information._test.memberStaffLabel({ guild: { ownerId: "999" }, id: "999" }), "👑 เจ้าของเซิร์ฟเวอร์ (Server Owner)");
    assert.equal(information._test.memberStaffLabel({ guild: { ownerId: "999" }, id: "111", permissions: { has: p => p === PermissionFlagsBits.Administrator } }), "🛡️ ทีมงานดูแลเซิร์ฟเวอร์ (Staff / Mod)");
    assert.equal(information._test.memberStaffLabel({ guild: { ownerId: "999" }, id: "222", permissions: { has: () => false } }), "👤 สมาชิกทั่วไป (Member)");

    // Test Highest Role Label
    const memberRoles = new Collection([
        ["everyone", { id: "g1", position: 0, toString: () => "@everyone" }],
        ["admin", { id: "admin", position: 10, toString: () => "@Admin" }],
        ["vip", { id: "vip", position: 5, toString: () => "@VIP" }]
    ]);
    assert.match(information._test.highestRoleLabel({ guild: { id: "g1" }, roles: { cache: memberRoles } }), /@Admin \(ลำดับที่ 10\)/);

    // Test Boost Detail
    const thirtyDaysAgo = Date.now() - 30 * DAY_MS;
    assert.match(information._test.memberBoostDetail({ premiumSinceTimestamp: thirtyDaysAgo }), /30 วัน/);
    assert.equal(information._test.memberBoostDetail(null), "ไม่ได้ Boost เซิร์ฟเวอร์นี้");
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
    assert.match(field(embed, "🧠 2. ทรัพยากรระบบ & Host (Resources & Hardware)"), /RAM \(RSS\) \*\*180\.3 MB\*\*/);
    assert.match(field(embed, "🧠 2. ทรัพยากรระบบ & Host (Resources & Hardware)"), /CPU ระหว่างการวัด \*\*12\.3%\*\*/);
    assert.match(field(embed, "🎙️ 4. Voice Subsystem & สุขภาพระบบ (Voice & Health)"), /ใช้งาน \*\*2\*\*/);
    assert.equal(information._test.formatDuration(SAMPLE_UPTIME_SECONDS), "1 วัน 1 ชม. 1 นาที 1 วินาที");
    assert.equal(information._test.cpuPercent({ user: 0, system: 0 }, { user: 250, system: 250 }, 1000), 50);
    assert.equal(information._test.makeProgressBar(0), "`[▱▱▱▱▱▱▱▱]`");
    assert.equal(information._test.makeProgressBar(50), "`[▰▰▰▰▱▱▱▱]`");
    assert.equal(information._test.makeProgressBar(100), "`[▰▰▰▰▰▰▰▰]`");
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
        reconnects: 0,
        botAvatarUrl: "https://cdn.discordapp.com/avatars/123/bot.png"
    }).toJSON().fields[0].value.includes("WebSocket **ไม่ทราบ**"), true);

    const embedWithAvatar = information._test.buildPingEmbed({
        interactionLatency: 20,
        websocketLatency: 20,
        shardId: 0,
        shardCount: 1,
        startedAt: Date.now(),
        uptimeSeconds: 10,
        rssMB: 100,
        heapUsedMB: 50,
        heapTotalMB: 80,
        externalMB: 10,
        cpuPercent: 5,
        guildCount: 1,
        reportedMemberCount: 10,
        sessions: { active: 1, recovering: 0, failed: 0, total: 1 },
        databaseReady: true,
        requests: 5,
        errors: 0,
        reconnects: 0,
        botAvatarUrl: "https://cdn.discordapp.com/avatars/123/bot.png"
    });
    assert.equal(embedWithAvatar.toJSON().thumbnail.url, "https://cdn.discordapp.com/avatars/123/bot.png");
});

test("ping command is owner-only and denies non-owner users", async () => {
    let replyPayload = null;
    const nonOwnerInteraction = {
        commandName: "ping",
        user: { id: "999999999999999999" },
        reply(payload) {
            replyPayload = payload;
            return Promise.resolve(payload);
        }
    };
    await information.handle(nonOwnerInteraction, {}, {});
    assert.ok(replyPayload);
    assert.equal(replyPayload.ephemeral, true);
    assert.match(replyPayload.content, /เฉพาะ \*\*เจ้าของบอท \(Bot Owner\)\*\* เท่านั้น/);
});

test("ping command executes successfully for configured bot owner", async () => {
    const config = require("../config.json");
    let initialReply = null;
    let editPayload = null;
    const ownerInteraction = {
        commandName: "ping",
        user: { id: config.system.ownerId },
        createdTimestamp: Date.now() - 30,
        reply(payload) {
            initialReply = payload;
            return Promise.resolve({ createdTimestamp: Date.now() });
        },
        editReply(payload) {
            editPayload = payload;
            return Promise.resolve(payload);
        }
    };
    const mockClient = {
        ws: { ping: 25, shards: new Map() },
        guilds: { cache: new Map() },
        user: { displayAvatarURL: () => "https://cdn.discordapp.com/avatars/bot.png" }
    };
    const mockSessionManager = {
        systemMetrics: { uptime: Date.now() - 5000, dbConnected: true },
        getAllSessions: () => new Map()
    };

    await information.handle(ownerInteraction, mockClient, mockSessionManager);
    assert.ok(initialReply);
    assert.ok(editPayload);
    assert.equal(editPayload.content, null);
    assert.equal(editPayload.embeds.length, 1);
    const resultEmbed = editPayload.embeds[0].toJSON();
    assert.equal(resultEmbed.thumbnail.url, "https://cdn.discordapp.com/avatars/bot.png");
    assert.equal(resultEmbed.fields.length, 4);
});

test("userinfo handle responds with 4-zone embed and action row components", async () => {
    let initialReply = null;
    let editPayload = null;
    const mockUser = {
        id: "555555555555555555",
        username: "userinfo_target",
        discriminator: "0",
        globalName: "Target User",
        createdTimestamp: Date.now() - 50 * DAY_MS,
        bot: false,
        system: false,
        flags: { toArray: () => [] },
        displayAvatarURL: () => "https://cdn.discordapp.com/avatars/555/avatar.png",
        bannerURL: () => null
    };
    const mockMember = {
        id: "555555555555555555",
        user: mockUser,
        nickname: "Target Nick",
        joinedTimestamp: Date.now() - 10 * DAY_MS,
        displayHexColor: "#57F287",
        roles: { cache: new Collection([["everyone", { id: "guild", position: 0 }]]) },
        permissions: { has: () => false },
        communicationDisabledUntilTimestamp: null,
        pending: false,
        premiumSinceTimestamp: null,
        avatarURL: () => null,
        guild: { id: "guild", memberCount: 50 }
    };
    const interaction = {
        commandName: "userinfo",
        options: {
            getUser: () => mockUser,
            getMember: () => mockMember
        },
        user: { id: "111111111111111111", username: "caller" },
        guild: {
            id: "guild",
            memberCount: 50,
            members: { cache: new Collection([["555555555555555555", mockMember]]) }
        },
        client: {
            users: { fetch: () => Promise.resolve(mockUser) }
        },
        reply(payload) {
            initialReply = payload;
            return Promise.resolve({ createdTimestamp: Date.now() });
        },
        editReply(payload) {
            editPayload = payload;
            return Promise.resolve(payload);
        }
    };

    await information.handle(interaction, interaction.client, {});
    assert.ok(initialReply);
    assert.ok(editPayload);
    assert.equal(editPayload.embeds.length, 1);
    assert.equal(editPayload.components.length, 1);
    const embedJson = editPayload.embeds[0].toJSON();
    assert.equal(embedJson.fields.length, 4);
    assert.equal(embedJson.fields[0].name, "🪪 1. ข้อมูลบัญชี & อายุ (Account Details)");
    assert.equal(embedJson.fields[1].name, "🏠 2. ข้อมูลในเซิร์ฟเวอร์นี้ (Server Profile)");
    assert.equal(embedJson.fields[2].name, "🛡️ 3. ยศและสิทธิ์ในเซิร์ฟเวอร์ (Roles & Permissions)");
    assert.equal(embedJson.fields[3].name, "🧭 4. สถานะสมาชิก & กิจกรรม (Member Status)");
});


