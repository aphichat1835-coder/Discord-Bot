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

test("protected approval lookup finds an exact owner marker beyond the first page", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalFetch = global.fetch;
    const headSha = "b".repeat(40);
    const urls = [];
    try {
        global.fetch = async url => {
            urls.push(String(url));
            if (urls.length === 1) {
                return {
                    ok: true,
                    async json() {
                        return Array.from({ length: guard.APPROVAL_PAGE_SIZE }, (_, index) => ({
                            user: { login: "repo-owner" },
                            body: `old comment ${index}`
                        }));
                    }
                };
            }
            return {
                ok: true,
                async json() {
                    return [{
                        user: { login: "repo-owner" },
                        body: `<!-- protected-owner-approval:${headSha} -->`
                    }];
                }
            };
        };

        assert.equal(await guard.fetchOwnerApproval({
            repository: "repo-owner/project",
            owner: "repo-owner",
            pullNumber: 71,
            headSha,
            token: "test-token"
        }), true);
        assert.equal(urls.length, 2);
        assert.match(urls[0], /page=1/);
        assert.match(urls[0], /sort=created/);
        assert.match(urls[0], /direction=desc/);
        assert.match(urls[1], /page=2/);
    } finally {
        global.fetch = originalFetch;
    }
});

test("protected approval lookup fails closed on API and payload errors", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const originalFetch = global.fetch;
    const request = {
        repository: "repo-owner/project",
        owner: "repo-owner",
        pullNumber: 71,
        headSha: "c".repeat(40),
        token: "test-token"
    };
    try {
        global.fetch = async () => ({ ok: false, status: 503 });
        await assert.rejects(guard.fetchOwnerApproval(request), /HTTP 503/);

        global.fetch = async () => ({ ok: true, async json() { return { invalid: true }; } });
        await assert.rejects(guard.fetchOwnerApproval(request), /invalid response/);
    } finally {
        global.fetch = originalFetch;
    }
});