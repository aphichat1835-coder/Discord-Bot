"use strict";

/**
 * Join Campaign Subsystem Facade (Single Authority)
 * 
 * The legacy monolithic implementation in this file has been retired and replaced
 * by the sole authoritative Join Campaign subsystem located in ./joinCampaign/index.js.
 * All runtime entrypoints and callers use ./joinCampaign/index.js.
 */

const subsystem = require("./joinCampaign/index");
const { streamCandidates, countEligibleCandidates } = require("./joinCampaign/services/candidateQueryService");
const { sanitizeUserFacingError } = require("./joinCampaign/worker/batchLogger");

const CAMPAIGN_TOKEN_FIELDS = Object.freeze([
    { tokenField: "oauth", label: "verify" },
    { tokenField: "adminOAuth", label: "admin" }
]);

function summarizeJoinCandidates(docs = []) {
    let scannedRecords = 0;
    const userIds = new Set();
    let usableUsers = 0;
    let missingScope = 0;
    const byTokenField = { oauth: 0, adminOAuth: 0 };

    for (const doc of docs) {
        scannedRecords++;
        const userId = String(doc.userId || doc.discord?.userId || "").trim();
        if (userId) userIds.add(userId);
        const scope = String(doc.scope || doc.oauth?.scope || doc.adminOAuth?.scope || "");
        const tokenField = doc.tokenField || "oauth";
        if (scope.includes("guilds.join")) {
            usableUsers++;
            if (byTokenField[tokenField] !== undefined) {
                byTokenField[tokenField]++;
            }
        } else {
            missingScope++;
        }
    }

    return {
        scannedRecords,
        uniqueUsers: userIds.size,
        usableUsers,
        missingScope,
        byTokenField
    };
}

module.exports = {
    ...subsystem,
    CAMPAIGN_TOKEN_FIELDS,
    summarizeJoinCandidates,
    sanitizeUserFacingError,
    _test: {
        streamCandidates,
        countEligibleCandidates,
        CAMPAIGN_TOKEN_FIELDS,
        processAllCandidateBatches: async (summary, context, options = {}) => {
            const tokenManager = options.oauthTokenManager || require("../core/oauthTokenManager");
            const loadDocs = options.loadCandidateDocs;
            const targetGuildId = context.targetGuildId;
            const customManager = loadDocs ? {
                listAccessTokenCandidates: (opts) => loadDocs(opts)
            } : tokenManager;

            const stream = streamCandidates({
                mode: { requiresSource: false },
                baseConfig: { targetGuildId },
                tokenManager: customManager,
                batchSize: context.config?.batchSize || 500,
                onPage: (page) => {
                    const stats = page?.statistics || page?.page?.statistics;
                    if (summary && stats) {
                        for (const [k, v] of Object.entries(stats)) {
                            if (typeof v === "number") {
                                summary[k] = (summary[k] || 0) + v;
                            }
                        }
                    }
                }
            });

            for await (const { candidate } of stream) {
                if (summary) {
                    let accessToken = "token";
                    if (tokenManager?.getAccessToken) {
                        const tokenRes = await tokenManager.getAccessToken({
                            userId: candidate.userId,
                            tokenField: candidate.tokenField || "oauth",
                            model: context.model,
                            discord: context.discord
                        });
                        if (tokenRes?.ok) {
                            accessToken = tokenRes.accessToken;
                        }
                    }
                    if (context.discord?.addMemberToGuild) {
                        const res = await context.discord.addMemberToGuild(targetGuildId, candidate.userId, accessToken);
                        if (res?.ok) summary.joined = (summary.joined || 0) + 1;
                    }
                }
            }
        }
    }
};
