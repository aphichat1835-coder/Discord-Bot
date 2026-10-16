"use strict";

const { PermissionFlagsBits } = require("discord.js");
const { isGuildAllowed, getJoinCampaignConfig } = require("../config");
const { countEligibleCandidates } = require("./candidateQueryService");
const { isValidDiscordWebhookUrl } = require("../worker/batchLogger");

function isValidSnowflake(id) {
    return /^\d{17,22}$/.test(String(id || "").trim());
}

async function _fetchChunkedMembers(guild) {
    const memberIds = new Set();
    let after = "0";
    while (true) {
        const batch = await guild.members.list({ limit: 1000, after });
        if (!batch || batch.size === 0) break;
        for (const [id] of batch) {
            memberIds.add(id);
        }
        if (batch.size < 1000) break;
        after = Array.from(batch.keys())[batch.size - 1];
    }
    return memberIds;
}

async function _fetchGuildMemberIds(guild) {
    if (guild.memberCount && guild.memberCount <= 1000) {
        const members = await guild.members.fetch();
        return new Set(members.keys());
    }
    return _fetchChunkedMembers(guild);
}

async function getLiveTargetMemberIds(guild) {
    if (!guild) {
        const err = new Error("ไม่พบข้อมูลเซิร์ฟเวอร์ปลายทางสำหรับตรวจสอบสมาชิก (Guild object is null or undefined)");
        err.code = "GUILD_NOT_FOUND";
        throw err;
    }

    try {
        return await _fetchGuildMemberIds(guild);
    } catch (firstErr) {
        console.warn(`[JoinCampaign] Target member fetch attempt 1 failed: ${firstErr.message}`);
        await new Promise(r => setTimeout(r, 600));
    }

    try {
        return await _fetchGuildMemberIds(guild);
    } catch (secondErr) {
        console.warn(`[JoinCampaign] Target member fetch attempt 2 failed: ${secondErr.message}`);
        const error = new Error("ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้ กรุณาลองใหม่อีกครั้งนะครับ");
        error.code = "FETCH_MEMBERS_FAILED";
        throw error;
    }
}

async function resolveAndValidateTargetGuild(client, targetGuildId, config) {
    if (!targetGuildId) {
        return { ok: false, error: "กรุณาระบุไอดีเซิร์ฟเวอร์ปลายทาง" };
    }

    if (!isValidSnowflake(targetGuildId)) {
        return { ok: false, error: "ไอดีเซิร์ฟเวอร์ปลายทางต้องเป็นตัวเลข 17–22 หลัก" };
    }

    if (!isGuildAllowed(targetGuildId, config)) {
        return { ok: false, error: "เซิร์ฟเวอร์ปลายทางนี้ไม่อยู่ในรายการที่อนุญาตให้เริ่มงาน" };
    }

    let targetGuild = client.guilds.cache.get(targetGuildId);
    if (!targetGuild) {
        try {
            targetGuild = await client.guilds.fetch(targetGuildId);
        } catch (_err) {
            return { ok: false, error: "บอทไม่ได้อยู่ในเซิร์ฟเวอร์ปลายทาง กรุณาเชิญบอทเข้าเซิร์ฟเวอร์ก่อนนะครับ" };
        }
    }

    if (!targetGuild) {
        return { ok: false, error: "บอทไม่ได้อยู่ในเซิร์ฟเวอร์ปลายทาง กรุณาเชิญบอทเข้าเซิร์ฟเวอร์ก่อนนะครับ" };
    }

    // Check bot permission in target guild (Fail-closed)
    const botMember = targetGuild.members?.me || await targetGuild.members?.fetchMe?.().catch(() => null);
    if (!botMember) {
        return { ok: false, error: "ไม่สามารถตรวจสอบสิทธิ์ของบอทในเซิร์ฟเวอร์ปลายทางได้ กรุณาตรวจสอบว่าบอทมีสิทธิ์ในเซิร์ฟเวอร์อย่างถูกต้อง" };
    }
    if (!botMember.permissions?.has(PermissionFlagsBits.CreateInstantInvite)) {
        return { ok: false, error: "บอทขาดสิทธิ์ 'สร้างคำเชิญ' (Create Instant Invite) ในเซิร์ฟเวอร์ปลายทาง" };
    }

    return { ok: true, targetGuild };
}

