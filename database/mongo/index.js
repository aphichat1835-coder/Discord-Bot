"use strict";

const connection = require("./connection");

// 1. Verification models
const GuildConfig = require("./models/verification/GuildConfig");
const VerifyLog = require("./models/verification/VerifyLog");

// 2. Identity & Security models
const OAuthUser = require("./models/identity/OAuthUser");
const OAuthMemberSnapshot = require("./models/identity/OAuthMemberSnapshot");
const OAuthMemberRoleSnapshot = require("./models/identity/OAuthMemberRoleSnapshot");
const OAuthUserProfileSnapshot = require("./models/identity/OAuthUserProfileSnapshot");
const OAuthUserGuildSnapshot = require("./models/identity/OAuthUserGuildSnapshot");
const OAuthUserConnectionSnapshot = require("./models/identity/OAuthUserConnectionSnapshot");
const OAuthObjectChunkSnapshot = require("./models/identity/OAuthObjectChunkSnapshot");
const OAuthSnapshotRecovery = require("./models/identity/OAuthSnapshotRecovery");
const IpIdentityLink = require("./models/identity/IpIdentityLink");
const IpIdentityDeviceHistory = require("./models/identity/IpIdentityDeviceHistory");
const IpIdentityUserHistory = require("./models/identity/IpIdentityUserHistory");
const IpIdentityRoleHistory = require("./models/identity/IpIdentityRoleHistory");

// 3. Lifecycle models
const PrivacyDeletionJob = require("./models/lifecycle/PrivacyDeletionJob");
const VerificationMigrationArchive = require("./models/lifecycle/VerificationMigrationArchive");
const VerificationMigrationState = require("./models/lifecycle/VerificationMigrationState");

module.exports = {
    ...connection,
    models: {
        GuildConfig,
        VerifyLog,
        OAuthUser,
        OAuthMemberSnapshot,
        OAuthMemberRoleSnapshot,
        OAuthUserProfileSnapshot,
        OAuthUserGuildSnapshot,
        OAuthUserConnectionSnapshot,
        OAuthObjectChunkSnapshot,
        OAuthSnapshotRecovery,
        IpIdentityLink,
        IpIdentityDeviceHistory,
        IpIdentityUserHistory,
        IpIdentityRoleHistory,
        PrivacyDeletionJob,
        VerificationMigrationArchive,
        VerificationMigrationState
    }
};
