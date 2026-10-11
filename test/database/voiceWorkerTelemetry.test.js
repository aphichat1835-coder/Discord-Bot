"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { openDatabase, closeDatabase } = require("../../database/sqlite/connection");
const { runMigrations } = require("../../database/sqlite/migrations/migrationRunner");
const database = require("../../database/index");
const { pushVoiceLog, getVoiceLogs } = require("../../discord/voiceWorker/eventLog");

const TEST_DB_PATH = path.join(__dirname, `test_voice_telemetry_${Date.now()}_${process.pid}.sqlite`);

describe("Voice Worker Telemetry Integration", () => {
    let db;

    before(() => {
        closeDatabase();
        db = openDatabase({ path: TEST_DB_PATH });
        runMigrations(db);
    });

    after(() => {
        closeDatabase();
        try {
            if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
            const wal = `${TEST_DB_PATH}-wal`;
            const shm = `${TEST_DB_PATH}-shm`;
            if (fs.existsSync(wal)) fs.unlinkSync(wal);
            if (fs.existsSync(shm)) fs.unlinkSync(shm);
        } catch (_) {}
    });

    test("pushVoiceLog stores in RAM and records into SQLite VoiceEventRepository", () => {
        const sessionId = `test_sess_${Date.now()}`;
        pushVoiceLog("TEST_VOICE_CONNECT", sessionId, "Connecting to voice channel");

        // 1. Check RAM buffer
        const ramLogs = getVoiceLogs();
        const foundRam = ramLogs.find(l => l.sessionId === sessionId);
        assert.ok(foundRam);
        assert.equal(foundRam.type, "TEST_VOICE_CONNECT");
        assert.equal(foundRam.detail, "Connecting to voice channel");

        // 2. Check SQLite repository write-behind
        const repo = database.repositories.voiceEvent;
        assert.ok(repo);
        // Flush write-behind buffer to SQLite
        repo.flush();

        const recent = repo.findBySession(sessionId);
        assert.ok(recent.length >= 1);
        assert.equal(recent[0].eventType, "TEST_VOICE_CONNECT");
        assert.equal(recent[0].sessionId, sessionId);
        assert.equal(recent[0].detail, "Connecting to voice channel");
    });

    test("restart simulation: history persists in SQLite across database close and re-open", () => {
        const restartSessionId = `test_sess_restart_${Date.now()}`;
        pushVoiceLog("TEST_VOICE_DISCONNECT", restartSessionId, "Disconnected safely");
        const repo = database.repositories.voiceEvent;
        repo.flush();

        // Simulate process shutdown / DB restart
        closeDatabase();
        const reopenedDb = openDatabase({ path: TEST_DB_PATH });
        assert.ok(reopenedDb.open);

        // Verify row still exists in persistent SQLite
        const rows = reopenedDb.prepare("SELECT * FROM voice_events WHERE session_id = ?").all(restartSessionId);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].event_type, "TEST_VOICE_DISCONNECT");
        assert.equal(rows[0].detail, "Disconnected safely");
    });
});
