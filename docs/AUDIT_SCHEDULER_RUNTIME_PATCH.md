# Audit Scheduler Runtime Patch

The scheduler helper now exists in `discord/logging/auditRuntimeLifecycle.js`.

Apply this patch only after confirming `FEATURE_AUDIT=true` behavior is stable.
The scheduler remains opt-in because `AUDIT_RECONCILER_ENABLED=false` is the default.

## Import

Add near the audit logger import in `discord/index.js`:

```js
const { startAuditRuntime } = require("./logging/auditRuntimeLifecycle");
```

## Start point

Inside the `client.on("ready")` audit block, immediately after:

```js
auditLogger.register(client, sessionManager);
console.log("[AUDIT] ✅ Audit Logger registered.");
```

Add:

```js
startAuditRuntime({ client, sessionManager });
```

## Shutdown point

`discord/index/system.js` now accepts an optional `auditReconcilerScheduler` argument and calls `.stop()` during graceful shutdown. When editing `discord/index.js`, pass the scheduler or lifecycle object into `system.initShutdown` only after reviewing the boot file.

## Runtime safety

- Default remains disabled.
- Enable only with `AUDIT_RECONCILER_ENABLED=true`.
- Keep `AUDIT_RECONCILER_LIMIT=10` unless test evidence says otherwise.
- Keep `AUDIT_RECONCILER_INTERVAL_MS>=300000` for normal use.
- Test in a private Discord server before enabling production.
