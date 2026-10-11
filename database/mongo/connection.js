"use strict";

const mongoose = require("mongoose");
const { sendWebhookEvent } = require("../../discord/core/webhooks");

const MONGO_POOL_CONFIG = Object.freeze({
    maxPoolSize: 20,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 45000
});

let dbConnected = false;
let wasPreviouslyConnected = false;
let isExplicitShutdown = false;

mongoose.connection.on("connected", () => {
    console.log("[DATABASE] 🟢 MongoDB Connection Active.");
    const isReconnected = wasPreviouslyConnected && !dbConnected;
    dbConnected = true;
    wasPreviouslyConnected = true;

    if (isReconnected) {
        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "SUCCESS",
                category: "DATA",
                code: "mongo.connection.restored",
                title: "🟢 MongoDB Atlas กลับมาเชื่อมต่อแล้ว",
                description: "การเชื่อมต่อไปยังคลัสเตอร์ MongoDB Atlas ได้รับการฟื้นฟูกลับสู่สภาวะปกติแล้ว",
                context: {
                    "โฮสต์ (Host)": mongoose.connection.host || "Atlas Cluster",
                    "ชื่อฐานข้อมูล": mongoose.connection.name || "N/A",
                    "เวลาที่ฟื้นฟู": new Date().toISOString()
                },
                dedupeKey: "mongo-connection-restored",
                dedupeMs: 60 * 1000
            }).catch(() => {});
        } catch (_) {}
    }
});

mongoose.connection.on("disconnected", () => {
    console.error("[DATABASE] 🔴 MongoDB Connection Lost.");
    const hadConnection = dbConnected;
    dbConnected = false;

    if (hadConnection && !isExplicitShutdown) {
        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "CRITICAL",
                category: "DATA",
                code: "mongo.connection.lost",
                title: "🚨 MongoDB Atlas ขาดการเชื่อมต่อ",
                description: "การเชื่อมต่อระหว่างบอทกับคลัสเตอร์ MongoDB Atlas หลุด ระบบอาจไม่สามารถบันทึกหรือตรวจสอบข้อมูล Identity/Verification ได้ชั่วคราว",
                context: {
                    "สถานะ": "DISCONNECTED",
                    "โฮสต์ (Host)": mongoose.connection.host || "Atlas Cluster",
                    "เวลาที่เกิด": new Date().toISOString()
                },
                dedupeKey: "mongo-connection-lost",
                dedupeMs: 5 * 60 * 1000
            }).catch(() => {});
        } catch (_) {}
    }
});

mongoose.connection.on("error", (err) => {
    console.error(`[DATABASE] ❌ MongoDB Error: ${err.message}`);
    const hadConnection = dbConnected;
    dbConnected = false;

    if (hadConnection && !isExplicitShutdown) {
        try {
            sendWebhookEvent({
                target: "ALERT",
                severity: "CRITICAL",
                category: "DATA",
                code: "mongo.connection.error",
                title: "🚨 เกิดข้อผิดพลาดในการเชื่อมต่อ MongoDB Atlas",
                description: `ไดรเวอร์ Mongoose รายงานข้อผิดพลาด: ${err.message}`,
                context: {
                    "ข้อความ Error": err.message,
                    "เวลาที่เกิด": new Date().toISOString()
                },
                dedupeKey: "mongo-connection-error",
                dedupeMs: 5 * 60 * 1000
            }).catch(() => {});
        } catch (_) {}
    }
});

async function connectMongo(customUri = null) {
    const uri = customUri || process.env.MONGO_URI;
    if (!uri) {
        throw new Error("[DATABASE] ❌ FATAL: Missing MONGO_URI Environment Variable. System cannot start.");
    }

    if (mongoose.connection.readyState === 1) {
        dbConnected = true;
        return mongoose.connection;
    }

    await mongoose.connect(uri, {
        serverSelectionTimeoutMS: MONGO_POOL_CONFIG.serverSelectionTimeoutMS,
        socketTimeoutMS: MONGO_POOL_CONFIG.socketTimeoutMS,
        maxPoolSize: MONGO_POOL_CONFIG.maxPoolSize,
        minPoolSize: MONGO_POOL_CONFIG.minPoolSize
    });

    dbConnected = true;
    return mongoose.connection;
}

async function disconnectMongo() {
    isExplicitShutdown = true;
    if (mongoose.connection.readyState === 0) {
        dbConnected = false;
        return;
    }
    await mongoose.disconnect();
    dbConnected = false;
}

function isMongoConnected() {
    return Boolean(dbConnected && mongoose.connection.readyState === 1);
}

function getMongoStatus() {
    return {
        connected: dbConnected,
        readyState: mongoose.connection.readyState,
        host: mongoose.connection.host || null,
        name: mongoose.connection.name || null,
        pool: MONGO_POOL_CONFIG,
        models: mongoose.modelNames().length
    };
}

function _resetStateForTesting() {
    dbConnected = false;
    wasPreviouslyConnected = false;
    isExplicitShutdown = false;
}

module.exports = {
    connectMongo,
    disconnectMongo,
    connectDB: connectMongo,
    disconnectDB: disconnectMongo,
    isMongoConnected,
    getMongoStatus,
    _resetStateForTesting,
    MONGO_POOL_CONFIG,
    mongoose
};

