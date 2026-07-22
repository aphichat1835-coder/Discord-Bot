"use strict";

const { Readable } = require("node:stream");

const {
    restoreFilter,
    restoreCursor,
    timestamp
} = require("../scripts/restoreVerificationMigration");

function archiveCursor(items) {
    return Readable.from(items, { objectMode: true });
}

describe("verification migration restore", () => {
    test("validates explicit restore scope before database work", () => {
        expect(restoreFilter({ restoreAll: true })).toEqual({
            migrationVersion: 2,
            sourceCollection: "oauthusers"
        });
        expect(restoreFilter({ sourceId: "0123456789abcdef01234567" })).toMatchObject({
            sourceId: "0123456789abcdef01234567"
        });
        expect(() => restoreFilter({ sourceId: "invalid" })).toThrow("24-character MongoDB ObjectId");
        expect(() => restoreFilter({ restoreAll: false, sourceId: "" }))
            .toThrow("Use --source-id=ID or --all");
    });

    test("dry-run counts archives without reading or replacing live documents", async () => {
        const findOne = jest.fn();
        const replaceOne = jest.fn();
        const summary = await restoreCursor({
            cursor: archiveCursor([
                { payload: { _id: "one" } },
                { payload: null }
            ]),
            findOne,
            replaceOne
        });

        expect(summary).toEqual({
            mode: "dry-run",
            found: 2,
            restored: 0,
            skipped: 1,
            newerSkipped: 0
        });
        expect(findOne).not.toHaveBeenCalled();
        expect(replaceOne).not.toHaveBeenCalled();
    });

    test("apply skips a live document that is newer than its archive", async () => {
        const replaceOne = jest.fn();
        const summary = await restoreCursor({
            cursor: archiveCursor([{
                backedUpAt: 200,
                payload: { _id: "one", updatedAt: 100 }
            }]),
            apply: true,
            findOne: jest.fn().mockResolvedValue({ updatedAt: 300 }),
            replaceOne
        });

        expect(summary).toMatchObject({ restored: 0, skipped: 1, newerSkipped: 1 });
        expect(replaceOne).not.toHaveBeenCalled();
    });

    test("force restore replaces newer data and counts acknowledged results", async () => {
        const findOne = jest.fn();
        const replaceOne = jest.fn().mockResolvedValue({ acknowledged: true });
        const summary = await restoreCursor({
            cursor: archiveCursor([{
                backedUpAt: 200,
                payload: { _id: "one", updatedAt: 100 }
            }]),
            apply: true,
            force: true,
            findOne,
            replaceOne
        });

        expect(summary).toMatchObject({ restored: 1, skipped: 0, newerSkipped: 0 });
        expect(findOne).not.toHaveBeenCalled();
        expect(replaceOne).toHaveBeenCalledWith(
            { _id: "one" },
            { _id: "one", updatedAt: 100 },
            { upsert: true }
        );
    });

    test("unacknowledged replacements are skipped", async () => {
        const summary = await restoreCursor({
            cursor: archiveCursor([{ backedUpAt: 200, payload: { _id: "one" } }]),
            apply: true,
            force: true,
            replaceOne: jest.fn().mockResolvedValue({ acknowledged: false })
        });
        expect(summary).toMatchObject({ restored: 0, skipped: 1 });
    });

    test("normalizes numeric and Date timestamps", () => {
        expect(timestamp(new Date(123))).toBe(123);
        expect(timestamp("456")).toBe(456);
        expect(timestamp("invalid")).toBe(0);
    });
});
