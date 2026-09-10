const SESSION_ERROR_KEYS = Object.freeze({
    INVALID_TOKEN_FORMAT: "INVALID_TOKEN_FORMAT",
    ALREADY_ACTIVE: "ALREADY_ACTIVE",
    ALREADY_ACTIVE_IN_GUILD: "ALREADY_ACTIVE_IN_GUILD",
    LOGIN_GENERATION_CANCELLED: "LOGIN_GENERATION_CANCELLED",
    SYSTEM_LIMIT: "SYSTEM_LIMIT",
    LOGIN_TIMEOUT: "LOGIN_TIMEOUT",
    TOKEN_INVALID: "TOKEN_INVALID",
    GUILD_NOT_FOUND: "GUILD_NOT_FOUND",
    CHANNEL_NOT_FOUND: "CHANNEL_NOT_FOUND",
    SYSTEM_SHUTTING_DOWN: "SYSTEM_SHUTTING_DOWN",
    SESSION_LOCKED: "SESSION_LOCKED",
    TOKEN_DECRYPTION_FAILED: "TOKEN_DECRYPTION_FAILED",
    DATABASE_NOT_CONNECTED: "DATABASE_NOT_CONNECTED",
    SESSION_PERSIST_FAILED: "SESSION_PERSIST_FAILED",
    SESSION_REPLACEMENT_FAILED: "SESSION_REPLACEMENT_FAILED",
    SUPERSEDED_BY_NEWER_REQUEST: "superseded_by_newer_request"
});

function getSessionErrorMessage(errorKey, config) {
    const emojis = config?.emojis || {};
    const limits = config?.limits || {};

    const error = emojis.error || "❌";
    const warning = emojis.warning || "⚠️";

    const messages = {
        [SESSION_ERROR_KEYS.INVALID_TOKEN_FORMAT]: `> ${error} รูปแบบ Token ไม่ถูกต้อง`,
        [SESSION_ERROR_KEYS.ALREADY_ACTIVE]: `> ${warning} Token นี้กำลังทำงานอยู่แล้ว`,
        [SESSION_ERROR_KEYS.ALREADY_ACTIVE_IN_GUILD]: `> ${warning} มีรายการเดิมของบัญชีนี้ในเซิร์ฟเวอร์ ระบบกำลังแทนด้วยคำสั่งล่าสุด`,
        [SESSION_ERROR_KEYS.LOGIN_GENERATION_CANCELLED]: `> ${warning} คำขอเข้าสู่ระบบหมดอายุและถูกยกเลิกอย่างปลอดภัย โปรดลองใหม่`,
        [SESSION_ERROR_KEYS.SYSTEM_LIMIT]: `> ${error} ระบบเต็ม! (เกินขีดจำกัด ${limits.maxSessions} เซสชัน)`,
        [SESSION_ERROR_KEYS.LOGIN_TIMEOUT]: `> ${warning} เชื่อมต่อล่าช้า โปรดลองใหม่`,
        [SESSION_ERROR_KEYS.TOKEN_INVALID]: `> ${error} Token ไม่ถูกต้อง หรือหมดอายุ`,
        [SESSION_ERROR_KEYS.GUILD_NOT_FOUND]: `> ${error} บอทเข้าถึงเซิร์ฟเวอร์ไม่ได้`,
        [SESSION_ERROR_KEYS.CHANNEL_NOT_FOUND]: `> ${error} ไม่พบห้องเสียง หรือไม่มีสิทธิ์เข้าห้อง`,
        [SESSION_ERROR_KEYS.SYSTEM_SHUTTING_DOWN]: `> ${warning} ระบบกำลังปิดตัว โปรดรอสักครู่`,
        [SESSION_ERROR_KEYS.SESSION_LOCKED]: `> ${warning} Session นี้กำลังประมวลผลอยู่ โปรดลองใหม่อีกครั้ง`,
        [SESSION_ERROR_KEYS.TOKEN_DECRYPTION_FAILED]: `> ${error} ระบบอ่าน Token ไม่สำเร็จ โปรดลองเริ่มใหม่`,
        [SESSION_ERROR_KEYS.DATABASE_NOT_CONNECTED]: `> ${error} ฐานข้อมูลยังไม่พร้อม โปรดลองใหม่อีกครั้ง`,
        [SESSION_ERROR_KEYS.SESSION_PERSIST_FAILED]: `> ${error} ระบบบันทึก Session ไม่สำเร็จ โปรดลองใหม่อีกครั้ง`,
        [SESSION_ERROR_KEYS.SESSION_REPLACEMENT_FAILED]: `> ${warning} หยุดรายการเดิมไม่สำเร็จ จึงยังไม่ย้ายไปห้องใหม่`,
        [SESSION_ERROR_KEYS.SUPERSEDED_BY_NEWER_REQUEST]: `> ${warning} คำสั่งนี้ถูกคำสั่งที่ใหม่กว่าแทนแล้ว`
    };

    return messages[errorKey] || null;
}

function getFallbackSessionErrorMessage(config) {
    const warning = config?.emojis?.warning || "⚠️";
    return `> ${warning} เกิดข้อผิดพลาดภายในระบบ โปรดลองใหม่อีกครั้ง`;
}

module.exports = {
    SESSION_ERROR_KEYS,
    getSessionErrorMessage,
    getFallbackSessionErrorMessage
};
