"use strict";

const emoji = require("../ui/emojis");

class AllToTargetMode {
    get id() {
        return "ALL_TO_TARGET";
    }

    get label() {
        return "ทั้งระบบ → เซิร์ฟปลายทาง";
    }

    get description() {
        return "ดึงสมาชิกที่พร้อมใช้งานทั้งหมดในฐานข้อมูลเข้าสู่เซิร์ฟเวอร์เป้าหมาย";
    }

    get selectEmoji() {
        return emoji.server;
    }

    get requiresSource() {
        return false;
    }

    getBaseModalFields(current = {}) {
        return [
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

    buildMongoFilter() {
        return {
            isDeleted: { $ne: true }
        };
    }

    resolveCandidateFilter(baseConfig = {}) {
        return this.buildMongoFilter(baseConfig);
    }

    formatPanelFields({ panelState, readyCount, liveJob, targetGuildName }) {
        const targetDisplay = panelState.targetGuildId
            ? (targetGuildName ? `${targetGuildName} (\`${panelState.targetGuildId}\`)` : `\`${panelState.targetGuildId}\``)
            : "ยังไม่ได้ระบุ (เลือกโหมดเพื่อตั้งค่า)";

        const readyDisplay = readyCount !== null && readyCount !== undefined
            ? `**${Number(readyCount).toLocaleString("th-TH")}** คน`
            : "กำลังตรวจสอบ...";

        return [
            {
                name: `${emoji.sparkle} รูปแบบการดึง`,
                value: `**${this.label}**`,
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
                inline: true
            }
        ];
    }
}

module.exports = new AllToTargetMode();
