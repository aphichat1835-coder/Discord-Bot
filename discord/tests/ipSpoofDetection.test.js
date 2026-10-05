const test = require("node:test");
const assert = require("node:assert/strict");
const { _test, extractDevice, processIP } = require("../verification/utils/ipUtils");

test("checkCloudflareSpoofFlags detects untrusted cf header and excessive xff chain", () => {
    const flags1 = _test.checkCloudflareSpoofFlags({
        cfConnectingIp: "1.1.1.1",
        xForwardedForChainLength: 4
    });
    assert.ok(flags1.includes("cf_header_without_trust"));
    assert.ok(flags1.includes("xff_chain_too_long"));

    const flags2 = _test.checkCloudflareSpoofFlags({
        cfConnectingIp: null,
        xForwardedForChainLength: 2
    });
    assert.deepEqual(flags2, []);
});

test("checkNamedHeaderSpoofFlags detects invalid IPs and private IP leaks", () => {
    const named = [
        ["x-real-ip", "invalid_ip"],
        ["x-client-ip", "192.168.1.1"],
        ["true-client-ip", "8.8.8.8"]
    ];
    const flags = _test.checkNamedHeaderSpoofFlags(named, "8.8.8.8");
    assert.ok(flags.includes("x-real-ip_invalid"));
    assert.ok(flags.includes("x-client-ip_private_ip"));
    assert.ok(!flags.includes("true-client-ip_invalid"));
    assert.ok(!flags.includes("true-client-ip_private_ip"));
});

test("checkXffChainSpoofFlags identifies invalid and private chain entries", () => {
    const chain = ["not.an.ip", "10.0.0.1", "1.1.1.1"];
    const flags = _test.checkXffChainSpoofFlags(chain, "1.1.1.1");
    assert.ok(flags.includes("xff_chain_invalid_ip"));
    assert.ok(flags.includes("xff_chain_private_ip"));
});

test("checkHeaderConflicts detects conflicts between trusted and header IPs", () => {
    const headerIps = {
        xRealIp: "1.2.3.4",
        xClientIp: "5.6.7.8"
    };
    const namedHeaders = [
        ["x-real-ip", "1.2.3.4"],
        ["x-client-ip", "5.6.7.8"]
    ];
    const { conflictFlags, headerIpConflict } = _test.checkHeaderConflicts(headerIps, namedHeaders, "9.9.9.9");
    assert.ok(headerIpConflict);
    assert.ok(conflictFlags.includes("xRealIp_conflicts_with_trusted_ip"));
    assert.ok(conflictFlags.includes("xClientIp_conflicts_with_trusted_ip"));
    assert.ok(conflictFlags.includes("header_ip_conflict"));
});

test("detectSpoofedHeaders integrates all spoof checks", () => {
    const req = {
        headers: {
            "x-forwarded-for": "10.0.0.1, 10.0.0.2, 10.0.0.3, 10.0.0.4",
            "x-real-ip": "1.2.3.4"
        },
        socket: { remoteAddress: "8.8.8.8" }
    };
    const result = _test.detectSpoofedHeaders(req, "8.8.8.8");
    assert.equal(typeof result, "object");
    assert.ok(result.spoofSuspected);
    assert.ok(Array.isArray(result.spoofFlags));
});

test("parseOS correctly classifies various user agent and platform combinations", () => {
    assert.equal(_test.parseOS("Mozilla/5.0 (Android 14; Mobile)", ""), "Android");
    assert.equal(_test.parseOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", ""), "iOS");
    assert.equal(_test.parseOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)", ""), "Windows");
    assert.equal(_test.parseOS("Mozilla/5.0 (X11; CrOS x86_64)", ""), "Chrome OS");
    assert.equal(_test.parseOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", ""), "macOS");
    assert.equal(_test.parseOS("UnknownBrowser/1.0", "Linux armv8l"), "Linux");
    assert.equal(_test.parseOS("UnknownBrowser/1.0", "Win32"), "Windows");
    assert.equal(_test.parseOS("Mozilla/5.0 (X11; Linux x86_64)", ""), "Linux");
    assert.equal(_test.parseOS("UnknownBrowser/1.0", ""), "Unknown");
});
