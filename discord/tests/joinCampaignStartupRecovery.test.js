"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { runStartupRecovery } = require("../features/joinCampaign/recovery/startupRecovery");

test("runStartupRecovery returns early when repository is missing", async () => {
    const res = await runStartupRecovery({});
    assert.equal(res.recovered, false);
    assert.equal(res.reason, "no_repository");
});

test("runStartupRecovery returns early when no interrupted job exists", async () => {
    const mockRepo = {
        findActiveRunningJob: () => null
    };
    const res = await runStartupRecovery({ repository: mockRepo });
    assert.equal(res.recovered, false);
    assert.equal(res.reason, "no_interrupted_jobs");
});

test("runStartupRecovery handles STAGED jobs by failing them cleanly", async () => {
    const updatedJobs = [];
    const savedPanels = [];
    const mockRepo = {
        findActiveRunningJob: () => ({
            id: "job_stage_1",
            status: "STAGE",
            startedByChannelId: "ch_1"
        }),
        updateJob: (id, updates) => {
            updatedJobs.push({ id, updates });
        },
        findPanelByChannelId: () => ({
            channelId: "ch_1",
            lastReadyCount: 5
        }),
        savePanel: (panel) => {
            savedPanels.push(panel);
        }
    };

    const res = await runStartupRecovery({ repository: mockRepo });
    assert.equal(res.recovered, false);
    assert.equal(res.jobId, "job_stage_1");
    assert.equal(res.reason, "staged_job_expired");
    assert.equal(updatedJobs.length, 1);
    assert.equal(updatedJobs[0].updates.status, "FAILED");
});

test("runStartupRecovery rejects jobs exceeding max recovery attempts", async () => {
    const updatedJobs = [];
    const mockRepo = {
        findActiveRunningJob: () => ({
            id: "job_exceeded",
            status: "INTERRUPTED",
            recoveryCount: 5,
            startedByChannelId: "ch_2"
        }),
        claimInterruptedJob: () => true,
        updateJob: (id, updates) => {
            updatedJobs.push({ id, updates });
        },
        findPanelByChannelId: () => null
    };

    const res = await runStartupRecovery({ repository: mockRepo });
    assert.equal(res.recovered, false);
    assert.equal(res.reason, "max_recovery_exceeded");
    assert.equal(updatedJobs.length, 1);
    assert.equal(updatedJobs[0].updates.status, "FAILED");
});

test("runStartupRecovery falls back to findPanelByActiveJobId when findPanelByChannelId returns null", async () => {
    const updatedJobs = [];
    const savedPanels = [];
    const mockRepo = {
        findActiveRunningJob: () => ({
            id: "job_panel_fallback",
            status: "STAGE",
            startedByChannelId: "ch_not_found"
        }),
        updateJob: (id, updates) => {
            updatedJobs.push({ id, updates });
        },
        findPanelByChannelId: () => null,
        findPanelByActiveJobId: (jobId) => ({
            channelId: "ch_actual",
            messageId: "msg_1",
            activeJobId: jobId,
            lastReadyCount: 10
        }),
        savePanel: (panel) => {
            savedPanels.push(panel);
        }
    };

    const res = await runStartupRecovery({ repository: mockRepo });
    assert.equal(res.recovered, false);
    assert.equal(res.jobId, "job_panel_fallback");
    assert.equal(savedPanels.length, 1);
    assert.equal(savedPanels[0].activeJobId, null);
    assert.match(savedPanels[0].lastStatusSummary, /เกิดข้อผิดพลาด/);
});

test("runStartupRecovery marks job FAILED when an unexpected exception occurs during recovery", async () => {
    const updatedJobs = [];
    const savedPanels = [];
    const mockRepo = {
        findActiveRunningJob: () => ({
            id: "job_exception_1",
            status: "INTERRUPTED",
            recoveryCount: 0,
            startedByChannelId: "ch_err",
            targetGuildId: "guild_err",
            targetGuildName: "Guild Err"
        }),
        claimInterruptedJob: () => true,
        updateJob: (id, updates) => {
            updatedJobs.push({ id, updates });
        },
        findPanelByChannelId: () => ({
            channelId: "ch_err",
            activeJobId: "job_exception_1"
        }),
        savePanel: (panel) => {
            savedPanels.push(panel);
        },
        releaseExpiredLeases: () => {
            throw new Error("unexpected repository corruption");
        }
    };

    const res = await runStartupRecovery({ repository: mockRepo });
    assert.equal(res.recovered, false);
    assert.equal(res.jobId, "job_exception_1");
    assert.match(res.error, /unexpected repository corruption/);

    const failUpdate = updatedJobs.find(j => j.updates?.status === "FAILED");
    assert.ok(failUpdate, "Job should be transitioned to FAILED status in repository");
    assert.match(failUpdate.updates.lastError, /unexpected repository corruption/);
    assert.ok(savedPanels.length >= 1, "Panel should be updated with failure status");
});


