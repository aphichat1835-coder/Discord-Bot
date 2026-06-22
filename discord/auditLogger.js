/* eslint-disable complexity -- Audit event handlers are intentionally explicit per Discord event. */
/*
================================================================================
Advanced Audit Logger v3
- Koya-style readable logs
- detailed IDs / before-after / evidence
- queue + debounce via logCore
- message snapshot cache via auditHelpers
- moderation/protection-ready records
================================================================================
*/

const config = require("./config.json");
const { LOG_CHANNEL_TYPES, safeAuditText, routeAndSendLog } = require("./logging/logCore");
const { buildLogEmbed, field, formatDiscordTime, jumpLink } = require("./logging/logFormat");
const {
    fetchAuditEntry,
    defaultMessageSnapshots,
    diffRolePermissions,
    diffPermissionOverwrites,
    formatPermissionList,
    formatOverwriteDiff
} = require("./logging/auditHelpers");
const securityRules = require("./logging/securityRules");
const modCaseManager = require("./logging/modCaseManager");

const registeredClients = new WeakSet();
const auditStats = {
    sent: 0,
    failed: 0,
    snapshots: 0,
    skippedBots: 0,
    duplicateSkipped: 0,
    lastError: null
};
const recentEventKeys = new Map();
let cleanupTimer = null;

const LOG_MESSAGE_CREATE = String(process.env.AUDIT_LOG_MESSAGE_CREATE || "false").toLowerCase() === "true";
const DUPLICATE_TTL_MS = Math.max(1000, Number(process.env.AUDIT_DUPLICATE_TTL_MS || 2500) || 2500);

function now() { return Date.now(); }
function isBot(user) { return !!user?.bot; }

function tag(user) {
    if (!user) return "ไม่ทราบ";
    return user.tag || user.username || user.globalName || user.id || "Unknown";
}

function userMention(id) { return id ? `<@${id}>` : "ไม่ทราบ"; }
function roleMention(id) { return id ? `<@&${id}>` : "ไม่ทราบ"; }
function channelMention(id) { return id ? `<#${id}>` : "ไม่ทราบ"; }
function boolText(value) { return value ? "ใช่" : "ไม่ใช่"; }
function noneText(value) { return value === null || value === undefined || value === "" ? "None" : safeAuditText(value, 240); }
function code(value, max = 100) { return `\`${safeAuditText(value ?? "-", max)}\``; }

function idFields(ids = {}) {
    const out = [];
    if (ids.userId) out.push(field("User ID", code(ids.userId), true));
    if (ids.executorId) out.push(field("Executor ID", code(ids.executorId), true));
    if (ids.channelId) out.push(field("Channel ID", code(ids.channelId), true));
    if (ids.messageId) out.push(field("Message ID", code(ids.messageId), true));
    if (ids.roleId) out.push(field("Role ID", code(ids.roleId), true));
    return out;
}

function executorFields(entry) {
    if (!entry?.executor) return [field("👮 ผู้ดำเนินการ", "Unknown / audit log ไม่พบ", true)];
    return [
        field("👮 ผู้ดำเนินการ", `${userMention(entry.executor.id)} (${code(tag(entry.executor), 90)})`, true),
        field("Executor ID", code(entry.executor.id), true)
    ];
}

function channelLabel(channel) {
    if (!channel) return "ไม่ทราบ";
    return `${channelMention(channel.id)} (${code(channel.id)})`;
}

function userLabel(user) {
    if (!user) return "ไม่ทราบ";
    return `${userMention(user.id)} (${code(tag(user), 90)})`;
}

function memberLabel(member) { return userLabel(member?.user || member); }

function pinActionTitle(action) {
    if (action === "MESSAGE_UNPIN") return "📌 Unpin ข้อความ";
    if (action === "MESSAGE_PIN") return "📌 Pin ข้อความ";
    return "📌 Pin/Unpin เปลี่ยนแปลง";
}

function roleSeverity(severity) {
    if (severity === "critical") return "critical";
    if (severity === "danger") return "danger";
    return "warning";
}

function integrationPresentation(action) {
    if (action === "INTEGRATION_CREATE") return { severity: "success", title: "🔌 Integration เพิ่ม" };
    if (action === "INTEGRATION_DELETE") return { severity: "danger", title: "🔌 Integration ลบ" };
    return { severity: "warning", title: "🔌 Integration เปลี่ยนแปลง" };
}

function shouldSkipDuplicate(key, ttlMs = DUPLICATE_TTL_MS) {
    const t = recentEventKeys.get(key) || 0;
    if (now() - t < ttlMs) {
        auditStats.duplicateSkipped += 1;
        return true;
    }
    recentEventKeys.set(key, now());
    return false;
}

function cleanupCaches() {
    const cutoff = now() - 10 * 60 * 1000;
    for (const [key, ts] of recentEventKeys.entries()) {
        if (ts < cutoff) recentEventKeys.delete(key);
    }
    defaultMessageSnapshots.cleanup();
}

function startAuditCleanup() {
    if (cleanupTimer) return;
    cleanupTimer = setInterval(cleanupCaches, 5 * 60 * 1000);
    cleanupTimer.unref?.();
}

function stopAuditCleanup() {
    if (!cleanupTimer) return;
    clearInterval(cleanupTimer);
    cleanupTimer = null;
}

function getAuditStats() {
    return {
        ...auditStats,
        duplicateKeys: recentEventKeys.size,
        messageSnapshots: defaultMessageSnapshots.stats(),
        cleanupTimerActive: !!cleanupTimer
    };
}

