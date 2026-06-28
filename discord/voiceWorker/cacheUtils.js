const { Options: SelfClientOptions } = require("discord.js-selfbot-v13");
const sessionManager = require("../sessionManager");
const { st, clientPool, tokenLoginCooldowns } = require("./state");
const {
    SELF_CLIENT_CACHE_LIMITS,
    SELF_CLIENT_CACHE_CLEANUP_TTL_MS,
    VOICE_LEAN_MODE,
    VOICE_LEAN_KEEP_TARGET_GUILD,
    VOICE_LEAN_CLEANUP_INTERVAL_MS,
    VOICE_LEAN_LOG,
} = require("./config");
const {
    getSessionShortId,
    getSessionTokenHash,
    isSessionRunnable,
    sanitizeLifecycleError,
    cacheDelete,
    clearManagerCache,
    disposeSelfClient,
    getSessionClientFromPool,
} = require("./session");

function buildSelfClientOptions() {
    return {
        checkUpdate: false,
        makeCache: SelfClientOptions.cacheWithLimits({
            ...SelfClientOptions.defaultMakeCacheSettings,
            ...SELF_CLIENT_CACHE_LIMITS
        })
    };
}

function getCacheSize(cacheLike) {
    return Number(cacheLike?.cache?.size ?? cacheLike?.size ?? 0) || 0;
}

function addGuildCacheStats(total, guild) {
    total.guildMembers += getCacheSize(guild.members);
    total.guildChannels += getCacheSize(guild.channels);
    total.voiceStates += getCacheSize(guild.voiceStates);
    total.roles += getCacheSize(guild.roles);
    total.emojis += getCacheSize(guild.emojis);
    total.presences += getCacheSize(guild.presences);
}

function getClientCacheStats(client) {
    const stats = {
        ready: !!client?.isReady?.(),
        guilds: getCacheSize(client?.guilds),
        channels: getCacheSize(client?.channels),
        users: getCacheSize(client?.users),
        guildMembers: 0,
        guildChannels: 0,
        voiceStates: 0,
        roles: 0,
        emojis: 0,
        presences: 0,
        messages: 0
    };

    for (const guild of client?.guilds?.cache?.values?.() || []) {
        addGuildCacheStats(stats, guild);
    }

    for (const channel of client?.channels?.cache?.values?.() || []) {
        stats.messages += getCacheSize(channel?.messages);
    }

    return stats;
}

function sumCacheStats(items) {
    return items.reduce((acc, item) => {
        for (const [key, value] of Object.entries(item || {})) {
            if (typeof value === "number") acc[key] = (acc[key] || 0) + value;
        }
        return acc;
    }, {});
}

function getClientListenerStats(client) {
    if (!client || typeof client.eventNames !== "function" || typeof client.listenerCount !== "function") {
        return { total: 0, byEvent: {} };
    }

    const byEvent = {};
    let total = 0;

    for (const event of client.eventNames()) {
        const name = String(event);
        const count = client.listenerCount(event);
        byEvent[name] = count;
        total += count;
    }

    return { total, byEvent };
}

function sumListenerStats(items) {
    return items.reduce((acc, item) => {
        acc.total += Number(item?.total || 0);
        for (const [event, count] of Object.entries(item?.byEvent || {})) {
            acc.byEvent[event] = (acc.byEvent[event] || 0) + count;
        }
        return acc;
    }, { total: 0, byEvent: {} });
}

function pruneCacheToIds(cacheLike, keepIds = new Set()) {
    const cache = cacheLike?.cache || cacheLike;
    if (!cache || typeof cache.entries !== "function") return 0;

    let removed = 0;
    for (const [id] of cache.entries()) {
        if (!keepIds.has(String(id))) {
            if (cacheDelete(cache, id)) removed++;
        }
    }
    return removed;
}

function getVoiceLeanConfig() {
    return {
        enabled: VOICE_LEAN_MODE,
        keepTargetGuild: VOICE_LEAN_KEEP_TARGET_GUILD,
        cleanupIntervalMs: VOICE_LEAN_CLEANUP_INTERVAL_MS,
        log: VOICE_LEAN_LOG
    };
}

