'use strict';

const OAuthUser = require('../discord/verification/models/OAuthUser');
const {
    OAUTH_USER_SUMMARY_MAX,
    getOAuthUserSummaryDiagnostics,
    loadOAuthUserSummaries,
    makeOAuthUserSummaryMap
} = require('../discord/verification/utils/oauthUserSummary');

describe('OAuth user summary loader', () => {
    let oldAggregate;

    beforeEach(() => {
        oldAggregate = OAuthUser.aggregate;
    });

    afterEach(() => {
        OAuthUser.aggregate = oldAggregate;
    });

    test('reports the configured max user id cap', () => {
        expect(getOAuthUserSummaryDiagnostics()).toEqual({
            maxUserIds: OAUTH_USER_SUMMARY_MAX
        });
    });

    test('uses aggregate counts instead of loading connection and guild arrays', async () => {
        let pipeline;
        OAuthUser.aggregate = jest.fn(async (receivedPipeline) => {
            pipeline = receivedPipeline;
            return [{
                discord: { userId: '100', username: 'A' },
                connectionsCount: 2,
                guildsCount: 3
            }];
        });

        const ids = Array.from({ length: OAUTH_USER_SUMMARY_MAX + 25 }, (_, idx) => String(100 + idx));
        const result = await loadOAuthUserSummaries(ids);

        expect(result).toHaveLength(1);
        expect(OAuthUser.aggregate).toHaveBeenCalledTimes(1);
        expect(pipeline[0].$match['discord.userId'].$in).toHaveLength(OAUTH_USER_SUMMARY_MAX);
        expect(pipeline[1].$project.connections).toBeUndefined();
        expect(pipeline[1].$project.guilds).toBeUndefined();
        expect(pipeline[1].$project.connectionsCount).toHaveProperty('$size');
        expect(pipeline[1].$project.guildsCount).toHaveProperty('$size');
        expect(pipeline[1].$project['discord.displayTag']).toBe(1);
        expect(pipeline[1].$project['discord.avatarUrl']).toBe(1);
        expect(pipeline[1].$project['discord.bannerUrl']).toBe(1);
        expect(pipeline[1].$project['discord.accountCreatedAt']).toBe(1);
        expect(pipeline[1].$project.lastMember).toMatchObject({
            guildId: '$lastMember.guildId',
            joinedAt: '$lastMember.joinedAt',
            pending: '$lastMember.pending'
        });
    });

    test('builds a summary map keyed by Discord user id', async () => {
        OAuthUser.aggregate = jest.fn(async () => [
            { discord: { userId: '100', username: 'A' }, connectionsCount: 1, guildsCount: 4 }
        ]);

        const map = await makeOAuthUserSummaryMap(['100']);

        expect(map['100'].discord.username).toBe('A');
        expect(map['100'].connectionsCount).toBe(1);
        expect(map['100'].guildsCount).toBe(4);
    });
});
