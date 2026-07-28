"use strict";

const {
  authorizeUrl,
  createOAuthStartHandler
} = require("../discord/verification/routes/oauthStart");

const GUILD_ID = "111111111111111111";
const ROLE_ID = "222222222222222222";
const USER_ID = "333333333333333333";
const CLIENT_ID = "444444444444444444";

function responseFixture() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    redirectLocation: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    send(value) { this.body = value; return this; },
    redirect(status, location) {
      this.statusCode = status;
      this.redirectLocation = location;
      return this;
    }
  };
}

function guildQuery(value, error = null) {
  const query = {
    where: jest.fn(() => query),
    equals: jest.fn(() => query),
    lean: jest.fn(async () => {
      if (error) throw error;
      return value;
    })
  };
  return query;
}

function createHandler(overrides = {}) {
  const panelState = {
    guildId: GUILD_ID,
    roleId: ROLE_ID,
    expectedUserId: USER_ID,
    panelRevision: "revision-1"
  };
  const executionState = {
    ...panelState,
    nonce: "nonce-1",
    ts: 700000
  };
  return createOAuthStartHandler({
    GuildConfigModel: {
      findOne: jest.fn(() => guildQuery({
        verification: {
          enabled: true,
          roleId: ROLE_ID,
          panelRevision: "revision-1"
        }
      }))
    },
    decodeState: jest.fn(value => value === "panel-state" ? panelState : executionState),
    createState: jest.fn(() => "execution-state"),
    registerState: jest.fn(() => Promise.resolve(true)),
    normalizeConfig: jest.fn(value => value),
    now: () => 100000,
    env: {
      DISCORD_CLIENT_ID: CLIENT_ID,
      PUBLIC_BASE_URL: "https://preview.example.test"
    },
    logger: { error: jest.fn() },
    ...overrides
  });
}

test("OAuth start creates a short-lived state and redirects only to Discord", async () => {
  const createState = jest.fn(() => "execution-state");
  const registerState = jest.fn(() => Promise.resolve(true));
  const handler = createHandler({ createState, registerState });
  const res = responseFixture();

  await handler({ query: { state: "panel-state" } }, res);

  expect(res.statusCode).toBe(302);
  const redirect = new URL(res.redirectLocation);
  expect(redirect.origin).toBe("https://discord.com");
  expect(redirect.pathname).toBe("/oauth2/authorize");
  expect(redirect.searchParams.get("client_id")).toBe(CLIENT_ID);
  expect(redirect.searchParams.get("state")).toBe("execution-state");
  expect(redirect.searchParams.get("redirect_uri")).toBe("https://preview.example.test/auth/callback");
  expect(res.headers["Cache-Control"]).toBe("no-store");
  expect(createState).toHaveBeenCalledWith(expect.objectContaining({
    guildId: GUILD_ID,
    roleId: ROLE_ID,
    expectedUserId: USER_ID,
    panelRevision: "revision-1",
    expiresAt: 700000
  }));
  expect(registerState).toHaveBeenCalledTimes(1);
});

test("OAuth start rejects invalid, disabled, stale, and unregistered panel state", async () => {
  const cases = [
    {
      handler: createHandler({ decodeState: jest.fn(() => null) }),
      status: 400,
      text: /ไม่ถูกต้อง/
    },
    {
      handler: createHandler({
        normalizeConfig: jest.fn(() => ({ enabled: false, roleId: ROLE_ID }))
      }),
      status: 409,
      text: /ไม่พร้อม/
    },
    {
      handler: createHandler({
        normalizeConfig: jest.fn(() => ({ enabled: true, roleId: ROLE_ID, panelRevision: "revision-2" }))
      }),
      status: 409,
      text: /ถูกแทนที่/
    },
    {
      handler: createHandler({ registerState: jest.fn(() => Promise.resolve(false)) }),
      status: 503,
      text: /ไม่สามารถเริ่ม/
    }
  ];

  for (const item of cases) {
    const res = responseFixture();
    await item.handler({ query: { state: "panel-state" } }, res);
    expect(res.statusCode).toBe(item.status);
    expect(res.body).toMatch(item.text);
    expect(res.redirectLocation).toBeNull();
  }
});

test("OAuth start converts database and nonce errors into a controlled Thai response", async () => {
  const dbError = Object.assign(new Error("mongo password should not escape"), { code: "DB_DOWN" });
  const logger = { error: jest.fn() };
  const handler = createHandler({
    GuildConfigModel: { findOne: jest.fn(() => guildQuery(null, dbError)) },
    logger
  });
  const res = responseFixture();

  await handler({ query: { state: "panel-state" } }, res);

  expect(res.statusCode).toBe(503);
  expect(res.body).toMatch(/ลองใหม่/);
  expect(String(res.body)).not.toContain(dbError.message);
  expect(logger.error).toHaveBeenCalledWith(
    "[VERIFY] OAuth start failed:",
    { code: "DB_DOWN" }
  );
});

test("authorize URL builder cannot change the destination origin", () => {
  const url = new URL(authorizeUrl({
    clientId: CLIENT_ID,
    redirectUri: "https://preview.example.test/auth/callback",
    state: "https://attacker.invalid/redirect"
  }));
  expect(url.origin).toBe("https://discord.com");
  expect(url.searchParams.get("state")).toBe("https://attacker.invalid/redirect");
});