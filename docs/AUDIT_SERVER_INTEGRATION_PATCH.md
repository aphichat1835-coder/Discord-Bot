# Audit Server Integration

This integration is documented separately because `discord/index/server.js` contains sensitive legacy dashboard routes. Any future edits must preserve auth, rate limit, CSRF, reveal-token, session, and protected owner/system behavior.

## Current wiring

`discord/index/server.js` imports:

```js
const { registerAuditWebBundle } = require("./auditWebBundle");
```

Inside `registerRoutes`, Service 1 mounts:

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
- Keep `AUDIT_RECONCILER_ENABLED=false` while first mounting the web/API bundle.

## Verify after changes

1. `npm test`.
2. Dashboard opens normally.
3. `/audit-logs` redirects/blocks when unauthenticated.
4. `/api/audit/logs` requires dashboard auth.
5. `/api/audit/dead-letters` requires dashboard auth.
6. `/api/audit/settings` reads current settings.
7. Existing `/api/status`, `/api/session/:id`, and settings routes still work.
