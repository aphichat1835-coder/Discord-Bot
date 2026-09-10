"use strict";

function normalizeCommitSha(value) {
    const text = String(value || "").trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(text) ? text : null;
}

function getReleaseIdentity(env = process.env) {
    const commitSha = normalizeCommitSha(
        env.RENDER_GIT_COMMIT ||
        env.RELEASE_COMMIT_SHA ||
        env.SOURCE_VERSION ||
        env.GITHUB_SHA
    );

    return {
        commitSha,
        provider: String(env.RENDER || "").toLowerCase() === "true" ? "render" : "unknown",
        preview: String(env.IS_PULL_REQUEST || "").toLowerCase() === "true"
    };
}

module.exports = {
    getReleaseIdentity,
    normalizeCommitSha
};
