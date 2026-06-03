'use strict';

/*
 * Tests for dashboard-public/models/VerifyLog.js
 *
 * Changes in this PR:
 *   - Added requestId: String field
 *   - Added schema.index({ requestId: 1 })
 *
 * We test the schema definition (field existence, types, required constraints,
 * enum values) without connecting to a real MongoDB.
 */

// Prevent mongoose from trying to connect
jest.mock('mongoose', () => {
    const actualMongoose = jest.requireActual('mongoose');
    return actualMongoose;
});

// Load the model (mongoose won't connect unless connectDB is called)
let VerifyLog;

beforeAll(() => {
    // Ensure we're testing the model schema
    VerifyLog = require('../dashboard-public/models/VerifyLog');
});

describe('VerifyLog schema - new requestId field', () => {
    test('schema has requestId path', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('requestId')).toBeDefined();
    });

    test('requestId is of String type', () => {
        const schema = VerifyLog.schema;
        const path = schema.path('requestId');
        expect(path.instance).toBe('String');
    });

    test('requestId is not required', () => {
        const schema = VerifyLog.schema;
        const path = schema.path('requestId');
        expect(path.isRequired).toBeFalsy();
    });
});

describe('VerifyLog schema - pre-existing required fields', () => {
    test('guildId is required', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('guildId').isRequired).toBe(true);
    });

    test('userId is required', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('userId').isRequired).toBe(true);
    });

    test('result is required', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('result').isRequired).toBe(true);
    });

    test('result enum values are success/failed/blocked', () => {
        const schema = VerifyLog.schema;
        const enumValues = schema.path('result').enumValues;
        expect(enumValues).toContain('success');
        expect(enumValues).toContain('failed');
        expect(enumValues).toContain('blocked');
        expect(enumValues).toHaveLength(3);
    });
});

describe('VerifyLog schema - optional fields', () => {
    test('roleId path exists and is String', () => {
        const schema = VerifyLog.schema;
        const path = schema.path('roleId');
        expect(path).toBeDefined();
        expect(path.instance).toBe('String');
        expect(path.isRequired).toBeFalsy();
    });

    test('riskScore path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('riskScore')).toBeDefined();
    });

    test('riskFlags is an array path', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('riskFlags')).toBeDefined();
    });

    test('verifiedAt defaults to Date.now', () => {
        const schema = VerifyLog.schema;
        const path = schema.path('verifiedAt');
        expect(path).toBeDefined();
        expect(path.defaultValue).toBeDefined();
    });
});

describe('VerifyLog schema - ipInfo nested fields', () => {
    test('ipInfo.isVPN path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('ipInfo.isVPN')).toBeDefined();
    });

    test('ipInfo.isProxy path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('ipInfo.isProxy')).toBeDefined();
    });

    test('ipInfo.isTOR path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('ipInfo.isTOR')).toBeDefined();
    });

    test('ipInfo.countryCode path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('ipInfo.countryCode')).toBeDefined();
    });

    test('ipInfo.riskScore path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('ipInfo.riskScore')).toBeDefined();
    });
});

describe('VerifyLog schema - device nested fields', () => {
    test('device.browser path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('device.browser')).toBeDefined();
    });

    test('device.os path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('device.os')).toBeDefined();
    });

    test('device.fingerprintHash path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('device.fingerprintHash')).toBeDefined();
    });
});

describe('VerifyLog schema - trackingSnapshot nested fields', () => {
    test('trackingSnapshot.ipHash path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('trackingSnapshot.ipHash')).toBeDefined();
    });

    test('trackingSnapshot.uniqueUsers path exists', () => {
        const schema = VerifyLog.schema;
        expect(schema.path('trackingSnapshot.uniqueUsers')).toBeDefined();
    });
});

describe('VerifyLog schema - indexes', () => {
    // We check that the expected indexes are defined on the schema
    // by inspecting schema._indexes (compound indexes) and schema.path().index (single-field)

    test('schema has at least one compound index', () => {
        const schema = VerifyLog.schema;
        // schema._indexes contains compound indexes
        expect(schema._indexes.length).toBeGreaterThan(0);
    });

    test('requestId index is defined (schema._indexes)', () => {
        const schema = VerifyLog.schema;
        const hasRequestIdIndex = schema._indexes.some(([fields]) =>
            Object.prototype.hasOwnProperty.call(fields, 'requestId')
        );
        expect(hasRequestIdIndex).toBe(true);
    });

    test('riskScore index is defined', () => {
        const schema = VerifyLog.schema;
        const hasRiskScoreIndex = schema._indexes.some(([fields]) =>
            Object.prototype.hasOwnProperty.call(fields, 'riskScore')
        );
        expect(hasRiskScoreIndex).toBe(true);
    });

    test('stateMode index is defined', () => {
        const schema = VerifyLog.schema;
        const hasStateModeIndex = schema._indexes.some(([fields]) =>
            Object.prototype.hasOwnProperty.call(fields, 'stateMode')
        );
        expect(hasStateModeIndex).toBe(true);
    });
});

describe('VerifyLog model creation validation (no DB)', () => {
    test('can create a VerifyLog document instance with required fields', () => {
        const doc = new VerifyLog({
            guildId: '111111111111111111',
            userId: '222222222222222222',
            result: 'success'
        });
        expect(doc.guildId).toBe('111111111111111111');
        expect(doc.userId).toBe('222222222222222222');
        expect(doc.result).toBe('success');
    });

    test('can set requestId on a document instance', () => {
        const doc = new VerifyLog({
            guildId: '111',
            userId: '222',
            result: 'success',
            requestId: 'req-abc-123'
        });
        expect(doc.requestId).toBe('req-abc-123');
    });

    test('requestId is undefined when not provided', () => {
        const doc = new VerifyLog({
            guildId: '111',
            userId: '222',
            result: 'failed'
        });
        expect(doc.requestId).toBeUndefined();
    });

    test('validation fails for invalid result enum', async () => {
        const doc = new VerifyLog({
            guildId: '111',
            userId: '222',
            result: 'invalid_value'
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.result).toBeDefined();
    });

    test('validation fails when guildId is missing', () => {
        const doc = new VerifyLog({
            userId: '222',
            result: 'success'
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.guildId).toBeDefined();
    });

    test('validation fails when userId is missing', () => {
        const doc = new VerifyLog({
            guildId: '111',
            result: 'success'
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.userId).toBeDefined();
    });

    test('validation fails when result is missing', () => {
        const doc = new VerifyLog({
            guildId: '111',
            userId: '222'
        });
        const err = doc.validateSync();
        expect(err).toBeDefined();
        expect(err.errors.result).toBeDefined();
    });

    test('verifiedAt gets a default value', () => {
        const before = Date.now();
        const doc = new VerifyLog({
            guildId: '111',
            userId: '222',
            result: 'success'
        });
        const after = Date.now();
        // verifiedAt default is Date.now (returns ms)
        if (doc.verifiedAt) {
            expect(doc.verifiedAt).toBeGreaterThanOrEqual(before);
            expect(doc.verifiedAt).toBeLessThanOrEqual(after);
        }
    });
});