function clearGuildRuntimeCache(guild, { targetChannelId = null, selfUserId = null, keepTargetGuild = true } = {}) {
    if (!guild) return { channelsRemoved: 0, membersRemoved: 0, voiceStatesRemoved: 0 };

    const keepChannelIds = keepTargetGuild && targetChannelId ? new Set([String(targetChannelId)]) : new Set();
    const keepMemberIds = keepTargetGuild && selfUserId ? new Set([String(selfUserId)]) : new Set();

    const channelsRemoved = keepTargetGuild
        ? pruneCacheToIds(guild.channels?.cache, keepChannelIds)
        : getCacheSize(guild.channels);
    if (!keepTargetGuild) clearManagerCache(guild.channels);

    const membersRemoved = keepTargetGuild
        ? pruneCacheToIds(guild.members?.cache, keepMemberIds)
        : getCacheSize(guild.members);
    if (!keepTargetGuild) clearManagerCache(guild.members);

    const voiceStatesRemoved = keepTargetGuild
        ? pruneCacheToIds(guild.voiceStates?.cache, keepMemberIds)
        : getCacheSize(guild.voiceStates);
    if (!keepTargetGuild) clearManagerCache(guild.voiceStates);

    clearManagerCache(guild.roles);
    clearManagerCache(guild.emojis);
    clearManagerCache(guild.presences);

    return { channelsRemoved, membersRemoved, voiceStatesRemoved };
}

function clearAllChannelMessageCaches(client) {
    for (const channel of client.channels?.cache?.values?.() || []) {
        clearManagerCache(channel?.messages);
    }
}

function pruneGuildsCaches(client, { targetGuildId, targetChannelId, selfUserId }) {
    let guildsRemoved = 0;
    let channelsRemoved = 0;
    let membersRemoved = 0;
    let voiceStatesRemoved = 0;

    for (const [guildId, guild] of client.guilds?.cache?.entries?.() || []) {
        const isTargetGuild = String(guildId) === targetGuildId;
        if (!isTargetGuild && VOICE_LEAN_KEEP_TARGET_GUILD) {
            guildsRemoved += cacheDelete(client.guilds?.cache, guildId) ? 1 : 0;
            clearGuildRuntimeCache(guild, { keepTargetGuild: false });
            continue;
        }
        const removed = clearGuildRuntimeCache(guild, {
            targetChannelId,
            selfUserId,
            keepTargetGuild: isTargetGuild && VOICE_LEAN_KEEP_TARGET_GUILD
        });
        channelsRemoved += removed.channelsRemoved;
        membersRemoved += removed.membersRemoved;
        voiceStatesRemoved += removed.voiceStatesRemoved;
    }

    return { guildsRemoved, channelsRemoved, membersRemoved, voiceStatesRemoved };
}

function cleanupLeanClientCache(client, session, reason = "scheduled") {
    if (!VOICE_LEAN_MODE || !client || !session) return null;

    const before = getClientCacheStats(client);
    const selfUserId = client.user?.id || session.accountId || null;
    const targetGuildId = String(session.serverId || "");
    const targetChannelId = String(session.voiceId || "");

    clearAllChannelMessageCaches(client);

    const keepGlobalChannelIds = targetChannelId ? new Set([targetChannelId]) : new Set();
    const globalChannelsPruned = pruneCacheToIds(client.channels?.cache, keepGlobalChannelIds);

    const { guildsRemoved, channelsRemoved, membersRemoved, voiceStatesRemoved } =
        pruneGuildsCaches(client, { targetGuildId, targetChannelId, selfUserId });

    const keepUserIds = selfUserId ? new Set([String(selfUserId)]) : new Set();
    pruneCacheToIds(client.users?.cache, keepUserIds);

    const after = getClientCacheStats(client);
    const summary = {
        at: Date.now(),
        reason,
        sessionId: session.sessionId || null,
        shortId: getSessionShortId(session.sessionId),
        targetGuildId,
        targetChannelId,
        guildsRemoved,
        channelsRemoved: globalChannelsPruned + channelsRemoved,
        membersRemoved,
        voiceStatesRemoved,
        before,
        after
    };
    st.lastLeanCleanup = summary;

    if (VOICE_LEAN_LOG) {
        console.log(`[WORKER] 🧼 Voice lean cleanup ${reason}: ${JSON.stringify({
            session: summary.shortId,
            guilds: `${before.guilds}->${after.guilds}`,
            channels: `${before.channels}->${after.channels}`,
            members: `${before.guildMembers}->${after.guildMembers}`,
            voiceStates: `${before.voiceStates}->${after.voiceStates}`,
            messages: `${before.messages}->${after.messages}`
        })}`);
    }

    return summary;
}

function cleanupLeanSessionClient(sessionId, reason = "scheduled") {
    const session = sessionManager.getSession(sessionId);
    if (!session) return null;
    return cleanupLeanClientCache(session.client, session, reason);
}

