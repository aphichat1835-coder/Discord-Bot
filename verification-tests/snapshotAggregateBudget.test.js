"use strict";

// Aggregate size is not a data-loss boundary. Every generated MongoDB document
// must stay under the effective per-document budget, with oversized values
// falling back to checksum-protected object chunks.
const ENV_KEY = "VERIFICATION_SNAPSHOT_MAX_BYTES";
const originalBudget = process.env[ENV_KEY];

function loadSnapshotStore() {
    process.env[ENV_KEY] = String(128 * 1024);
    jest.resetModules();
    return require("../discord/verification/services/oauthSnapshotStore");
}

function mockObjectChunkWrites(snapshotStore) {
    const stored = [];
    jest.spyOn(snapshotStore._models.ObjectChunkSnapshot, "bulkWrite")
        .mockImplementation(async operations => {
            stored.push(...operations.map(operation => operation.updateOne.update.$set));
            return { acknowledged: true };
        });
    jest.spyOn(snapshotStore._models.ObjectChunkSnapshot, "updateMany")
        .mockImplementation(async () => ({ matchedCount: stored.length }));
    return stored;
}

async function reconstructObject(snapshotStore, stored, ref, options) {
    const docs = stored.map(item => ({ ...item, complete: true }));
    jest.spyOn(snapshotStore._models.ObjectChunkSnapshot, "find").mockReturnValue({
        sort: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(docs)
    });
    return snapshotStore.loadObjectChunkSnapshot(
        "123456789012345678",
        ref,
        options
    );
}

function expectEveryDocumentSafe(snapshotStore, documentSets) {
    expect(documentSets.length).toBeGreaterThan(0);
    for (const documentSet of documentSets) {
        expect(snapshotStore.documentSetBytes(documentSet))
            .toBeLessThan(snapshotStore.DOCUMENT_MAX_BYTES);
        expect(snapshotStore.isDocumentSetSafe(documentSet)).toBe(true);
    }
}

afterEach(() => {
    jest.restoreAllMocks();
    if (originalBudget === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalBudget;
    jest.resetModules();
});

test("array snapshots store the complete payload above the old aggregate ceiling", async () => {
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
    expect(operations.flatMap(operation => operation.updateOne.update.$set.items)).toEqual(items);
    expectEveryDocumentSafe(
        snapshotStore,
        operations.map(operation => operation.updateOne.update.$set)
    );
});

test("profile above the embedded-document budget falls back to object chunks without data loss", async () => {
    const snapshotStore = loadSnapshotStore();
    const stored = mockObjectChunkWrites(snapshotStore);
    const profileWrite = jest.spyOn(snapshotStore._models.ProfileSnapshot, "findOneAndUpdate");
    const profile = {
        id: "123456789012345678",
        payload: "x".repeat(snapshotStore.DOCUMENT_WRITE_MAX_BYTES - 80)
    };
    expect(Buffer.byteLength(JSON.stringify(profile), "utf8"))
        .toBeLessThan(snapshotStore.DOCUMENT_MAX_BYTES);

    const ref = await snapshotStore.storeProfileSnapshot({
        userId: "123456789012345678",
        version: "aggregate-profile",
        profile,
        now: 1000
    });

    expect(ref).toMatchObject({
        complete: true,
        storedCount: 1,
        format: "json-base64-chunks-v1"
    });
    expect(profileWrite).not.toHaveBeenCalled();
    expectEveryDocumentSafe(snapshotStore, stored);
    await expect(reconstructObject(snapshotStore, stored, ref, { kind: "profile" }))
        .resolves.toEqual(profile);
});

test("member snapshot keeps member core and every role when member envelope is oversized", async () => {
    const snapshotStore = loadSnapshotStore();
    const roleOperations = [];
    jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "bulkWrite")
        .mockImplementation(async operations => {
            roleOperations.push(...operations);
            return { acknowledged: true };
        });
    jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "updateMany")
        .mockImplementation(async () => ({ matchedCount: roleOperations.length }));
    const stored = mockObjectChunkWrites(snapshotStore);
    const memberWrite = jest.spyOn(snapshotStore._models.MemberSnapshot, "findOneAndUpdate");
    const roles = Array.from({ length: 250 }, (_, index) => String(index));
    const member = {
        roles,
        snapshot: {
            bio: "x".repeat(snapshotStore.DOCUMENT_WRITE_MAX_BYTES - 160),
            roles
        }
    };
    const memberCore = {
        snapshot: { bio: member.snapshot.bio }
    };
    expect(Buffer.byteLength(JSON.stringify(memberCore), "utf8"))
        .toBeLessThan(snapshotStore.DOCUMENT_MAX_BYTES);

    const ref = await snapshotStore.storeMemberSnapshot({
        userId: "123456789012345678",
        guildId: "987654321098765432",
        version: "aggregate-member",
        member,
        now: 1000
    });

    expect(ref).toMatchObject({
        complete: true,
        storedCount: 1,
        format: "json-base64-chunks-v1",
        roleReturnedCount: roles.length,
        roleStoredCount: roles.length
    });
    expect(roleOperations.flatMap(operation => operation.updateOne.update.$set.items)).toEqual(roles);
    expect(memberWrite).not.toHaveBeenCalled();
    expectEveryDocumentSafe(snapshotStore, [
        ...roleOperations.map(operation => operation.updateOne.update.$set),
        ...stored
    ]);
    const expectedCore = memberCore;
    await expect(reconstructObject(snapshotStore, stored, ref, {
        kind: "member",
        guildId: "987654321098765432"
    })).resolves.toEqual(expectedCore);
});

