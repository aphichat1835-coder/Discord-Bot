"use strict";

function getAdminUser(req) {
    return req.verificationOwner === true
        ? { id: "owner-dashboard", username: "Owner" }
        : null;
}

function getAdminId(req) {
    const user = getAdminUser(req);
    return user?.id || user?.userId || user?.discordId || null;
}

module.exports = { getAdminUser, getAdminId };
