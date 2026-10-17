#!/usr/bin/env node
"use strict";

const { getDatabase, closeDatabase } = require("../../database/sqlite/connection");
const { runMigrations, getPendingMigrations } = require("../../database/sqlite/migrations/migrationRunner");

async function main() {
    console.log("🚀 กำลังตรวจสอบและรัน Schema Migrations สำหรับ SQLite...");
    let db;
    try {
        db = getDatabase();
        const pending = getPendingMigrations(db);

        if (pending.length === 0) {
            const currentVer = db.pragma("user_version", { simple: true });
            console.log(`✅ Schema ปัจจุบันเป็นเวอร์ชันล่าสุดแล้ว (v${currentVer}) ไม่มีการอัปเดตค้าง`);
            return;
        }

        console.log(`พบ Migration ที่รอดำเนินการ ${pending.length} รายการ:`);
        for (const p of pending) {
            console.log(`  - [v${p.version}] ${p.migrationId}`);
        }

        const res = runMigrations(db);
        console.log("------------------------------------------------------------");
        console.log(`✅ ดำเนินการ Migration สำเร็จ! เวอร์ชันปัจจุบัน: v${res.currentVersion}`);
        console.log(`   - รันไปทั้งหมด: ${res.applied.length} ไฟล์`);
        console.log("------------------------------------------------------------");
    } catch (err) {
        console.error("❌ เกิดข้อผิดพลาดในการทำ Migration:", err.message);
        process.exitCode = 1;
    } finally {
        if (db) closeDatabase();
    }
}

main().catch(err => {
    console.error("❌ Fatal:", err.message);
    process.exit(1);
});
