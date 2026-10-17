"use strict";

const { sanitizeLogText } = require("./safeLogger");
const webhooks = require("./webhooks");

const attachedClients = new WeakSet();

function safeLabel(value, fallback) {
    const raw = value !== undefined && value !== null && value !== "" ? value : fallback;
    const clean = sanitizeLogText(String(raw !== undefined && raw !== null ? raw : "unknown")).trim();
    return clean.slice(0, 120) || "unknown";
}

function registerGatewayDiagnostics(client, options = {}) {
    if (!client?.on || attachedClients.has(client)) return false;
    attachedClients.add(client);
    const clientName = safeLabel(options.clientName, "discord");
    const context = safeLabel(options.context, "runtime");
    const prefix = `[GATEWAY] client=${clientName} context=${context}`;

    client.on("error", error => {
        const msg = safeLabel(error?.message, error);
        console.error(`${prefix} event=error message=${msg}`);
        webhooks.sendWebhookEvent({
            target: "ALERT",
            severity: "ERROR",
            category: "GATEWAY",
            code: "gateway.error",
            state: "OPEN",
            title: "CONNECTION ERROR",
            description: `เกิดข้อผิดพลาดในการเชื่อมต่อ Discord Gateway: ${msg}`,
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "ผลกระทบ", value: "การรับส่งข้อมูลกับ Discord อาจเกิดความล่าช้าหรือหลุดการเชื่อมต่อ" },
                { name: "สิ่งที่ควรทำ", value: "ตรวจสอบความเสถียรของเครือข่ายและสถานะของ Discord API" },
                { name: "Client", value: clientName },
                { name: "รหัสข้อผิดพลาด", value: String(error?.code || error?.name || "gateway_error") }
            ],
            dedupeKey: `gateway-error:${clientName}`,
            dedupeMs: 5 * 60 * 1000
        }).catch(() => {});
    });

    client.on("shardError", (error, shardId) => {
        const sId = safeLabel(shardId, "unknown");
        const msg = safeLabel(error?.message, error);
        console.error(`${prefix} event=shardError shard=${sId} message=${msg}`);
        webhooks.sendWebhookEvent({
            target: "ALERT",
            severity: "ERROR",
            category: "GATEWAY",
            code: "gateway.shard_error",
            state: "OPEN",
            title: "SHARD ERROR",
            description: `เกิดข้อผิดพลาดบน Gateway Shard ${sId}: ${msg}`,
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "ผลกระทบ", value: "การรับส่งข้อมูลใน Shard นี้อาจล้มเหลวชั่วคราว" },
                { name: "สิ่งที่ควรทำ", value: "ตรวจสอบสถานะ Discord Gateway และเครือข่าย" },
                { name: "Client", value: clientName },
                { name: "Shard ID", value: sId },
                { name: "รหัสข้อผิดพลาด", value: String(error?.code || error?.name || "shard_error") }
            ],
            dedupeKey: `gateway-shard-error:${clientName}:${sId}`,
            dedupeMs: 5 * 60 * 1000
        }).catch(() => {});
    });

    client.on("shardDisconnect", (closeEvent, shardId) => {
        const sId = safeLabel(shardId, "unknown");
        const code = safeLabel(closeEvent?.code, "unknown");
        console.warn(`${prefix} event=shardDisconnect shard=${sId} code=${code}`);
        webhooks.sendWebhookEvent({
            target: "ALERT",
            severity: "WARNING",
            category: "GATEWAY",
            code: "gateway.shard_disconnected",
            state: "OPEN",
            title: "SHARD DISCONNECTED",
            description: `Shard ${sId} ตัดการเชื่อมต่อจาก Discord Gateway (Close code: ${code})`,
            fields: [
                { name: "สถานะ", value: "OPEN" },
                { name: "ผลกระทบ", value: "บอทอาจไม่ตอบสนองชั่วคราวในเซิร์ฟเวอร์ที่อยู่บน Shard นี้" },
                { name: "สิ่งที่ควรทำ", value: "ระบบจะพยายามเชื่อมต่อใหม่โดยอัตโนมัติ" },
                { name: "Client", value: clientName },
                { name: "Shard ID", value: sId },
                { name: "Close Code", value: code }
            ],
            dedupeKey: `gateway-shard-disconnect:${clientName}:${sId}`,
            dedupeMs: 3 * 60 * 1000
        }).catch(() => {});
    });

    client.on("shardReconnecting", shardId => {
        const sId = safeLabel(shardId, "unknown");
        console.warn(`${prefix} event=shardReconnecting shard=${sId}`);
        webhooks.sendWebhookEvent({
            target: "LOG",
            severity: "INFO",
            category: "GATEWAY",
            code: "gateway.shard_reconnecting",
            title: "SHARD RECONNECTING",
            description: `Shard ${sId} กำลังพยายามเชื่อมต่อกับ Gateway ใหม่...`,
            fields: [
                { name: "ผู้ดำเนินการ", value: "Discord Gateway" },
                { name: "เป้าหมาย", value: `Shard ${sId} (${clientName})` },
                { name: "การกระทำ", value: "gateway reconnect" },
                { name: "ผลลัพธ์", value: "กำลังดำเนินการ" }
            ],
            dedupeKey: `gateway-shard-reconnect:${clientName}:${sId}`,
            dedupeMs: 2 * 60 * 1000
        }).catch(() => {});
    });

    client.on("shardResume", (shardId, replayedEvents) => {
        const sId = safeLabel(shardId, "unknown");
        const replayed = Number.isFinite(Number(replayedEvents)) ? Number(replayedEvents) : 0;
        console.log(`${prefix} event=shardResume shard=${sId} replayed=${replayed}`);
        webhooks.sendWebhookEvent({
            target: "ALERT",
            severity: "SUCCESS",
            category: "GATEWAY",
            code: "gateway.shard_resumed",
            state: "RESOLVED",
            title: "GATEWAY RECONNECTED (RESOLVED)",
            description: `Shard ${sId} เชื่อมต่อกลับมาสำเร็จแล้วและพร้อมทำงานตามปกติ`,
            fields: [
                { name: "สถานะ", value: "แก้ไขแล้ว" },
                { name: "Client", value: clientName },
                { name: "Shard ID", value: sId },
                { name: "ผลลัพธ์", value: `สำเร็จ (เล่นเหตุการณ์ย้อนหลัง ${replayed} รายการ)` }
            ],
            dedupeKey: `gateway-shard-resume:${clientName}:${sId}`,
            dedupeMs: 2 * 60 * 1000
        }).catch(() => {});
    });

    return true;
}

module.exports = { registerGatewayDiagnostics };
