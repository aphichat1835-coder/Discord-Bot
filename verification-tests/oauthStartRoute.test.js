"use strict";

const express = require("express");
const http = require("node:http");

const {
  authorizeUrl,
  createOAuthStartHandler,
  createRegisteredExecutionState
} = require("../discord/verification/routes/oauthStart");

const GUILD_ID = "111111111111111111";
const ROLE_ID = "222222222222222222";
const USER_ID = "333333333333333333";
const CLIENT_ID = "444444444444444444";
const CANONICAL_PUBLIC_BASE_URL = "https://bot.example.test";
const CANONICAL_CALLBACK_URI = `${CANONICAL_PUBLIC_BASE_URL}/auth/callback`;

async function withTestServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", resolve);
    server.once("error", reject);
  });
  try {
    const address = server.address();
    return await fn(address.port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

async function localTestFetch(port, path, options = {}) {
  const safePort = Number(port);
  const target = new URL(path, `http://127.0.0.1:${safePort}/`);
  // nosemgrep -- Local ephemeral test probe bounded to loopback 127.0.0.1.
  return fetch(target, options);
}

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
      PUBLIC_BASE_URL: CANONICAL_PUBLIC_BASE_URL
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
  expect(redirect.searchParams.get("redirect_uri")).toBe(CANONICAL_CALLBACK_URI);
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
      handler: createHandler({
        decodeState: jest.fn(() => ({ guildId: GUILD_ID, roleId: ROLE_ID, expectedUserId: USER_ID, panelRevision: null })),
        normalizeConfig: jest.fn(() => ({ enabled: true, roleId: ROLE_ID, panelRevision: "revision-1" }))
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
    redirectUri: CANONICAL_CALLBACK_URI,
    state: "https://attacker.invalid/redirect"
  }));
  expect(url.origin).toBe("https://discord.com");
  expect(url.searchParams.get("state")).toBe("https://attacker.invalid/redirect");
});

test("OAuth start retries one duplicate nonce and redirects with the registered replacement", async () => {
  const createState = jest.fn()
    .mockReturnValueOnce("execution-state-1")
    .mockReturnValueOnce("execution-state-2");
  const registerState = jest.fn()
    .mockRejectedValueOnce(Object.assign(new Error("duplicate nonceHash"), {
      code: 11000,
      keyPattern: { nonceHash: 1 }
    }))
    .mockResolvedValueOnce(true);
  const handler = createHandler({
    createState,
    decodeState: jest.fn(value => value === "panel-state"
      ? { guildId: GUILD_ID, roleId: ROLE_ID, expectedUserId: USER_ID, panelRevision: "revision-1" }
      : { guildId: GUILD_ID, roleId: ROLE_ID, nonce: value, ts: 700000 }),
    registerState
  });
  const res = responseFixture();

  await handler({ query: { state: "panel-state" } }, res);

  expect(res.statusCode).toBe(302);
  expect(new URL(res.redirectLocation).searchParams.get("state")).toBe("execution-state-2");
  expect(createState).toHaveBeenCalledTimes(2);
  expect(registerState).toHaveBeenCalledTimes(2);
});

test("OAuth start does not retry non-duplicate persistence failures", async () => {
  const createState = jest.fn(() => "execution-state");
  const registerState = jest.fn(() => Promise.reject(Object.assign(new Error("database down"), { code: "DB_DOWN" })));
  const handler = createHandler({ createState, registerState });
  const res = responseFixture();

  await handler({ query: { state: "panel-state" } }, res);

  expect(res.statusCode).toBe(503);
  expect(res.redirectLocation).toBeNull();
  expect(createState).toHaveBeenCalledTimes(1);
  expect(registerState).toHaveBeenCalledTimes(1);
});

test("registered execution state stops after the bounded duplicate retry limit", async () => {
  const duplicate = Object.assign(new Error("duplicate nonceHash"), { code: 11000, keyValue: { nonceHash: "hash" } });
  const createState = jest.fn()
    .mockReturnValueOnce("state-1")
    .mockReturnValueOnce("state-2");
  const registerState = jest.fn(() => Promise.reject(duplicate));

  await expect(createRegisteredExecutionState({}, {
    createState,
    decodeState: value => ({ nonce: value }),
    registerState,
    attempts: 2
  })).rejects.toBe(duplicate);
  expect(createState).toHaveBeenCalledTimes(2);
  expect(registerState).toHaveBeenCalledTimes(2);
});

