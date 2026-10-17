'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    BaseRepository,
    MongoAdapter,
    SqliteAdapter,
    repositoryFactory
} = require('../core/dal');

test('BaseRepository abstract methods throw error', async () => {
    assert.throws(() => new BaseRepository(), /requires an entityName/);
    const repo = new BaseRepository('TestEntity');
    await assert.rejects(() => repo.findById('1'), /findById\(\) not implemented/);
    await assert.rejects(() => repo.findOne({}), /findOne\(\) not implemented/);
    await assert.rejects(() => repo.find({}), /find\(\) not implemented/);
    await assert.rejects(() => repo.create({}), /create\(\) not implemented/);
    await assert.rejects(() => repo.updateById('1', {}), /updateById\(\) not implemented/);
    await assert.rejects(() => repo.updateOne({}, {}), /updateOne\(\) not implemented/);
    await assert.rejects(() => repo.deleteById('1'), /deleteById\(\) not implemented/);
    await assert.rejects(() => repo.deleteOne({}), /deleteOne\(\) not implemented/);
    await assert.rejects(() => repo.count({}), /count\(\) not implemented/);
});

test('SqliteAdapter in-memory CRUD operations', async () => {
    const repo = new SqliteAdapter('GuildConfig', ':memory:');

    // Create
    const created = await repo.create({ id: 'guild_1', name: 'Server 1', prefix: '!' });
    assert.equal(created.id, 'guild_1');
    assert.equal(created.name, 'Server 1');

    // FindById
    const found = await repo.findById('guild_1');
    assert.equal(found.name, 'Server 1');
    assert.equal(await repo.findById(null), null);

    // FindOne
    const foundOne = await repo.findOne({ name: 'Server 1' });
    assert.equal(foundOne.id, 'guild_1');
    assert.equal(await repo.findOne({ name: 'Nonexistent' }), null);

    // Find all
    const all = await repo.find();
    assert.equal(all.length, 1);

    // UpdateById
    const updated = await repo.updateById('guild_1', { name: 'Server Updated' });
    assert.equal(updated.name, 'Server Updated');
    assert.equal(await repo.updateById(null, {}), null);
    assert.equal(await repo.updateById('missing', {}), null);

    // UpdateOne (upsert = true)
    const upserted = await repo.updateOne({ id: 'guild_2' }, { name: 'Server 2' }, { upsert: true });
    assert.equal(upserted.id, 'guild_2');
    assert.equal(await repo.count(), 2);

    // DeleteById
    const deleted = await repo.deleteById('guild_1');
    assert.equal(deleted, true);
    assert.equal(await repo.deleteById(null), false);
    assert.equal(await repo.deleteById('guild_1'), false);

    // DeleteOne
    const deletedOne = await repo.deleteOne({ id: 'guild_2' });
    assert.equal(deletedOne, true);
    assert.equal(await repo.deleteOne({ id: 'guild_2' }), false);

    // Count
    assert.equal(await repo.count(), 0);
});

test('MongoAdapter delegating methods with mock Mongoose model', async () => {
    assert.throws(() => new MongoAdapter('Test'), /requires a mongooseModel/);

    const store = new Map();
    const mockModel = {
        findById(id) {
            return {
                lean() {
                    return {
                        exec: async () => store.get(id) || null
                    };
                }
            };
        },
        findOne(filter) {
            return {
                lean() {
                    return {
                        exec: async () => {
                            for (const val of store.values()) {
                                let match = true;
                                for (const [k, v] of Object.entries(filter)) {
                                    if (val[k] !== v) match = false;
                                }
                                if (match) return val;
                            }
                            return null;
                        }
                    };
                }
            };
        },
        find(filter) {
            return {
                sort() { return this; },
                skip() { return this; },
                limit() { return this; },
                lean() {
                    return {
                        exec: async () => Array.from(store.values())
                    };
                }
            };
        },
        async create(data) {
            store.set(data._id, data);
            return {
                toObject() {
                    return { ...data };
                }
            };
        },
        findByIdAndUpdate(id, updateData) {
            return {
                lean() {
                    return {
                        exec: async () => {
                            const cur = store.get(id);
                            if (!cur) return null;
                            const next = { ...cur, ...updateData };
                            store.set(id, next);
                            return next;
                        }
                    };
                }
            };
        },
        findOneAndUpdate(filter, updateData) {
            return {
                lean() {
                    return {
                        exec: async () => {
                            const cur = Array.from(store.values())[0];
                            if (!cur) return null;
                            const next = { ...cur, ...updateData };
                            store.set(cur._id, next);
                            return next;
                        }
                    };
                }
            };
        },
        findByIdAndDelete(id) {
            return {
                exec: async () => {
                    const exists = store.has(id);
                    store.delete(id);
                    return exists ? { _id: id } : null;
                }
            };
        },
        deleteOne() {
            return {
                exec: async () => ({ deletedCount: 1 })
            };
        },
        countDocuments() {
            return {
                exec: async () => store.size
            };
        }
    };

    const repo = new MongoAdapter('MockEntity', mockModel);
    const created = await repo.create({ _id: 'm1', name: 'Mongo Item' });
    assert.equal(created._id, 'm1');

    const found = await repo.findById('m1');
    assert.equal(found.name, 'Mongo Item');
    assert.equal(await repo.findById(null), null);

    const foundOne = await repo.findOne({ name: 'Mongo Item' });
    assert.equal(foundOne._id, 'm1');

    const all = await repo.find({}, { sort: { _id: 1 }, skip: 0, limit: 10 });
    assert.equal(all.length, 1);

    const updated = await repo.updateById('m1', { name: 'Updated Mongo Item' });
    assert.equal(updated.name, 'Updated Mongo Item');
    assert.equal(await repo.updateById(null, {}), null);

    const updatedOne = await repo.updateOne({ _id: 'm1' }, { name: 'Updated One' });
    assert.equal(updatedOne.name, 'Updated One');

    assert.equal(await repo.count(), 1);
    assert.equal(await repo.deleteById('m1'), true);
    assert.equal(await repo.deleteById(null), false);
    assert.equal(await repo.deleteOne({ _id: 'm1' }), true);
});

