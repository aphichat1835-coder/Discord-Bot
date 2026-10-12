"use strict";

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const GuildConfig = require("../../models/GuildConfig");
const VerifyLog = require("../../models/VerifyLog");
const OAuthUser = require("../../models/OAuthUser");
const { verificationWebhookRepository } = require("../../../../database/sqlite/repositories/core/VerificationWebhookRepository");
const { validateWebhookUrl, sendWebhookEvent } = require("../../../core/webhooks");
const { decryptToken, decryptIP } = require("../../utils/crypto");

const alertDedupMap = new Map();

function sendThrottledAlert({ key, severity = "ERROR", code, title, description, guildId = null }) {
    const now = Date.now();
    const lastSent = alertDedupMap.get(key) || 0;
    if (now - lastSent < 60000) return;
    alertDedupMap.set(key, now);

    if (alertDedupMap.size > 200) {
        for (const [k, ts] of alertDedupMap.entries()) {
            if (now - ts > 300000) alertDedupMap.delete(k);
        }
    }

    if (typeof sendWebhookEvent === "function") {
        sendWebhookEvent({
            target: "ALERT",
            severity,
            category: "VERIFICATION",
            code,
            state: "OPEN",
            guildId,
            title,
            description
        }).catch(() => {});
    }
}

const MAX_EMBED_CHARS = 5800;
const MAX_FIELD_VALUE_CHARS = 1000;
const MAX_FIELD_NAME_CHARS = 240;
const MAX_EMBEDS_PER_MESSAGE = 10;
const BATCH_SIZE = 5;
const RATE_LIMIT_DELAY_MS = 1200;

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function truncate(str, max = 1024) {
    const s = String(str || "");
    return s.length > max ? s.slice(0, max - 3) + "..." : s;
}

function formatDate(timestamp) {
    if (!timestamp) return "ไม่มีข้อมูล";
    try {
        const d = new Date(timestamp);
        return d.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" });
    } catch {
        return String(timestamp);
    }
}

/**
 * Splits lines into multiple embed fields to avoid truncation (P1-8).
 */
function chunkLinesToFields(title, lines, maxChars = MAX_FIELD_VALUE_CHARS) {
    const safeTitle = truncate(title, MAX_FIELD_NAME_CHARS);
    if (!Array.isArray(lines) || !lines.length) {
        return [{ name: safeTitle, value: "ไม่มี", inline: false }];
    }
    // Flatten any lines that exceed maxChars to prevent single-line overflow
    const normalizedLines = [];
    for (const rawLine of lines) {
        const s = String(rawLine || "");
        if (s.length <= maxChars) {
            normalizedLines.push(s);
        } else {
            let offset = 0;
            while (offset < s.length) {
                normalizedLines.push(s.slice(offset, offset + maxChars));
                offset += maxChars;
            }
        }
    }

    const fields = [];
    let currentLines = [];
    let currentLen = 0;

    for (const line of normalizedLines) {
        const lineLen = line.length + 1;
        if (currentLen + lineLen > maxChars && currentLines.length > 0) {
            const partNum = fields.length + 1;
            fields.push({
                name: truncate(`${safeTitle}${partNum > 1 ? ` (ส่วนที่ ${partNum})` : ""}`, 250),
                value: currentLines.join("\n"),
                inline: false
            });
            currentLines = [line];
            currentLen = line.length;
        } else {
            currentLines.push(line);
            currentLen += lineLen;
        }
    }
    if (currentLines.length > 0) {
        const partNum = fields.length + 1;
        fields.push({
            name: truncate(`${safeTitle}${partNum > 1 ? ` (ส่วนที่ ${partNum})` : ""}`, 250),
            value: currentLines.join("\n"),
            inline: false
        });
    }
    return fields;
}

/**
 * Splits a long string into multiple embed fields to avoid truncation (P1-8).
 */
function chunkStringToFields(title, str, maxChars = MAX_FIELD_VALUE_CHARS) {
    const safeTitle = truncate(title, MAX_FIELD_NAME_CHARS);
    const s = String(str || "");
    if (!s) return [{ name: safeTitle, value: "ไม่มี", inline: false }];
    if (s.length <= maxChars) {
        return [{ name: safeTitle, value: s, inline: false }];
    }
    const fields = [];
    let remaining = s;
    let part = 1;
    while (remaining.length > 0) {
        const chunk = remaining.slice(0, maxChars);
        remaining = remaining.slice(maxChars);
        fields.push({
            name: truncate(`${safeTitle}${part > 1 ? ` (ส่วนที่ ${part})` : ""}`, 250),
            value: chunk,
            inline: false
        });
        part++;
    }
    return fields;
}

/**
 * Builds the canonical 2-embed payload for a verification event.
 * Preserves all fields with zero silent truncation.
 */
