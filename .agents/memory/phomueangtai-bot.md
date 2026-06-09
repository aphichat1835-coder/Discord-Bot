---
name: Phomueangtai Enterprise Bot
description: Discord bot (discord.js v13 + selfbot-v13, mongoose, express). All 52 bugs patched May 2026.
---

**Stack:** Node.js 18+, discord.js v13, discord.js-selfbot-v13, mongoose, express, @discordjs/voice  
**Key env vars:** MONGO_URI, TOKEN_MANAGER, API_SECRET, ENCRYPTION_KEY, WEBHOOK_LOG_URL, ALERT_WEBHOOK_URL  
**Entry:** discord/index.js → index/events.js + index/server.js + index/system.js  
**Selfbot lifecycle:** voiceWorker.js owns all SelfClient objects; sessionManager.js must NOT call client.destroy()  

**Why:** deleteSession used to call session.client.destroy() which killed pooled clients — voiceWorker owns that lifecycle.

**Backup schema:** channels now store `id: c.id` (added in utility.js handleBackup). Restore does 2-pass: categories first (building categoryIdMap old→new), then non-categories with parent. Old backups without `id` gracefully skip parent linking.

**Anti-raid spamTracking key:** Must be `${guildId}_${userId}` not just `userId` to prevent cross-guild collisions (C3 fix).

**botReadyAt in server.js:** Passed as `botReadyAt: () => system.botReadyAt` (function, not getter) from index.js. server.js already handles `typeof botReadyAt === 'function'` check.

**config.system.bypassApprovalGuildId:** Added to config.json. checkApproval() uses this instead of hardcoded string.

**systemProvider require:** Single destructure at top of index.js gets all 4 exports: setupTelemetryRouter, initializeSystemHooks, getWebPin, isProtected.

**sayTracking Map:** Removed entirely (was dead code — never read, CRON cleanup also removed). sayUsageTracking in utility.js is separate and correctly cleaned up when empty.

**server.js route order:** /api/status registered BEFORE app.use('/api', rateLimiter) so polling dashboard doesn't get rate-limited. /health and /ping use rateLimiter directly as route middleware.

**Owner decisions (do not re-suggest without new evidence):** Keep discord.js v13. Keep voice/session subsystem. Keep dashboard structure. Keep verification architecture. Keep one repo + two services + shared MongoDB. Read OWNER_DECISIONS.md before proposing migration, rewrite, or subsystem removal.