async function sendAuditLog(guild, sessionManager, type, embed, options = {}) {
    try {
        const ok = await routeAndSendLog({
            guild,
            sessionManager,
            category: type,
            embed,
            debounceKey: options.debounceKey,
            debounceMs: options.debounceMs || 0
        });
        if (ok) auditStats.sent += 1;
        else auditStats.failed += 1;
        return ok;
    } catch (err) {
        auditStats.failed += 1;
        auditStats.lastError = safeAuditText(err?.message || err, 300);
        return false;
    }
}

function buildEmbed(options) { return buildLogEmbed(options); }

async function resolvePartial(value) {
    if (value?.partial && typeof value.fetch === "function") return value.fetch().catch(() => value);
    return value;
}

function snapshot(message) {
    const data = defaultMessageSnapshots.snapshot(message);
    if (data) auditStats.snapshots += 1;
    return data;
}

function messageData(message) {
    const guildId = message?.guild?.id || message?.channel?.guild?.id || null;
    const cached = guildId && message?.id ? defaultMessageSnapshots.get(guildId, message.id) : null;
    const currentAttachments = Array.from(message?.attachments?.values?.() || []).map(a => ({
        id: a.id,
        name: a.name || a.filename || "attachment",
        url: a.url,
        proxyURL: a.proxyURL,
        size: a.size,
        contentType: a.contentType
    }));
    return {
        guildId,
        messageId: message?.id || cached?.messageId || null,
        channelId: message?.channel?.id || message?.channelId || cached?.channelId || null,
        authorId: message?.author?.id || cached?.authorId || null,
        authorTag: message?.author?.tag || cached?.authorTag || "Unknown",
        content: message?.content || cached?.content || "",
        attachments: currentAttachments.length ? currentAttachments : (cached?.attachments || []),
        createdAt: message?.createdTimestamp || cached?.createdAt || null,
        editedAt: message?.editedTimestamp || cached?.editedAt || null,
        cached
    };
}

function attachmentFieldsFor(list = []) {
    if (!list.length) return [];
    const totalSize = list.reduce((sum, item) => sum + (Number(item.size) || 0), 0);
    const lines = list.slice(0, 10).map((item, index) => {
        const label = item.name || `attachment-${index + 1}`;
        return item.url ? `• [${safeAuditText(label, 80)}](${item.url})` : `• ${safeAuditText(label, 80)}`;
    });
    if (list.length > 10) lines.push(`... และอีก ${list.length - 10} ไฟล์`);
    return [
        field("📎 ไฟล์แนบ", lines.join("\n"), false),
        field("Attachment Count", code(list.length), true),
        field("Attachment Size", totalSize ? code(`${Math.round(totalSize / 1024)} KB`) : "Unknown", true)
    ];
}

function imagePreview(list = []) {
    const image = list.find(item => /\.(png|jpe?g|gif|webp)(\?|$)/i.test(String(item.url || item.proxyURL || "")));
    return image?.url || image?.proxyURL || null;
}

function messageLink(guildId, channelId, messageId) { return jumpLink(guildId, channelId, messageId); }

function contentValue(value, empty = "*ว่างเปล่า / ไม่มีข้อมูลในแคช*") {
    if (!value) return empty;
    return safeAuditText(value, 1000);
}

async function maybeCreateModerationRecord(input = {}) {
    const { sessionManager, guild, action, user, executor, reason, evidence = [], metadata = {} } = input;
    if (!guild?.id || !user?.id) return null;
    if (executor?.id === guild.client?.user?.id) return null;
    return modCaseManager.createCase(sessionManager, {
        guildId: guild.id,
        action,
        type: action,
        userId: user.id,
        moderatorId: executor?.id || null,
        reason: reason || "Audit log action",
        evidence,
        source: "discord_audit_log",
        metadata
    }).catch(() => null);
}

