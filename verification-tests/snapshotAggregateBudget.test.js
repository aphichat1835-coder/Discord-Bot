"use strict";

// Aggregate size is no longer a data-loss boundary. Only individual MongoDB
// documents are bounded; larger payloads must be split and stored completely.
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

test("array snapshots store the complete payload even above the old aggregate ceiling", async () => {
    const snapshotStore = loadSnapshotStore();
    const operations = [];
    const Model = {
        bulkWrite: jest.fn(async writes => {
            operations.push(...writes);
            return { acknowledged: true };
        }),
        updateMany: jest.fn(async () => ({ matchedCount: operations.length }))
    };
    const items = Array.from({ length: 12 }, (_, index) => ({
        id: String(index),
        payload: "x".repeat(20 * 1024)
    }));
    const ref = await snapshotStore.storeArraySnapshot(Model, {
        kind: "guilds",
        userId: "123456789012345678",
        version: "aggregate-array",
        items,
        now: 1000
    });
    expect(ref).toMatchObject({
        complete: true,
        returnedCount: items.length,
        storedCount: items.length
    });
    expect(operations.flatMap(op => op.updateOne.update.$set.items)).toEqual(items);
});

test("profile snapshots above the old aggregate ceiling are written in full", async () => {
    const snapshotStore = loadSnapshotStore();
    const write = jest.spyOn(snapshotStore._models.ProfileSnapshot, "findOneAndUpdate")
        .mockResolvedValue({});
    jest.spyOn(snapshotStore._models.ProfileSnapshot, "updateOne")
        .mockResolvedValue({ matchedCount: 1 });
    const profile = { id: "123456789012345678", payload: "x".repeat(140 * 1024) };
    const ref = await snapshotStore.storeProfileSnapshot({
        userId: "123456789012345678",
        version: "aggregate-profile",
        profile,
        now: 1000
    });
    expect(ref).toMatchObject({ complete: true, storedCount: 1 });
    expect(write.mock.calls[0][1].$set.snapshot).toEqual(profile);
});

test("member snapshots keep member core and every role above the old aggregate ceiling", async () => {
    const snapshotStore = loadSnapshotStore();
    const roleOps = [];
    jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "bulkWrite")
        .mockImplementation(async operations => {
            roleOps.push(...operations);
            return { acknowledged: true };
        });
    jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "updateMany")
        .mockImplementation(async () => ({ matchedCount: roleOps.length }));
    const memberWrite = jest.spyOn(snapshotStore._models.MemberSnapshot, "findOneAndUpdate")
        .mockResolvedValue({});
    jest.spyOn(snapshotStore._models.MemberSnapshot, "updateOne")
        .mockResolvedValue({ matchedCount: 1 });
    const roles = Array.from({ length: 250 }, (_, index) => String(index));
    const ref = await snapshotStore.storeMemberSnapshot({
        userId: "123456789012345678",
        guildId: "987654321098765432",
        version: "aggregate-member",
        member: {
            roles,
            snapshot: { bio: "x".repeat(140 * 1024), roles }
        },
        now: 1000
    });
    expect(ref).toMatchObject({
        complete: true,
        storedCount: 1,
        roleReturnedCount: roles.length,
        roleStoredCount: roles.length
    });
    expect(roleOps.flatMap(op => op.updateOne.update.$set.items)).toEqual(roles);
    expect(memberWrite.mock.calls[0][1].$set.snapshot.snapshot.bio)
        .toBe("x".repeat(140 * 1024));
});

test("a single object larger than one MongoDB document is split and reconstructed exactly", async () => {
    const snapshotStore = loadSnapshotStore();
    const stored = [];
    jest.spyOn(snapshotStore._models.ObjectChunkSnapshot, "bulkWrite")
        .mockImplementation(async operations => {
            stored.push(...operations.map(op => op.updateOne.update.$set));
            return { acknowledged: true };
        });
    jest.spyOn(snapshotStore._models.ObjectChunkSnapshot, "updateMany")
        .mockImplementation(async () => ({ matchedCount: stored.length }));
    const profile = {
        id: "123456789012345678",
        unicode: "ข้อมูลครบ🙂".repeat(800_000)
    };
    const ref = await snapshotStore.storeProfileSnapshot({
        userId: "123456789012345678",
        version: "oversized-profile",
        profile,
        now: 1000
    });
    expect(ref.format).toBe("json-base64-chunks-v1");
    expect(ref.complete).toBe(true);
    expect(ref.chunkCount).toBeGreaterThan(1);

    const docs = stored.map(item => ({ ...item, complete: true }));
    jest.spyOn(snapshotStore._models.ObjectChunkSnapshot, "find").mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(docs)
    });
    const loaded = await snapshotStore.loadObjectChunkSnapshot(
        "123456789012345678",
        ref,
        { kind: "profile" }
    );
    expect(loaded).toEqual(profile);
});

test("one failed component rolls back the whole version instead of publishing partial refs", async () => {
    const snapshotStore = loadSnapshotStore();
    const models = snapshotStore._models;
    const guildOps = [];
    jest.spyOn(models.ProfileSnapshot, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(models.ProfileSnapshot, "updateOne").mockResolvedValue({ matchedCount: 1 });
    jest.spyOn(models.GuildSnapshot, "bulkWrite").mockImplementation(async operations => {
        guildOps.push(...operations);
        return { acknowledged: true };
    });
    jest.spyOn(models.GuildSnapshot, "updateMany")
        .mockImplementationOnce(async () => ({ matchedCount: guildOps.length }))
        .mockResolvedValue({ matchedCount: guildOps.length });
    jest.spyOn(models.ConnectionSnapshot, "bulkWrite")
        .mockRejectedValue(Object.assign(new Error("db failed"), { code: "connection_write_failed" }));
    for (const Model of Object.values(models)) {
        if (!jest.isMockFunction(Model.updateMany)) {
            jest.spyOn(Model, "updateMany").mockResolvedValue({ matchedCount: 0 });
        }
        jest.spyOn(Model, "deleteMany").mockResolvedValue({ deletedCount: 0 });
    }
    jest.spyOn(console, "error").mockImplementation(() => {});

    const result = await snapshotStore.storeOAuthSnapshots({
        userId: "123456789012345678",
        guildId: "987654321098765432",
        profile: { id: "123456789012345678" },
        guilds: [{ id: "1" }],
        connections: [{ id: "2" }],
        member: null,
        now: 1000
    });

    expect(result.complete).toBe(false);
    expect(result.profile.complete).toBe(false);
    expect(result.guilds.complete).toBe(false);
    expect(result.connections.complete).toBe(false);
    expect(models.ProfileSnapshot.deleteMany).toHaveBeenCalled();
    expect(models.GuildSnapshot.deleteMany).toHaveBeenCalled();
});
