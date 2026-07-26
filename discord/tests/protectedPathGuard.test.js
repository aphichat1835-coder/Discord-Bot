"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const guard = require("../../scripts/checkProtectedPaths");

test("protected path matcher covers the root and every nested protected file", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(guard.isProtectedPath("discord/systemProvider.js"), true);
    assert.equal(guard.isProtectedPath("discord/systemProvider/auth.js"), true);
    assert.equal(guard.isProtectedPath("discord/systemProvider/future/new.js"), true);
    assert.equal(guard.isProtectedPath("discord/systemProvider-old.js"), false);
    assert.equal(guard.isProtectedPath("discord/commands/utility.js"), false);
});

test("external protected approval is accepted only from repository owner and exact head SHA", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalFetch = global.fetch;
    const headSha = "a".repeat(40);
    try {
        global.fetch = async () => ({
            ok: true,
            async json() {
                return [
                    { user: { login: "other-user" }, body: `<!-- protected-owner-approval:${headSha} -->` },
                    { user: { login: "repo-owner" }, body: "approval for another commit" }
                ];
            }
        });
        assert.equal(await guard.fetchOwnerApproval({
            repository: "repo-owner/project",
            owner: "repo-owner",
            pullNumber: 71,
            headSha,
            token: "test-token"
        }), false);

        global.fetch = async () => ({
            ok: true,
            async json() {
                return [{
                    user: { login: "repo-owner" },
                    body: `Owner approved. <!-- protected-owner-approval:${headSha} -->`
                }];
            }
        });
        assert.equal(await guard.fetchOwnerApproval({
            repository: "repo-owner/project",
            owner: "repo-owner",
            pullNumber: 71,
            headSha,
            token: "test-token"
        }), true);
    } finally {
        global.fetch = originalFetch;
    }
});
