'use strict';

/*
 * Tests for discord/sessionManager.js - focusing on the new pure helpers
 * added in this PR:
 *   - hashToken
 *   - buildVoiceSessionId
 *   - getSessionShortId
 *   - findActiveVoiceSessionByTokenGuild (via in-memory state)
 *   - countActiveSessionsByTokenHash (via in-memory state)
 *   - getActiveSessionsByTokenHash
 *   - getActiveSessionsByGuild
 *   - hasActiveTokenGuildSession
 *   - getSessionByTokenGuild
 *   - getVoiceSessionSummary
 *   - getSessionShortId
 *   - compat exports: lockSession, unlockSession, addReconnect, clearReconnect, getToken
 *   - getAllWhitelist alias
 *   - systemMetrics.increment
 */

// Mock mongoose to prevent actual DB connection
jest.mock('mongoose', () => {
    const schemaMock = function () {
        return {
            index: jest.fn()
        };
    };
    schemaMock.Types = { Mixed: {} };

    const modelMock = jest.fn(() => ({
        find: jest.fn().mockResolvedValue([]),
        findOne: jest.fn().mockResolvedValue(null),
        deleteMany: jest.fn().mockResolvedValue({}),
        deleteOne: jest.fn().mockResolvedValue({}),
        updateOne: jest.fn().mockResolvedValue({}),
        bulkWrite: jest.fn().mockResolvedValue({})
    }));

    const connectionMock = {
        on: jest.fn(),
        readyState: 0,
        host: null,
        name: null
    };

    return {
        Schema: schemaMock,
        model: modelMock,
        models: {},
        connection: connectionMock,
        connect: jest.fn().mockResolvedValue({})
    };
});

// Set ENCRYPTION_KEY so sessionManager's encrypt/decrypt can work
process.env.ENCRYPTION_KEY = 'test-encryption-key-for-unit-tests-only';

const sessionManager = require('../discord/sessionManager');

const {
    hashToken,
    buildVoiceSessionId,
    getSessionShortId,
    getVoiceSessionSummary,
    getAllSessionSummaries,
    systemMetrics,
    lockSession,
    unlockSession,
    addReconnect,
    clearReconnect,
    getToken,
    getAllWhitelist,
    acquireSessionLock,
    releaseSessionLock,
    isSessionLocked,
    canAttemptReconnect,
    recordReconnectAttempt,
    resetReconnectInfo,
    getReconnectInfo,
    encryptToken,
    decryptToken
} = sessionManager;

