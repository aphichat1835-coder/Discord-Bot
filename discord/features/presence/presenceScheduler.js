"use strict";

const { STATUS_OPTIONS, PLATFORM_CONFIGS, DEFAULT_ROTATION_ITEMS } = require("./constants");

function resolveItemId(rawId, index) {
    if (typeof rawId === "string" && rawId.trim()) {
        return rawId.trim().slice(0, 32);
    }
    return `rot_${index + 1}_${Date.now().toString(36)}`;
}

function resolveItemType(rawType) {
    if (rawType === "both" || rawType === "combined") {
        return "combined";
    }
    if (rawType === "platform") {
        return "platform";
    }
    return "status";
}

function resolveItemStatus(rawStatus, type) {
    if (type === "platform") return null;
    if (typeof rawStatus === "string" && STATUS_OPTIONS.includes(rawStatus.toLowerCase())) {
        return rawStatus.toLowerCase();
    }
    return "online";
}

function resolveItemPlatform(rawPlatform, type) {
    if (type === "status") return null;
    if (typeof rawPlatform === "string" && PLATFORM_CONFIGS[rawPlatform.toLowerCase()]) {
        return rawPlatform.toLowerCase();
    }
    return "mobile";
}

function resolveItemDuration(rawItem, type) {
    let minutes = 5;
    const rawMin = Number(rawItem?.durationMinutes);
    const rawSec = Number(rawItem?.durationSeconds);

    if (Number.isFinite(rawMin) && rawMin > 0) {
        minutes = rawMin;
    } else if (Number.isFinite(rawSec) && rawSec > 0) {
        minutes = rawSec / 60;
    }

    const minAllowed = (type === "platform" || type === "combined") ? 5 : 1;
    return Math.min(1440, Math.max(minAllowed, minutes));
}

function resolveItemName(rawName, type, status, platform, durationMinutes) {
    if (typeof rawName === "string" && rawName.trim()) {
        return rawName.trim().slice(0, 64);
    }
    if (type === "status") {
        const statusUpper = (status || "ONLINE").toUpperCase();
        return `สถานะ ${statusUpper} (${durationMinutes} นาที)`;
    }
    if (type === "platform") {
        const platName = PLATFORM_CONFIGS[platform]?.name || platform || "Desktop";
        return `แพลตฟอร์ม ${platName} (${durationMinutes} นาที)`;
    }
    const statusUpper = (status || "ONLINE").toUpperCase();
    const platName = PLATFORM_CONFIGS[platform]?.name || platform || "Desktop";
    return `สถานะ ${statusUpper} + ${platName}`;
}

function sanitizeItem(rawItem, index = 0) {
    if (!rawItem || typeof rawItem !== "object") return null;

    const id = resolveItemId(rawItem.id, index);
    const type = resolveItemType(rawItem.type);
    const status = resolveItemStatus(rawItem.status, type);
    const platform = resolveItemPlatform(rawItem.platform, type);
    const durationMinutes = resolveItemDuration(rawItem, type);
    const durationMs = Math.round(durationMinutes * 60 * 1000);
    const name = resolveItemName(rawItem.name, type, status, platform, durationMinutes);
    const enabled = rawItem.enabled !== false;

    return {
        id,
        name,
        type,
        status,
        platform,
        durationMinutes,
        durationMs,
        enabled
    };
}

class PresenceScheduler {
    items = [];
    currentIndex = -1;
    timer = null;
    isRunning = false;
    stepExpiresAt = null;
    lastAction = null;
    generation = 0;

    constructor(options = {}) {
        this.onStep = options.onStep || (async () => {});
        this.now = options.now || (() => Date.now());
        this.setTimer = options.setTimer || setTimeout;
        this.clearTimer = options.clearTimer || clearTimeout;

        if (Array.isArray(options.items)) {
            this.setItems(options.items);
        } else {
            this.setItems(DEFAULT_ROTATION_ITEMS);
        }
    }

    setItems(rawItems) {
        if (!Array.isArray(rawItems)) {
            throw new TypeError("Items must be an array");
        }
        this.generation = (this.generation || 0) + 1;
        const cleaned = rawItems
            .map((item, idx) => sanitizeItem(item, idx))
            .filter(Boolean);

        this.items = cleaned.length > 0
            ? cleaned
            : DEFAULT_ROTATION_ITEMS.map((item, idx) => sanitizeItem(item, idx));

        return this.items;
    }

    getEnabledItems() {
        return this.items.filter(item => item.enabled);
    }

    findNextEnabledIndex(fromIndex = -1) {
        if (!this.items.length) return -1;
        const total = this.items.length;
        for (let i = 1; i <= total; i++) {
            const checkIndex = (fromIndex + i) % total;
            if (this.items[checkIndex].enabled) {
                return checkIndex;
            }
        }
        return -1;
    }

