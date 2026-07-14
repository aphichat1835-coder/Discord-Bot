"use strict";

// Prevent chunking from bypassing the configured aggregate snapshot ceiling.
const ENV_KEY = "VERIFICATION_SNAPSHOT_MAX_BYTES";
const originalBudget = process.env[ENV_KEY];

function loadSnapshotStore() {
    process.env[ENV_KEY] = String(128 * 1024);
    jest.resetModules();
    return require("../discord/verification/services/oauthSnapshotStore");
}

afterEach(() => {
    jest.restoreAllMocks();
    if (originalBudget === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalBudget;
    jest.resetModules();
});

test("array snapshots reject an aggregate payload before chunk writes", async () => {
    const snapshotStore = loadSnapshotStore();
    jest.spyOn(console, "error").mockImplementation(() => {});
    const Model = { bulkWrite: jest.fn(), updateMany: jest.fn() };
    const ref = await snapshotStore.storeArraySnapshot(Model, {
        kind: "guilds",
        userId: "123456789012345678",
        version: "aggregate-array",
        items: [{ id: "1", payload: "x".repeat(140 * 1024) }],
        now: 1000
    });
    expect(ref).toMatchObject({ complete: false, failureReason: "payload_too_large" });
    expect(Model.bulkWrite).not.toHaveBeenCalled();
    expect(Model.updateMany).not.toHaveBeenCalled();
});

test("profile snapshots reject an aggregate payload before MongoDB writes", async () => {
    const snapshotStore = loadSnapshotStore();
    jest.spyOn(console, "error").mockImplementation(() => {});
    const write = jest.spyOn(snapshotStore._models.ProfileSnapshot, "findOneAndUpdate");
    const finalize = jest.spyOn(snapshotStore._models.ProfileSnapshot, "updateOne");
    const ref = await snapshotStore.storeProfileSnapshot({
        userId: "123456789012345678",
        version: "aggregate-profile",
        profile: { id: "123456789012345678", payload: "x".repeat(140 * 1024) },
        now: 1000
    });
    expect(ref).toMatchObject({ complete: false, failureReason: "payload_too_large" });
    expect(write).not.toHaveBeenCalled();
    expect(finalize).not.toHaveBeenCalled();
});

test("member snapshots include member core and roles in the aggregate budget", async () => {
    const snapshotStore = loadSnapshotStore();
    jest.spyOn(console, "error").mockImplementation(() => {});
    const roleWrite = jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "bulkWrite");
    const memberWrite = jest.spyOn(snapshotStore._models.MemberSnapshot, "findOneAndUpdate");
    const ref = await snapshotStore.storeMemberSnapshot({
        userId: "123456789012345678",
        guildId: "987654321098765432",
        version: "aggregate-member",
        member: {
            roles: ["1"],
            snapshot: { bio: "x".repeat(140 * 1024), roles: ["1"] }
        },
        now: 1000
    });
    expect(ref).toMatchObject({ complete: false, failureReason: "payload_too_large" });
    expect(roleWrite).not.toHaveBeenCalled();
    expect(memberWrite).not.toHaveBeenCalled();
});
