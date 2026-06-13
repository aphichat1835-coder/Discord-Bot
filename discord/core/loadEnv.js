const fs = require("fs");
const path = require("path");

function parseEnvLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed || trimmed.startsWith("#")) return null;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) return null;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

    let value = trimmed.slice(eq + 1).trim();
    if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
    ) {
        value = value.slice(1, -1);
    }

    return [key, value.replace(/\\n/g, "\n")];
}

function loadEnvFile(filePath, env = process.env) {
    if (!filePath || !fs.existsSync(filePath)) return 0;

    let loaded = 0;
    const body = fs.readFileSync(filePath, "utf8");
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

loadLocalEnv();

module.exports = {
    parseEnvLine,
    loadEnvFile,
    loadLocalEnv
};
