"use strict";

const https = require("node:https");
const { URL } = require("node:url");
const emoji = require("../ui/emojis");

const DISCORD_WEBHOOK_HOSTS = new Set([
    "discord.com",
    "www.discord.com",
    "discordapp.com",
    "www.discordapp.com",
    "canary.discord.com",
    "ptb.discord.com"
]);

function isValidDiscordWebhookUrl(url) {
    if (!url || typeof url !== "string") return false;
    try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== "https:") return false;
        if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) return false;
        if (parsed.username || parsed.password) return false;
        return /^\/api(?:\/v\d+)?\/webhooks\/\d{17,22}\/[\w-]+$/i.test(parsed.pathname);
    } catch {
        return false;
    }
}

function formatDurationThai(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) {
        return `${minutes} นาที ${seconds} วินาที`;
    }
    return `${seconds} วินาที`;
}

function sendRawWebhook(webhookUrl, payload) {
    return new Promise((resolve) => {
        if (!isValidDiscordWebhookUrl(webhookUrl)) {
            return resolve(false);
        }

        try {
            const urlObj = new URL(webhookUrl);
            const data = JSON.stringify(payload);

            const req = https.request(urlObj, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(data)
                },
                timeout: 10000
            }, (res) => {
                res.resume();
                resolve(res.statusCode >= 200 && res.statusCode < 300);
            });

            req.on("error", () => resolve(false));
            req.on("timeout", () => {
                req.destroy();
                resolve(false);
            });

            req.write(data);
            req.end();
        } catch (err) {
            // Return false if URL parsing or request creation throws synchronously
            if (process.env.NODE_ENV !== "test") {
                console.debug?.("[JoinCampaign:batchLogger] Webhook request dispatch error:", err?.message || err);
            }
            resolve(false);
        }
    });
}

async function sendBatchLog({
    webhookUrl,
    mode,
    batchNumber,
    items = [],
    joinedCount,
    alreadyCount,
    failedCount,
    targetGuildName
}) {
    if (!webhookUrl || !isValidDiscordWebhookUrl(webhookUrl)) return;

    const mentions = items
        .map(item => `<@${item.userId}>`)
        .join(" ");

    const content = [
        `**${emoji.boost} รายงานการดึงสมาชิก (ชุดที่ ${batchNumber})**`,
        `เซิร์ฟเวอร์ปลายทาง: **${targetGuildName || "เซิร์ฟเวอร์เป้าหมาย"}**`,
        `ความคืบหน้าชุดนี้: ดึงเข้าสำเร็จ **${joinedCount}** คน | อยู่ในเซิร์ฟแล้ว **${alreadyCount}** คน | ไม่สำเร็จ **${failedCount}** คน`,
        "",
        `รายชื่อสมาชิกในชุดนี้:`,
        mentions.slice(0, 1500)
    ].join("\n");

    const payload = {
        content: content.slice(0, 1950),
        allowed_mentions: { parse: [] } // Silent mentions - does not trigger pings
    };

    await sendRawWebhook(webhookUrl, payload);
}

const USER_ERROR_RULES = Object.freeze([
    {
        keywords: ["sqlite_busy", "database is locked"],
        message: "ฐานข้อมูลกำลังประมวลผลงานอื่นอยู่ชั่วคราว กรุณารอสักครู่แล้วลองใหม่ครับ"
    },
    {
        keywords: ["mongoserverselectionerror", "mongonetworkerror", "topology was destroyed"],
        message: "การเชื่อมต่อฐานข้อมูลหลักขัดข้องชั่วคราว"
    },
    {
        keywords: ["aborterror", "etimedout", "econnreset", "econnrefused"],
        message: "การเชื่อมต่อไปยัง Discord เกิดความล่าช้าหรือหลุดการเชื่อมต่อชั่วคราว"
    },
    {
        keywords: ["fail-closed", "ตรวจสอบรายชื่อสมาชิก"],
        message: "ไม่สามารถตรวจสอบรายชื่อสมาชิกในเซิร์ฟเวอร์เป้าหมายได้ครบถ้วน (ระบบหยุดเพื่อความปลอดภัย)"
    },
    {
        keywords: ["guild_full", "สมาชิกเต็ม", "30005", "maximum number of guilds"],
        message: "เซิร์ฟเวอร์ปลายทางมีสมาชิกถึงจำนวนสูงสุดแล้ว"
    },
    {
        keywords: ["active_campaign_exists", "มีงานดึงสมาชิกกำลังทำงาน"],
        message: "มีงานดึงสมาชิกกำลังทำงานอยู่แล้วในระบบ กรุณารอให้งานเดิมเสร็จก่อนนะครับ"
    },
    {
        keywords: ["token_unavailable", "invalid_grant"],
        message: "โทเค็นสำหรับดึงสมาชิกไม่พร้อมใช้งานหรือหมดอายุ"
    },
    {
        keywords: ["50001", "50013", "missing access", "missing permissions"],
        message: "บอทไม่มีสิทธิ์ที่จำเป็นในการดำเนินการนี้ (กรุณาตรวจสอบสิทธิ์ของบอทในเซิร์ฟเวอร์)"
    },
    {
        keywords: ["10004", "unknown guild"],
        message: "ไม่พบเซิร์ฟเวอร์ปลายทาง หรือบอทไม่ได้อยู่ในเซิร์ฟเวอร์ดังกล่าวแล้ว"
    }
]);

function _isTechnicalStackTrace(reason, lower) {
    return lower.includes("error") || reason.includes("at ") || reason.includes("SQLITE_") || reason.includes("ENOENT");
}

