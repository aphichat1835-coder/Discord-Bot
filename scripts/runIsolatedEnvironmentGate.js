#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const mongoose = require("mongoose");
const { Client, GatewayIntentBits } = require("discord.js");
const {
    VoiceConnectionStatus,
    entersState,
    joinVoiceChannel
} = require("@discordjs/voice");
const { normalizeDiscordSnowflake } = require("../discord/core/snowflakes");

const REQUIRED_NAMES = [
    "TEST_COMMIT_SHA",
    "TEST_MONGO_URI",
    "TEST_DISCORD_TOKEN",
    "TEST_GUILD_ID",
    "TEST_TEXT_CHANNEL_ID",
    "TEST_VOICE_CHANNEL_ID",
    "TEST_DISCORD_CLIENT_ID",
    "TEST_DISCORD_CLIENT_SECRET",
    "TEST_PUBLIC_BASE_URL",
    "TEST_ALLOWED_HOSTS",
    "PRODUCTION_PUBLIC_BASE_URL"
];

function requiredText(env, name) {
    const value = String(env[name] || "").trim();
    if (!value) throw new Error(`MISSING_${name}`);
    return value;
}

function databaseNameFromMongoUri(uri) {
    let parsed;
    try {
        parsed = new URL(String(uri || "").trim());
    } catch {
        return "";
    }
    const pathname = String(parsed.pathname || "").replace(/^\/+/, "");
    if (!pathname) return "";
    try {
        return decodeURIComponent(pathname);
    } catch {
        return pathname;
    }
}

function exactAllowedHosts(value) {
    return new Set(
        String(value || "")
            .split(",")
            .map(item => item.trim().toLowerCase())
            .filter(Boolean)
    );
}

function normalizeHttpsOrigin(value, errorCode) {
    let url;
    try {
        url = new URL(String(value || "").trim());
    } catch {
        throw new Error(`${errorCode}_INVALID`);
    }
    if (url.protocol !== "https:") throw new Error(`${errorCode}_MUST_USE_HTTPS`);
    return url.origin;
}

function validateIsolatedEnvironment(env = process.env) {
    if (String(env.TEST_ENVIRONMENT_CONFIRMATION || "") !== "ISOLATED_TEST_ONLY") {
        throw new Error("TEST_ENVIRONMENT_CONFIRMATION_REQUIRED");
    }

    const missing = REQUIRED_NAMES.filter(name => !String(env[name] || "").trim());
    if (missing.length) throw new Error(`MISSING_TEST_ENVIRONMENT:${missing.join(",")}`);

    const commitSha = requiredText(env, "TEST_COMMIT_SHA").toLowerCase();
    if (!/^[a-f0-9]{40}$/.test(commitSha)) throw new Error("INVALID_TEST_COMMIT_SHA");

    const mongoUri = requiredText(env, "TEST_MONGO_URI");
    const databaseName = databaseNameFromMongoUri(mongoUri);
    if (!/(?:test|testing|sandbox|staging|preview|integration|ci)/i.test(databaseName)) {
        throw new Error("TEST_MONGO_DATABASE_NAME_REQUIRED");
    }
    if (env.MONGO_URI && String(env.MONGO_URI).trim() === mongoUri) {
        throw new Error("TEST_MONGO_MUST_DIFFER_FROM_RUNTIME_MONGO");
    }

    const publicUrl = new URL(requiredText(env, "TEST_PUBLIC_BASE_URL"));
    if (publicUrl.protocol !== "https:") throw new Error("TEST_PUBLIC_BASE_URL_MUST_USE_HTTPS");
    publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, "");
    publicUrl.search = "";
    publicUrl.hash = "";

    const allowedHosts = exactAllowedHosts(requiredText(env, "TEST_ALLOWED_HOSTS"));
    if (!allowedHosts.has(publicUrl.hostname.toLowerCase())) {
        throw new Error("TEST_PUBLIC_HOST_NOT_ALLOWLISTED");
    }

    const productionOrigin = normalizeHttpsOrigin(
        requiredText(env, "PRODUCTION_PUBLIC_BASE_URL"),
        "PRODUCTION_PUBLIC_BASE_URL"
    );
    if (productionOrigin === publicUrl.origin) {
        throw new Error("TEST_PUBLIC_URL_MUST_DIFFER_FROM_PRODUCTION");
    }

    const ids = {};
    for (const name of [
        "TEST_GUILD_ID",
        "TEST_TEXT_CHANNEL_ID",
        "TEST_VOICE_CHANNEL_ID",
        "TEST_DISCORD_CLIENT_ID"
    ]) {
        ids[name] = normalizeDiscordSnowflake(requiredText(env, name));
        if (!ids[name]) throw new Error(`INVALID_${name}`);
    }

    return {
        mongoUri,
        databaseName,
        botToken: requiredText(env, "TEST_DISCORD_TOKEN"),
        clientId: ids.TEST_DISCORD_CLIENT_ID,
        clientSecret: requiredText(env, "TEST_DISCORD_CLIENT_SECRET"),
        guildId: ids.TEST_GUILD_ID,
        textChannelId: ids.TEST_TEXT_CHANNEL_ID,
        voiceChannelId: ids.TEST_VOICE_CHANNEL_ID,
        publicBaseUrl: publicUrl.toString().replace(/\/$/, ""),
        productionOrigin,
        allowedHosts: [...allowedHosts].sort(),
        commitSha,
        recordDir: String(env.GATE_RECORD_DIR || "artifacts").trim() || "artifacts"
    };
}

