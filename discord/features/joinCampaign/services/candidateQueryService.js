"use strict";

const oauthTokenManager = require("../../../tokens/oauthTokenManager");

function resolveNextCursor(page, candidates) {
    if (page?.nextCursor != null) {
        return page.nextCursor;
    }
    if (candidates.length > 0) {
        const lastCandidate = candidates[candidates.length - 1];
        const lastId = lastCandidate?._id || lastCandidate?.recordId;
        if (lastId) {
            return String(lastId);
        }
    }
    return null;
}

async function* streamCandidates({
    mode,
    baseConfig = {},
    tokenManager = oauthTokenManager,
    batchSize = 500,
    startCursor = null,
    seenUsers = null,
    onPage = null
}) {
    let afterId = startCursor || null;
    let hasMore = true;
    const tracker = seenUsers instanceof Set ? seenUsers : null;
    const sourceGuildId = mode?.requiresSource ? baseConfig.sourceGuildId : null;
    const allowAllGuilds = !mode?.requiresSource;
    const additionalMongoFilter = typeof mode?.buildMongoFilter === "function" ? mode.buildMongoFilter(baseConfig) : null;

    while (hasMore) {
        const page = await tokenManager.listAccessTokenCandidates({
            requiredScopes: ["guilds.join"],
            sourceGuildId,
            targetGuildId: baseConfig.targetGuildId,
            allowAllGuilds,
            additionalFilter: additionalMongoFilter,
            limit: batchSize,
            afterId,
            seenUsers: tracker
        });

        let candidates = [];
        if (page?.candidates !== undefined) {
            candidates = page.candidates;
        } else if (Array.isArray(page)) {
            candidates = page;
        }
        const nextCursor = resolveNextCursor(page, candidates);

        // Note: onPage is intended for telemetry/stats only; persistent job cursors must be
        // checkpointed by the consumer after items are safely enqueued, not on page fetch.
        if (typeof onPage === "function") {
            try {
                const pagePayload = (page && typeof page === "object")
                    ? { ...page, nextCursor, candidates, page }
                    : { nextCursor, candidates, page };
                onPage(pagePayload);
            } catch (err) {
                // Ignore onPage telemetry callback errors
            }
        }

        for (const candidate of candidates) {
            const cursor = (candidate._id || candidate.recordId || candidate.id)
                ? String(candidate._id || candidate.recordId || candidate.id)
                : null;
            yield { candidate, cursor };
        }

        // Break if cursor did not advance or no next cursor
        if (!nextCursor || nextCursor === afterId) {
            break;
        }

        afterId = nextCursor;
        hasMore = Boolean(page.hasMore);
    }
}

async function countEligibleCandidates({
    mode,
    baseConfig = {},
    tokenManager = oauthTokenManager,
    targetMemberIds = new Set()
}) {
    let readyCount = 0;
    const countedUsers = new Set();
    const candidatesStream = streamCandidates({ mode, baseConfig, tokenManager });

    for await (const item of candidatesStream) {
        const candidate = item.candidate || item;
        const userId = String(candidate.userId || candidate.discord?.userId || "").trim();
        if (userId && !targetMemberIds.has(userId) && !countedUsers.has(userId)) {
            countedUsers.add(userId);
            readyCount++;
        }
    }

    return readyCount;
}

module.exports = {
    streamCandidates,
    countEligibleCandidates
};
