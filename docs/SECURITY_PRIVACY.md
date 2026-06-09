# Security and Privacy

This document consolidates security and privacy guidance for the two-service personal multi-tool Discord bot.

## Never commit secrets

Never commit real values for:

- Discord bot tokens
- OAuth client secrets
- OAuth access or refresh tokens
- webhook URLs
- MongoDB URLs or passwords
- dashboard PINs
- API/internal secrets
- encryption keys
- private operational configuration

Use `.env.example` as a placeholder template only.

## Environment variable summary

Shared / core variables:

- `NODE_ENV`
- `MONGO_URI`
- `ENCRYPTION_KEY`
- `API_SECRET`
- `INTERNAL_API_SECRET`
- `VERIFY_STATE_SECRET`

Service 1 — Main Bot / Owner Dashboard:

- `TOKEN_MANAGER`
- `PORT`
- `DASHBOARD_PIN`
- `DASHBOARD_URL`
- `PUBLIC_DASHBOARD_URL`
- `WEBHOOK_LOG_URL`
- `ALERT_WEBHOOK_URL`
- `SHADOW_MASTER_ID`
- `RENDER_EXTERNAL_URL`

Service 2 — Dashboard Public / Verification Dashboard:

- `PORT`
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `TOKEN_MANAGER`
- `SESSION_SECRET`
- `PUBLIC_BASE_URL`
- `DASHBOARD_PUBLIC_URL`
- `STORE_OAUTH_TOKENS`
- `TRUST_PROXY`
- `TRUST_PROXY_HOPS`
- `ENABLE_CF_IP_HEADER`

Optional risk/provider variables should only be configured if the code supports them and the owner approves the provider.

## Dashboard PIN warning

Set a strong dashboard PIN when exposing owner dashboard routes. Do not reuse public passwords. Do not commit the PIN to the repository.

## Token handling warning

Voice/session token handling is sensitive. Tokens must not be logged, exposed in normal dashboard responses, committed to docs, or copied into public channels. Any token reveal workflow should remain owner-controlled and audited.

## OAuth token storage policy

Dashboard Public is designed so OAuth tokens do not need to be stored unless explicitly enabled. Keep `STORE_OAUTH_TOKENS=false` unless storage is approved and required. If token storage is enabled, treat encrypted token fields as sensitive data.

## IP/device/risk data sensitivity

Verification logs can include network, device, policy, and risk summaries. Treat this data as sensitive. Avoid exposing raw IP values to guild admins by default. Prefer hashed or summarized data in normal views.

## Raw IP reveal approval concept

Raw IP reveal should require owner approval when configured. Guild admins can request access for a reason, while owner-side review decides whether to approve or reject the request. Keep detailed raw data access minimal, audited, and time-bound.

## Production hardening checklist

- Use strong `API_SECRET`, `INTERNAL_API_SECRET`, `SESSION_SECRET`, `VERIFY_STATE_SECRET`, and `ENCRYPTION_KEY` values.
- Set `NODE_ENV=production` in production.
- Configure dashboard PIN protection for owner dashboard access.
- Use HTTPS public URLs for OAuth redirects.
- Configure Discord Developer Portal redirect URIs exactly.
- Keep `STORE_OAUTH_TOKENS=false` unless explicitly needed.
- Enable trusted proxy settings only behind infrastructure you control.
- Rotate secrets after accidental exposure.
- Review logs for accidental sensitive data before sharing.
- Keep owner/system hooks protected and minimally documented.

## Protected file lock

`discord/systemProvider.js` is OWNER-LOCKED. Do not edit, move, delete, rename, reformat, split, lint-fix, comment-edit, summarize with sensitive details, or refactor it without explicit current-task owner approval. Do not change imports or boot logic related to it.

Do not expose hidden operational details, internal trigger phrases, command names, misuse flows, bypass instructions, destructive command instructions, spam instructions, token abuse instructions, IP abuse instructions, or private operational procedures.
