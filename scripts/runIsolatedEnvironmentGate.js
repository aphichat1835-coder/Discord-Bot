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
    "PRODUCTION_PUBLIC_BASE_URL",
    "PRODUCTION_DISCORD_CLIENT_IDS",
    "PRODUCTION_GUILD_IDS",
    "PRODUCTION_CHANNEL_IDS"
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

function exactSnowflakeSet(value, errorCode) {
    const ids = new Set();
    for (const item of String(value || "").split(",").map(entry => entry.trim()).filter(Boolean)) {
        const normalized = normalizeDiscordSnowflake(item);
        if (!normalized) throw new Error(`INVALID_${errorCode}`);
        ids.add(normalized);
    }
    if (!ids.size) throw new Error(`MISSING_${errorCode}`);
    return ids;
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

    const productionClientIds = exactSnowflakeSet(
        requiredText(env, "PRODUCTION_DISCORD_CLIENT_IDS"),
        "PRODUCTION_DISCORD_CLIENT_IDS"
    );
    const productionGuildIds = exactSnowflakeSet(
        requiredText(env, "PRODUCTION_GUILD_IDS"),
        "PRODUCTION_GUILD_IDS"
    );
    const productionChannelIds = exactSnowflakeSet(
        requiredText(env, "PRODUCTION_CHANNEL_IDS"),
        "PRODUCTION_CHANNEL_IDS"
    );
    if (productionClientIds.has(ids.TEST_DISCORD_CLIENT_ID)) {
        throw new Error("TEST_DISCORD_CLIENT_MUST_DIFFER_FROM_PRODUCTION");
    }
    if (productionGuildIds.has(ids.TEST_GUILD_ID)) {
        throw new Error("TEST_GUILD_MUST_DIFFER_FROM_PRODUCTION");
    }
    if (productionChannelIds.has(ids.TEST_TEXT_CHANNEL_ID) || productionChannelIds.has(ids.TEST_VOICE_CHANNEL_ID)) {
        throw new Error("TEST_CHANNELS_MUST_DIFFER_FROM_PRODUCTION");
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
        productionResourceCounts: {
            clients: productionClientIds.size,
            guilds: productionGuildIds.size,
            channels: productionChannelIds.size
        },
        allowedHosts: [...allowedHosts].sort((a, b) => a.localeCompare(b)),
        commitSha,
        recordDir: String(env.GATE_RECORD_DIR || "artifacts").trim() || "artifacts"
    };
}

function hashIdentifier(value) {
    return crypto.createHash("sha256").update(String(value || "")).digest("hex").slice(0, 16);
}

function normalizeRecordSha(value) {
    const normalized = String(value || "").trim().toLowerCase();
    return /^[a-f0-9]{40}$/.test(normalized) ? normalized : "local";
}

function resolveRecordDirectory(recordDir, repositoryRoot = path.resolve(__dirname, "..")) {
    const root = path.resolve(repositoryRoot);
    const directory = path.resolve(root, String(recordDir || "artifacts"));
    const relative = path.relative(root, directory);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
        const error = new Error("ENV_GATE_RECORD_DIRECTORY_OUTSIDE_REPOSITORY");
        error.code = "ENV_GATE_RECORD_DIRECTORY_OUTSIDE_REPOSITORY";
        throw error;
    }
    return directory;
}

function currentCheckoutSha(options = {}) {
    if (typeof options.currentCheckoutSha === "function") {
        return String(options.currentCheckoutSha() || "").trim().toLowerCase();
    }
    const gitBinary = process.platform === "win32" ? "git.exe" : "/usr/bin/git";
    const result = spawnSync(gitBinary, ["rev-parse", "HEAD"], {
        cwd: path.resolve(__dirname, ".."),
        encoding: "utf8",
        timeout: 10000
    });
    if (result.error || result.status !== 0) {
        const error = new Error("CURRENT_COMMIT_SHA_UNAVAILABLE");
        error.code = "CURRENT_COMMIT_SHA_UNAVAILABLE";
        throw error;
    }
    return String(result.stdout || "").trim().toLowerCase();
}

function assertCurrentCheckoutSha(expectedSha, options = {}) {
    const actualSha = currentCheckoutSha(options);
    if (!/^[a-f0-9]{40}$/.test(actualSha)) {
        const error = new Error("INVALID_CURRENT_COMMIT_SHA");
        error.code = "INVALID_CURRENT_COMMIT_SHA";
        throw error;
    }
    if (actualSha !== String(expectedSha || "").trim().toLowerCase()) {
        const error = new Error("TEST_COMMIT_SHA_MISMATCH");
        error.code = "TEST_COMMIT_SHA_MISMATCH";
        throw error;
    }
    return actualSha;
}