function cleanupLeanActiveSessions(now = Date.now(), force = false) {
    if (!VOICE_LEAN_MODE) return null;
    if (!force && st.lastLeanCleanup?.at && now - st.lastLeanCleanup.at < VOICE_LEAN_CLEANUP_INTERVAL_MS) {
        return {
            skipped: true,
            reason: "interval",
            nextRunInMs: VOICE_LEAN_CLEANUP_INTERVAL_MS - (now - st.lastLeanCleanup.at),
            lastRunAt: st.lastLeanCleanup.at
        };
    }

    st.lastLeanCleanup = { at: now };

    const seenClients = new Set();
    let cleaned = 0;
    let skipped = 0;
    const summaries = [];

    for (const [sessionId, session] of sessionManager.getAllSessions()) {
        if (!isSessionRunnable(session)) {
            skipped++;
            continue;
        }

        const tokenHash = getSessionTokenHash(sessionId, session);
        const clientRef = session.client || getSessionClientFromPool(sessionId, session, tokenHash);
        if (!clientRef || seenClients.has(clientRef)) {
            skipped++;
            continue;
        }

        seenClients.add(clientRef);
        const summary = cleanupLeanClientCache(clientRef, session, "scheduled");
        if (summary) {
            cleaned++;
            summaries.push({
                sessionId: summary.sessionId,
                shortId: summary.shortId,
                before: {
                    guilds: summary.before.guilds,
                    channels: summary.before.channels,
                    guildMembers: summary.before.guildMembers,
                    voiceStates: summary.before.voiceStates,
                    messages: summary.before.messages
                },
                after: {
                    guilds: summary.after.guilds,
                    channels: summary.after.channels,
                    guildMembers: summary.after.guildMembers,
                    voiceStates: summary.after.voiceStates,
                    messages: summary.after.messages
                }
            });
        }
    }

    return {
        skipped: false,
        cleaned,
        skippedSessions: skipped,
        summaries
    };
}

function destroyAllPooledClients(reason = "cleanup") {
    for (const [, client] of clientPool.entries()) {
        try {
            disposeSelfClient(client, reason);
        } catch (e) {
            console.warn(`[WORKER] ⚠️ Failed to destroy pooled client during ${reason}: ${sanitizeLifecycleError(e.message)}`);
        }
    }

    for (const session of sessionManager.getAllSessions().values()) {
        if (session) session.client = null;
    }

    clientPool.clear();
    tokenLoginCooldowns.clear();
    console.log(`[WORKER] 🗑️ Client pool destroyed and cleared (${reason}).`);
}

function sweepCollection(collection, filter) {
    if (!collection || typeof collection.sweep !== "function") return 0;
    try {
        return collection.sweep(filter);
    } catch {
        return 0;
    }
}

function cleanupClientCaches(client, now = Date.now()) {
    if (!client) return { messages: 0, reactions: 0, presences: 0, members: 0, users: 0 };

    const removed = { messages: 0, reactions: 0, presences: 0, members: 0, users: 0 };
    const messageCutoff = now - SELF_CLIENT_CACHE_CLEANUP_TTL_MS;
    const selfUserId = client.user?.id || null;

    for (const channel of client.channels?.cache?.values?.() || []) {
        const messages = channel?.messages?.cache;
        if (!messages) continue;

        for (const message of messages.values?.() || []) {
            removed.reactions += sweepCollection(message?.reactions?.cache, () => true);
        }

        removed.messages += sweepCollection(messages, message => {
            const ts = message?.editedTimestamp || message?.createdTimestamp || 0;
            return ts > 0 && ts < messageCutoff;
        });
    }

    for (const guild of client.guilds?.cache?.values?.() || []) {
        removed.presences += sweepCollection(guild.presences?.cache, (_presence, userId) => String(userId) !== String(selfUserId));

        const voiceMemberIds = new Set();
        for (const state of guild.voiceStates?.cache?.values?.() || []) {
            if (state?.id) voiceMemberIds.add(String(state.id));
        }

        removed.members += sweepCollection(guild.members?.cache, member => {
            const memberId = String(member?.id || "");
            return memberId !== String(selfUserId) && !voiceMemberIds.has(memberId);
        });
    }

    removed.users += sweepCollection(client.users?.cache, user => String(user?.id || "") !== String(selfUserId));

    return removed;
}

function cleanupSelfClientCaches(now = Date.now()) {
    const totals = { messages: 0, reactions: 0, presences: 0, members: 0, users: 0 };

    for (const client of clientPool.values()) {
        const removed = cleanupClientCaches(client, now);
        for (const [key, value] of Object.entries(removed)) {
            totals[key] += value;
        }
    }

    return totals;
}

module.exports = {
    buildSelfClientOptions,
    getCacheSize,
    addGuildCacheStats,
    getClientCacheStats,
    sumCacheStats,
    getClientListenerStats,
    sumListenerStats,
    pruneCacheToIds,
    getVoiceLeanConfig,
    clearGuildRuntimeCache,
    cleanupLeanClientCache,
    cleanupLeanSessionClient,
    cleanupLeanActiveSessions,
    destroyAllPooledClients,
    sweepCollection,
    cleanupClientCaches,
    cleanupSelfClientCaches,
};
