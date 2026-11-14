"use strict";

const STATUS_OPTIONS = Object.freeze(["online", "idle", "dnd", "invisible"]);

const STATUS_METADATA = Object.freeze({
    online: {
        id: "online",
        label: "🟢 Online",
        name: "ออนไลน์",
        color: "#4ade80",
        description: "แสดงจุดสีเขียว พร้อมให้บริการปกติ"
    },
    idle: {
        id: "idle",
        label: "🌙 Idle",
        name: "ไม่อยู่ (Idle)",
        color: "#fbbf24",
        description: "แสดงสัญลักษณ์พระจันทร์สีเหลือง"
    },
    dnd: {
        id: "dnd",
        label: "⛔ Do Not Disturb",
        name: "ห้ามรบกวน (DND)",
        color: "#f87171",
        description: "แสดงสัญลักษณ์วงกลมสีแดงห้ามรบกวน"
    },
    invisible: {
        id: "invisible",
        label: "⚫ Invisible",
        name: "ออฟไลน์ (Invisible)",
        color: "#6b7280",
        description: "ซ่อนสถานะ ปรากฏเป็นออฟไลน์สำหรับผู้อื่น"
    }
});

function resolveDefaultOs() {
    if (process.platform === "win32") return "Windows";
    if (process.platform === "darwin") return "Mac OS X";
    return "Linux";
}

const PLATFORM_CONFIGS = Object.freeze({
    desktop: {
        id: "desktop",
        name: "Desktop (PC)",
        icon: "💻",
        badge: "🟢 Discord Official",
        status: "supported",
        properties: {
            os: resolveDefaultOs(),
            browser: "Discord Client",
            device: "discord.js"
        },
        indicator: "Standard Dot / Monitor Icon (Client-Mod)",
        description: "โหมดไคลเอนต์หลักของบอท แสดงสถานะออนไลน์มาตรฐานบนทุกอุปกรณ์"
    },
    mobile: {
        id: "mobile",
        name: "Mobile (Discord Android)",
        icon: "📱",
        badge: "🟢 Official Mobile Icon",
        status: "supported",
        properties: {
            os: "Android",
            browser: "Discord Android",
            device: "Discord Android"
        },
        indicator: "Smartphone Phone Icon (Official Discord)",
        description: "เปลี่ยนจุดสถานะเป็นไอคอนสมาร์ทโฟนบนรายชื่อสมาชิกในแอป Discord ทุกเครื่อง"
    },
    mobile_android: {
        id: "mobile_android",
        name: "Mobile (Discord Android)",
        icon: "📱",
        badge: "🟢 Official Mobile Icon",
        status: "supported",
        properties: {
            os: "Android",
            browser: "Discord Android",
            device: "Discord Android"
        },
        indicator: "Smartphone Phone Icon (Official Discord)",
        description: "เปลี่ยนจุดสถานะเป็นไอคอนสมาร์ทโฟนบนรายชื่อสมาชิกในแอป Discord ทุกเครื่อง"
    },
    mobile_ios: {
        id: "mobile_ios",
        name: "Mobile (Discord iOS)",
        icon: "🍏",
        badge: "🟢 Official Mobile Icon",
        status: "supported",
        properties: {
            os: "iOS",
            browser: "Discord iOS",
            device: "iPhone"
        },
        indicator: "Smartphone Phone Icon (Official Discord)",
        description: "ระบุ Gateway เป็น iOS Client แสดงไอคอนสมาร์ทโฟนเช่นกัน"
    },
    web: {
        id: "web",
        name: "Web Browser (Chrome)",
        icon: "🌐",
        badge: "🔵 Official Web Session / Client-Mod",
        status: "client_mod_only",
        properties: {
            os: "Windows",
            browser: "Discord Web",
            device: ""
        },
        indicator: "Globe / Browser Icon (Client-Mod)",
        description: "ระบุ session เป็น Web Client (แสดงไอคอนลูกโลกใน Vencord/Equicord/BetterDiscord)"
    },
    console_ps: {
        id: "console_ps",
        name: "PlayStation 5 Console",
        icon: "🎮",
        badge: "🟡 Client-Mod Indicator",
        status: "client_mod_only",
        properties: {
            os: "Console",
            browser: "Discord Embedded",
            device: "PlayStation 5"
        },
        indicator: "Controller Icon (Client-Mod)",
        description: "ระบุ session เป็น Embedded Console บน PS5 (Discord Gateway นับเป็น embedded session เดียวกับ Xbox)"
    },
    console_ps5: {
        id: "console_ps5",
        name: "PlayStation 5 Console",
        icon: "🎮",
        badge: "🟡 Client-Mod Indicator",
        status: "client_mod_only",
        properties: {
            os: "Console",
            browser: "Discord Embedded",
            device: "PlayStation 5"
        },
        indicator: "Controller Icon (Client-Mod)",
        description: "ระบุ session เป็น Embedded Console บน PS5 (Discord Gateway นับเป็น embedded session เดียวกับ Xbox)"
    },
    console_xbox: {
        id: "console_xbox",
        name: "Xbox Series X Console",
        icon: "🎮",
        badge: "🟡 Client-Mod Indicator",
        status: "client_mod_only",
        properties: {
            os: "Console",
            browser: "Discord Embedded",
            device: "Xbox Series X"
        },
        indicator: "Controller Icon (Client-Mod)",
        description: "ระบุ session เป็น Embedded Console บน Xbox (ใช้กลไก Discord Embedded เช่นเดียวกับ PS5)"
    },
    vr: {
        id: "vr",
        name: "Meta Quest / VR",
        icon: "🥽",
        badge: "⚠️ Experimental Client-Mod",
        status: "experimental",
        properties: {
            os: "Android",
            browser: "Discord VR",
            device: "Meta Quest"
        },
        indicator: "VR Headset Icon (Client-Mod Only)",
        description: "ระบุ Gateway เป็น Discord VR (ไอคอน VR ทางการของ Discord สงวนเฉพาะบัญชีผู้ใช้ที่ต่อ OAuth2 Meta Horizon)"
    }
});

const DEFAULT_ROTATION_ITEMS = Object.freeze([
    {
        id: "rot_1",
        name: "🟢 Online",
        type: "status",
        status: "online",
        durationMinutes: 10,
        enabled: true
    },
    {
        id: "rot_2",
        name: "🌙 Idle",
        type: "status",
        status: "idle",
        durationMinutes: 5,
        enabled: true
    },
    {
        id: "rot_3",
        name: "⛔ Do Not Disturb",
        type: "status",
        status: "dnd",
        durationMinutes: 3,
        enabled: true
    },
    {
        id: "rot_4",
        name: "📱 Mobile Platform",
        type: "platform",
        platform: "mobile",
        durationMinutes: 15,
        enabled: true
    }
]);

module.exports = {
    STATUS_OPTIONS,
    STATUS_METADATA,
    PLATFORM_CONFIGS,
    DEFAULT_ROTATION_ITEMS
};
