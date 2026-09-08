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
        name: "clear",
        description: "ลบข้อความในช่องปัจจุบัน รวมข้อความเกิน 14 วัน (สูงสุด 1,000)",
        options: [
            { type: 4, name: "amount", description: "จำนวนข้อความ (1-1000)", required: true, min_value: 1, max_value: 1000 }
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
        name: "announce",
        description: "ส่งข้อความประกาศแบบ Embed ปรับแต่งได้อิสระ",
        options: [
            { type: 3, name: "message", description: String.raw`เนื้อหาประกาศใน Embed (รองรับ Markdown และ \n)`, required: true, min_length: 1, max_length: 4096 },
            { type: 3, name: "title",   description: "หัวข้อประกาศ", required: false, max_length: 256 },
            { type: 7, name: "channel", description: "ห้องที่จะส่งประกาศ (ถ้าไม่ระบุจะส่งห้องนี้)", required: false },
            { type: 3, name: "content", description: "ข้อความดิบนอก Embed (รองรับ @everyone / @here / user / role)", required: false, max_length: 2000 },
            { type: 3, name: "color", description: "สีขอบ Embed แบบ HEX เช่น #5865F2 หรือ FF0000", required: false },
            { type: 3, name: "image", description: "ลิงก์รูปภาพหลักขนาดใหญ่ใน Embed", required: false, max_length: 2048 },
            { type: 3, name: "thumbnail", description: "ลิงก์รูปภาพเล็กมุมขวาของ Embed", required: false, max_length: 2048 },
            { type: 3, name: "footer", description: "ข้อความท้าย Embed", required: false, max_length: 2048 },
            { type: 3, name: "footer_icon", description: "ลิงก์ไอคอนท้าย Embed", required: false, max_length: 2048 },
            { type: 3, name: "author_name", description: "ชื่อผู้เขียนด้านบน Embed", required: false, max_length: 256 },
            { type: 3, name: "author_icon", description: "ลิงก์ไอคอนผู้เขียนด้านบน Embed", required: false, max_length: 2048 },
            { type: 3, name: "url", description: "ลิงก์ที่หัวข้อ Embed จะกดเข้าไปได้", required: false, max_length: 2048 },
            { type: 5, name: "timestamp", description: "เปิดหรือปิดเวลาใต้ Embed", required: false },
            { type: 3, name: "button_text", description: "ข้อความบนปุ่มลิงก์แนบประกาศ", required: false, max_length: 80 },
            { type: 3, name: "button_url", description: "ลิงก์ URL ปลายทางของปุ่ม (ต้องขึ้นต้นด้วย http:// หรือ https://)", required: false, max_length: 2048 }
        ]
    },

    {
        name: "copy-emojis",
        description: "ดึงอิโมจิเข้าเซิร์ฟเวอร์ (สูงสุด 50 ตัว)",
        options: [
            { type: 3, name: "emojis", description: "วางอิโมจิที่ต้องการดึง", required: true }
        ]
    },

    { name: "backup", description: "บันทึกโครงสร้างเซิร์ฟเวอร์ (เฉพาะเจ้าของ)" },

    {
        name: "restore",
        description: "กู้คืนโครงสร้างเซิร์ฟเวอร์",
        options: [
            { type: 3, name: "server_id", description: "ไอดีเซิร์ฟเวอร์ต้นทาง", required: true },
            { type: 5, name: "dry_run", description: "ดูแผนกู้คืนก่อน โดยยังไม่สร้างอะไร", required: false }
        ]
    },

    { name: "voiceadmin", description: "เปิดแผงจัดการสมาชิกในห้องเสียงนี้ (เฉพาะผู้ดูแล)" },

    {
        name: "ban",
        description: "แบนสมาชิกออกจากเซิร์ฟเวอร์ พร้อมเก็บบันทึกประวัติ",
        options: [
            { type: 6, name: "target", description: "สมาชิกเป้าหมายที่ต้องการแบน", required: true },
            {
                type: 4,
                name: "delete_messages",
                description: "เลือกลบประวัติข้อความย้อนหลังของสมาชิก",
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
        description: "เตะสมาชิกออกจากเซิร์ฟเวอร์ พร้อมเก็บบันทึกประวัติ",
        options: [
            { type: 6, name: "target", description: "สมาชิกเป้าหมายที่ต้องการเตะ", required: true },
            { type: 3, name: "reason", description: "เหตุผลในการเตะ", required: false, max_length: 500 }
        ]
    },

    {
        name: "timeout",
        description: "ระงับการใช้งานสมาชิกชั่วคราว หรือระบุ 0 เพื่อปลด",
        options: [
            { type: 6, name: "target", description: "สมาชิกเป้าหมายที่ต้องการระงับการใช้งาน", required: true },
            { type: 4, name: "duration", description: "จำนวนระยะเวลา (ใส่ 0 เพื่อปลด Timeout)", required: true, min_value: 0 },
            {
                type: 3,
                name: "unit",
                description: "หน่วยของระยะเวลา (ค่าเริ่มต้น: นาที)",
                required: false,
                choices: [
                    { name: "นาที (Minutes)", value: "minutes" },
                    { name: "ชั่วโมง (Hours)", value: "hours" },
                    { name: "วัน (Days)", value: "days" },
                    { name: "วินาที (Seconds)", value: "seconds" }
                ]
            },
            { type: 3, name: "reason", description: "เหตุผลในการระงับการใช้งาน", required: false, max_length: 500 }
        ]
    },

    {
        name: "setup-verify",
        description: "ติดตั้งแผงยืนยันตัวตน พร้อมระบบให้ยศอัตโนมัติ",
        options: [
            { type: 7, name: "channel", description: "ห้องข้อความที่จะให้บอทส่งแผงยืนยันตัวตน", required: true },
            { type: 8, name: "role", description: "ยศที่จะมอบให้สมาชิกหลังยืนยันตัวตนสำเร็จ", required: true },
            { type: 5, name: "verify_type", description: "เปิด = OAuth2 | ปิด = กดรับยศทันที | ไม่กรอก = OAuth2", required: false },
            { type: 3, name: "content", description: "ข้อความนอก Embed เช่น @everyone หรือข้อความประกาศ", required: false, max_length: 2000 },
            { type: 3, name: "title", description: "หัวข้อหลักของ Embed ถ้าไม่กรอกจะใช้ค่าเริ่มต้น", required: false, max_length: 256 },
            { type: 3, name: "description", description: String.raw`คำอธิบายใน Embed ใช้ \n เพื่อขึ้นบรรทัดใหม่ได้`, required: false, max_length: 4096 },
            { type: 3, name: "button_text", description: "ข้อความปุ่ม เช่น ✅ ยืนยันตัวตน ✅ หรือ <:verify:id> ยืนยันตัวตน ✅", required: false, max_length: 80 },
            { type: 3, name: "color", description: "สีขอบ Embed แบบ HEX เช่น #5865F2 หรือ FF0000", required: false },
            { type: 3, name: "image", description: "ลิงก์รูปภาพหลักขนาดใหญ่ใน Embed", required: false, max_length: 2048 },
            { type: 3, name: "thumbnail", description: "ลิงก์รูปภาพเล็กมุมขวาของ Embed", required: false, max_length: 2048 },
            { type: 3, name: "footer", description: "ข้อความท้าย Embed เช่น Verification System", required: false, max_length: 2048 },
            { type: 5, name: "timestamp", description: "เปิดหรือปิดเวลาใต้ Embed", required: false },
            { type: 3, name: "url", description: "ลิงก์ที่หัวข้อ Embed จะกดเข้าไปได้", required: false, max_length: 2048 }
        ]
    },

    {
        name: "rerole",
        description: "คำนวณและกวาดยศสมาชิก โดยเว้นยศที่เลือกไว้",
        options: [1, 2, 3, 4, 5].map(index => ({
            type: 8,
            name: `role_${index}`,
            description: `ยศที่ ${index} ที่ต้องการเว้นไว้ (ไม่ให้ถูกลบ)`,
            required: false
        }))
    },

    {
        name: "quest",
        description: "ระบบ Discord Quest อัตโนมัติ",
        options: [
            {
                type: 1,
                name: "panel",
                description: "เปิดแผงควบคุม NeverDie Auto Quest (เฉพาะเจ้าของบอท)",
                required: false
            }
        ]
    },

    {
        name: "token-check",
        description: "เปิดแผงตรวจสอบ Discord Token (เฉพาะเจ้าของบอท)"
    },

    {
        name: "dm-panel",
        description: "เปิดแผงควบคุมระบบกระจายข้อความ DM ผ่านบอทตัวรอง (เฉพาะเจ้าของบอท)"
    }
].map(command => ({ ...command, dmPermission: false }));

validateSlashCommandsData(slashCommandsData);

module.exports = { slashCommandsData, validateSlashCommandsData };
