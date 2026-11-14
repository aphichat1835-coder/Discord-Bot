'use strict';

const { sanitizeLogText } = require('../../core/safeLogger');
const { cleanupInactiveTokenState } = require('./tokenState');

/**
 * Register a subsystem with the coordinator to receive lifecycle events
 * @param {object} coordinator
 * @param {{ name: string, onTokenQuarantined?: (tokenHash: string, reason: string, state: object) => void, onTokenActive?: (tokenHash: string, state: object) => void }} config
 */
function registerSubsystem(coordinator, config) {
    if (!config?.name || typeof config.name !== 'string') {
        throw new TypeError('registerSubsystem requires a valid string name');
    }
    coordinator.subsystems.set(config.name, {
        onTokenQuarantined: typeof config.onTokenQuarantined === 'function' ? config.onTokenQuarantined : null,
        onTokenActive: typeof config.onTokenActive === 'function' ? config.onTokenActive : null
    });
}

/**
 * Unregister a subsystem
 * @param {object} coordinator
 * @param {string} name
 * @returns {boolean}
 */
function unregisterSubsystem(coordinator, name) {
    if (!name) return false;
    return coordinator.subsystems.delete(String(name));
}

/**
 * Quarantine a token across the entire system with alert throttling
 * @param {object} coordinator
 * @param {string} token
 * @param {string} [reason]
 * @returns {boolean}
 */
function quarantineToken(coordinator, token, reason = 'Token Invalid or Revoked') {
    const hash = coordinator.hashToken(token);
    if (!hash) return false;

    const safeReason = sanitizeLogText(String(reason || 'Token Invalid or Revoked'));
    const state = coordinator._getOrCreateState(hash);
    const now = Date.now();
    state.quarantine = {
        quarantinedAt: now,
        reason: safeReason
    };
    state.lastActivity = now;

    // Invalidate cached profile
    coordinator.profileCache.delete(hash);

    // Emit high-speed In-Memory event to all listeners
    coordinator.emit('token:quarantined', { tokenHash: hash, reason: safeReason, state });

    // Notify registered subsystems to gracefully clean up
    for (const sub of coordinator.subsystems.values()) {
        if (typeof sub?.onTokenQuarantined === 'function') {
            try {
                sub.onTokenQuarantined(hash, safeReason, state);
            } catch {
                // Safe swallow to avoid cascade
            }
        }
    }

    // Send alert webhook with throttling cooldown per token
    const lastAlert = coordinator.alertHistory.get(hash) || 0;
    const shouldSendAlert = (now - lastAlert) > coordinator.alertCooldownMs;

    if (shouldSendAlert) {
        coordinator.alertHistory.set(hash, now);
        try {
            const { sendWebhookEvent } = require('../../core/webhooks');
            if (typeof sendWebhookEvent === 'function') {
                sendWebhookEvent({
                    target: 'ALERT',
                    severity: 'ERROR',
                    category: 'TOKEN',
                    code: 'token.quarantined',
                    state: 'OPEN',
                    title: 'QUARANTINED',
                    description: `ตรวจพบโทเคนหมดอายุหรือไม่ถูกต้อง ระบบได้กักกันและหยุดการทำงานที่เกี่ยวข้องอย่างปลอดภัย`,
                    fields: [
                        { name: 'สถานะ', value: 'OPEN' },
                        { name: 'ผลกระทบ', value: 'เซสชันหรือกิจกรรมที่ใช้โทเคนนี้จะถูกระงับชั่วคราว' },
                        { name: 'สิ่งที่ควรทำ', value: 'ตรวจสอบความถูกต้องของโทเคนหรือเปลี่ยนโทเคนใหม่ใน Dashboard' },
                        { name: 'Token Hash', value: `\`${hash.slice(0, 16)}...\`` },
                        { name: 'เหตุผล', value: safeReason }
                    ],
                    dedupeKey: `token-quarantine:${hash}`,
                    dedupeMs: coordinator.alertCooldownMs
                }).catch(() => {});
            }
        } catch {
            // Webhooks module not available in isolated unit tests
        }
    }

    return true;
}

/**
 * Release a token from quarantine
 * @param {object} coordinator
 * @param {string} token
 * @returns {boolean}
 */
function releaseQuarantine(coordinator, token) {
    const hash = coordinator.hashToken(token);
    if (!hash) return false;

    const state = coordinator.tokenStates.get(hash);
    if (state) {
        state.quarantine = null;
        state.lastActivity = Date.now();
        coordinator.alertHistory.delete(hash);
        coordinator.emit('token:released', { tokenHash: hash });

        try {
            const { sendWebhookEvent } = require('../../core/webhooks');
            if (typeof sendWebhookEvent === 'function') {
                sendWebhookEvent({
                    target: 'LOG',
                    severity: 'SUCCESS',
                    category: 'TOKEN',
                    code: 'token.quarantine_released',
                    title: 'QUARANTINE RELEASED',
                    description: `ปลดการกักกันโทเคนสำเร็จ โทเคนสามารถกลับมาใช้งานได้ตามปกติ`,
                    fields: [
                        { name: 'ผู้ดำเนินการ', value: 'Token Coordinator' },
                        { name: 'เป้าหมาย', value: `\`${hash.slice(0, 16)}...\`` },
                        { name: 'การกระทำ', value: 'release quarantine' },
                        { name: 'ผลลัพธ์', value: 'ปลดกักกันสำเร็จ' }
                    ]
                }).catch(() => {});
            }
        } catch {}

        cleanupInactiveTokenState(coordinator, hash, state);
        return true;
    }
    return false;
}

/**
 * Check if a token is currently quarantined
 * @param {object} coordinator
 * @param {string} token
 * @returns {boolean}
 */
function isQuarantined(coordinator, token) {
    const hash = coordinator.hashToken(token);
    return Boolean(coordinator.tokenStates.get(hash)?.quarantine);
}

/**
 * Get details of quarantine for a token
 * @param {object} coordinator
 * @param {string} token
 * @returns {{ quarantinedAt: number, reason: string } | null}
 */
function getQuarantineDetails(coordinator, token) {
    const hash = coordinator.hashToken(token);
    return coordinator.tokenStates.get(hash)?.quarantine || null;
}

module.exports = {
    registerSubsystem,
    unregisterSubsystem,
    quarantineToken,
    releaseQuarantine,
    isQuarantined,
    getQuarantineDetails
};