test('RepositoryFactory routes and instantiates repositories', () => {
    repositoryFactory.clear();
    repositoryFactory.setSqliteDatabase(':memory:');
    repositoryFactory.setEngineRoute('GuildSettings', 'sqlite');

    assert.equal(repositoryFactory.getEngineRoute('GuildSettings'), 'sqlite');
    assert.equal(repositoryFactory.getEngineRoute('VerifyLog'), 'mongo');

    assert.throws(() => repositoryFactory.setEngineRoute('Invalid', 'redis'), /Unsupported engine/);

    const sqliteRepo = repositoryFactory.getRepository('GuildSettings');
    assert.equal(sqliteRepo instanceof SqliteAdapter, true);

    const sameRepo = repositoryFactory.getRepository('GuildSettings');
    assert.equal(sqliteRepo, sameRepo);

    assert.throws(
        () => repositoryFactory.getRepository('VerifyLog'),
        /Cannot instantiate MongoAdapter.*without mongooseModel/
    );
});

test('GuildConfigRepository domain methods work over SQLite adapter', async () => {
    const { GuildConfigRepository } = require('../core/dal');
    assert.throws(() => new GuildConfigRepository(), /requires an underlying storage adapter/);

    const adapter = new SqliteAdapter('GuildConfig', ':memory:');
    const repo = new GuildConfigRepository(adapter);

    // Initial ensure creates default
    const config1 = await repo.ensureGuildConfig('123456789', { guildName: 'Test Guild' });
    assert.equal(config1.guildId, '123456789');
    assert.equal(config1.guildName, 'Test Guild');
    assert.equal(config1.verification.enabled, false);

    // Ensure again returns existing without overwrite
    const config2 = await repo.ensureGuildConfig('123456789', { guildName: 'New Name' });
    assert.equal(config2.guildId, '123456789');
    assert.equal(config2.guildName, 'Test Guild');

    // Find by guildId
    const found = await repo.findByGuildId('123456789');
    assert.equal(found.guildId, '123456789');
    assert.equal(await repo.findByGuildId(null), null);

    // Update verification config
    const updated = await repo.updateVerificationConfig('123456789', {
        enabled: true,
        roleId: 'role_999',
        mode: 'oauth'
    });
    assert.equal(updated.verification.enabled, true);
    assert.equal(updated.verification.roleId, 'role_999');
    assert.equal(updated.verification.mode, 'oauth');

    // Delete by guildId
    const delResult = await repo.deleteByGuildId('123456789');
    assert.equal(delResult, true);
    assert.equal(await repo.findByGuildId('123456789'), null);
    assert.equal(await repo.deleteByGuildId(null).then(r => r.deletedCount), 0);
});

