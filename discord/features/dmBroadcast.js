'use strict';

const {
    Client,
    GatewayIntentBits,
    WebhookClient
} = require('discord.js');
const { MessageEmbed } = require('../core/discordCompat');
const { delay, withTimeoutReject } = require('../core/timers');
const { isDiscordSnowflake } = require('../core/snowflakes');
const config = require('../config.json');

const DISCORD_WEBHOOK_PATTERN = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,22}\/[A-Za-z0-9_-]+$/i;
const PRECHECK_TIMEOUT_MS = 15000;
const STAGED_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Concurrency control: 1 job at a time
let activeBroadcastJob = null;

// Short-lived in-memory staged jobs for pending confirmations
const stagedBroadcasts = new Map();

function isValidWebhookUrl(url) {
    if (typeof url !== 'string') return false;
    return DISCORD_WEBHOOK_PATTERN.test(url.trim());
}

function isBroadcastRunning() {
    return activeBroadcastJob !== null;
}

function getActiveBroadcastJob() {
    return activeBroadcastJob;
}

function stageBroadcast(userId, data) {
    const now = Date.now();
    for (const [key, val] of stagedBroadcasts.entries()) {
        if (now - val.stagedAt > STAGED_TTL_MS) {
            stagedBroadcasts.delete(key);
        }
    }
    stagedBroadcasts.set(String(userId), {
        ...data,
        stagedAt: now
    });
}

function getStagedBroadcast(userId) {
    const key = String(userId);
    const staged = stagedBroadcasts.get(key);
    if (!staged) return null;
    if (Date.now() - staged.stagedAt > STAGED_TTL_MS) {
        stagedBroadcasts.delete(key);
        return null;
    }
    return staged;
}

function clearStagedBroadcast(userId) {
    stagedBroadcasts.delete(String(userId));
}

function formatDuration(ms) {
    const totalSec = Math.max(0, Math.floor(ms / 1000));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    if (mins > 0) {
        return `${mins} นาที ${secs} วินาที`;
    }
    return `${secs} วินาที`;
}

function buildMemberLogEmbed({
    member,
    botUser,
    index,
    total,
    success,
    errorReason = null
}) {
    const color = success
        ? (config.system?.themeColors?.success || '#57F287')
        : (config.system?.themeColors?.error || '#ED4245');

    const statusText = success
        ? '✅ **ส่งสำเร็จ (Delivered)**'
        : `❌ **ล้มเหลว** (${errorReason || 'ผู้ใช้ปิด DM หรือบล็อกบอท'})`;

    const userTag = member.user?.tag || member.user?.username || member.id;
    const avatarUrl = typeof member.user?.displayAvatarURL === 'function'
        ? member.user.displayAvatarURL({ dynamic: true, size: 256 })
        : null;

    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(`[${index}/${total}] แจ้งเตือนการส่ง DM`)
        .addFields(
            { name: '👤 ผู้รับ', value: `<@${member.id}> (\`${userTag}\`)`, inline: true },
            { name: '🆔 User ID', value: `\`${member.id}\``, inline: true },
            { name: '📊 สถานะ', value: statusText, inline: false },
            { name: '⏰ เวลาที่ส่ง', value: `<t:${Math.floor(Date.now() / 1000)}:T> (<t:${Math.floor(Date.now() / 1000)}:R>)`, inline: false }
        )
        .setFooter({
            text: `บอทตัวรอง: ${botUser?.tag || 'Helper Bot'} • Phomueangtai DM System`
        })
        .setTimestamp();

    if (avatarUrl) {
        embed.setThumbnail(avatarUrl);
    }

    return embed;
}

