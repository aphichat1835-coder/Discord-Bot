# Deployment

This document summarizes deployment information for both services without changing runtime behavior.

## Node.js version

Both services require Node.js 18 or newer.

```txt
Node.js: >=18.0.0
```

## Service 1 — Main Discord Bot / Owner Dashboard

```txt
Root directory: .
Entry: discord/index.js
Build command: npm install
Start command: npm start
Health check: /ping
```

Primary required env vars:

- `MONGO_URI`
- `TOKEN_MANAGER`
- `API_SECRET`
- `ENCRYPTION_KEY`

Common recommended env vars:

- `DASHBOARD_PIN`
- `DASHBOARD_URL`
- `PUBLIC_DASHBOARD_URL`
- `WEBHOOK_LOG_URL`
- `ALERT_WEBHOOK_URL`
- `INTERNAL_API_SECRET`
- `VERIFY_STATE_SECRET`

## Service 2 — Dashboard Public / Verification Dashboard

```txt
Root directory: dashboard-public
Entry: dashboard-public/index.js
Build command: npm install
Start command: npm start
Health check: /ping
```

Primary required env vars:

- `MONGO_URI`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `TOKEN_MANAGER`
- `ENCRYPTION_KEY`
- `SESSION_SECRET`

Common recommended env vars:

- `PUBLIC_BASE_URL`
- `DASHBOARD_PUBLIC_URL`
- `DASHBOARD_URL`
- `INTERNAL_API_SECRET`
- `VERIFY_STATE_SECRET`
- `STORE_OAUTH_TOKENS`
- `TRUST_PROXY`
- `TRUST_PROXY_HOPS`
- `ENABLE_CF_IP_HEADER`

## Render notes

`render.yaml` documents two Render web services:

- Service 1 at repository root
- Service 2 at `dashboard-public/`

The blueprint intentionally does not store secret environment values. Add required secrets manually in the Render Dashboard using `.env.example` as the reference.

Confirm service names before syncing a Render blueprint. If names do not match existing Render services, Render may create new services instead of updating existing ones.

## OAuth redirect URI notes

Configure Discord Developer Portal redirect URIs for Dashboard Public, for example:

```txt
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/callback
https://YOUR-DASHBOARD-PUBLIC-SERVICE.onrender.com/auth/admin-callback
```

The public base URL used by Service 2 must match the deployed Dashboard Public URL.

## Secret handling

Do not store secrets in `render.yaml`, markdown docs, screenshots, logs, or committed env files. Use Render environment variables or local untracked `.env` files.
