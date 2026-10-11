"use strict";

const DmNotificationRepository = require("../../sqlite/repositories/core/DmNotificationRepository");

let dmNotificationInstance = null;

function getDmNotificationRepository() {
    if (!dmNotificationInstance) dmNotificationInstance = new DmNotificationRepository();
    return dmNotificationInstance;
}

module.exports = {
    getDmNotificationRepository
};