function buildFinalSummaryEmbed({
    guild,
    botUser,
    total,
    sent,
    failed,
    durationMs
}) {
    const color = config.system?.themeColors?.info || '#5865F2';
    const universeEmoji = config.emojis?.universe || '✨';
    const successEmoji = config.emojis?.success || '✅';
    const errorEmoji = config.emojis?.error || '❌';

    const embed = new MessageEmbed()
        .setColor(color)
        .setTitle(`${universeEmoji} : รายงานสรุปการกระจายข้อความ DM`)
        .setDescription(`ภารกิจส่งข้อความไปยังสมาชิกในเซิร์ฟเวอร์ **${guild?.name || 'Unknown Guild'}** ดำเนินการเสร็จสิ้นสมบูรณ์`)
        .addFields(
            { name: '👥 สมาชิกเป้าหมายทั้งหมด', value: `**${total}** คน (ไม่รวมบอท)`, inline: true },
            { name: `${successEmoji} ส่งสำเร็จ`, value: `**${sent}** คน`, inline: true },
            { name: `${errorEmoji} ล้มเหลว (ปิด DM)`, value: `**${failed}** คน`, inline: true },
            { name: '⏱️ เวลาที่ใช้ทั้งหมด', value: `\`${formatDuration(durationMs)}\``, inline: true },
            { name: '🤖 บอทผู้ส่ง (ตัวรอง)', value: `\`${botUser?.tag || botUser?.id || 'Unknown'}\``, inline: true },
            { name: '🌐 เซิร์ฟเวอร์', value: `\`${guild?.name}\` (\`${guild?.id}\`)`, inline: true }
        )
        .setFooter({ text: 'Phomueangtai Personal Multi-Tool • One-shot Session Ended' })
        .setTimestamp();

    if (guild?.iconUrl) {
        embed.setThumbnail(guild.iconUrl);
    }

    return embed;
}

/**
 * Validates the secondary bot token, verifies membership in the guild,
 * checks Server Members Intent, and counts eligible non-bot members.
 */
async function validateSecondaryBot(token, guildId, options = {}) {
    const trimmedToken = String(token || '').trim();
    const targetGuildId = String(guildId || '').trim();

    if (!trimmedToken) {
        return { ok: false, error: 'กรุณากรอก Bot Token ของบอทตัวรอง' };
    }

    if (!isDiscordSnowflake(targetGuildId)) {
        return { ok: false, error: 'Server ID (Guild ID) ไม่ถูกต้องตามรูปแบบ Discord Snowflake (17-22 หลัก)' };
    }

    const ClientClass = options.ClientClass || Client;
    const tempClient = new ClientClass({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers
        ]
    });

    try {
        await withTimeoutReject(
            tempClient.login(trimmedToken),
            PRECHECK_TIMEOUT_MS,
            'การเชื่อมต่อกับ Bot Token หมดเวลา (Login Timeout 15s)'
        );

        let guild = null;
        try {
            guild = await tempClient.guilds.fetch(targetGuildId);
        } catch {
            return {
                ok: false,
                error: `บอทตัวรองไม่ได้อยู่ในเซิร์ฟเวอร์เป้าหมาย (Guild ID: \`${targetGuildId}\`) กรุณาเชิญบอทเข้าเซิร์ฟเวอร์ก่อนใช้งาน`
            };
        }

        let nonBotMembers = [];
        try {
            const memberCollection = await guild.members.fetch();
            if (Array.isArray(memberCollection)) {
                nonBotMembers = memberCollection.filter(m => !m.user?.bot);
            } else if (typeof memberCollection?.filter === 'function') {
                nonBotMembers = memberCollection.filter(m => !m.user?.bot);
            } else if (typeof memberCollection?.values === 'function') {
                nonBotMembers = Array.from(memberCollection.values()).filter(m => !m.user?.bot);
            }
        } catch (fetchErr) {
            const errMsg = String(fetchErr?.message || '');
            if (errMsg.includes('Disallowed') || errMsg.includes('intent') || fetchErr?.code === 4014) {
                return {
                    ok: false,
                    error: "บอทตัวรองไม่ได้เปิดใช้งาน **'Server Members Intent'** ใน Discord Developer Portal (หมวด Bot -> Privileged Gateway Intents)"
                };
            }
            return {
                ok: false,
                error: `ไม่สามารถดึงรายชื่อสมาชิกในเซิร์ฟเวอร์ได้: ${fetchErr.message}`
            };
        }

        const targetCount = nonBotMembers.size !== undefined ? nonBotMembers.size : nonBotMembers.length;
        if (targetCount === 0) {
            return {
                ok: false,
                error: 'ไม่พบสมาชิกที่เป็นบุคคลจริง (Human members) ในเซิร์ฟเวอร์เป้าหมายที่บอทสามารถส่ง DM ได้'
            };
        }

        const botUser = {
            id: tempClient.user?.id || '',
            tag: tempClient.user?.tag || tempClient.user?.username || '',
            avatarUrl: typeof tempClient.user?.displayAvatarURL === 'function'
                ? tempClient.user.displayAvatarURL({ dynamic: true, size: 256 })
                : null
        };

        const guildInfo = {
            id: guild.id,
            name: guild.name,
            iconUrl: typeof guild.iconURL === 'function' ? guild.iconURL({ dynamic: true, size: 256 }) : null
        };

        return {
            ok: true,
            botUser,
            guild: guildInfo,
            targetCount
        };
    } catch (err) {
        const msg = String(err?.message || '');
        if (msg.includes('401') || msg.includes('TOKEN_INVALID') || msg.includes('An invalid token')) {
            return {
                ok: false,
                error: 'Bot Token ไม่ถูกต้อง (Invalid Discord Token) กรุณาตรวจสอบ Token อีกครั้ง'
            };
        }
        return {
            ok: false,
            error: `เกิดข้อผิดพลาดในการตรวจสอบบอทตัวรอง: ${err.message}`
        };
    } finally {
        await tempClient.destroy().catch(() => {});
    }
}