function hashIdentifier(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function redactSecrets(message, config) {
    let text = String(message || "");
    const secrets = [config?.mongoUri, config?.botToken, config?.clientSecret]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.split(secret).join("[REDACTED]");
    return text.slice(0, 500);
}

async function runMongoGate(config) {
    const connection = await mongoose.createConnection(config.mongoUri, {
        maxPoolSize: 2,
        minPoolSize: 0,
        serverSelectionTimeoutMS: 10000,
        socketTimeoutMS: 15000
    }).asPromise();

    const markerId = `environment-gate:${config.commitSha}:${crypto.randomUUID()}`;
    const collection = connection.collection("environment_gate_records");
    try {
        if (connection.name !== config.databaseName) throw new Error("MONGO_DATABASE_NAME_MISMATCH");
        await connection.db.admin().ping();
        await collection.insertOne({ _id: markerId, createdAt: new Date(), commitSha: config.commitSha });
        const stored = await collection.findOne({ _id: markerId });
        if (!stored) throw new Error("MONGO_WRITE_READ_FAILED");
        const removed = await collection.deleteOne({ _id: markerId });
        if (removed.deletedCount !== 1) throw new Error("MONGO_DELETE_FAILED");
        return { database: config.databaseName, writeReadDelete: true };
    } finally {
        await collection.deleteOne({ _id: markerId }).catch(() => null);
        await connection.close().catch(() => null);
    }
}

async function requestClientCredentials(config) {
    const body = new URLSearchParams({
        grant_type: "client_credentials",
        scope: "applications.commands.update"
    });
    const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`, "utf8").toString("base64");
    const response = await fetch("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: {
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded"
        },
        body
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || !payload.access_token) {
        throw new Error(`OAUTH_CLIENT_CREDENTIALS_FAILED:${response.status}`);
    }
    const scope = String(payload.scope || "");
    payload.access_token = null;
    return { clientCredentials: true, scope };
}

async function runDiscordBotGate(config) {
    const client = new Client({
        intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });
    let message = null;
    let voiceConnection = null;
    try {
        await client.login(config.botToken);
        if (!client.user || String(client.user.id) !== config.clientId) {
            throw new Error("BOT_APPLICATION_ID_MISMATCH");
        }

        const guild = await client.guilds.fetch(config.guildId);
        const textChannel = await guild.channels.fetch(config.textChannelId);
        const voiceChannel = await guild.channels.fetch(config.voiceChannelId);
        if (!textChannel?.isTextBased?.() || typeof textChannel.send !== "function") {
            throw new Error("TEST_TEXT_CHANNEL_NOT_SENDABLE");
        }
        if (!voiceChannel?.isVoiceBased?.()) throw new Error("TEST_VOICE_CHANNEL_NOT_VOICE_BASED");

        message = await textChannel.send({
            content: `[isolated environment gate] ${config.commitSha.slice(0, 12)}`,
            allowedMentions: { parse: [] }
        });
        if (!message?.id) throw new Error("DISCORD_MESSAGE_CREATE_FAILED");

        voiceConnection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: guild.id,
            adapterCreator: guild.voiceAdapterCreator,
            selfDeaf: true,
            selfMute: true
        });
        await entersState(voiceConnection, VoiceConnectionStatus.Ready, 20000);

        await message.delete();
        message = null;
        voiceConnection.destroy();
        voiceConnection = null;

        return {
            bot: hashIdentifier(client.user.id),
            guild: hashIdentifier(guild.id),
            textChannel: hashIdentifier(textChannel.id),
            voiceChannel: hashIdentifier(voiceChannel.id),
            messageWriteDelete: true,
            botVoiceConnectDisconnect: true
        };
    } finally {
        if (voiceConnection) {
            try { voiceConnection.destroy(); } catch {}
        }
        if (message) await message.delete().catch(() => null);
        client.destroy();
    }
}

function runDeploymentSmoke(config) {
    const result = spawnSync(
        process.execPath,
        [path.join(__dirname, "smokeUnifiedRuntime.js"), config.publicBaseUrl],
        {
            encoding: "utf8",
            timeout: 120000,
            env: {
                ...process.env,
                SMOKE_ALLOWED_HOSTS: config.allowedHosts.join(","),
                SMOKE_EXPECTED_COMMIT_SHA: config.commitSha,
                SMOKE_REQUIRE_PREVIEW: "true"
            },
            maxBuffer: 1024 * 1024
        }
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`DEPLOYMENT_SMOKE_FAILED:${result.status}:${String(result.stderr || result.stdout || "").slice(-240)}`);
    }
    return { deployedHttpsSmoke: true };
}

function writeRecord(config, record) {
    const directory = path.resolve(config.recordDir);
    fs.mkdirSync(directory, { recursive: true });
    const safeSha = String(config.commitSha || "local").replace(/[^a-fA-F0-9_-]/g, "").slice(0, 64) || "local";
    const filename = path.join(directory, `environment-gate-${safeSha}.json`);
    fs.writeFileSync(filename, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    return filename;
}

async function main() {
    let config = null;
    const startedAt = new Date().toISOString();
    const record = {
        schemaVersion: 1,
        status: "failed",
        startedAt,
        finishedAt: null,
        commitSha: String(process.env.TEST_COMMIT_SHA || process.env.GITHUB_SHA || "local"),
        evidence: {}
    };

    try {
        config = validateIsolatedEnvironment(process.env);
        record.commitSha = config.commitSha;
        record.environment = {
            database: config.databaseName,
            deploymentOriginHash: hashIdentifier(new URL(config.publicBaseUrl).origin),
            productionOriginHash: hashIdentifier(config.productionOrigin),
            guildHash: hashIdentifier(config.guildId)
        };
        record.evidence.mongo = await runMongoGate(config);
        record.evidence.oauth = await requestClientCredentials(config);
        record.evidence.discord = await runDiscordBotGate(config);
        record.evidence.deployment = runDeploymentSmoke(config);
        record.evidence.selfBotLiveAutomation = {
            executed: false,
            reason: "Discord standard-user automation is not part of the compliant live gate"
        };
        record.status = "passed";
        return record;
    } catch (error) {
        record.error = redactSecrets(error?.message || error, config);
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { gateRecord: record, gateConfig: config });
    } finally {
        record.finishedAt = new Date().toISOString();
        const fallbackConfig = config || {
            commitSha: record.commitSha,
            recordDir: String(process.env.GATE_RECORD_DIR || "artifacts")
        };
        const filename = writeRecord(fallbackConfig, record);
        console.log(`[ENV-GATE] record=${filename} status=${record.status}`);
    }
}

if (require.main === module) {
    main()
        .then(() => {
            console.log("[ENV-GATE] isolated environment verification passed");
        })
        .catch(error => {
            const config = error?.gateConfig || null;
            console.error(`[ENV-GATE] failed: ${redactSecrets(error?.message || error, config)}`);
            process.exitCode = 1;
        });
}

module.exports = {
    REQUIRED_NAMES,
    databaseNameFromMongoUri,
    exactAllowedHosts,
    hashIdentifier,
    normalizeHttpsOrigin,
    redactSecrets,
    validateIsolatedEnvironment
};
