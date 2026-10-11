#!/usr/bin/env node
"use strict";

const databaseService = require("../../database/services/databaseService");

async function main() {
    console.log("🔍 กำลังตรวจสอบสถานะระบบฐานข้อมูล (Database Status)...");
    const overview = await databaseService.getDatabaseOverview();
    const sq = overview.databases.sqlite;
    const mg = overview.databases.mongodb;

    console.log("════════════════════════════════════════════════════════════");
    console.log("               ศูนย์จัดการฐานข้อมูล (Database Center)         ");
    console.log("════════════════════════════════════════════════════════════");
    console.log(`📁 SQLite Operational DB : ${sq.statusLabel}`);
    console.log(`   - ไฟล์ฐานข้อมูล       : ${sq.path}`);
    console.log(`   - พื้นที่ที่ใช้         : ${sq.footprintMb} MB / ${sq.hardLimitMb.toLocaleString()} MB (${sq.usedPercent}%)`);
    console.log(`   - สถานะการทำงาน       : ${sq.degradedReason}`);
    console.log(`   - จำนวน Records รวม   : ${sq.records.total.toLocaleString()} รายการ`);
    console.log(`     ↳ Core: ${sq.records.core} | Cache: ${sq.records.cache} | History: ${sq.records.history} | Temp: ${sq.records.temp}`);
    console.log("------------------------------------------------------------");
    console.log(`🍃 MongoDB Authoritative  : ${mg.statusLabel}`);
    console.log(`   - ชื่อฐานข้อมูล        : ${mg.name || "ไม่ได้เชื่อมต่อ"}`);
    console.log(`   - Latency (Ping)     : ${mg.pingMs !== null ? `${mg.pingMs} ms` : "-"}`);
    console.log(`   - จำนวนโมเดลในระบบ    : ${mg.modelsCount} โมเดล`);
    console.log("════════════════════════════════════════════════════════════");
}

main().catch(err => {
    console.error("❌ เกิดข้อผิดพลาด:", err.message);
    process.exit(1);
});
