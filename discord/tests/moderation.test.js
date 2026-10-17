"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { PermissionFlagsBits } = require("discord.js");

const moderation = require("../commands/moderation");

test("moderation helper isBulkDeletableMessage checks message age correctly", () => {
    const now = 1700000000000;
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    const safetyMs = 60 * 1000;

    // Recent message (1 hour ago)
    assert.equal(moderation._test.isBulkDeletableMessage({ createdTimestamp: now - 3600000 }, now), true);
    // Message right before limit
    assert.equal(moderation._test.isBulkDeletableMessage({ createdTimestamp: now - (fourteenDaysMs - safetyMs - 1000) }, now), true);
    // Message older than 14 days - safety
    assert.equal(moderation._test.isBulkDeletableMessage({ createdTimestamp: now - (fourteenDaysMs - safetyMs + 1000) }, now), false);
    // Message with invalid timestamp
    assert.equal(moderation._test.isBulkDeletableMessage({ createdTimestamp: 0 }, now), false);
    assert.equal(moderation._test.isBulkDeletableMessage(null, now), false);
});

test("moderation helper deleteMessagesIndividually deletes in batches", async () => {
    const deletedList = [];
    const messages = [
        { id: "1", delete: async () => { deletedList.push("1"); } },
        { id: "2", delete: async () => { throw new Error("delete failed"); } },
        { id: "3", delete: async () => { deletedList.push("3"); } }
    ];

    const result = await moderation._test.deleteMessagesIndividually(messages, { batchSize: 2, delayMs: 0 });
    assert.equal(result.deleted, 2);
    assert.equal(result.failed, 1);
    assert.deepEqual(deletedList, ["1", "3"]);
});

test("moderation helper deleteChannelMessages coordinates bulk and individual deletion", async () => {
    const now = 1700000000000;
    const messages = [
        { id: "m1", createdTimestamp: now - 10000, delete: async () => {} },
        { id: "m2", createdTimestamp: now - 20000, delete: async () => {} },
        { id: "m3", createdTimestamp: now - (15 * 86400 * 1000), delete: async () => {} }
    ];

    const channel = {
        messages: {
            fetch: async (opts) => {
                assert.ok(opts.limit <= 100);
                return messages;
            }
        },
        bulkDelete: async (msgs) => {
            return {
                size: msgs.length,
                keys: () => msgs.map(m => m.id)
            };
        }
    };

    const result = await moderation._test.deleteChannelMessages(channel, 3, now, { delayMs: 0 });
    assert.equal(result.requested, 3);
    assert.equal(result.fetched, 3);
    assert.equal(result.bulkDeleted, 2);
    assert.equal(result.individualDeleted, 1);
    assert.equal(result.deleted, 3);
    assert.equal(result.failed, 0);
});

test("moderation handleClear rejects invalid amount or missing permissions", async () => {
    let replyPayload = null;
    const interaction = {
        commandName: "clear",
        channel: { id: "ch_test" },
        member: {
            permissions: {
                has: (perm) => perm === PermissionFlagsBits.Administrator
            }
        },
        options: {
            getInteger: (name) => (name === "amount" ? 0 : null)
        },
        reply: async (payload) => { replyPayload = payload; return payload; },
        guild: {
            members: {
                me: {
                    permissionsIn: () => ({
                        has: () => true
                    })
                }
            }
        }
    };

    // Amount = 0 should reject
    await moderation.handle(interaction);
    assert.ok(replyPayload);
    assert.equal(replyPayload.ephemeral, true);
    assert.match(replyPayload.embeds[0].data.description, /1-1,000/);

    // Missing admin permission should reject
    replyPayload = null;
    const noAdminInteraction = {
        ...interaction,
        member: {
            permissions: {
                has: () => false
            }
        }
    };
    await moderation.handle(noAdminInteraction);
    assert.ok(replyPayload);
    assert.match(replyPayload.content, /Administrator/);
});

test("moderation handleClear executes clear and edits reply with result embed", async () => {
    let editReplyPayload = null;
    const messages = [
        { id: "m1", createdTimestamp: Date.now() - 1000, delete: async () => {} },
        { id: "m2", createdTimestamp: Date.now() - 2000, delete: async () => {} }
    ];

    const interaction = {
        commandName: "clear",
        channel: {
            id: "ch_clear_ok",
            messages: {
                fetch: async () => messages
            },
            bulkDelete: async (msgs) => ({
                size: msgs.length,
                keys: () => msgs.map(m => m.id)
            })
        },
        member: {
            permissions: {
                has: () => true
            }
        },
        options: {
            getInteger: (name) => (name === "amount" ? 2 : null)
        },
        guild: {
            id: "guild_clear",
            name: "Guild Clear",
            iconURL: () => null,
            members: {
                me: {
                    permissionsIn: () => ({
                        has: () => true
                    })
                }
            }
        },
        user: { id: "user_mod", tag: "Mod#0001" },
        reply: async () => {},
        deferReply: async () => {},
        editReply: async (payload) => { editReplyPayload = payload; return payload; }
    };

    await moderation.handle(interaction);
    assert.ok(editReplyPayload);
    assert.ok(editReplyPayload.embeds);
    assert.match(editReplyPayload.embeds[0].data.title, /เรียบร้อย/);
    assert.equal(moderation.getRuntimeDiagnostics().activeClearChannels, 0);
});

test("moderation handleClear handles errors and formats code 50013", async () => {
    let editReplyPayload = null;
    const err = new Error("Missing Access");
    err.code = 50013;

    const interaction = {
        commandName: "clear",
        channel: {
            id: "ch_clear_err",
            messages: {
                fetch: async () => { throw err; }
            }
        },
        member: {
            permissions: {
                has: () => true
            }
        },
        options: {
            getInteger: (name) => (name === "amount" ? 5 : null)
        },
        guild: {
            id: "guild_err",
            name: "Guild Err",
            iconURL: () => null,
            members: {
                me: {
                    permissionsIn: () => ({
                        has: () => true
                    })
                }
            }
        },
        user: { id: "user_mod", tag: "Mod#0001" },
        reply: async () => {},
        deferReply: async () => {},
        editReply: async (payload) => { editReplyPayload = payload; return payload; }
    };

    await moderation.handle(interaction);
    assert.ok(editReplyPayload);
    assert.match(editReplyPayload.embeds[0].data.description, /ไม่มีสิทธิ์ลบข้อความ/);
    assert.equal(moderation.getRuntimeDiagnostics().activeClearChannels, 0);
});