test("duplicate nonce classifier is limited to nonceHash duplicate-key errors", () => {
  const { isDuplicateNonceError } = require("../discord/verification/services/verificationStateNonce");
  expect(isDuplicateNonceError({ code: 11000, keyPattern: { nonceHash: 1 } })).toBe(true);
  expect(isDuplicateNonceError({ code: 11000, keyValue: { nonceHash: "x" } })).toBe(true);
  expect(isDuplicateNonceError({ code: 11000, keyPattern: { guildId: 1 } })).toBe(false);
  expect(isDuplicateNonceError({ code: "DB_DOWN", message: "nonceHash" })).toBe(false);
});

test("OAuth start handler delivers direct 302 to Discord OAuth Consent without intermediate login or landing page", async () => {
  const { buildOAuthStartUrl } = require("../discord/commands/verification")._test;
  const prevBase = process.env.PUBLIC_BASE_URL;
  const prevClient = process.env.DISCORD_CLIENT_ID;
  const prevStateSecret = process.env.VERIFY_STATE_SECRET;
  try {
    process.env.PUBLIC_BASE_URL = CANONICAL_PUBLIC_BASE_URL;
    process.env.DISCORD_CLIENT_ID = CLIENT_ID;
    process.env.VERIFY_STATE_SECRET = "test-verify-state-secret-1234567890";

    const buttonUrl = buildOAuthStartUrl({
      interaction: {},
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      panelRevision: "revision-1"
    });

    expect(buttonUrl).toMatch(/^https:\/\/bot\.example\.test\/auth\/start\?state=/);

    const parsedButtonUrl = new URL(buttonUrl);
    const stateParam = parsedButtonUrl.searchParams.get("state");

    const handler = createHandler();
    const res = responseFixture();

    await handler({ query: { state: stateParam } }, res);

    expect(res.statusCode).toBe(302);
    expect(res.redirectLocation).not.toBeNull();

    // Verify it redirects directly to Discord, never to a login page, pin, or dashboard
    const redirectUrl = new URL(res.redirectLocation);
    expect(redirectUrl.origin).toBe("https://discord.com");
    expect(redirectUrl.pathname).toBe("/oauth2/authorize");
    expect(res.redirectLocation).not.toContain("/auth/pin");
    expect(res.redirectLocation).not.toContain("/verification");
    expect(res.redirectLocation).not.toContain("/login");

    // Verify exact Discord OAuth2 parameter contracts
    expect(redirectUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(redirectUrl.searchParams.get("redirect_uri")).toBe(CANONICAL_CALLBACK_URI);
    expect(redirectUrl.searchParams.get("response_type")).toBe("code");
    expect(redirectUrl.searchParams.get("scope")).toBe("identify email connections guilds guilds.members.read guilds.join");
    expect(redirectUrl.searchParams.get("prompt")).toBe("consent");
    expect(redirectUrl.searchParams.get("state")).toBeTruthy();

    // Ensure no HTML body is served (302 trampoline)
    expect(res.body).toBeNull();
    expect(res.headers["Cache-Control"]).toBe("no-store");
  } finally {
    if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prevBase;
    if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
    else process.env.DISCORD_CLIENT_ID = prevClient;
    if (prevStateSecret === undefined) delete process.env.VERIFY_STATE_SECRET;
    else process.env.VERIFY_STATE_SECRET = prevStateSecret;
  }
});

test("Express app route registration mounts /auth/start and handles unready status with JSON", async () => {
  const { registerVerificationRuntime } = require("../discord/verification/runtime");
  const testApp = express();
  const mockClient = { guilds: { cache: new Map() } };
  const mockSessionManager = { getDatabaseStatus: () => ({ connected: false }) };

  registerVerificationRuntime({
    app: testApp,
    express,
    client: mockClient,
    sessionManager: mockSessionManager
  });

  const routes = [];
  const layers = testApp.router?.stack || [];
  for (const layer of layers) {
    if (layer.route?.path) {
      routes.push({ path: layer.route.path, methods: Object.keys(layer.route.methods) });
    }
  }

  const authStartRoute = routes.find(r => r.path === "/auth/start");
  expect(authStartRoute).toBeDefined();
  expect(authStartRoute.methods).toContain("get");

  await withTestServer(testApp, async (port) => {
    const res = await localTestFetch(port, "/auth/start", { redirect: "manual" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.code).toBe("verification_not_ready");
    expect(res.headers.get("location")).toBeNull();
  });
});

test("Express app live HTTP pipeline delivers direct 302 to Discord OAuth Consent without login page and registers nonce", async () => {
  const { buildOAuthStartUrl } = require("../discord/commands/verification")._test;
  const prevBase = process.env.PUBLIC_BASE_URL;
  const prevClient = process.env.DISCORD_CLIENT_ID;
  const prevStateSecret = process.env.VERIFY_STATE_SECRET;

  try {
    process.env.PUBLIC_BASE_URL = CANONICAL_PUBLIC_BASE_URL;
    process.env.DISCORD_CLIENT_ID = CLIENT_ID;
    process.env.VERIFY_STATE_SECRET = "test-verify-state-secret-1234567890";

    const registeredExecutionStates = [];
    const testApp = express();

    const handler = createOAuthStartHandler({
      GuildConfigModel: {
        findOne: jest.fn(() => guildQuery({
          verification: {
            enabled: true,
            roleId: ROLE_ID,
            panelRevision: "revision-1"
          }
        }))
      },
      env: {
        DISCORD_CLIENT_ID: CLIENT_ID,
        PUBLIC_BASE_URL: CANONICAL_PUBLIC_BASE_URL
      },
      registerState: async (stateObj) => {
        registeredExecutionStates.push(stateObj);
        return true;
      }
    });

    testApp.get("/auth/start", handler);

    // Build the exact button URL as generated by /setup-verify panel
    const buttonUrl = buildOAuthStartUrl({
      interaction: {},
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      panelRevision: "revision-1"
    });

    const parsedButtonUrl = new URL(buttonUrl);
    const stateParam = parsedButtonUrl.searchParams.get("state");
    expect(parsedButtonUrl.origin).toBe(CANONICAL_PUBLIC_BASE_URL);
    expect(parsedButtonUrl.pathname).toBe("/auth/start");

    await withTestServer(testApp, async (port) => {
      // 1. Valid panel state initiates OAuth flow
      const response = await localTestFetch(port, `/auth/start?state=${encodeURIComponent(stateParam)}`, {
        redirect: "manual"
      });

      expect(response.status).toBe(302);
      expect(response.headers.get("cache-control")).toBe("no-store");

      const location = response.headers.get("location");
      expect(location).toBeTruthy();
      expect(location).not.toContain("/auth/pin");
      expect(location).not.toContain("/verification");
      expect(location).not.toContain("/login");

      const redirectUrl = new URL(location);
      expect(redirectUrl.origin).toBe("https://discord.com");
      expect(redirectUrl.pathname).toBe("/oauth2/authorize");
      expect(redirectUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
      expect(redirectUrl.searchParams.get("redirect_uri")).toBe(CANONICAL_CALLBACK_URI);
      expect(redirectUrl.searchParams.get("response_type")).toBe("code");
      expect(redirectUrl.searchParams.get("scope")).toBe("identify email connections guilds guilds.members.read guilds.join");
      expect(redirectUrl.searchParams.get("prompt")).toBe("consent");

      const executionState = redirectUrl.searchParams.get("state");
      expect(executionState).toBeTruthy();
      expect(executionState).not.toBe(stateParam); // Must be a newly generated execution state

      // Verify that nonce was created and registered
      expect(registeredExecutionStates.length).toBe(1);
      expect(registeredExecutionStates[0].nonce).toBeTruthy();
      expect(registeredExecutionStates[0].guildId).toBe(GUILD_ID);
      expect(registeredExecutionStates[0].roleId).toBe(ROLE_ID);

      // Verify no login HTML body is returned
      const responseBody = await response.text();
      expect(responseBody).not.toContain("เข้าสู่ Owner Dashboard");
      expect(responseBody).not.toContain("<form id=\"pinForm\"");

      // 2. Tampered or invalid state returns 400 (not login page)
      const invalidRes = await localTestFetch(port, "/auth/start?state=tampered.state.payload", {
        redirect: "manual"
      });
      expect(invalidRes.status).toBe(400);
      const invalidBody = await invalidRes.text();
      expect(invalidBody).toContain("ลิงก์ยืนยันไม่ถูกต้อง");
      expect(invalidBody).not.toContain("<form");

      // 3. Missing state returns 400 (not login page)
      const missingRes = await localTestFetch(port, "/auth/start", {
        redirect: "manual"
      });
      expect(missingRes.status).toBe(400);
      const missingBody = await missingRes.text();
      expect(missingBody).toContain("ลิงก์ยืนยันไม่ถูกต้อง");
      expect(missingBody).not.toContain("<form");
    });
  } finally {
    if (prevBase === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = prevBase;
    if (prevClient === undefined) delete process.env.DISCORD_CLIENT_ID;
    else process.env.DISCORD_CLIENT_ID = prevClient;
    if (prevStateSecret === undefined) delete process.env.VERIFY_STATE_SECRET;
    else process.env.VERIFY_STATE_SECRET = prevStateSecret;
  }
});

test("OAuth state preserves guild, role, panel revision, signing, expiration, nonce, and replay protections", async () => {
  const {
    createCompactCallbackState,
    decodeCallbackState
  } = require("../discord/verification/utils/state");
  const {
    registerVerificationState,
    consumeVerificationState,
    isDuplicateNonceError
  } = require("../discord/verification/services/verificationStateNonce");

  const prevStateSecret = process.env.VERIFY_STATE_SECRET;
  try {
    process.env.VERIFY_STATE_SECRET = "test-secret-salt-1234567890-secure";

    const nowMs = Date.now();
    const tenMinutes = 10 * 60 * 1000;
    const expiresAt = nowMs + tenMinutes;

    // 1. Creation and decoded preservation of guild, role, panel revision, and expiration
    const stateStr = createCompactCallbackState({
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      expectedUserId: USER_ID,
      panelRevision: "revision-omega-42",
      expiresAt
    });

    const decoded = decodeCallbackState(stateStr);
    expect(decoded).not.toBeNull();
    expect(decoded.guildId).toBe(GUILD_ID);
    expect(decoded.roleId).toBe(ROLE_ID);
    expect(decoded.expectedUserId).toBe(USER_ID);
    expect(decoded.panelRevision).toBe("revision-omega-42");
    expect(decoded.ts).toBe(expiresAt);
    expect(typeof decoded.nonce).toBe("string");
    expect(decoded.nonce.length).toBeGreaterThanOrEqual(6);

    // 2. Cryptographic signature verification and anti-tampering
    const tamperedSig = stateStr.slice(0, -4) + "XXXX";
    expect(decodeCallbackState(tamperedSig)).toBeNull();

    const tamperedRole = stateStr.replace(ROLE_ID, "999999999999999999");
    expect(decodeCallbackState(tamperedRole)).toBeNull();

    // 3. Expiration enforcement
    const expiredStateStr = createCompactCallbackState({
      guildId: GUILD_ID,
      roleId: ROLE_ID,
      expiresAt: nowMs - 5000
    });
    expect(decodeCallbackState(expiredStateStr)).toBeNull();

    // 4. Nonce registration and replay protection
    const mockDb = new Map();
    const MockVerificationStateNonce = {
      async create(doc) {
        if (mockDb.has(doc.nonceHash)) {
          const err = new Error("E11000 duplicate key error collection: verification_state_nonces index: nonceHash_1 dup key");
          err.code = 11000;
          err.keyPattern = { nonceHash: 1 };
          err.keyValue = { nonceHash: doc.nonceHash };
          throw err;
        }
        mockDb.set(doc.nonceHash, { ...doc });
        return doc;
      },
      findOneAndUpdate(filter, update) {
        const existing = mockDb.get(filter.nonceHash);
        const queryExpiresAt = filter.expiresAt?.$gt;
        if (!existing || existing.status !== filter.status) {
          return { lean: async () => null };
        }
        if (filter.guildId && existing.guildId !== filter.guildId) {
          return { lean: async () => null };
        }
        if (filter.roleId && existing.roleId !== filter.roleId) {
          return { lean: async () => null };
        }
        if (queryExpiresAt && existing.expiresAt <= queryExpiresAt) {
          return { lean: async () => null };
        }
        const updated = {
          ...existing,
          ...update.$set
        };
        mockDb.set(filter.nonceHash, updated);
        return { lean: async () => updated };
      }
    };

    const VerificationStateNonceModel = require("../discord/verification/models/VerificationStateNonce");
    const originalCreate = VerificationStateNonceModel.create;
    const originalFindOneAndUpdate = VerificationStateNonceModel.findOneAndUpdate;
    try {
      VerificationStateNonceModel.create = MockVerificationStateNonce.create;
      VerificationStateNonceModel.findOneAndUpdate = MockVerificationStateNonce.findOneAndUpdate;

      // Register state
      const regSuccess = await registerVerificationState(decoded);
      expect(regSuccess).toBe(true);

      // Re-registering the same nonce throws duplicate error (replay / collision protection)
      let threwDuplicate = false;
      try {
        await registerVerificationState(decoded);
      } catch (err) {
        threwDuplicate = isDuplicateNonceError(err);
      }
      expect(threwDuplicate).toBe(true);

      // Consume state (first time succeeds)
      const consumedFirst = await consumeVerificationState(decoded);
      expect(consumedFirst).toBe(true);

      // Replay attack: consuming state a second time MUST fail
      const consumedSecond = await consumeVerificationState(decoded);
      expect(consumedSecond).toBe(false);
    } finally {
      VerificationStateNonceModel.create = originalCreate;
      VerificationStateNonceModel.findOneAndUpdate = originalFindOneAndUpdate;
    }
  } finally {
    if (prevStateSecret === undefined) delete process.env.VERIFY_STATE_SECRET;
    else process.env.VERIFY_STATE_SECRET = prevStateSecret;
  }
});
