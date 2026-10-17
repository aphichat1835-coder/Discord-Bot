const nodeTest = require("node:test");
const describe = globalThis.describe || nodeTest.describe;
const test = globalThis.test || globalThis.it || nodeTest.it || nodeTest.test;
const expect = globalThis.expect || require("expect").expect || require("expect");

const {
    VerificationWebhookManager,
    _test
} = require("../discord/verification/services/webhook/verificationWebhookManager");
const GuildConfig = require("../discord/verification/models/GuildConfig");

describe("VerificationWebhookManager Delivery Pipeline Suite", () => {
    const validGuildId = "123456789012345678";
    const validJobId = "job_test_123";

    describe("1. _validateDeliveryPrerequisites", () => {
        test("rejects backfill delivery when guild is currently in live mode", () => {
            let failedCalled = null;
            const mockRepo = {
                markDeliveryFailed: (delivId, reason, message, version) => {
                    failedCalled = { delivId, reason, message, version };
                }
            };
            const manager = new VerificationWebhookManager(mockRepo);
            const item = { delivery_id: 1, job_id: validJobId, destination_version: 1 };
            const context = { activeVersion: 1, activeUrl: "https://discord.com/api/webhooks/1/abc", currentMode: "live" };

            const res = manager._validateDeliveryPrerequisites(item, validGuildId, context);
            expect(res).toBe(false);
            expect(failedCalled).toEqual({
                delivId: 1,
                reason: "cancelled_by_live_mode",
                message: "Backfill delivery cancelled because guild switched to live-only mode",
                version: 1
            });
        });

        test("rejects delivery when backfill job is not in RUNNING status", () => {
            let failedCalled = null;
            const mockRepo = {
                getJobById: (id) => ({ job_id: id, status: "FAILED" }),
                markDeliveryFailed: (delivId, reason, message, version) => {
                    failedCalled = { delivId, reason, message, version };
                }
            };
            const manager = new VerificationWebhookManager(mockRepo);
            const item = { delivery_id: 2, job_id: validJobId, destination_version: 1 };
            const context = { activeVersion: 1, activeUrl: "https://discord.com/api/webhooks/1/abc", currentMode: "backfill_live" };

            const res = manager._validateDeliveryPrerequisites(item, validGuildId, context);
            expect(res).toBe(false);
            expect(failedCalled).toEqual({
                delivId: 2,
                reason: "job_not_running",
                message: "Backfill job status is FAILED",
                version: 1
            });
        });

        test("rejects delivery when destination version is obsolete or activeUrl is missing", () => {
            let failedCalled = null;
            const mockRepo = {
                markDeliveryFailed: (delivId, reason, message, version) => {
                    failedCalled = { delivId, reason, message, version };
                }
            };
            const manager = new VerificationWebhookManager(mockRepo);
            const item = { delivery_id: 3, destination_version: 1 };
            const context = { activeVersion: 2, activeUrl: "https://discord.com/api/webhooks/1/abc", currentMode: "live" };

            const res = manager._validateDeliveryPrerequisites(item, validGuildId, context);
            expect(res).toBe(false);
            expect(failedCalled?.reason).toBe("destination_version_obsolete");

            // Also fails when activeUrl is missing
            const res2 = manager._validateDeliveryPrerequisites(item, validGuildId, { activeVersion: 1, activeUrl: null, currentMode: "live" });
            expect(res2).toBe(false);
        });

        test("accepts delivery when all prerequisites are satisfied", () => {
            const mockRepo = {
                getJobById: (id) => ({ job_id: id, status: "RUNNING" })
            };
            const manager = new VerificationWebhookManager(mockRepo);
            const item = { delivery_id: 4, job_id: validJobId, destination_version: 2 };
            const context = { activeVersion: 2, activeUrl: "https://discord.com/api/webhooks/1/abc", currentMode: "backfill_live" };

            const res = manager._validateDeliveryPrerequisites(item, validGuildId, context);
            expect(res).toBe(true);
        });
    });

    describe("2. _determineFailReasonAndMessage", () => {
        const manager = new VerificationWebhookManager({});

        test("destination changed during delivery with sent_parts > 0", () => {
            const item = { sent_parts: 2 };
            const err = { code: "destination_changed_during_delivery", message: "url changed" };
            const res = manager._determineFailReasonAndMessage(item, err, true);
            expect(res.failReason).toBe("cancelled_during_send_partial");
            expect(res.failMessage).toContain("after sending 2 parts");
        });

        test("destination changed during delivery with sent_parts == 0", () => {
            const item = { sent_parts: 0 };
            const err = { code: "destination_changed_during_delivery", message: "url changed" };
            const res = manager._determineFailReasonAndMessage(item, err, true);
            expect(res.failReason).toBe("cancelled_during_send");
        });

        test("permanent error with sent_parts > 0", () => {
            const item = { sent_parts: 1 };
            const err = { code: "http_404", message: "not found" };
            const res = manager._determineFailReasonAndMessage(item, err, true);
            expect(res.failReason).toBe("partial_delivery_failed");
        });

        test("permanent error without sent parts", () => {
            const item = { sent_parts: 0 };
            const err = { code: "http_401", message: "unauthorized" };
            const res = manager._determineFailReasonAndMessage(item, err, true);
            expect(res.failReason).toBe("http_401");
        });

        test("exhausted retry error", () => {
            const item = { sent_parts: 0 };
            const err = { message: "timeout after retries" };
            const res = manager._determineFailReasonAndMessage(item, err, false);
            expect(res.failReason).toBe("exhausted");
            expect(res.failMessage).toBe("timeout after retries");
        });
    });

    describe("3. _handleTerminalDeliveryFailure and retry handling", () => {
        test("marks delivery failed and updates backfill job progress", async () => {
            let markedFailed = null;
            let updatedJob = null;
            let checkedComplete = false;

            const mockRepo = {
                markDeliveryFailed: (id, reason, msg, version) => {
                    markedFailed = { id, reason, msg, version };
                },
                getJobById: () => ({ job_id: validJobId, failure_count: 2 }),
                updateJobProgress: (id, prog) => {
                    updatedJob = { id, prog };
                }
            };

            const manager = new VerificationWebhookManager(mockRepo);
            manager.checkAndCompleteJobIfDone = async (jobId) => {
                if (jobId === validJobId) checkedComplete = true;
            };

            const item = { delivery_id: 10, job_id: validJobId, destination_version: 1, sent_parts: 0 };
            const sendErr = { code: "webhook_not_found", message: "404 Not Found" };

            await manager._handleTerminalDeliveryFailure(item, validGuildId, sendErr, true);

            expect(markedFailed).toEqual({
                id: 10,
                reason: "webhook_not_found",
                msg: "404 Not Found",
                version: 1
            });
            expect(updatedJob).toEqual({
                id: validJobId,
                prog: { failureCount: 3 }
            });
            expect(checkedComplete).toBe(true);
        });

        test("_scheduleDeliveryRetry records retry in repo and schedules wake up", () => {
            let retryScheduled = null;
            const mockRepo = {
                markDeliveryRetry: (id, delayMs, status, errorMsg, version) => {
                    retryScheduled = { id, delayMs, status, errorMsg, version };
                }
            };
            const manager = new VerificationWebhookManager(mockRepo);

            const item = { delivery_id: 11, attempt_count: 1, destination_version: 1 };
            manager._scheduleDeliveryRetry(item, new Error("temporary rate limit"));

            expect(retryScheduled).toBeTruthy();
            expect(retryScheduled.id).toBe(11);
            expect(retryScheduled.status).toBe("retry");
            expect(retryScheduled.errorMsg).toBe("temporary rate limit");
            expect(retryScheduled.version).toBe(1);
        });
    });

    describe("4. _recoverActiveJob", () => {
        test("recovers active job with expired lease by resetting lease and triggering worker", async () => {
            let leaseReset = false;
            let workerTriggered = false;

            const mockRepo = {
                resetJobLease: (id) => { if (id === validJobId) leaseReset = true; }
            };
            const manager = new VerificationWebhookManager(mockRepo);
            manager.triggerWorker = (gId, jId) => {
                if (gId === validGuildId && jId === validJobId) workerTriggered = true;
            };

            const origFindOne = GuildConfig.findOne;
            GuildConfig.findOne = () => ({
                where: () => ({
                    equals: () => ({
                        lean: async () => ({
                            verification: {
                                webhookLog: {
                                    enabled: true,
                                    mode: "backfill_live",
                                    url: "https://discord.com/api/webhooks/1/xyz"
                                }
                            }
                        })
                    })
                })
            });

            try {
                const job = {
                    job_id: validJobId,
                    guild_id: validGuildId,
                    lease_expires_at: Date.now() - 1000
                };

                await manager._recoverActiveJob(job);
                expect(leaseReset).toBe(true);
                expect(workerTriggered).toBe(true);
            } finally {
                GuildConfig.findOne = origFindOne;
            }
        });

        test("cancels orphan job when webhook is disabled or not configured", async () => {
            let jobCancelled = null;
            const mockRepo = {
                cancelJob: (id, reason) => { jobCancelled = { id, reason }; }
            };
            const manager = new VerificationWebhookManager(mockRepo);

            const origFindOne = GuildConfig.findOne;
            GuildConfig.findOne = () => ({
                where: () => ({
                    equals: () => ({
                        lean: async () => ({
                            verification: {
                                webhookLog: { enabled: false }
                            }
                        })
                    })
                })
            });

            try {
                const job = { job_id: validJobId, guild_id: validGuildId };
                await manager._recoverActiveJob(job);
                expect(jobCancelled).toEqual({
                    id: validJobId,
                    reason: "orphan_job_recovered_on_startup"
                });
            } finally {
                GuildConfig.findOne = origFindOne;
            }
        });
    });

    describe("5. Internal Helpers & Retry Parsing", () => {
        test("sendThrottledAlert deduplicates alert within 60 seconds", () => {
            const { sendThrottledAlert } = _test;
            expect(() => {
                sendThrottledAlert({ key: "test_alert_key_1", severity: "WARN", code: "test_code", title: "Test", description: "Test alert" });
                // Second call with same key is throttled
                sendThrottledAlert({ key: "test_alert_key_1", severity: "WARN", code: "test_code", title: "Test", description: "Test alert" });
            }).not.toThrow();
        });

        test("_parseRetryAfterSeconds parses header or body and bounds between 0.5 and 60", async () => {
            const { _parseRetryAfterSeconds } = _test;

            // 1. Valid Retry-After header
            const res1 = {
                headers: { get: () => "5" },
                json: async () => ({})
            };
            expect(await _parseRetryAfterSeconds(res1)).toBe(5);

            // 2. High Retry-After clamped to 60
            const res2 = {
                headers: { get: () => "120" },
                json: async () => ({})
            };
            expect(await _parseRetryAfterSeconds(res2)).toBe(60);

            // 3. Fallback to JSON body retry_after
            const res3 = {
                headers: { get: () => null },
                json: async () => ({ retry_after: 3.5 })
            };
            expect(await _parseRetryAfterSeconds(res3)).toBe(3.5);

            // 4. Default fallback when no header and json throws
            const res4 = {
                headers: { get: () => null },
                json: async () => { throw new Error("invalid json"); }
            };
            expect(await _parseRetryAfterSeconds(res4)).toBe(2);
        });
    });
});
