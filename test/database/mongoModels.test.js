"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongo = require("../../database/mongo/index");

test("MongoDB Centralized Models Suite", async (t) => {
    const expectedModels = [
        { name: "GuildConfig", path: "verification/GuildConfig" },
        { name: "VerifyLog", path: "verification/VerifyLog" },
        { name: "OAuthUser", path: "identity/OAuthUser" },
        { name: "OAuthMemberSnapshot", path: "identity/OAuthMemberSnapshot" },
        { name: "OAuthMemberRoleSnapshot", path: "identity/OAuthMemberRoleSnapshot" },
        { name: "OAuthUserProfileSnapshot", path: "identity/OAuthUserProfileSnapshot" },
        { name: "OAuthUserGuildSnapshot", path: "identity/OAuthUserGuildSnapshot" },
        { name: "OAuthUserConnectionSnapshot", path: "identity/OAuthUserConnectionSnapshot" },
        { name: "OAuthObjectChunkSnapshot", path: "identity/OAuthObjectChunkSnapshot" },
        { name: "OAuthSnapshotRecovery", path: "identity/OAuthSnapshotRecovery" },
        { name: "IpIdentityLink", path: "identity/IpIdentityLink" },
        { name: "IpIdentityUserHistory", path: "identity/IpIdentityUserHistory" },
        { name: "IpIdentityDeviceHistory", path: "identity/IpIdentityDeviceHistory" },
        { name: "IpIdentityRoleHistory", path: "identity/IpIdentityRoleHistory" },
        { name: "PrivacyDeletionJob", path: "lifecycle/PrivacyDeletionJob" },
        { name: "VerificationMigrationArchive", path: "lifecycle/VerificationMigrationArchive" },
        { name: "VerificationMigrationState", path: "lifecycle/VerificationMigrationState" }
    ];

    await t.test("exports all 17 centralized models", () => {
        for (const { name } of expectedModels) {
            assert.ok(mongo.models[name], `Model ${name} should be exported`);
            assert.equal(typeof mongo.models[name], "function", `Model ${name} should be a Mongoose model constructor`);
            assert.equal(mongo.models[name].modelName, name, `Model name should match ${name}`);
        }
    });

    await t.test("verification model files strictly re-export canonical mongo models with identical identity", () => {
        for (const { name, path } of expectedModels) {
            const canonicalModel = require(`../../database/mongo/models/${path}`);
            const legacyModel = require(`../../discord/verification/models/${name}`);

            // Strict object reference identity check: old import === new import
            assert.equal(legacyModel, canonicalModel, `discord/verification/models/${name} must strictly equal canonical model`);
            assert.equal(legacyModel.modelName, canonicalModel.modelName);
            assert.equal(legacyModel.collection.name, canonicalModel.collection.name);
            assert.deepEqual(Object.keys(legacyModel.schema.paths), Object.keys(canonicalModel.schema.paths));
        }
    });

    await t.test("exports database mongo connection helper and config", () => {
        assert.ok(mongo.connectDB, "connectDB should be exported");
        assert.ok(mongo.disconnectDB, "disconnectDB should be exported");
        assert.ok(mongo.isMongoConnected, "isMongoConnected should be exported");
        assert.ok(mongo.MONGO_POOL_CONFIG, "MONGO_POOL_CONFIG should be exported");
        assert.equal(mongo.MONGO_POOL_CONFIG.maxPoolSize, 20, "maxPoolSize should be 20");
    });
});
