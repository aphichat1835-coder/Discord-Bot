const IDS = {
    BTN_START: "btn_start",
    BTN_STATUS: "btn_status",
    BTN_STOP_ALL: "btn_stop_all",
    BTN_RESTORE_CANCEL: "btn_restore_cancel",
    MODAL_START: "modal_start",
    FIELD_TOKEN: "token",
    FIELD_SERVER_ID: "server_id",
    FIELD_VOICE_ID: "voice_id",
    BTN_QUEST_RUN: "quest_panel:run",
    BTN_QUEST_RUN_ONESHOT: "quest_panel:run_oneshot",
    BTN_QUEST_RUN_DAILY: "quest_panel:run_daily",
    BTN_QUEST_STOP: "quest_panel:stop",
    BTN_QUEST_REFRESH: "runner-stop:refresh",
    BTN_QUEST_STOP_ALL: "runner-stop:all",
    SELECT_QUEST_STOP: "runner-stop:select",
    MODAL_QUEST_RUN: "quest_run_modal",
    FIELD_QUEST_TOKENS: "user_tokens"
};

const PREFIXES = {
    VERIFY_ROLE: "verify_role_",
    VERIFY_OAUTH: "verify_oauth_",
    RESTORE_CONFIRM: "btn_restore_confirm_",
    STATUS_PAGE: "status_page_",
    STATUS_STOP: "status_stop_",
    QUEST_PANEL: "quest_panel:",
    RUNNER_STOP: "runner-stop:"
};

function isVerifyButton(customId = "") {
    return customId.startsWith(PREFIXES.VERIFY_ROLE) ||
        customId.startsWith(PREFIXES.VERIFY_OAUTH);
}

function isQuestButton(customId = "") {
    return customId.startsWith(PREFIXES.QUEST_PANEL) ||
        customId.startsWith(PREFIXES.RUNNER_STOP);
}

function isQuestModal(customId = "") {
    return customId.startsWith(IDS.MODAL_QUEST_RUN);
}

function isQuestSelect(customId = "") {
    return customId === IDS.SELECT_QUEST_STOP;
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
    isQuestButton,
    isQuestModal,
    isQuestSelect,
    isRestoreConfirm,
    isStatusPage,
    getStatusPage,
    isStatusStop,
    getStatusStopSessionId
};