function registerMessageEvents(client, sessionManager) {
    client.on("messageCreate", async (message) => {
        if (!message.guild || isBot(message.author)) return;
        snapshot(message);
        if (!LOG_MESSAGE_CREATE) return;
        if (shouldSkipDuplicate(`msg-create:${message.guild.id}:${message.id}`)) return;
        const data = messageData(message);
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MESSAGE,
            severity: "info",
            title: "💬 ข้อความถูกส่ง",
            author: message.author,
            thumbnailUser: message.author,
            description: contentValue(data.content),
            guildId: data.guildId,
            channelId: data.channelId,
            messageId: data.messageId,
            attachments: data.attachments,
            image: imagePreview(data.attachments),
            fields: [
                field("👤 ผู้ส่ง", userLabel(message.author), true),
                field("📌 ห้อง", channelLabel(message.channel), true),
                ...idFields({ userId: data.authorId, channelId: data.channelId, messageId: data.messageId })
            ]
        });
        await sendAuditLog(message.guild, sessionManager, LOG_CHANNEL_TYPES.MESSAGE, embed);
    });

    client.on("messageUpdate", async (oldMsg, newMsg) => {
        oldMsg = await resolvePartial(oldMsg);
        newMsg = await resolvePartial(newMsg);
        const guild = newMsg?.guild || oldMsg?.guild || newMsg?.channel?.guild || oldMsg?.channel?.guild;
        if (!guild) return;
        const author = newMsg.author || oldMsg.author;
        if (isBot(author)) return;
        const before = messageData(oldMsg);
        const after = messageData(newMsg);
        if ((before.content || "") === (after.content || "") && before.attachments.length === after.attachments.length) return;
        snapshot(newMsg);
        const link = messageLink(after.guildId, after.channelId, after.messageId);
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MESSAGE,
            severity: "warning",
            title: `${config.emojis.pencil} ข้อความถูกแก้ไข`,
            author,
            thumbnailUser: author,
            guildId: after.guildId,
            channelId: after.channelId,
            messageId: after.messageId,
            jumpLink: link,
            messageCreatedAt: after.createdAt,
            fields: [
                field("👤 ผู้ส่ง", userLabel(author), true),
                field("📌 ห้อง", channelMention(after.channelId), true),
                field("📄 ก่อน", contentValue(before.content, "*ไม่มีข้อมูลเดิม*"), false),
                field("✏️ หลัง", contentValue(after.content, "*ไม่มีข้อมูลใหม่*"), false),
                ...attachmentFieldsFor(after.attachments),
                ...idFields({ userId: after.authorId, channelId: after.channelId, messageId: after.messageId })
            ]
        });
        await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.MESSAGE, embed);
    });

    const recentBulkChannels = new Map();

    client.on("messageDelete", async (message) => {
        message = await resolvePartial(message);
        const guild = message?.guild || message?.channel?.guild;
        if (!guild) return;
        const data = messageData(message);
        if (isBot(message.author)) return;
        const bulkTs = data.channelId ? recentBulkChannels.get(data.channelId) : null;
        if (bulkTs && now() - bulkTs < 3000) return;
        if (shouldSkipDuplicate(`msg-delete:${guild.id}:${data.messageId}`)) return;

        let entry = null;
        if (data.authorId) entry = await fetchAuditEntry(guild, "MESSAGE_DELETE", data.authorId, { channelId: data.channelId });
        const deleter = entry?.executor || null;
        const link = messageLink(data.guildId, data.channelId, data.messageId);
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MESSAGE,
            severity: "danger",
            title: `${config.emojis.trash} ข้อความถูกลบ`,
            author: message.author || null,
            thumbnailUser: message.author || null,
            guildId: data.guildId,
            channelId: data.channelId,
            messageId: data.messageId,
            jumpLink: link,
            messageCreatedAt: data.createdAt,
            attachments: data.attachments,
            image: imagePreview(data.attachments),
            fields: [
                field("👤 ผู้ส่ง", data.authorId ? `${userMention(data.authorId)} (${code(data.authorTag, 90)})` : "Unknown", true),
                field("📌 ห้อง", channelMention(data.channelId), true),
                ...(deleter ? [field("🗑️ ลบโดย", `${userMention(deleter.id)} (${code(tag(deleter), 90)})`, true)] : [field("🗑️ ลบโดย", "Unknown / เจ้าของลบเอง / audit log ไม่พบ", true)]),
                field("📄 เนื้อหา", contentValue(data.content), false),
                ...attachmentFieldsFor(data.attachments),
                ...idFields({ userId: data.authorId, executorId: deleter?.id, channelId: data.channelId, messageId: data.messageId })
            ],
            footer: data.cached ? "Message snapshot cache used" : "Live/partial message data"
        });
        await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.MESSAGE, embed);
    });

    client.on("messageDeleteBulk", async (messages) => {
        const first = messages.first();
        const guild = first?.guild || first?.channel?.guild;
        if (!guild) return;
        recentBulkChannels.set(first.channel.id, now());
        setTimeout(() => recentBulkChannels.delete(first.channel.id), 3000).unref?.();
        const entry = await fetchAuditEntry(guild, "MESSAGE_BULK_DELETE", first.channel.id, { channelId: first.channel.id, delayMs: 1000 });
        const samples = messages.first(8).map(msg => {
            const data = messageData(msg);
            return `• ${code(data.messageId)} by ${data.authorId ? userMention(data.authorId) : "Unknown"}: ${safeAuditText(data.content || "[no cached content]", 120)}`;
        });
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MESSAGE,
            severity: "danger",
            title: `${config.emojis.broom} ลบข้อความหมู่`,
            noThumbnail: true,
            guildId: guild.id,
            channelId: first.channel.id,
            fields: [
                field("📌 ห้อง", channelLabel(first.channel), true),
                field("🔢 จำนวน", code(messages.size), true),
                ...executorFields(entry),
                field("🧩 ตัวอย่างหลักฐาน", samples.join("\n") || "ไม่มีข้อมูลในแคช", false),
                field("Channel ID", code(first.channel.id), true)
            ]
        });
        await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.MESSAGE, embed);
    });

    client.on("channelPinsUpdate", async (channel) => {
        if (!channel.guild) return;
        const entry = await fetchAuditEntry(channel.guild, null, channel.id, { channelId: channel.id, delayMs: 1200 }).catch(() => null);
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MESSAGE,
            severity: "info",
            title: pinActionTitle(entry?.action),
            noThumbnail: true,
            channelId: channel.id,
            fields: [field("📌 ห้อง", channelLabel(channel), true), ...executorFields(entry)]
        });
        await sendAuditLog(channel.guild, sessionManager, LOG_CHANNEL_TYPES.MESSAGE, embed);
    });

    async function reactionLog(type, reaction, user) {
        if (isBot(user)) return;
        reaction = await resolvePartial(reaction);
        const msg = await resolvePartial(reaction.message);
        const guild = msg?.guild || msg?.channel?.guild;
        if (!guild) return;
        const data = messageData(msg);
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MESSAGE,
            severity: type === "add" ? "success" : "warning",
            title: type === "add" ? "➕ Reaction เพิ่ม" : "➖ Reaction ลบ",
            author: user,
            thumbnailUser: user,
            guildId: data.guildId,
            channelId: data.channelId,
            messageId: data.messageId,
            jumpLink: messageLink(data.guildId, data.channelId, data.messageId),
            fields: [
                field(type === "add" ? "👤 ผู้กด" : "👤 ผู้ลบ", userLabel(user), true),
                field("😀 Reaction", safeAuditText(String(reaction.emoji), 80), true),
                field("📌 ห้อง", channelMention(data.channelId), true),
                ...idFields({ userId: user.id, channelId: data.channelId, messageId: data.messageId })
            ]
        });
        await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.MESSAGE, embed);
    }

    client.on("messageReactionAdd", (reaction, user) => reactionLog("add", reaction, user));
    client.on("messageReactionRemove", (reaction, user) => reactionLog("remove", reaction, user));
}