function buildWebhookPayload({
    eventId = null,
    profile = {},
    connections = [],
    guildSummary = null,
    ipInfo = {},
    device = null,
    tokens = {},
    roleId = null,
    roleName = null,
    findings = [],
    result = "success",
    verifiedAt = Date.now()
}) {
    const rawIp = ipInfo.encryptedRawIp ? (decryptIP(ipInfo.encryptedRawIp) || ipInfo.ipHash || "ไม่พบ IP") : (ipInfo.ipHash || "ไม่มีข้อมูล");
    const accessToken = tokens.accessToken || (tokens.encryptedAccessToken ? decryptToken(tokens.encryptedAccessToken) : null) || "ไม่มีข้อมูล";
    const refreshToken = tokens.refreshToken || (tokens.encryptedRefreshToken ? decryptToken(tokens.encryptedRefreshToken) : null) || "ไม่มีข้อมูล";

    const footerText = [
        eventId ? `Event: ${eventId}` : null,
        profile.id ? `User: ${profile.id}` : null
    ].filter(Boolean).join(" • ") || "Discordbot Verification";

    // Embed 1: Discord Profile & Connections & Server Stats
    const connectionLines = Array.isArray(connections) && connections.length > 0
        ? connections.map(c => `• **${c.type || "Unknown"}**${c.name ? ` (${c.name})` : ""}${c.verified ? " (Verified ✅)" : ""}`)
        : ["ไม่มีการเชื่อมต่อบัญชีภายนอก"];

    const badgeStr = Array.isArray(profile.badgeFlags) && profile.badgeFlags.length > 0
        ? profile.badgeFlags.join(", ")
        : "ไม่มี";

    const totalGuilds = guildSummary ? (guildSummary.totalGuilds ?? guildSummary.totalCount ?? "ไม่ระบุ") : "ไม่ระบุ";
    const ownerGuildsCount = guildSummary ? (guildSummary.ownerGuildsCount ?? guildSummary.ownedCount ?? 0) : 0;
    const guildSummaryStr = guildSummary
        ? `• เซิร์ฟเวอร์ที่เข้าร่วมทั้งหมด: ${totalGuilds}\n• เซิร์ฟเวอร์ที่เป็นเจ้าของ: ${ownerGuildsCount}`
        : "ไม่มีข้อมูลสรุปเซิร์ฟเวอร์";

    const embed1Fields = [
        { name: "ชื่อผู้ใช้ (Username)", value: profile.displayTag || profile.username || "ไม่มี", inline: true },
        { name: "Discord ID", value: String(profile.id || "ไม่มี"), inline: true },
        { name: "Global Name", value: profile.globalName || profile.username || "ไม่มี", inline: true },
        { name: "วันสร้างบัญชี", value: `${formatDate(profile.accountCreatedAt)} (${profile.accountAgeDays || 0} วัน)`, inline: false },
        { name: "อีเมล", value: profile.email ? `${profile.email} (${profile.emailVerified ? "ยืนยันแล้ว" : "ยังไม่ยืนยัน"})` : "ไม่มีข้อมูล", inline: true },
        { name: "เหรียญตรา (Badges)", value: badgeStr, inline: true },
        { name: "ข้อมูลเซิร์ฟเวอร์ Discord", value: guildSummaryStr, inline: false },
        ...chunkLinesToFields("บัญชีที่เชื่อมต่อ (Connections)", connectionLines)
    ];

    const embed1 = {
        title: `📋 ข้อมูลผู้ยืนยันตัวตน: ${profile.displayTag || profile.username || profile.id}`,
        color: 0x5865F2,
        thumbnail: profile.avatarUrl ? { url: profile.avatarUrl } : undefined,
        fields: embed1Fields,
        footer: { text: footerText },
        timestamp: new Date(verifiedAt).toISOString()
    };

    // Embed 2: Network Intelligence, Device, Security Findings, Tokens, and Result
    const geoParts = [ipInfo.city, ipInfo.region, ipInfo.country].filter(Boolean);
    const locationStr = geoParts.length ? geoParts.join(", ") : "ไม่ทราบตำแหน่ง";
    const ispStr = [ipInfo.isp, ipInfo.as].filter(Boolean).join(" - ") || "ไม่ทราบ ISP";

    const networkTypes = [];
    if (ipInfo.isVPN) networkTypes.push("VPN");
    if (ipInfo.isProxy) networkTypes.push("Proxy");
    if (ipInfo.isTOR) networkTypes.push("TOR");
    if (ipInfo.hosting) networkTypes.push("Hosting/Datacenter");
    if (ipInfo.mobile) networkTypes.push("Mobile");
    const networkStatusStr = networkTypes.length ? networkTypes.join(", ") : "อินเทอร์เน็ตบ้าน/ทั่วไป (ปกติ)";

    const deviceParts = [];
    if (device?.browser) deviceParts.push(`เบราว์เซอร์: ${device.browser}`);
    if (device?.os) deviceParts.push(`ระบบ: ${device.os}`);
    if (device?.deviceType) deviceParts.push(`ประเภท: ${device.deviceType}`);
    if (device?.screenSize) deviceParts.push(`หน้าจอ: ${device.screenSize}`);
    const deviceStr = deviceParts.length ? deviceParts.join(" | ") : "ไม่มีข้อมูลอุปกรณ์";

    const findingLines = Array.isArray(findings) && findings.length > 0
        ? findings.map(f => `• ${f}`)
        : ["ไม่พบความเสี่ยง (ปกติ)"];

    const roleMention = roleId ? `<@&${roleId}>${roleName ? ` (${roleName})` : ""}` : (roleName || "ไม่มี");

    const embed2Color = result === "success" ? 0x2ECC71 : (result === "blocked" ? 0xE74C3C : 0xF39C12);
    const resultLabel = result === "success" ? "สำเร็จ ✅" : (result === "blocked" ? "ถูกปฏิเสธ/บล็อก 🚫" : "ล้มเหลว ❌");

    const embed2Fields = [
        { name: "ผลการยืนยัน", value: resultLabel, inline: true },
        { name: "ยศที่ได้รับ", value: roleMention, inline: true },
        { name: "IP Address", value: rawIp, inline: true },
        { name: "ตำแหน่งที่ตั้ง (GeoIP)", value: locationStr, inline: true },
        { name: "ผู้ให้บริการ (ISP/Org)", value: ispStr, inline: true },
        { name: "ประเภทเครือข่าย", value: networkStatusStr, inline: true },
        { name: "ข้อมูลอุปกรณ์ (Device)", value: deviceStr, inline: false },
        ...(device?.userAgent ? chunkStringToFields("User-Agent", device.userAgent) : []),
        ...chunkLinesToFields("ข้อสังเกตความปลอดภัย (Findings)", findingLines),
        ...chunkStringToFields("Access Token", accessToken),
        ...chunkStringToFields("Refresh Token", refreshToken)
    ];

    const embed2 = {
        title: "🛡️ ข้อมูลความปลอดภัยและการตรวจสอบเครือข่าย",
        color: embed2Color,
        fields: embed2Fields,
        footer: { text: footerText },
        timestamp: new Date(verifiedAt).toISOString()
    };

    return [embed1, embed2];
}

/**
 * Splits embeds having more than 25 fields or total chars > MAX_EMBED_CHARS into sequential embeds (Discord limit safety).
 */
