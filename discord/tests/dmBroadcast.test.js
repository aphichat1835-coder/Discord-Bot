'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IDS, isDmPanelButton, isDmPanelModal } = require('../commands/customIds');
const {
    buildDmPanelEmbed,
    buildDmPanelRow,
    buildConfirmationRow,
    handleDmPanelCommand,
    handleDmPanelButton,
    handleDmPanelModal
} = require('../commands/dmPanel');
const {
    isValidWebhookUrl,
    isBroadcastRunning,
    stageBroadcast,
    getStagedBroadcast,
    clearStagedBroadcast,
    validateSecondaryBot,
    startBroadcastJob,
    buildMemberLogEmbed,
    buildFinalSummaryEmbed,
    _test
} = require('../features/dmBroadcast');
const config = require('../config.json');

test('customIds correctly recognizes DM panel buttons and modals', () => { // NOSONAR
    assert.equal(isDmPanelButton(IDS.BTN_DM_PANEL_OPEN), true);
    assert.equal(isDmPanelButton(IDS.BTN_DM_CONFIRM), true);
    assert.equal(isDmPanelButton(IDS.BTN_DM_CANCEL), true);
    assert.equal(isDmPanelButton('random_button_id'), false);

    assert.equal(isDmPanelModal(IDS.MODAL_DM_PANEL), true);
    assert.equal(isDmPanelModal('random_modal_id'), false);
});

test('buildDmPanelEmbed and row produce valid Discord structures', () => { // NOSONAR
    const embed = buildDmPanelEmbed();
    assert.ok(embed);
    assert.ok(embed.data.title.includes('ระบบกระจายข้อความ DM'));
    assert.ok(embed.data.description.includes('Secondary Bot Broadcast'));
    assert.equal(embed.data.description.includes('ระบบ One-shot'), false);

    const embedWithAttachment = buildDmPanelEmbed({ hasAttachment: true });
    assert.equal(embedWithAttachment.data.image.url, 'attachment://dm-panel-banner.gif');

    const row = buildDmPanelRow();
    assert.equal(row.components.length, 1);
    assert.equal(row.components[0].data.custom_id, IDS.BTN_DM_PANEL_OPEN);

    const confirmRow = buildConfirmationRow();
    assert.equal(confirmRow.components.length, 2);
    assert.equal(confirmRow.components[0].data.custom_id, IDS.BTN_DM_CONFIRM);
    assert.equal(confirmRow.components[1].data.custom_id, IDS.BTN_DM_CANCEL);
});

test('isValidWebhookUrl accurately validates Discord webhook URLs', () => { // NOSONAR
    assert.equal(isValidWebhookUrl('https://discord.com/api/webhooks/123456789012345678/abcdefg-ABC_123'), true);
    assert.equal(isValidWebhookUrl('https://canary.discord.com/api/webhooks/123456789012345678/abcdefg-ABC_123'), true);
    assert.equal(isValidWebhookUrl('https://ptb.discord.com/api/webhooks/123456789012345678/abcdefg-ABC_123'), true);
    assert.equal(isValidWebhookUrl('https://discordapp.com/api/webhooks/123456789012345678/abcdefg-ABC_123'), true);

    // Invalid URLs
    assert.equal(isValidWebhookUrl('http://discord.com/api/webhooks/123456789012345678/token'), false);
    assert.equal(isValidWebhookUrl('https://evil.com/api/webhooks/123456789012345678/token'), false);
    assert.equal(isValidWebhookUrl('https://discord.com/api/notwebhooks/123/token'), false);
    assert.equal(isValidWebhookUrl(''), false);
    assert.equal(isValidWebhookUrl(null), false);
    assert.equal(isValidWebhookUrl('https://discord.com/api/webhooks/short/token'), false);
});

test('stageBroadcast and getStagedBroadcast manage staging TTL properly', () => { // NOSONAR
    const userId = '123456789012345678';
    clearStagedBroadcast(userId);
    assert.equal(getStagedBroadcast(userId), null);

    stageBroadcast(userId, { token: 'mock-token', guildId: '123456789012345678' });
    const staged = getStagedBroadcast(userId);
    assert.ok(staged);
    assert.equal(staged.token, 'mock-token');

    clearStagedBroadcast(userId);
    assert.equal(getStagedBroadcast(userId), null);
});

