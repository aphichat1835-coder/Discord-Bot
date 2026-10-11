#!/usr/bin/env node
"use strict";

const databaseService = require("../../database/services/databaseService");

async function main() {
    console.log("📊 กำลังดึงสถิติข้อมูลแยกตามประเภท (SQLite Stats)...");
    const details = await databaseService.getSqliteDetailedStatus();

    console.log("════════════════════════════════════════════════════════════");
    console.log("           สถิติข้อมูลแยกตามประเภท (Data Categories)           ");
    console.log("════════════════════════════════════════════════════════════");

    for (const [catKey, catVal] of Object.entries(details.categories)) {
        console.log(`\n📌 ${catVal.label} (รวม ${catVal.count.toLocaleString()} รายการ):`);
        for (const [tblKey, tblVal] of Object.entries(catVal.tables)) {
            console.log(`   - ${tblKey.padEnd(26)} : ${tblVal.count.toLocaleString()} แถว (${tblVal.label})`);
        }
    }

    console.log("\n------------------------------------------------------------");
    console.log(`💾 ขนาด Footprint รวม: ${details.storage.totalMb} MB (${((details.storage.totalMb / details.storage.limits.hardMb) * 100).toFixed(1)}% ของ Hard Limit ${details.storage.limits.hardMb} MB)`);
    console.log(`   - ไฟล์หลัก .sqlite : ${(details.storage.mainBytes / (1024*1024)).toFixed(2)} MB`);
    console.log(`   - ไฟล์ log -wal    : ${(details.storage.walBytes / (1024*1024)).toFixed(2)} MB`);
    console.log(`   - ไฟล์ shared -shm : ${(details.storage.shmBytes / (1024*1024)).toFixed(2)} MB`);
    console.log("════════════════════════════════════════════════════════════");
}

main().catch(err => {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
    process.exit(1);
});
