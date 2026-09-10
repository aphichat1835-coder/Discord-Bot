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

test("protected manifest uses Git blob identities for every protected file", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(guard.validateManifest(), true);
});
