"use strict";

const snapshotStore = require("../discord/verification/services/oauthSnapshotStore");
const ownerService = require("../discord/verification/ownerService");
const OAuthUser = require("../discord/verification/models/OAuthUser");
const VerifyLog = require("../discord/verification/models/VerifyLog");
const verifiedMemberService = require("../discord/verification/services/verifiedMemberService");

function leanQuery(value) {
    return {
        select: jest.fn().mockReturnThis(),
        sort: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(value)
    };
}

describe("OAuth snapshot chunk persistence", () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test("splits large arrays into ordered chunks without losing entries", () => {
        const items = Array.from({ length: 200 }, (_, index) => ({
            id: String(index),
            payload: "x".repeat(256)
        }));
        const chunks = snapshotStore.chunkItems(items, { maxBytes: 4096, maxItems: 25 });

        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.flat()).toEqual(items);
        expect(chunks.every(chunk => chunk.length <= 25)).toBe(true);
        expect(chunks.every((chunk, chunkIndex) =>
            snapshotStore.documentSetBytes({ chunkIndex, items: chunk }) <= 4096
        )).toBe(true);
    });

    test("marks an array snapshot complete only after every chunk is finalized", async () => {
        const writes = [];
        const Model = {
            bulkWrite: jest.fn(async operations => {
                writes.push(...operations);
                return { acknowledged: true };
            }),
            updateMany: jest.fn(async () => ({ matchedCount: writes.length }))
        };
        const items = Array.from({ length: 120 }, (_, index) => ({
            id: String(index),
            payload: "x".repeat(6000)
        }));

        const ref = await snapshotStore.storeArraySnapshot(Model, {
            kind: "guilds",
            userId: "123456789012345678",
            version: "version-1",
            items,
            now: 1000
        });

        const stored = writes.flatMap(operation => operation.updateOne.update.$set.items);
        expect(stored).toEqual(items);
        expect(ref.returnedCount).toBe(120);
        expect(ref.storedCount).toBe(120);
        expect(ref.chunkCount).toBe(writes.length);
        expect(ref.complete).toBe(true);
    });

    test("does not report a partially written chunk set as complete", async () => {
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
        const Model = {
            bulkWrite: jest.fn().mockRejectedValue(Object.assign(new Error("sensitive database detail"), {
                code: "chunk_write_failed"
            })),
            updateMany: jest.fn()
        };

        const ref = await snapshotStore.storeArraySnapshot(Model, {
            kind: "connections",
            userId: "123456789012345678",
            version: "version-failed",
            items: [{ id: "1" }, { id: "2" }],
            now: 1000
        });

        expect(ref).toMatchObject({
            returnedCount: 2,
            storedCount: 0,
            complete: false,
            fetchStatus: "failed",
            failureReason: "chunk_write_failed"
        });
        expect(Model.updateMany).not.toHaveBeenCalled();
        expect(errorLog).toHaveBeenCalledWith(
            "[SNAPSHOT] write failed:",
            expect.stringContaining('"code":"chunk_write_failed"')
        );
        expect(errorLog.mock.calls.flat().join(" ")).not.toContain("sensitive database detail");
    });

    test("reports zero stored items when chunk finalization is incomplete", async () => {
        const errorLog = jest.spyOn(console, "error").mockImplementation(() => {});
        const Model = {
            bulkWrite: jest.fn().mockResolvedValue({ acknowledged: true }),
            updateMany: jest.fn().mockResolvedValue({ matchedCount: 0 })
        };
        const ref = await snapshotStore.storeArraySnapshot(Model, {
            kind: "guilds",
            userId: "123456789012345678",
            version: "version-finalize-failed",
            items: [{ id: "1" }, { id: "2" }],
            now: 1000
        });

        expect(ref).toMatchObject({
            returnedCount: 2,
            storedCount: 0,
            complete: false,
            failureReason: "snapshot_finalize_incomplete"
        });
        expect(errorLog).toHaveBeenCalled();
    });

    test("snapshot models avoid redundant standalone userId indexes", () => {
        for (const Model of Object.values(snapshotStore._models)) {
            const standaloneUserId = Model.schema.indexes().some(([keys]) =>
                Object.keys(keys).length === 1 && keys.userId === 1
            );
            expect(standaloneUserId).toBe(false);
        }
    });

    test("object chunk identity includes guildId to prevent cross-guild collisions", () => {
        const identityIndex = snapshotStore._models.ObjectChunkSnapshot.schema.indexes()
            .find(([, options]) => options.name === "oauth_object_chunk_identity_v2");
        expect(identityIndex).toBeDefined();
        expect(identityIndex[0]).toEqual({
            userId: 1,
            guildId: 1,
            snapshotVersion: 1,
            kind: 1,
            chunkIndex: 1
        });
        expect(identityIndex[1].unique).toBe(true);
    });

    test("loads every ordered chunk and rejects incomplete counts", async () => {
        let documents = [
            { chunkIndex: 0, complete: true, items: [{ id: "1" }, { id: "2" }] },
            { chunkIndex: 1, complete: true, items: [{ id: "3" }] }
        ];
        const Model = {
            find: jest.fn(() => ({
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                lean: jest.fn(async () => documents)
            }))
        };
        const ref = {
            version: "version-1",
            chunkCount: 2,
            storedCount: 3,
            complete: true
        };
        const items = await snapshotStore.loadArraySnapshot(Model, "12345678901234567", ref);

        expect(items).toEqual([{ id: "1" }, { id: "2" }, { id: "3" }]);

        documents = documents.slice(0, 1);
        await expect(snapshotStore.loadArraySnapshot(Model, "12345678901234567", ref))
            .resolves.toBeNull();

        documents = [
            { chunkIndex: 0, complete: true, items: [{ id: "1" }, { id: "2" }] },
            { chunkIndex: 2, complete: true, items: [{ id: "3" }] }
        ];
        await expect(snapshotStore.loadArraySnapshot(Model, "12345678901234567", ref))
            .resolves.toBeNull();

        documents[1].chunkIndex = 1;
        await expect(snapshotStore.loadArraySnapshot(Model, "12345678901234567", {
            ...ref,
            storedCount: 4
        })).resolves.toBeNull();
    });

    test("stores all returned guilds, connections, and member roles with complete counts", async () => {
        const guildOps = [];
        const connectionOps = [];
        const roleOps = [];
        jest.spyOn(snapshotStore._models.GuildSnapshot, "bulkWrite")
            .mockImplementation(async operations => {
                guildOps.push(...operations);
                return { acknowledged: true };
            });
        jest.spyOn(snapshotStore._models.GuildSnapshot, "updateMany")
            .mockImplementation(async () => ({ matchedCount: guildOps.length }));
        jest.spyOn(snapshotStore._models.ConnectionSnapshot, "bulkWrite")
            .mockImplementation(async operations => {
                connectionOps.push(...operations);
                return { acknowledged: true };
            });
        jest.spyOn(snapshotStore._models.ConnectionSnapshot, "updateMany")
            .mockImplementation(async () => ({ matchedCount: connectionOps.length }));
        jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "bulkWrite")
            .mockImplementation(async operations => {
                roleOps.push(...operations);
                return { acknowledged: true };
            });
        jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "updateMany")
            .mockImplementation(async () => ({ matchedCount: roleOps.length }));
        jest.spyOn(snapshotStore._models.MemberSnapshot, "findOneAndUpdate").mockResolvedValue({});
        jest.spyOn(snapshotStore._models.MemberSnapshot, "updateOne").mockResolvedValue({ matchedCount: 1 });
        jest.spyOn(snapshotStore._models.ProfileSnapshot, "findOneAndUpdate").mockResolvedValue({});
        jest.spyOn(snapshotStore._models.ProfileSnapshot, "updateOne").mockResolvedValue({ matchedCount: 1 });

        const guilds = Array.from({ length: 200 }, (_, index) => ({
            id: String(index), name: `guild-${index}`, permissions: "8"
        }));
        const connections = Array.from({ length: 75 }, (_, index) => ({
            type: "service", id: String(index), name: `account-${index}`
        }));
        const roles = Array.from({ length: 125 }, (_, index) => String(index));
        const result = await snapshotStore.storeOAuthSnapshots({
            userId: "123456789012345678",
            guildId: "987654321098765432",
            profile: { id: "123456789012345678", futureField: "preserved" },
            guilds,
            connections,
            member: {
                guildId: "987654321098765432",
                roles,
                snapshot: { nick: "member", roles, futureMemberField: "preserved" }
            },
            now: 1000
        });

        expect(result.guilds).toMatchObject({ returnedCount: 200, storedCount: 200, complete: true });
        expect(result.connections).toMatchObject({ returnedCount: 75, storedCount: 75, complete: true });
        expect(result.profile).toMatchObject({ returnedCount: 1, storedCount: 1, complete: true });
        expect(result.member).toMatchObject({ returnedCount: 1, storedCount: 1, complete: true });
        expect(result.member).toMatchObject({
            roleReturnedCount: 125,
            roleStoredCount: 125,
            roleChunkCount: roleOps.length
        });
        expect(guildOps.flatMap(op => op.updateOne.update.$set.items)).toEqual(guilds);
        expect(connectionOps.flatMap(op => op.updateOne.update.$set.items)).toEqual(connections);
        expect(roleOps.flatMap(op => op.updateOne.update.$set.items)).toEqual(roles);
        expect(snapshotStore._models.MemberSnapshot.findOneAndUpdate).toHaveBeenCalledWith(
            expect.any(Object),
            expect.objectContaining({
                $set: expect.objectContaining({
                    snapshot: expect.objectContaining({
                        snapshot: expect.objectContaining({
                            futureMemberField: "preserved"
                        })
                    }),
                    roleSnapshotRef: expect.objectContaining({ complete: true, storedCount: 125 })
                })
            }),
            expect.any(Object)
        );
        const storedMember = snapshotStore._models.MemberSnapshot.findOneAndUpdate.mock.calls[0][1].$set.snapshot;
        expect(storedMember).not.toHaveProperty("roles");
        expect(storedMember.snapshot).not.toHaveProperty("roles");
    });

    test("reassembles every member role chunk when loading Member Detail data", async () => {
        function findResult(value) {
            return {
                where: jest.fn().mockReturnThis(),
                equals: jest.fn().mockReturnThis(),
                sort: jest.fn().mockReturnThis(),
                findOne: jest.fn().mockReturnThis(),
                lean: jest.fn().mockResolvedValue(value)
            };
        }
        jest.spyOn(snapshotStore._models.GuildSnapshot, "find")
            .mockReturnValue(findResult([{ items: [], chunkIndex: 0, complete: true }]));
        jest.spyOn(snapshotStore._models.ConnectionSnapshot, "find")
            .mockReturnValue(findResult([{ items: [], chunkIndex: 0, complete: true }]));
        jest.spyOn(snapshotStore._models.MemberRoleSnapshot, "find")
            .mockReturnValue(findResult([
                { items: ["1", "2"], chunkIndex: 0, complete: true },
                { items: ["3"], chunkIndex: 1, complete: true }
            ]));
        jest.spyOn(snapshotStore._models.MemberSnapshot, "find").mockReturnValue(
            findResult({
                snapshot: { guildId: "987654321098765432", nick: "member" },
                roleSnapshotRef: {
                    version: "v1",
                    chunkCount: 2,
                    storedCount: 3,
                    complete: true
                }
            })
        );

        const loaded = await snapshotStore.loadOAuthSnapshots({
            userId: "123456789012345678",
            guildId: "987654321098765432",
            refs: {
                guilds: { version: "v1", chunkCount: 1, storedCount: 0, complete: true },
                connections: { version: "v1", chunkCount: 1, storedCount: 0, complete: true },
                member: { version: "v1", guildId: "987654321098765432", complete: true }
            }
        });

        expect(loaded.member.roles).toEqual(["1", "2", "3"]);
        expect(loaded.member.roleCount).toBe(3);
    });

    test("Member Detail hydrates guilds, connections, and all roles from snapshot collections", async () => {
        const roles = Array.from({ length: 125 }, (_, index) => String(index));
        jest.spyOn(OAuthUser, "findOne").mockReturnValue(leanQuery({
            discord: { userId: "123456789012345678", username: "member" },
            snapshotRefs: {
                guilds: { version: "v1", complete: true },
                connections: { version: "v1", complete: true },
                member: { version: "v1", guildId: "987654321098765432", complete: true }
            }
        }));
        jest.spyOn(VerifyLog, "findOne").mockReturnValue(leanQuery({
            userId: "123456789012345678",
            guildId: "987654321098765432",
            result: "success",
            memberSnapshot: { roles: ["legacy-log-role"] }
        }));
        jest.spyOn(VerifyLog, "find").mockReturnValue(leanQuery([]));
        jest.spyOn(snapshotStore, "loadOAuthSnapshots").mockResolvedValue({
            profile: { id: "123456789012345678", futureField: "preserved" },
            guilds: Array.from({ length: 200 }, (_, index) => ({ id: String(index), name: `guild-${index}` })),
            connections: Array.from({ length: 75 }, (_, index) => ({ type: "service", id: String(index) })),
            member: { guildId: "987654321098765432", roles, roleCount: roles.length }
        });

        const detail = await ownerService.getMemberDetail(
            "987654321098765432",
            "123456789012345678",
            { canViewSensitive: true }
        );

        expect(detail.guilds).toHaveLength(200);
        expect(detail.connections).toHaveLength(75);
        expect(detail.targetMember.roles).toHaveLength(125);
        expect(detail.rawSnapshots.profile.futureField).toBe("preserved");
    });

    test("member list pagination returns the next page without overlapping users", async () => {
        const logs = Array.from({ length: 10 }, (_, index) => ({
            _id: `log-${index}`,
            guildId: "987654321098765432",
            userId: `user-${index}`,
            result: "success",
            verifiedAt: 10_000 - index,
            discordSnapshot: { userId: `user-${index}`, username: `member-${index}` }
        }));
        jest.spyOn(VerifyLog, "aggregate").mockImplementation(pipeline => {
            const facet = pipeline.find(stage => stage.$facet)?.$facet;
            const skip = facet?.rows?.find(stage => stage.$skip !== undefined)?.$skip || 0;
            const limit = facet?.rows?.find(stage => stage.$limit !== undefined)?.$limit || 5;
            return {
                allowDiskUse: jest.fn().mockResolvedValue([{
                    metadata: [{ total: logs.length }],
                    rows: logs.slice(skip, skip + limit).map(log => ({
                        userId: log.userId,
                        verifiedAt: log.verifiedAt,
                        log,
                        oauth: null
                    }))
                }])
            };
        });

        const first = await verifiedMemberService.listVerifiedMembers(
            "987654321098765432",
            { page: 0, limit: 5, includeLegacy: false }
        );
        const second = await verifiedMemberService.listVerifiedMembers(
            "987654321098765432",
            { page: 1, limit: 5, includeLegacy: false }
        );

        expect(first.members).toHaveLength(5);
        expect(second.members).toHaveLength(5);
        expect(new Set([...first.members, ...second.members].map(member => member.userId)).size).toBe(10);
        expect(first.hasMore).toBe(true);
        expect(second.hasMore).toBe(false);
    });
});
