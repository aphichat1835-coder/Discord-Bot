"use strict";

const { DefaultWebSocketManagerOptions } = require("@discordjs/ws");
const { PLATFORM_CONFIGS } = require("./constants");

let currentPlatform = "desktop";
let lastReconnectTime = 0;
const RECONNECT_COOLDOWN_MS = 15_000;
const DAILY_IDENTIFY_LIMIT = 200;
const identifyTimestamps = [];

function checkDailyIdentifyCap(now) {
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    while (identifyTimestamps.length > 0 && identifyTimestamps[0] < oneDayAgo) {
        identifyTimestamps.shift();
    }
    return identifyTimestamps.length < DAILY_IDENTIFY_LIMIT;
}

function recordIdentify(now) {
    identifyTimestamps.push(now);
}

function resolvePlatformKey(key, fallback = "desktop") {
    if (typeof key === "string" && PLATFORM_CONFIGS[key]) {
        return key;
    }
    return fallback;
}

function getPlatformProperties(platformKey) {
    const key = resolvePlatformKey(platformKey);
    return { ...PLATFORM_CONFIGS[key].properties };
}

function updateIdentifyProperties(props, ws) {
    const targetProps = {
        browser: props.browser,
        device: props.device,
        os: props.os
    };

    if (DefaultWebSocketManagerOptions.identifyProperties) {
        Object.assign(DefaultWebSocketManagerOptions.identifyProperties, targetProps);
    } else {
        DefaultWebSocketManagerOptions.identifyProperties = { ...targetProps };
    }

    if (ws?.options?.identifyProperties) {
        Object.assign(ws.options.identifyProperties, targetProps);
    } else if (ws?.options) {
        ws.options.identifyProperties = { ...targetProps };
    }

    if (ws?.strategy?.options?.identifyProperties) {
        Object.assign(ws.strategy.options.identifyProperties, targetProps);
    }
}

function checkCooldown(key, force, skipCooldown, now) {
    if (!force && key === currentPlatform) {
        return {
            allowed: false,
            result: {
                success: true,
                changed: false,
                platform: key,
                reason: "already_active"
            }
        };
    }

    const elapsed = now - lastReconnectTime;
    if (elapsed < RECONNECT_COOLDOWN_MS && !skipCooldown && !force) {
        const waitSec = Math.ceil((RECONNECT_COOLDOWN_MS - elapsed) / 1000);
        return {
            allowed: false,
            result: {
                success: false,
                changed: false,
                platform: currentPlatform,
                error: `กรุณารออีก ${waitSec} วินาที ก่อนเปลี่ยนแพลตฟอร์มเพื่อความปลอดภัยต่อระบบเชื่อมต่อ Discord Gateway`
            }
        };
    }

    if (!force && !checkDailyIdentifyCap(now)) {
        return {
            allowed: false,
            result: {
                success: false,
                changed: false,
                platform: currentPlatform,
                error: "ถึงขีดจำกัดการสลับแพลตฟอร์มสูงสุดต่อวัน (Daily Gateway Identify Cap) เพื่อความปลอดภัยสูงสุดของบอท Discord"
            }
        };
    }

    return { allowed: true };
}

async function reconnectShards(client, ws, key) {
    const shardCollection = ws?.strategy?.shards || ws?.shards || client?.ws?.shards;
    const isClientReady = typeof client?.isReady === "function" ? client.isReady() : (client?.isReady !== false);
    if (!isClientReady || !shardCollection || (!shardCollection.size && !shardCollection.length)) {
        return { reconnected: false };
    }

    try {
        const shardsList = typeof shardCollection.values === "function" ? shardCollection.values() : shardCollection;
        const shardPromises = [];
        for (const shard of shardsList) {
            shardPromises.push(
                shard.destroy({
                    recover: 0,
                    reason: `Gateway Platform changed to ${key}`
                })
            );
        }
        await Promise.all(shardPromises);
        recordIdentify(Date.now());
        return { reconnected: true };
    } catch (err) {
        return {
            reconnected: false,
            warning: `บันทึกการตั้งค่าแล้ว แต่ไม่สามารถ reconnect ได้ทันที: ${err.message}`
        };
    }
}

function applyDefaultPlatform(platformKey) {
    const key = resolvePlatformKey(platformKey);
    const props = getPlatformProperties(key);
    updateIdentifyProperties(props, null);
    currentPlatform = key;
    return { success: true, platform: key, properties: props };
}

async function applyRuntimePlatform(client, platformKey, options = {}) {
    const key = resolvePlatformKey(platformKey);
    const force = options.force === true;
    const now = Date.now();

    const cooldown = checkCooldown(key, force, options.skipCooldown, now);
    if (!cooldown.allowed) {
        return cooldown.result;
    }

    const props = getPlatformProperties(key);
    const ws = client?.ws?._ws;

    updateIdentifyProperties(props, ws);
    currentPlatform = key;
    lastReconnectTime = now;

    const reconnectResult = await reconnectShards(client, ws, key);

    return {
        success: true,
        changed: true,
        reconnected: reconnectResult.reconnected,
        platform: key,
        properties: props,
        ...(reconnectResult.warning ? { warning: reconnectResult.warning } : {})
    };
}

function getCurrentPlatform() {
    return currentPlatform;
}

function resetCooldownForTest() {
    lastReconnectTime = 0;
}

module.exports = {
    resolvePlatformKey,
    getPlatformProperties,
    applyDefaultPlatform,
    applyRuntimePlatform,
    getCurrentPlatform,
    resetCooldownForTest,
    RECONNECT_COOLDOWN_MS
};
