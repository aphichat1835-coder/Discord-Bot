"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

function runIsolated(script) {
    return execFileSync(process.execPath, ["-e", script], {
        cwd: process.cwd(), encoding: "utf8", timeout: 5000
    }).trim();
}

test("awaited delay keeps an otherwise idle process alive", () => {
    const output = runIsolated(`
        const { delay } = require("./discord/core/timers");
        delay(25).then(() => process.stdout.write("resolved"));
    `);
    assert.equal(output, "resolved");
});

test("timeout value remains referenced until fallback resolution", () => {
    const output = runIsolated(`
        const { withTimeoutValue } = require("./discord/core/timers");
        withTimeoutValue(new Promise(() => {}), 25, "fallback")
  .then(value => process.stdout.write(value));
    `);
    assert.equal(output, "fallback");
});

test("timeout rejection remains referenced until rejection", () => {
    const output = runIsolated(`
        const { withTimeoutReject } = require("./discord/core/timers");
        withTimeoutReject(new Promise(() => {}), 25, "expired")
  .catch(error => process.stdout.write(error.message));
    `);
    assert.equal(output, "expired");
});
