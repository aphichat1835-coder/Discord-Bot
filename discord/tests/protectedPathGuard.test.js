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
    const headSha = "a".repeat(40);
    const request = {
        repository: "repo-owner/project",
        owner: "repo-owner",
        pullNumber: 71,
        headSha,
        token: "test-token"
    };
    assert.equal(await guard.fetchOwnerApproval({
        ...request,
        requestComments: async () => [
            { user: { login: "other-user" }, body: `<!-- protected-owner-approval:${headSha} -->` },
            { user: { login: "repo-owner" }, body: "approval for another commit" }
        ]
    }), false);

    assert.equal(await guard.fetchOwnerApproval({
        ...request,
        requestComments: async () => [{
            user: { login: "repo-owner" },
            body: `Owner approved. <!-- protected-owner-approval:${headSha} -->`
        }]
    }), true);
});

test("protected approval lookup finds an exact owner marker beyond the first page", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const headSha = "b".repeat(40);
    const requests = [];
    assert.equal(await guard.fetchOwnerApproval({
        repository: "repo-owner/project",
        owner: "repo-owner",
        pullNumber: 71,
        headSha,
        token: "test-token",
        requestComments: async options => {
            requests.push(options);
            if (requests.length === 1) {
                return Array.from({ length: guard.APPROVAL_PAGE_SIZE }, (_, index) => ({
                    user: { login: "repo-owner" },
                    body: `old comment ${index}`
                }));
            }
            return [{
                user: { login: "repo-owner" },
                body: `<!-- protected-owner-approval:${headSha} -->`
            }];
        }
    }), true);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].hostname, "api.github.com");
    assert.equal(requests[0].protocol, "https:");
    assert.match(requests[0].path, /page=1/);
    assert.match(requests[0].path, /sort=created/);
    assert.match(requests[0].path, /direction=desc/);
    assert.match(requests[1].path, /page=2/);
});

test("protected approval lookup fails closed on transport and payload errors", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const request = {
        repository: "repo-owner/project",
        owner: "repo-owner",
        pullNumber: 71,
        headSha: "c".repeat(40),
        token: "test-token"
    };
    await assert.rejects(guard.fetchOwnerApproval({
        ...request,
        requestComments: async () => { throw new Error("HTTP 503"); }
    }), /HTTP 503/);
    await assert.rejects(guard.fetchOwnerApproval({
        ...request,
        requestComments: async () => ({ invalid: true })
    }), /invalid response/);
});

test("protected approval transport always fixes the GitHub host and validates repository input", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const options = guard.ownerApprovalRequestOptions("repo-owner/project", 71, 1, "test-token");
    assert.equal(options.hostname, "api.github.com");
    assert.equal(options.port, 443);
    assert.equal(options.method, "GET");
    assert.match(options.path, /^\/repos\/repo-owner\/project\/issues\/71\/comments\?/);
    assert.throws(
        () => guard.ownerApprovalRequestOptions("repo-owner/project?target=bad", 71, 1, "test-token"),
        /invalid GitHub repository slug/
    );
});
