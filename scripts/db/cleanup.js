#!/usr/bin/env node
"use strict";

const databaseService = require("../../database/services/databaseService");

async function main() {
    console.log("🧹 กำลังดำเนินการทำความสะอาดข้อมูลตาม Retention & Quota Policy...");
    const result = await databaseService.executeSqliteAction("cleanup_all", { maxBatches: 5 }, "cli");

    console.log("------------------------------------------------------------");
    if (result.ok) {
        console.log(`✅ ทำความสะอาดข้อมูลสำเร็จ!`);
        console.log(`   - จำนวนแถวที่ลบรวม: ${result.stats?.deletedRows || 0} รายการ`);
        console.log(`   - รายละเอียด: Nonces (${result.stats?.details?.nonces || 0}), DMs (${result.stats?.details?.dms || 0}), History (${result.stats?.details?.history || 0}), Cache (${result.stats?.details?.cache || 0})`);
        console.log(`⏱️ เวลาที่ใช้: ${result.durationMs} ms`);
    } else {
        console.error(`❌ ล้มเหลว: ${result.error}`);
        process.exitCode = 1;
    }
    console.log("------------------------------------------------------------");
}

main().catch(err => {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
    process.exit(1);
});
