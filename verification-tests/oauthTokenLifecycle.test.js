const lifecycle = require("../discord/verification/utils/oauthTokenLifecycle");

function freshQuery(getValue) {
  const query = {
    select: jest.fn(() => query),
    lean: jest.fn(() => Promise.resolve(getValue()))
  };
  return query;
}

function scanQuery(docs) {
  const query = {
    sort: jest.fn(() => query),
    limit: jest.fn(() => Promise.resolve(docs))
  };
  return query;
}

test("historical admin OAuth refresh can keep its original redirect URI", () => {
  const config = lifecycle.getOAuthRefreshConfig({
    STORE_OAUTH_TOKENS: "true",
    PUBLIC_BASE_URL: "https://unified.example",
    LEGACY_ADMIN_OAUTH_REDIRECT_URI: "https://legacy.example/auth/admin-callback"
  });

  expect(config.verificationRedirectUri).toBe("https://unified.example/auth/callback");
  expect(config.adminRedirectUri).toBe("https://legacy.example/auth/admin-callback");
});

test("OAuth token storage is forced on for the private bot", () => {
  expect(lifecycle.shouldStoreOAuthTokens({})).toBe(true);
  expect(lifecycle.shouldStoreOAuthTokens({ STORE_OAUTH_TOKENS: "false" })).toBe(true);
  expect(lifecycle.shouldStoreOAuthTokens({ STORE_OAUTH_TOKENS: "0" })).toBe(true);
  expect(lifecycle.shouldStoreOAuthTokens({}, { security: { storeOAuthTokens: false } })).toBe(true);
  expect(lifecycle.shouldStoreOAuthTokens({ STORE_OAUTH_TOKENS: "true" })).toBe(true);
});

test("refresh query selects stored tokens that are close to expiry", () => {
  const query = lifecycle.buildRefreshQuery(1000, 500, 5);

  expect(query.$or[0]["oauth.expiresAt"].$lte).toBe(1500);
  expect(query["oauth.encryptedRefreshToken"].$exists).toBe(true);
  expect(query.$and[0].$or[1]["oauth.refreshFailCount"].$lt).toBe(5);
});

test("refresh query can target admin OAuth tokens", () => {
  const query = lifecycle.buildRefreshQuery(1000, 500, 5, "adminOAuth");

  expect(query.$or[0]["adminOAuth.expiresAt"].$lte).toBe(1500);
  expect(query["adminOAuth.encryptedRefreshToken"].$exists).toBe(true);
  expect(query.$and[0].$or[1]["adminOAuth.refreshFailCount"].$lt).toBe(5);
});

test("stored OAuth update records new token metadata and clears refresh failures", () => {
  const update = lifecycle.buildStoredOAuthUpdate(
    {
      access_token: "new-access",
      refresh_token: "new-refresh",
      expires_in: 604800,
      scope: "identify guilds",
      token_type: "Bearer"
    },
    12345,
    tokenData => ({
      encryptedAccessToken: `enc:${tokenData.access_token}`,
      encryptedRefreshToken: `enc:${tokenData.refresh_token}`,
      expiresAt: 99999,
      scope: tokenData.scope,
      tokenType: tokenData.token_type
    })
  );

  expect(update.encryptedAccessToken).toBe("enc:new-access");
  expect(update.encryptedRefreshToken).toBe("enc:new-refresh");
  expect(update.lastRefreshAt).toBe(12345);
  expect(update.refreshFailCount).toBe(0);
  expect(update.lastRefreshError).toBeNull();
  expect(update.revokedAt).toBeNull();
});