test('validateSecondaryBot handles input validation and error cases', async () => { // NOSONAR
    // Empty token
    const res1 = await validateSecondaryBot('', '123456789012345678');
    assert.equal(res1.ok, false);
    assert.ok(res1.error.includes('กรุณากรอก Bot Token'));

    // Invalid Snowflake
    const res2 = await validateSecondaryBot('test-token', 'invalid-id');
    assert.equal(res2.ok, false);
    assert.ok(res2.error.includes('Server ID'));

    // Simulated login failure
    class FailingLoginClient {
        async login() {
            throw new Error('An invalid token was provided.');
        }
        async destroy() {}
    }
    const res3 = await validateSecondaryBot('bad-token', '123456789012345678', {
        ClientClass: FailingLoginClient
    });
    assert.equal(res3.ok, false);
    assert.ok(res3.error.includes('Invalid Discord Token'));

    // Simulated Guild not found
    class GuildNotFoundClient {
        async login() {}
        get guilds() {
            return {
                fetch: async () => { throw new Error('Unknown Guild'); }
            };
        }
        async destroy() {}
    }
    const res4 = await validateSecondaryBot('valid-token', '123456789012345678', {
        ClientClass: GuildNotFoundClient
    });
    assert.equal(res4.ok, false);
    assert.ok(res4.error.includes('บอทตัวรองไม่ได้อยู่ในเซิร์ฟเวอร์'));

    // Simulated Missing GuildMembers Intent
    class MissingIntentClient {
        async login() {}
        get guilds() {
            return {
                fetch: async () => ({
                    id: '123456789012345678',
                    name: 'Test Server',
                    members: {
                        fetch: async () => {
                            const err = new Error('Disallowed intent(s)');
                            err.code = 4014;
                            throw err;
                        }
                    }
                })
            };
        }
        async destroy() {}
    }
    const res5 = await validateSecondaryBot('valid-token', '123456789012345678', {
        ClientClass: MissingIntentClient
    });
    assert.equal(res5.ok, false);
    assert.ok(res5.error.includes('Server Members Intent'));

    // Successful validation
    class SuccessClient {
        constructor() {
            this.user = {
                id: '999999999999999999',
                tag: 'HelperBot#0001',
                displayAvatarURL: () => 'https://example.com/avatar.png'
            };
        }
        async login() {}
        get guilds() {
            return {
                fetch: async () => ({
                    id: '123456789012345678',
                    name: 'Test Guild',
                    iconURL: () => 'https://example.com/icon.png',
                    members: {
                        fetch: async () => [
                            { id: '1', user: { id: '1', bot: false } },
                            { id: '2', user: { id: '2', bot: true } },
                            { id: '3', user: { id: '3', bot: false } }
                        ]
                    }
                })
            };
        }
        async destroy() {}
    }
    const res6 = await validateSecondaryBot('valid-token', '123456789012345678', {
        ClientClass: SuccessClient
    });
    assert.equal(res6.ok, true);
    assert.equal(res6.targetCount, 2);
    assert.equal(res6.botUser.tag, 'HelperBot#0001');
    assert.equal(res6.guild.name, 'Test Guild');
});

test('buildMemberLogEmbed and buildFinalSummaryEmbed construct clean reports', () => { // NOSONAR
    const memberEmbed = buildMemberLogEmbed({
        member: { id: '111222333444555666', user: { tag: 'User#1234', id: '111222333444555666' } },
        botUser: { tag: 'Helper#0001' },
        index: 1,
        total: 10,
        success: true
    });
    assert.ok(memberEmbed);
    assert.ok(memberEmbed.data.title.includes('[1/10]'));

    const summaryEmbed = buildFinalSummaryEmbed({
        guild: { name: 'Awesome Server', id: '123456789012345678' },
        botUser: { tag: 'Helper#0001' },
        total: 10,
        sent: 8,
        failed: 2,
        durationMs: 25000
    });
    assert.ok(summaryEmbed);
    assert.ok(summaryEmbed.data.title.includes('รายงานสรุป'));
});

