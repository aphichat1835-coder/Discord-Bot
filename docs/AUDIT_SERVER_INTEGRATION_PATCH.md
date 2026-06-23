# Audit Server Integration Patch

This patch is intentionally documented separately because `discord/index/server.js` contains sensitive legacy dashboard routes. Apply it only after reviewing that no auth, rate limit, CSRF, reveal-token, session, or Shadow Portal logic is removed.

## Import

Add near the other `discord/index` imports:

```js
const { registerAuditWebBundle } = require("./auditWebBundle");
```

## Mount point

Inside `registerRoutes`, after these lines exist:

```js
const checkAuth      = makeCheckAuth(API_SECRET);
const checkRevealPin = makeCheckRevealPin(getWebPin);
const rateLimiter    = createRateLimiter(requestCounts, config, sessionManager);
```

Add:

```js
registerAuditWebBundle({ app, express, sessionManager, client, auditLogger, checkAuth });
```

## Routes this enables

- `GET /audit-logs`
- `GET /api/audit/logs`
- `GET /api/audit/export`
- `GET /api/audit/health`
- `GET /api/audit/dead-letters`
- `GET /api/audit/settings`
- `POST /api/audit/settings`

## Safety notes

- Do not move or remove `/api` middleware.
- Do not remove `rateLimiter`.
- Do not remove `checkAuth`.
- Do not remove `auth.requireCsrf`.
- Do not touch reveal-token routes while applying this patch.
- Keep audit routes behind dashboard auth.

## Verify after patch

1. `npm test` in `discord/`.
2. Dashboard opens normally.
3. `/audit-logs` redirects/blocks when unauthenticated.
4. `/api/audit/logs` requires dashboard auth.
5. `/api/audit/dead-letters` requires dashboard auth.
6. Existing `/api/status`, `/api/session/:id`, and settings routes still work.
