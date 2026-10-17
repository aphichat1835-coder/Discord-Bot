'use strict';

const BaseRepository = require('./BaseRepository');

/**
 * MongoAdapter
 * Wraps Mongoose models with the universal BaseRepository interface.
 */
class MongoAdapter extends BaseRepository {
    constructor(entityName, mongooseModel) {
        super(entityName);
        if (!mongooseModel) {
            throw new Error(`MongoAdapter requires a mongooseModel for ${entityName}`);
        }
        this.model = mongooseModel;
    }

    async findById(id) {
        if (!id) return null;
        const q = this.model.findById(id);
        return typeof q?.lean === 'function' ? q.lean().exec() : q;
    }

    async findOne(filter = {}) {
        const q = this.model.findOne(filter);
        return typeof q?.lean === 'function' ? q.lean().exec() : q;
    }

    async find(filter = {}, options = {}) {
        let query = this.model.find(filter);
        if (options.sort && typeof query?.sort === 'function') query = query.sort(options.sort);
        if (options.skip && typeof query?.skip === 'function') query = query.skip(options.skip);
        if (options.limit && typeof query?.limit === 'function') query = query.limit(options.limit);
        return typeof query?.lean === 'function' ? query.lean().exec() : query;
    }

    async create(data) {
        const doc = await this.model.create(data);
        return doc && typeof doc.toObject === 'function' ? doc.toObject() : doc;
    }

    async updateById(id, updateData) {
        if (!id) return null;
        const q = this.model.findByIdAndUpdate(
            id,
            updateData,
            { returnDocument: 'after' }
        );
        return typeof q?.lean === 'function' ? q.lean().exec() : q;
    }

    async updateOne(filter, updateData, options = {}) {
        const q = this.model.findOneAndUpdate(
            filter,
            updateData,
            { returnDocument: 'after', ...options }
        );
        return typeof q?.lean === 'function' ? q.lean().exec() : q;
    }

    async deleteById(id) {
        if (!id) return false;
        const q = this.model.findByIdAndDelete(id);
        const res = await (typeof q?.exec === 'function' ? q.exec() : q);
        return Boolean(res);
    }

    async deleteOne(filter) {
        const q = this.model.deleteOne(filter);
        const res = await (typeof q?.exec === 'function' ? q.exec() : q);
        return (res?.deletedCount || 0) > 0;
    }

    async count(filter = {}) {
        const q = this.model.countDocuments(filter);
        return typeof q?.exec === 'function' ? q.exec() : q;
    }
}

module.exports = MongoAdapter;
