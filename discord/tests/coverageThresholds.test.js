"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateCoverage, parseLcov, percentage } = require("../../scripts/checkCoverageThresholds");

test("LCOV threshold parser aggregates source files, lines, functions, and branches", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
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
        sourceFiles: 2,
        lines: { found: 30, hit: 21 },
        functions: { found: 6, hit: 4 },
        branches: { found: 14, hit: 9 }
    });
    assert.equal(percentage(21, 30), 70);
    assert.equal(Number.isNaN(percentage(0, 0)), true);
});

test("coverage evaluation reports every real metric below configured threshold", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = evaluateCoverage({
        sourceFiles: 1,
        lines: { found: 100, hit: 50 },
        functions: { found: 100, hit: 40 },
        branches: { found: 100, hit: 30 }
    }, {
        COVERAGE_LINES_MIN: "60",
        COVERAGE_FUNCTIONS_MIN: "50",
        COVERAGE_BRANCHES_MIN: "40"
    });
    assert.deepEqual(result.failures.sort(), ["branches", "functions", "lines"]);
    assert.deepEqual(result.invalid, []);
    assert.equal(Object.hasOwn(result.metrics, "statements"), false);
});

test("coverage thresholds reject Infinity, accept explicit bounds, and use blank fallbacks", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = evaluateCoverage({
        sourceFiles: 1,
        lines: { found: 100, hit: 100 },
        functions: { found: 100, hit: 100 },
        branches: { found: 100, hit: 100 }
    }, {
        COVERAGE_LINES_MIN: "Infinity",
        COVERAGE_FUNCTIONS_MIN: "-1",
        COVERAGE_BRANCHES_MIN: "101"
    });
    assert.deepEqual(result.failures, []);
    assert.equal(result.thresholds.lines, 35);
    assert.equal(result.thresholds.functions, 0);
    assert.equal(result.thresholds.branches, 100);

    const blank = evaluateCoverage({
        sourceFiles: 1,
        lines: { found: 100, hit: 100 },
        functions: { found: 100, hit: 100 },
        branches: { found: 100, hit: 100 }
    }, {
        COVERAGE_LINES_MIN: "   ",
        COVERAGE_FUNCTIONS_MIN: "",
        COVERAGE_BRANCHES_MIN: ""
    });
    assert.deepEqual(blank.thresholds, { lines: 35, functions: 30, branches: 25 });
});

test("coverage reports with no measured data fail closed instead of reporting one hundred percent", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const result = evaluateCoverage(parseLcov("TN:\nend_of_record\n"));
    assert.deepEqual(result.invalid.sort(), ["branches", "functions", "lines", "sourceFiles"]);
    assert.deepEqual(result.failures.sort(), ["branches", "functions", "lines"]);
    assert.equal(Number.isNaN(result.metrics.lines), true);
});

test("Voice coverage is scoped to the voice/session runtime instead of unrelated imports", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const pkg = require("../../package.json");
    const command = pkg.scripts["test:coverage:voice"];
    assert.match(command, /--test-coverage-include='discord\/voiceWorker\.js'/);
    assert.match(command, /--test-coverage-include='discord\/voiceWorker\/\*\*\/\*\.js'/);
    assert.match(command, /--test-coverage-include='discord\/sessionManager\.js'/);
    assert.match(command, /--test-coverage-include='discord\/sessions\/\*\*\/\*\.js'/);
    assert.equal(command.includes("--test-coverage-exclude"), false);
});