#!/usr/bin/env node
"use strict";

const databaseService = require("../../database/services/databaseService");

async function main() {
    console.log("🚨 [CLI] กำลังเริ่มการทำงาน Emergency Auto-Trim สำหรับฐานข้อมูล SQLite...");
    console.log("   (นโยบายความปลอดภัย: ลบเฉพาะ Expired Assets/Cache และ History พ้น Retention — ห้ามแตะต้อง Core Data)");

    const result = await databaseService.executeSqliteAction("emergency_trim", { reason: "CLI manual emergency trim trigger" }, "cli_operator");

    console.log("------------------------------------------------------------");
    if (result.ok) {
        const t = result.trimResult;
        console.log(`✅ Emergency Trim สำเร็จ!`);
        console.log(`   - สถานะความปลอดภัย: ${t.isResolved ? "🟢 RESOLVED (ปลอดภัย)" : "⚠️ DEGRADED (เฝ้าระวัง)"}`);
        console.log(`   - พื้นที่ที่คืนได้:     ${t.freedMb} MB`);
        console.log(`   - รายการที่ลบรวม:    ${t.itemsPurged?.totalItems || 0} รายการ`);
        console.log(`     * Expired Assets:  ${t.itemsPurged?.assetExpired || 0}`);
        console.log(`     * Expired Nonces:  ${t.itemsPurged?.nonces || 0}`);
        console.log(`     * Expired DMs:     ${t.itemsPurged?.dms || 0}`);
        console.log(`     * Expired Cache:   ${t.itemsPurged?.cacheEntries || 0}`);
        console.log(`     * History (Old):   ${t.itemsPurged?.expiredHistory || 0}`);
        console.log(`   - ขนาด Footprint:   ${t.preFootprint?.totalMb} MB ➔ ${t.postFootprint?.totalMb} MB`);
        console.log(`⏱️ ระยะเวลาที่ใช้:     ${t.durationMs} ms`);
    } else {
        console.error(`❌ ล้มเหลว: ${result.error || result.message}`);
        process.exitCode = 1;
    }
    console.log("------------------------------------------------------------");
}

main().catch(err => {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
    process.exit(1);
});