    async start(onStepCallback) {
        if (typeof onStepCallback === "function") {
            this.onStep = onStepCallback;
        }

        if (this.isRunning) {
            return { success: true, alreadyRunning: true };
        }

        const enabled = this.getEnabledItems();
        if (!enabled.length) {
            this.stop();
            return { success: false, reason: "no_enabled_items" };
        }

        this.stopTimer();
        this.isRunning = true;

        const nextIndex = this.findNextEnabledIndex(-1);
        if (nextIndex === -1) {
            this.isRunning = false;
            return { success: false, reason: "no_enabled_items" };
        }

        return this.executeStep(nextIndex);
    }

    stop() {
        this.generation = (this.generation || 0) + 1;
        this.stopTimer();
        this.isRunning = false;
        this.stepExpiresAt = null;
        return { success: true };
    }

    stopTimer() {
        if (this.timer) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
    }

    async executeStep(index) {
        if (!this.isRunning || !this.items[index]) return;

        const stepGen = this.generation;
        this.currentIndex = index;
        const item = this.items[index];
        const startedAt = this.now();
        this.stepExpiresAt = startedAt + item.durationMs;

        let result = null;
        try {
            result = await this.onStep(item, index);
            this.lastAction = {
                timestamp: startedAt,
                itemId: item.id,
                name: item.name,
                type: item.type,
                status: item.status,
                platform: item.platform,
                ok: true,
                result
            };
        } catch (err) {
            this.lastAction = {
                timestamp: startedAt,
                itemId: item.id,
                name: item.name,
                ok: false,
                error: err?.message || String(err)
            };
        }

        // Check if scheduler was stopped or items replaced during the step execution
        if (!this.isRunning || this.generation !== stepGen) {
            return {
                success: false,
                stale: true,
                activeItem: item,
                lastAction: this.lastAction
            };
        }

        // Schedule the next step after item.durationMs
        this.stopTimer();
        if (this.isRunning) {
            this.timer = this.setTimer(() => {
                this.timer = null;
                if (!this.isRunning || this.generation !== stepGen) return;
                const nextIndex = this.findNextEnabledIndex(this.currentIndex);
                if (nextIndex !== -1 && this.isRunning) {
                    void this.executeStep(nextIndex).catch(err => {
                        this.lastAction = {
                            timestamp: this.now(),
                            ok: false,
                            error: err?.message || String(err)
                        };
                    });
                } else {
                    this.stop();
                }
            }, item.durationMs);

            this.timer?.unref?.();
        }

        return {
            success: true,
            activeItem: item,
            expiresAt: this.stepExpiresAt,
            lastAction: this.lastAction
        };
    }

    get currentItem() {
        return this.isRunning && this.currentIndex >= 0 && this.items[this.currentIndex]
            ? this.items[this.currentIndex]
            : null;
    }

    getNextItem() {
        const nextIndex = this.isRunning && this.currentIndex >= 0
            ? this.findNextEnabledIndex(this.currentIndex)
            : this.findNextEnabledIndex(-1);
        return nextIndex >= 0 && this.items[nextIndex] ? this.items[nextIndex] : null;
    }

    async step() {
        if (!this.isRunning) return { success: false, reason: "not_running" };
        const nextIndex = this.findNextEnabledIndex(this.currentIndex);
        if (nextIndex === -1) {
            this.stop();
            return { success: false, reason: "no_next_enabled_item" };
        }
        return this.executeStep(nextIndex);
    }

    getState() {
        const now = this.now();
        const activeItem = this.isRunning && this.currentIndex >= 0 && this.items[this.currentIndex]
            ? this.items[this.currentIndex]
            : null;

        const nextIndex = this.isRunning && this.currentIndex >= 0
            ? this.findNextEnabledIndex(this.currentIndex)
            : this.findNextEnabledIndex(-1);

        const nextItem = nextIndex >= 0 && this.items[nextIndex]
            ? this.items[nextIndex]
            : null;

        const remainingMs = this.stepExpiresAt && this.isRunning
            ? Math.max(0, this.stepExpiresAt - now)
            : 0;

        return {
            isRunning: this.isRunning,
            currentIndex: this.currentIndex,
            activeItem,
            currentItem: activeItem,
            nextItem,
            stepExpiresAt: this.stepExpiresAt,
            expiresAt: this.stepExpiresAt,
            remainingSeconds: Math.ceil(remainingMs / 1000),
            totalItems: this.items.length,
            enabledCount: this.getEnabledItems().length,
            lastAction: this.lastAction,
            items: this.items
        };
    }
}

module.exports = {
    sanitizeItem,
    PresenceScheduler
};