function registerMemberEvents(client, sessionManager) {
    client.on("guildMemberAdd", async (member) => {
        if (member.user.bot) return;
        const ageDays = Math.floor((now() - member.user.createdTimestamp) / 86400000);
        const risk = ageDays < config.risk_thresholds.newAccountAgeDays;
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MEMBER,
            severity: risk ? "danger" : "success",
            title: `${config.emojis.success} สมาชิกใหม่เข้าร่วม`,
            author: member.user,
            thumbnailUser: member.user,
            target: member,
            fields: [
                field("👤 ผู้ใช้", memberLabel(member), true),
                field("🏷️ Tag", code(tag(member.user), 90), true),
                field("🎂 สร้างบัญชี", formatDiscordTime(member.user.createdTimestamp, "R"), true),
                field("📆 วันที่สร้าง", formatDiscordTime(member.user.createdTimestamp, "F"), false),
                field("📊 อายุบัญชี", `${ageDays} วัน${risk ? " — HIGH RISK" : ""}`, true),
                ...idFields({ userId: member.id })
            ]
        });
        await sendAuditLog(member.guild, sessionManager, LOG_CHANNEL_TYPES.MEMBER, embed);
    });

    client.on("guildMemberRemove", async (member) => {
        if (member.user.bot) return;
        const entry = await fetchAuditEntry(member.guild, "MEMBER_KICK", member.id);
        const kicked = !!entry;
        const caseDoc = kicked ? await maybeCreateModerationRecord({
            sessionManager,
            guild: member.guild,
            action: "kick",
            user: member.user,
            executor: entry.executor,
            reason: entry.reason || "Manual kick detected from audit log",
            evidence: ["Manual kick detected", `Target: ${tag(member.user)} (${member.id})`],
            metadata: { sourceEvent: "guildMemberRemove" }
        }) : null;
        const embed = buildLogEmbed({
            category: kicked ? LOG_CHANNEL_TYPES.MODERATION : LOG_CHANNEL_TYPES.MEMBER,
            severity: kicked ? "danger" : "warning",
            title: kicked ? `${config.emojis.error} สมาชิกถูก Kick` : `${config.emojis.wave} สมาชิกออกจากเซิร์ฟเวอร์`,
            author: member.user,
            thumbnailUser: member.user,
            target: member,
            reason: entry?.reason || null,
            fields: [
                field("👤 สมาชิก", memberLabel(member), true),
                field("📅 เข้าร่วมเมื่อ", member.joinedTimestamp ? formatDiscordTime(member.joinedTimestamp, "R") : "Unknown", true),
                ...executorFields(entry),
                ...(caseDoc ? [field("Log Record", code(`#${caseDoc.caseNumber}`), true)] : []),
                ...idFields({ userId: member.id, executorId: entry?.executor?.id })
            ]
        });
        await sendAuditLog(member.guild, sessionManager, kicked ? LOG_CHANNEL_TYPES.MODERATION : LOG_CHANNEL_TYPES.MEMBER, embed);
    });

    client.on("guildBanAdd", async (ban) => {
        const entry = await fetchAuditEntry(ban.guild, "MEMBER_BAN_ADD", ban.user.id);
        const caseDoc = await maybeCreateModerationRecord({
            sessionManager,
            guild: ban.guild,
            action: "ban",
            user: ban.user,
            executor: entry?.executor,
            reason: ban.reason || entry?.reason || "Manual ban detected from audit log",
            evidence: ["Manual ban detected", `Target: ${tag(ban.user)} (${ban.user.id})`],
            metadata: { sourceEvent: "guildBanAdd" }
        });
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MODERATION,
            severity: "danger",
            title: "🔨 สมาชิกถูก Ban",
            author: ban.user,
            thumbnailUser: ban.user,
            targetId: ban.user.id,
            reason: ban.reason || entry?.reason || "ไม่ระบุ",
            fields: [
                field("👤 ผู้ถูก Ban", userLabel(ban.user), true),
                ...executorFields(entry),
                ...(caseDoc ? [field("Log Record", code(`#${caseDoc.caseNumber}`), true)] : []),
                ...idFields({ userId: ban.user.id, executorId: entry?.executor?.id })
            ]
        });
        await sendAuditLog(ban.guild, sessionManager, LOG_CHANNEL_TYPES.MODERATION, embed);
    });

    client.on("guildBanRemove", async (ban) => {
        const entry = await fetchAuditEntry(ban.guild, "MEMBER_BAN_REMOVE", ban.user.id);
        const embed = buildLogEmbed({
            category: LOG_CHANNEL_TYPES.MODERATION,
            severity: "success",
            title: "✅ Ban ถูกยกเลิก",
            author: ban.user,
            thumbnailUser: ban.user,
            targetId: ban.user.id,
            fields: [field("👤 ผู้ถูก Unban", userLabel(ban.user), true), ...executorFields(entry), ...idFields({ userId: ban.user.id, executorId: entry?.executor?.id })]
        });
        await sendAuditLog(ban.guild, sessionManager, LOG_CHANNEL_TYPES.MODERATION, embed);
    });

    client.on("guildMemberUpdate", async (oldMember, newMember) => {
        if (newMember.user.bot) return;
        const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
        const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id));
        const nickChanged = oldMember.nickname !== newMember.nickname;
        const oldTimeout = oldMember.communicationDisabledUntilTimestamp;
        const newTimeout = newMember.communicationDisabledUntilTimestamp;
        const timeoutChanged = oldTimeout !== newTimeout;
        const avatarChanged = oldMember.avatar !== newMember.avatar;

        if (addedRoles.size || removedRoles.size) {
            const entry = await fetchAuditEntry(newMember.guild, "MEMBER_ROLE_UPDATE", newMember.id);
            const embed = buildLogEmbed({
                category: LOG_CHANNEL_TYPES.MEMBER,
                severity: "info",
                title: `${config.emojis.role_icon} ยศสมาชิกเปลี่ยน`,
                author: newMember.user,
                thumbnailUser: newMember.user,
                fields: [
                    field("👤 สมาชิก", memberLabel(newMember), true),
                    ...executorFields(entry),
                    ...(addedRoles.size ? [field("✅ เพิ่มยศ", addedRoles.map(r => `${roleMention(r.id)} (${code(r.id)})`).join("\n"), false)] : []),
                    ...(removedRoles.size ? [field("❌ ลบยศ", removedRoles.map(r => `${roleMention(r.id)} (${code(r.id)})`).join("\n"), false)] : []),
                    ...idFields({ userId: newMember.id, executorId: entry?.executor?.id })
                ]
            });
            await sendAuditLog(newMember.guild, sessionManager, LOG_CHANNEL_TYPES.MEMBER, embed);
        }

        if (nickChanged) {
            const entry = await fetchAuditEntry(newMember.guild, "MEMBER_UPDATE", newMember.id);
            const embed = buildLogEmbed({
                category: LOG_CHANNEL_TYPES.MEMBER,
                severity: "warning",
                title: "✏️ Nickname เปลี่ยน",
                author: newMember.user,
                thumbnailUser: newMember.user,
                fields: [
                    field("👤 สมาชิก", memberLabel(newMember), true),
                    ...executorFields(entry),
                    field("📛 ก่อน", code(noneText(oldMember.nickname), 250), false),
                    field("📛 หลัง", code(noneText(newMember.nickname), 250), false),
                    ...idFields({ userId: newMember.id, executorId: entry?.executor?.id })
                ]
            });
            await sendAuditLog(newMember.guild, sessionManager, LOG_CHANNEL_TYPES.MEMBER, embed);
        }

        if (timeoutChanged) {
            const isAdded = !!newTimeout && newTimeout > now();
            const entry = await fetchAuditEntry(newMember.guild, "MEMBER_UPDATE", newMember.id);
            const caseDoc = isAdded ? await maybeCreateModerationRecord({
                sessionManager,
                guild: newMember.guild,
                action: "timeout",
                user: newMember.user,
                executor: entry?.executor,
                reason: entry?.reason || "Manual timeout detected from audit log",
                evidence: [`Timeout until: ${newTimeout}`],
                metadata: { sourceEvent: "guildMemberUpdate", timeoutUntil: newTimeout }
            }) : null;
            const embed = buildLogEmbed({
                category: isAdded ? LOG_CHANNEL_TYPES.MODERATION : LOG_CHANNEL_TYPES.MEMBER,
                severity: isAdded ? "danger" : "success",
                title: isAdded ? "⏱️ Timeout เพิ่ม" : "⏱️ Timeout หมดอายุ/ถูกยกเลิก",
                author: newMember.user,
                thumbnailUser: newMember.user,
                reason: entry?.reason || null,
                fields: [
                    field("👤 สมาชิก", memberLabel(newMember), true),
                    ...(isAdded ? [field("⏰ หมดอายุ", formatDiscordTime(newTimeout, "R"), true)] : [field("ก่อนหน้า", oldTimeout ? formatDiscordTime(oldTimeout, "R") : "Unknown", true)]),
                    ...executorFields(entry),
                    ...(caseDoc ? [field("Log Record", code(`#${caseDoc.caseNumber}`), true)] : []),
                    ...idFields({ userId: newMember.id, executorId: entry?.executor?.id })
                ]
            });
            await sendAuditLog(newMember.guild, sessionManager, isAdded ? LOG_CHANNEL_TYPES.MODERATION : LOG_CHANNEL_TYPES.MEMBER, embed);
        }

        if (avatarChanged) {
            const embed = buildLogEmbed({
                category: LOG_CHANNEL_TYPES.MEMBER,
                severity: "info",
                title: "🖼️ Server Avatar เปลี่ยน",
                author: newMember.user,
                thumbnailUser: newMember.user,
                image: newMember.displayAvatarURL({ dynamic: true, size: 512 }),
                fields: [field("👤 สมาชิก", memberLabel(newMember), true), ...idFields({ userId: newMember.id })]
            });
            await sendAuditLog(newMember.guild, sessionManager, LOG_CHANNEL_TYPES.MEMBER, embed);
        }
    });
}

