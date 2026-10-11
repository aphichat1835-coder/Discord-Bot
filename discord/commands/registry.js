const VALID_OPTION_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

function assertSlashName(name, label, { allowUnderscore = false } = {}) {
    const re = allowUnderscore ? /^[a-z0-9_-]{1,32}$/ : /^[a-z0-9-]{1,32}$/;
    if (typeof name !== "string" || !re.test(name)) {
        throw new Error(`${label} has invalid slash-command name`);
    }
}

function assertDescription(description, label) {
    if (typeof description !== "string" || description.length < 1 || description.length > 100) {
        throw new Error(`${label} has invalid description`);
    }
}

function validateOption(option, commandName, index) {
    const label = `/${commandName} option[${index}]`;
    if (!option || typeof option !== "object" || Array.isArray(option)) {
        throw new Error(`${label} must be an object`);
    }
    if (!VALID_OPTION_TYPES.has(option.type)) {
        throw new Error(`${label} has invalid type`);
    }
    assertSlashName(option.name, label, { allowUnderscore: true });
    assertDescription(option.description, label);
    if (option.required !== undefined && typeof option.required !== "boolean") {
        throw new Error(`${label} has invalid required flag`);
    }
    if (option.choices !== undefined) {
        if (!Array.isArray(option.choices)) throw new Error(`${label} choices must be an array`);
        for (const choice of option.choices) {
            if (!choice || typeof choice !== "object" || typeof choice.name !== "string" || choice.value === undefined) {
                throw new Error(`${label} has invalid choice`);
            }
        }
    }
    if (option.options !== undefined) {
        if (!Array.isArray(option.options)) throw new Error(`${label} options must be an array`);
        option.options.forEach((nestedOption, nestedIndex) => validateOption(nestedOption, `${commandName} ${option.name}`, nestedIndex));
    }
}

function validateSlashCommandsData(commands) {
    if (!Array.isArray(commands) || commands.length < 1) {
        throw new Error("slash command registry is empty");
    }

    const seen = new Set();
    for (const [index, command] of commands.entries()) {
        const label = `slashCommandsData[${index}]`;
        if (!command || typeof command !== "object" || Array.isArray(command)) {
            throw new Error(`${label} must be an object`);
        }
        assertSlashName(command.name, label);
        assertDescription(command.description, label);
        if (seen.has(command.name)) throw new Error(`duplicate slash command: /${command.name}`);
        seen.add(command.name);
        if (command.dmPermission !== false) throw new Error(`/${command.name} must be guild-only`);
        if (command.options !== undefined) {
            if (!Array.isArray(command.options)) throw new Error(`/${command.name} options must be an array`);
            command.options.forEach((option, optionIndex) => validateOption(option, command.name, optionIndex));
        }
    }

    return commands;
}

