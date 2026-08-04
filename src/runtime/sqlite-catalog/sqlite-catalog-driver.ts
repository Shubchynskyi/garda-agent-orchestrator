import { createRequire } from 'node:module';

import type { SqliteCatalogCapability } from './sqlite-catalog-contracts';

export type CatalogDatabase = import('node:sqlite').DatabaseSync;
type CatalogDatabaseConstructor = typeof import('node:sqlite').DatabaseSync;

interface SqliteModuleShape {
    readonly DatabaseSync?: CatalogDatabaseConstructor;
}

const requireFromAdapter = createRequire(__filename);
let cachedCapability: SqliteCatalogCapability | null = null;

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : String(error || 'unknown SQLite error');
}

function readFirstString(row: unknown): string | null {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return null;
    }
    const firstValue = Object.values(row as Record<string, unknown>)[0];
    return typeof firstValue === 'string' ? firstValue : null;
}

function closeQuietly(database: CatalogDatabase | null): void {
    if (!database) {
        return;
    }
    try {
        database.close();
    } catch {
        // Capability diagnostics already report the primary failure.
    }
}

export function loadSqliteDatabaseConstructor(): CatalogDatabaseConstructor | null {
    try {
        const sqliteModule = requireFromAdapter('node:sqlite') as SqliteModuleShape;
        return typeof sqliteModule.DatabaseSync === 'function'
            ? sqliteModule.DatabaseSync
            : null;
    } catch {
        return null;
    }
}

function executeCapabilityProbe(DatabaseSync: CatalogDatabaseConstructor): SqliteCatalogCapability {
    let database: CatalogDatabase | null = null;
    try {
        database = new DatabaseSync(':memory:');
        database.exec([
            'PRAGMA foreign_keys = ON;',
            'PRAGMA trusted_schema = OFF;',
            'CREATE TABLE capability_probe (probe_value INTEGER NOT NULL);'
        ].join('\n'));
        database.exec('BEGIN IMMEDIATE;');
        database.prepare('INSERT INTO capability_probe (probe_value) VALUES (?)').run(7);
        const preparedRow = database.prepare('SELECT probe_value FROM capability_probe').get();
        database.exec('ROLLBACK;');
        const probeValue = preparedRow && typeof preparedRow === 'object'
            ? Number((preparedRow as Record<string, unknown>).probe_value)
            : Number.NaN;
        if (probeValue !== 7) {
            throw new Error('Prepared statement or transaction probe returned an unexpected value.');
        }
        const sqliteVersion = readFirstString(
            database.prepare('SELECT sqlite_version() AS sqlite_version').get()
        );
        if (!sqliteVersion) {
            throw new Error('SQLite version probe returned no value.');
        }
        database.exec(`CREATE VIRTUAL TABLE capability_fts_probe USING fts5(probe_text);`);
        database.prepare('INSERT INTO capability_fts_probe (probe_text) VALUES (?)').run('garda capability');
        const ftsRow = database.prepare(`
            SELECT count(*) AS match_count
            FROM capability_fts_probe
            WHERE capability_fts_probe MATCH 'garda'
        `).get() as Record<string, unknown> | undefined;
        if (Number(ftsRow?.match_count) !== 1) {
            throw new Error('FTS5 capability probe returned an unexpected value.');
        }
        return Object.freeze({
            available: true,
            sqliteVersion,
            fts5Available: true,
            diagnostic: `node:sqlite DatabaseSync ${sqliteVersion} passed prepare, transaction, and FTS5 probes.`
        });
    } catch (error: unknown) {
        return Object.freeze({
            available: false,
            sqliteVersion: null,
            fts5Available: false,
            diagnostic: `node:sqlite capability probe failed: ${errorMessage(error)}`
        });
    } finally {
        closeQuietly(database);
    }
}

export function probeSqliteCatalogCapability(): SqliteCatalogCapability {
    if (cachedCapability) {
        return cachedCapability;
    }
    const DatabaseSync = loadSqliteDatabaseConstructor();
    cachedCapability = DatabaseSync
        ? executeCapabilityProbe(DatabaseSync)
        : Object.freeze({
            available: false,
            sqliteVersion: null,
            fts5Available: false,
            diagnostic: 'node:sqlite DatabaseSync is unavailable on this Node runtime.'
        });
    return cachedCapability;
}
