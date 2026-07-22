"use strict";

const snapshotStore = require("../discord/verification/services/oauthSnapshotStore");

function rollbackModel({
    updateError = null,
    deleteError = null,
    updateAcknowledged = true,
    deleteAcknowledged = true,
    deletedCount = 1
} = {}) {
    return {
        updateMany: updateError
            ? jest.fn().mockRejectedValue(updateError)
            : jest.fn().mockResolvedValue({ acknowledged: updateAcknowledged, matchedCount: 1 }),
        deleteMany: deleteError
            ? jest.fn().mockRejectedValue(deleteError)
            : jest.fn().mockResolvedValue({ acknowledged: deleteAcknowledged, deletedCount })
    };
}

function recoveryModel({ updateAcknowledged = true, deleteAcknowledged = true, retryCount = 0 } = {}) {
    const query = {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ retryCount })
    };
    return {
        findOne: jest.fn().mockReturnValue(query),
        updateOne: jest.fn().mockResolvedValue({ acknowledged: updateAcknowledged, modifiedCount: 1 }),
        deleteOne: jest.fn().mockResolvedValue({ acknowledged: deleteAcknowledged, deletedCount: 1 })
    };
}

afterEach(() => {
    jest.restoreAllMocks();
});

describe("snapshot rollback reporting", () => {
    test("reports a complete rollback only when every mark and delete succeeds", async () => {
        const refs = {
            profile: { version: "v1", complete: true, storedCount: 1 },
            member: {
                version: "v1",
                complete: true,
                storedCount: 1,
                roleRef: { version: "v1", complete: true, storedCount: 2 }
            }
        };
        const RecoveryModel = recoveryModel();
        const result = await snapshotStore.rollbackSnapshotVersion({
            userId: "123456789012345678",
            version: "v1",
            refs,
            models: {
                profile: rollbackModel(),
                objectChunks: rollbackModel()
            },
            RecoveryModel,
            now: 1000
        });

        expect(result).toMatchObject({
            complete: true,
            failedModels: [],
            attemptedModels: ["profile", "objectChunks"],
            recoveryRequired: false
        });
        expect(refs.profile.complete).toBe(false);
        expect(refs.member.roleRef.complete).toBe(false);
        expect(RecoveryModel.deleteOne).toHaveBeenCalledWith({
            userId: "123456789012345678",
            snapshotVersion: "v1"
        });
    });

    test("reports updateMany failure even when deleteMany succeeds", async () => {
        const RecoveryModel = recoveryModel();
        const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
        const Model = rollbackModel({
            updateError: Object.assign(new Error("private database detail"), {
                code: "mark_failed"
            })
        });

        const result = await snapshotStore.rollbackSnapshotVersion({
            userId: "123456789012345678",
            version: "v-update-failed",
            models: { profile: Model },
            RecoveryModel,
            now: 1000
        });

        expect(result.complete).toBe(false);
        expect(result.failedModels).toEqual(["profile"]);
        expect(result.failureCodes).toContain("mark_failed");
        expect(result.operationResults.profile.delete.complete).toBe(true);
        expect(result.recoveryPersisted).toBe(true);
        expect(warning.mock.calls.flat().join(" ")).not.toContain("private database detail");
    });

    test("reports deleteMany failure and persists recovery metadata", async () => {
        const RecoveryModel = recoveryModel();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        const Model = rollbackModel({
            deleteError: Object.assign(new Error("delete exploded"), {
                code: "delete_failed"
            })
        });

        const result = await snapshotStore.rollbackSnapshotVersion({
            userId: "123456789012345678",
            version: "v-delete-failed",
            models: { objectChunks: Model },
            RecoveryModel,
            now: 1000
        });

        expect(result).toMatchObject({
            complete: false,
            failedModels: ["objectChunks"],
            recoveryRequired: true,
            recoveryPersisted: true
        });
        expect(result.failureCodes).toContain("delete_failed");
        expect(RecoveryModel.updateOne).toHaveBeenCalledWith(
            {
                userId: "123456789012345678",
                snapshotVersion: "v-delete-failed"
            },
            expect.objectContaining({
                $set: expect.objectContaining({
                    failedModels: ["objectChunks"],
                    failureCodes: expect.arrayContaining(["delete_failed"])
                })
            }),
            { upsert: true }
        );
    });

    test("reports mixed per-model rollback outcomes without hiding partial failure", async () => {
        const RecoveryModel = recoveryModel();
        jest.spyOn(console, "warn").mockImplementation(() => {});
        const result = await snapshotStore.rollbackSnapshotVersion({
            userId: "123456789012345678",
            version: "v-mixed",
            models: {
                profile: rollbackModel(),
                guilds: rollbackModel({
                    deleteError: Object.assign(new Error("no delete"), { code: "guild_delete_failed" })
                }),
                objectChunks: rollbackModel({
                    updateError: Object.assign(new Error("no mark"), { code: "object_mark_failed" })
                })
            },
            RecoveryModel,
            now: 1000
        });

        expect(result.complete).toBe(false);
        expect(result.attemptedModels).toEqual(["profile", "guilds", "objectChunks"]);
        expect(result.failedModels).toEqual(["guilds", "objectChunks"]);
        expect(result.operationResults.profile.complete).toBe(true);
        expect(result.failureCodes).toEqual(expect.arrayContaining([
            "guild_delete_failed",
            "object_mark_failed"
        ]));
    });
});


