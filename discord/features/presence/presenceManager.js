"use strict";

const { STATUS_OPTIONS, STATUS_METADATA, PLATFORM_CONFIGS, DEFAULT_ROTATION_ITEMS } = require("./constants");
const gatewayPlatform = require("./gatewayPlatform");
const { PresenceScheduler } = require("./presenceScheduler");

class PresenceManager {
    client = null;
    sessionManager = null;
    runtimeLog = null;
    config = null;
    currentStatus = "online";
    currentPlatform = "desktop";
    isInitialized = false;

    constructor() {
        this.scheduler = new PresenceScheduler({
            onStep: (item) => this.executeRotationStep(item)
        });
    }

    async initialize({ client, sessionManager, runtimeLog, config } = {}) {
        this.client = client || this.client;
        this.sessionManager = sessionManager || this.sessionManager;
        this.runtimeLog = runtimeLog || this.runtimeLog || console;
        this.config = config || this.config || {};

        let savedStatus = "online";
        let savedPlatform = "desktop";
        let savedRotation = { enabled: false, items: DEFAULT_ROTATION_ITEMS };

        if (this.sessionManager?.getSetting) {
            try {
                savedStatus = await this.sessionManager.getSetting("botStatus", "online");
                savedPlatform = await this.sessionManager.getSetting("botPlatform", "desktop");
                savedRotation = await this.sessionManager.getSetting("presenceRotation", {
                    enabled: false,
                    items: DEFAULT_ROTATION_ITEMS
                });
            } catch (err) {
                this.runtimeLog.warn?.("PRESENCE", "Failed to load presence settings from DB, using defaults", {
                    error: err?.message || String(err)
                });
            }
        }

        const configuredStatus = STATUS_OPTIONS.includes(config?.bot_presence?.status)
            ? config.bot_presence.status
            : "online";
        this.currentStatus = STATUS_OPTIONS.includes(savedStatus) ? savedStatus : configuredStatus;
        this.currentPlatform = PLATFORM_CONFIGS[savedPlatform] ? savedPlatform : "desktop";

        // 1. Apply platform properties to default gateway template before connect
        gatewayPlatform.applyDefaultPlatform(this.currentPlatform);

        // 2. Configure rotation items in scheduler
        const rotationItems = Array.isArray(savedRotation?.items) && savedRotation.items.length > 0
            ? savedRotation.items
            : DEFAULT_ROTATION_ITEMS;
        this.scheduler.setItems(rotationItems);

        // 3. If rotation was enabled, auto-start rotation scheduler
        if (savedRotation?.enabled === true) {
            this.scheduler.start((item) => this.executeRotationStep(item)).catch(() => {});
            this.runtimeLog.success?.("PRESENCE", "Presence rotation scheduler auto-started", {
                itemsCount: rotationItems.length,
                initialStatus: this.currentStatus,
                initialPlatform: this.currentPlatform
            });
        }

        this.isInitialized = true;
        return this.getState();
    }

    async applyCurrentPresenceToDiscord() {
        if (!this.client?.isReady?.() || !this.client.user?.setPresence) return false;

        try {
            // Keep existing activities if any were configured
            const currentActivities = this.client.user.presence?.activities || [];
            this.client.user.setPresence({
                status: this.currentStatus,
                activities: currentActivities
            });
            return true;
        } catch (err) {
            this.runtimeLog.error?.("PRESENCE", "Failed to set Discord client presence", {
                error: err?.message || String(err)
            });
            return false;
        }
    }

    async setStatus(status) {
        const clean = String(status || "").toLowerCase().trim();
        if (!STATUS_OPTIONS.includes(clean)) {
            throw new Error(`Invalid status: ${status}. Must be one of: ${STATUS_OPTIONS.join(", ")}`);
        }

        this.currentStatus = clean;

        if (this.sessionManager?.setSetting) {
            await this.sessionManager.setSetting("botStatus", clean);
        }

        const applied = await this.applyCurrentPresenceToDiscord();
        return {
            success: true,
            status: clean,
            applied
        };
    }