test('GuildConfigRepository domain methods work over MongoAdapter', async () => {
    const { GuildConfigRepository, MongoAdapter } = require('../core/dal');
    const store = new Map();

    const mockMongooseModel = {
        async findOne(query) {
            const item = store.get(query.guildId);
            return item ? { ...item } : null;
        },
        async create(doc) {
            const copy = { ...doc, _id: doc.guildId };
            store.set(doc.guildId, copy);
            return copy;
        },
        async findOneAndUpdate(filter, update) {
            let item = store.get(filter.guildId);
            if (!item) {
                item = { guildId: filter.guildId, verification: {} };
            }
            if (update.$set) {
                for (const [k, v] of Object.entries(update.$set)) {
                    if (k.startsWith('verification.')) {
                        item.verification[k.replace('verification.', '')] = v;
                    } else {
                        item[k] = v;
                    }
                }
            }
            store.set(filter.guildId, item);
            return { ...item };
        },
        async deleteOne(filter) {
            const existed = store.delete(filter.guildId);
            return { deletedCount: existed ? 1 : 0 };
        }
    };

    const adapter = new MongoAdapter('GuildConfig', mockMongooseModel);
    const repo = new GuildConfigRepository(adapter);

    const config = await repo.ensureGuildConfig('guild_mongo_1', { guildName: 'Mongo Guild' });
    assert.equal(config.guildId, 'guild_mongo_1');
    assert.equal(config.guildName, 'Mongo Guild');

    const updated = await repo.updateVerificationConfig('guild_mongo_1', {
        enabled: true,
        roleId: 'role_mongo',
        mode: 'oauth'
    });
    assert.equal(updated.verification.enabled, true);
    assert.equal(updated.verification.roleId, 'role_mongo');

    const found = await repo.findByGuildId('guild_mongo_1');
    assert.equal(found.guildId, 'guild_mongo_1');

    const del = await repo.deleteByGuildId('guild_mongo_1');
    assert.equal(del, true);
});

test('VerifyLogRepository creates and queries verification logs', async () => {
    const { VerifyLogRepository, SqliteAdapter } = require('../core/dal');
    const adapter = new SqliteAdapter('VerifyLog', ':memory:');
    const repo = new VerifyLogRepository(adapter);

    await assert.rejects(() => repo.createLog({}), /guildId and userId are required/);

    const log1 = await repo.createLog({
        guildId: 'guild_100',
        userId: 'user_1',
        result: 'success',
        reason: 'direct_verified'
    });
    assert.equal(log1.guildId, 'guild_100');
    assert.equal(log1.result, 'success');

    const log2 = await repo.createLog({
        guildId: 'guild_100',
        userId: 'user_2',
        result: 'failed',
        reason: 'vpn_detected'
    });
    assert.equal(log2.result, 'failed');

    const byGuild = await repo.findByGuild('guild_100');
    assert.equal(byGuild.length, 2);

    const countAll = await repo.countByGuild('guild_100');
    assert.equal(countAll, 2);

    const countSuccess = await repo.countByResult('guild_100', 'success');
    assert.equal(countSuccess, 1);

    const countFailed = await repo.countByResult('guild_100', 'failed');
    assert.equal(countFailed, 1);
});

test('OAuthUserRepository stores, updates, and deletes users', async () => {
    const { OAuthUserRepository, SqliteAdapter } = require('../core/dal');
    const adapter = new SqliteAdapter('OAuthUser', ':memory:');
    const repo = new OAuthUserRepository(adapter);

    await assert.rejects(() => repo.upsertUser(null), /userId is required/);

    const user = await repo.upsertUser('user_oauth_1', {
        discord: {
            userId: 'user_oauth_1',
            username: 'alice',
            discriminator: '0001'
        }
    });
    assert.equal(user.discord.username, 'alice');

    const found = await repo.findByUserId('user_oauth_1');
    assert.equal(found.discord.userId, 'user_oauth_1');

    const tokenUpdated = await repo.updateTokens('user_oauth_1', {
        encryptedAccessToken: 'token_abc',
        scope: 'identify guilds'
    });
    assert.equal(tokenUpdated.tokens.encryptedAccessToken, 'token_abc');

    const deleted = await repo.deleteByUserId('user_oauth_1');
    assert.equal(deleted, true);
    assert.equal(await repo.findByUserId('user_oauth_1'), null);
});

test('PrivacyDeletionJobRepository manages privacy job lifecycle', async () => {
    const { PrivacyDeletionJobRepository, SqliteAdapter } = require('../core/dal');
    const adapter = new SqliteAdapter('PrivacyDeletionJob', ':memory:');
    const repo = new PrivacyDeletionJobRepository(adapter);

    await assert.rejects(() => repo.createJob({}), /jobId, guildId, and userId are required/);

    const job = await repo.createJob({
        jobId: 'job_gdpr_1',
        guildId: 'guild_100',
        userId: 'user_1',
        operationKey: 'op_123',
        requestedBy: 'owner_1'
    });
    assert.equal(job.jobId, 'job_gdpr_1');
    assert.equal(job.status, 'pending');

    const pending = await repo.findPendingJobs();
    assert.equal(pending.length, 1);

    const running = await repo.updateStatus('job_gdpr_1', 'running');
    assert.equal(running.status, 'running');

    const completed = await repo.updateStatus('job_gdpr_1', 'completed', { completedAt: Date.now() });
    assert.equal(completed.status, 'completed');
    assert.ok(completed.completedAt > 0);
});
