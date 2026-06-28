const { VoiceConnectionStatus } = require("@discordjs/voice");
const sessionManager = require("../sessionManager");
const { st } = require("./state");
const { withTimeoutValue } = require("./config");
const {
    getSessionShortId,
    updateSessionMetadata,
    sanitizeLifecycleError,
} = require("./session");

// ════════════════════════════════════════════════════════════════════════════
//  🧠 REGION 4: SESSION METADATA / DISPLAY HELPERS
// ════════════════════════════════════════════════════════════════════════════
function safeAvatarURL(userLike) {
    try {
        if (!userLike) return null;
        if (typeof userLike.displayAvatarURL === "function") {
            return userLike.displayAvatarURL({ dynamic: true, size: 128 });
        }
        if (typeof userLike.avatarURL === "function") {
            return userLike.avatarURL({ dynamic: true, size: 128 });
        }
    } catch {}
    return null;
}

function safeGuildIconURL(guild) {
    try {
        if (!guild) return null;
        if (typeof guild.iconURL === "function") {
            return guild.iconURL({ dynamic: true, size: 128 });
        }
    } catch {}
    return null;
}

function getAccountLabel(session) {
    const displayName =
        session?.accountGlobalName ||
        session?.accountTag ||
        session?.accountUsername ||
        session?.accountId ||
        "ไม่ทราบบัญชี";

    if (session?.accountUsername && session?.accountGlobalName) {
        return `${session.accountGlobalName} (@${session.accountUsername})`;
    }

    return displayName;
}

function getGuildLabel(session) {
    return session?.serverName || session?.serverId || "ไม่ทราบเซิร์ฟเวอร์";
}

function getVoiceLabel(session) {
    if (session?.voiceName) return session.voiceName;
    if (session?.voiceId) return `<#${session.voiceId}>`;
    return "ไม่ทราบช่องเสียง";
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function getUptimeString(session) {
    if (!session?.startedAt) return "ไม่ทราบ";
    const uptimeMs = Date.now() - session.startedAt;
    const days = Math.floor(uptimeMs / MS_PER_DAY);
    const hours = Math.floor((uptimeMs % MS_PER_DAY) / 3600000);
    const minutes = Math.floor((uptimeMs % 3600000) / 60000);

    if (days > 0) return `${days} วัน ${hours} ชั่วโมง ${minutes} นาที`;
    if (hours > 0) return `${hours} ชั่วโมง ${minutes} นาที`;
    return `${minutes} นาที`;
}

function getConnectionStatusText(session) {
    const status = session?.connection?.state?.status || "unknown";
    if (status === VoiceConnectionStatus.Ready) return "🟢 กำลังออน";
    if (status === VoiceConnectionStatus.Connecting) return "🟡 กำลังเชื่อมต่อ";
    if (status === VoiceConnectionStatus.Signalling) return "🟡 กำลังส่งสัญญาณ";
    if (status === VoiceConnectionStatus.Disconnected) return "🟠 หลุด กำลังกู้คืน";
    if (status === VoiceConnectionStatus.Destroyed) return "🔴 หยุดแล้ว";
    return `⚪ ${status}`;
}

function isVoiceConnectionUsable(connection, channelId = null) {
    if (!connection || connection.state?.status !== VoiceConnectionStatus.Ready) return false;
    if (!channelId) return true;
    return String(connection.joinConfig?.channelId || "") === String(channelId);
}

function normalizeVoiceTarget(input = {}) {
    const guildId = String(input.guildId || input.serverId || "").trim();
    const channelId = String(input.channelId || input.voiceId || "").trim();

    if (!/^\d{17,22}$/.test(guildId)) throw new Error("INVALID_GUILD_ID");
    if (!/^\d{17,22}$/.test(channelId)) throw new Error("INVALID_VOICE_CHANNEL_ID");

    return { guildId, channelId };
}

async function refreshSessionMetadata(sessionId, client, guild = null, channel = null) {
    const session = sessionManager.getSession(sessionId);
    if (!session || !client) return false;

    let resolvedGuild = guild;
    let resolvedChannel = channel;

    try {
        if (!resolvedGuild) {
            resolvedGuild = client.guilds.cache.get(session.serverId) ||
                await client.guilds.fetch(session.serverId).catch(() => null);
        }

        if (resolvedGuild && !resolvedChannel) {
            resolvedChannel = resolvedGuild.channels.cache.get(session.voiceId) ||
                await resolvedGuild.channels.fetch(session.voiceId).catch(() => null);
        }
    } catch {}

    const user = client.user || null;
    const metadata = {
        accountId: user?.id || session.accountId || null,
        accountUsername: user?.username || session.accountUsername || null,
        accountGlobalName: user?.globalName || session.accountGlobalName || null,
        accountTag: user?.tag || user?.username || session.accountTag || null,
        accountAvatar: safeAvatarURL(user) || session.accountAvatar || null,

        serverName: resolvedGuild?.name || session.serverName || null,
        guildIcon: safeGuildIconURL(resolvedGuild) || session.guildIcon || null,
        voiceName: resolvedChannel?.name || session.voiceName || null,
        lastActivity: Date.now()
    };

    return updateSessionMetadata(sessionId, metadata);
}

async function refreshSessionMetadataFast(sessionId, timeoutMs = 1500) {
    const session = sessionManager.getSession(sessionId);
    if (!session?.client?.isReady?.()) return false;

    return withTimeoutValue(
        refreshSessionMetadata(sessionId, session.client),
        timeoutMs,
        false
    ).catch(() => false);
}

function buildVoiceFields(session, extra = {}) {
    const fields = [
        { name: "👤 บัญชีที่ออน", value: getAccountLabel(session), inline: true },
        { name: "🆔 User ID", value: session.accountId ? `\`${session.accountId}\`` : "-", inline: true },
        { name: "🖥️ เซิร์ฟเวอร์", value: getGuildLabel(session), inline: true },
        { name: "🎙️ ช่องเสียง", value: getVoiceLabel(session), inline: true },
        { name: "📌 สถานะ", value: getConnectionStatusText(session), inline: true },
        { name: "⏱️ ออนมาทั้งหมด", value: getUptimeString(session), inline: true },
    ];

    if (session.reconnectCount > 0) {
        fields.push({ name: "🔄 Reconnect", value: `${session.reconnectCount} ครั้ง`, inline: true });
    }

    if (extra.reason) {
        fields.push({ name: "📋 สาเหตุ", value: extra.reason });
    }

    if (extra.action) {
        fields.push({ name: "💡 ต้องทำอะไร", value: extra.action });
    }

    fields.push({ name: "🧩 Session", value: `\`${getSessionShortId(session.sessionId)}\``, inline: true });

    return fields;
}

module.exports = {
    safeAvatarURL,
    safeGuildIconURL,
    getAccountLabel,
    getGuildLabel,
    getVoiceLabel,
    getUptimeString,
    getConnectionStatusText,
    isVoiceConnectionUsable,
    normalizeVoiceTarget,
    refreshSessionMetadata,
    refreshSessionMetadataFast,
    buildVoiceFields,
};
