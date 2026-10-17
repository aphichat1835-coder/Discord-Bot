"use strict";

const mongo = require("./mongo/connection");
const sqlite = require("./sqlite/index");
const QuestLogRepository = require("./sqlite/repositories/core/QuestLogRepository");
const ScheduledRunnerRepository = require("./sqlite/repositories/core/ScheduledRunnerRepository");
const DmNotificationRepository = require("./sqlite/repositories/core/DmNotificationRepository");
const VerificationRecoveryRepository = require("./sqlite/repositories/core/VerificationRecoveryRepository");
const VerificationStateNonceRepository = require("./sqlite/repositories/temp/VerificationStateNonceRepository");
const { getCacheManager } = require("./sqlite/cache/cacheManager");
const { getVoiceEventRepository } = require("./sqlite/repositories/history/VoiceEventRepository");
const { getCommandEventRepository } = require("./sqlite/repositories/history/CommandEventRepository");
const { getSessionEventRepository } = require("./sqlite/repositories/history/SessionEventRepository");
const VoiceSessionRuntimeRepository = require("./sqlite/repositories/core/VoiceSessionRuntimeRepository");
const JoinCampaignRepository = require("./sqlite/repositories/core/JoinCampaignRepository");
const VerificationWebhookRepository = require("./sqlite/repositories/core/VerificationWebhookRepository");
const VoiceAdminRepository = require("./sqlite/repositories/core/VoiceAdminRepository");
const { getAssetCacheManager } = require("./sqlite/cache/assetCacheManager");
const scheduler = require("./sqlite/maintenance/scheduler");

let questLogRepo = null;
let scheduledRunnerRepo = null;
let dmNotificationRepo = null;
let verificationRecoveryRepo = null;
let verificationStateNonceRepo = null;
let voiceSessionRuntimeRepo = null;
let joinCampaignRepo = null;
let verificationWebhookRepo = null;
let voiceAdminRepo = null;

async function initialize(options = {}) {
    const results = {
        mongo: null,
        sqlite: null,
        ready: false
    };

    // 1. Connect MongoDB (Authoritative Core)
    if (options.connectMongo !== false && (process.env.MONGO_URI || options.mongoUri)) {
        await mongo.connectMongo(options.mongoUri);
        results.mongo = mongo.getMongoStatus();
    }

    // 2. Open & Validate SQLite (Local Operational DB)
    if (options.connectSqlite !== false) {
        results.sqlite = sqlite.initialize(options.sqlite || {});
    }

    // Initialize repository singletons
    questLogRepo = new QuestLogRepository();
    scheduledRunnerRepo = new ScheduledRunnerRepository();
    dmNotificationRepo = new DmNotificationRepository();
    verificationRecoveryRepo = new VerificationRecoveryRepository();
    verificationStateNonceRepo = new VerificationStateNonceRepository();
    voiceSessionRuntimeRepo = new VoiceSessionRuntimeRepository();
    joinCampaignRepo = new JoinCampaignRepository();
    verificationWebhookRepo = new VerificationWebhookRepository();
    voiceAdminRepo = new VoiceAdminRepository();

    // 3. Start 24/7 background maintenance scheduler
    if (options.startScheduler !== false) {
        scheduler.startScheduler();
    }

    results.ready = true;
    return results;
}

async function shutdown() {
    try {
        scheduler.stopScheduler();
        await scheduler.drainSchedulerTasks();
    } catch (_err) {
        // Ignored: Best-effort drain during shutdown
    }

    try {
        getCacheManager().stopTouchFlusher();
        getAssetCacheManager().stopTouchFlusher();
        getVoiceEventRepository().stopFlusher();
        getCommandEventRepository().stopFlusher();
        getSessionEventRepository().stopFlusher();
    } catch (_err) {
        // Ignored: Best-effort stop of cache and repository flushers
    }

    try {
        sqlite.shutdown();
    } catch (_err) {
        // Ignored: Best-effort SQLite shutdown
    }

    try {
        await mongo.disconnectMongo();
    } catch (_err) {
        // Ignored: Best-effort Mongo disconnect during shutdown
    }
}

function isReady() {
    return sqlite.isReady();
}

function getHealth() {
    return {
        mongo: mongo.getMongoStatus(),
        sqlite: sqlite.getHealth(),
        timestamp: Date.now()
    };
}

module.exports = {
    initialize,
    shutdown,
    isReady,
    getHealth,
    mongo,
    sqlite,
    repositories: {
        get questLog() {
            if (!questLogRepo) questLogRepo = new QuestLogRepository();
            return questLogRepo;
        },
        get scheduledRunner() {
            if (!scheduledRunnerRepo) scheduledRunnerRepo = new ScheduledRunnerRepository();
            return scheduledRunnerRepo;
        },
        get dmNotification() {
            if (!dmNotificationRepo) dmNotificationRepo = new DmNotificationRepository();
            return dmNotificationRepo;
        },
        get verificationRecovery() {
            if (!verificationRecoveryRepo) verificationRecoveryRepo = new VerificationRecoveryRepository();
            return verificationRecoveryRepo;
        },
        get verificationStateNonce() {
            if (!verificationStateNonceRepo) verificationStateNonceRepo = new VerificationStateNonceRepository();
            return verificationStateNonceRepo;
        },
        get cache() {
            return getCacheManager();
        },
        get assetCache() {
            return getAssetCacheManager();
        },
        get voiceEvent() {
            return getVoiceEventRepository();
        },
        get commandEvent() {
            return getCommandEventRepository();
        },
        get sessionEvent() {
            return getSessionEventRepository();
        },
        get voiceSessionRuntime() {
            if (!voiceSessionRuntimeRepo) voiceSessionRuntimeRepo = new VoiceSessionRuntimeRepository();
            return voiceSessionRuntimeRepo;
        },
        get joinCampaign() {
            if (!joinCampaignRepo) joinCampaignRepo = new JoinCampaignRepository();
            return joinCampaignRepo;
        },
        get verificationWebhook() {
            if (!verificationWebhookRepo) verificationWebhookRepo = new VerificationWebhookRepository();
            return verificationWebhookRepo;
        },
        get voiceAdmin() {
            if (!voiceAdminRepo) voiceAdminRepo = new VoiceAdminRepository();
            return voiceAdminRepo;
        }
    },
    get databaseService() {
        return require("./services/databaseService");
    },
    services: require("./services/databaseService")
};
