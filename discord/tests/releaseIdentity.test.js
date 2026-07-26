"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { getReleaseIdentity, normalizeCommitSha } = require("../core/releaseIdentity");

test("release identity accepts only exact 40-character commit SHAs", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const sha = "ABCDEF1234567890ABCDEF1234567890ABCDEF12";
    assert.equal(normalizeCommitSha(sha), sha.toLowerCase());
    assert.equal(normalizeCommitSha("abcdef"), null);
    assert.equal(normalizeCommitSha("g".repeat(40)), null);
});

test("release identity prefers Render commit metadata and reports preview state", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const identity = getReleaseIdentity({
        RENDER: "true",
        RENDER_GIT_COMMIT: "1234567890abcdef1234567890abcdef12345678",
        RELEASE_COMMIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
        IS_PULL_REQUEST: "true"
    });
    assert.deepEqual(identity, {
        commitSha: "1234567890abcdef1234567890abcdef12345678",
        provider: "render",
        preview: true
    });
});

test("release identity fails closed when deployment metadata is malformed", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(getReleaseIdentity({
        RENDER: "false",
        RENDER_GIT_COMMIT: "not-a-sha",
        IS_PULL_REQUEST: "false"
    }), {
        commitSha: null,
        provider: "unknown",
        preview: false
    });
});
