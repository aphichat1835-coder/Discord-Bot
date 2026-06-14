const IDS = {
    BTN_START: "btn_start",
    BTN_STATUS: "btn_status",
    BTN_STOP_ALL: "btn_stop_all",
    BTN_RESTORE_CANCEL: "btn_restore_cancel",
    MODAL_START: "modal_start",
    FIELD_TOKEN: "token",
    FIELD_SERVER_ID: "server_id",
    FIELD_VOICE_ID: "voice_id"
};

const PREFIXES = {
    VERIFY_ROLE: "verify_role_",
    VERIFY_OAUTH: "verify_oauth_",
    RESTORE_CONFIRM: "btn_restore_confirm_",
    STATUS_PAGE: "status_page_",
    STATUS_STOP: "status_stop_"
};

function isVerifyButton(customId = "") {
    return customId.startsWith(PREFIXES.VERIFY_ROLE) ||
        customId.startsWith(PREFIXES.VERIFY_OAUTH);
}

function isRestoreConfirm(customId = "") {
    return customId.startsWith(PREFIXES.RESTORE_CONFIRM);
}

function isStatusPage(customId = "") {
    return customId.startsWith(PREFIXES.STATUS_PAGE);
}

function getStatusPage(customId = "") {
    return Number.parseInt(customId.split("_")[2], 10) || 0;
}

function isStatusStop(customId = "") {
    return customId.startsWith(PREFIXES.STATUS_STOP);
}

function getStatusStopSessionId(customId = "") {
    return customId.replace(PREFIXES.STATUS_STOP, "");
}

module.exports = {
    IDS,
    PREFIXES,
    isVerifyButton,
    isRestoreConfirm,
    isStatusPage,
    getStatusPage,
    isStatusStop,
    getStatusStopSessionId
};
