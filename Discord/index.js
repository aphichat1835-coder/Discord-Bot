process.on("uncaughtException", (err) => console.error("[CRITICAL] uncaughtException:", err.message));
process.on("unhandledRejection", (reason) => console.error("[CRITICAL] unhandledRejection:", reason?.message ?? reason));

const { Client, Intents } = require("discord.js");
const express = require("express");
const config = require("./config.json");
const sessionManager = require("./sessionManager");
const voiceWorker = require("./voiceWorker");
const commands = require("./commands");

const app = express();
app.get("/", (_req, res) => res.send("Enterprise Voice System Online"));
app.get("/ping", (_req, res) => res.send("PONG"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[EXPRESS] Server online on port ${PORT}`));

if (!process.env.TOKEN_MANAGER) {
    console.error("[CONFIG] TOKEN_MANAGER not configured in environment");
    process.exit(1);
}

const client = new Client({
    intents:[
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_MEMBERS,
        Intents.FLAGS.GUILD_VOICE_STATES,
        Intents.FLAGS.MESSAGE_CONTENT,
    ],
});

client.on("ready", async () => {
    console.log(`[CLIENT] Logged in as ${client.user.tag}`);
    console.log(`[CONFIG] Max Sessions: ${config.limits.maxSessions}`);

    try {
        await client.application.commands.set(commands.slashCommandsData);
        console.log("[COMMANDS] Slash commands registered successfully");
    } catch (err) {
        console.error("[COMMANDS] Failed to register slash commands:", err.message);
    }

    await voiceWorker.autoResume();
});

client.on("messageCreate", async (msg) => {
    await commands.handleMessage(msg);
});

client.on("interactionCreate", async (interaction) => {
    await commands.handleInteraction(interaction);
});

client.on("error", (err) => console.error("[CLIENT] Error:", err.message));

setInterval(() => commands.updatePanel().catch(() => {}), 15000);
setInterval(() => voiceWorker.healthCheck().catch(() => {}), 30000);
setInterval(() => voiceWorker.cleanupIdleSessions().catch(() => {}), 3600000);

async function shutdown(signal) {
    console.log(`\n[SHUTDOWN] Received ${signal} — initiating cleanup...`);
    try {
        await voiceWorker.stopAll();
        client.destroy();
        console.log("[SHUTDOWN] Cleanup complete");
    } catch (err) {
        console.error("[SHUTDOWN] Error:", err.message);
    }
    process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

async function startBot() {
    try { await client.login(process.env.TOKEN_MANAGER); } 
    catch (err) { setTimeout(startBot, 10000); }
}
startBot();