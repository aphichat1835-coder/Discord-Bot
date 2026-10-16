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

