"use strict";

const allToTargetMode = require("./allToTargetMode");
const guildToGuildMode = require("./guildToGuildMode");

const modes = new Map([
    [allToTargetMode.id, allToTargetMode],
    [guildToGuildMode.id, guildToGuildMode]
]);

const DEFAULT_MODE_ID = allToTargetMode.id;

function getMode(id) {
    const key = String(id || "").trim();
    return modes.get(key) || modes.get(DEFAULT_MODE_ID);
}

function listModes() {
    return Array.from(modes.values());
}

module.exports = {
    getMode,
    listModes,
    DEFAULT_MODE_ID
};
