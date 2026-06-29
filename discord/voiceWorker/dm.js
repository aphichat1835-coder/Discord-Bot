const { MessageEmbed } = require("discord.js");
const sessionManager = require("../sessionManager");
const { st, lastDMSent, lastOnlineDMSent } = require("./state");
const { CONFIG } = require("./config");
const { getSessionShortId } = require("./session");
const { sanitizeLogText } = require("../core/safeLogger");
const {
    getGuildLabel,
    getVoiceLabel,
    buildVoiceFields,
    refreshSessionMetadataFast,
} = require("./display");

// ════════════════════════════════════════════════════════════════════════════
//  📨  REGION 8: DM NOTIFICATION
// ════════════════════════════════════════════════════════════════════════════
async function sendSessionStoppedDM(sessionId, reason) {
    if (!st.mainClient) return;

    const lastSent = lastDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < CONFIG.DM_THROTTLE_MS) return;
    lastDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session?.ownerId) return;

    try {
        await refreshSessionMetadataFast(sessionId, 1200).catch(() => {});

        const owner = await st.mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const colorMap = {
            maxRetries: "#ED4245",
            idle: "#FEE75C",
            manual: "#5865F2",
            disconnect: "#ED4245"
        };

        let reasonText;
        let actionText;

        if (reason === "maxRetries") {
            reasonText = `บอทพยายามกลับเข้าช่องเสียงซ้ำ ${CONFIG.MAX_RECONNECT_ATTEMPTS} ครั้งแต่ไม่สำเร็จ ระบบจึงหยุดทำงาน`;
            actionText = "ให้กดเริ่มใหม่ผ่านแผงควบคุมในเซิร์ฟเวอร์ หากช่องเสียงมีปัญหาให้ตรวจสอบสิทธิ์ของบัญชีและช่องเสียง";
        } else if (reason === "idle") {
            reasonText = "Session ไม่ได้มี activity นานเกินเวลาที่ตั้งไว้ ระบบจึงหยุดและลบ session นี้ออก";
            actionText = "หากต้องการให้ออนอีกครั้ง ให้เริ่ม session ใหม่";
        } else if (reason === "manual") {
            reasonText = "มีการสั่งหยุด session นี้ด้วยตนเอง";
            actionText = "หากต้องการให้ออนอีกครั้ง ให้เริ่ม session ใหม่";
        } else {
            reasonText = "การเชื่อมต่อขัดข้องกะทันหัน";
            actionText = "ระบบจะพยายามกู้คืนอัตโนมัติหาก session ยังอยู่";
        }

        const embed = new MessageEmbed()
            .setColor(colorMap[reason] || "#555555")
            .setAuthor({
                name: st.mainClient.user?.username || "Enterprise",
                iconURL: st.mainClient.user?.displayAvatarURL()
            })
            .setTitle("🤖 แจ้งเตือนระบบออนช่องเสียง")
            .setDescription(`Session ในเซิร์ฟเวอร์ **${getGuildLabel(session)}** หยุดออนช่องเสียงแล้ว`)
            .addFields(buildVoiceFields(session, {
                reason: reasonText,
                action: actionText
            }))
            .setTimestamp()
            .setFooter({
                text: "Phomueangtai Enterprise",
                iconURL: st.mainClient.user?.displayAvatarURL()
            });

        if (session.accountAvatar) {
            embed.setThumbnail(session.accountAvatar);
        }

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send DM for ${sanitizeLogText(sessionId)}: ${e.message}`);
    }
}

async function sendTokenInvalidDM(sessionId) {
    if (!st.mainClient) return;

    const lastSent = lastDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < CONFIG.DM_THROTTLE_MS) return;
    lastDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session?.ownerId) return;

    try {
        const owner = await st.mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const embed = new MessageEmbed()
            .setColor("#ED4245")
            .setAuthor({
                name: st.mainClient.user?.username || "Enterprise",
                iconURL: st.mainClient.user?.displayAvatarURL()
            })
            .setTitle("🚫 Token ใช้งานไม่ได้")
            .setDescription("ระบบไม่สามารถเข้าสู่ระบบบัญชีที่ใช้สำหรับออนช่องเสียงได้")
            .addFields(
                { name: "🖥️ เซิร์ฟเวอร์", value: getGuildLabel(session), inline: true },
                { name: "🎙️ ช่องเสียง", value: getVoiceLabel(session), inline: true },
                { name: "📋 สาเหตุที่เป็นไปได้", value: "Token ผิด / Token หมดอายุ / บัญชีถูกล็อก / Discord ปฏิเสธการเข้าสู่ระบบ" },
                { name: "💡 ต้องทำอะไร", value: "ตรวจสอบ token หรือใช้บัญชีอื่นเริ่ม session ใหม่" },
                { name: "🧩 Session", value: `\`${getSessionShortId(sessionId)}\``, inline: true }
            )
            .setTimestamp()
            .setFooter({
                text: "Phomueangtai Enterprise",
                iconURL: st.mainClient.user?.displayAvatarURL()
            });

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send token invalid DM for ${sanitizeLogText(sessionId)}: ${e.message}`);
    }
}

async function sendSessionOnlineDM(sessionId) {
    if (!st.mainClient) return;

    const lastSent = lastOnlineDMSent.get(sessionId) || 0;
    if (Date.now() - lastSent < 300000) return;
    lastOnlineDMSent.set(sessionId, Date.now());

    const session = sessionManager.getSession(sessionId);
    if (!session?.ownerId) return;

    try {
        await refreshSessionMetadataFast(sessionId, 1200).catch(() => {});

        const owner = await st.mainClient.users.fetch(session.ownerId).catch(() => null);
        if (!owner) return;

        const embed = new MessageEmbed()
            .setColor("#57F287")
            .setAuthor({
                name: st.mainClient.user?.username || "Enterprise",
                iconURL: st.mainClient.user?.displayAvatarURL()
            })
            .setTitle("✅ กลับมาออนช่องเสียงแล้ว")
            .setDescription(`Session ในเซิร์ฟเวอร์ **${getGuildLabel(session)}** กลับมาเชื่อมต่อได้ตามปกติ`)
            .addFields(buildVoiceFields(session, {
                reason: "ระบบกู้คืนการเชื่อมต่อสำเร็จ"
            }))
            .setTimestamp()
            .setFooter({
                text: "Phomueangtai Enterprise",
                iconURL: st.mainClient.user?.displayAvatarURL()
            });

        if (session.accountAvatar) {
            embed.setThumbnail(session.accountAvatar);
        }

        owner.send({ embeds: [embed] }).catch(() => {});
    } catch (e) {
        console.error(`[WORKER] ❌ Failed to send online DM for ${sanitizeLogText(sessionId)}: ${e.message}`);
    }
}

module.exports = { sendSessionStoppedDM, sendTokenInvalidDM, sendSessionOnlineDM };
