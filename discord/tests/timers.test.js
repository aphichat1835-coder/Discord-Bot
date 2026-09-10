"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { _test } = require("../core/timers");

test("timer delay normalization rejects non-finite values and caps oversized values", () => {
    assert.equal(_test.normalizeDelay("Infinity"), 0);
    assert.equal(_test.normalizeDelay("NaN"), 0);
    assert.equal(_test.normalizeDelay(-100), 0);
    assert.equal(_test.normalizeDelay(_test.MAX_TIMEOUT_MS + 1), _test.MAX_TIMEOUT_MS);
});
