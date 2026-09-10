"use strict";

const { finalizeCriticalPersistenceFailure } = require("../discord/verification/routes/oauth")._test;

const BASE_INPUT = Object.freeze({
    requestId: "verify-persistence-test",
    guildId: "222222222222222222",
    userId: "333333333333333333",
    roleId: "444444444444444444",
    result: "success",
    roleAssignResult: { ok: true, alreadyHadRole: false },
    persistence: { oauthUser: false, verifyLog: true, ipTracking: true }
});

describe("OAuth callback critical persistence outcome", () => {
    test("rolls back a newly granted role, records recovery, sends a failure DM, and returns recovery truth", async () => {
        let rollbackCalls = 0;
        let savedRecovery = null;
        let dmCalls = 0;

        const outcome = await finalizeCriticalPersistenceFailure({
            ...BASE_INPUT,
            sendDm: true,
            removeRole: async () => {
                rollbackCalls++;
                return { ok: true };
            },
            saveRecovery: async recovery => {
                savedRecovery = recovery;
                return true;
            },
            sendFailureDm: async () => {
                dmCalls++;
                return true;
            }
        });

        expect(rollbackCalls).toBe(1);
        expect(savedRecovery.status).toBe("role_rolled_back");
        expect(dmCalls).toBe(1);
        expect(outcome.statusCode).toBe(503);
        expect(outcome.body).toMatchObject({
            success: false,
            code: "verification_persistence_failed",
            recoveryRequired: true,
            manualReviewRequired: false,
            recoveryPersisted: true,
            rollbackAttempted: true,
            rollbackSucceeded: true,
            dmSent: true
        });
    });

    test("keeps the failure response truthful when rollback or the failure DM fails", async () => {
        const originalError = console.error;
        console.error = () => {};
        try {
            const outcome = await finalizeCriticalPersistenceFailure({
                ...BASE_INPUT,
                sendDm: true,
                removeRole: async () => ({ ok: false }),
                saveRecovery: async () => true,
                sendFailureDm: async () => {
                    throw new Error("DM_UNAVAILABLE");
                }
            });

            expect(outcome.statusCode).toBe(503);
            expect(outcome.body).toMatchObject({
                success: false,
                code: "verification_persistence_failed",
                recoveryRequired: true,
                manualReviewRequired: true,
                rollbackAttempted: true,
                rollbackSucceeded: false,
                dmSent: false
            });
        } finally {
            console.error = originalError;
        }
    });

    test("does not remove a role that existed before the failed callback", async () => {
        let rollbackCalls = 0;
        const outcome = await finalizeCriticalPersistenceFailure({
            ...BASE_INPUT,
            roleAssignResult: { ok: true, alreadyHadRole: true },
            sendDm: false,
            removeRole: async () => {
                rollbackCalls++;
                return { ok: true };
            },
            saveRecovery: async () => true
        });

        expect(rollbackCalls).toBe(0);
        expect(outcome.body).toMatchObject({
            success: false,
            recoveryRequired: true,
            rollbackAttempted: false,
            rollbackSucceeded: false,
            dmSent: false
        });
    });
});
