'use strict';

/**
 * BaseRepository
 * Abstract interface for Data Access Layer (DAL) supporting Dual-DB (MongoDB + SQLite).
 */
class BaseRepository {
    constructor(entityName) {
        if (!entityName) {
            throw new Error('BaseRepository requires an entityName');
        }
        this.entityName = entityName;
    }

    async findById(id) {
        throw new Error(`findById() not implemented in ${this.constructor.name}`);
    }

    async findOne(filter) {
        throw new Error(`findOne() not implemented in ${this.constructor.name}`);
    }

    async find(filter, options) {
        throw new Error(`find() not implemented in ${this.constructor.name}`);
    }

    async create(data) {
        throw new Error(`create() not implemented in ${this.constructor.name}`);
    }

    async updateById(id, updateData) {
        throw new Error(`updateById() not implemented in ${this.constructor.name}`);
    }

    async updateOne(filter, updateData) {
        throw new Error(`updateOne() not implemented in ${this.constructor.name}`);
    }

    async deleteById(id) {
        throw new Error(`deleteById() not implemented in ${this.constructor.name}`);
    }

    async deleteOne(filter) {
        throw new Error(`deleteOne() not implemented in ${this.constructor.name}`);
    }

    async count(filter) {
        throw new Error(`count() not implemented in ${this.constructor.name}`);
    }
}

module.exports = BaseRepository;