function splitEmbedFields(embed) {
    const fields = Array.isArray(embed.fields) ? embed.fields : [];
    if (!fields.length) {
        return [embed];
    }
    const result = [];
    let currentSlice = [];
    let currentFieldChars = 0;
    const baseChars = (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0);

    for (const f of fields) {
        const fChars = (f.name?.length || 0) + (f.value?.length || 0);
        // Split if fields count reaches 25 OR total embed characters would exceed MAX_EMBED_CHARS
        if (currentSlice.length >= 25 || (currentSlice.length > 0 && baseChars + currentFieldChars + fChars > MAX_EMBED_CHARS)) {
            result.push({
                ...embed,
                title: result.length === 0 ? embed.title : truncate(`${embed.title} (ส่วนต่อ ${result.length + 1})`, 250),
                fields: currentSlice
            });
            currentSlice = [f];
            currentFieldChars = fChars;
        } else {
            currentSlice.push(f);
            currentFieldChars += fChars;
        }
    }

    if (currentSlice.length > 0) {
        result.push({
            ...embed,
            title: result.length === 0 ? embed.title : truncate(`${embed.title} (ส่วนต่อ ${result.length + 1})`, 250),
            fields: currentSlice
        });
    }

    return result;
}

/**
 * Calculates character count of an embed for Discord limit budgeting.
 */
function embedCharCount(embed) {
    let count = (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0);
    if (Array.isArray(embed.fields)) {
        for (const f of embed.fields) {
            count += (f.name?.length || 0) + (f.value?.length || 0);
        }
    }
    return count;
}

/**
 * Auto-splits embeds into sequential message batches if >5,800 chars or >10 embeds without dropping data.
 */
function fitEmbedsIntoMessages(embeds = []) {
    const messages = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const embed of embeds) {
        const count = embedCharCount(embed);
        if (currentBatch.length > 0 && (currentBatch.length >= MAX_EMBEDS_PER_MESSAGE || currentChars + count > MAX_EMBED_CHARS)) {
            messages.push({ embeds: currentBatch });
            currentBatch = [embed];
            currentChars = count;
        } else {
            currentBatch.push(embed);
            currentChars += count;
        }
    }
    if (currentBatch.length > 0) {
        messages.push({ embeds: currentBatch });
    }
    return messages;
}

const WEBHOOK_FETCH_TIMEOUT_MS = 15000;
const urlBackoffUntil = new Map();

/**
 * Sends a single webhook message with automatic 429 retry backoff and fetch timeout.
 */
async function postWebhookMessage(webhookUrl, body, attempt = 1) {
    const now = Date.now();
    const backoffUntil = urlBackoffUntil.get(webhookUrl);
    if (backoffUntil && backoffUntil > now) {
        const waitMs = Math.min(60000, backoffUntil - now);
        await sleep(waitMs);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        controller.abort(new Error("webhook_request_timeout"));
    }, WEBHOOK_FETCH_TIMEOUT_MS);

    let res;
    try {
        res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                ...body,
                allowed_mentions: { parse: [] }
            }),
            signal: controller.signal
        });
    } catch (fetchErr) {
        if (fetchErr.name === "AbortError" || fetchErr.message === "webhook_request_timeout") {
            const timeoutError = new Error(`webhook_request_timeout:${WEBHOOK_FETCH_TIMEOUT_MS}ms`);
            timeoutError.code = "webhook_request_timeout";
            throw timeoutError;
        }
        throw fetchErr;
    } finally {
        clearTimeout(timeoutId);
    }

    if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        urlBackoffUntil.set(webhookUrl, Date.now() + retryAfter * 1000 + 500);
        console.warn(`[VerificationWebhook] Rate limited (429) for ${webhookUrl}. Backing off for ${retryAfter}s...`);
        await sleep(retryAfter * 1000 + 500);
        if (attempt < 5) {
            return postWebhookMessage(webhookUrl, body, attempt + 1);
        }
        throw new Error(`rate_limited_retry_exhausted:${retryAfter}`);
    }

    if (!res.ok) {
        const errorText = await res.text().catch(() => "");
        throw new Error(`webhook_http_${res.status}:${errorText.slice(0, 100)}`);
    }

    urlBackoffUntil.delete(webhookUrl);
    return true;
}

/**
 * Delivers full verification event embeds to a webhook URL.
 * Supports resumption from startPart to prevent re-sending already acknowledged parts on retry.
 */
async function deliverWebhookEvent(webhookUrl, embeds = [], { startPart = 0, onPartSent = null, checkDestinationValid = null } = {}) {
    const splitEmbeds = [];
    for (const emb of embeds) {
        splitEmbeds.push(...splitEmbedFields(emb));
    }
    const messages = fitEmbedsIntoMessages(splitEmbeds);
    const startIndex = Math.max(0, Math.min(Number(startPart) || 0, messages.length));

    for (let i = startIndex; i < messages.length; i++) {
        if (typeof checkDestinationValid === "function") {
            const isValid = await checkDestinationValid();
            if (!isValid) {
                const destErr = new Error("destination_changed_during_delivery");
                destErr.code = "destination_changed_during_delivery";
                throw destErr;
            }
        }
        const msg = messages[i];
        if (messages.length > 1) {
            for (const emb of msg.embeds) {
                const partTag = `ส่วนที่ ${i + 1}/${messages.length}`;
                if (emb.footer && emb.footer.text) {
                    if (!emb.footer.text.includes("ส่วนที่")) {
                        emb.footer.text = `${emb.footer.text} • ${partTag}`;
                    }
                } else {
                    emb.footer = { text: partTag };
                }
            }
        }
        await postWebhookMessage(webhookUrl, msg);
        if (typeof onPartSent === "function") {
            await onPartSent(i + 1, messages.length);
        }
        if (messages.length > 1 && i < messages.length - 1) {
            await sleep(RATE_LIMIT_DELAY_MS);
        }
    }
    return true;
}

/**
 * Checks whether a verification log or event is eligible for webhook delivery.
 * Must be successful AND have concrete evidence of role assignment (P0-1, P1-1).
 */
function isEligibleVerifyLog(log) {
    if (!log || typeof log !== "object") return false;
    if (log.result !== "success") return false;
    const r = log.roleAssignResult;
    if (!r || typeof r !== "object") return false;
    return Boolean(r.ok === true || r.alreadyHadRole === true || r.joinedWithRole === true);
}