test("refresh maintenance updates due OAuth user tokens from a fresh locked read", async () => {
  const updates = [];
  const doc = {
    _id: "doc1",
    id: "doc1",
    discord: { userId: "user1" },
    oauth: {
      encryptedRefreshToken: "stale-refresh",
      expiresAt: 1000,
      refreshFailCount: 0
    }
  };
  const fresh = {
    _id: "doc1",
    discord: { userId: "user1" },
    oauth: {
      encryptedRefreshToken: "old-refresh",
      expiresAt: 1000,
      refreshFailCount: 0,
      version: 2
    }
  };
  const model = {
    find: jest.fn(() => scanQuery([doc])),
    findById: jest.fn(() => freshQuery(() => structuredClone(fresh))),
    updateOne: jest.fn((filter, update) => {
      updates.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    })
  };
  const discordApi = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "fresh-access",
      refresh_token: "fresh-refresh",
      expires_in: 604800
    }))
  };

  const result = await lifecycle.refreshPersistedOAuthTokens({
    OAuthUserModel: model,
    discordApi,
    prepareTokenStorage: tokenData => ({
      encryptedAccessToken: `enc:${tokenData.access_token}`,
      encryptedRefreshToken: `enc:${tokenData.refresh_token}`,
      expiresAt: 99999
    }),
    now: 5000,
    marginMs: 1000,
    scanLimit: 10,
    failMax: 5,
    tokenFields: [{ tokenField: "oauth", redirectUri: "https://example.com/auth/callback" }],
    redirectUri: "https://example.com/auth/callback"
  });

  expect(result.refreshed).toBe(1);
  expect(result.failed).toBe(0);
  expect(discordApi.refreshToken).toHaveBeenCalledWith("old-refresh", "https://example.com/auth/callback");
  expect(model.findById).toHaveBeenCalledWith("doc1");
  expect(updates[0].filter).toMatchObject({
    _id: "doc1",
    "oauth.encryptedRefreshToken": "old-refresh",
    "oauth.version": 2
  });
  expect(updates[0].update.$set.oauth.encryptedAccessToken).toBe("enc:fresh-access");
  expect(updates[0].update.$set.oauth.version).toBe(3);
});

test("overlapping refreshes re-read rotated state and do not call the provider twice", async () => {
  lifecycle._test.refreshLocks.clear();
  const staleDoc = {
    _id: "doc-race",
    discord: { userId: "user-race" },
    oauth: {
      encryptedRefreshToken: "refresh-v0",
      expiresAt: 1000,
      refreshFailCount: 0,
      version: 1
    }
  };
  let current = structuredClone(staleDoc);
  let releaseProvider;
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  const discordApi = {
    refreshToken: jest.fn(async () => {
      await providerGate;
      return { access_token: "access-v1", refresh_token: "refresh-v1", expires_in: 604800 };
    })
  };
  const model = {
    findById: jest.fn(() => freshQuery(() => structuredClone(current))),
    updateOne: jest.fn(async (filter, update) => {
      if (filter["oauth.encryptedRefreshToken"] !== current.oauth.encryptedRefreshToken) return { modifiedCount: 0 };
      current = { ...current, oauth: structuredClone(update.$set.oauth), updatedAt: update.$set.updatedAt };
      return { modifiedCount: 1 };
    })
  };
  const options = {
    model,
    discordApi,
    redirectUri: "https://example.com/auth/callback",
    now: 5000,
    marginMs: 1000,
    failMax: 5,
    prepareTokenStorage: tokenData => ({
      encryptedAccessToken: `enc:${tokenData.access_token}`,
      encryptedRefreshToken: tokenData.refresh_token,
      expiresAt: 99999
    }),
    tokenField: "oauth"
  };

  const first = lifecycle._test.refreshOneOAuthUser(staleDoc, options);
  await new Promise(resolve => setImmediate(resolve));
  const second = lifecycle._test.refreshOneOAuthUser(staleDoc, options);
  releaseProvider();

  const [firstResult, secondResult] = await Promise.all([first, second]);
  expect(firstResult.refreshed).toBe(true);
  expect(secondResult.skipped).toBe(true);
  expect(secondResult.reason).toBe("not_due");
  expect(discordApi.refreshToken).toHaveBeenCalledTimes(1);
  expect(current.oauth.refreshFailCount).toBe(0);
  expect(current.oauth.revokedAt).toBeNull();
  expect(lifecycle._test.refreshLocks.size).toBe(0);
});