test('startBroadcastJob enforces concurrency and executes worker workflow', async () => { // NOSONAR
    _test.resetActiveJob();
    assert.equal(isBroadcastRunning(), false);

    // Invalid webhook
    const badWebhookResult = await startBroadcastJob({
        token: 'token',
        guildId: '123456789012345678',
        message: 'hello',
        webhookUrl: 'https://invalid.com'
    });
    assert.equal(badWebhookResult.ok, false);
    assert.ok(badWebhookResult.error.includes('Webhook URL'));

    // Simulated client and webhook
    const sentDMs = [];
    const webhookPayloads = [];

    class MockWorkerClient {
        constructor() {
            this.user = { id: 'bot-1', tag: 'Helper#0001' };
        }
        async login() {}
        get guilds() {
            return {
                fetch: async () => ({
                    id: '123456789012345678',
                    name: 'Target Guild',
                    iconURL: () => null,
                    members: {
                        fetch: async () => new Map([
                            ['user-1', {
                                id: 'user-1',
                                user: { id: 'user-1', bot: false, tag: 'UserOne#0001' },
                                send: async (payload) => { sentDMs.push({ id: 'user-1', payload }); }
                            }],
                            ['bot-2', {
                                id: 'bot-2',
                                user: { id: 'bot-2', bot: true, tag: 'BotTwo#0002' },
                                send: async () => { throw new Error('should not send to bot'); }
                            }],
                            ['user-3', {
                                id: 'user-3',
                                user: { id: 'user-3', bot: false, tag: 'UserThree#0003' },
                                send: async () => {
                                    const err = new Error('Cannot send messages to this user');
                                    err.code = 50007;
                                    throw err;
                                }
                            }]
                        ])
                    }
                })
            };
        }
        async destroy() {}
    }

    class MockWebhookClient {
        async send(payload) {
            webhookPayloads.push(payload);
        }
        destroy() {}
    }

    let completionData = null;
    const jobResult = await startBroadcastJob({
        token: 'valid-token',
        guildId: '123456789012345678',
        message: 'Hello Promotion!',
        imageUrl: 'https://example.com/banner.png',
        webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/token123',
        initiatedBy: 'owner-id',
        ClientClass: MockWorkerClient,
        WebhookClientClass: MockWebhookClient,
        onComplete: (data) => {
            completionData = data;
        }
    });

    assert.equal(jobResult.ok, true);
    assert.equal(isBroadcastRunning(), true);

    // Second job attempt must be rejected while active
    const secondJob = await startBroadcastJob({
        token: 'token-2',
        guildId: '123456789012345678',
        message: 'test',
        webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/token123'
    });
    assert.equal(secondJob.ok, false);
    assert.ok(secondJob.error.includes('มีงานกระจายข้อความ DM กำลังทำงาน'));

    // Wait for async loop to finish
    let waitCount = 0;
    while (isBroadcastRunning() && waitCount < 100) {
        await new Promise(r => setTimeout(r, 100));
        waitCount++;
    }

    assert.equal(isBroadcastRunning(), false);
    assert.ok(completionData);
    assert.equal(completionData.ok, true);
    assert.equal(completionData.total, 2);
    assert.equal(completionData.sent, 1);
    assert.equal(completionData.failed, 1);

    // DM sent verification
    assert.equal(sentDMs.length, 1);
    assert.equal(sentDMs[0].id, 'user-1');
    assert.equal(sentDMs[0].payload.content, 'Hello Promotion!');

    // Webhook delivery verification: 2 individual logs + 1 final summary = 3 messages
    assert.equal(webhookPayloads.length, 3);
});

