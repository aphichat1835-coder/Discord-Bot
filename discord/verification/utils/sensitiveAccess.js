"use strict";

function redactSensitiveDiscordSnapshot(discord = {}, canView = false) {
    if (canView) return discord;
    return {
        ...discord,
        email: null,
        connections: [],
        guilds: []
    };
}

function redactSensitiveIpInfo(ipInfo = {}, canView = false) {
    if (canView) return ipInfo;
    return {
        ...ipInfo,
        rawIp: null,
        ip: null
    };
}

module.exports = {
    redactSensitiveDiscordSnapshot,
    redactSensitiveIpInfo
};
