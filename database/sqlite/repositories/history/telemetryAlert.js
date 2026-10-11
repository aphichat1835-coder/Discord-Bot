"use strict";

const { canSendAlert, recordAlertSent } = require("../../maintenance/quota");
const { sendWebhookEvent } = require("../../../../discord/core/webhooks");

function notifyBufferDropped(repoName, dropCount, maxCap, totalDropped) {
    const alertKey = `sqlite_buffer_dropped_${repoName}`;
    if (!canSendAlert(alertKey)) return;
    recordAlertSent(alertKey);

    try {
        sendWebhookEvent({
            target: "ALERT",
            severity: "WARNING",
            category: "DATA",
            code: "sqlite.telemetry.buffer_dropped",
            title: `⚠️ คิวพักข้อมูล Telemetry ล้น (${repoName})`,
            description: `คิวพักข้อมูล Write-Behind ของ ${repoName} เต็มความจุ (${maxCap} รายการ) ระบบได้ตัดทิ้งข้อมูลเก่าที่สุด ${dropCount} รายการเพื่อป้องกันภาวะหน่วยความจำล้น (RAM Exhaustion)`,
            context: {
                "Repository": repoName,
                "จำนวนที่ตัดทิ้งรอบนี้": `${dropCount} รายการ`,
                "ความจุสูงสุดของคิว": `${maxCap} รายการ`,
                "ยอดรวมที่ตัดทิ้งสะสม": `${totalDropped} รายการ`,
                "เวลาที่เกิด": new Date().toISOString()
            }
        }).catch(() => {});
    } catch (_) {}
}

function notifyP1Dropped(repoName, p1DropCount, totalDropped) {
    const alertKey = `sqlite_buffer_p1_dropped_${repoName}`;
    if (!canSendAlert(alertKey)) return;
    recordAlertSent(alertKey);

    try {
        sendWebhookEvent({
            target: "ALERT",
            severity: "CRITICAL",
            category: "DATA",
            code: "sqlite.telemetry.p1_dropped",
            title: `🚨 วิกฤตคิวพักข้อมูล: ประวัติสำคัญ (P1) สูญหาย (${repoName})`,
            description: `คิวพักข้อมูล Write-Behind ของ ${repoName} เต็มความจุและพื้นที่จัดเก็บถูกระงับการเขียน ระบบจำเป็นต้องตัดทิ้งข้อมูลสำคัญระดับ P1 (Session/Quarantine/429/Error) จำนวน ${p1DropCount} รายการเพื่อความอยู่รอดของโปรเซส`,
            context: {
                "Repository": repoName,
                "จำนวน P1 ที่สูญหาย": `${p1DropCount} รายการ`,
                "ยอดรวมที่ตัดทิ้งสะสม": `${totalDropped} รายการ`,
                "เวลาที่เกิด": new Date().toISOString()
            }
        }).catch(() => {});
    } catch (_) {}
}

module.exports = {
    notifyBufferDropped,
    notifyP1Dropped
};
