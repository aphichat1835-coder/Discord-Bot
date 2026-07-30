"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
    assertReleaseIdentity,
    expectedCommitSha,
    parseJsonResult
} = require("../../scripts/smokeUnifiedRuntime");

const SHA = "abcdef1234567890abcdef1234567890abcdef12";

function result(release) {
    return {
        path: "/health",
        status: 200,
        text: JSON.stringify({ status: "ok", release })
    };
}

test("deployed smoke accepts the exact expected preview release", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.deepEqual(assertReleaseIdentity(result({
        commitSha: SHA,
        preview: true,
        provider: "render"
    }), SHA, true), {
        commitSha: SHA,
        preview: true,
        provider: "render"
    });
});

test("deployed smoke rejects stale commits, missing identity, and non-preview deployments", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.throws(() => assertReleaseIdentity(result({
        commitSha: "1234567890abcdef1234567890abcdef12345678",
        preview: true
    }), SHA, true), /did not match/);

    assert.throws(() => assertReleaseIdentity(result({
        commitSha: SHA,
        preview: false
    }), SHA, true), /pull-request preview/);

    assert.throws(() => assertReleaseIdentity({
        path: "/health",
        status: 200,
        text: "not-json"
    }, SHA, true), /parseable release JSON/);
});

test("expected smoke SHA is optional for ordinary smoke and exact when supplied", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(expectedCommitSha({}), null);
    assert.equal(expectedCommitSha({ SMOKE_EXPECTED_COMMIT_SHA: SHA.toUpperCase() }), SHA);
    assert.throws(() => expectedCommitSha({ SMOKE_EXPECTED_COMMIT_SHA: "abcdef" }), /40-character/);
    assert.equal(parseJsonResult(result({ commitSha: SHA }))?.release?.commitSha, SHA);
});
