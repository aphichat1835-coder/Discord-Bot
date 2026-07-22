"use strict";

const path = require("node:path");
const testApi = require("node:test");
const { expect } = require("expect");
const jestMock = require("jest-mock");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const SETUP_FILE = __filename;
const activeSpies = new Set();

function formatCaseName(template, values) {
    let index = 0;
    return String(template).replace(/%[psdifjo]/g, token => {
        const value = values[index++];
        if (token === "%s") return String(value);
        if (["%d", "%i", "%f"].includes(token)) return String(Number(value));
        try {
            return JSON.stringify(value);
        } catch {
            return String(value);
        }
    });
}

function withEach(testFunction) {
    const compatible = (...args) => testFunction(...args);
    Object.assign(compatible, testFunction);
    compatible.each = cases => (name, callback, options) => {
        for (const item of cases) {
            const values = Array.isArray(item) ? item : [item];
            testFunction(formatCaseName(name, values), options || {}, () => callback(...values));
        }
    };
    return compatible;
}

function spyOn(target, property, accessType) {
    const spy = jestMock.spyOn(target, property, accessType);
    activeSpies.add(spy);
    return spy;
}

function restoreAllMocks() {
    for (const spy of activeSpies) spy.mockRestore();
    activeSpies.clear();
}

function resetModules() {
    restoreAllMocks();
    for (const filename of Object.keys(require.cache)) {
        if (filename === SETUP_FILE) continue;
        if (filename.startsWith(`${PROJECT_ROOT}${path.sep}`) && !filename.includes(`${path.sep}node_modules${path.sep}`)) {
            delete require.cache[filename];
        }
    }
}

global.test = withEach(testApi.test);
global.it = global.test;
global.describe = withEach(testApi.describe);
global.before = testApi.before;
global.after = testApi.after;
global.beforeAll = testApi.before;
global.afterAll = testApi.after;
global.beforeEach = testApi.beforeEach;
global.afterEach = testApi.afterEach;
global.expect = expect;
global.jest = {
    fn: jestMock.fn,
    isMockFunction: value => Boolean(value?._isMockFunction),
    resetModules,
    restoreAllMocks,
    spyOn
};
