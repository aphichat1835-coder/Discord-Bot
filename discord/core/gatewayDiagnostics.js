"use strict";

const { sanitizeLogText } = require("./safeLogger");

const attachedClients = new WeakSet();

function safeLabel(value, fallback) {
    const clean = sanitizeLogText(String(value || fallback || "unknown")).trim();
    return clean.slice(0, 120) || "unknown";
}

function registerGatewayDiagnostics(client, options = {}) {
    if (!client?.on || attachedClients.has(client)) return false;
    attachedClients.add(client);
    const clientName = safeLabel(options.clientName, "discord");
    const context = safeLabel(options.context, "runtime");
    const prefix = `[GATEWAY] client=${clientName} context=${context}`;

    client.on("error", error => {
        console.error(`${prefix} event=error message=${safeLabel(error?.message, error)}`);
    });
    client.on("shardError", (error, shardId) => {
        console.error(`${prefix} event=shardError shard=${safeLabel(shardId, "unknown")} message=${safeLabel(error?.message, error)}`);
    });
    client.on("shardDisconnect", (closeEvent, shardId) => {
        console.warn(`${prefix} event=shardDisconnect shard=${safeLabel(shardId, "unknown")} code=${safeLabel(closeEvent?.code, "unknown")}`);
    });
    client.on("shardReconnecting", shardId => {
        console.warn(`${prefix} event=shardReconnecting shard=${safeLabel(shardId, "unknown")}`);
    });
    return true;
}

module.exports = { registerGatewayDiagnostics };
