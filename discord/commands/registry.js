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
        if (command.options !== undefined) {
            if (!Array.isArray(command.options)) throw new Error(`/${command.name} options must be an array`);
            command.options.forEach((option, optionIndex) => validateOption(option, command.name, optionIndex));
        }
    }

    return commands;
}

const slashCommandsData = [
    { name: "panel",      description: "เรียกแผงควบคุมระบบออนช่องเสียง" },
    { name: "help",       description: "แสดงคู่มือการใช้งานระบบ Enterprise" },
    { name: "stats",      description: "ดูสถิติการทำงานของระบบ" },
    { name: "serverinfo", description: "แสดงข้อมูลรายละเอียดของเซิร์ฟเวอร์แบบเจาะลึก" },
    { name: "setup-log",  description: "ติดตั้งระบบ Audit Log (ยศ/หมวดหมู่/ห้อง Log)" },
    { name: "setup",      description: "รับลิงก์ Dashboard เพื่อตั้งค่าบอทในเซิร์ฟเวอร์ของคุณ" },
    { name: "ping",       description: "ตรวจสอบ Latency และสถานะระบบ" },

    {
        name: "userinfo",
        description: "แสดงข้อมูลโปรไฟล์ของสมาชิก",
        options: [
            { type: 6, name: "member", description: "สมาชิกที่ต้องการดูข้อมูล", required: false }
        ]
    },

    {
        name: "clear",
        description: "ลบข้อความในช่องปัจจุบัน (สูงสุด 100 ข้อความ)",
        options: [
            { type: 4, name: "amount", description: "จำนวนข้อความ (1-100)", required: true }
        ]
    },

    {
        name: "say",
        description: "ส่งข้อความในนามระบบ",
        options: [
            { type: 3, name: "message", description: "ข้อความที่ต้องการส่ง", required: true }
        ]
    },

    {
        name: "announce",
        description: "ส่งข้อความประกาศแบบ Embed",
        options: [
            { type: 3, name: "title",   description: "หัวข้อประกาศ", required: true },
            { type: 3, name: "message", description: "เนื้อหาประกาศ", required: true },
            { type: 3, name: "content", description: "ข้อความดิบนอก Embed (เช่น @everyone)", required: false },
            { type: 5, name: "allow_mentions", description: "อนุญาตให้ content ping users/roles/everyone (ต้องมีสิทธิ์สูง)", required: false }
        ]
    },

    {
        name: "steal",
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

    { name: "voicekickall", description: "เตะทุกคนในห้องเสียงที่คุณอยู่ (ยกเว้นผู้ดูแล)" },

    {
        name: "ban",
        description: "แบนสมาชิก พร้อม DM แจ้งเตือน",
        options: [
            { type: 6, name: "target", description: "เป้าหมาย", required: true },
            { type: 3, name: "reason", description: "เหตุผล", required: false }
        ]
    },

    {
        name: "kick",
        description: "เตะสมาชิก พร้อม DM แจ้งเตือน",
        options: [
            { type: 6, name: "target", description: "เป้าหมาย", required: true },
            { type: 3, name: "reason", description: "เหตุผล", required: false }
        ]
    },

    {
        name: "timeout",
        description: "ระงับสมาชิกชั่วคราว พร้อม DM แจ้งเตือน",
        options: [
            { type: 6, name: "target",  description: "เป้าหมาย", required: true },
            { type: 4, name: "minutes", description: "จำนวนนาที (1-40000)", required: true },
            { type: 3, name: "reason",  description: "เหตุผล", required: false }
        ]
    },

    {
        name: "case",
        description: "ดูและแก้ไขบันทึก Case ของระบบ Moderation",
        options: [
            {
                type: 1,
                name: "view",
                description: "ดูรายละเอียด Case ตามหมายเลข",
                options: [
                    { type: 4, name: "case_id", description: "หมายเลข Case", required: true }
                ]
            },
            {
                type: 1,
                name: "reason",
                description: "แก้เหตุผลของ Case",
                options: [
                    { type: 4, name: "case_id", description: "หมายเลข Case", required: true },
                    { type: 3, name: "reason", description: "เหตุผลใหม่", required: true }
                ]
            },
            {
                type: 1,
                name: "user",
                description: "ดู Case ล่าสุดของสมาชิก",
                options: [
                    { type: 6, name: "target", description: "สมาชิก", required: true }
                ]
            },
            {
                type: 1,
                name: "latest",
                description: "ดู Case ล่าสุดของสมาชิกหรือของตัวเอง",
                options: [
                    { type: 6, name: "target", description: "สมาชิก", required: false }
                ]
            }
        ]
    },

    {
        name: "whitelist",
        description: "จัดการ Whitelist /say (เฉพาะ Admin)",
        options: [
            { type: 3, name: "action",  description: "add / remove / list", required: true },
            { type: 3, name: "user_id", description: "Discord User ID", required: false }
        ]
    },

    {
        name: "setup-verify",
        description: "ติดตั้งแผงยืนยันตัวตน พร้อมระบบให้ยศอัตโนมัติ",
        options: [
            { type: 7, name: "channel", description: "ห้องข้อความที่จะให้บอทส่งแผงยืนยันตัวตน", required: true },
            { type: 8, name: "role", description: "ยศที่จะมอบให้สมาชิกหลังยืนยันตัวตนสำเร็จ", required: true },
            { type: 5, name: "verify_type", description: "เปิด = OAuth2 | ปิด = กดรับยศทันที | ไม่กรอก = OAuth2", required: false },
            { type: 3, name: "content", description: "ข้อความนอก Embed เช่น @everyone หรือข้อความประกาศ", required: false },
            { type: 3, name: "title", description: "หัวข้อหลักของ Embed ถ้าไม่กรอกจะใช้ค่าเริ่มต้น", required: false },
            { type: 3, name: "description", description: String.raw`คำอธิบายใน Embed ใช้ \n เพื่อขึ้นบรรทัดใหม่ได้`, required: false },
            { type: 3, name: "button_text", description: "ข้อความปุ่ม เช่น ✅ ยืนยันตัวตน ✅ หรือ <:verify:id> ยืนยันตัวตน ✅", required: false },
            { type: 3, name: "color", description: "สีขอบ Embed แบบ HEX เช่น #5865F2 หรือ FF0000", required: false },
            { type: 3, name: "image", description: "ลิงก์รูปภาพหลักขนาดใหญ่ใน Embed", required: false },
            { type: 3, name: "thumbnail", description: "ลิงก์รูปภาพเล็กมุมขวาของ Embed", required: false },
            { type: 3, name: "footer", description: "ข้อความท้าย Embed เช่น Verification System", required: false },
            { type: 5, name: "timestamp", description: "เปิดหรือปิดเวลาใต้ Embed", required: false },
            { type: 3, name: "url", description: "ลิงก์ที่หัวข้อ Embed จะกดเข้าไปได้", required: false }
        ]
    }
];

validateSlashCommandsData(slashCommandsData);

module.exports = { slashCommandsData, validateSlashCommandsData };