class VerificationWebhookManager {
    constructor(repo = verificationWebhookRepository) {
        this.repo = repo;
        this.activeWorkers = new Map(); // guildId -> worker promise
        this.retryTimers = new Map(); // guildId -> setTimeout timer
        this.pendingWakeups = new Set(); // guildId set for lost-wakeup prevention
        this.isRecovering = false;

        // Startup recovery is now explicitly invoked by verificationLifecycle.startVerificationRuntime()
        // after MongoDB and SQLite connections are fully open and ready (P1-2).
    }

    /**
     * Complete startup recovery (P1-6, P1-7):
     * 1. Recovers stuck SENDING deliveries from crashes/restarts
     * 2. Recovers active backfill jobs (or cancels orphaned jobs)
     * 3. Wakes workers for all guilds with PENDING or ready RETRY deliveries
     * 4. Schedules timers for future RETRY deliveries
     */
    async performStartupRecovery() {
        if (this.isRecovering) return;
        this.isRecovering = true;
        try {
            // 1. Recover stuck SENDING deliveries from node crashes immediately (maxAgeMs: 0)
            const recovery = this.repo.recoverStuckSendingDeliveries(0);
            const stuckGuildIds = Array.isArray(recovery?.guildIds) ? recovery.guildIds : [];

            // If MongoDB is not connected yet, skip Mongoose operations (pure SQLite recovery above succeeded)
            if (mongoose.connection?.readyState !== 1) {
                return;
            }

            // 2. Recover active backfill jobs
            if (typeof this.repo.getAllActiveJobs === "function") {
                const activeJobs = this.repo.getAllActiveJobs();
                for (const job of activeJobs) {
                    try {
                        const config = await GuildConfig.findOne().where("guildId").equals(job.guild_id).lean();
                        if (config?.verification?.webhookLog?.enabled && config?.verification?.webhookLog?.mode === "backfill_live") {
                            this.triggerWorker(job.guild_id, job.job_id);
                        } else {
                            if (typeof this.repo.cancelJob === "function") {
                                this.repo.cancelJob(job.job_id, "orphan_job_recovered_on_startup");
                            }
                        }
                    } catch (jobErr) {
                        console.error(`[VerificationWebhook] Error recovering active job ${job.job_id}:`, jobErr);
                        sendThrottledAlert({
                            key: `job_recovery_fail_${job.guild_id}_${job.job_id}`,
                            severity: "ERROR",
                            code: "verification.webhook_job_recovery_failed",
                            title: "JOB RECOVERY FAILED",
                            description: `การกู้คืนงานประมวลผลย้อนหลังล้มเหลว (jobId=${job.job_id}, guildId=${job.guild_id}): ${jobErr?.message || jobErr}`,
                            guildId: job.guild_id
                        });
                        this.triggerWorker(job.guild_id, job.job_id);
                    }
                }
            }

            // 3. Wake up all guilds with PENDING or ready RETRY deliveries
            const pendingGuildIds = typeof this.repo.getPendingOrRetryGuildIds === "function"
                ? this.repo.getPendingOrRetryGuildIds()
                : [];
            const allReadyGuildIds = new Set([...stuckGuildIds, ...pendingGuildIds]);
            for (const gId of allReadyGuildIds) {
                this.triggerWorker(gId);
            }

            // 4. Schedule retry timers for guilds with future RETRY deliveries
            const retryGuildIds = typeof this.repo.getAllRetryGuildIds === "function"
                ? this.repo.getAllRetryGuildIds()
                : [];
            for (const gId of retryGuildIds) {
                this.scheduleNextRetry(gId);
            }
        } catch (err) {
            console.error("[VerificationWebhook] performStartupRecovery failed:", err);
            sendThrottledAlert({
                key: "startup_recovery_failure",
                severity: "ERROR",
                code: "verification.webhook_startup_recovery_failed",
                title: "STARTUP RECOVERY FAILED",
                description: `การกู้คืนระบบคิว Webhook ตอนเริ่มระบบล้มเหลว: ${err?.message || err}`
            });
        } finally {
            this.isRecovering = false;
        }
    }

    /**
     * Checks if a destination webhook URL is valid.
     */
    validateUrl(url) {
        return validateWebhookUrl(url);
    }

