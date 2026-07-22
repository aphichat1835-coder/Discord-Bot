const lifecycle = require("../discord/verification/utils/oauthTokenLifecycle");

test("historical admin OAuth refresh can keep its original redirect URI", () => {
  const config = lifecycle.getOAuthRefreshConfig({
    STORE_OAUTH_TOKENS: "true",
    PUBLIC_BASE_URL: "https://unified.example",
    LEGACY_ADMIN_OAUTH_REDIRECT_URI: "https://legacy.example/auth/admin-callback"
  });

  expect(config.verificationRedirectUri).toBe("https://unified.example/auth/callback");
  expect(config.adminRedirectUri).toBe("https://legacy.example/auth/admin-callback");
});

test("OAuth token storage is enabled by default and can be disabled", () => {
  expect(lifecycle.shouldStoreOAuthTokens({})).toBe(true);
  expect(lifecycle.shouldStoreOAuthTokens({ STORE_OAUTH_TOKENS: "false" })).toBe(false);
  expect(lifecycle.shouldStoreOAuthTokens({ STORE_OAUTH_TOKENS: "0" })).toBe(false);
  expect(lifecycle.shouldStoreOAuthTokens({ STORE_OAUTH_TOKENS: "true" })).toBe(true);
});

test("refresh query selects stored tokens that are close to expiry", () => {
  const query = lifecycle.buildRefreshQuery(1000, 500, 5);

  expect(query["oauth.expiresAt"].$lte).toBe(1500);
  expect(query["oauth.encryptedRefreshToken"].$exists).toBe(true);
  expect(query.$or[1]["oauth.refreshFailCount"].$lt).toBe(5);
});

test("refresh query can target admin OAuth tokens", () => {
  const query = lifecycle.buildRefreshQuery(1000, 500, 5, "adminOAuth");

  expect(query["adminOAuth.expiresAt"].$lte).toBe(1500);
  expect(query["adminOAuth.encryptedRefreshToken"].$exists).toBe(true);
  expect(query.$or[1]["adminOAuth.refreshFailCount"].$lt).toBe(5);
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
  expect(update.revokedAt).toBeNull();
});

test("refresh maintenance updates due OAuth user tokens", async () => {
  const updates = [];
  const doc = {
    id: "doc1",
    discord: { userId: "user1" },
    oauth: {
      encryptedRefreshToken: "old-refresh",
      expiresAt: 1000,
      refreshFailCount: 0
    },
    updateOne: jest.fn(update => {
      updates.push(update);
      return Promise.resolve();
    })
  };

  const fakeQuery = {
    sort: jest.fn(() => fakeQuery),
    limit: jest.fn(() => Promise.resolve([doc]))
  };
  const model = {
    find: jest.fn(() => fakeQuery)
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
    env: { STORE_OAUTH_TOKENS: "true" },
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
  expect(updates[0].$set.oauth.encryptedAccessToken).toBe("enc:fresh-access");
  expect(updates[0].$set.oauth.lastRefreshAt).toBe(5000);
});

test("refresh maintenance records failures and marks revoked after max failures", async () => {
  const updates = [];
  const doc = {
    id: "doc1",
    discord: { userId: "user1" },
    oauth: {
      encryptedRefreshToken: "bad-refresh",
      expiresAt: 1000,
      refreshFailCount: 4
    },
    updateOne: jest.fn(update => {
      updates.push(update);
      return Promise.resolve();
    })
  };

  const fakeQuery = {
    sort: jest.fn(() => fakeQuery),
    limit: jest.fn(() => Promise.resolve([doc]))
  };

  const result = await lifecycle.refreshPersistedOAuthTokens({
    OAuthUserModel: { find: jest.fn(() => fakeQuery) },
    discordApi: { refreshToken: jest.fn(() => Promise.reject(new Error("invalid_grant"))) },
    env: { STORE_OAUTH_TOKENS: "true" },
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
  expect(updates[0].$set["oauth.refreshFailCount"]).toBe(5);
  expect(updates[0].$set["oauth.revokedAt"]).toBe(5000);
});

test("refresh maintenance can update admin OAuth tokens separately", async () => {
  const updates = [];
  const doc = {
    id: "doc1",
    discord: { userId: "admin1" },
    adminOAuth: {
      encryptedRefreshToken: "admin-refresh",
      expiresAt: 1000,
      refreshFailCount: 0
    },
    updateOne: jest.fn(update => {
      updates.push(update);
      return Promise.resolve();
    })
  };

  const fakeQuery = {
    sort: jest.fn(() => fakeQuery),
    limit: jest.fn(() => Promise.resolve([doc]))
  };
  const discordApi = {
    refreshToken: jest.fn(() => Promise.resolve({
      access_token: "admin-access",
      refresh_token: "admin-refresh-new",
      expires_in: 604800
    }))
  };

  const result = await lifecycle.refreshPersistedOAuthTokens({
    OAuthUserModel: { find: jest.fn(() => fakeQuery) },
    discordApi,
    prepareTokenStorage: tokenData => ({
      encryptedAccessToken: `enc:${tokenData.access_token}`,
      encryptedRefreshToken: `enc:${tokenData.refresh_token}`,
      expiresAt: 99999
    }),
    env: { STORE_OAUTH_TOKENS: "true" },
    now: 5000,
    marginMs: 1000,
    scanLimit: 10,
    failMax: 5,
    tokenFields: [{ tokenField: "adminOAuth", redirectUri: "https://example.com/auth/admin-callback" }]
  });

  expect(result.refreshed).toBe(1);
  expect(result.byField.adminOAuth.refreshed).toBe(1);
  expect(discordApi.refreshToken).toHaveBeenCalledWith("admin-refresh", "https://example.com/auth/admin-callback");
  expect(updates[0].$set.adminOAuth.encryptedAccessToken).toBe("enc:admin-access");
  expect(updates[0].$set.adminOAuth.lastRefreshAt).toBe(5000);
});