const slashCommandsData = [
    { name: "voice-online", description: "เรียกแผงควบคุมระบบออนช่องเสียง" },
    { name: "serverinfo", description: "ดูสมาชิก ช่อง ความปลอดภัย Boost และทรัพยากรของเซิร์ฟเวอร์" },
    { name: "ping",       description: "วัดการตอบสนอง RAM CPU และสถานะระบบแบบเรียลไทม์" },

    {
        name: "userinfo",
        description: "ดูบัญชี อายุ ยศ สิทธิ์ และสถานะของสมาชิกในเซิร์ฟเวอร์",
        options: [
            { type: 6, name: "member", description: "สมาชิกที่ต้องการดูข้อมูล", required: false }
        ]
    },

    {
        name: "user",
        description: "ดูรูปโปรไฟล์ของสมาชิก",
        options: [
            {
                type: 1,
                name: "avatar",
                description: "แสดงรูปโปรไฟล์ของสมาชิก",
                required: false,
                options: [
                    {
                        type: 6,
                        name: "member",
                        description: "สมาชิกที่ต้องการดูรูปโปรไฟล์",
                        required: false
                    }
                ]
            }
        ]
    },

    {
        name: "clear",
        description: "ลบข้อความในช่องนี้ สูงสุด 1,000 ข้อความ",
        options: [
            { type: 4, name: "amount", description: "จำนวนข้อความที่ต้องการลบ (1-1,000)", required: true, min_value: 1, max_value: 1000 }
        ]
    },

    {
        name: "say",
        description: "ส่งข้อความในนามระบบ",
        options: [
            { type: 3, name: "message", description: "ข้อความที่ต้องการส่ง", required: true, min_length: 1, max_length: 2000 }
        ]
    },

    {
        name: "embed",
        description: "ระบบสร้างข้อความประกาศแบบ Embed",
        options: [
            {
                type: 1,
                name: "create",
                description: "สร้างและส่งข้อความ Embed สำหรับประกาศ",
                required: false,
                options: [
                    { type: 3, name: "description", description: "เนื้อหาหลักของ Embed รองรับ Markdown และขึ้นบรรทัดใหม่", required: true, min_length: 1, max_length: 4096 },
                    { type: 3, name: "title", description: "หัวข้อของ Embed", required: false, max_length: 256 },
                    { type: 7, name: "channel", description: "ช่องที่จะส่ง Embed นี้", required: false },
                    { type: 3, name: "content", description: "ข้อความปกตินอก Embed รองรับ @everyone, @here, ผู้ใช้ และยศ", required: false, max_length: 2000 },
                    { type: 3, name: "color", description: "สีขอบด้านซ้ายของ Embed แบบ HEX เช่น #5865F2 หรือ FF0000", required: false },
                    { type: 3, name: "image", description: "URL ของรูปภาพหลักขนาดใหญ่ใน Embed", required: false, max_length: 2048 },
                    { type: 3, name: "thumbnail", description: "URL ของรูปภาพขนาดเล็กบริเวณมุมขวาบน", required: false, max_length: 2048 },
                    { type: 3, name: "footer", description: "ข้อความที่แสดงด้านล่างของ Embed", required: false, max_length: 2048 },
                    { type: 3, name: "url", description: "URL ที่จะเปิดเมื่อกดหัวข้อของ Embed", required: false, max_length: 2048 },
                    { type: 5, name: "timestamp", description: "เพิ่มเวลาปัจจุบันลงใน Embed", required: false },
                    { type: 3, name: "button_label", description: "ข้อความที่แสดงบนปุ่มลิงก์", required: false, max_length: 80 },
                    { type: 3, name: "button_url", description: "URL ที่ปุ่มจะเปิดเมื่อกด", required: false, max_length: 2048 }
                ]
            }
        ]
    },

    {
        name: "copy-emojis",
        description: "คัดลอกอิโมจิเข้าเซิร์ฟเวอร์ สูงสุด 50 ตัว",
        options: [
            { type: 3, name: "emojis", description: "อิโมจิที่ต้องการคัดลอก", required: true }
        ]
    },

    { name: "voice-admin", description: "เปิดแผงจัดการห้องเสียง (เฉพาะผู้ดูแล)" },

    {
        name: "ban",
        description: "แบนสมาชิกออกจากเซิร์ฟเวอร์",
        options: [
            { type: 6, name: "target", description: "สมาชิกที่ต้องการแบน", required: true },
            {
                type: 4,
                name: "delete_messages",
                description: "ข้อความย้อนหลังที่จะลบ",
                required: false,
                choices: [
                    { name: "ไม่ลบข้อความ", value: 0 },
                    { name: "ย้อนหลัง 1 ชั่วโมง", value: 3600 },
                    { name: "ย้อนหลัง 6 ชั่วโมง", value: 21600 },
                    { name: "ย้อนหลัง 24 ชั่วโมง (1 วัน)", value: 86400 },
                    { name: "ย้อนหลัง 3 วัน", value: 259200 },
                    { name: "ย้อนหลัง 7 วัน", value: 604800 }
                ]
            },
            { type: 3, name: "reason", description: "เหตุผลในการแบน", required: false, max_length: 500 }
        ]
    },

    {
        name: "kick",
        description: "เตะสมาชิกออกจากเซิร์ฟเวอร์",
        options: [
            { type: 6, name: "target", description: "สมาชิกที่ต้องการเตะ", required: true },
            { type: 3, name: "reason", description: "เหตุผลในการเตะ", required: false, max_length: 500 }
        ]
    },

    {
        name: "timeout",
        description: "ตั้ง Timeout ให้สมาชิก หรือใส่ 0 เพื่อปลด",
        options: [
            { type: 6, name: "target", description: "สมาชิกที่ต้องการ Timeout", required: true },
            { type: 4, name: "duration", description: "ระยะเวลา Timeout (ใส่ 0 เพื่อปลด)", required: true, min_value: 0 },
            {
                type: 3,
                name: "unit",
                description: "หน่วยเวลา",
                required: false,
                choices: [
                    { name: "นาที", value: "minutes" },
                    { name: "ชั่วโมง", value: "hours" },
                    { name: "วัน", value: "days" },
                    { name: "วินาที", value: "seconds" }
                ]
            },
            { type: 3, name: "reason", description: "เหตุผลในการ Timeout", required: false, max_length: 500 }
        ]
    },

    {
        name: "setup-verify",
        description: "ติดตั้งแผงยืนยันตัวตนและมอบยศอัตโนมัติ",
        options: [
            { type: 7, name: "channel", description: "ห้องที่จะส่งแผงยืนยันตัวตน", required: true },
            { type: 8, name: "role", description: "ยศที่จะมอบหลังยืนยันตัวตนสำเร็จ", required: true },
            { type: 5, name: "verify_type", description: "เปิดเพื่อใช้ OAuth2 หรือปิดเพื่อให้กดรับยศทันที", required: false },
            { type: 3, name: "content", description: "ข้อความที่จะส่งพร้อมแผง", required: false, max_length: 2000 },
            { type: 3, name: "title", description: "หัวข้อของ Embed", required: false, max_length: 256 },
            { type: 3, name: "description", description: "รายละเอียดของ Embed", required: false, max_length: 4096 },
            { type: 3, name: "button_text", description: "ข้อความบนปุ่มยืนยัน", required: false, max_length: 80 },
            { type: 3, name: "color", description: "สีของ Embed แบบ HEX", required: false },
            { type: 3, name: "image", description: "ลิงก์รูปภาพหลัก", required: false, max_length: 2048 },
            { type: 3, name: "thumbnail", description: "ลิงก์รูปภาพขนาดเล็ก", required: false, max_length: 2048 },
            { type: 3, name: "footer", description: "ข้อความท้าย Embed", required: false, max_length: 2048 },
            { type: 5, name: "timestamp", description: "แสดงเวลาที่ท้าย Embed", required: false },
            { type: 3, name: "url", description: "ลิงก์เมื่อกดหัวข้อ Embed", required: false, max_length: 2048 }
        ]
    },

    {
        name: "re-role",
        description: "ถอดยศสมาชิกทั้งหมด หรือเลือกยศที่ต้องการถอดได้",
        options: [
            {
                type: 8,
                name: "target_role",
                description: "ยศที่ต้องการถอด หากไม่เลือกจะถอดยศที่บอทจัดการได้ทั้งหมด",
                required: false
            },
            ...[1, 2, 3, 4, 5].map(index => ({
                type: 8,
                name: `role_${index}`,
                description: "ยศที่ต้องการเว้นไว้",
                required: false
            }))
        ]
    },

    {
        name: "quest",
        description: "ระบบ Discord Quest อัตโนมัติ",
        options: [
            {
                type: 1,
                name: "panel",
                description: "เปิดแผงควบคุมระบบ Quest อัตโนมัติ (เฉพาะเจ้าของบอท)",
                required: false,
                options: [
                    {
                        type: 5,
                        name: "auto_daily",
                        description: "แสดงปุ่ม AUTO DAILY บนแผงควบคุม (ค่าเริ่มต้น: ปิด)",
                        required: false
                    }
                ]
            }
        ]
    },

    {
        name: "token-check",
        description: "เปิดแผงตรวจสอบ Discord Token"
    },

    {
        name: "dm-panel",
        description: "เปิดแผงควบคุมระบบกระจายข้อความ DM ผ่านบอทตัวรอง (เฉพาะเจ้าของบอท)"
    },

    {
        name: "join-panel",
        description: "เปิดแผงควบคุมดึงสมาชิกเข้าเซิร์ฟเวอร์",
        options: [
            { type: 3, name: "target_guild", description: "ไอดีเซิร์ฟเวอร์ปลายทาง", required: false },
            { type: 3, name: "source_guild", description: "ไอดีเซิร์ฟเวอร์ต้นทาง", required: false }
        ]
    }
].map(command => ({ ...command, dmPermission: false }));

validateSlashCommandsData(slashCommandsData);

module.exports = { slashCommandsData, validateSlashCommandsData };
