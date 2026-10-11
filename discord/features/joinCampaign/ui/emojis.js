"use strict";

const config = require("../../../config.json");

const emojis = config.emojis || {};

module.exports = {
    members: emojis.members || "👥",
    server: emojis.server_icon || "🖥️",
    boost: emojis.boost || "🚀",
    loading: emojis.loading || "⏳",
    success: emojis.success || emojis.check_alt || "✅",
    error: emojis.error || "❌",
    alert: emojis.alert || emojis.warning || "⚠️",
    online: emojis.status_online || "🟢",
    offline: emojis.status_offline || "🔴",
    sparkle: emojis.universe || "✨",
    key: emojis.key || "🔑",
    shield: emojis.shield || "🛡️",
    no_entry: emojis.no_entry || "⛔",
    owner: emojis.owner || "👑",
    activate: emojis.activate || "▶️",
    disable: emojis.disable || "⏹️",
    refresh: emojis.loading_circle || emojis.loading || "🔄"
};