test("a single object larger than one document is split and reconstructed byte-for-byte", async () => {
    const snapshotStore = loadSnapshotStore();
    const stored = mockObjectChunkWrites(snapshotStore);
    const profile = {
        id: "123456789012345678",
        unicode: "ข้อมูลครบ🙂".repeat(80_000)
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
    expectEveryDocumentSafe(snapshotStore, stored);
    await expect(reconstructObject(snapshotStore, stored, ref, { kind: "profile" }))
        .resolves.toEqual(profile);
});

test("an item below the raw 12 MB ceiling falls back when its real document envelope is too large", async () => {
    const snapshotStore = loadSnapshotStore();
    const stored = mockObjectChunkWrites(snapshotStore);
    const normalModel = {
        bulkWrite: jest.fn(),
        updateMany: jest.fn()
    };
    const item = {
        id: "boundary",
        payload: "x".repeat(snapshotStore.DOCUMENT_WRITE_MAX_BYTES - 80)
    };
    expect(Buffer.byteLength(JSON.stringify(item), "utf8"))
        .toBeLessThan(snapshotStore.DOCUMENT_MAX_BYTES);

    const ref = await snapshotStore.storeArraySnapshot(normalModel, {
        kind: "connections",
        userId: "123456789012345678",
        version: "boundary-envelope",
        items: [item],
        now: 1000
    });

    expect(ref).toMatchObject({
        format: "json-base64-chunks-v1",
        complete: true,
        storedCount: 1
    });
    expect(normalModel.bulkWrite).not.toHaveBeenCalled();
    expectEveryDocumentSafe(snapshotStore, stored);
    await expect(reconstructObject(snapshotStore, stored, ref, { kind: "connections" }))
        .resolves.toEqual([item]);
});

test("one failed component rolls back the whole version instead of publishing partial refs", async () => {
    const snapshotStore = loadSnapshotStore();
    const models = snapshotStore._models;
    const guildOperations = [];
    jest.spyOn(models.ProfileSnapshot, "findOneAndUpdate").mockResolvedValue({});
    jest.spyOn(models.ProfileSnapshot, "updateOne").mockResolvedValue({ matchedCount: 1 });
    jest.spyOn(models.GuildSnapshot, "bulkWrite").mockImplementation(async operations => {
        guildOperations.push(...operations);
        return { acknowledged: true };
    });
    jest.spyOn(models.GuildSnapshot, "updateMany")
        .mockImplementationOnce(async () => ({ matchedCount: guildOperations.length }))
        .mockResolvedValue({ matchedCount: guildOperations.length });
    jest.spyOn(models.ConnectionSnapshot, "bulkWrite")
        .mockRejectedValue(Object.assign(new Error("db failed"), { code: "connection_write_failed" }));

    for (const Model of [
        models.GuildSnapshot,
        models.ConnectionSnapshot,
        models.MemberRoleSnapshot,
        models.MemberSnapshot,
        models.ProfileSnapshot,
        models.ObjectChunkSnapshot
    ]) {
        if (!jest.isMockFunction(Model.updateMany)) {
            jest.spyOn(Model, "updateMany").mockResolvedValue({ matchedCount: 0 });
        }
        jest.spyOn(Model, "deleteMany").mockResolvedValue({ deletedCount: 0 });
    }
    jest.spyOn(models.SnapshotRecovery, "deleteOne").mockResolvedValue({ deletedCount: 0 });
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
    expect(result.rollback.complete).toBe(true);
    expect(result.profile.complete).toBe(false);
    expect(result.guilds.complete).toBe(false);
    expect(result.connections.complete).toBe(false);
    expect(models.ProfileSnapshot.deleteMany).toHaveBeenCalled();
    expect(models.GuildSnapshot.deleteMany).toHaveBeenCalled();
});

test("document budget uses the MongoDB BSON size instead of JSON estimation", () => {
    const mongoose = require("mongoose");
    const snapshotStore = loadSnapshotStore();
    const documentSet = {
        userId: "123456789012345678",
        snapshotVersion: "bson-boundary",
        items: Array.from({ length: 200 }, (_, index) => ({ index, value: "x".repeat(64) }))
    };
    const bsonBytes = mongoose.mongo.BSON.calculateObjectSize(documentSet, { ignoreUndefined: true });
    const jsonBytes = Buffer.byteLength(JSON.stringify(documentSet), "utf8");
    expect(snapshotStore.documentSetBytes(documentSet)).toBe(bsonBytes);
    expect(bsonBytes).toBeGreaterThan(jsonBytes);
});
