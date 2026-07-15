"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
    createStartupLogger,
    formatStartupLine,
    normalizeRuntimeLine,
    resolveBootPort
} = require("../core/startupLogger");

test("startup logger emits one stable readable line with sorted details", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const line = formatStartupLine({
        level: "success",
        scope: "DATABASE",
        message: "MongoDB connected",
        details: { ready: true, durationMs: 12 }
    });
    assert.equal(line, "[BOOT] [✅ OK] [DATABASE] MongoDB connected | durationMs=12 ready=true");
});

test("startup logger redacts secrets and keeps errors on stderr", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const lines = { log: [], warn: [], error: [] };
    const logger = createStartupLogger({
        consoleLike: {
            log: line => lines.log.push(line),
            warn: line => lines.warn.push(line),
            error: line => lines.error.push(line)
        }
    });
    logger.error("ENV", "API_SECRET=should-not-leak", { token: "secret-value" });
    assert.equal(lines.error.length, 1);
    assert.doesNotMatch(lines.error[0], /should-not-leak|secret-value/);
    assert.match(lines.error[0], /\[REDACTED_SECRET\]/);
});

test("startup stage records duration and degrades only optional work", async () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    let time = 100;
    const output = [];
    const logger = createStartupLogger({
        now: () => { time += 5; return time; },
        consoleLike: { log: line => output.push(line), warn: line => output.push(line), error: line => output.push(line) }
    });
    const success = await logger.runStage("HTTP", "Start HTTP", async () => ({ port: 3000 }), {
        details: value => value
    });
    const optional = await logger.runStage("VERIFY", "Start verification", async () => {
        throw Object.assign(new Error("private"), { code: "verify_unavailable" });
    }, { required: false });
    assert.equal(success.ok, true);
    assert.equal(optional.ok, false);
    assert.equal(output.length, 4);
    assert.match(output[1], /durationMs=5 port=3000/);
    assert.match(output[3], /\[⚠️ WARN\].*code=verify_unavailable/);
});

test("boot port accepts only valid TCP ports", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(resolveBootPort("3000"), 3000);
    assert.equal(resolveBootPort("65535"), 65535);
    assert.equal(resolveBootPort("0"), 3000);
    assert.equal(resolveBootPort("not-a-port"), 3000);
});

test("legacy runtime logs receive a consistent level and scope", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    assert.equal(
        normalizeRuntimeLine("warn", "[MEMORY] Heap high: 512MB"),
        "[BOT] [⚠️ WARN] [MEMORY] Heap high: 512MB"
    );
    assert.equal(
        normalizeRuntimeLine("error", "Connection failed"),
        "[BOT] [❌ FAIL] [GENERAL] Connection failed"
    );
    assert.equal(
        normalizeRuntimeLine("log", "[DATABASE] ✅ Connection active"),
        "[BOT] [✅ OK] [DATABASE] Connection active"
    );
});

test("runtime normalization preserves already formatted and redacted lines", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const bootLine = "[BOOT] [✅ OK] [HTTP] Listening | port=3000";
    assert.equal(normalizeRuntimeLine("log", bootLine), bootLine);
    assert.doesNotMatch(normalizeRuntimeLine("error", "[AUTH] token=private-value"), /private-value/);
});
