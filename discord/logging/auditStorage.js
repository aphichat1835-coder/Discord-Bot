"use strict";

// Protected compatibility boundary only. Enterprise Audit remains retired.
// Every operation delegates to the internal-event namespace and storage rules.
const internalEventStorage = require("./internalEventStorage");

module.exports = {
    normalizeAuditRecord: internalEventStorage.normalizeInternalEvent,
    saveAuditRecord: internalEventStorage.saveInternalEvent,
    getAuditRecord: internalEventStorage.getInternalEvent,
    listAuditRecords: internalEventStorage.listInternalEvents,

    normalizeInternalEvent: internalEventStorage.normalizeInternalEvent,
    saveInternalEvent: internalEventStorage.saveInternalEvent,
    getInternalEvent: internalEventStorage.getInternalEvent,
    listInternalEvents: internalEventStorage.listInternalEvents,
    storageKey: internalEventStorage.storageKey,
    indexKey: internalEventStorage.indexKey,
    canUseMongoStore: internalEventStorage.canUseMongoStore
};
