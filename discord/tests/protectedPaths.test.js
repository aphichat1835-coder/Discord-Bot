const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function run(command, args, cwd) {
    return spawnSync(command, args, {
        cwd,
        encoding: "utf8",
        env: { ...process.env, CI: "false" }
    });
}

test("protected path guard fails closed cleanly when an approved file is deleted", () => { // NOSONAR -- node:test assertions are not recognized by Sonar S2699.
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "protected-paths-"));
    try {
        fs.mkdirSync(path.join(tempDir, "scripts"), { recursive: true });
        fs.mkdirSync(path.join(tempDir, "discord"), { recursive: true });
        fs.copyFileSync(
            path.join(__dirname, "../../scripts/checkProtectedPaths.js"),
            path.join(tempDir, "scripts/checkProtectedPaths.js")
        );
        fs.writeFileSync(path.join(tempDir, "discord/systemProvider.js"), "module.exports = {};\n");

        assert.equal(run("git", ["init"], tempDir).status, 0);
        assert.equal(run("git", ["config", "user.email", "test@example.com"], tempDir).status, 0);
        assert.equal(run("git", ["config", "user.name", "Test"], tempDir).status, 0);
        assert.equal(run("git", ["add", "."], tempDir).status, 0);
        assert.equal(run("git", ["commit", "-m", "baseline"], tempDir).status, 0);

        fs.unlinkSync(path.join(tempDir, "discord/systemProvider.js"));
        const result = run(process.execPath, ["scripts/checkProtectedPaths.js"], tempDir);
        const output = `${result.stdout || ""}\n${result.stderr || ""}`;

        assert.equal(result.status, 1);
        assert.match(output, /owner-locked files changed/);
        assert.match(output, /discord\/systemProvider\.js/);
        assert.doesNotMatch(output, /ENOENT|readFileSync|node:fs/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