    async setPlatform(platformKey, options = {}) {
        const clean = String(platformKey || "").toLowerCase().trim();
        if (!PLATFORM_CONFIGS[clean]) {
            throw new Error(`Invalid platform: ${platformKey}. Must be one of: ${Object.keys(PLATFORM_CONFIGS).join(", ")}`);
        }

        const result = await gatewayPlatform.applyRuntimePlatform(this.client, clean, options);
        if (result.success && result.changed) {
            this.currentPlatform = clean;
            if (this.sessionManager?.setSetting) {
                await this.sessionManager.setSetting("botPlatform", clean);
            }
        }

        return result;
    }

    async executeRotationStep(item) {
        if (!item?.enabled) return;

        let statusChanged = false;
        let platformChanged = false;

        const shouldApplyStatus = item.type !== "platform";
        const shouldApplyPlatform = item.type !== "status";

        // Apply Status if allowed by item type and specified
        if (shouldApplyStatus && item.status && STATUS_OPTIONS.includes(item.status)) {
            this.currentStatus = item.status;
            await this.applyCurrentPresenceToDiscord();
            statusChanged = true;
        }

        // Apply Platform if allowed by item type and specified
        if (shouldApplyPlatform && item.platform && PLATFORM_CONFIGS[item.platform] && item.platform !== this.currentPlatform) {
            const platformResult = await gatewayPlatform.applyRuntimePlatform(this.client, item.platform, {
                skipCooldown: false
            });
            if (platformResult.success && platformResult.changed) {
                this.currentPlatform = item.platform;
                platformChanged = true;
            }
        }

        this.runtimeLog.info?.("PRESENCE", `Rotation step applied: ${item.name}`, {
            type: item.type,
            status: item.status || this.currentStatus,
            platform: item.platform || this.currentPlatform,
            durationMinutes: item.durationMinutes
        });

        return {
            itemId: item.id,
            statusChanged,
            platformChanged,
            status: this.currentStatus,
            platform: this.currentPlatform
        };
    }

    async saveRotation({ enabled, items } = {}) {
        const isEnabled = Boolean(enabled);
        const savedItems = this.scheduler.setItems(Array.isArray(items) ? items : DEFAULT_ROTATION_ITEMS);

        if (this.sessionManager?.setSetting) {
            await this.sessionManager.setSetting("presenceRotation", {
                enabled: isEnabled,
                items: savedItems
            });
        }

        if (isEnabled) {
            this.scheduler.stop();
            await this.scheduler.start((item) => this.executeRotationStep(item));
        } else {
            this.scheduler.stop();
        }

        return {
            success: true,
            enabled: isEnabled,
            items: savedItems,
            schedulerState: this.scheduler.getState()
        };
    }

    async toggleRotation() {
        const currentlyRunning = this.scheduler.isRunning;
        const newEnabled = !currentlyRunning;
        return this.saveRotation({
            enabled: newEnabled,
            items: this.scheduler.items
        });
    }

    stop() {
        this.scheduler.stop();
    }

    getState() {
        const schedulerState = this.scheduler.getState();
        const supportedPlatforms = Object.values(PLATFORM_CONFIGS).map(p => ({
            id: p.id,
            name: p.name,
            icon: p.icon,
            badge: p.badge,
            status: p.status,
            indicator: p.indicator,
            description: p.description
        }));

        const supportedStatuses = Object.values(STATUS_METADATA);

        return {
            isInitialized: this.isInitialized,
            currentStatus: this.currentStatus,
            currentPlatform: this.currentPlatform,
            currentPlatformConfig: PLATFORM_CONFIGS[this.currentPlatform] || PLATFORM_CONFIGS.desktop,
            currentStatusMetadata: STATUS_METADATA[this.currentStatus] || STATUS_METADATA.online,
            supportedPlatforms,
            supportedStatuses,
            rotation: schedulerState
        };
    }
}

const presenceManager = new PresenceManager();

module.exports = {
    PresenceManager,
    presenceManager
};
