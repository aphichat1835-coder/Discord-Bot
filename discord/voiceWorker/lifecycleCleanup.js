'use strict';

const { VoiceConnectionStatus, getVoiceConnection } = require("@discordjs/voice");
const { sanitizeLifecycleError } = require("./session");
const { delay } = require("./config");
const { countOtherActiveSessionsForClient, cleanupSessionClientIfUnused, getSessionClientFromPool } = require("./session");

function getVoiceGroup(client, guildId, session = null) {
    const userId = client?.user?.id || session?.accountId;
    if (!userId || !guildId) return null;
    return `${userId}:${guildId}`;
}

function destroyConnectionObject(connection) {
    if (!connection || connection.state?.status === VoiceConnectionStatus.Destroyed) return false;
    connection.destroy();
    return true;
}

function resolveSelfMember(guild, userId) {
    if (!guild || !userId) return null;
    return guild.members?.me || guild.me || guild.members?.cache?.get?.(userId) || null;
}

function resolveVoiceChannelId(memberVoice, cachedState) {
    return memberVoice?.channelId ||
        memberVoice?.channel?.id ||
        cachedState?.channelId ||
        cachedState?.channel?.id ||
        null;
}

function getSelfVoiceStateInfo(client, session) {
    const guild = client?.guilds?.cache?.get?.(session?.serverId) || null;
    const userId = client?.user?.id || null;
    const member = resolveSelfMember(guild, userId);
    const memberVoice = member?.voice || null;
    const cachedState = guild && userId ? guild.voiceStates?.cache?.get?.(userId) : null;
    const voiceState = memberVoice || cachedState || null;
    const channelId = resolveVoiceChannelId(memberVoice, cachedState);
    const inTargetChannel = Boolean(channelId && String(channelId) === String(session?.voiceId));

    return {
        inspectable: Boolean(guild && (memberVoice || cachedState)),
        inTargetGuild: Boolean(channelId),
        inTargetChannel,
        channelId,
        channelSource: channelId ? "voice_state" : null,
        voiceState,
        memberVoice
    };
}

async function waitForSelfVoiceExit(clientRef, session, timeoutMs = 1200) {
    const started = Date.now();
    let lastInfo = getSelfVoiceStateInfo(clientRef, session);

    while (Date.now() - started < timeoutMs) {
        if (!lastInfo.inTargetChannel) return lastInfo;
        await delay(150);
        lastInfo = getSelfVoiceStateInfo(clientRef, session);
    }

    return lastInfo;
}

async function waitForTargetVoice(clientRef, session, timeoutMs = 3000, connection = null) {
    const started = Date.now();
    let info = getSelfVoiceStateInfo(clientRef, session);
    while (Date.now() - started < timeoutMs) {
        if (info.inTargetChannel) return info;
        await delay(150);
        info = getSelfVoiceStateInfo(clientRef, session);
    }
    const connectionReady = connection?.state?.status === VoiceConnectionStatus.Ready;
    const joinedChannelId = connection?.joinConfig?.channelId || null;
    if (!info.inspectable && connectionReady && String(joinedChannelId) === String(session?.voiceId)) {
        return {
            ...info,
            inTargetGuild: true,
            inTargetChannel: true,
            channelId: joinedChannelId,
            channelSource: "connection_state"
        };
    }
    return info;
}

