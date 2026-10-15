'use strict';

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const BaseRepository = require('./BaseRepository');

function setDeep(target, path, value) {
    const parts = path.split('.');
    let curr = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        if (!curr[p] || typeof curr[p] !== 'object') {
            curr[p] = {};
        }
        curr = curr[p];
    }
    curr[parts[parts.length - 1]] = value;
}

function getDeep(target, path) {
    if (!target || typeof target !== 'object') return undefined;
    if (path in target) return target[path];
    const parts = path.split('.');
    let curr = target;
    for (const p of parts) {
        if (!curr || typeof curr !== 'object') return undefined;
        curr = curr[p];
    }
    return curr;
}

function applyDocUpdate(existing, updateData) {
    const updated = JSON.parse(JSON.stringify(existing));
    if (updateData.$set && typeof updateData.$set === 'object') {
        for (const [key, value] of Object.entries(updateData.$set)) {
            setDeep(updated, key, value);
        }
    }
    if (updateData.$unset && typeof updateData.$unset === 'object') {
        for (const key of Object.keys(updateData.$unset)) {
            const parts = key.split('.');
            let curr = updated;
            for (let i = 0; i < parts.length - 1; i++) {
                if (!curr[parts[i]]) break;
                curr = curr[parts[i]];
            }
            if (curr && typeof curr === 'object') {
                delete curr[parts.at(-1)];
            }
        }
    }
    for (const [k, v] of Object.entries(updateData)) {
        if (!k.startsWith('$')) {
            if (k.includes('.')) {
                setDeep(updated, k, v);
            } else {
                updated[k] = v;
            }
        }
    }
    return updated;
}

/**
 * SqliteAdapter
 * High-performance, low-latency SQLite implementation with WAL mode.
 * Stores entities as structured records with fast JSON document payload.
 */
class SqliteAdapter extends BaseRepository {
    constructor(entityName, dbOrPath = ':memory:') {
        super(entityName);
        this.tableName = `tbl_${entityName.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;

        if (typeof dbOrPath === 'string') {
            this.db = new DatabaseSync(dbOrPath);
            if (dbOrPath !== ':memory:') {
                this.db.exec('PRAGMA journal_mode = WAL;');
                this.db.exec('PRAGMA synchronous = NORMAL;');
            }
        } else {
            this.db = dbOrPath;
        }

        this.initTable();
    }

    initTable() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS ${this.tableName} (
                id TEXT PRIMARY KEY,
                data TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_${this.tableName}_updated ON ${this.tableName} (updated_at);
        `);

        this.stmtFindById = this.db.prepare(`SELECT data FROM ${this.tableName} WHERE id = ?`);
        this.stmtInsert = this.db.prepare(`
            INSERT INTO ${this.tableName} (id, data, created_at, updated_at)
            VALUES (?, ?, ?, ?)
        `);
        this.stmtUpdate = this.db.prepare(`
            UPDATE ${this.tableName}
            SET data = ?, updated_at = ?
            WHERE id = ?
        `);
        this.stmtDeleteById = this.db.prepare(`DELETE FROM ${this.tableName} WHERE id = ?`);
        this.stmtCount = this.db.prepare(`SELECT COUNT(*) as cnt FROM ${this.tableName}`);
        this.stmtAll = this.db.prepare(`SELECT data FROM ${this.tableName} ORDER BY updated_at DESC`);
    }

    parseRow(row) {
        if (!row?.data) return null;
        try {
            return JSON.parse(row.data);
        } catch {
            return null;
        }
    }

    async findById(id) {
        if (!id) return null;
        const row = this.stmtFindById.get(String(id));
        return this.parseRow(row);
    }

    async findOne(filter = {}) {
        const results = await this.find(filter, { limit: 1 });
        return results.length > 0 ? results[0] : null;
    }

    async find(filter = {}, options = {}) {
        const rows = this.stmtAll.all();
        let items = [];
        for (const row of rows) {
            const item = this.parseRow(row);
            if (!item) continue;
            let match = true;
            for (const [k, v] of Object.entries(filter)) {
                const val = getDeep(item, k);
                if (val !== v) {
                    match = false;
                    break;
                }
            }
            if (match) items.push(item);
        }
        if (options.skip) items = items.slice(options.skip);
        if (options.limit) items = items.slice(0, options.limit);
        return items;
    }

    async create(data) {
        const now = Date.now();
        const base = data.$set ? { ...data, ...data.$set } : { ...data };
        delete base.$set;
        const unwrapped = {};
        for (const [k, v] of Object.entries(base)) {
            if (k.includes('.')) {
                setDeep(unwrapped, k, v);
            } else {
                unwrapped[k] = v;
            }
        }
        const id = String(unwrapped.id || unwrapped._id || `${now}_${crypto.randomBytes(4).toString('hex')}`);
        const item = { ...unwrapped, id, _id: id, createdAt: now, updatedAt: now };
        this.stmtInsert.run(id, JSON.stringify(item), now, now);
        return item;
    }

    async updateById(id, updateData) {
        if (!id) return null;
        const existing = await this.findById(id);
        if (!existing) return null;
        const now = Date.now();
        const updated = applyDocUpdate(existing, updateData);
        updated.id = String(id);
        updated._id = String(id);
        updated.updatedAt = now;
        this.stmtUpdate.run(JSON.stringify(updated), now, String(id));
        return updated;
    }

    async updateOne(filter, updateData, options = {}) {
        const existing = await this.findOne(filter);
        if (!existing) {
            if (options.upsert) {
                return this.create({ ...filter, ...updateData });
            }
            return null;
        }
        return this.updateById(existing.id || existing._id, updateData);
    }

    async deleteById(id) {
        if (!id) return false;
        const info = this.stmtDeleteById.run(String(id));
        return (info.changes || 0) > 0;
    }

    async deleteOne(filter) {
        const existing = await this.findOne(filter);
        if (!existing) return false;
        return this.deleteById(existing.id || existing._id);
    }

    async count(filter = {}) {
        if (Object.keys(filter).length === 0) {
            const res = this.stmtCount.get();
            return Number(res?.cnt || 0);
        }
        const matches = await this.find(filter);
        return matches.length;
    }
}

module.exports = SqliteAdapter;