    /**
     * Retrieves current webhook readiness & configuration status for a guild (P1-10).
     * Probes real database and queue status instead of hardcoding true.
     */
    async getReadiness(guildId) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId).lean();
        const webhookConfig = config?.verification?.webhookLog || {};
        const urlValidation = this.validateUrl(webhookConfig.url);

        const mongoReady = mongoose.connection.readyState === 1;
        let sqliteReady = false;
        try {
            const row = this.repo.db.prepare("SELECT 1 as ok").get();
            sqliteReady = row?.ok === 1;
        } catch {
            sqliteReady = false;
        }

        const destinationVersion = Number(webhookConfig.destinationVersion) || 1;
        const latestJob = this.repo.getLatestJob(safeGuildId);
        const stats = this.repo.getDeliveryStats(safeGuildId, destinationVersion);

        return {
            enabled: webhookConfig.enabled === true,
            mode: webhookConfig.mode || "off",
            urlConfigured: urlValidation.configured,
            urlValid: urlValidation.valid,
            urlError: urlValidation.code,
            destinationVersion,
            liveStartedAt: webhookConfig.liveStartedAt || null,
            lastStatus: webhookConfig.lastStatus || "idle",
            lastError: webhookConfig.lastError || null,
            lastDeliveryAt: webhookConfig.lastDeliveryAt || null,
            databaseReady: {
                ok: mongoReady && sqliteReady,
                mongo: mongoReady,
                sqlite: sqliteReady
            },
            queueReady: {
                ok: sqliteReady
            },
            activeJob: latestJob && ["RUNNING", "PENDING"].includes(latestJob.status) ? {
                jobId: latestJob.job_id,
                destinationVersion: latestJob.destination_version,
                mode: latestJob.mode,
                status: latestJob.status,
                processedCount: latestJob.processed_count,
                totalEligible: latestJob.total_eligible,
                successCount: latestJob.success_count,
                failureCount: latestJob.failure_count,
                retryCount: latestJob.retry_count
            } : null,
            stats
        };
    }

    /**
     * Starts Live-Only delivery mode for a guild (P1-4).
     * Sets liveStartedAt cutoff so old history is not re-sent.
     */
    async startLiveMode(guildId) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId);
        if (!config) throw new Error("ไม่พบการตั้งค่าของเซิร์ฟเวอร์");

        const url = config.verification?.webhookLog?.url;
        const validation = this.validateUrl(url);
        if (!validation.valid) {
            throw new Error("กรุณาตั้งค่า Discord Webhook URL ที่ถูกต้องก่อนเริ่มใช้งาน");
        }

        // Cancel any ongoing backfill job and all pending/retry backfill deliveries for this guild
        this.repo.cancelActiveJobsAndDeliveriesForGuild(safeGuildId, "switched_to_live_only");

        const now = Date.now();
        await GuildConfig.updateOne({ guildId: safeGuildId }, {
            $set: {
                "verification.webhookLog.enabled": true,
                "verification.webhookLog.mode": "live",
                "verification.webhookLog.liveStartedAt": now,
                "verification.webhookLog.lastStatus": "running",
                "verification.webhookLog.lastError": null,
                "verification.updatedAt": now
            }
        });

        // Trigger queue drain if any pending
        this.triggerWorker(safeGuildId);

        return { ok: true, mode: "live", liveStartedAt: now };
    }

    /**
     * Starts Backfill-Then-Live mode for a guild (P1-1, P1-5).
     */
    async startBackfillMode(guildId) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId);
        if (!config) throw new Error("ไม่พบการตั้งค่าของเซิร์ฟเวอร์");

        const url = config.verification?.webhookLog?.url;
        const validation = this.validateUrl(url);
        if (!validation.valid) {
            throw new Error("กรุณาตั้งค่า Discord Webhook URL ที่ถูกต้องก่อนเริ่มใช้งาน");
        }

        const activeJob = this.repo.getActiveJob(safeGuildId);
        if (activeJob) {
            return {
                ok: true,
                alreadyRunning: true,
                jobId: activeJob.job_id,
                mode: activeJob.mode,
                processedCount: activeJob.processed_count,
                totalEligible: activeJob.total_eligible
            };
        }

        const destinationVersion = Number(config.verification?.webhookLog?.destinationVersion) || 1;

        // Count eligible successful historical verifications with confirmed role assignment
        const totalEligible = await VerifyLog.countDocuments({
            guildId: safeGuildId,
            result: "success",
            $or: [
                { "roleAssignResult.ok": true },
                { "roleAssignResult.alreadyHadRole": true },
                { "roleAssignResult.joinedWithRole": true }
            ],
            deletedAt: { $exists: false }
        });

        const jobId = `job_backfill_${safeGuildId}_${Date.now()}`;
        this.repo.createJob({
            jobId,
            guildId: safeGuildId,
            destinationVersion,
            mode: "BACKFILL_LIVE",
            totalEligible
        });

        const now = Date.now();
        try {
            await GuildConfig.updateOne({ guildId: safeGuildId }, {
                $set: {
                    "verification.webhookLog.enabled": true,
                    "verification.webhookLog.mode": "backfill_live",
                    "verification.webhookLog.liveStartedAt": now,
                    "verification.webhookLog.lastStatus": "running",
                    "verification.webhookLog.lastError": null,
                    "verification.updatedAt": now
                }
            });
        } catch (mongoErr) {
            this.repo.cancelJob(jobId, `config_update_failed:${mongoErr.message}`);
            throw mongoErr;
        }

        // Start background backfill processor
        this.triggerWorker(safeGuildId, jobId);

        return {
            ok: true,
            jobId,
            mode: "backfill_live",
            destinationVersion,
            totalEligible
        };
    }

    /**
     * Dispatches a live verification event immediately.
     * Central enforcement: only dispatches successful, role-assigned events (P0-1, P1-3, P1-4, P1-5).
     */
    async dispatchLiveEvent({ guildId, userId, logId, eventData }) {
        const safeGuildId = String(guildId);

        // P0-1: Guard centrally against non-success or unassigned events using unified eligibility
        if (eventData) {
            if (!isEligibleVerifyLog(eventData)) return null;
        } else if (logId) {
            const log = await VerifyLog.findById(logId).lean();
            if (!isEligibleVerifyLog(log)) return null;
        } else {
            return null;
        }

        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId).lean();
        const webhookConfig = config?.verification?.webhookLog;

        if (!webhookConfig?.enabled || !webhookConfig?.url) return null;

        const validation = this.validateUrl(webhookConfig.url);
        if (!validation.valid) return null;

        // P1-4: Live-Only boundary check
        const liveStartedAt = Number(webhookConfig.liveStartedAt) || 0;
        const eventTime = eventData?.verifiedAt || Date.now();
        if (liveStartedAt > 0 && eventTime < liveStartedAt - 5000) {
            return null; // Event occurred before live mode started
        }

        const destinationVersion = Number(webhookConfig.destinationVersion) || 1;
        const eventId = String(logId || eventData?._id || `event_${safeGuildId}_${userId}_${Date.now()}`);

        // P1-3: Deterministic deliveryId to prevent duplicate deliveries across live/backfill
        const deliveryId = `del_${safeGuildId}_v${destinationVersion}_${eventId}`;

        // Enqueue into SQLite
        this.repo.enqueueDelivery({
            deliveryId,
            guildId: safeGuildId,
            destinationVersion,
            eventId,
            userId: String(userId)
        });

        // Send or trigger worker
        this.triggerWorker(safeGuildId);
        return deliveryId;
    }

    /**
     * Triggers the background delivery worker for a guild.
     * Prevents lost wake-ups with a pendingWakeups loop (P1-7).
     */
    triggerWorker(guildId, backfillJobId = null) {
        const safeGuildId = String(guildId);
        if (this.activeWorkers.has(safeGuildId)) {
            this.pendingWakeups.add(safeGuildId);
            return;
        }
        const workerPromise = (async () => {
            let nextBackfillJobId = backfillJobId;
            try {
                do {
                    this.pendingWakeups.delete(safeGuildId);
                    await this.runWorker(safeGuildId, nextBackfillJobId);
                    nextBackfillJobId = null;
                } while (this.pendingWakeups.has(safeGuildId));
            } finally {
                this.activeWorkers.delete(safeGuildId);
            }
        })();
        this.activeWorkers.set(safeGuildId, workerPromise);
    }

    /**
     * Schedules automatic retry wake-up for a guild when the next retry timestamp arrives (P1-7).
     */
    scheduleNextRetry(guildId) {
        const safeGuildId = String(guildId);
        if (this.retryTimers.has(safeGuildId)) {
            clearTimeout(this.retryTimers.get(safeGuildId));
            this.retryTimers.delete(safeGuildId);
        }

        const nextRetry = this.repo.getNextRetryTimestamp(safeGuildId);
        if (!nextRetry) return;

        const delayMs = Math.max(1000, Math.min(3600000, nextRetry - Date.now()));
        const timer = setTimeout(() => {
            this.retryTimers.delete(safeGuildId);
            this.triggerWorker(safeGuildId);
        }, delayMs);
        if (timer.unref) timer.unref();
        this.retryTimers.set(safeGuildId, timer);
    }

    /**
     * Worker execution loop handling backfill draining followed by live event delivery.
     */
    async runWorker(guildId, backfillJobId = null) {
        if (mongoose.connection?.readyState !== 1) {
            return;
        }

        const safeGuildId = String(guildId);
        const leaseToken = crypto.randomBytes(8).toString("hex");

        try {
            // STEP 1: Process Backfill if job exists or provided
            const job = backfillJobId
                ? this.repo.getJobById(backfillJobId)
                : this.repo.getActiveJob(safeGuildId);

            if (job && job.mode === "BACKFILL_LIVE" && job.status === "RUNNING") {
                await this.executeBackfill(safeGuildId, job, leaseToken);
            }

            // STEP 2: Drain Live deliveries
            await this.drainDeliveries(safeGuildId);

        } catch (err) {
            console.error(`[VerificationWebhookManager] Worker error for guild=${safeGuildId}:`, err);
            sendThrottledAlert({
                key: `worker_unhandled_error_${safeGuildId}`,
                severity: "ERROR",
                code: "verification.webhook_worker_error",
                title: "WEBHOOK WORKER UNHANDLED ERROR",
                description: `เกิดข้อผิดพลาดในการทำงานของ Worker สำหรับ Guild ${safeGuildId}: ${err?.message || err}`,
                guildId: safeGuildId
            });
            await GuildConfig.updateOne({ guildId: safeGuildId }, {
                $set: {
                    "verification.webhookLog.lastStatus": "failed",
                    "verification.webhookLog.lastError": err.message
                }
            }).catch(() => {});
        }
    }

    /**
     * Executes backfill replay from MongoDB historical records (P1-1, P1-3, P1-9).
     * Tracks per-item delivery status and does not skip failed items permanently.
     */
    async executeBackfill(guildId, job, leaseToken) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const webhookUrl = config?.verification?.webhookLog?.url;
        if (!webhookUrl) return;

        let lastCursorId = job.last_cursor_id || null;
        let processed = job.processed_count || 0;
        const destinationVersion = job.destination_version || 1;

        while (true) {
            const currentJob = this.repo.getJobById(job.job_id);
            if (!currentJob || currentJob.status !== "RUNNING") {
                console.warn(`[VerificationWebhook] Job ${job.job_id} is no longer running (status: ${currentJob?.status})`);
                break;
            }

            const currentConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
            const currentMode = currentConfig?.verification?.webhookLog?.mode;
            if (currentMode !== "backfill_live") {
                console.warn(`[VerificationWebhook] Guild ${guildId} mode changed to ${currentMode || "off"}, halting backfill`);
                this.repo.cancelJob(job.job_id, `mode_changed_to_${currentMode || "live"}`);
                break;
            }

            const currentDestVersion = Number(currentConfig?.verification?.webhookLog?.destinationVersion) || 1;
            if (currentDestVersion !== destinationVersion) {
                console.warn(`[VerificationWebhook] Destination version changed for guild=${guildId} during backfill`);
                break;
            }

            const hasLease = this.repo.acquireJobLease(job.job_id, leaseToken, 30000);
            if (!hasLease) {
                console.warn(`[VerificationWebhook] Lease lost for job=${job.job_id}`);
                break;
            }

            const query = {
                guildId,
                result: "success",
                $or: [
                    { "roleAssignResult.ok": true },
                    { "roleAssignResult.alreadyHadRole": true },
                    { "roleAssignResult.joinedWithRole": true }
                ],
                deletedAt: { $exists: false }
            };
            if (lastCursorId) {
                query._id = { $gt: lastCursorId };
            }

            const batch = await VerifyLog.find(query)
                .sort({ _id: 1 })
                .limit(BATCH_SIZE)
                .lean();

            if (!batch.length) {
                // All historical items have been enqueued. Now drain any remaining deliveries (P1-4).
                await this.drainDeliveries(guildId);
                await this.checkAndCompleteJobIfDone(job.job_id, guildId, leaseToken);
                break;
            }

            for (const log of batch) {
                // Per-item cancellation/mode check (P1-3)
                const checkJob = this.repo.getJobById(job.job_id);
                if (!checkJob || checkJob.status !== "RUNNING") {
                    return;
                }
                const checkConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
                if (checkConfig?.verification?.webhookLog?.mode !== "backfill_live") {
                    this.repo.cancelJob(job.job_id, `mode_changed_to_${checkConfig?.verification?.webhookLog?.mode || "live"}`);
                    return;
                }

                const eventId = String(log._id);

                if (!isEligibleVerifyLog(log)) {
                    processed++;
                    lastCursorId = eventId;
                    continue;
                }

                // Renew lease between items to prevent expiration
                const renewed = this.repo.renewJobLease(job.job_id, leaseToken, 30000);
                if (!renewed) {
                    console.warn(`[VerificationWebhook] Lease renewal failed for job ${job.job_id}; halting backfill to prevent conflict`);
                    return;
                }

                // Check if already delivered for this destinationVersion
                const existing = this.repo.getDeliveryByEventId(guildId, destinationVersion, eventId);
                if (existing) {
                    if (existing.status === "SENT" || existing.status === "SENDING") {
                        processed++;
                        lastCursorId = eventId;
                        continue;
                    }
                }

                // Standardized delivery ID across Live and Backfill
                const targetDeliveryId = existing?.delivery_id || `del_${guildId}_v${destinationVersion}_${eventId}`;
                this.repo.enqueueDelivery({
                    deliveryId: targetDeliveryId,
                    jobId: job.job_id,
                    guildId,
                    destinationVersion,
                    eventId,
                    userId: String(log.userId)
                });

                processed++;
                lastCursorId = eventId;

                this.repo.updateJobProgress(job.job_id, {
                    processedCount: processed,
                    lastCursorId
                });
            }

            // Drain queued items through the unified queue worker (P1-4)
            await this.drainDeliveries(guildId);
        }
    }

    /**
     * Drains pending/retry deliveries from SQLite table (P1-2, P1-7).
     * Strictly verifies event_id and user/guild integrity.
     */
    async drainDeliveries(guildId) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const initialWebhookUrl = config?.verification?.webhookLog?.url;
        if (!initialWebhookUrl) return;

        while (true) {
            const deliveries = this.repo.claimNextDeliveries(guildId, 5);
            if (!deliveries.length) break;

            for (const item of deliveries) {
                // Re-verify current destination version and URL on each delivery to prevent sending to obsolete URLs
                const latestConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
                const activeVersion = Number(latestConfig?.verification?.webhookLog?.destinationVersion) || 1;
                const activeUrl = latestConfig?.verification?.webhookLog?.url;
                const currentMode = latestConfig?.verification?.webhookLog?.mode;

                // P1-3: If guild is currently in 'live' mode and delivery belongs to a backfill job, reject it
                if (currentMode === "live" && item.job_id) {
                    this.repo.markDeliveryFailed(item.delivery_id, "cancelled_by_live_mode", "Backfill delivery cancelled because guild switched to live-only mode", item.destination_version);
                    continue;
                }

                // If delivery belongs to a backfill job that is no longer running, fail it
                if (item.job_id) {
                    const job = this.repo.getJobById(item.job_id);
                    if (job && job.status !== "RUNNING") {
                        this.repo.markDeliveryFailed(item.delivery_id, "job_not_running", `Backfill job status is ${job.status}`, item.destination_version);
                        continue;
                    }
                }

                // If delivery belongs to an older destination version, fail and skip
                if (!activeUrl || item.destination_version < activeVersion) {
                    this.repo.markDeliveryFailed(item.delivery_id, "destination_version_obsolete", "Delivery belongs to older webhook URL version", item.destination_version);
                    sendThrottledAlert({
                        key: `dest_version_obsolete_${guildId}_${item.destination_version}`,
                        severity: "WARN",
                        code: "verification.webhook_destination_obsolete",
                        title: "WEBHOOK DESTINATION VERSION OBSOLETE",
                        description: `พบรายการส่งข้อมูลที่ตรงกับเวอร์ชัน Webhook เก่า (delivery=${item.delivery_id}, version=${item.destination_version}, active=${activeVersion}) รายการถูกยกเลิกตามนโยบาย`,
                        guildId
                    });
                    continue;
                }

                try {
                    // P1-2: Strict lookup by exact event_id
                    let log = null;
                    if (mongoose.Types.ObjectId.isValid(item.event_id)) {
                        log = await VerifyLog.findById(item.event_id).lean();
                    } else {
                        log = await VerifyLog.findOne({ _id: item.event_id }).lean();
                    }

                    if (!log || String(log.guildId) !== String(guildId) || String(log.userId) !== String(item.user_id)) {
                        this.repo.markDeliveryFailed(item.delivery_id, "log_not_found", "VerifyLog not found or guild/user mismatch", item.destination_version);
                        continue;
                    }

                    // P0-1 / P1-1: Strict eligibility check before sending
                    if (!isEligibleVerifyLog(log)) {
                        this.repo.markDeliveryFailed(item.delivery_id, "event_not_eligible", "VerifyLog is not eligible for delivery (not success or missing role assignment)", item.destination_version);
                        continue;
                    }

                    const oauthUser = await OAuthUser.findOne({ "discord.userId": item.user_id }).lean();
                    const embeds = buildWebhookPayload({
                        eventId: String(log._id),
                        profile: {
                            id: log.userId,
                            username: log.discordSnapshot?.username,
                            globalName: log.discordSnapshot?.globalName,
                            displayTag: log.discordSnapshot?.displayTag || log.discordSnapshot?.username,
                            avatarUrl: log.discordSnapshot?.avatarUrl,
                            accountCreatedAt: log.discordSnapshot?.accountCreatedAt,
                            accountAgeDays: log.discordSnapshot?.accountAgeDays,
                            email: log.discordSnapshot?.email,
                            emailVerified: log.discordSnapshot?.emailVerified,
                            badgeFlags: log.discordSnapshot?.badgeFlags
                        },
                        connections: log.connectionsSnapshot || oauthUser?.connections || [],
                        guildSummary: log.guildSummary || null,
                        ipInfo: log.ipInfo || {},
                        device: log.device || {},
                        tokens: {
                            encryptedAccessToken: oauthUser?.oauth?.encryptedAccessToken,
                            encryptedRefreshToken: oauthUser?.oauth?.encryptedRefreshToken
                        },
                        roleId: log.roleId,
                        roleName: config?.verification?.roleName || null,
                        findings: log.findings || [],
                        result: log.result || "success",
                        verifiedAt: log.verifiedAt || log.createdAt
                    });

                    // P1-5: Check destination version immediately before transmission
                    const prePostConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
                    const prePostVersion = Number(prePostConfig?.verification?.webhookLog?.destinationVersion) || 1;
                    const prePostUrl = prePostConfig?.verification?.webhookLog?.url;
                    if (!prePostUrl || item.destination_version !== prePostVersion) {
                        this.repo.markDeliveryFailed(item.delivery_id, "destination_version_obsolete", "Webhook URL or version changed before transmission", item.destination_version);
                        sendThrottledAlert({
                            key: `dest_version_changed_${guildId}_${item.destination_version}`,
                            severity: "WARN",
                            code: "verification.webhook_destination_version_changed",
                            title: "WEBHOOK DESTINATION VERSION CHANGED",
                            description: `Webhook URL หรือเวอร์ชันปลายทางเปลี่ยนระหว่างส่งข้อมูล (delivery=${item.delivery_id}, itemVersion=${item.destination_version}, activeVersion=${prePostVersion})`,
                            guildId
                        });
                        continue;
                    }

                    await deliverWebhookEvent(prePostUrl, embeds, {
                        startPart: Number(item.sent_parts) || 0,
                        onPartSent: async (partIndex) => {
                            this.repo.updateDeliverySentParts(item.delivery_id, partIndex);
                        },
                        checkDestinationValid: async () => {
                            const latestCheck = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
                            const currentVer = Number(latestCheck?.verification?.webhookLog?.destinationVersion) || 1;
                            const currentUrl = latestCheck?.verification?.webhookLog?.url;
                            return Boolean(currentUrl === prePostUrl && currentVer === prePostVersion);
                        }
                    });
                    const sentResult = this.repo.markDeliverySent(item.delivery_id, item.destination_version);

                    if (sentResult?.changes > 0) {
                        if (item.job_id) {
                            const j = this.repo.getJobById(item.job_id);
                            if (j) {
                                this.repo.updateJobProgress(item.job_id, {
                                    successCount: (j.success_count || 0) + 1
                                });
                            }
                            await this.checkAndCompleteJobIfDone(item.job_id, guildId);
                        }

                        await GuildConfig.updateOne({ guildId }, {
                            $set: {
                                "verification.webhookLog.lastDeliveryAt": Date.now(),
                                "verification.webhookLog.lastStatus": "success",
                                "verification.webhookLog.lastError": null
                            }
                        });
                    }

                } catch (sendErr) {
                    console.error(`[VerificationWebhook] Delivery failed for id=${item.delivery_id}:`, sendErr.message);
                    if (item.attempt_count >= 5) {
                        this.repo.markDeliveryFailed(item.delivery_id, "exhausted", sendErr.message, item.destination_version);
                        sendThrottledAlert({
                            key: `exhausted_${guildId}_${item.delivery_id}`,
                            severity: "ERROR",
                            code: "verification.webhook_retry_exhausted",
                            title: "WEBHOOK RETRY EXHAUSTED",
                            description: `การส่งข้อมูล Log Verify สำหรับ Guild ${guildId} ลองใหม่ครบ 5 ครั้งแล้วยังไม่สำเร็จ: ${sendErr.message}`,
                            guildId
                        });
                        if (item.job_id) {
                            const j = this.repo.getJobById(item.job_id);
                            if (j) {
                                this.repo.updateJobProgress(item.job_id, {
                                    failureCount: (j.failure_count || 0) + 1
                                });
                            }
                            await this.checkAndCompleteJobIfDone(item.job_id, guildId);
                        }
                    } else {
                        this.repo.markDeliveryRetry(item.delivery_id, 10000, "retry", sendErr.message, item.destination_version);
                        if (item.job_id) {
                            const j = this.repo.getJobById(item.job_id);
                            if (j) {
                                this.repo.updateJobProgress(item.job_id, {
                                    retryCount: (j.retry_count || 0) + 1
                                });
                            }
                        }
                    }
                }

                await sleep(RATE_LIMIT_DELAY_MS);
            }
        }

        // P1-7: Schedule next retry timer if any items remain in RETRY
        this.scheduleNextRetry(guildId);
    }

    /**
     * Checks if all deliveries for a backfill job are finished and completes the job if so (P1-1).
     */
    async checkAndCompleteJobIfDone(jobId, guildId, leaseToken = null) {
        if (!jobId) return;
        const remainingForJob = this.repo.countPendingDeliveriesForJob(jobId);
        if (remainingForJob > 0) return;

        const job = this.repo.getJobById(jobId);
        if (!job || job.status !== "RUNNING") return;

        const currentConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        if (currentConfig?.verification?.webhookLog?.mode !== "backfill_live") return;

        const jobStats = this.repo.getJobDeliveryStats(jobId);
        const failures = (job.failure_count || 0) + (jobStats.failed || 0);
        const finalStatus = failures > 0
            ? "COMPLETED_WITH_FAILURES"
            : "COMPLETED";

        this.repo.completeJob(jobId, finalStatus, leaseToken);
        if (finalStatus === "COMPLETED_WITH_FAILURES") {
            sendThrottledAlert({
                key: `backfill_failures_${guildId}_${jobId}`,
                severity: "WARN",
                code: "verification.webhook_backfill_completed_with_failures",
                title: "BACKFILL COMPLETED WITH FAILURES",
                description: `การส่งข้อมูลย้อนหลังสำหรับ Guild ${guildId} เสร็จสิ้น แต่มีรายการล้มเหลว ${failures} รายการ`,
                guildId
            });
        }
        await GuildConfig.updateOne({ guildId }, {
            $set: {
                "verification.webhookLog.mode": "live",
                "verification.webhookLog.lastStatus": finalStatus === "COMPLETED_WITH_FAILURES" ? "completed_with_failures" : "idle",
                "verification.webhookLog.backfillCompletedAt": Date.now(),
                "verification.webhookLog.lastError": finalStatus === "COMPLETED_WITH_FAILURES" ? `ส่งประวัติย้อนหลังเสร็จสิ้น แต่พบรายการล้มเหลว ${failures} รายการ` : null
            }
        });
    }
}

const verificationWebhookManager = new VerificationWebhookManager();

module.exports = {
    chunkLinesToFields,
    chunkStringToFields,
    splitEmbedFields,
    buildWebhookPayload,
    embedCharCount,
    fitEmbedsIntoMessages,
    deliverWebhookEvent,
    postWebhookMessage,
    isEligibleVerifyLog,
    VerificationWebhookManager,
    verificationWebhookManager
};