function sanitizeUserFacingError(reason) {
    if (!reason || typeof reason !== "string") return "เกิดข้อผิดพลาดในการเชื่อมต่อ";
    const lower = reason.toLowerCase();

    for (const rule of USER_ERROR_RULES) {
        if (rule.keywords.some(k => lower.includes(k))) {
            return rule.message;
        }
    }

    if (_isTechnicalStackTrace(reason, lower)) {
        return "ระบบขัดข้องชั่วคราว ไม่สามารถดำเนินการต่อได้";
    }
    return reason;
}

async function sendFinalSummaryEmbed({
    webhookUrl,
    mode,
    targetGuildName,
    targetGuildId,
    sourceGuildName,
    sourceGuildId,
    requestedQuota,
    joinedCount,
    alreadyCount,
    failedCount,
    processedCount,
    retryCount = 0,
    durationMs,
    finalStatus = "COMPLETED",
    statusReason = null
}) {
    if (!webhookUrl || !isValidDiscordWebhookUrl(webhookUrl)) return;

    let color = 0x57F287; // Green
    let title = `${emoji.boost} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เสร็จสิ้นสมบูรณ์)`;
    let description = `ดำเนินการดึงสมาชิกเข้าสู่ **${targetGuildName || targetGuildId}** ครบตามเป้าหมายเรียบร้อยแล้วครับ`;
    let statusLabel = "สำเร็จครบตามเป้าหมาย";

    if (finalStatus === "INTERRUPTED") {
        color = 0x5865F2; // Blurple
        const statusEmoji = emoji.refresh || emoji.loading || "🔄";
        title = `${statusEmoji} รายงานสถานะการดึงสมาชิก (หยุดชั่วคราวเพื่อรีสตาร์ต)`;
        description = `ระบบหยุดทำงานชั่วคราวเนื่องจากบอทปิดระบบ (Graceful Shutdown) และจะกลับมาทำงานต่ออัตโนมัติเมื่อระบบเริ่มใหม่`;
        statusLabel = "หยุดชั่วคราว (รอทำต่ออัตโนมัติ)";
    } else if (finalStatus === "PARTIAL") {
        color = 0xFEE75C; // Yellow
        title = `${emoji.boost} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เสร็จสิ้นบางส่วน)`;
        description = `ดำเนินการดึงสมาชิกเข้าสู่ **${targetGuildName || targetGuildId}** เรียบร้อยแล้ว (สมาชิกที่พร้อมดึงในระบบหมดแล้ว)`;
        statusLabel = "เสร็จสิ้นบางส่วน";
    } else if (finalStatus === "SERVER_FULL") {
        color = 0xFEE75C; // Yellow
        title = `${emoji.alert} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เซิร์ฟเวอร์เต็ม)`;
        description = `เซิร์ฟเวอร์ปลายทางมีสมาชิกถึงจำนวนสูงสุดแล้ว ระบบจึงหยุดทำงาน`;
        statusLabel = "หยุดทำงาน (เซิร์ฟเวอร์เต็ม)";
    } else if (finalStatus === "FAILED") {
        color = 0xED4245; // Red
        title = `${emoji.error} สรุปผลการดึงสมาชิกเข้าเซิร์ฟเวอร์ (เกิดข้อผิดพลาด)`;
        const friendlyReason = sanitizeUserFacingError(statusReason);
        description = `การดึงสมาชิกหยุดชะงักเนื่องจาก: ${friendlyReason}`;
        statusLabel = "เกิดข้อผิดพลาด";
    }

    const fields = [
        {
            name: `${emoji.sparkle} รูปแบบการดึง`,
            value: mode?.label || "ทั้งระบบ → ปลายทาง",
            inline: true
        },
        {
            name: `${emoji.server} เซิร์ฟเวอร์ปลายทาง`,
            value: targetGuildName ? `${targetGuildName} (\`${targetGuildId}\`)` : `\`${targetGuildId}\``,
            inline: true
        }
    ];

    if (mode?.requiresSource && sourceGuildId) {
        fields.push({
            name: `${emoji.server} เซิร์ฟเวอร์ต้นทาง`,
            value: sourceGuildName ? `${sourceGuildName} (\`${sourceGuildId}\`)` : `\`${sourceGuildId}\``,
            inline: true
        });
    }

    fields.push(
        {
            name: `${emoji.boost} เป้าหมายที่ต้องการ`,
            value: `**${Number(requestedQuota).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.success} ดึงเข้าสำเร็จจริง`,
            value: `**${Number(joinedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.members} อยู่ในเซิร์ฟแล้ว`,
            value: `**${Number(alreadyCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.error} ไม่สามารถดึงได้`,
            value: `**${Number(failedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.loading} ตรวจเช็กไปแล้ว`,
            value: `**${Number(processedCount).toLocaleString("th-TH")}** คน`,
            inline: true
        },
        {
            name: `${emoji.alert} จำนวนครั้งที่ลองใหม่`,
            value: `**${Number(retryCount).toLocaleString("th-TH")}** ครั้ง`,
            inline: true
        },
        {
            name: `${emoji.shield} สถานะสุดท้าย`,
            value: `**${statusLabel}**`,
            inline: true
        },
        {
            name: `${emoji.sparkle} เวลาที่ใช้ทั้งหมด`,
            value: formatDurationThai(durationMs),
            inline: true
        }
    );

    const embed = {
        title,
        description,
        color,
        fields,
        timestamp: new Date().toISOString()
    };

    await sendRawWebhook(webhookUrl, {
        embeds: [embed],
        allowed_mentions: { parse: [] }
    });
}

module.exports = {
    isValidDiscordWebhookUrl,
    formatDurationThai,
    sendRawWebhook,
    sendBatchLog,
    sendFinalSummaryEmbed,
    sanitizeUserFacingError
};