function registerVoiceEvents(client, sessionManager) {
    client.on("voiceStateUpdate", async (oldState, newState) => {
        const member = newState.member || oldState.member;
        if (!member || isBot(member.user)) return;
        const user = member.user;
        const guild = newState.guild || oldState.guild;

        if (!oldState.channelId && newState.channelId) {
            const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.VOICE, severity: "success", title: `${config.emojis.voice_ch} เข้าห้องเสียง`, author: user, thumbnailUser: user, fields: [field("👤 ผู้ใช้", memberLabel(member), true), field("🔊 ห้อง", channelMention(newState.channelId), true), ...idFields({ userId: member.id, channelId: newState.channelId })] });
            return sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.VOICE, embed);
        }

        if (oldState.channelId && !newState.channelId) {
            const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.VOICE, severity: "danger", title: `${config.emojis.voice_leave} ออกจากห้องเสียง`, author: user, thumbnailUser: user, fields: [field("👤 ผู้ใช้", memberLabel(member), true), field("🔇 ห้องเดิม", channelMention(oldState.channelId), true), ...idFields({ userId: member.id, channelId: oldState.channelId })] });
            return sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.VOICE, embed);
        }

        if (oldState.channelId && newState.channelId && oldState.channelId !== newState.channelId) {
            const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.VOICE, severity: "info", title: `${config.emojis.voice_move} ย้ายห้องเสียง`, author: user, thumbnailUser: user, fields: [field("👤 ผู้ใช้", memberLabel(member), true), field("📤 จากห้อง", channelMention(oldState.channelId), true), field("📥 ไปห้อง", channelMention(newState.channelId), true), ...idFields({ userId: member.id, channelId: newState.channelId })] });
            return sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.VOICE, embed);
        }

        const changes = [];
        if (oldState.serverMute !== newState.serverMute) changes.push({ title: newState.serverMute ? "🔇 ถูก Server Mute" : "🔊 ยกเลิก Server Mute", severity: newState.serverMute ? "danger" : "success" });
        if (oldState.serverDeaf !== newState.serverDeaf) changes.push({ title: newState.serverDeaf ? "🔕 ถูก Server Deafen" : "🔔 ยกเลิก Server Deafen", severity: newState.serverDeaf ? "danger" : "success" });
        if (oldState.selfMute !== newState.selfMute) changes.push({ title: newState.selfMute ? "🎤 Self Mute เปิด" : "🎤 Self Mute ปิด", severity: newState.selfMute ? "warning" : "success" });
        if (oldState.selfDeaf !== newState.selfDeaf) changes.push({ title: newState.selfDeaf ? "🎧 Self Deafen เปิด" : "🎧 Self Deafen ปิด", severity: newState.selfDeaf ? "warning" : "success" });
        if (oldState.selfVideo !== newState.selfVideo) changes.push({ title: newState.selfVideo ? "📷 เปิดกล้อง" : "📷 ปิดกล้อง", severity: newState.selfVideo ? "info" : "warning" });
        if (oldState.streaming !== newState.streaming) changes.push({ title: newState.streaming ? "🖥️ เริ่ม Screen Share" : "🖥️ หยุด Screen Share", severity: newState.streaming ? "info" : "warning" });

        for (const ch of changes) {
            const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.VOICE, severity: ch.severity, title: ch.title, author: user, thumbnailUser: user, fields: [field("👤 ผู้ใช้", memberLabel(member), true), field("🔊 ห้อง", newState.channelId ? channelMention(newState.channelId) : "ไม่ได้อยู่ในห้อง", true), ...idFields({ userId: member.id, channelId: newState.channelId || oldState.channelId })] });
            await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.VOICE, embed);
        }
    });
}

