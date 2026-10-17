"use strict";

const configModule = require("./config");
const modeRegistry = require("./modes/modeRegistry");
const joinCampaignService = require("./services/joinCampaignService");
const { runPreflight, validateGuildTargets } = require("./services/preflightService");
const campaignWorker = require("./worker/campaignWorker");
const { runStartupRecovery } = require("./recovery/startupRecovery");
const { handleJoinPanelCommand, isOwner } = require("./handlers/commandHandler");
const { isJoinCampaignInteraction, handleJoinCampaignInteraction } = require("./handlers/interactionRouter");
const database = require("../../../database/index");

function getJoinCampaignStatus() {
    const repository = database.repositories.joinCampaign;
    return joinCampaignService.getStatus(repository);
}

function listRecentCampaigns(options = {}) {
    const repository = database.repositories.joinCampaign;
    return joinCampaignService.getHistory(repository, options);
}

function getCampaignMetrics() {
    const repository = database.repositories.joinCampaign;
    return joinCampaignService.getMetrics(repository);
}

module.exports = {
    // Configuration
    getJoinCampaignConfig: configModule.getJoinCampaignConfig,
    isGuildAllowed: configModule.isGuildAllowed,

    // Modes & Registry
    getMode: modeRegistry.getMode,
    listModes: modeRegistry.listModes,

    // Services & Lifecycle
    joinCampaignService,
    runPreflight,
    validateGuildTargets,
    campaignWorker,
    runStartupRecovery,

    // Handlers
    handleJoinPanelCommand,
    isOwner,
    isJoinCampaignInteraction,
    handleJoinCampaignInteraction,

    // Status & Monitoring (Used by Dashboard Routes)
    getJoinCampaignStatus,
    listRecentCampaigns,
    getCampaignMetrics
};
