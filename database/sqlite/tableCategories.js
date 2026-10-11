"use strict";

/**
 * Central Table Category Map for SQLite Database Architecture
 * Covers all 17 tables across Core, History, Temporary, and Cache domains.
 */
const TABLE_CATEGORIES = {
    CORE: {
        key: "core",
        label: "ข้อมูลหลัก (Core Operational)",
        tables: {
            quest_accounts: "บัญชี Quest",
            quest_details: "รายละเอียด Quest Step",
            quest_logs: "ประวัติการรัน Quest",
            scheduled_runners: "ตัวตั้งเวลา Auto Daily",
            dm_notifications: "คิวแจ้งเตือน DM",
            verification_recovery: "จุดกู้คืนสถานะยืนยันตัวตน",
            voice_session_runtime: "สถานะ Voice Session Runtime",
            database_meta: "ค่าสถานะระบบภายใน",
            schema_migrations: "ประวัติการ Migration โครงสร้าง",
            maintenance_runs: "บันทึกการบำรุงรักษาระบบ"
        }
    },
    HISTORY: {
        key: "history",
        label: "บันทึกประวัติ (History & Telemetry - 30 วัน)",
        tables: {
            voice_events: "ประวัติเหตุการณ์ห้องเสียง",
            command_events: "ประวัติการใช้คำสั่ง Slash",
            session_events: "ประวัติ Token Coordinator",
            runtime_events: "ประวัติการทำงานของระบบ"
        }
    },
    TEMP: {
        key: "temporary",
        label: "ข้อมูลชั่วคราว (Temporary / Nonces)",
        tables: {
            verification_state_nonce: "OAuth State Nonces (มีอายุ)"
        }
    },
    CACHE: {
        key: "cache",
        label: "แคชระบบ (Cache / Assets)",
        tables: {
            cache_entries: "แคชทั่วไป (KV Store)",
            asset_cache: "แคชรูปภาพ/ไอคอน (Filesystem Metadata)"
        }
    }
};

/**
 * Returns the category key ("core" | "history" | "temporary" | "cache") for a table.
 * Defaults to "temporary" for unknown non-system tables.
 */
function getCategoryForTable(tableName) {
    for (const cat of Object.values(TABLE_CATEGORIES)) {
        if (Object.prototype.hasOwnProperty.call(cat.tables, tableName)) {
            return cat.key;
        }
    }
    return "temporary";
}

/**
 * Returns array of all known table names.
 */
function getAllTrackedTableNames() {
    const list = [];
    for (const cat of Object.values(TABLE_CATEGORIES)) {
        list.push(...Object.keys(cat.tables));
    }
    return list;
}

module.exports = {
    TABLE_CATEGORIES,
    getCategoryForTable,
    getAllTrackedTableNames
};
