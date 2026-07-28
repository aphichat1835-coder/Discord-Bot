"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateCoverage, evaluateCriticalFiles, normalizeCoveragePath, parseLcov, percentage } = require("../../scripts/checkCoverageThresholds");

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
    assert.equal(totals.sourceFiles, 2);
    assert.deepEqual(totals.lines, { found: 30, hit: 21 });
    assert.deepEqual(totals.functions, { found: 6, hit: 4 });
    assert.deepEqual(totals.branches, { found: 14, hit: 9 });
    assert.deepEqual(totals.files["file-a.js"], {
        sourceFiles: 1,
        lines: { found: 20, hit: 16 },
        functions: { found: 4, hit: 3 },
        branches: { found: 10, hit: 7 }
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

test("critical coverage normalizes Windows paths and evaluates files independently", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const parsed = parseLcov(`
        SF:C:\\repo\\discord\\voiceWorker\\lifecycle.js
        FNF:10
        FNH:8
        BRF:20
        BRH:12
        LF:100
        LH:80
        end_of_record
    `);
    assert.equal(normalizeCoveragePath("C:\\repo\\discord\\voiceWorker\\lifecycle.js"), "discord/voiceWorker/lifecycle.js");
    const result = evaluateCriticalFiles(parsed, {
        "discord/voiceWorker/lifecycle.js": { lines: 80, functions: 80, branches: 60 }
    });
    assert.equal(result.failures.length, 0);
});

test("critical coverage fails when aggregate coverage passes but a protected file is low", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const parsed = parseLcov(`
        SF:discord/critical.js
        FNF:10
        FNH:1
        BRF:10
        BRH:1
        LF:10
        LH:1
        end_of_record
        SF:discord/high.js
        FNF:100
        FNH:100
        BRF:100
        BRH:100
        LF:1000
        LH:1000
        end_of_record
    `);
    assert.deepEqual(evaluateCoverage(parsed, {
        COVERAGE_LINES_MIN: "35",
        COVERAGE_FUNCTIONS_MIN: "30",
        COVERAGE_BRANCHES_MIN: "25"
    }).failures, []);
    const result = evaluateCriticalFiles(parsed, {
        "discord/critical.js": { lines: 50, functions: 50, branches: 50 }
    });
    assert.deepEqual(result.failures[0].failures.sort(), ["branches", "functions", "lines"]);
});

test("critical coverage fails closed when a required source file is absent", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const parsed = parseLcov("SF:discord/present.js\nLF:1\nLH:1\nend_of_record\n");
    const result = evaluateCriticalFiles(parsed, {
        "discord/missing.js": { lines: 1 }
    });
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].missing, true);
    assert.deepEqual(result.failures[0].failures, ["missing"]);
});