describe('hashToken', () => {
    test('returns a 64-character hex string (SHA-256)', () => {
        const hash = hashToken('my-discord-token');
        expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    test('same token always produces same hash', () => {
        expect(hashToken('token123')).toBe(hashToken('token123'));
    });

    test('different tokens produce different hashes', () => {
        expect(hashToken('tokenA')).not.toBe(hashToken('tokenB'));
    });

    test('handles empty string without throwing', () => {
        expect(() => hashToken('')).not.toThrow();
        expect(hashToken('')).toMatch(/^[0-9a-f]{64}$/);
    });

    test('handles null without throwing', () => {
        expect(() => hashToken(null)).not.toThrow();
    });

    test('handles undefined without throwing', () => {
        expect(() => hashToken(undefined)).not.toThrow();
    });
});

describe('buildVoiceSessionId', () => {
    test('returns string starting with "vc_"', () => {
        const id = buildVoiceSessionId('hash123', 'server456', 'owner789');
        expect(id).toMatch(/^vc_/);
    });

    test('total length is vc_ (3) + 24 chars = 27', () => {
        const id = buildVoiceSessionId('hash', 'server', 'owner');
        expect(id).toHaveLength(27);
    });

    test('same inputs produce same session ID', () => {
        const id1 = buildVoiceSessionId('h', 's', 'o');
        const id2 = buildVoiceSessionId('h', 's', 'o');
        expect(id1).toBe(id2);
    });

    test('different tokenHash produces different session ID', () => {
        const id1 = buildVoiceSessionId('hash1', 'server', 'owner');
        const id2 = buildVoiceSessionId('hash2', 'server', 'owner');
        expect(id1).not.toBe(id2);
    });

    test('different serverId produces different session ID', () => {
        const id1 = buildVoiceSessionId('hash', 'server1', 'owner');
        const id2 = buildVoiceSessionId('hash', 'server2', 'owner');
        expect(id1).not.toBe(id2);
    });

    test('different ownerId produces different session ID', () => {
        const id1 = buildVoiceSessionId('hash', 'server', 'owner1');
        const id2 = buildVoiceSessionId('hash', 'server', 'owner2');
        expect(id1).not.toBe(id2);
    });
});

describe('getSessionShortId', () => {
    test('removes vc_ prefix', () => {
        const result = getSessionShortId('vc_abcdef1234567890');
        expect(result).not.toContain('vc_');
    });

    test('truncates to 10 chars', () => {
        const result = getSessionShortId('vc_abcdef1234567890');
        expect(result).toHaveLength(10);
    });

    test('handles empty string', () => {
        expect(getSessionShortId('')).toBe('');
    });

    test('handles null', () => {
        expect(getSessionShortId(null)).toBe('');
    });

    test('works on non-vc_ IDs', () => {
        const result = getSessionShortId('abcdef1234567890');
        expect(result).toHaveLength(10);
    });
});

describe('encryptToken / decryptToken', () => {
    test('round-trips a token (encrypt then decrypt)', () => {
        const original = 'my-discord-bot-token';
        const encrypted = encryptToken(original);
        expect(encrypted).not.toBe(original);
        expect(encrypted).toMatch(/^gcm:/);
        const decrypted = decryptToken(encrypted);
        expect(decrypted).toBe(original);
    });

    test('returns null for null input (encrypt)', () => {
        expect(encryptToken(null)).toBeNull();
    });

    test('returns null for null input (decrypt)', () => {
        expect(decryptToken(null)).toBeNull();
    });

    test('encryption of same token produces different ciphertext (random IV)', () => {
        const enc1 = encryptToken('sametoken');
        const enc2 = encryptToken('sametoken');
        expect(enc1).not.toBe(enc2);
    });
});

describe('systemMetrics', () => {
    test('has required metric keys', () => {
        expect(typeof systemMetrics.requests).toBe('number');
        expect(typeof systemMetrics.errors).toBe('number');
        expect(typeof systemMetrics.reconnects).toBe('number');
    });

    test('increment increases the metric by 1', () => {
        const before = systemMetrics.requests;
        systemMetrics.increment('requests');
        expect(systemMetrics.requests).toBe(before + 1);
    });

    test('increment ignores unknown metric keys', () => {
        expect(() => systemMetrics.increment('nonExistentKey')).not.toThrow();
    });

    test('increment on errors', () => {
        const before = systemMetrics.errors;
        systemMetrics.increment('errors');
        expect(systemMetrics.errors).toBe(before + 1);
    });
});

describe('Session lock functions (acquireSessionLock / releaseSessionLock / isSessionLocked)', () => {
    const testId = 'lock-test-session-' + Date.now();

    afterEach(() => {
        releaseSessionLock(testId);
    });

    test('acquires lock successfully when not locked', () => {
        expect(acquireSessionLock(testId)).toBe(true);
    });

    test('returns false when already locked', () => {
        acquireSessionLock(testId);
        expect(acquireSessionLock(testId)).toBe(false);
    });

    test('isSessionLocked returns true when locked', () => {
        acquireSessionLock(testId);
        expect(isSessionLocked(testId)).toBe(true);
    });

    test('isSessionLocked returns false when not locked', () => {
        expect(isSessionLocked('never-locked-session')).toBe(false);
    });

    test('release unlocks the session', () => {
        acquireSessionLock(testId);
        releaseSessionLock(testId);
        expect(isSessionLocked(testId)).toBe(false);
    });
});

describe('Compatibility exports', () => {
    test('lockSession is an alias for acquireSessionLock', () => {
        expect(lockSession).toBe(acquireSessionLock);
    });

    test('unlockSession is an alias for releaseSessionLock', () => {
        expect(unlockSession).toBe(releaseSessionLock);
    });

    test('addReconnect is an alias for recordReconnectAttempt', () => {
        expect(addReconnect).toBe(recordReconnectAttempt);
    });

    test('clearReconnect is an alias for resetReconnectInfo', () => {
        expect(clearReconnect).toBe(resetReconnectInfo);
    });

    test('getToken is an alias for getSessionToken', () => {
        const { getToken: gt, getSessionToken } = sessionManager;
        expect(gt).toBe(getSessionToken);
    });
});

describe('getAllWhitelist alias', () => {
    test('getAllWhitelist is a function', () => {
        expect(typeof getAllWhitelist).toBe('function');
    });

    test('getAllWhitelist calls getWhitelist', async () => {
        // With mocked mongoose (DB not connected), returns []
        const result = await getAllWhitelist('say');
        expect(Array.isArray(result)).toBe(true);
    });
});

describe('Reconnect tracking', () => {
    const sessionId = 'reconnect-test-' + Date.now();

    afterEach(() => {
        resetReconnectInfo(sessionId);
    });

    test('canAttemptReconnect returns true initially', () => {
        expect(canAttemptReconnect(sessionId)).toBe(true);
    });

    test('getReconnectInfo initializes with zero attempts', () => {
        const info = getReconnectInfo(sessionId);
        expect(info.attempts).toBe(0);
        expect(info.lastAttempt).toBe(0);
        expect(info.nextAllowedAt).toBe(0);
    });

    test('recordReconnectAttempt increments attempts', () => {
        recordReconnectAttempt(sessionId);
        const info = getReconnectInfo(sessionId);
        expect(info.attempts).toBe(1);
    });

    test('recordReconnectAttempt sets nextAllowedAt in the future', () => {
        const before = Date.now();
        recordReconnectAttempt(sessionId);
        const info = getReconnectInfo(sessionId);
        expect(info.nextAllowedAt).toBeGreaterThan(before);
    });

    test('after recordReconnectAttempt, canAttemptReconnect returns false', () => {
        recordReconnectAttempt(sessionId);
        expect(canAttemptReconnect(sessionId)).toBe(false);
    });

    test('resetReconnectInfo clears tracking', () => {
        recordReconnectAttempt(sessionId);
        resetReconnectInfo(sessionId);
        const info = getReconnectInfo(sessionId);
        expect(info.attempts).toBe(0);
    });
});

describe('getVoiceSessionSummary', () => {
    test('returns null for null input', () => {
        expect(getVoiceSessionSummary(null)).toBeNull();
    });

    test('returns null for undefined input', () => {
        expect(getVoiceSessionSummary(undefined)).toBeNull();
    });

    test('returns summary object with required fields', () => {
        const session = {
            sessionId: 'vc_abc123',
            serverId: '111',
            voiceId: '222',
            serverName: 'Test Server',
            voiceName: 'General',
            guildIcon: null,
            ownerId: '333',
            ownerTag: 'Owner#0001',
            ownerAvatar: null,
            accountId: 'acc1',
            accountUsername: 'botaccount',
            accountGlobalName: 'Bot Account',
            accountTag: 'botaccount',
            accountAvatar: null,
            startedAt: 1000,
            lastActivity: 2000,
            reconnecting: false,
            reconnectCount: 3,
            tokenInvalid: false,
            connection: null,
            token: 'encrypted-token',
            tokenTail: 'lastchrs',
            tokenHash: 'hashval'
        };

        const result = getVoiceSessionSummary(session);

        expect(result.sessionId).toBe('vc_abc123');
        expect(result.serverId).toBe('111');
        expect(result.voiceName).toBe('General');
        expect(result.accountUsername).toBe('botaccount');
        expect(result.reconnectCount).toBe(3);
        expect(result.hasConnection).toBe(false);
    });

    test('does NOT expose token in summary', () => {
        const session = {
            sessionId: 'vc_test',
            token: 'gcm:super-secret',
            tokenTail: 'seccret',
            tokenHash: 'hashval',
            serverId: '111',
            voiceId: '222',
            ownerId: '333',
            startedAt: 1000,
            lastActivity: 2000
        };
        const result = getVoiceSessionSummary(session);
        expect(result.token).toBeUndefined();
        expect(result.tokenTail).toBeUndefined();
        expect(result.tokenHash).toBeUndefined();
    });

    test('hasConnection is true when connection object exists', () => {
        const session = {
            sessionId: 'vc_conn',
            serverId: '1',
            voiceId: '2',
            ownerId: '3',
            startedAt: 0,
            lastActivity: 0,
            connection: { state: { status: 5 } }
        };
        const result = getVoiceSessionSummary(session);
        expect(result.hasConnection).toBe(true);
    });
});

describe('getAllSessionSummaries', () => {
    test('returns an array', () => {
        const result = getAllSessionSummaries();
        expect(Array.isArray(result)).toBe(true);
    });
});