async function resolveAndValidateSourceGuild(client, sourceGuildId, targetGuildId) {
    if (!sourceGuildId) {
        return { ok: false, error: "กรุณาระบุไอดีเซิร์ฟเวอร์ต้นทาง" };
    }
    if (!isValidSnowflake(sourceGuildId)) {
        return { ok: false, error: "ไอดีเซิร์ฟเวอร์ต้นทางต้องเป็นตัวเลข 17–22 หลัก" };
    }
    if (sourceGuildId === targetGuildId) {
        return { ok: false, error: "เซิร์ฟเวอร์ต้นทางและปลายทางต้องไม่เป็นเซิร์ฟเวอร์เดียวกัน" };
    }

    let sourceGuild = client.guilds.cache.get(sourceGuildId);
    if (!sourceGuild) {
        try {
            sourceGuild = await client.guilds.fetch(sourceGuildId);
        } catch (_err) {
            // Ignored: Source guild might not be accessible by bot
        }
    }
    return { ok: true, sourceGuild };
}

async function validateGuildTargets({ client, mode, baseConfig = {}, webhookUrl = null, config = getJoinCampaignConfig() }) {
    if (webhookUrl && !isValidDiscordWebhookUrl(webhookUrl)) {
        return { ok: false, error: "ลิงก์ Webhook ต้องเป็นลิงก์ Discord Webhook ที่ถูกต้องเท่านั้นครับ" };
    }

    const targetGuildId = String(baseConfig.targetGuildId || "").trim();
    const targetRes = await resolveAndValidateTargetGuild(client, targetGuildId, config);
    if (!targetRes.ok) return targetRes;
    const targetGuild = targetRes.targetGuild;

    let sourceGuild = null;
    let sourceGuildId = null;

    if (mode.requiresSource) {
        sourceGuildId = String(baseConfig.sourceGuildId || "").trim();
        const sourceRes = await resolveAndValidateSourceGuild(client, sourceGuildId, targetGuildId);
        if (!sourceRes.ok) return sourceRes;
        sourceGuild = sourceRes.sourceGuild;
    }

    return {
        ok: true,
        targetGuild,
        targetGuildId,
        targetGuildName: targetGuild.name,
        sourceGuild,
        sourceGuildId,
        sourceGuildName: sourceGuild?.name || null
    };
}

async function runPreflight({ client, mode, baseConfig = {}, webhookUrl = null, tokenManager, requestedAmount = null, config = getJoinCampaignConfig() }) {
    const targetValidation = await validateGuildTargets({ client, mode, baseConfig, webhookUrl, config });
    if (!targetValidation.ok) {
        return targetValidation;
    }

    // Live Target Membership Check (Fail-closed)
    let targetMemberIds;
    try {
        targetMemberIds = await getLiveTargetMemberIds(targetValidation.targetGuild);
    } catch (err) {
        return {
            ok: false,
            error: err.message || "ไม่สามารถดึงรายชื่อสมาชิกปัจจุบันของเซิร์ฟเวอร์ปลายทางได้ กรุณาลองใหม่อีกครั้งนะครับ"
        };
    }

    // Calculate live ready count subtracting members already in Target Guild
    const readyCount = await countEligibleCandidates({
        mode,
        baseConfig,
        tokenManager,
        targetMemberIds
    });

    if (readyCount === 0) {
        return {
            ok: false,
            error: "ไม่พบสมาชิกที่พร้อมดึงเข้าเซิร์ฟเวอร์ในขณะนี้ (หรือทุกคนอยู่ในเซิร์ฟเวอร์เรียบร้อยแล้ว)"
        };
    }

    // Calculate Joined Quota:
    // If requestedAmount is provided, strictly validate positive integer (DO NOT clamp with readyCount!)
    // If blank or not provided, default to readyCount.
    let requestedQuota = readyCount;
    if (requestedAmount !== null && requestedAmount !== undefined && String(requestedAmount).trim() !== "") {
        const rawStr = String(requestedAmount).trim();
        if (!/^\d+$/.test(rawStr)) {
            return {
                ok: false,
                error: "จำนวนสมาชิกที่ต้องการดึงต้องเป็นตัวเลขจำนวนเต็มบวกเท่านั้นครับ (เช่น 50, 100) หรือเว้นว่างไว้เพื่อดึงทั้งหมด"
            };
        }
        const parsed = Number(rawStr);
        if (!Number.isSafeInteger(parsed) || parsed <= 0) {
            return {
                ok: false,
                error: "จำนวนสมาชิกที่ต้องการดึงต้องมากกว่า 0 ครับ หรือเว้นว่างไว้เพื่อดึงทั้งหมด"
            };
        }
        requestedQuota = parsed;
    }

    return {
        ok: true,
        targetGuild: targetValidation.targetGuild,
        targetGuildId: targetValidation.targetGuildId,
        targetGuildName: targetValidation.targetGuildName,
        sourceGuild: targetValidation.sourceGuild,
        sourceGuildId: targetValidation.sourceGuildId,
        sourceGuildName: targetValidation.sourceGuildName,
        targetMemberIds,
        readyCount,
        requestedQuota
    };
}

module.exports = {
    isValidSnowflake,
    getLiveTargetMemberIds,
    validateGuildTargets,
    runPreflight
};