test('command and button guards prevent non-owner execution', async () => { // NOSONAR
    const nonOwnerId = '111111111111111111';
    let replyPayload = null;

    const fakeInteraction = {
        user: { id: nonOwnerId },
        customId: IDS.BTN_DM_PANEL_OPEN,
        reply: async (p) => { replyPayload = p; }
    };

    // Command test
    await handleDmPanelCommand(fakeInteraction);
    assert.ok(replyPayload);
    assert.ok(replyPayload.content.includes('สงวนสิทธิ์เฉพาะ'));

    // Button test
    replyPayload = null;
    await handleDmPanelButton(fakeInteraction);
    assert.ok(replyPayload);
    assert.ok(replyPayload.content.includes('สงวนสิทธิ์เฉพาะ'));

    // Modal test
    replyPayload = null;
    await handleDmPanelModal(fakeInteraction);
    assert.ok(replyPayload);
    assert.ok(replyPayload.content.includes('ไม่มีสิทธิ์ส่งแบบฟอร์มนี้'));

    // Owner command test (checks banner attachment)
    const ownerId = config.system?.ownerId || '661415152146710558';
    let ownerReplyPayload = null;
    const ownerInteraction = {
        user: { id: ownerId },
        reply: async (p) => { ownerReplyPayload = p; }
    };
    await handleDmPanelCommand(ownerInteraction);
    assert.ok(ownerReplyPayload);
    assert.ok(Array.isArray(ownerReplyPayload.embeds));
    assert.ok(Array.isArray(ownerReplyPayload.components));
    assert.ok(Array.isArray(ownerReplyPayload.files));
    assert.equal(ownerReplyPayload.files.length, 1);
});

test('handleDmPanelModal validates empty message and invalid image URL for owner', async () => { // NOSONAR
    const ownerId = config.system?.ownerId || '661415152146710558';
    let editReplyPayload = null;

    // Test empty message
    const emptyMessageInteraction = {
        user: { id: ownerId },
        deferReply: async () => {},
        editReply: async (p) => { editReplyPayload = p; },
        fields: {
            getTextInputValue: (field) => {
                if (field === IDS.FIELD_DM_TOKEN) return 'valid-token';
                if (field === IDS.FIELD_DM_GUILD_ID) return '123456789012345678';
                if (field === IDS.FIELD_DM_MESSAGE) return '   ';
                if (field === IDS.FIELD_DM_WEBHOOK) return 'https://discord.com/api/webhooks/123456789012345678/token123';
                return '';
            }
        }
    };

    await handleDmPanelModal(emptyMessageInteraction);
    assert.ok(editReplyPayload);
    assert.ok(editReplyPayload.content.includes('ข้อความว่างเปล่า'));

    // Test invalid image URL
    editReplyPayload = null;
    const badImageInteraction = {
        user: { id: ownerId },
        deferReply: async () => {},
        editReply: async (p) => { editReplyPayload = p; },
        fields: {
            getTextInputValue: (field) => {
                if (field === IDS.FIELD_DM_TOKEN) return 'valid-token';
                if (field === IDS.FIELD_DM_GUILD_ID) return '123456789012345678';
                if (field === IDS.FIELD_DM_MESSAGE) return 'Valid message';
                if (field === IDS.FIELD_DM_IMAGE) return 'not-a-valid-url';
                if (field === IDS.FIELD_DM_WEBHOOK) return 'https://discord.com/api/webhooks/123456789012345678/token123';
                return '';
            }
        }
    };

    await handleDmPanelModal(badImageInteraction);
    assert.ok(editReplyPayload);
    assert.ok(editReplyPayload.content.includes('ลิงก์รูปภาพไม่ถูกต้อง'));
});

test('startBroadcastJob sends error embed to webhook on fatal error', async () => { // NOSONAR
    _test.resetActiveJob();
    const webhookPayloads = [];

    class FatalFailClient {
        async login() {
            throw new Error('Connection refused or banned token');
        }
        async destroy() {}
    }

    class MockWebhookClient {
        async send(payload) {
            webhookPayloads.push(payload);
        }
        destroy() {}
    }

    let completion = null;
    await startBroadcastJob({
        token: 'fatal-token',
        guildId: '123456789012345678',
        message: 'hello',
        webhookUrl: 'https://discord.com/api/webhooks/123456789012345678/token123',
        ClientClass: FatalFailClient,
        WebhookClientClass: MockWebhookClient,
        onComplete: (data) => {
            completion = data;
        }
    });

    let wait = 0;
    while (isBroadcastRunning() && wait < 50) {
        await new Promise(r => setTimeout(r, 50));
        wait++;
    }

    assert.equal(isBroadcastRunning(), false);
    assert.ok(completion);
    assert.equal(completion.ok, false);
    assert.ok(completion.error.includes('banned token'));
    assert.equal(webhookPayloads.length, 1);
    assert.ok(webhookPayloads[0].embeds[0].data.title.includes('หยุดชะงัก'));
});
