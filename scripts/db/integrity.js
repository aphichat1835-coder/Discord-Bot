#!/usr/bin/env node
"use strict";

const databaseService = require("../../database/services/databaseService");

async function main() {
    console.log("🛡️ กำลังตรวจสอบความสมบูรณ์เชิงลึก (Deep Integrity Check)...");
    const result = await databaseService.executeSqliteAction("integrity", {}, "cli");

    console.log("------------------------------------------------------------");
    if (result.ok) {
        console.log("✅ การตรวจสอบสมบูรณ์: ผ่าน Integrity Check และ Foreign Keys 100%");
        console.log(`⏱️ เวลาที่ใช้: ${result.durationMs} ms`);
    } else {
        console.error("❌ พบข้อบกพร่องในฐานข้อมูล:");
        console.error("Integrity results:", result.integrity);
        console.error("Foreign key errors:", result.foreignKeyErrors);
        process.exitCode = 1;
    }
    console.log("------------------------------------------------------------");
}

main().catch(err => {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
    process.exit(1);
});
