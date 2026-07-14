"use strict";

const snapshotStore = require("../discord/verification/services/oauthSnapshotStore");

function rollbackModel({ updateError = null, deleteError = null, deletedCount = 1 } = {}) {
    return {
        updateMany: updateError
            ? jest.fn().mockRejectedValue(updateError)
            : jest.fn().mockResolvedValue({ matchedCount: 1 }),
        deleteMany: deleteError
            ? jest.fn().mockRejectedValue(deleteError)
            : jest.fn().mockResolvedValue({ deletedCount })
    };
}

function recoveryModel() {
    return {
        findOneAndUpdate: jest.fn().mockResolvedValue({}),
        deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 })
    };
}

describe("snapshot rollback reporting", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

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
        expect(RecoveryModel.findOneAndUpdate).toHaveBeenCalledWith(
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
            { upsert: true, new: true }
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
