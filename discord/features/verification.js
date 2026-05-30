/*
 * Verification Feature Module
 * Business logic สำหรับระบบยืนยันตัวตน
 * commands/verification.js ใช้ module นี้เป็น backend
 */
const { MessageEmbed, MessageActionRow, MessageButton } = require('discord.js');
const config         = require('../config.json');
const sessionManager = require('../sessionManager');

// ── สร้าง Verify Embed + Button ──
function buildVerifyEmbed(options = {}) {
    const {
        title       = 'ยืนยันตัวตน',
        description = 'กดปุ่มด้านล่างเพื่อรับยศ',
        colorHex    = config.system.themeColors.primary,
        imageUrl    = null,
        thumbUrl    = null,
        footerText  = null,
        showTs      = false,
        titleUrl    = null,
        roleId,
        roleName    = 'ยศ',
        verifyType  = false,      // false = กดรับยศเลย | true = OAuth2
        dashboardUrl= null
    } = options;

    const embed = new MessageEmbed().setColor(colorHex).setTitle(title);
    if (titleUrl)    embed.setURL(titleUrl);
    if (description) embed.setDescription(description);
    if (imageUrl)    embed.setImage(imageUrl);
    if (thumbUrl)    embed.setThumbnail(thumbUrl);
    if (footerText)  embed.setFooter({ text: footerText });
    if (showTs)      embed.setTimestamp();

    const customId = verifyType ? `verify_oauth_${roleId}` : `verify_role_${roleId}`;
    const button   = new MessageButton()
        .setCustomId(customId)
        .setLabel(`" ${roleName} "`)
        .setEmoji(verifyType ? '🔐' : '🎭')
        .setStyle(verifyType ? 'PRIMARY' : 'SUCCESS');

    const row = new MessageActionRow().addComponents(button);
    return { embeds: [embed], components: [row] };
}

// ── ตรวจสอบว่า member มีสิทธิ์รับยศหรือไม่ ──
async function checkMemberEligibility(member, guildConfig) {
    const v = guildConfig?.verification;
    if (!v?.enabled) return { ok: true };

    // Account age
    const snowflake = BigInt(member.user.id);
    const ageDays   = Math.floor((Date.now() - Number((snowflake >> 22n) + 1420070400000n)) / 86400000);
    const minAge    = v.minAccountAgeDays ?? 7;

    if (ageDays < minAge) {
        return { ok: false, reason: `บัญชีอายุน้อยเกินไป (${ageDays} วัน จาก ${minAge} วันที่ต้องการ)` };
    }

    // ตรวจ existing role
    if (v.roleId && member.roles.cache.has(v.roleId)) {
        return { ok: false, reason: 'คุณมียศนี้อยู่แล้ว', alreadyHas: true };
    }

    return { ok: true };
}

// ── บันทึก verify config ลง DB ──
async function saveVerifyConfig(guildId, data) {
    return sessionManager.setSetting(`verify_config_${guildId}_${data.roleId}`, {
        ...data,
        updatedAt: Date.now()
    });
}

// ── โหลด verify config จาก DB ──
async function loadVerifyConfig(guildId, roleId) {
    return sessionManager.getSetting(`verify_config_${guildId}_${roleId}`, null);
}

module.exports = { buildVerifyEmbed, checkMemberEligibility, saveVerifyConfig, loadVerifyConfig };
