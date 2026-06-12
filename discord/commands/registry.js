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
            { type: 3, name: "content", description: "ข้อความดิบนอก Embed (เช่น @everyone)", required: false }
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
            { type: 3, name: "server_id", description: "ไอดีเซิร์ฟเวอร์ต้นทาง", required: true }
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
            {
                type: 7,
                name: "channel",
                description: "ห้องข้อความที่จะให้บอทส่งแผงยืนยันตัวตน",
                required: true
            },
            {
                type: 8,
                name: "role",
                description: "ยศที่จะมอบให้สมาชิกหลังยืนยันตัวตนสำเร็จ",
                required: true
            },
            {
                type: 5,
                name: "verify_type",
                description: "เปิด = OAuth2 | ปิด = กดรับยศทันที | ไม่กรอก = OAuth2",
                required: false
            },
            {
                type: 3,
                name: "content",
                description: "ข้อความนอก Embed เช่น @everyone หรือข้อความประกาศ",
                required: false
            },
            {
                type: 3,
                name: "title",
                description: "หัวข้อหลักของ Embed ถ้าไม่กรอกจะใช้ค่าเริ่มต้น",
                required: false
            },
            {
                type: 3,
                name: "description",
                description: "คำอธิบายใน Embed ใช้ \\n เพื่อขึ้นบรรทัดใหม่ได้",
                required: false
            },
            {
                type: 3,
                name: "button_text",
                description: "ข้อความปุ่ม เช่น ✅ ยืนยันตัวตน ✅ หรือ <:verify:id> ยืนยันตัวตน ✅",
                required: false
            },
            {
                type: 3,
                name: "color",
                description: "สีขอบ Embed แบบ HEX เช่น #5865F2 หรือ FF0000",
                required: false
            },
            {
                type: 3,
                name: "image",
                description: "ลิงก์รูปภาพหลักขนาดใหญ่ใน Embed",
                required: false
            },
            {
                type: 3,
                name: "thumbnail",
                description: "ลิงก์รูปภาพเล็กมุมขวาของ Embed",
                required: false
            },
            {
                type: 3,
                name: "footer",
                description: "ข้อความท้าย Embed เช่น Verification System",
                required: false
            },
            {
                type: 5,
                name: "timestamp",
                description: "เปิดหรือปิดเวลาใต้ Embed",
                required: false
            },
            {
                type: 3,
                name: "url",
                description: "ลิงก์ที่หัวข้อ Embed จะกดเข้าไปได้",
                required: false
            }
        ]
    }
];

module.exports = { slashCommandsData };
