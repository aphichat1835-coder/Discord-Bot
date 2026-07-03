'use strict';

const OAuthUser = require('../models/OAuthUser');

describe('OAuthUser connections schema', () => {
    test('is an explicit document array rather than an array of strings', () => {
        const path = OAuthUser.schema.path('connections');
        const embeddedSchema = path?.schema || path?.caster?.schema || path?.$embeddedSchemaType?.schema;
        expect(embeddedSchema).toBeTruthy();
        expect(embeddedSchema.path('type')?.instance).toBe('String');
        expect(embeddedSchema.path('id')?.instance).toBe('String');
    });

    test('accepts normalized Discord connection objects', () => {
        const doc = new OAuthUser({
            discord: { userId: '123456789012345678' },
            connections: [{
                type: 'github',
                id: 'connection-id',
                name: 'Example',
                verified: true,
                metadata: { source: 'discord' }
            }]
        });

        expect(doc.validateSync()).toBeUndefined();
        expect(doc.connections).toHaveLength(1);
        expect(doc.connections[0].type).toBe('github');
        expect(doc.connections[0].id).toBe('connection-id');
    });

    test('normalizes legacy string entries during construction and hydration', () => {
        const created = new OAuthUser({
            discord: { userId: '123456789012345679' },
            connections: ['github']
        });
        const hydrated = OAuthUser.hydrate({
            discord: { userId: '123456789012345680' },
            connections: ['steam']
        });

        expect(created.connections[0].type).toBe('github');
        expect(hydrated.connections[0].type).toBe('steam');
        expect(hydrated.validateSync()).toBeUndefined();
    });

    test('uses the documented connection type limit for legacy strings', () => {
        const longType = 'x'.repeat(120);
        const doc = new OAuthUser({
            discord: { userId: '123456789012345681' },
            connections: [longType]
        });

        expect(doc.connections[0].type).toHaveLength(80);
        expect(doc.validateSync()).toBeUndefined();
    });
});
