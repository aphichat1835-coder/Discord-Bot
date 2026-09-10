const fs = require("node:fs");
const path = require("node:path");

function parseEnvLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return null;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_]\w*$/.test(key)) return null;

    let value = trimmed.slice(eq + 1).trim();
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    return [key, value.replaceAll(String.raw`\n`, "\n")];
}

function loadEnvFile(filePath, env = process.env, fsApi = fs) {
    if (!filePath) return 0;

    const resolvedPath = String(filePath);
    if (path.basename(resolvedPath) !== ".env") return 0;
    if (!fsApi.existsSync(resolvedPath)) return 0;

    let loaded = 0;
    const body = fsApi.readFileSync(resolvedPath, "utf8");
    for (const line of body.split(/\r?\n/)) {
        const pair = parseEnvLine(line);
        if (!pair) continue;
        const [key, value] = pair;
        if (env[key] === undefined) {
            env[key] = value;
            loaded += 1;
        }
    }

    return loaded;
}

function loadLocalEnv(env = process.env) {
    const repoRoot = path.resolve(__dirname, "..", "..");
    const candidates = [
        path.resolve(process.cwd(), ".env"),
        path.resolve(repoRoot, ".env")
    ];

    let loaded = 0;
    for (const filePath of Array.from(new Set(candidates))) {
        loaded += loadEnvFile(filePath, env);
    }
    return loaded;
}

function deleteBlankEnvironmentValues(env = process.env) {
    let removed = 0;
    for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string" || value.trim() !== "") continue;
        delete env[key];
        removed += 1;
    }
    return removed;
}

loadLocalEnv();
deleteBlankEnvironmentValues();

module.exports = {
    parseEnvLine,
    loadEnvFile,
    loadLocalEnv,
    deleteBlankEnvironmentValues
};