# Audit Scheduler Runtime

The scheduler helper now exists in `discord/logging/auditRuntimeLifecycle.js`.

The scheduler is wired from the Service 1 boot path and remains opt-in because `AUDIT_RECONCILER_ENABLED=false` is the default.

## Current wiring

`discord/index.js` imports:

```js
const { startAuditRuntime } = require("./logging/auditRuntimeLifecycle");
```

Inside the `client.on("ready")` audit block, Service 1 calls:

```js
startAuditRuntime({ client, sessionManager });
```

`discord/index/system.js` accepts the audit reconciler scheduler and stops it during graceful shutdown.

## Runtime safety

- Default remains disabled.
- Enable only with `AUDIT_RECONCILER_ENABLED=true`.
- Keep `AUDIT_RECONCILER_LIMIT=10` unless test evidence says otherwise.
- Keep `AUDIT_RECONCILER_INTERVAL_MS>=300000` for normal use.
- Test in a private Discord server before enabling production.
