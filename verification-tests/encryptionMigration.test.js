"use strict";

const crypto = require("node:crypto");
const {
    runEncryptionMigration,
    CURRENT_PREFIX,
    _test
} = require("../discord/verification/services/encryptionMigration");

function legacyServiceKey(secret) {
    return Buffer.from(
        crypto.createHash("sha256").update(secret).digest("base64").substring(0, 32)
    );
}

function encryptLegacy(value, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", legacyServiceKey(secret), iv);
    const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return `v2:gcm:${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function readPath(source, path) {
    return path.split(".").reduce((value, key) => value?.[key], source);
}

function writePath(target, path, value) {
    const parts = path.split(".");
    const finalKey = parts.pop();
    const parent = parts.reduce((item, key) => {
        item[key] ||= {};
        return item[key];
    }, target);
    parent[finalKey] = value;
}

function matchesLegacyFilter(doc, filter) {
    if (filter._id?.$gt && doc._id <= filter._id.$gt) return false;
    return filter.$or.some(condition => {
        const field = Object.keys(condition)[0];
        const value = readPath(doc, field);
        return typeof value === "string" && value.length > 0 && !value.startsWith(CURRENT_PREFIX);
    });
}

function fakeModel(docs) {
    return {
        find(filter) {
            const matches = docs.filter(doc => matchesLegacyFilter(doc, filter));
            return {
                select() { return this; },
                sort() { return this; },
                limit(max) { this.max = max; return this; },
                async lean() { return matches.slice(0, this.max); }
            };
        },
        async updateOne(filter, update) {
            const field = Object.keys(filter).find(key => key !== "_id");
            const doc = docs.find(item => item._id === filter._id && readPath(item, field) === filter[field]);
            if (!doc) return { modifiedCount: 0 };
            writePath(doc, field, update.$set[field]);
            return { modifiedCount: 1 };
        },
        async countDocuments(filter) {
            return docs.filter(doc => matchesLegacyFilter(doc, filter)).length;
        }
    };
}

describe("encryption migration", () => {
    const previousKey = process.env.ENCRYPTION_KEY;
    const secret = crypto.randomBytes(48).toString("base64url");

    beforeAll(() => {
        process.env.ENCRYPTION_KEY = secret;
    });

    beforeEach(() => {
        _test.resetMigrationCursors();
    });

    afterAll(() => {
        if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = previousKey;
    });

    test("migrates OAuth tokens and encrypted IPs with conditional updates", async () => {
        const oauthDocs = [{
            _id: "oauth-1",
            oauth: {
                encryptedAccessToken: encryptLegacy("access-token-value", secret),
                encryptedRefreshToken: encryptLegacy("refresh-token-value", secret)
            }
        }];
        const verifyDocs = [{
            _id: "verify-1",
            ipInfo: { encryptedRawIp: encryptLegacy("203.0.113.10", secret) }
        }];
        const identityDocs = [{
            _id: "identity-1",
            encryptedRawIp: encryptLegacy("2001:db8::10", secret)
        }];

        const summary = await runEncryptionMigration({
            OAuthUserModel: fakeModel(oauthDocs),
            VerifyLogModel: fakeModel(verifyDocs),
            IpIdentityLinkModel: fakeModel(identityDocs),
            scanMax: 20
        });

        expect(summary.migratedFields).toBe(4);
        expect(summary.failedFields).toBe(0);
        expect(summary.remainingDocuments).toBe(0);
        expect(oauthDocs[0].oauth.encryptedAccessToken).toMatch(/^v3:gcm:/);
        expect(oauthDocs[0].oauth.encryptedRefreshToken).toMatch(/^v3:gcm:/);
        expect(verifyDocs[0].ipInfo.encryptedRawIp).toMatch(/^v3:gcm:/);
        expect(identityDocs[0].encryptedRawIp).toMatch(/^v3:gcm:/);
    });

    test("dry-run reports legacy data without changing it", async () => {
        const legacy = encryptLegacy("access-token-value", secret);
        const oauthDocs = [{ _id: "oauth-2", oauth: { encryptedAccessToken: legacy } }];
        const emptyModel = fakeModel([]);

        const summary = await runEncryptionMigration({
            OAuthUserModel: fakeModel(oauthDocs),
            VerifyLogModel: emptyModel,
            IpIdentityLinkModel: emptyModel,
            dryRun: true
        });

        expect(summary.eligibleFields).toBe(1);
        expect(summary.migratedFields).toBe(0);
        expect(summary.remainingDocuments).toBe(1);
        expect(oauthDocs[0].oauth.encryptedAccessToken).toBe(legacy);
    });

    test("does not replace a malformed legacy value", async () => {
        const malformed = "v2:gcm:not-valid:not-valid:not-valid";
        const oauthDocs = [{ _id: "oauth-3", oauth: { encryptedAccessToken: malformed } }];
        const emptyModel = fakeModel([]);
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        const summary = await runEncryptionMigration({
            OAuthUserModel: fakeModel(oauthDocs),
            VerifyLogModel: emptyModel,
            IpIdentityLinkModel: emptyModel
        });

        expect(summary.migratedFields).toBe(0);
        expect(summary.failedFields).toBe(1);
        expect(summary.remainingDocuments).toBe(1);
        expect(oauthDocs[0].oauth.encryptedAccessToken).toBe(malformed);
        errorSpy.mockRestore();
    });

    test("advances past a malformed record so later records are not starved", async () => {
        const oauthDocs = [
            { _id: "001", oauth: { encryptedAccessToken: "v2:gcm:broken:value:data" } },
            { _id: "002", oauth: { encryptedAccessToken: encryptLegacy("later-access-token", secret) } }
        ];
        const oauthModel = fakeModel(oauthDocs);
        const emptyModel = fakeModel([]);
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

        const first = await runEncryptionMigration({
            OAuthUserModel: oauthModel,
            VerifyLogModel: emptyModel,
            IpIdentityLinkModel: emptyModel,
            scanMax: 1
        });
        const second = await runEncryptionMigration({
            OAuthUserModel: oauthModel,
            VerifyLogModel: emptyModel,
            IpIdentityLinkModel: emptyModel,
            scanMax: 1
        });

        expect(first.failedFields).toBe(1);
        expect(second.migratedFields).toBe(1);
        expect(oauthDocs[1].oauth.encryptedAccessToken).toMatch(/^v3:gcm:/);
        errorSpy.mockRestore();
    });
});
