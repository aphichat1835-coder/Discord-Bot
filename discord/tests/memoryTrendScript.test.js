const assert = require("node:assert/strict");
const test = require("node:test");

const { evaluateTrend } = require("../../scripts/checkMemoryTrend");

test("memory trend checker accepts stable diagnostics", () => {
    const { findings, summary } = evaluateTrend({
        memoryMonitor: {
            trend: [
                {
                    at: 1,
                    heapUsed: 100,
                    rss: 200,
                    discordListeners: 10,
                    selfClientListeners: 6,
                    activeHandles: 20,
                    selfClientMessages: 10,
                    selfClientUsers: 10,
                    discordMessages: 20,
                    discordUsers: 20
                },
                {
                    at: 2,
                    heapUsed: 110,
                    rss: 230,
                    discordListeners: 11,
                    selfClientListeners: 6,
                    activeHandles: 21,
                    selfClientMessages: 11,
                    selfClientUsers: 12,
                    discordMessages: 23,
                    discordUsers: 22
                }
            ]
        }
    });

    assert.deepEqual(findings, []);
    assert.equal(summary.heapGrowthMb, 10);
    assert.equal(summary.rssGrowthMb, 30);
});

test("memory trend checker rejects unstable diagnostics", () => {
    const { findings } = evaluateTrend({
        memoryMonitor: {
            trend: [
                {
                    at: 1,
                    heapUsed: 100,
                    rss: 200,
                    discordListeners: 10,
                    selfClientListeners: 6,
                    activeHandles: 20,
                    selfClientMessages: 10,
                    selfClientUsers: 10,
                    discordMessages: 20,
                    discordUsers: 20
                },
                {
                    at: 2,
                    heapUsed: 200,
                    rss: 350,
                    discordListeners: 30,
                    selfClientListeners: 20,
                    activeHandles: 80,
                    selfClientMessages: 2000,
                    selfClientUsers: 900,
                    discordMessages: 1200,
                    discordUsers: 1000
                }
            ]
        }
    });

    assert.ok(findings.length > 0);
    assert.ok(findings.some((finding) => finding.includes("heapUsedMB grew")));
    assert.ok(findings.some((finding) => finding.includes("rssMB grew")));
});
