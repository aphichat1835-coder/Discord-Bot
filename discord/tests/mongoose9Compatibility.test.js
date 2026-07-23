"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { analyzeSource } = require("../../scripts/checkMongoose9Compatibility");

function codes(source) {
    return analyzeSource(source).map(item => item.code);
}

test("Mongoose 9 scanner flags removed pre middleware next callbacks", () => {
    assert.deepEqual(codes('schema.pre("save", function(next) { next(); });'), [
        "pre-middleware-next-callback"
    ]);
    assert.deepEqual(codes('schema.pre("save", true, next => next());'), [
        "pre-middleware-next-callback"
    ]);
    assert.deepEqual(codes('schema.pre("save", { document: true }, (next) => next());'), [
        "pre-middleware-next-callback"
    ]);
});

test("Mongoose 9 scanner allows supported post middleware next signatures", () => {
    assert.deepEqual(codes('schema.post("save", function(doc, next) { next(); });'), []);
});

test("Mongoose 9 scanner flags callback doValidate and updateOne forms", () => {
    assert.deepEqual(codes('schema.path("name").doValidate(value, function(error) {});'), [
        "doValidate-callback"
    ]);
    assert.deepEqual(codes('Model.updateOne(filter, update, (error) => { done(error); });'), [
        "updateOne-callback"
    ]);
    assert.deepEqual(codes('document.updateOne(update, async error => { report(error); });'), [
        "updateOne-callback"
    ]);
});

test("Mongoose 9 scanner allows Promise-based middleware and updates", () => {
    assert.deepEqual(codes('schema.pre("save", async function() { await work(); });'), []);
    assert.deepEqual(codes('await Model.updateOne(filter, update, options);'), []);
});