/**
 * Starts the broadcast worker job.
 */
async function startBroadcastJob({
    token,
    guildId,
    message,
    imageUrl = '',
    webhookUrl,
    initiatedBy,
    onProgress = null,
    onComplete = null,
    ClientClass = Client,
    WebhookClientClass = WebhookClient
}) {
    if (activeBroadcastJob !== null) {
        return {
            ok: false,
            error: 'มีงานกระจายข้อความ DM กำลังทำงานอยู่ในขณะนี้ กรุณารอให้งานปัจจุบันเสร็จสิ้นก่อนเริ่มงานใหม่'
        };
    }

    const trimmedToken = String(token || '').trim();
    const targetGuildId = String(guildId || '').trim();
    const cleanMessage = String(message || '').trim();
    const cleanImageUrl = String(imageUrl || '').trim();
    const cleanWebhookUrl = String(webhookUrl || '').trim();

    if (!isValidWebhookUrl(cleanWebhookUrl)) {
        return { ok: false, error: 'ลิงก์ Webhook URL ไม่ถูกต้องตามรูปแบบ Discord Webhook' };
    }

    const broadcastClient = new ClientClass({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.DirectMessages
        ]
    });

    let webhookClient = null;
    try {
        webhookClient = new WebhookClientClass({ url: cleanWebhookUrl });
    } catch (err) {
        return { ok: false, error: `ไม่สามารถเชื่อมต่อกับ Webhook ได้: ${err.message}` };
    }

    activeBroadcastJob = {
        initiatedBy,
        guildId: targetGuildId,
        startedAt: Date.now(),
        total: 0,
        sent: 0,
        failed: 0,
        status: 'running'
    };

    // Run execution asynchronously in the background so the interaction returns promptly
    (async () => {
        let startTime = Date.now();
        let botUser = null;
        let guildInfo = null;

        try {
            await broadcastClient.login(trimmedToken);

            botUser = {
                id: broadcastClient.user?.id,
                tag: broadcastClient.user?.tag || broadcastClient.user?.username || 'Helper Bot'
            };

            const guild = await broadcastClient.guilds.fetch(targetGuildId);
            guildInfo = {
                id: guild.id,
                name: guild.name,
                iconUrl: typeof guild.iconURL === 'function' ? guild.iconURL({ dynamic: true, size: 256 }) : null
            };

            const memberCollection = await guild.members.fetch();
            const rawMembers = Array.isArray(memberCollection)
                ? memberCollection
                : (typeof memberCollection?.values === 'function' ? Array.from(memberCollection.values()) : []);
            const memberList = rawMembers.filter(m => !m.user?.bot);

            activeBroadcastJob.total = memberList.length;

            const dmPayload = {
                content: cleanMessage
            };

            if (cleanImageUrl) {
                const imageEmbed = new MessageEmbed()
                    .setImage(cleanImageUrl);
                dmPayload.embeds = [imageEmbed];
            }

            let index = 0;
            for (const member of memberList) {
                index++;
                let success = false;
                let errorReason = null;

                try {
                    await member.send(dmPayload);
                    success = true;
                    activeBroadcastJob.sent++;
                } catch (dmErr) {
                    activeBroadcastJob.failed++;
                    if (dmErr?.code === 50007) {
                        errorReason = 'ผู้ใช้ปิดรับข้อความ DM หรือไม่มีห้องข้อความร่วมกัน';
                    } else if (dmErr?.status === 429 || dmErr?.code === 429) {
                        let retryAfterMs = 5000;
                        if (typeof dmErr.retryAfter === 'number' && dmErr.retryAfter > 0) {
                            retryAfterMs = dmErr.retryAfter > 1000 ? dmErr.retryAfter : Math.round(dmErr.retryAfter * 1000);
                        }
                        await delay(retryAfterMs);
                        // Retry once
                        try {
                            await member.send(dmPayload);
                            success = true;
                            activeBroadcastJob.sent++;
                            activeBroadcastJob.failed--;
                            errorReason = null;
                        } catch (retryErr) {
                            errorReason = `Rate limit retry failed: ${retryErr.message}`;
                        }
                    } else {
                        errorReason = dmErr?.message || 'ไม่สามารถส่งข้อความได้';
                    }
                }

                // Send individual real-time log to Webhook
                try {
                    const logEmbed = buildMemberLogEmbed({
                        member,
                        botUser,
                        index,
                        total: memberList.length,
                        success,
                        errorReason
                    });
                    await webhookClient.send({ embeds: [logEmbed] }).catch(() => {});
                } catch {
                    // Ignore webhook delivery errors to keep broadcast running
                }

                if (typeof onProgress === 'function') {
                    try {
                        onProgress({
                            index,
                            total: memberList.length,
                            sent: activeBroadcastJob.sent,
                            failed: activeBroadcastJob.failed
                        });
                    } catch {}
                }

                // Adaptive delay: 2.0s to 3.0s between members
                const throttleMs = 2000 + Math.floor(Math.random() * 1000);
                await delay(throttleMs);
            }

            // Broadcast complete: Send final summary to Webhook
            const durationMs = Date.now() - startTime;
            try {
                const summaryEmbed = buildFinalSummaryEmbed({
                    guild: guildInfo,
                    botUser,
                    total: memberList.length,
                    sent: activeBroadcastJob.sent,
                    failed: activeBroadcastJob.failed,
                    durationMs
                });
                await webhookClient.send({ embeds: [summaryEmbed] }).catch(() => {});
            } catch {}

            if (typeof onComplete === 'function') {
                try {
                    onComplete({
                        ok: true,
                        total: memberList.length,
                        sent: activeBroadcastJob.sent,
                        failed: activeBroadcastJob.failed,
                        durationMs
                    });
                } catch {}
            }
        } catch (jobErr) {
            console.error('[DM_BROADCAST] ❌ Broadcast job fatal error:', jobErr.message);
            if (webhookClient) {
                try {
                    const errorEmbed = new MessageEmbed()
                        .setColor(config.system?.themeColors?.error || '#ED4245')
                        .setTitle('❌ การกระจายข้อความ DM หยุดชะงัก')
                        .setDescription(`เกิดข้อผิดพลาดร้ายแรงระหว่างการทำงาน: \`${jobErr.message}\``)
                        .addFields(
                            { name: '📊 สถิติก่อนหยุดทำงาน', value: `ส่งสำเร็จ: **${activeBroadcastJob?.sent || 0}** | ล้มเหลว: **${activeBroadcastJob?.failed || 0}**`, inline: true }
                        )
                        .setTimestamp();
                    await webhookClient.send({ embeds: [errorEmbed] }).catch(() => {});
                } catch {}
            }
            if (typeof onComplete === 'function') {
                try {
                    onComplete({
                        ok: false,
                        error: jobErr.message,
                        sent: activeBroadcastJob?.sent || 0,
                        failed: activeBroadcastJob?.failed || 0
                    });
                } catch {}
            }
        } finally {
            activeBroadcastJob = null;
            await broadcastClient.destroy().catch(() => {});
            if (typeof webhookClient?.destroy === 'function') {
                try { webhookClient.destroy(); } catch {}
            }
        }
    })();

    return {
        ok: true,
        message: 'เริ่มการกระจายข้อความ DM สำเร็จ บอทตัวรองกำลังดำเนินการส่งในเบื้องหลัง'
    };
}

module.exports = {
    DISCORD_WEBHOOK_PATTERN,
    isValidWebhookUrl,
    isBroadcastRunning,
    getActiveBroadcastJob,
    stageBroadcast,
    getStagedBroadcast,
    clearStagedBroadcast,
    formatDuration,
    buildMemberLogEmbed,
    buildFinalSummaryEmbed,
    validateSecondaryBot,
    startBroadcastJob,
    _test: {
        resetActiveJob: () => { activeBroadcastJob = null; },
        setActiveJob: (job) => { activeBroadcastJob = job; },
        stagedBroadcasts
    }
};