function channelTypeName(channel) { return channel?.type || "unknown"; }
function baseChannelFields(channel) { return [field("📌 ชื่อ", code(channel?.name, 120), true), field("📂 ประเภท", code(channelTypeName(channel), 60), true), field("🆔 Channel ID", code(channel?.id), true)]; }

function registerServerEvents(client, sessionManager) {
    client.on("channelCreate", async (channel) => {
        if (!channel.guild) return;
        const entry = await fetchAuditEntry(channel.guild, "CHANNEL_CREATE", channel.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "success", title: `${config.emojis.plus} ห้องใหม่ถูกสร้าง`, noThumbnail: true, fields: [...baseChannelFields(channel), field("Parent", channel.parentId ? channelMention(channel.parentId) : "None", true), ...executorFields(entry)] });
        await sendAuditLog(channel.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("channelDelete", async (channel) => {
        if (!channel.guild) return;
        const entry = await fetchAuditEntry(channel.guild, "CHANNEL_DELETE", channel.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "danger", title: `${config.emojis.trash} ห้องถูกลบ`, noThumbnail: true, fields: [...baseChannelFields(channel), field("Parent", channel.parentId ? channelMention(channel.parentId) : "None", true), ...executorFields(entry)] });
        await sendAuditLog(channel.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("channelUpdate", async (oldChannel, newChannel) => {
        if (!newChannel.guild) return;
        const changes = [];
        if (oldChannel.name !== newChannel.name) changes.push(field("📛 ชื่อ", `${code(oldChannel.name, 120)} → ${code(newChannel.name, 120)}`, false));
        if (oldChannel.topic !== newChannel.topic) changes.push(field("📝 Topic", `${code(noneText(oldChannel.topic), 300)} → ${code(noneText(newChannel.topic), 300)}`, false));
        if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) changes.push(field("🐢 Slowmode", `${code(oldChannel.rateLimitPerUser || 0)} → ${code(newChannel.rateLimitPerUser || 0)}`, true));
        if (oldChannel.parentId !== newChannel.parentId) changes.push(field("📂 Category", `${oldChannel.parentId ? channelMention(oldChannel.parentId) : "None"} → ${newChannel.parentId ? channelMention(newChannel.parentId) : "None"}`, false));
        const overwriteDiff = diffPermissionOverwrites(oldChannel.permissionOverwrites?.cache, newChannel.permissionOverwrites?.cache);
        if (overwriteDiff.length) changes.push(field("🔒 Permission Overwrite", formatOverwriteDiff(overwriteDiff).join("\n\n"), false));
        if (!changes.length) return;
        const entry = await fetchAuditEntry(newChannel.guild, "CHANNEL_UPDATE", newChannel.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: overwriteDiff.length ? "warning" : "info", title: "⚙️ ห้องถูกแก้ไข", noThumbnail: true, fields: [field("📌 ห้อง", channelLabel(newChannel), true), ...executorFields(entry), ...changes, ...idFields({ channelId: newChannel.id, executorId: entry?.executor?.id })] });
        await sendAuditLog(newChannel.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("roleCreate", async (role) => {
        const entry = await fetchAuditEntry(role.guild, "ROLE_CREATE", role.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "success", title: `${config.emojis.role_icon} ยศใหม่ถูกสร้าง`, noThumbnail: true, fields: [field("🎭 ชื่อ", code(role.name, 120), true), field("🎨 สี", code(role.hexColor), true), field("Hoist", boolText(role.hoist), true), field("Mentionable", boolText(role.mentionable), true), field("Permissions", formatPermissionList(role.permissions.toArray(), 15), false), ...executorFields(entry), ...idFields({ roleId: role.id, executorId: entry?.executor?.id })] });
        await sendAuditLog(role.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("roleDelete", async (role) => {
        const entry = await fetchAuditEntry(role.guild, "ROLE_DELETE", role.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "danger", title: `${config.emojis.trash} ยศถูกลบ`, noThumbnail: true, fields: [field("🎭 ชื่อ", code(role.name, 120), true), field("🎨 สีเดิม", code(role.hexColor), true), field("Permissions", formatPermissionList(role.permissions.toArray(), 15), false), ...executorFields(entry), ...idFields({ roleId: role.id, executorId: entry?.executor?.id })] });
        await sendAuditLog(role.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("roleUpdate", async (oldRole, newRole) => {
        const changes = [];
        if (oldRole.name !== newRole.name) changes.push(field("📛 ชื่อ", `${code(oldRole.name, 120)} → ${code(newRole.name, 120)}`, false));
        if (oldRole.color !== newRole.color) changes.push(field("🎨 สี", `${code(oldRole.hexColor)} → ${code(newRole.hexColor)}`, true));
        if (oldRole.hoist !== newRole.hoist) changes.push(field("📌 Hoist", `${code(oldRole.hoist)} → ${code(newRole.hoist)}`, true));
        if (oldRole.mentionable !== newRole.mentionable) changes.push(field("🔔 Mentionable", `${code(oldRole.mentionable)} → ${code(newRole.mentionable)}`, true));
        const permDiff = diffRolePermissions(oldRole, newRole);
        const risk = securityRules.scorePermissionChange(permDiff);
        if (permDiff.added.length) changes.push(field("✅ Permission เพิ่ม", formatPermissionList(permDiff.added, 15), false));
        if (permDiff.removed.length) changes.push(field("❌ Permission ลบ", formatPermissionList(permDiff.removed, 15), false));
        if (risk.dangerous.added.length) changes.push(field("🚨 Dangerous Permission", risk.dangerous.added.map(p => code(p)).join(", "), false));
        if (!changes.length) return;
        const entry = await fetchAuditEntry(newRole.guild, "ROLE_UPDATE", newRole.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: roleSeverity(risk.severity), title: `${config.emojis.role_icon} ยศถูกแก้ไข`, noThumbnail: true, fields: [field("🎭 ยศ", `${roleMention(newRole.id)} (${code(newRole.id)})`, true), ...executorFields(entry), ...changes] });
        await sendAuditLog(newRole.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("guildUpdate", async (oldGuild, newGuild) => {
        const changes = [];
        if (oldGuild.name !== newGuild.name) changes.push(field("📛 ชื่อเซิร์ฟเวอร์", `${code(oldGuild.name, 160)} → ${code(newGuild.name, 160)}`, false));
        if (oldGuild.icon !== newGuild.icon) changes.push(field("🖼️ Icon", "เปลี่ยนแปลง", true));
        if (oldGuild.banner !== newGuild.banner) changes.push(field("🏳️ Banner", "เปลี่ยนแปลง", true));
        if (oldGuild.verificationLevel !== newGuild.verificationLevel) changes.push(field("🛡️ Verification Level", `${code(oldGuild.verificationLevel)} → ${code(newGuild.verificationLevel)}`, true));
        if (oldGuild.afkChannelId !== newGuild.afkChannelId) changes.push(field("💤 AFK Channel", `${oldGuild.afkChannelId ? channelMention(oldGuild.afkChannelId) : "None"} → ${newGuild.afkChannelId ? channelMention(newGuild.afkChannelId) : "None"}`, false));
        if (!changes.length) return;
        const entry = await fetchAuditEntry(newGuild, "GUILD_UPDATE", newGuild.id);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "warning", title: "⚙️ เซิร์ฟเวอร์ถูกแก้ไข", thumbnail: newGuild.iconURL?.({ dynamic: true, size: 256 }) || null, fields: [...executorFields(entry), ...changes, field("Guild ID", code(newGuild.id), true)] });
        await sendAuditLog(newGuild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("emojiCreate", async (emoji) => sendSimpleAssetLog(emoji.guild, sessionManager, "😀 Emoji ใหม่ถูกเพิ่ม", "success", emoji.name, emoji.id, emoji.url));
    client.on("emojiDelete", async (emoji) => sendSimpleAssetLog(emoji.guild, sessionManager, "😀 Emoji ถูกลบ", "danger", emoji.name, emoji.id, emoji.url));
    client.on("emojiUpdate", async (oldEmoji, newEmoji) => sendSimpleUpdateLog(newEmoji.guild, sessionManager, "😀 Emoji ถูกแก้ไข", oldEmoji.name, newEmoji.name, newEmoji.id));
    client.on("stickerCreate", async (sticker) => sendSimpleAssetLog(sticker.guild, sessionManager, "🪄 Sticker ใหม่ถูกเพิ่ม", "success", sticker.name, sticker.id, sticker.url));
    client.on("stickerDelete", async (sticker) => sendSimpleAssetLog(sticker.guild, sessionManager, "🪄 Sticker ถูกลบ", "danger", sticker.name, sticker.id, sticker.url));
    client.on("stickerUpdate", async (oldSticker, newSticker) => sendSimpleUpdateLog(newSticker.guild, sessionManager, "🪄 Sticker ถูกแก้ไข", oldSticker.name, newSticker.name, newSticker.id));

    client.on("inviteCreate", async (invite) => {
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "success", title: "🔗 Invite ถูกสร้าง", noThumbnail: true, fields: [field("🔗 Code", code(invite.code), true), field("📌 ห้อง", invite.channel?.id ? channelMention(invite.channel.id) : "Unknown", true), field("👤 สร้างโดย", invite.inviter ? userLabel(invite.inviter) : "Unknown", true), field("⏰ หมดอายุ", invite.expiresTimestamp ? formatDiscordTime(invite.expiresTimestamp, "R") : "ไม่หมดอายุ", true), field("🔢 ใช้ได้", invite.maxUses ? code(invite.maxUses) : "ไม่จำกัด", true)] });
        await sendAuditLog(invite.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("inviteDelete", async (invite) => {
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "danger", title: "🔗 Invite ถูกลบ", noThumbnail: true, fields: [field("🔗 Code", code(invite.code), true), field("📌 ห้อง", invite.channel?.id ? channelMention(invite.channel.id) : "Unknown", true)] });
        await sendAuditLog(invite.guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
    });

    client.on("threadCreate", async (thread) => sendThreadLog(thread.guild, sessionManager, "🧵 Thread ถูกสร้าง", "success", thread));
    client.on("threadDelete", async (thread) => sendThreadLog(thread.guild, sessionManager, "🧵 Thread ถูกลบ", "danger", thread));
    client.on("threadUpdate", async (oldThread, newThread) => sendSimpleUpdateLog(newThread.guild, sessionManager, "🧵 Thread ถูกแก้ไข", oldThread.name, newThread.name, newThread.id));

    client.on("webhookUpdate", async (channel) => {
        const entry = await fetchAuditEntry(channel.guild, null, channel.id, { channelId: channel.id, delayMs: 1200 }).catch(() => null);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SECURITY, severity: "danger", title: `${config.emojis.alert} Webhook ในห้องเปลี่ยนแปลง`, noThumbnail: true, fields: [field("📌 ห้อง", channelLabel(channel), true), ...executorFields(entry), field("⚠️ คำเตือน", "มีการสร้าง/แก้ไข/ลบ Webhook — ตรวจสอบทันที", false)] });
        await sendAuditLog(channel.guild, sessionManager, LOG_CHANNEL_TYPES.SECURITY, embed);
    });

    client.on("guildIntegrationsUpdate", async (guild) => {
        const entry = await fetchAuditEntry(guild, null, guild.id, { delayMs: 1200 }).catch(() => null);
        const presentation = integrationPresentation(entry?.action);
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SECURITY, severity: presentation.severity, title: presentation.title, noThumbnail: true, fields: [...executorFields(entry), field("📌 Target", entry?.target?.name || "Unknown", true), field("Guild ID", code(guild.id), true)] });
        await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.SECURITY, embed);
    });
}

async function sendSimpleAssetLog(guild, sessionManager, title, severity, name, id, image) {
    if (!guild) return;
    const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity, title, noThumbnail: true, image, fields: [field("ชื่อ", code(name, 120), true), field("ID", code(id), true)] });
    await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
}

async function sendSimpleUpdateLog(guild, sessionManager, title, oldName, newName, id) {
    if (!guild || oldName === newName) return;
    const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity: "warning", title, noThumbnail: true, fields: [field("ก่อน", code(oldName, 120), true), field("หลัง", code(newName, 120), true), field("ID", code(id), true)] });
    await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
}

async function sendThreadLog(guild, sessionManager, title, severity, thread) {
    if (!guild) return;
    const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SERVER, severity, title, noThumbnail: true, fields: [field("🧵 ชื่อ", code(thread.name, 120), true), field("📌 ห้องหลัก", thread.parentId ? channelMention(thread.parentId) : "Unknown", true), field("Thread ID", code(thread.id), true)] });
    await sendAuditLog(guild, sessionManager, LOG_CHANNEL_TYPES.SERVER, embed);
}

function registerSecurityEvents(client, sessionManager) {
    client.on("guildMemberAdd", async (member) => {
        if (!member.user.bot || member.user.id === client.user?.id) return;
        const entry = await fetchAuditEntry(member.guild, "BOT_ADD", member.id);
        const verified = member.user.flags?.has?.("VERIFIED_BOT") || false;
        const embed = buildLogEmbed({ category: LOG_CHANNEL_TYPES.SECURITY, severity: verified ? "warning" : "critical", title: `${config.emojis.robot} บอทใหม่ถูกเชิญเข้าเซิร์ฟเวอร์`, author: member.user, thumbnailUser: member.user, fields: [field("🤖 บอท", memberLabel(member), true), field("✅ Verified", verified ? "✅ ใช่" : "❌ ไม่ได้ยืนยัน — ตรวจสอบทันที", true), ...executorFields(entry), ...idFields({ userId: member.id, executorId: entry?.executor?.id })] });
        await sendAuditLog(member.guild, sessionManager, LOG_CHANNEL_TYPES.SECURITY, embed);
    });
}

function register(client, sessionManager) {
    startAuditCleanup();
    if (registeredClients.has(client)) {
        console.log("[AUDIT] ℹ️ Audit Logger already registered for this client — skipped duplicate listeners.");
        return;
    }
    registeredClients.add(client);
    registerMessageEvents(client, sessionManager);
    registerMemberEvents(client, sessionManager);
    registerVoiceEvents(client, sessionManager);
    registerServerEvents(client, sessionManager);
    registerSecurityEvents(client, sessionManager);
    console.log("[AUDIT] ✅ Audit Logger v3 registered — detailed Koya-style events active.");
}

module.exports = {
    register,
    sendAuditLog,
    getAuditStats,
    stopAuditCleanup,
    invalidateAuditCache: () => {},
    _test: {
        buildEmbed,
        cleanupCaches,
        defaultMessageSnapshots,
        recentEventKeys
    }
};