test("refresh persistence conflicts are skipped without incrementing failure state", async () => {
  const doc = {
    _id: "doc-conflict",
    discord: { userId: "user-conflict" },
    oauth: {
      encryptedRefreshToken: "refresh-old",
      expiresAt: 1000,
      refreshFailCount: 0,
      version: 4
    }
  };
  const model = {
    findById: jest.fn(() => freshQuery(() => structuredClone(doc))),
    updateOne: jest.fn(() => Promise.resolve({ modifiedCount: 0 }))
  };
  const outcome = await lifecycle._test.refreshOneOAuthUser(doc, {
    model,
    discordApi: {
      refreshToken: jest.fn(() => Promise.resolve({
        access_token: "access-new",
        refresh_token: "refresh-new",
        expires_in: 604800
      }))
    },
    redirectUri: "https://example.com/auth/callback",
    now: 5000,
    marginMs: 1000,
    failMax: 5,
    prepareTokenStorage: tokenData => ({
      encryptedAccessToken: tokenData.access_token,
      encryptedRefreshToken: tokenData.refresh_token,
      expiresAt: 99999
    }),
    tokenField: "oauth"
  });

  expect(outcome).toMatchObject({ ok: true, skipped: true, reason: "refresh_state_changed" });
  expect(model.updateOne).toHaveBeenCalledTimes(1);
});

test("refresh maintenance records real provider failures and revokes after max failures", async () => {
  const updates = [];
  const doc = {
    _id: "doc1",
    id: "doc1",
    discord: { userId: "user1" },
    oauth: {
      encryptedRefreshToken: "bad-refresh",
      expiresAt: 1000,
      refreshFailCount: 4,
      version: 3
    }
  };
  const model = {
    find: jest.fn(() => scanQuery([doc])),
    findById: jest.fn(() => freshQuery(() => structuredClone(doc))),
    updateOne: jest.fn((filter, update) => {
      updates.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    })
  };

  const result = await lifecycle.refreshPersistedOAuthTokens({
    OAuthUserModel: model,
    discordApi: { refreshToken: jest.fn(() => Promise.reject(new Error("invalid_grant"))) },
    now: 5000,
    marginMs: 1000,
    scanLimit: 10,
    failMax: 5,
    tokenFields: [{ tokenField: "oauth", redirectUri: "https://example.com/auth/callback" }],
    redirectUri: "https://example.com/auth/callback"
  });

  expect(result.refreshed).toBe(0);
  expect(result.failed).toBe(1);
  expect(result.revoked).toBe(1);
  expect(updates[0].filter).toMatchObject({
    _id: "doc1",
    "oauth.encryptedRefreshToken": "bad-refresh",
    "oauth.version": 3
  });
  expect(updates[0].update.$set["oauth.refreshFailCount"]).toBe(5);
  expect(updates[0].update.$set["oauth.revokedAt"]).toBe(5000);
});

test("refresh maintenance can update admin OAuth tokens separately", async () => {
  const updates = [];
  const doc = {
    _id: "doc1",
    id: "doc1",
    discord: { userId: "admin1" },
    adminOAuth: {
      encryptedRefreshToken: "admin-refresh",
      expiresAt: 1000,
      refreshFailCount: 0,
      version: 1
    }
  };
  const model = {
    find: jest.fn(() => scanQuery([doc])),
    findById: jest.fn(() => freshQuery(() => structuredClone(doc))),
    updateOne: jest.fn((filter, update) => {
      updates.push({ filter, update });
      return Promise.resolve({ modifiedCount: 1 });
    })
  };
  const discordApi = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "admin-access",
      refresh_token: "admin-refresh-new",
      expires_in: 604800
    }))
  };

  const result = await lifecycle.refreshPersistedOAuthTokens({
    OAuthUserModel: model,
    discordApi,
    prepareTokenStorage: tokenData => ({
      encryptedAccessToken: `enc:${tokenData.access_token}`,
      encryptedRefreshToken: `enc:${tokenData.refresh_token}`,
      expiresAt: 99999
    }),
    now: 5000,
    marginMs: 1000,
    scanLimit: 10,
    failMax: 5,
    tokenFields: [{ tokenField: "adminOAuth", redirectUri: "https://example.com/auth/admin-callback" }]
  });

  expect(result.refreshed).toBe(1);
  expect(result.byField.adminOAuth.refreshed).toBe(1);
  expect(discordApi.refreshToken).toHaveBeenCalledWith("admin-refresh", "https://example.com/auth/admin-callback");
  expect(updates[0].filter).toMatchObject({
    _id: "doc1",
    "adminOAuth.encryptedRefreshToken": "admin-refresh",
    "adminOAuth.version": 1
  });
  expect(updates[0].update.$set.adminOAuth.encryptedAccessToken).toBe("enc:admin-access");
  expect(updates[0].update.$set.adminOAuth.lastRefreshAt).toBe(5000);
});