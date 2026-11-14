'use strict';

/**
 * Cache a token profile in memory with a TTL and bounded pruning
 * @param {Map} profileCache
 * @param {Map} tokenStates
 * @param {(token: string) => string} hashTokenFn
 * @param {(tokenHash: string) => object} getOrCreateStateFn
 * @param {string} token
 * @param {object} profile
 * @param {number} ttlMs
 */
function cacheTokenProfile(profileCache, tokenStates, hashTokenFn, getOrCreateStateFn, token, profile, ttlMs = 20 * 60 * 1000) {
    const hash = hashTokenFn(token);
    if (!hash || !profile) return;

    // Bounded pruning if cache grows over 2000 entries
    if (profileCache.size > 2000) {
        const now = Date.now();
        for (const [k, v] of profileCache.entries()) {
            if (v.expiresAt <= now) {
                profileCache.delete(k);
            }
        }
    }

    profileCache.set(hash, {
        profile,
        cachedAt: Date.now(),
        expiresAt: Date.now() + ttlMs
    });

    const state = getOrCreateStateFn(hash);
    if (profile.isBot || profile.tokenType === 'bot' || profile.category === 'bot') {
        state.tokenType = 'bot';
        if (!profile.tokenType) profile.tokenType = 'bot';
    } else if (profile.tokenType === 'user' || profile.valid) {
        state.tokenType = 'user';
        if (!profile.tokenType) profile.tokenType = 'user';
    }
}

/**
 * Get cached token profile if present and not expired
 * @param {Map} profileCache
 * @param {(token: string) => string} hashTokenFn
 * @param {string} token
 * @returns {object | null}
 */
function getCachedTokenProfile(profileCache, hashTokenFn, token) {
    const hash = hashTokenFn(token);
    if (!hash) return null;

    const entry = profileCache.get(hash);
    if (!entry) return null;

    if (entry.expiresAt <= Date.now()) {
        profileCache.delete(hash);
        return null;
    }

    return entry.profile;
}

/**
 * Clear token profile cache (single token or all)
 * @param {Map} profileCache
 * @param {(token: string) => string} hashTokenFn
 * @param {string} [token]
 */
function clearTokenProfileCache(profileCache, hashTokenFn, token = null) {
    if (token) {
        profileCache.delete(hashTokenFn(token));
    } else {
        profileCache.clear();
    }
}

module.exports = {
    cacheTokenProfile,
    getCachedTokenProfile,
    clearTokenProfileCache
};
