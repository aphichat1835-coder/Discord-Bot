#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
function read(file) { return fs.readFileSync(path.join(root, file), "utf8"); }
function write(file, content) { fs.writeFileSync(path.join(root, file), content); }
function replaceOnce(file, search, replacement) {
    const source = read(file);
    const first = source.indexOf(search);
    if (first < 0) throw new Error(`PATCH_SOURCE_NOT_FOUND:${file}`);
    if (source.indexOf(search, first + search.length) >= 0) throw new Error(`PATCH_SOURCE_NOT_UNIQUE:${file}`);
    write(file, source.slice(0, first) + replacement + source.slice(first + search.length));
}
function replaceRegexOnce(file, regex, replacement) {
    const source = read(file);
    const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
    const count = [...source.matchAll(new RegExp(regex.source, flags))].length;
    if (count !== 1) throw new Error(`PATCH_REGEX_COUNT:${file}:${count}`);
    write(file, source.replace(regex, replacement));
}

replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`function buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage = discord.prepareTokenStorage) {`,
`async function readLatestTokenDocument(model, doc) {
    if (!doc?._id) return doc;
    if (typeof model.findById === "function") {
        const query = model.findById(doc._id);
        return typeof query?.lean === "function" ? await query.lean() : await query;
    }
    if (typeof model.findOne === "function") {
        const query = model.findOne({ _id: doc._id });
        return typeof query?.lean === "function" ? await query.lean() : await query;
    }
    return doc;
}

function tokenStillDue(tokenState, now, marginMs) {
    const expiresAt = Number(tokenState?.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= now + marginMs;
}

function buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage = discord.prepareTokenStorage) {`
);
replaceRegexOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
/async function refreshOneOAuthUser\(doc, \{ model, discordApi, redirectUri, now, prepareTokenStorage, tokenField = 'oauth' \}\) \{[\s\S]*?\n\}/,
`async function refreshOneOAuthUser(doc, {
    model,
    discordApi,
    redirectUri,
    now,
    marginMs,
    prepareTokenStorage,
    tokenField = 'oauth'
}) {
    const userId = doc.discord?.userId || String(doc._id);
    return withRefreshLock(\`${userId}:${tokenField}\`, async () => {
        const latest = await readLatestTokenDocument(model, doc);
        if (!latest) return { ok: true, skipped: true, reason: 'document_missing', tokenField, userId };
        const tokenState = latest[tokenField] || {};
        if (!tokenStillDue(tokenState, now, marginMs)) {
            return { ok: true, skipped: true, reason: 'already_refreshed', tokenField, userId };
        }
        const previousRefreshToken = tokenState.encryptedRefreshToken;
        if (!previousRefreshToken) return { ok: true, skipped: true, reason: 'refresh_token_missing', tokenField, userId };
        const previousVersion = Number(tokenState.version || 0);
        const tokenData = await discordApi.refreshToken(previousRefreshToken, redirectUri);
        const oauth = {
            ...buildStoredOAuthUpdate(tokenData, now, prepareTokenStorage),
            version: previousVersion + 1
        };
        const versionCondition = previousVersion > 0
            ? { [tokenPath(tokenField, 'version')]: previousVersion }
            : {
                $or: [
                    { [tokenPath(tokenField, 'version')]: 0 },
                    { [tokenPath(tokenField, 'version')]: { $exists: false } }
                ]
            };
        const result = await model.updateOne(
            {
                _id: latest._id,
                [tokenPath(tokenField, 'encryptedRefreshToken')]: previousRefreshToken,
                ...versionCondition
            },
            {
                $set: {
                    [tokenField]: oauth,
                    updatedAt: now
                }
            }
        );
        const modified = Number(result?.modifiedCount ?? result?.nModified ?? 0);
        if (modified !== 1) {
            const conflict = new Error('OAuth refresh state changed before persistence');
            conflict.code = 'TOKEN_REFRESH_CONFLICT';
            throw conflict;
        }
        return { ok: true, tokenField, userId, version: oauth.version };
    });
}`
);
replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`        refreshed: 0,
        failed: 0,
        revoked: 0,`,
`        refreshed: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        revoked: 0,`
);
replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`                now,
                prepareTokenStorage,
                tokenField
            });
            summary.refreshed++;
        } catch (err) {
            const failure = await markRefreshFailure(doc, err, {`,
`                now,
                marginMs: config.marginMs,
                prepareTokenStorage,
                tokenField
            });
            if (result.skipped) summary.skipped++;
            else summary.refreshed++;
        } catch (err) {
            if (err?.code === 'TOKEN_REFRESH_CONFLICT') {
                summary.conflicts++;
                continue;
            }
            const failure = await markRefreshFailure(doc, err, {`
);
replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`        refreshed: 0,
        failed: 0,
        revoked: 0,
        persistenceFailed: 0,`,