test("treats unacknowledged rollback writes as failures and queues recovery", async () => {
    const RecoveryModel = recoveryModel();
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await snapshotStore.rollbackSnapshotVersion({
        userId: "123456789012345678",
        version: "v-unacknowledged",
        models: {
            profile: rollbackModel({ updateAcknowledged: false }),
            objectChunks: rollbackModel({ deleteAcknowledged: false })
        },
        RecoveryModel,
        now: 1000
    });

    expect(result.complete).toBe(false);
    expect(result.failedModels).toEqual(["profile", "objectChunks"]);
    expect(result.failureCodes).toEqual(expect.arrayContaining([
        "rollback_profile_mark_unacknowledged",
        "rollback_objectChunks_delete_unacknowledged"
    ]));
    expect(result.recoveryPersisted).toBe(true);
});

test("does not claim recovery metadata was persisted when MongoDB does not acknowledge it", async () => {
    const RecoveryModel = recoveryModel({ updateAcknowledged: false });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await snapshotStore.rollbackSnapshotVersion({
        userId: "123456789012345678",
        version: "v-recovery-unacknowledged",
        models: { profile: rollbackModel({ deleteError: Object.assign(new Error("fail"), { code: "delete_failed" }) }) },
        RecoveryModel,
        now: 1000
    });

    expect(result.complete).toBe(false);
    expect(result.recoveryPersisted).toBe(false);
    expect(result.failureCodes).toContain("rollback_recovery_metadata_unacknowledged");
});

test("reports an unacknowledged recovery-record clear without misreporting the snapshot rollback", async () => {
    const RecoveryModel = recoveryModel({ deleteAcknowledged: false });
    const result = await snapshotStore.rollbackSnapshotVersion({
        userId: "123456789012345678",
        version: "v-clear-unacknowledged",
        models: { profile: rollbackModel() },
        RecoveryModel,
        now: 1000
    });

    expect(result.complete).toBe(true);
    expect(result.recoveryRecordCleared).toBe(false);
    expect(result.failureCodes).toContain("rollback_recovery_clear_unacknowledged");
});

test("recovery metadata schedules exponential backoff with a bounded nextRetryAt", async () => {
    const RecoveryModel = recoveryModel({ retryCount: 3 });
    jest.spyOn(console, "warn").mockImplementation(() => {});
    await snapshotStore.rollbackSnapshotVersion({
        userId: "123456789012345678",
        version: "v-backoff",
        models: { profile: rollbackModel({ deleteError: Object.assign(new Error("fail"), { code: "delete_failed" }) }) },
        RecoveryModel,
        now: 1000
    });
    const update = RecoveryModel.updateOne.mock.calls[0][1];
    expect(update.$set.retryCount).toBe(4);
    expect(update.$set.nextRetryAt).toBe(1000 + snapshotStore.recoveryDelayMs(4));
    expect(update.$set.nextRetryAt - 1000).toBeLessThanOrEqual(snapshotStore.RECOVERY_RETRY_MAX_MS);
});
