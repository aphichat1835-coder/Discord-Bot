'use strict';

const MongoAdapter = require('./MongoAdapter');
const SqliteAdapter = require('./SqliteAdapter');

/**
 * RepositoryFactory
 * Singleton factory and router for repositories.
 * Directs entities to MongoDB or SQLite according to engine configuration.
 */
class RepositoryFactory {
    constructor() {
        this.repositories = new Map();
        this.sqliteDb = null;
        this.engineRouting = new Map(); // entityName -> 'mongo' | 'sqlite'
    }

    setSqliteDatabase(dbOrPath) {
        this.sqliteDb = dbOrPath;
    }

    setEngineRoute(entityName, engine) {
        if (!['mongo', 'sqlite'].includes(engine)) {
            throw new Error(`Unsupported engine: ${engine}`);
        }
        this.engineRouting.set(entityName, engine);
    }

    getEngineRoute(entityName) {
        return this.engineRouting.get(entityName) || 'mongo';
    }

    registerRepository(entityName, repository) {
        this.repositories.set(entityName, repository);
    }

    getRepository(entityName, options = {}) {
        if (this.repositories.has(entityName)) {
            return this.repositories.get(entityName);
        }

        const engine = options.engine || this.getEngineRoute(entityName);
        let repo;

        if (engine === 'sqlite') {
            const db = options.sqliteDb || this.sqliteDb || ':memory:';
            repo = new SqliteAdapter(entityName, db);
        } else {
            if (!options.mongooseModel) {
                throw new Error(`Cannot instantiate MongoAdapter for ${entityName} without mongooseModel`);
            }
            repo = new MongoAdapter(entityName, options.mongooseModel);
        }

        this.repositories.set(entityName, repo);
        return repo;
    }

    clear() {
        this.repositories.clear();
        this.engineRouting.clear();
    }
}

const defaultFactory = new RepositoryFactory();
module.exports = defaultFactory;
module.exports.RepositoryFactory = RepositoryFactory;
