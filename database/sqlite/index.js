"use strict";

const connection = require("./connection");
const { runStartupCheck } = require("./maintenance/startupCheck");
const { evaluateQuota } = require("./maintenance/quota");
const { runBoundedCleanup } = require("./maintenance/cleanup");
const { runIncrementalVacuum, checkpointWal } = require("./maintenance/vacuum");
const { createBackup } = require("./maintenance/backup");
const { getHealthStatus } = require("./maintenance/health");

let isInitialized = false;
let startupInfo = null;

function initialize(options = {}) {
    const db = connection.openDatabase(options);
    const dbPath = connection.getCurrentDbPath();
    startupInfo = runStartupCheck(db, { dbPath, ...options });
    isInitialized = true;
    return startupInfo;
}

function getDb() {
    return connection.getDatabase();
}

function shutdown() {
    connection.closeDatabase();
    isInitialized = false;
}

function isReady() {
    return Boolean(isInitialized && connection.isDatabaseOpen());
}

function getHealth() {
    return getHealthStatus(connection.getDatabase(), connection.getCurrentDbPath());
}

module.exports = {
    initialize,
    getDb,
    shutdown,
    isReady,
    getHealth,
    getStartupInfo: () => startupInfo,
    evaluateQuota: () => evaluateQuota(connection.getCurrentDbPath()),
    cleanup: (opts) => runBoundedCleanup(connection.getDatabase(), opts),
    vacuum: (pages) => runIncrementalVacuum(connection.getDatabase(), pages),
    checkpoint: (mode) => checkpointWal(connection.getDatabase(), mode),
    backup: (opts) => createBackup(connection.getDatabase(), opts),
    scheduler: require("./maintenance/scheduler"),
    startScheduler: () => require("./maintenance/scheduler").startScheduler(),
    stopScheduler: () => require("./maintenance/scheduler").stopScheduler()
};
