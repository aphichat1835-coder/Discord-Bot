"use strict";

const QuestLogRepository = require("../../sqlite/repositories/core/QuestLogRepository");
const ScheduledRunnerRepository = require("../../sqlite/repositories/core/ScheduledRunnerRepository");

let questLogInstance = null;
let scheduledRunnerInstance = null;

function getQuestLogRepository() {
    if (!questLogInstance) questLogInstance = new QuestLogRepository();
    return questLogInstance;
}

function getScheduledRunnerRepository() {
    if (!scheduledRunnerInstance) scheduledRunnerInstance = new ScheduledRunnerRepository();
    return scheduledRunnerInstance;
}

module.exports = {
    getQuestLogRepository,
    getScheduledRunnerRepository
};
