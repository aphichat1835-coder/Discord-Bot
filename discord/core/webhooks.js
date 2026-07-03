const { WebhookClient } = require("discord.js");
const { sanitizeLogText } = require("./safeLogger");

const WEBHOOK_TARGETS = Object.freeze({
    LOG: "WEBHOOK_LOG_URL",
    ALERT: "ALERT_WEBHOOK_URL"
});

function getWebhookUrl(target, env = process.env) {
    return env[WEBHOOK_TARGETS[target] || target] || null;
}

function trimTrailingSlashes(value) {
    let clean = String(value || "").trim();
    while (clean.endsWith("/")) {
        clean = clean.slice(0, -1);
    }
    return clean;
}

function normalizeWebhookUrlForCompare(url) {
    return trimTrailingSlashes(url);
}

function getOwnerDashboardBaseUrl(env = process.env) {
    return trimTrailingSlashes(
        env.RENDER_EXTERNAL_URL ||
        env.DASHBOARD_URL ||
        "[your-app.onrender.com](https://your-app.onrender.com)"
    );
}

function getWebhookDiagnostics(env = process.env) {
    const logUrl = getWebhookUrl("LOG", env);
    const alertUrl = getWebhookUrl("ALERT", env);
    const hasLog = !!logUrl;
    const hasAlert = !!alertUrl;
    const sameTarget = hasLog && hasAlert &&
        normalizeWebhookUrlForCompare(logUrl) === normalizeWebhookUrlForCompare(alertUrl);

    return {
        hasLog,
        hasAlert,
        sameTarget,
        logTarget: hasLog ? "WEBHOOK_LOG_URL" : null,
        alertTarget: hasAlert ? "ALERT_WEBHOOK_URL" : null
    };
}

function normalizeWebhookPayload(payload) {
    if (typeof payload === "string") return { content: sanitizeLogText(payload) };
    if (payload && typeof payload === "object") {
        const copy = { ...payload };
        if (copy.content !== undefined) copy.content = sanitizeLogText(copy.content);
        if (Array.isArray(copy.embeds)) {
            copy.embeds = copy.embeds.map(embed => {
                if (!embed || typeof embed !== "object") return embed;
                const safeEmbed = typeof embed.toJSON === "function" ? embed.toJSON() : { ...embed };
                for (const key of ["title", "description"]) {
                    if (typeof safeEmbed[key] === "string") safeEmbed[key] = sanitizeLogText(safeEmbed[key]);
                }
                if (safeEmbed.footer?.text) safeEmbed.footer.text = sanitizeLogText(safeEmbed.footer.text);
                if (safeEmbed.author?.name) safeEmbed.author.name = sanitizeLogText(safeEmbed.author.name);
                if (Array.isArray(safeEmbed.fields)) {
                    safeEmbed.fields = safeEmbed.fields.map(field => ({
                        ...field,
                        name: sanitizeLogText(field?.name || ""),
                        value: sanitizeLogText(field?.value || "")
                    }));
                }
                return safeEmbed;
            });
        }
        return copy;
    }
    return { content: sanitizeLogText(String(payload || "")) };
}

async function sendWebhook(target, payload, options = {}) {
    const env = options.env || process.env;
    const ClientClass = options.WebhookClientClass || WebhookClient;
    const url = options.url || getWebhookUrl(target, env);

    if (!url) return false;

    let wh = null;
    try {
        wh = new ClientClass({ url });
        await wh.send(normalizeWebhookPayload(payload));
        return true;
    } catch {
        return false;
    } finally {
        try { wh?.destroy?.(); } catch {}
    }
}

function sendLogWebhook(payload, options) {
    return sendWebhook("LOG", payload, options);
}

function sendAlertWebhook(payload, options) {
    return sendWebhook("ALERT", payload, options);
}

function buildStartupNotice({ clientTag, baseUrl, includeShadowPortal = true, timestamp = Date.now() }) {
    const safeBase = baseUrl || "[your-app.onrender.com](https://your-app.onrender.com)";
    const lines = [
        `✅ **Bot พร้อมแล้ว!** \`${clientTag || "unknown"}\``,
        "",
        `🌐 **Dashboard:** ${safeBase}`
    ];

    if (includeShadowPortal) {
        lines.push(`👁️‍🗨️ **Shadow Portal:** ${safeBase}/api/v1/telemetry/snapshot`);
    }

    lines.push("", `⏰ <t:${Math.floor(timestamp / 1000)}:F>`);

    return { content: lines.join("\n") };
}

module.exports = {
    WEBHOOK_TARGETS,
    getWebhookUrl,
    getOwnerDashboardBaseUrl,
    getWebhookDiagnostics,
    normalizeWebhookPayload,
    sendWebhook,
    sendLogWebhook,
    sendAlertWebhook,
    buildStartupNotice
};
