"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const {
    isDestructiveMigration,
    _stripSqlCommentsAndLiterals
} = require("../../database/sqlite/migrations/migrationRunner");

describe("SQL Comment & Literal Stripper Regression Suite", () => {
    describe("_stripSqlCommentsAndLiterals unit behavior", () => {
        test("strips single-line comments and preserves trailing newline", () => {
            const sql = "SELECT * FROM users; -- line comment\nSELECT * FROM orders;";
            const stripped = _stripSqlCommentsAndLiterals(sql);
            assert.ok(!stripped.includes("line comment"));
            assert.ok(stripped.includes("SELECT * FROM users;"));
            assert.ok(stripped.includes("SELECT * FROM orders;"));
        });

        test("strips block comments across single and multiple lines", () => {
            const sql = "SELECT /* inline block */ 1;\n/* multi\nline\nblock */\nSELECT 2;";
            const stripped = _stripSqlCommentsAndLiterals(sql);
            assert.ok(!stripped.includes("inline block"));
            assert.ok(!stripped.includes("multi"));
            assert.ok(!stripped.includes("line"));
            assert.ok(stripped.includes("SELECT"));
        });

        test("strips single-quoted string literals including escaped quotes", () => {
            const sql = "INSERT INTO t VALUES ('simple string', 'escaped '' quote '' here');";
            const stripped = _stripSqlCommentsAndLiterals(sql);
            assert.ok(!stripped.includes("simple string"));
            assert.ok(!stripped.includes("escaped"));
            assert.ok(!stripped.includes("quote"));
            assert.ok(stripped.includes("INSERT INTO t VALUES"));
        });

        test("strips double-quoted literals including escaped double quotes", () => {
            const sql = 'SELECT "col name", "escaped "" name "" here" FROM t;';
            const stripped = _stripSqlCommentsAndLiterals(sql);
            assert.ok(!stripped.includes("col name"));
            assert.ok(!stripped.includes("escaped"));
            assert.ok(stripped.includes("SELECT"));
            assert.ok(stripped.includes("FROM t;"));
        });

        test("handles unterminated comments gracefully without infinite loop", () => {
            const unterminatedBlock = "SELECT 1; /* unterminated block comment";
            const strippedBlock = _stripSqlCommentsAndLiterals(unterminatedBlock);
            assert.ok(strippedBlock.includes("SELECT 1;"));
            assert.ok(!strippedBlock.includes("unterminated"));

            const unterminatedLine = "SELECT 2; -- unterminated line at EOF";
            const strippedLine = _stripSqlCommentsAndLiterals(unterminatedLine);
            assert.ok(strippedLine.includes("SELECT 2;"));
            assert.ok(!strippedLine.includes("unterminated"));
        });

        test("handles unterminated quoted literals gracefully", () => {
            const unterminatedSingle = "SELECT 1; 'unterminated single quote literal";
            const strippedSingle = _stripSqlCommentsAndLiterals(unterminatedSingle);
            assert.ok(strippedSingle.includes("SELECT 1;"));
            assert.ok(!strippedSingle.includes("unterminated"));

            const unterminatedDouble = 'SELECT 2; "unterminated double quote literal';
            const strippedDouble = _stripSqlCommentsAndLiterals(unterminatedDouble);
            assert.ok(strippedDouble.includes("SELECT 2;"));
            assert.ok(!strippedDouble.includes("unterminated"));
        });
    });

    describe("isDestructiveMigration real destructive statements", () => {
        test("detects DROP TABLE variations", () => {
            assert.equal(isDestructiveMigration("DROP TABLE users;"), true);
            assert.equal(isDestructiveMigration("drop table users;"), true);
            assert.equal(isDestructiveMigration("DROP   TABLE   `users`;"), true);
            assert.equal(isDestructiveMigration("DROP\nTABLE\nusers;"), true);
            assert.equal(isDestructiveMigration("DROP TABLE IF EXISTS audit_logs;"), true);
            assert.equal(isDestructiveMigration("CREATE TABLE foo (id INT);\nDROP TABLE bar;"), true);
        });

        test("detects DROP COLUMN variations", () => {
            assert.equal(isDestructiveMigration("ALTER TABLE users DROP COLUMN email;"), true);
            assert.equal(isDestructiveMigration("alter table users drop   column phone;"), true);
            assert.equal(isDestructiveMigration("ALTER TABLE users DROP\nCOLUMN bio;"), true);
        });

        test("detects TRUNCATE variations", () => {
            assert.equal(isDestructiveMigration("TRUNCATE TABLE logs;"), true);
            assert.equal(isDestructiveMigration("truncate table logs;"), true);
            assert.equal(isDestructiveMigration("TRUNCATE sessions;"), true);
            assert.equal(isDestructiveMigration("truncate events;"), true);
        });
    });

    describe("isDestructiveMigration safety for false-positive triggers", () => {
        test("ignores keywords in single-line comments", () => {
            const sql = "-- DROP TABLE users;\n-- TRUNCATE logs;\nCREATE TABLE users (id INT);";
            assert.equal(isDestructiveMigration(sql), false);
        });

        test("ignores keywords in multi-line block comments", () => {
            const sql = "/*\nDROP TABLE users;\nALTER TABLE users DROP COLUMN phone;\nTRUNCATE audit_logs;\n*/\nCREATE TABLE safe (id INT);";
            assert.equal(isDestructiveMigration(sql), false);
        });

        test("ignores keywords inside single-quoted strings", () => {
            const sql = "INSERT INTO logs (msg) VALUES ('DROP TABLE was executed by admin');";
            assert.equal(isDestructiveMigration(sql), false);
        });

        test("ignores keywords inside strings with escaped quotes", () => {
            const sql = "INSERT INTO logs (msg) VALUES ('Notice: ''DROP TABLE'' is not allowed');";
            assert.equal(isDestructiveMigration(sql), false);

            const sqlMultipleEscapes = "INSERT INTO logs VALUES ('a''''b DROP TABLE c''''d');";
            assert.equal(isDestructiveMigration(sqlMultipleEscapes), false);
        });

        test("ignores keywords inside double-quoted strings", () => {
            const sql = 'SELECT "DROP TABLE", "TRUNCATE" FROM config;';
            assert.equal(isDestructiveMigration(sql), false);

            const sqlEscapedDouble = 'SELECT "quoted "" DROP TABLE "" string" FROM config;';
            assert.equal(isDestructiveMigration(sqlEscapedDouble), false);
        });

        test("ignores keywords in unterminated comments and strings", () => {
            assert.equal(isDestructiveMigration("-- DROP TABLE unterminated"), false);
            assert.equal(isDestructiveMigration("/* DROP TABLE unterminated"), false);
            assert.equal(isDestructiveMigration("'DROP TABLE unterminated"), false);
            assert.equal(isDestructiveMigration('"DROP TABLE unterminated'), false);
        });

        test("passes standard non-destructive DDL and DML statements", () => {
            assert.equal(isDestructiveMigration("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);"), false);
            assert.equal(isDestructiveMigration("CREATE INDEX idx_items_name ON items(name);"), false);
            assert.equal(isDestructiveMigration("ALTER TABLE items ADD COLUMN age INTEGER;"), false);
            assert.equal(isDestructiveMigration("INSERT INTO items VALUES (1, 'apple', 5);"), false);
            assert.equal(isDestructiveMigration("UPDATE items SET age = 6 WHERE id = 1;"), false);
            assert.equal(isDestructiveMigration("SELECT * FROM items WHERE name = 'banana';"), false);
            assert.equal(isDestructiveMigration(""), false);
            assert.equal(isDestructiveMigration(null), false);
            assert.equal(isDestructiveMigration(undefined), false);
        });
    });

    describe("Performance and ReDoS Resistance", () => {
        test("executes in linear time on large adversarial inputs (100k characters)", () => {
            // Adversarial patterns: repetitive unclosed tokens, asterisks, dashes, escaped quotes
            const repetitiveComments = "/* " + "*".repeat(40000) + " / ".repeat(10000) + " */\n";
            const repetitiveQuotes = "INSERT INTO t VALUES ('" + "''".repeat(20000) + "');\n";
            const repetitiveDashes = "--" + "-".repeat(30000) + "\n";
            const largeInput = repetitiveComments + repetitiveQuotes + repetitiveDashes + "CREATE TABLE final_check (id INT);";

            assert.ok(largeInput.length > 100000, `Input length should exceed 100k chars (got ${largeInput.length})`);

            const startTime = Date.now();
            const result = isDestructiveMigration(largeInput);
            const durationMs = Date.now() - startTime;

            assert.equal(result, false, "Adversarial input should not trigger destructive flag");
            assert.ok(
                durationMs < 100,
                `Linear scanner must process 100k+ chars within 100ms (completed in ${durationMs}ms)`
            );
        });
    });
});
