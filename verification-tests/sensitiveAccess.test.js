"use strict";

const {
  redactSensitiveDiscordSnapshot,
  redactSensitiveIpInfo
} = require("../discord/verification/utils/sensitiveAccess");

describe("sensitive value redaction", () => {
  test("redacts private fields outside the Owner detail route", () => {
    expect(redactSensitiveIpInfo({ rawIp: "203.0.113.10", ip: "203.0.113.10", country: "TH" }, false))
      .toEqual({ rawIp: null, ip: null, country: "TH" });
    expect(redactSensitiveDiscordSnapshot({
      email: "user@example.test",
      connections: [{ id: "1" }],
      guilds: [{ id: "2" }],
      username: "tester"
    }, false)).toEqual({
      email: null,
      connections: [],
      guilds: [],
      username: "tester"
    });
  });

  test("returns complete values for the authenticated Owner route", () => {
    const discord = { email: "owner@example.test", connections: [{ id: "1" }], guilds: [{ id: "2" }] };
    const ip = { rawIp: "203.0.113.10", ip: "203.0.113.10" };
    expect(redactSensitiveDiscordSnapshot(discord, true)).toBe(discord);
    expect(redactSensitiveIpInfo(ip, true)).toBe(ip);
  });
});