function gateErrorDetails(error) {
    const message = String(error?.message || error || "ENVIRONMENT_GATE_FAILED");
    const separator = message.indexOf(":");
    const messageCode = separator === -1 ? message : message.slice(0, separator);
    const detail = separator === -1 ? "" : message.slice(separator + 1);
    const errorCode = String(error?.code || messageCode || "ENVIRONMENT_GATE_FAILED");
    const missing = errorCode === "MISSING_TEST_ENVIRONMENT"
        ? detail.split(",").map(item => item.trim()).filter(Boolean).sort((a, b) => a.localeCompare(b))
        : [];
    return { errorCode, missing };
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
    const directory = resolveRecordDirectory(config.recordDir);
    fs.mkdirSync(directory, { recursive: true });
    const safeSha = normalizeRecordSha(config.commitSha);
    const filename = path.join(directory, `environment-gate-${safeSha}.json`);
    fs.writeFileSync(filename, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    return filename;
}

function persistGateRecord(config, record, options = {}) {
    const writer = options.writer || writeRecord;
    const logger = options.logger || console;
    try {
        const filename = writer(config, record);
        logger.log(`[ENV-GATE] record=${filename} status=${record.status}`);
        return { ok: true, filename, error: null };
    } catch (writeError) {
        const safeMessage = redactSecrets(writeError?.message || writeError, config);
        logger.error(`[ENV-GATE] record write failed: ${safeMessage}`);
        return {
            ok: false,
            filename: null,
            error: Object.assign(new Error(safeMessage || "environment gate record write failed"), {
                code: "ENV_GATE_RECORD_WRITE_FAILED"
            })
        };
    }
}

async function runIsolatedEnvironmentGate(env = process.env, options = {}) {
    let config = null;
    let primaryError = null;
    const record = {
        schemaVersion: 1,
        status: "failed",
        startedAt: new Date().toISOString(),
        finishedAt: null,
        commitSha: String(env.TEST_COMMIT_SHA || env.GITHUB_SHA || "local"),
        evidence: {}
    };

    try {
        config = validateIsolatedEnvironment(env);
        assertCurrentCheckoutSha(config.commitSha, options);
        record.commitSha = config.commitSha;
        record.environment = {
            database: config.databaseName,
            deploymentOriginHash: hashIdentifier(new URL(config.publicBaseUrl).origin),
            productionOriginHash: hashIdentifier(config.productionOrigin),
            productionResourceCounts: config.productionResourceCounts,
            guildHash: hashIdentifier(config.guildId)
        };
        record.evidence.mongo = await (options.runMongoGate || runMongoGate)(config);
        record.evidence.oauth = await (options.requestClientCredentials || requestClientCredentials)(config);
        record.evidence.discord = await (options.runDiscordBotGate || runDiscordBotGate)(config);
        record.evidence.deployment = await (options.runDeploymentSmoke || runDeploymentSmoke)(config);
        record.evidence.selfBotLiveAutomation = {
            executed: false,
            reason: "Discord standard-user automation is not part of the compliant live gate"
        };
        record.status = "passed";
    } catch (error) {
        const details = gateErrorDetails(error);
        record.error = redactSecrets(error?.message || error, config);
        record.errorCode = details.errorCode;
        if (details.missing.length) record.missing = details.missing;
        primaryError = Object.assign(error instanceof Error ? error : new Error(String(error)), {
            gateRecord: record,
            gateConfig: config
        });
    }

    record.finishedAt = new Date().toISOString();
    const fallbackConfig = config || {
        commitSha: record.commitSha,
        recordDir: String(env.GATE_RECORD_DIR || "artifacts")
    };
    const persistence = persistGateRecord(fallbackConfig, record, {
        writer: options.writer,
        logger: options.logger
    });
    if (!persistence.ok) {
        if (primaryError) {
            primaryError.recordPersistenceError = persistence.error.message;
        } else {
            primaryError = Object.assign(persistence.error, {
                gateRecord: record,
                gateConfig: config
            });
        }
    }
    if (primaryError) throw primaryError;
    return record;
}

async function main() {
    return runIsolatedEnvironmentGate(process.env);
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
    assertCurrentCheckoutSha,
    databaseNameFromMongoUri,
    exactAllowedHosts,
    exactSnowflakeSet,
    gateErrorDetails,
    hashIdentifier,
    normalizeHttpsOrigin,
    normalizeRecordSha,
    persistGateRecord,
    redactSecrets,
    resolveRecordDirectory,
    runIsolatedEnvironmentGate,
    validateIsolatedEnvironment,
    writeRecord
};