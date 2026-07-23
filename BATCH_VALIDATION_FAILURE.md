# Batch validation failed

- Run ID: 30028472503
- Staging SHA: 158e9e7e59c54de7ed5e779fe173738a1d6d2fa3

```text
npm notice run phomueangtai-enterprise@5.0.0 test:coverage:discord
npm notice run mkdir -p coverage && find discord/tests -name '*.test.js' ! -name 'voice*.test.js' -print0 | xargs -0 -r node --test --experimental-test-coverage --test-reporter=spec --test-reporter=lcov --test-reporter-destination=stdout --test-reporter-destination=coverage/discord.lcov
✔ dashboard auth has no fallback secret (1.450838ms)
✔ production check trims NODE_ENV (0.184885ms)
✔ parseCookies skips malformed cookie encoding without throwing (1.701968ms)
✔ pin page escapes hidden next attribute (0.331073ms)
✔ csrf token is bound to a valid dashboard session token (1.339192ms)
✔ dashboard auth session duration is configurable and bounded (0.218075ms)
✔ dashboard auth can identify sessions that need rolling refresh (0.348471ms)
✔ snapshot chunker preserves every item while bounding each chunk (3.752653ms)
✔ restore schema rejects malformed snowflakes and accepts serialized guild data (1.092776ms)
✔ restore private-delivery failure builds a structured operational event (0.619123ms)
✔ restore planning maps numeric category parents before matching child channels (0.957277ms)
✔ snapshot loader keeps legacy compatibility and rejects incomplete chunk pointers (0.549423ms)
✔ snapshot history schema keeps one additive active pointer without deleting versions (1.068788ms)
✔ restore snapshot identity binds payload, metadata, and preview target guild (0.477947ms)
✔ backup sorting does not mutate live Discord manager cache order (0.307533ms)
✔ backup webhook events contain bounded operational metadata (8.270096ms)
✔ mocked boot preserves HTTP Mongo verification settings Discord order (3.368824ms)
✔ optional boot failures stay degraded and Discord still starts (2.022279ms)
✔ shutdown aborts before Discord login (0.460661ms)
✔ Discord login failure leaves boot degraded without aborting (0.475233ms)
✔ clear bulk-deletes recent messages and individually deletes old messages (3.439035ms)
✔ clear falls back to sequential deletion when bulk deletion fails (0.662374ms)
✔ clear reports individual failures without stopping later deletions (0.495591ms)
✔ hasPermission supports all and any matching modes (4.869581ms)
✔ safeReply chooses reply, followUp, or editReply from interaction state (1.597737ms)
✔ safeDefer does not defer already handled interactions (1.879673ms)
✔ member and bot permission guards reply on missing permissions (0.500946ms)
✔ checkRoleHierarchy rejects protected targets and allows lower targets (0.628512ms)
✔ sanitizeUserMessage neutralizes mentions and blocks risky links (0.536829ms)
✔ voice panel control matcher uses shared custom IDs and prefixes (0.391739ms)
✔ command registration retries without blocking after a transient failure (5.783759ms)
✔ command registration returns a degraded result after bounded retries (0.452795ms)
✔ command registration replaces Discord global commands with the current 15-command registry (0.285009ms)
✔ accepted command marker is explicit and leaves rejected interactions untouched (0.229165ms)
✔ serverinfo shares one in-flight member fetch per guild (0.751632ms)
✔ voice panel update reports persistence failure (3.840694ms)
✔ voice panel rejects a second create while the guild operation is active (0.838283ms)
✔ panel rollback keeps tracking the replacement when Discord cleanup fails (0.527928ms)
✔ panel rollback restores the previous panel only after cleanup succeeds (0.421279ms)
✔ command router delegates registered command groups without changing handlers (0.19897ms)
✔ latest setting prefix rejects values that could alter a Mongo query (0.905843ms)
✔ serverinfo skips full member fetch for large guilds with incomplete cache (0.442699ms)
✔ serverinfo bounds member fetch time and falls back to cache on timeout (0.461934ms)
✔ command toggle keeps runtime state unchanged when persistence fails (2.705909ms)
✔ command toggle applies the new runtime state only after persistence succeeds (0.369318ms)
✔ command toggle route reports unavailable storage without cooldown or audit side effects (1.282168ms)
[SHADOW] 🌐 Shadow web portal registered.
[SHADOW] ❌ Shadow web portal registration failed: mount failed
✔ validateRequiredEnv trims required values and rejects whitespace-only secrets (3.479957ms)
✔ validateRequiredEnv rejects weak production secrets (0.579883ms)
✔ validateRequiredEnv accepts any non-empty owner dashboard PIN (0.334907ms)
✔ validateRequiredEnv requires OAuth client id and https public URL in production (0.639458ms)
✔ production deployment contract has exactly thirteen owner-maintained values (1.471656ms)
✔ createHttpApp only trusts proxies when explicitly configured (0.547849ms)
✔ feature flags default on and can be disabled by env (0.599268ms)
✔ safe loggers redact IPv6 and MongoDB connection strings (7.970853ms)
✔ Shadow web portal mounts on the shared Express app (2.144499ms)
✔ missing Shadow web hook leaves the shared runtime available (0.312998ms)
✔ failed Shadow web portal mount is reported without stopping the shared runtime (0.434056ms)
✔ owner diagnostics report the runtime token variable (0.278129ms)
[WARN] dashboard_request_blocked {"path":"/write","ip":"[REDACTED_IP]","reason":"rate limit exceeded"}
[WEBHOOK] LOG delivery unavailable (missing); inspect Owner diagnostics for counters.
[WARN] dashboard_auth_rejected {"path":"/api","ip":"test-client-a"}
[ERROR] dashboard_api_secret_missing {"path":"/api"}
[WARN] dashboard_request_blocked {"path":"/api/reveal-token","ip":"test-client-b","reason":"token reveal PIN locked"}
[WEBHOOK] ALERT delivery unavailable (missing); inspect Owner diagnostics for counters.
✔ sensitive secret comparison is constant-time and type-strict (1.74038ms)
✔ dashboard intrusion text cannot break Discord formatting (0.582623ms)
✔ dashboard security logs keep the mounted API path and omit query data (0.272914ms)
✔ dashboard read APIs do not bypass owner auth (0.251678ms)
✔ rate limiter blocks after configured request count (15.508913ms)
✔ rate limiter buckets expire stale entries and stay capped (31.594193ms)
✔ checkAuth accepts exact secret and rejects mismatches (1.623947ms)
✔ checkAuth fails closed when API_SECRET is not configured (0.770879ms)
✔ reveal PIN guard locks after repeated failures and can clean expired attempts (3.195798ms)
✔ reveal PIN attempts expire stale unlocked records and stay capped (1.40577ms)
✔ dashboard reports process RSS separately from V8 heap (2.171717ms)
✔ dashboard hides terminal Voice sessions from active cards (1.713094ms)
✔ session detail consumes the current API response contract (0.886217ms)
✔ event permission helpers use Discord.js v14 permission flags (5.656903ms)
✔ event permission helpers fail closed when Discord state is unavailable (0.261611ms)
✔ Discord v14 compatibility preserves existing component and embed payloads (5.205117ms)
✔ Discord v14 compatibility maps legacy channel and activity identifiers (0.28755ms)
✔ shared DM design always includes the relevant profile and disables mentions (14.894193ms)
✔ shared DM design stays inside Discord embed limits (9.150036ms)
✔ DM outbox schema keeps unique event keys, finite states and automatic expiry (0.400973ms)
✔ voice important-only policy is materially different from all (0.377915ms)
✔ voice snapshot never invents an actually observed channel (1.712694ms)
✔ gateway 4014 is not diagnosed as an invalid token (0.358458ms)
✔ moderation DM states never claim success before Discord confirms it (2.908402ms)
✔ restore result DM is private-profiled Thai output (1.873927ms)
✔ DM delivery classifies closed DMs as permanent without retrying forever (1.490837ms)
✔ DM delivery queues transient failures and suppresses the same event twice (0.543132ms)
✔ gateway diagnostics attach once and handle websocket lifecycle errors locally (9.567251ms)
✔ decodeTokenOwnerIdSafe extracts a canonical Discord user ID (2.251415ms)
✔ custom ID helpers preserve the routing parser contract (0.389808ms)
✔ buildVoiceStatusControls uses shared custom ID prefixes (4.563271ms)
✔ serializeVoiceSession redacts tokens and serializes timestamps as epoch milliseconds (0.93155ms)
✔ session serializer helpers handle labels, timestamps, and token fallback (0.332175ms)
✔ view helpers escape HTML and create a consistent shell (0.651885ms)
✔ view styles remain available through the split style module and views compatibility export (0.264555ms)
✔ serverinfo groups current Discord data into readable Thai sections (51.216745ms)
✔ information commands use distinct truthful loading embeds before the final result (3.648119ms)
✔ userinfo resolves the selected user instead of silently falling back to the caller (0.423745ms)
✔ userinfo presents age as context rather than declaring a person high risk (1.91248ms)
✔ ping labels process RSS, V8 heap, CPU sample and session states precisely (1.694964ms)
✔ internal event filters accept supported fields and time bounds (1.85361ms)
✔ internal event filters reject unknown fields and malformed time bounds (0.321244ms)
✔ internal event rollover deletes evicted records and keeps the index bounded (44.517453ms)
✔ internal event eviction retries a transient delete failure (29.198699ms)
✔ internal event save removes the new record when index persistence fails (0.883709ms)
✔ internal event index failure restores a previous record with the same id (0.598654ms)
✔ internal event save aborts before writing when a strict read fails (3.065671ms)
✔ general settings loader excludes internal event namespaces before applying its limit (307.671148ms)
✔ join campaign candidate summary uses only tokens with guilds.join (2.682526ms)
✔ join campaign refreshes expiring token before adding member (7.326042ms)
✔ Thai join campaign log summarizes counts without raw tokens (0.701102ms)
✔ join campaign route helpers list and resolve allowed target guilds (0.676488ms)
✔ startJoinCampaign rejects disabled config before creating an active job (0.897342ms)
✔ join campaign allows every bot guild when allowlist is empty (0.753312ms)
✔ join campaign follows database cursor batches until every OAuth user is scanned (1.2485ms)
✔ join campaign has no Sync Roles UI or route surface (4.969179ms)
✔ join campaign confirmation stays bound to the guild captured before dry-run (0.758044ms)
✔ parseEnvLine handles comments, quotes, and invalid keys (1.864712ms)
✔ loadEnvFile loads missing values without overriding existing env (0.276194ms)
✔ builds discord.js v14 client options with cache and default sweepers (21.249898ms)
✔ entrypoint uses the v14 client option boundary without stale v13 sweepers (0.648338ms)
✔ rejects non-finite cache and sweeper overrides (0.276876ms)
✔ memory monitor trend stays bounded and compact (5.683884ms)
✔ memory trend checker accepts stable diagnostics (3.0288ms)
✔ memory trend checker rejects unstable diagnostics (0.429888ms)
✔ createCase assigns increasing case numbers (10.405894ms)
✔ createCase fallback serializes concurrent counters and user indexes (3.594669ms)
✔ getCase and listUserCases work with settings fallback (1.589391ms)
✔ updateCaseReason amends existing case (0.703515ms)
✔ case fallback fails closed when a database write reports false (1.016515ms)
✔ updateCaseStatus persists pending workflow outcomes (0.897918ms)
✔ moderation helpers map required permissions (0.996545ms)
✔ moderation helpers parse timeout duration (0.20748ms)
✔ moderation helpers build case input (0.269833ms)
✔ moderation helpers avoid exposing raw exception messages (0.170065ms)
✔ voice kick result state distinguishes complete, partial, and failed (0.152958ms)
✔ voice kick processing skips administrators and counts disconnect failures (1.307215ms)
[WEBHOOK] ALERT delivery unavailable (missing); inspect Owner diagnostics for counters.
✔ moderation workflow exposes action handlers (1.493268ms)
✔ moderation workflow reads full timeout input (7.747195ms)
✔ moderation workflow validates missing target reply (0.282805ms)
✔ moderation workflow persists pending case before applying action (1.774078ms)
✔ moderation workflow does not apply action when pending persistence fails (0.850614ms)
✔ moderation workflow reports a successful action with pending reconciliation (5.102998ms)
✔ moderation workflow marks the pending case failed when Discord action fails (0.777788ms)
✔ ban DM starts pending and is confirmed only after Discord succeeds (6.268703ms)
✔ failed ban edits the pending DM to say the action had no effect (1.472814ms)
✔ Mongoose 9 AST scanner flags removed pre middleware next callbacks (16.476335ms)
✖ Mongoose 9 AST scanner ignores comments and quoted examples (1.811966ms)
✔ Mongoose 9 AST scanner resolves named callbacks (2.394557ms)
✔ Mongoose 9 AST scanner allows supported post middleware next signatures (0.903567ms)
✔ Mongoose 9 AST scanner flags callback doValidate and updateOne forms (2.205595ms)
✔ Mongoose 9 AST scanner allows Promise-based middleware and updates (0.826961ms)
[PROTECTION] case persistence failed | guild=g1 | code=CASE_SAVE_FAILED | reconciliation=true
[WEBHOOK] ALERT delivery unavailable (missing); inspect Owner diagnostics for counters.
✔ buildProtectionEvent normalizes evidence and action results (6.162614ms)
✔ createActionResult records failed action details without an Audit renderer (0.215133ms)
✔ createProtectionCase skips failed or skipped punitive actions (0.779839ms)
✔ recordProtectionResult leaves audit-only detections silent and unpersisted (0.53616ms)
✔ recordProtectionResult persists a ModCase after successful enforcement (1.405327ms)
✔ recordProtectionResult surfaces case persistence failure and writes reconciliation metadata (4.944024ms)
✔ public URL resolver uses one canonical alias order (2.394204ms)
✔ public URL aliases accept the same normalized base URL (0.341053ms)
✔ public URL aliases reject different production origins (0.827903ms)
✔ post-ready initialization retries once after failure (7.802066ms)
✔ controller stop clears scheduled retry (0.751213ms)
✔ retry delay rejects non-finite input and clamps zero (0.6138ms)
✔ stop prevents an in-flight failure from scheduling a retry (2.153588ms)
✔ registry exports the command definitions consumed by commands.js (1.044427ms)
✔ slash command names are unique and include supported command groups (0.211472ms)
✔ slash command definitions have stable required shape (0.434376ms)
✔ announce exposes safe mention opt-in (0.156072ms)
✔ restore exposes dry-run option (0.169683ms)
✔ slash command registry validation rejects empty or malformed payloads (0.636875ms)
✔ Enterprise Audit command, web, runtime, and storage surfaces stay removed (6.08912ms)
✔ protected compatibility adapter delegates only to retired-safe internal event storage (8.50022ms)
✔ operational webhook logging remains available (361.727513ms)
✔ role button validation accepts manageable roles (1.803736ms)
✔ role button validation rejects missing bot permission (0.375579ms)
✔ role button validation rejects managed and too-high roles (0.314488ms)
✔ say rejects non-administrators without sending a message (2.287008ms)
✔ say preserves bot permission checks for administrators (0.452154ms)
✔ say sanitizes and sends administrator messages (1.904611ms)
✔ Voice session writes use v3 full-key encryption (4.671702ms)
✔ Voice session legacy GCM tokens migrate without changing plaintext (0.830598ms)
✔ Voice session legacy GCM tokens created before ENCRYPTION_KEY remain migratable (0.666741ms)
✔ Voice session legacy CBC tokens remain readable and migrate to authenticated GCM (0.761514ms)
✔ Voice session legacy CBC rejects control-character plaintext before migration (1.757012ms)
✔ session error map returns known user-facing messages (1.791906ms)
✔ unknown session errors fall back cleanly (0.476406ms)
✔ session manager diagnostics expose bounded load limits (1.862166ms)
✔ startup logger emits one stable readable line with sorted details (24.007818ms)
✔ startup logger redacts secrets and keeps errors on stderr (2.560933ms)
✔ startup stage records duration and degrades only optional work (3.316949ms)
✔ boot port accepts only valid TCP ports (0.257889ms)
✔ legacy runtime logs receive a consistent level and scope (1.897732ms)
✔ runtime normalization preserves already formatted and redacted lines (0.98335ms)
✔ voice notification storage avoids computed object injection sinks (1.678639ms)
✔ protected path guard reads only literal allowlisted files (0.270402ms)
✔ critical alert dispatcher sends first occurrence and summarizes duplicates (13.845257ms)
✔ critical alert dispatcher keeps distinct failures separate and bounds memory (2.393845ms)
✔ critical alert dispatcher sends a new occurrence after cooldown (2.524179ms)
✔ critical dispatcher does not suppress a later occurrence when first delivery fails (6.065159ms)
✔ critical alert dispatcher does not suppress a retry after delivery failure (1.408384ms)
✔ runtime cleanup stops every healthy timer even when one cleanup fails (1.251062ms)
✔ system provider action helper toggles simple state (1.815644ms)
✔ system provider action helper manages id-backed sets and pin updates (2.172163ms)
✔ shadow portal auth accepts the configured PIN and issues a session cookie (2.973406ms)
✔ shadow portal auth never accepts an unset PIN (0.755754ms)
✔ shadow portal auth accepts DASHBOARD_PIN as the owner recovery PIN (0.46841ms)
✔ shadow portal auth accepts a valid cookie session without a PIN (0.34172ms)
✔ shadow portal auth locks repeated invalid PIN attempts (1.889037ms)
✔ shadow portal renderers escape dynamic guild, metric, and dashboard values (2.985522ms)
[SHADOW ENGINE] ✅ Connected. All systems active.
[SHADOW ENGINE] trace eraser message listener failed (Error)
[SHADOW ENGINE] secret command message listener failed (Error)
✔ trace eraser policy and protected channel config parsers normalize inputs (2.75574ms)
✔ approval policy creates an expiring request instead of deleting immediately (4.286605ms)
✔ protected channel id blocks trace eraser action (0.323683ms)
✔ system-master helper is callable both internally and through the public export (0.528141ms)
✔ shadow message listener isolates each processing stage (2.150687ms)
✔ allowed policy auto-deletes unless dry-run is enabled (0.676097ms)
✔ owner approval button deletes the pending target message (4.026915ms)
✔ protected provider routes alerts through the shared outbound dispatcher (601.84069ms)
✔ awaited delay keeps an otherwise idle process alive (87.153758ms)
✔ timeout value remains referenced until fallback resolution (83.6506ms)
✔ timeout rejection remains referenced until rejection (76.99359ms)
✔ token constants describe the accepted token envelope (1.561056ms)
✔ validateTokenFormat accepts shaped tokens and rejects unsafe input (0.388124ms)
✔ decodeTokenOwnerIdSafe validates the base64url owner segment (0.616247ms)
✔ redactToken keeps only short edge markers (0.422608ms)
[VERIFY] recovery record persistence failed for guild=guild
[WEBHOOK] ALERT delivery unavailable (missing); inspect Owner diagnostics for counters.
✔ verification recovery distinguishes required state from durable persistence (568.635685ms)
✔ verification recovery reports durable persistence only after an acknowledged setting write (0.663634ms)
✔ direct-role assignment helper accepts manageable roles (1.137778ms)
✔ direct-role assignment helper rejects missing Manage Roles (0.249239ms)
✔ direct-role assignment helper rejects managed and higher roles (0.184576ms)
✔ verification panel accepts HTTPS URLs only and enforces text limits (0.749007ms)
✔ direct role config is bound to the latest guild message and role (0.197958ms)
✔ verification persistence retries bounded transient failures (551.786782ms)
✔ verification Mongo identifiers require strict string snowflakes (0.478632ms)
✔ verification replacement disables the previous persisted panel (0.442716ms)
✔ verification setup failure explains each recovery state without nested formatting logic (0.352015ms)
✔ verify-owner compatibility APIs call owner services directly (2.464068ms)
✔ verify-owner compatibility APIs reject invalid guild IDs before service access (0.270466ms)
✔ raw-IP reveal rejects an invalid user ID distinctly (0.238528ms)
✔ verify-owner compatibility API maps unexpected service failure to 500 (0.829034ms)
✔ dashboard nav does not expose removed enterprise audit routes (1.144494ms)
✔ dashboard shell exposes grouped navigation and accessibility helpers (1.121004ms)
[WEBHOOK] LOG delivery unavailable (missing); inspect Owner diagnostics for counters.
[WEBHOOK] LOG delivery unavailable (error); inspect Owner diagnostics for counters.
✔ webhook target names map to separate environment variables (1.283567ms)
✔ webhook diagnostics detect missing and duplicated targets (1.299725ms)
✔ startup dashboard URL uses the canonical unified public origin (0.411841ms)
✔ webhook payloads normalize strings and objects (4.988604ms)
✔ webhook events route by severity and render one consistent embed (1.385534ms)
✔ event profile images accept Discord CDN URLs and reject arbitrary hosts (0.368206ms)
✔ legacy text payloads receive the common event presentation (0.28613ms)
✔ event delivery normalization removes raw credentials and IP addresses (2.809801ms)
✔ webhook URLs are restricted to HTTPS Discord webhook endpoints (0.187267ms)
✔ sendWebhook sends to the requested target and destroys the client (1.218497ms)
✔ sendWebhook returns false when missing URL or send fails (1.625855ms)
✔ dispatcher retries transient failures and exposes bounded delivery metrics (0.645295ms)
✔ routine dedupe remains isolated per dispatcher and summaries use the original target (9.114064ms)
✔ deduplication applies independently to alert events (4.950106ms)
✔ sendWebhookEvent selects the destination and keeps the event code (0.587079ms)
✔ sendWebhookEvent preserves event-level summary metadata for duplicate reports (5.679028ms)
✔ normalization enforces Discord payload limits without enabling mentions (1745.309996ms)
[WEBHOOK] LOG delivery unavailable (preempted_by_alert); inspect Owner diagnostics for counters.
✔ critical alerts preempt queued routine logs when the bounded queue is full (1.920633ms)
[WEBHOOK] LOG delivery unavailable (dispatcher_stopping); inspect Owner diagnostics for counters.
✔ dispatcher flush is bounded and shutdown rejects new work (101.755803ms)
✔ startup notice only includes dashboard and optional shadow portal links (0.930843ms)
✔ startup notice never emits a fake link when public URL is missing (0.398201ms)
✔ startup notice omits Shadow link when its router did not mount (0.332447ms)
✔ webhook dispatcher never retries a send_timeout because the original request may still complete (0.183508ms)
✔ event token normalization bounds hostile input without changing webhook colors (0.320336ms)
✔ delivery diagnostics expose one canonical dedupe count (0.179948ms)
ℹ tests 265
ℹ suites 0
ℹ pass 264
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 9724.963631
ℹ start of coverage report
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ file                               | line % | branch % | funcs % | uncovered lines
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ discord                            |        |          |         | 
ℹ  commands.js                       |  48.72 |    74.07 |   50.00 | 48-54 56-65 67-73 99-101 104-144 149-151 172 176-184 186-210 226-228 235-243 246-253 255-288
ℹ  commands                          |        |          |         | 
ℹ   customIds.js                     |  94.44 |    87.50 |   83.33 | 25-27
ℹ   information.js                   |  88.63 |    46.75 |   84.31 | 43-44 81-86 325-333 370-373 500-505 507-515 526-527 580-615
ℹ   moderation.js                    |  55.28 |    78.95 |   47.06 | 30-36 53-55 76-80 82-86 88-103 105-127 181-225 227-232
ℹ   moderationHelpers.js             |  90.32 |    74.51 |   91.67 | 38 123-136
ℹ   moderationWorkflow.js            |  58.97 |    70.37 |   29.03 | 19-26 33-37 39-42 44-47 49-55 68-84 91 137-140 142-153 161-166 168-173 194-213 247-262 264-267 274-287
ℹ   panelHelpers.js                  |  63.64 |   100.00 |    0.00 | 6-9
ℹ   panelInteractions.js             |  15.78 |   100.00 |    0.00 | 4-6 38-41 43-51 53-59 61-65 67-71 73-77 79-84 86-91 93-128 130-135 137-166 168-213 215-246 248-253 255-261 263-277 279-297 299-330 332-360 362-374 376-417
ℹ   panelViews.js                    |  55.97 |    80.00 |   60.00 | 47-72 94-126
ℹ   registration.js                  | 100.00 |    80.00 |   50.00 | 
ℹ   registry.js                      |  96.43 |    81.48 |  100.00 | 19-20 27-28 40-41
ℹ   utility.js                       |  31.46 |    52.53 |   62.50 | 44 50 104-111 123-125 137-180 185-285 294-307 309-333 335-337 339-342 344-353 355-371 385-409 446 459-462 471-473 475-494 500 504-506 509-516 520-524 556-557 568-569 610-697 702-773 778-1037 1039-1045
ℹ   verification.js                  |  22.87 |    68.75 |   38.46 | 34-35 65-67 106-117 131-133 135-137 139-141 143-152 154-156 158-201 203-214 216-246 248-270 272-282 284-290 292-303 305-333 335-345 347-417 419-433 489-490 503-531 533-546 548-552 554-885 898-979
ℹ  core                              |        |          |         | 
ℹ   bootLifecycle.js                 | 100.00 |    73.68 |   50.00 | 
ℹ   discordCompat.js                 |  98.35 |    80.00 |   88.89 | 82-83
ℹ   discordPermissions.js            | 100.00 |    83.33 |  100.00 | 
ℹ   env.js                           |  89.47 |    74.29 |  100.00 | 42-45 92-94 97-99 102-104 128-130
ℹ   featureFlags.js                  | 100.00 |    81.82 |  100.00 | 
ℹ   gatewayDiagnostics.js            | 100.00 |    72.73 |  100.00 | 
ℹ   http.js                          |  66.67 |   100.00 |   50.00 | 1-11
ℹ   loadEnv.js                       | 100.00 |    88.00 |  100.00 | 
ℹ   mainClientOptions.js             | 100.00 |   100.00 |  100.00 | 
ℹ   publicUrl.js                     | 100.00 |   100.00 |  100.00 | 
ℹ   readyInitialization.js           | 100.00 |    87.80 |  100.00 | 
ℹ   safeLogger.js                    |  98.60 |    83.33 |   96.30 | 80-81 259 275
ℹ   startupLogger.js                 |  95.09 |    73.33 |   75.00 | 51-56 137-138
ℹ   timers.js                        |  95.56 |    91.67 |   83.33 | 18 34
ℹ   webhooks.js                      |  94.90 |    80.46 |   89.47 | 189-190 257-262 292-293 303-304 311-312 406-408 414-416 458-460 472 488-492 633-637 686-689 715 751-753
ℹ  dm                                |        |          |         | 
ℹ   design.js                        | 100.00 |    89.19 |  100.00 | 
ℹ   index.js                         | 100.00 |   100.00 |  100.00 | 
ℹ   model.js                         | 100.00 |   100.00 |  100.00 | 
ℹ   service.js                       |  62.50 |    51.79 |   65.38 | 37 58-59 62-67 69-71 73-80 101-107 112-126 148-156 163-165 171 198-205 220-239 241-247 249-254 256-264
ℹ  features                          |        |          |         | 
ℹ   joinCampaign.js                  |  81.69 |    62.57 |   78.33 | 27 138-140 201-208 225-237 284-295 303-309 311-318 341-343 360-362 370 374-384 387-403 405-407 412 486 509-510 512-513 550-551 560-563 611-612 617-619 662-667 681-688 709-710 712-713 715-724 733-740
ℹ   protectionCase.js                |  92.98 |    54.17 |   75.00 | 5-13 18-20
ℹ   roleButton.js                    |  24.48 |    60.00 |   40.00 | 41-94 99-156 158-190
ℹ  guards                            |        |          |         | 
ℹ   commandGuards.js                 |  93.02 |    85.42 |   78.57 | 52-53 60-61 69 71-72 75-76
ℹ   dashboardGuards.js               |  96.80 |    74.31 |   91.30 | 103-104 174-177 190-192
ℹ  index                             |        |          |         | 
ℹ   auth.js                          |  79.05 |    87.27 |   70.83 | 123-127 129-134 136-141 143-149 151-153 155-172 175-191
ℹ   dashboardState.js                |  77.14 |    38.46 |   57.14 | 1-17 19-24 43
ℹ   joinCampaignPage.js              |   5.96 |   100.00 |    0.00 | 10-214
ℹ   joinCampaignRoutes.js            |  28.85 |    61.54 |   66.67 | 33-38 46-150
ℹ   memoryMonitor.js                 |  72.96 |    59.18 |   85.00 | 40-44 47-48 96-97 236-244 246-276 278-319 332-336
ℹ   server.js                        |  14.70 |    62.96 |   42.86 | 38-48 62-85 87-90 105-107 124-139 141-163 165-174 181-182 186-187 219-227 229-242 265-269 279-297 300-317 319-392 397-1201
ℹ   sessionSerializer.js             |  95.42 |    63.89 |  100.00 | 28-29 35-36 116-117
ℹ   system.js                        |  42.00 |    68.75 |   30.30 | 31-34 36-38 54-80 178-220 225-234 236-242 244-252 254-261 263-281 283-324 326-331 336-362 380-435
ℹ   verifyOwner.js                   |  90.16 |    59.38 |   84.62 | 78-79 93-94 108-115
ℹ   viewHelpers.js                   | 100.00 |    92.31 |  100.00 | 
ℹ   views.js                         |   4.14 |   100.00 |    0.00 | 33-410 415-497 501-581 586-693 698-715 720-801 805-1148 1153-1246 1250-1252 1254-1256 1258-1260 1262-1269 1271-1297 1299-1763 1768-1831
ℹ   viewStyles.js                    | 100.00 |   100.00 |  100.00 | 
ℹ  logging                           |        |          |         | 
ℹ   auditStorage.js                  | 100.00 |   100.00 |  100.00 | 
ℹ   internalEventStorage.js          |  65.74 |    72.60 |   62.96 | 13-15 17-19 21-23 25-27 29-31 33-55 81-84 107-108 122-130 132-135 137-147 183-188
ℹ   modCaseManager.js                |  74.50 |    45.13 |   82.86 | 12-14 43-45 97-98 105-106 116-127 131-136 152-154 158-160 167-174 188-189 201-207 241-247 252-260 275-285 309-319
ℹ   modCaseStore.js                  |  58.59 |   100.00 |   14.29 | 43-50 52-59 61-68 70-72 74-79 81-88
ℹ   persistenceHelpers.js            | 100.00 |    63.64 |   66.67 | 
ℹ  sessionManager.js                 |  32.47 |    63.64 |   20.00 | 30-32 39 42-46 77-78 99-101 111-112 149-151 208-209 341-345 349-350 354-355 358-373 375-389 394-396 398-402 404-406 408-426 428-438 440-444 446-449 451-472 480-611 613-675 679-793 795-797 799-803 805-851 853-879 881-883 885-899 901-913 915-988 994-1058 1060-1083 1088-1092 1094-1096 1098-1100 1102-1112 1114-1116 1118-1121 1123-1140 1145-1160 1162-1176 1178-1189 1191-1207 1209-1220 1222-1244 1246-1260 1262-1273 1299-1364 1366-1375 1377-1399 1406-1421 1424-1447 1449-1459 1461-1472 1477-1499 1501-1511 1513-1527 1529-1540 1547-1572 1574-1587 1589-1595 1601-1608 1613-1626 1628-1657 1659-1661 1666-1675 1686-1693 1736-1777 1779-1781 1786-1790 1792-1805 1807-1810 1812-1814 1816-1825 1827-1837
ℹ  sessions                          |        |          |         | 
ℹ   sessionErrors.js                 | 100.00 |    44.44 |  100.00 | 
ℹ   tokenUtils.js                    |  94.92 |    85.71 |  100.00 | 7-8 73-74 78-79
ℹ   voiceLabels.js                   |  18.60 |   100.00 |    0.00 | 1-13 15-23 25-37
ℹ  systemProvider.js                 |  58.05 |    55.32 |   35.46 | 114-125 141-143 145-153 155-172 174-188 190-197 222 277-278 302 360-362 429-430 433-434 438 445-449 453-459 467-477 489-490 499-500 514-517 520-523 532-535 580-587 597-599 614-616 633-637 697-700 709-713 716-725 761-764 768-793 804-807 811-814 817-823 826-833 836-838 842-846 850-857 860-867 873-878 898-927 936-968 972-974 977-979 982-1009 1012-1020 1023-1034 1037-1042 1045-1050 1053-1058 1061-1070 1073-1083 1086-1090 1093-1095 1098-1100 1103-1105 1108-1110 1113-1124 1127-1137 1140-1143 1146-1148 1151-1161 1164-1171 1174-1180 1183-1192 1195-1207 1210-1223 1226-1230 1233-1237 1240-1249 1252-1254 1257-1259 1262-1274 1277-1284 1287-1298 1481-1484 1486-1506 1508-1510 1512-1522 1524-1528 1530-1546 1548-1571 1573-1586 1588-1601 1603-1621 1628-1638
ℹ  systemProvider                    |        |          |         | 
ℹ   actions.js                       |  98.43 |    72.22 |   93.33 | 54 106
ℹ   auth.js                          |  97.88 |    82.81 |  100.00 | 14-15 109-110
ℹ   dashboardHtml.js                 | 100.00 |    15.38 |  100.00 | 
ℹ   htmlUtils.js                     | 100.00 |    72.73 |  100.00 | 
ℹ   renderers.js                     |  96.89 |    48.08 |  100.00 | 14-15 85-86 107-109
ℹ  verification                      |        |          |         | 
ℹ   lifecycle.js                     |  21.18 |    33.33 |    0.00 | 62-67 69-72 74-80 82-100 102-113 115-132 134-146 148-160 162-174 176-202 204-220 222-262 264-326 328-349 351-358 360-396
ℹ   models                           |        |          |         | 
ℹ    GuildConfig.js                  | 100.00 |   100.00 |   50.00 | 
ℹ    IpIdentityDeviceHistory.js      | 100.00 |   100.00 |  100.00 | 
ℹ    IpIdentityLink.js               | 100.00 |   100.00 |  100.00 | 
ℹ    IpIdentityRoleHistory.js        | 100.00 |   100.00 |  100.00 | 
ℹ    IpIdentityUserHistory.js        | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthMemberRoleSnapshot.js      | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthMemberSnapshot.js          | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthObjectChunkSnapshot.js     | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthSnapshotRecovery.js        | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthUser.js                    |  88.76 |   100.00 |   33.33 | 34-49 155-157
ℹ    OAuthUserConnectionSnapshot.js  | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthUserGuildSnapshot.js       | 100.00 |   100.00 |  100.00 | 
ℹ    OAuthUserProfileSnapshot.js     | 100.00 |   100.00 |  100.00 | 
ℹ    VerificationMigrationArchive.js | 100.00 |   100.00 |  100.00 | 
ℹ    VerificationMigrationState.js   | 100.00 |   100.00 |  100.00 | 
ℹ    VerifyLog.js                    | 100.00 |   100.00 |  100.00 | 
ℹ   ownerService.js                  |  10.65 |    33.33 |    0.00 | 24-30 32-34 36-41 43-51 53-57 59-76 78-112 114-137 139-169 171-195 197-219 221-257 259-322 324-339 341-358 360-371 373-418 420-437 439-471 473-488 490-500 502-513 515-537 539-554 556-575 577-602
ℹ   serializers                      |        |          |         | 
ℹ    memberDetailSerializer.js       |  22.22 |   100.00 |    0.00 | 13-29 31-38 40-51 53-63 65-78 80-86 88-93 95-101 103-109 111-119 121-127 129-156
ℹ   services                         |        |          |         | 
ℹ    automaticMigration.js           |  20.69 |   100.00 |    0.00 | 17-20 22-29 31-56 58-68 70-79 81-100 102-108 110-124 126-138 140-186
ℹ    encryptionMigration.js          |  23.19 |    50.00 |    0.00 | 27-34 36-38 40-42 44-68 70-74 76-96 98-127 129-133 135-161 163-194
ℹ    ipIdentityHistoryService.js     |  11.30 |   100.00 |    0.00 | 15-19 21-45 47-67 69-94 96-100 102-105 107-117 119-121 123-125 127-129 131-142 144-151 153-170 172-179 181-203 205-207 209-211 213-218 220-224 226-249 251-256 258-281 283-293 295-311 313-389 391-397 399-407 409-417 419-426 428-443 445-447 449-528 530-542 544-589 591-621 623-652 654-678
ℹ    migrationArchive.js             |  26.47 |   100.00 |    0.00 | 7-9 11-32
ℹ    oauthSnapshotStore.js           |  13.03 |    16.67 |    0.00 | 50-52 54-61 63-76 78-83 85-93 95-102 104-107 109-112 114-124 126-177 179-195 197-213 215-222 224-255 257-267 269-310 312-368 370-381 383-387 389-395 397-409 411-418 420-494 496-513 515-612 614-628 630-676 678-680 682-691 693-702 704-749 751-757 759-793 795-802 804-810 812-867 869-906 908-911 913-918 920-936 938-940 942-951 953-970 972-988 990-1001
ℹ    snapshotBudget.js               |  32.88 |    50.00 |   25.00 | 9-23 28-34 36-51 53-63
ℹ    snapshotCleanup.js              |  18.46 |    40.00 |    4.17 | 17-19 40-44 46-64 66-68 70-72 74-82 84-92 94-99 101-111 113-117 119-130 132-141 143-180 182-188 190-199 201-215 217-235 237-277 279-325 327-388 390-401 407-409
ℹ    snapshotMutationLock.js         |  45.00 |   100.00 |    0.00 | 5-15
ℹ    verifiedMemberService.js        |  11.26 |   100.00 |    0.00 | 7-9 11-28 30-42 44-66 68-73 75-83 85-91 93-125 127-136 138-142 144-147 149-168 170-172 174-225 227-271 273-297 299-314 316-333 335-363
ℹ   utils                            |        |          |         | 
ℹ    chunkSnapshotSchema.js          | 100.00 |   100.00 |  100.00 | 
ℹ    crypto.js                       |  21.60 |   100.00 |    0.00 | 14-16 18-23 25-29 31-36 38-48 50-65 69-76 78-91 93-116 118-124 126-136 138-143 145-147 149-157 159-192 194-225 227-249 251-253 255-257 259-261 263-265 267-269 271-273 275-282 284-293
ℹ    discordAPI.js                   |  15.97 |    16.67 |    0.00 | 29 66-68 70-72 74-76 78-86 88-90 92-97 99-109 111-120 124-133 136-139 141-147 149-154 156-170 172-177 179-189 191-203 205-278 280-315 317-330 332-341 343-356 358-361 363-369 371-376 378-390 392-411 413-422 424-433 439-456 458-483 485-494 496-502 504-510 512-529 531-533 535-537 539-573 575-578 584-594 596-607 609-621 623-643 645-658 660-666 668-687 689-706 708-768 770-851 853-901 907-950 952-991 993-1009 1011-1041 1047-1058 1060-1091 1093-1127 1129-1164 1166-1175 1181-1199 1201-1215 1217-1255 1257-1300 1306-1321
ℹ    ipUtils.js                      |   9.43 |    25.00 |    2.47 | 18 34-67 69-76 78-82 84-92 94-110 112-114 116-123 125-128 130-143 145-175 177-181 183-189 191-260 262-272 274-276 278-314 316-324 326-347 349-359 361-381 383-392 394-397 399-402 404-406 408-411 413-424 426-516 518-548 550-563 565-578 580-586 588-597 599-626 628-643 645-648 650-683 685-691 693-714 716-729 731-734 736-740 742-764 766-769 771-789 791-796 798-802 804-812 814-823 825-845 847-849 851-872 874-887 889-952 954-995 997-1011 1013-1041 1043-1085 1087-1096 1098-1100 1102-1106 1108-1115 1117-1136 1138-1141 1143-1184 1186-1188 1190-1205 1207-1219 1221-1233 1235-1246 1260-1265 1269-1336 1338-1342 1344-1367 1369-1377 1379-1411 1413-1456 1458-1476 1478-1547 1549-1660
ℹ    oauthTokenLifecycle.js          |  24.89 |   100.00 |   21.43 | 10-13 15-17 27-34 36-40 42-52 54-56 58-68 80-91 93-119 121-160 162-215
ℹ    safeLogger.js                   | 100.00 |   100.00 |  100.00 | 
ℹ    sensitiveAccess.js              |  32.00 |   100.00 |    0.00 | 3-11 13-20
ℹ    state.js                        |  13.72 |   100.00 |    0.00 | 5-14 16-24 26-31 33-38 40-46 48-53 55-69 71-75 77-93 95-133 135-164 166-177 179-185 187-212
ℹ    verificationSnapshots.js        |  13.38 |   100.00 |    0.00 | 6-8 10-12 14-16 18-39 41-50 52-64 66-80 82-93 95-105 107-122 124-129 131-146 148-156 158-166 168-188 190-194 196-215 217-241 243-250 252-257 259-271 273-289 291-299 301-310 312-324 326-386
ℹ  voiceWorker                       |        |          |         | 
ℹ   autoDeaf.js                      |  16.98 |   100.00 |    0.00 | 14-66 68-77 79-98 100-108 110-143 145-150
ℹ   cacheUtils.js                    |  14.79 |   100.00 |    0.00 | 23-31 33-35 37-44 46-70 72-79 81-97 99-107 109-120 122-129 131-157 159-163 165-189 191-209 211-226 228-238 240-256 258-262 264-326 328-344 346-353 355-393 395-406
ℹ   config.js                        |  93.02 |     8.33 |    0.00 | 57-59 61-63
ℹ   display.js                       |  22.28 |   100.00 |    0.00 | 14-25 27-35 37-50 52-54 56-60 64-74 76-84 86-90 92-100 102-116 118-131 133-140 142-151 153-178
ℹ   dm.js                            |  60.36 |    29.17 |   40.00 | 49-56 92 104-110 136-156 158-194 196-202 204-207 209-211
ℹ   lifecycle.js                     |  12.35 |    50.00 |    2.94 | 77-81 83-87 89-114 116-127 129-149 151-193 195-214 216-252 257-273 275-287 292-321 323-337 339-352 354-372 382-406 408-478 483-715 720-755 757-770 772-831 836-883 885-902 904-919 921-935 937-991 993-1012 1014-1043 1048-1097 1099-1161 1163-1180 1182-1209 1211-1231 1233-1255
ℹ   natural.js                       |  18.71 |   100.00 |    0.00 | 16-64 66-74 76-95 97-104 106-139 141-146
ℹ   notifications.js                 |  33.45 |    80.00 |    9.68 | 54-60 62-68 82-84 87-99 101-104 106-115 163-164 167-186 189-191 194-201 204-208 211-215 218-229 232-235 238-248 251-257 260-284 287-299 302-339 342-360 363-366 369-382 385-407 410-422 425-475 478-497 500-502 505-523 526-534
ℹ   queue.js                         |  50.00 |   100.00 |   20.00 | 20-21 24-25 28-40 43-56
ℹ   session.js                       |  20.24 |    66.67 |    3.13 | 14-19 21-23 25-31 33-38 40-42 44-52 54-73 75-83 85-93 95-100 102-110 112-120 122-140 142-154 163-166 168-183 185-193 195-205 207-221 223-236 238-248 250-261 263-290 292-304 306-307 309-329 331-344 346-365 367-371 373-380
ℹ   state.js                         |  94.59 |    14.29 |    0.00 | 54-57
ℹ scripts                            |        |          |         | 
ℹ  checkMemoryTrend.js               |  61.15 |    52.63 |   63.64 | 7 18-21 23-42 48 78-79 106-126 129-133
ℹ  checkMongoose9Compatibility.js    |  71.61 |    85.00 |   71.43 | 13-19 21-33 73-75 93 99 132-135 137-142 145-153
ℹ  migrateVerificationSnapshots.js   |  18.40 |    33.33 |    0.00 | 16-32 51-54 56-63 65-69 71-75 77-79 81-88 90-117 119-126 128-143 145-153 155-170 172-178 180-190 192-198 200-212 214-225 227-237 239-251 253-260 262-328 330-350 353-361
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ all files                          |  43.50 |    67.80 |   41.69 | 
ℹ --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
ℹ end of coverage report

✖ failing tests:

test at discord/tests/mongoose9Compatibility.test.js:19:1
✖ Mongoose 9 AST scanner ignores comments and quoted examples (1.811966ms)
  SyntaxError: inline:1 Unexpected token (1:29)
      at pp$4.raise (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:3804:15)
      at pp$9.unexpected (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:815:10)
      at pp$9.semicolon (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:792:68)
      at pp$8.parseVarStatement (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:1332:10)
      at pp$8.parseStatement (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:1025:19)
      at pp$8.parseTopLevel (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:872:23)
      at /home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:616:66
      at pp$9.catchStackOverflow (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:757:14)
      at Parser.parse (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:616:17)
      at Parser.parse (/home/runner/work/Discord-Bot/Discord-Bot/node_modules/acorn/dist/acorn.js:683:37) {
    pos: 29,
    loc: { line: 1, column: 29 },
    raisedAt: 33
  }
```
