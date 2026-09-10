"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { spawnSync } = require("node:child_process");
const { analyzeSource } = require("../../scripts/checkMongoose9Compatibility");

function codes(source) {
    return analyzeSource(source).map(item => item.code);
}

test("Mongoose 9 AST scanner flags removed pre middleware next callbacks", () => {
    assert.deepEqual(codes('schema.pre("save", function(next) { next(); });'), ["pre-middleware-next-callback"]);
    assert.deepEqual(codes('schema.pre("save", true, next => next());'), ["pre-middleware-next-callback"]);
    assert.deepEqual(codes('schema.pre("save", { document: true }, (next) => next());'), ["pre-middleware-next-callback"]);
    assert.deepEqual(codes('schema.pre("save", /* migration note */ function(next) { next(); });'), ["pre-middleware-next-callback"]);
    assert.deepEqual(codes('schema.pre("save", // migration note\nfunction(next) { next(); });'), ["pre-middleware-next-callback"]);
});

test("Mongoose 9 AST scanner ignores comments and quoted examples", () => {
    assert.deepEqual(codes('// schema.pre("save", function(next) {})\nconst value = 1;'), []);
    assert.deepEqual(codes('/* schema.pre("save", function(next) {}) */ const value = 1;'), []);
    assert.deepEqual(codes(`const example = 'schema.pre("save", function(next) {})';`), []);
    assert.deepEqual(codes('const example = `schema.pre("save", function(next) {})`;'), []);
});

test("Mongoose 9 AST scanner resolves named callbacks", () => {
    assert.deepEqual(codes('function beforeSave(next) { next(); } schema.pre("save", beforeSave);'), [
        "pre-middleware-next-callback"
    ]);
    assert.deepEqual(codes('const beforeSave = async () => work(); schema.pre("save", beforeSave);'), []);
    assert.deepEqual(codes('const callback = error => done(error); Model.updateOne(filter, update, callback);'), [
        "updateOne-callback"
    ]);
});

test("Mongoose 9 AST scanner allows supported post middleware next signatures", () => {
    assert.deepEqual(codes('schema.post("save", function(doc, next) { next(); });'), []);
});

test("Mongoose 9 AST scanner flags callback doValidate and updateOne forms", () => {
    assert.deepEqual(codes('schema.path("name").doValidate(value, function(error) {});'), ["doValidate-callback"]);
    assert.deepEqual(codes('Model.updateOne(filter, update, (error) => { done(error); });'), ["updateOne-callback"]);
    assert.deepEqual(codes('document.updateOne(update, async error => { report(error); });'), ["updateOne-callback"]);
});

test("Mongoose 9 AST scanner allows Promise-based middleware and updates", () => {
    assert.deepEqual(codes('schema.pre("save", async function() { await work(); });'), []);
    assert.deepEqual(codes('await Model.updateOne(filter, update, options);'), []);
});

test("Mongoose 9 CLI scanner reads source from stdin instead of opening dynamic paths", () => {
    const scanner = require.resolve("../../scripts/checkMongoose9Compatibility");
    const blocked = spawnSync(process.execPath, [scanner, "discord/models/Example.js"], {
        input: 'schema.pre("save", function(next) { next(); });',
        encoding: "utf8"
    });
    const clean = spawnSync(process.execPath, [scanner, "discord/models/Example.js"], {
        input: 'schema.pre("save", async function() { await work(); });',
        encoding: "utf8"
    });

    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /discord\/models\/Example\.js:1 pre-middleware-next-callback/);
    assert.equal(clean.status, 0);
    assert.equal(clean.stderr, "");
});
