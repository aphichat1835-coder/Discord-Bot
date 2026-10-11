"use strict";

const emoji = require("../ui/emojis");

class GuildToGuildMode {
    get id() {
        return "GUILD_TO_GUILD";
    }

    get label() {
        return "เฉพาะเซิฟดึงเซิฟ";
    }

    get description() {
        return "ดึงเฉพาะสมาชิกที่ยืนยันตัวตนจากเซิร์ฟเวอร์ต้นทางไปยังเซิร์ฟเวอร์ปลายทาง";
    }

    get selectEmoji() {
        return emoji.members;
    }

    get requiresSource() {
        return true;
    }

    getBaseModalFields(current = {}) {
        return [
            {
                id: "source_guild_id",
                label: "ไอดีเซิร์ฟเวอร์ต้นทาง",
                placeholder: "ใส่ไอดีเซิร์ฟเวอร์ต้นทาง (ตัวเลข 17–22 หลัก)",
                required: true,
                value: current.sourceGuildId || ""
            },
            {
                id: "target_guild_id",
                label: "ไอดีเซิร์ฟเวอร์ปลายทาง",
                placeholder: "ใส่ไอดีเซิร์ฟเวอร์ปลายทาง (ตัวเลข 17–22 หลัก)",
                required: true,
                value: current.targetGuildId || ""
            }
        ];
    }

    getBaseSetupFields(current = {}) {
        return this.getBaseModalFields(current);
    }

    buildMongoFilter(baseConfig = {}) {
        const sourceGuildId = String(baseConfig.sourceGuildId || "").trim();
        return {
            "lastVerify.guildId": sourceGuildId,
            "lastVerify.result": "success",
            isDeleted: { $ne: true }
        };
    }

    resolveCandidateFilter(baseConfig = {}) {
        return this.buildMongoFilter(baseConfig);
    }

    formatPanelFields({ panelState, readyCount, liveJob, sourceGuildName, targetGuildName }) {
        const sourceDisplay = panelState.sourceGuildId
            ? (sourceGuildName ? `${sourceGuildName} (\`${panelState.sourceGuildId}\`)` : `\`${panelState.sourceGuildId}\``)
            : "ยังไม่ได้ระบุ";

        const targetDisplay = panelState.targetGuildId
            ? (targetGuildName ? `${targetGuildName} (\`${panelState.targetGuildId}\`)` : `\`${panelState.targetGuildId}\``)
            : "ยังไม่ได้ระบุ";

        const readyDisplay = readyCount !== null && readyCount !== undefined
            ? `**${Number(readyCount).toLocaleString("th-TH")}** คน`
            : "กำลังตรวจสอบ...";

        return [
            {
                name: `${emoji.sparkle} รูปแบบการดึง`,
                value: `**${this.label}**`,
                inline: false
            },
            {
                name: `${emoji.server} เซิร์ฟเวอร์ต้นทาง`,
                value: sourceDisplay,
                inline: true
            },
            {
                name: `${emoji.server} เซิร์ฟเวอร์ปลายทาง`,
                value: targetDisplay,
                inline: true
            },
            {
                name: `${emoji.members} สมาชิกพร้อมดึงเข้า`,
                value: readyDisplay,
                inline: false
            }
        ];
    }
}

module.exports = new GuildToGuildMode();
