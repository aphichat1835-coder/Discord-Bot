const { MessageEmbed, MessageActionRow, MessageButton, Modal, TextInputComponent } = require("../core/discordCompat");
const config = require("../config.json");
const { IDS, PREFIXES } = require("./customIds");
const {
    getVoiceAccountLabel,
    getVoiceChannelLabel,
    getVoiceStatusLabel
} = require("../sessions/voiceLabels");

const CB = "```";

function buildControlPanelEmbed(_total = null) {
    return new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setTitle(`${config.emojis.universe} : Phomueangtai ระบบออนช่องเสียง`)
        .setDescription(
            `ระบบออนช่องเสียงอัตโนมัติ ${config.emojis.dreamworld}\n\n` +
            `ออนไลน์ฟรีครบ 24. ${config.emojis.dreamworld}\n\n` +
            `ตั้งค่าควบคุมผ่านปุ่มแผงควบคุมด้านล่าง ${config.emojis.dreamworld}\n\n` +
            `*Developed by <@${config.system.ownerId}>*`
        )
        .setImage(config.system.bannerUrl || null);
}

function buildControlPanelRow() {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(IDS.BTN_START)
            .setLabel("เริ่มการทำงาน")
            .setEmoji(config.emojis.signal)
            .setStyle("SUCCESS"),

        new MessageButton()
            .setCustomId(IDS.BTN_STATUS)
            .setLabel("สถานะ & จัดการ")
            .setEmoji(config.emojis.ping)
            .setStyle("PRIMARY"),

        new MessageButton()
            .setCustomId(IDS.BTN_STOP_ALL)
            .setLabel("หยุดทั้งหมด")
            .setEmoji(config.emojis.stop)
            .setStyle("DANGER")
    );
}

function buildVoiceStatusEmbed(session, page, total) {
    const accountLabel = getVoiceAccountLabel(session);
    const avatar =
        session.accountAvatar ||
        session.ownerAvatar ||
        "https://cdn.discordapp.com/embed/avatars/0.png";
    const userIdLabel = session.accountId ? `${CB}${session.accountId}${CB}` : "-";

    return new MessageEmbed()
        .setColor(config.system.themeColors.primary)
        .setAuthor({
            name: accountLabel,
            iconURL: avatar
        })
        .setThumbnail(avatar)
        .setDescription(
            `— **บัญชีที่ออน:** ${CB}${accountLabel}${CB}\n` +
            `— **User ID:** ${userIdLabel}\n` +
            `— **เซิร์ฟเวอร์:** ${CB}${session.serverName || session.serverId || "-"}${CB}\n` +
            `— **ช่องเสียง:** ${getVoiceChannelLabel(session)}\n` +
            `— **สถานะ:** ${getVoiceStatusLabel(session, config)}\n` +
            `— **ออนเมื่อ:** <t:${Math.floor((session.startedAt || Date.now()) / 1000)}:R>\n` +
            `— **Reconnect:** ${session.reconnectCount || 0} ครั้ง`
        )
        .setFooter({ text: `รายการทั้งหมดในระบบ ${page + 1} / ${total}` });
}

function buildVoiceStatusControls(current, page) {
    return new MessageActionRow().addComponents(
        new MessageButton()
            .setCustomId(`${PREFIXES.STATUS_PAGE}${page - 1}`)
            .setEmoji(config.emojis.page_prev)
            .setStyle("SECONDARY"),

        new MessageButton()
            .setCustomId(`${PREFIXES.STATUS_STOP}${current.sessionId}`)
            .setLabel("หยุดออนตัวนี้")
            .setEmoji(config.emojis.status_offline)
            .setStyle("DANGER"),

        new MessageButton()
            .setCustomId(`${PREFIXES.STATUS_PAGE}${page + 1}`)
            .setEmoji(config.emojis.page_next)
            .setStyle("SECONDARY")
    );
}

function buildStartModal() {
    const modal = new Modal()
        .setCustomId(IDS.MODAL_START)
        .setTitle("ออนช่องเสียง");

    modal.addComponents(
        new MessageActionRow().addComponents(
            new TextInputComponent()
                .setCustomId(IDS.FIELD_TOKEN)
                .setLabel("🔑 Token บัญชี")
                .setStyle("SHORT")
                .setRequired(true)
        ),

        new MessageActionRow().addComponents(
            new TextInputComponent()
                .setCustomId(IDS.FIELD_SERVER_ID)
                .setLabel(`${config.emojis.server_icon} ไอดีเซิร์ฟเวอร์`)
                .setStyle("SHORT")
                .setRequired(true)
        ),

        new MessageActionRow().addComponents(
            new TextInputComponent()
                .setCustomId(IDS.FIELD_VOICE_ID)
                .setLabel(`${config.emojis.voice_ch} ไอดีช่องเสียง`)
                .setStyle("SHORT")
                .setRequired(true)
        )
    );

    return modal;
}

module.exports = {
    buildControlPanelEmbed,
    buildControlPanelRow,
    buildVoiceStatusEmbed,
    buildVoiceStatusControls,
    buildStartModal
};
