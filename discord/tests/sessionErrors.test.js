const assert = require("node:assert/strict");
const test = require("node:test");

const {
    SESSION_ERROR_KEYS,
    getSessionErrorMessage,
    getFallbackSessionErrorMessage
} = require("../sessions/sessionErrors");

const config = {
    emojis: {
        error: "ERR",
        warning: "WARN"
    },
    limits: {
        maxSessions: 3
    }
};

test("session error map returns known user-facing messages", () => {
    assert.match(getSessionErrorMessage(SESSION_ERROR_KEYS.TOKEN_INVALID, config), /Token ไม่ถูกต้อง/);
    assert.match(getSessionErrorMessage(SESSION_ERROR_KEYS.ALREADY_ACTIVE, config), /กำลังทำงานอยู่แล้ว/);
    assert.match(getSessionErrorMessage(SESSION_ERROR_KEYS.SYSTEM_LIMIT, config), /3 เซสชัน/);
});

test("unknown session errors fall back cleanly", () => {
    assert.equal(getSessionErrorMessage("NOPE", config), null);
    assert.match(getFallbackSessionErrorMessage(config), /เกิดข้อผิดพลาดภายในระบบ/);
});