`        refreshed: 0,
        skipped: 0,
        conflicts: 0,
        failed: 0,
        revoked: 0,
        persistenceFailed: 0,`
);
replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`        summary.refreshed += fieldSummary.refreshed;
        summary.failed += fieldSummary.failed;`,
`        summary.refreshed += fieldSummary.refreshed;
        summary.skipped += fieldSummary.skipped || 0;
        summary.conflicts += fieldSummary.conflicts || 0;
        summary.failed += fieldSummary.failed;`
);
replaceOnce(
    "discord/verification/utils/oauthTokenLifecycle.js",
`        readPositiveNumber,
        refreshOneOAuthUser,`,
`        readPositiveNumber,
        readLatestTokenDocument,
        tokenStillDue,
        refreshOneOAuthUser,`
);

replaceRegexOnce(
    "discord/verification/routes/oauth.js",
/router\.get\('\/auth\/start', async \(req, res\) => \{[\s\S]*?\n\}\);\n\nrouter\.get\('\/auth\/callback'/,
`router.get('/auth/start', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
        const panelState = decodeCallbackState(req.query?.state);
        if (!panelState?.guildId || !panelState?.roleId) {
            return res.status(400).send('ลิงก์ยืนยันไม่ถูกต้อง');
        }

        const safeGuildId = safeSnowflakeStrict(panelState.guildId, "guild_id");
        const guildConfig = await GuildConfig.findOne()
            .where('guildId').equals(safeGuildId)
            .lean();
        const verification = normalizeVerificationConfig(guildConfig?.verification || {});
        if (!verification.enabled || String(verification.roleId || '') !== String(panelState.roleId)) {
            return res.status(409).send('แผงยืนยันนี้ไม่พร้อมใช้งาน');
        }
        if (panelState.panelRevision && verification.panelRevision &&
            String(panelState.panelRevision) !== String(verification.panelRevision)) {
            return res.status(409).send('แผงยืนยันนี้ถูกแทนที่แล้ว กรุณาใช้แผงล่าสุด');
        }

        const executionState = createCompactCallbackState({
            guildId: panelState.guildId,
            roleId: panelState.roleId,
            expectedUserId: panelState.expectedUserId || null,
            panelRevision: verification.panelRevision || panelState.panelRevision || null,
            expiresAt: Date.now() + 10 * 60 * 1000
        });
        const executionStateObj = decodeCallbackState(executionState);
        if (!executionStateObj || !await registerVerificationState(executionStateObj)) {
            return res.status(503).send('ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่');
        }

        const params = new URLSearchParams({
            client_id: process.env.DISCORD_CLIENT_ID,
            redirect_uri: REDIRECT_URI,
            response_type: 'code',
            scope: VERIFY_SCOPE,
            state: executionState,
            prompt: 'consent'
        });
        return res.redirect(302, \`https://discord.com/oauth2/authorize?${params.toString()}\`);
    } catch (error) {
        const code = String(error?.code || error?.name || 'oauth_start_failed').slice(0, 80);
        console.error('[VERIFY] OAuth start failed:', code);
        const status = code.startsWith('invalid_') || code.includes('snowflake') ? 400 : 503;
        return res.status(status).send(status === 400
            ? 'ลิงก์ยืนยันไม่ถูกต้อง'
            : 'ไม่สามารถเริ่มการยืนยันได้ กรุณาลองใหม่');
    }
});

router.get('/auth/callback'`
);
replaceOnce(
    "discord/verification/lifecycle.js",
`    app.post("/auth/callback", callbackLimiter, (req, res, next) => {`,
`    app.get("/auth/start", callbackLimiter, (_req, _res, next) => next());
    app.post("/auth/callback", callbackLimiter, (req, res, next) => {`
);

replaceRegexOnce(
    "discord/verification/services/privacyDeletion.js",
/async function runMemberPrivacyDeletion\([\s\S]*?\n\}\n\nmodule\.exports/,
`const activePrivacyDeletions = new Map();

function countQueryWithSession(Model, filter, session) {
    const query = Model.countDocuments(filter);
    return typeof query?.session === "function" ? query.session(session) : query;
}

function runMemberPrivacyDeletion(options) {
    const key = \`${String(options?.guildId || "")}:${String(options?.userId || "")}\`;
    if (activePrivacyDeletions.has(key)) return activePrivacyDeletions.get(key);
    const operation = runMemberPrivacyDeletionInternal(options).finally(() => {
        if (activePrivacyDeletions.get(key) === operation) activePrivacyDeletions.delete(key);
    });
    activePrivacyDeletions.set(key, operation);
    return operation;
}

async function runMemberPrivacyDeletionInternal({
    guildId,
    userId,
    requestedBy,
    now = Date.now(),
    models = DEFAULT_MODELS,
    mongooseInstance = mongoose
}) {
    const safeGuildId = String(guildId || "");
    const safeUserId = String(userId || "");
    const safeRequestedBy = String(requestedBy || "dashboard-control").slice(0, 120);
    const hash = subjectHash(safeGuildId, safeUserId);
    const jobId = crypto.randomUUID();
    const {
        VerifyLog: VerifyLogModel,
        OAuthUser: OAuthUserModel,
        IpIdentityLink: IpIdentityLinkModel,
        IpIdentityUserHistory: IpIdentityUserHistoryModel,
        IpIdentityDeviceHistory: IpIdentityDeviceHistoryModel,
        IpIdentityRoleHistory: IpIdentityRoleHistoryModel,
        OAuthMemberSnapshot: OAuthMemberSnapshotModel,
        OAuthMemberRoleSnapshot: OAuthMemberRoleSnapshotModel,
        OAuthObjectChunkSnapshot: OAuthObjectChunkSnapshotModel,
        OAuthSnapshotRecovery: OAuthSnapshotRecoveryModel,
        VerificationMigrationArchive: VerificationMigrationArchiveModel,
        VerificationRecovery: VerificationRecoveryModel,
        PrivacyDeletionJob: PrivacyDeletionJobModel
    } = models;

    const manifest = {
        version: MANIFEST_VERSION,
        scope: "guild_member",
        preservedGlobalSnapshots: true,
        counts: {},
        remainingReferences: null
    };
    const setCount = (name, value) => {
        const count = Math.max(0, Number(value || 0));
        manifest.counts[name] = count;
        manifest[name] = count;
    };

    await PrivacyDeletionJobModel.create({
        jobId,
        guildId: safeGuildId,
        userId: safeUserId,
        subjectHash: hash,
        requestedBy: safeRequestedBy,
        status: "pending",
        manifestVersion: MANIFEST_VERSION,
        createdAt: now,
        updatedAt: now
    });

    let dbSession = null;
    try {
        dbSession = await mongooseInstance.startSession();
        await dbSession.withTransaction(async () => {
            await PrivacyDeletionJobModel.updateOne(
                { jobId },
                { $set: { status: "running", updatedAt: Date.now() } },
                { session: dbSession }
            );

            const memberSnapshots = await OAuthMemberSnapshotModel.find({ userId: safeUserId, guildId: safeGuildId })
                .select("snapshotVersion")
                .session(dbSession)
                .lean();
            const memberVersions = [...new Set(memberSnapshots
                .map(item => String(item?.snapshotVersion || ""))
                .filter(Boolean))];

            const verifyLogResult = await VerifyLogModel.updateMany(
                { guildId: safeGuildId, userId: safeUserId },
                {
                    $set: {
                        userId: deletedSubjectId(hash),
                        result: "failed",
                        reason: "privacy_deleted",
                        findings: [],
                        deletedAt: now,
                        deletedBy: safeRequestedBy
                    },
                    $unset: sensitiveVerifyLogUnset()
                },
                { session: dbSession }
            );
            setCount("verifyLogsRedacted", resultCount(verifyLogResult));

            const operations = [
                ["ipUserHistory", () => IpIdentityUserHistoryModel.deleteMany({ guildId: safeGuildId, userId: safeUserId }, { session: dbSession })],
                ["ipDeviceHistory", () => IpIdentityDeviceHistoryModel.deleteMany({ guildId: safeGuildId, userId: safeUserId }, { session: dbSession })],
                ["ipRoleHistory", () => IpIdentityRoleHistoryModel.deleteMany({ guildId: safeGuildId, userId: safeUserId }, { session: dbSession })],
                ["memberSnapshots", () => OAuthMemberSnapshotModel.deleteMany({ guildId: safeGuildId, userId: safeUserId }, { session: dbSession })],
                ["memberRoleSnapshots", () => memberVersions.length
                    ? OAuthMemberRoleSnapshotModel.deleteMany({ userId: safeUserId, snapshotVersion: { $in: memberVersions } }, { session: dbSession })
                    : Promise.resolve({ deletedCount: 0 })],
                ["objectChunks", () => OAuthObjectChunkSnapshotModel.deleteMany({ userId: safeUserId, guildId: safeGuildId }, { session: dbSession })],
                ["snapshotRecovery", () => memberVersions.length
                    ? OAuthSnapshotRecoveryModel.deleteMany({ userId: safeUserId, snapshotVersion: { $in: memberVersions } }, { session: dbSession })
                    : Promise.resolve({ deletedCount: 0 })],
                ["verificationRecovery", () => VerificationRecoveryModel.deleteMany({ guildId: safeGuildId, userId: safeUserId }, { session: dbSession })]
            ];
            for (const [name, operationFn] of operations) setCount(name, resultCount(await operationFn()));

            const identity = await scrubIdentityLinks({
                LinkModel: IpIdentityLinkModel,
                guildId: safeGuildId,
                userId: safeUserId,
                requestedBy: safeRequestedBy,
                now,
                session: dbSession
            });
            setCount("ipIdentityLinksDeleted", identity.deleted);
            setCount("ipIdentityLinksUpdated", identity.updated);

            const oauthDocument = await OAuthUserModel.findOne({ "discord.userId": safeUserId })
                .select("guilds lastMember lastVerify lastIpTracking snapshotMeta snapshotRefs")
                .session(dbSession)
                .lean();
            if (oauthDocument) {
                const oauthResult = await OAuthUserModel.updateOne(
                    { _id: oauthDocument._id },
                    buildOAuthUserPrivacyUpdate(oauthDocument, safeGuildId, now),
                    { session: dbSession }
                );
                setCount("oauthUserUpdated", resultCount(oauthResult));
            } else {
                setCount("oauthUserUpdated", 0);
            }

            setCount("migrationArchivesRedacted", await redactMigrationArchives({
                ArchiveModel: VerificationMigrationArchiveModel,
                userId: safeUserId,
                guildId: safeGuildId,
                requestedBy: safeRequestedBy,
                now,
                session: dbSession
            }));

            const remainingFilters = [
                [VerifyLogModel, { guildId: safeGuildId, userId: safeUserId }],
                [OAuthMemberSnapshotModel, { guildId: safeGuildId, userId: safeUserId }],
                [IpIdentityUserHistoryModel, { guildId: safeGuildId, userId: safeUserId }],
                [IpIdentityDeviceHistoryModel, { guildId: safeGuildId, userId: safeUserId }],
                [IpIdentityRoleHistoryModel, { guildId: safeGuildId, userId: safeUserId }],
                [OAuthObjectChunkSnapshotModel, { guildId: safeGuildId, userId: safeUserId }],
                [VerificationRecoveryModel, { guildId: safeGuildId, userId: safeUserId }],
                [OAuthUserModel, {
                    "discord.userId": safeUserId,
                    $or: [
                        { "guilds.id": safeGuildId },
                        { "lastMember.guildId": safeGuildId },
                        { "lastVerify.guildId": safeGuildId },
                        { "snapshotRefs.member.guildId": safeGuildId }
                    ]
                }],
                [IpIdentityLinkModel, {
                    guildId: safeGuildId,
                    $or: [
                        { "users.userId": safeUserId },
                        { "deviceFingerprints.userId": safeUserId },
                        { "roleSnapshots.userId": safeUserId }
                    ]
                }]
            ];
            if (memberVersions.length) {
                remainingFilters.push(
                    [OAuthMemberRoleSnapshotModel, { userId: safeUserId, snapshotVersion: { $in: memberVersions } }],
                    [OAuthSnapshotRecoveryModel, { userId: safeUserId, snapshotVersion: { $in: memberVersions } }]
                );
            }
            const remainingChecks = await Promise.all(
                remainingFilters.map(([Model, filter]) => countQueryWithSession(Model, filter, dbSession))
            );
            manifest.remainingReferences = remainingChecks.reduce((sum, value) => sum + Number(value || 0), 0);
            if (manifest.remainingReferences !== 0) {
                const error = new Error("Privacy deletion left remaining guild-scoped references");
                error.code = "PRIVACY_DELETION_INCOMPLETE";
                throw error;
            }

            await PrivacyDeletionJobModel.updateOne(
                { jobId },
                {
                    $set: {
                        userId: deletedSubjectId(hash),
                        subjectHash: hash,
                        status: "completed",
                        manifest,
                        completedAt: Date.now(),
                        updatedAt: Date.now()
                    }
                },
                { session: dbSession }
            );
        });
        return { success: true, jobId, manifest };
    } catch (error) {
        await PrivacyDeletionJobModel.updateOne(
            { jobId },
            {
                $set: {
                    status: "failed",
                    manifest,
                    errorCode: error.code || error.name || "PRIVACY_DELETION_FAILED",
                    updatedAt: Date.now()
                }
            }
        ).catch(() => {});
        throw error;
    } finally {
        if (dbSession) await dbSession.endSession().catch(() => {});
    }
}

module.exports`
);
replaceOnce(
    "discord/verification/routes/guild.js",
`      deletedCount: Object.values(deletion.manifest || {})
        .filter(value => Number.isFinite(Number(value)))
        .reduce((sum, value) => sum + Number(value), 0),`,
`      deletedCount: Object.values(deletion.manifest?.counts || {})
        .filter(value => Number.isFinite(Number(value)))
        .reduce((sum, value) => sum + Number(value), 0),`
);

console.log("[TEMP-PATCH] verification remediation applied");