async function attemptSelfVoiceDisconnect(clientRef, session, sessionId, tokenHash, errors) {
    let info = getSelfVoiceStateInfo(clientRef, session);
    if (!info.inTargetChannel) return info;

    const started = Date.now();
    const budgetMs = 1500;
    const disconnectors = [
        { target: info.memberVoice, method: "disconnect", args: ["Voice session stopped"] },
        { target: info.voiceState, method: "disconnect", args: ["Voice session stopped"] },
        { target: info.memberVoice, method: "setChannel", args: [null, "Voice session stopped"] },
        { target: info.voiceState, method: "setChannel", args: [null, "Voice session stopped"] }
    ].filter(item => item.target && typeof item.target[item.method] === "function");

    for (const item of disconnectors) {
        info = getSelfVoiceStateInfo(clientRef, session);
        if (!info.inTargetChannel) return info;
        if (Date.now() - started >= budgetMs) break;

        try {
            await item.target[item.method](...item.args);
            const remainingMs = Math.max(150, budgetMs - (Date.now() - started));
            const after = await waitForSelfVoiceExit(clientRef, session, Math.min(remainingMs, 750));
            if (!after.inTargetChannel) return after;
        } catch (err) {
            errors.push(`selfVoiceDisconnect:${sanitizeLifecycleError(err.message)}`);
        }
    }

    info = getSelfVoiceStateInfo(clientRef, session);
    if (!info.inTargetChannel) return info;

    const otherActive = countOtherActiveSessionsForClient(tokenHash, sessionId, session);
    if (otherActive <= 0) {
        cleanupSessionClientIfUnused(tokenHash, clientRef, sessionId, session, "self-voice-fallback");
        const afterDestroy = await waitForSelfVoiceExit(clientRef, session, 500);
        if (!afterDestroy.inTargetChannel) {
            errors.length = 0;
            return { inspectable: true, inTargetGuild: false, inTargetChannel: false, channelId: null };
        }
        return afterDestroy;
    }

    errors.push(`selfVoiceStillConnected:activeSessions=${otherActive}`);
    return getSelfVoiceStateInfo(clientRef, session);
}

function verifyCleanupState(registryAfter, ownConnection, selfVoiceInfo, errors, clientRef) {
    const registryAlive = !!registryAfter && registryAfter.state?.status !== VoiceConnectionStatus.Destroyed;
    const ownConnectionAlive = !!ownConnection && ownConnection.state?.status !== VoiceConnectionStatus.Destroyed;
    const selfStillInTargetVoice = !!selfVoiceInfo.inTargetChannel;

    if (registryAlive) errors.push("voiceRegistry:still_active");
    if (ownConnectionAlive) errors.push("session.connection:still_active");
    if (selfStillInTargetVoice) {
        errors.push("selfVoiceStillConnected:target_channel");
    }

    const ok = errors.length === 0 && !registryAlive && !ownConnectionAlive && !selfStillInTargetVoice;

    return {
        ok,
        verified: ok && (selfVoiceInfo.inspectable || !clientRef?.isReady?.()),
        reason: ok ? "cleanup_verified" : "cleanup_not_confirmed",
        safeError: errors.join("; ") || null
    };
}

async function cleanupSessionVoiceConnection(sessionId, session, tokenHash) {
    const errors = [];
    const clientRef = session?.client || getSessionClientFromPool(sessionId, session, tokenHash);
    const group = getVoiceGroup(clientRef, session?.serverId, session);

    const ownConnection = session?.connection;

    try {
        if (ownConnection) destroyConnectionObject(ownConnection);
    } catch (err) {
        errors.push(`session.connection:${sanitizeLifecycleError(err.message)}`);
    }

    try {
        const registryConnection = group ? getVoiceConnection(session.serverId, group) : null;
        if (registryConnection) destroyConnectionObject(registryConnection);
    } catch (err) {
        errors.push(`voiceRegistry:${sanitizeLifecycleError(err.message)}`);
    }

    let selfVoiceInfo = { inspectable: false, inTargetGuild: false, inTargetChannel: false, channelId: null };
    if (clientRef) {
        selfVoiceInfo = await attemptSelfVoiceDisconnect(clientRef, session, sessionId, tokenHash, errors);
    }

    const registryAfter = group ? getVoiceConnection(session.serverId, group) : null;
    const ownConnectionAlive = !!ownConnection && ownConnection.state?.status !== VoiceConnectionStatus.Destroyed;
    if (session) session.connection = ownConnectionAlive ? ownConnection : null;

    const verification = verifyCleanupState(registryAfter, ownConnection, selfVoiceInfo, errors, clientRef);

    return {
        ...verification,
        shouldDeleteRecord: verification.ok,
        clientRef
    };
}

module.exports = {
    getVoiceGroup,
    destroyConnectionObject,
    resolveSelfMember,
    resolveVoiceChannelId,
    getSelfVoiceStateInfo,
    waitForSelfVoiceExit,
    waitForTargetVoice,
    attemptSelfVoiceDisconnect,
    verifyCleanupState,
    cleanupSessionVoiceConnection
};
