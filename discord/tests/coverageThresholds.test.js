"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateCoverage, parseLcov, percentage } = require("../../scripts/checkCoverageThresholds");

test("LCOV threshold parser aggregates lines, functions, and branches", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const totals = parseLcov(`
        TN:
        SF:file-a.js
        FNF:4
        FNH:3
        BRF:10
        BRH:7
        LF:20
        LH:16
        end_of_record
        SF:file-b.js
        FNF:2
        FNH:1
        BRF:4
        BRH:2
        LF:10
        LH:5
        end_of_record
    `);
    assert.deepEqual(totals, {
        lines: { found: 30, hit: 21 },
        functions: { found: 6, hit: 4 },
        branches: { found: 14, hit: 9 }
    });
    assert.equal(percentage(21, 30), 70);
});

test("coverage evaluation reports every metric below configured threshold", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = evaluateCoverage({
        lines: { found: 100, hit: 50 },
        functions: { found: 100, hit: 40 },
        branches: { found: 100, hit: 30 }
    }, {
        COVERAGE_STATEMENTS_MIN: "60",
        COVERAGE_LINES_MIN: "60",
        COVERAGE_FUNCTIONS_MIN: "50",
        COVERAGE_BRANCHES_MIN: "40"
    });
    assert.deepEqual(result.failures.sort(), ["branches", "functions", "lines", "statements"]);
});

test("coverage thresholds reject Infinity and fall back to bounded defaults", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = evaluateCoverage({
        lines: { found: 100, hit: 100 },
        functions: { found: 100, hit: 100 },
        branches: { found: 100, hit: 100 }
    }, {
        COVERAGE_LINES_MIN: "Infinity",
        COVERAGE_FUNCTIONS_MIN: "-1",
        COVERAGE_BRANCHES_MIN: "101",
        COVERAGE_STATEMENTS_MIN: "NaN"
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.thresholds.lines, 35);
    assert.equal(result.thresholds.functions, 0);
    assert.equal(result.thresholds.branches, 100);
});
