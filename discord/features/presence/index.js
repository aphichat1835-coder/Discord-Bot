"use strict";

const constants = require("./constants");
const gatewayPlatform = require("./gatewayPlatform");
const { PresenceScheduler, sanitizeItem } = require("./presenceScheduler");
const { PresenceManager, presenceManager } = require("./presenceManager");

module.exports = {
    ...constants,
    gatewayPlatform,
    ...gatewayPlatform,
    PresenceScheduler,
    sanitizeItem,
    PresenceManager,
    presenceManager
};
