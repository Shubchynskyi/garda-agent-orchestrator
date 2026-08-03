import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPathRealpathInsideRoot, resolvePathInsideRoot } from '../../core/paths';
import { withFilesystemLock } from '../../gate-runtime/timeline/task-events-locking';
import type {
    DerivedCatalogProjection,
    DerivedSqliteCatalog,
    OpenDerivedSqliteCatalogOptions,
    OpenDerivedSqliteCatalogResult,
    SqliteCatalogInspection,
    SqliteCatalogUnavailableReason,
    SqliteCatalogWriteDeferredReason,
    SqliteCatalogWriteResult
} from './sqlite-catalog-contracts';
import {
    type CatalogDatabase,
    loadSqliteDatabaseConstructor,
    probeSqliteCatalogCapability
} from './sqlite-catalog-driver';
import {
    SQLITE_CATALOG_APPLICATION_ID,
    SQLITE_CATALOG_BUSY_TIMEOUT_MS,
    SQLITE_CATALOG_MIGRATIONS,
    SQLITE_CATALOG_REQUIRED_COLUMNS,
    SQLITE_CATALOG_SCHEMA_VERSION,
    type SqliteCatalogMigration
} from './sqlite-catalog-migration';
import {
    CatalogProjectionRebuildRequiredError,
    readCatalogCounts,
    replaceCatalogProjection
} from './sqlite-catalog-projection';
import {
    assessSqliteWalFilesystem,
    createSqliteWalFilesystemAssessmentSession,
    type SqliteWalFilesystemAssessment
} from './sqlite-catalog-filesystem';
import { CatalogProjectionValidationError } from './sqlite-catalog-validation';

const ACTIVE_CATALOG_PATHS = new Set<string>();
const SQLITE_CATALOG_MAINTENANCE_TIMEOUT_MS = 5_000;
let expectedCatalogSchemaSignatures: readonly string[] | null = null;

class CatalogOpenError extends Error {
    readonly reason: SqliteCatalogUnavailableReason;

    constructor(reason: SqliteCatalogUnavailableReason, message: string) {
        super(message);
        this.name = 'CatalogOpenError';
        this.reason = reason;
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message
        ? error.message
        : String(error || 'unknown SQLite catalog error');
}

function contentionReason(error: unknown): 'busy' | 'locked' | null {
    const message = errorMessage(error).toLowerCase();
    if (message.includes('sqlite_locked') || message.includes('database is locked')) return 'locked';
    if (message.includes('sqlite_busy') || message.includes('database is busy')) return 'busy';
    return null;
}

function firstRowValue(row: unknown): unknown {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
        return undefined;
    }
    return Object.values(row as Record<string, unknown>)[0];
}

function readPragmaNumber(database: CatalogDatabase, sql: string, label: string): number {
    const value = Number(firstRowValue(database.prepare(sql).get()));
    if (!Number.isSafeInteger(value)) {
        throw new CatalogOpenError('invalid_schema', `${label} returned an invalid integer.`);
    }
    return value;
}

function readPragmaString(database: CatalogDatabase, sql: string, label: string): string {
    const value = firstRowValue(database.prepare(sql).get());
    if (typeof value !== 'string' || !value.trim()) {
        throw new CatalogOpenError('invalid_schema', `${label} returned an invalid value.`);
    }
    return value;
}

function closeQuietly(database: CatalogDatabase | null): void {
    if (!database) return;
    try {
        database.close();
    } catch {
        // Preserve the primary open or validation failure.
    }
}

function resolveOrchestratorRoot(repoRoot: string): string {
    return joinOrchestratorPath(path.resolve(repoRoot), '');
}

function resolveDerivedSqliteCatalogPathWithAssessment(
    repoRoot: string,
    assessFilesystem: (candidatePath: string) => SqliteWalFilesystemAssessment
): string {
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    let catalogPath: string;
    try {
        catalogPath = resolvePathInsideRoot(
            orchestratorRoot,
            path.join('runtime', 'catalog', 'orchestration.sqlite3')
        );
    } catch (error: unknown) {
        throw new CatalogOpenError('unsafe_path', errorMessage(error));
    }
    const filesystem = assessFilesystem(path.dirname(catalogPath));
    if (filesystem.status === 'unsafe') {
        throw new CatalogOpenError(
            'unsafe_path',
            filesystem.diagnostic
        );
    }
    if (filesystem.status === 'unavailable') {
        throw new CatalogOpenError('path_unavailable', filesystem.diagnostic);
    }
    return catalogPath;
}

export function resolveDerivedSqliteCatalogPath(repoRoot: string): string {
    return resolveDerivedSqliteCatalogPathWithAssessment(repoRoot, assessSqliteWalFilesystem);
}

function readAppVersion(repoRoot: string, explicitVersion: string | undefined): string {
    const normalizedExplicit = String(explicitVersion || '').trim();
    if (normalizedExplicit) return normalizedExplicit;
    try {
        const versionPath = joinOrchestratorPath(repoRoot, 'VERSION');
        const version = fs.readFileSync(versionPath, 'utf8').trim();
        return version || 'unknown';
    } catch {
        return 'unknown';
    }
}

function ensureCatalogDirectory(catalogPath: string): void {
    const directoryPath = path.dirname(catalogPath);
    try {
        fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
        if (process.platform !== 'win32') {
            fs.chmodSync(directoryPath, 0o700);
        }
    } catch (error: unknown) {
        throw new CatalogOpenError(
            'path_unavailable',
            `SQLite catalog directory is unavailable: ${errorMessage(error)}`
        );
    }
}

function assertCatalogDirectoryInsideWorkspace(repoRoot: string, catalogPath: string): void {
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const catalogDirectory = path.dirname(catalogPath);
    if (!isPathRealpathInsideRoot(orchestratorRoot, catalogDirectory)) {
        throw new CatalogOpenError(
            'unsafe_path',
            'SQLite catalog directory escapes the workspace through a filesystem link.'
        );
    }
}

function assertCatalogFilesInsideWorkspace(repoRoot: string, catalogPath: string): void {
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const candidatePaths = [
        catalogPath,
        `${catalogPath}-journal`,
        `${catalogPath}-wal`,
        `${catalogPath}-shm`
    ];
    for (const candidatePath of candidatePaths) {
        let candidateState: fs.Stats;
        try {
            candidateState = fs.lstatSync(candidatePath);
        } catch (error: unknown) {
            const code = String((error as NodeJS.ErrnoException)?.code || '');
            if (code === 'ENOENT' || code === 'ENOTDIR') continue;
            throw new CatalogOpenError(
                'path_unavailable',
                `SQLite catalog path cannot be inspected: ${errorMessage(error)}`
            );
        }
        if (
            candidateState.isSymbolicLink()
            || !isPathRealpathInsideRoot(orchestratorRoot, candidatePath)
        ) {
            throw new CatalogOpenError(
                'unsafe_path',
                'SQLite catalog file or journal escapes the workspace through a filesystem link.'
            );
        }
    }
}

function enforceCatalogFilePermissions(catalogPath: string): void {
    if (process.platform === 'win32') return;
    try {
        for (const candidatePath of [catalogPath, `${catalogPath}-wal`, `${catalogPath}-shm`]) {
            if (fs.existsSync(candidatePath)) {
                fs.chmodSync(candidatePath, 0o600);
            }
        }
    } catch (error: unknown) {
        throw new CatalogOpenError(
            'path_unavailable',
            `SQLite catalog permissions cannot be restricted: ${errorMessage(error)}`
        );
    }
}

function readUserSchemaObjectNames(database: CatalogDatabase): string[] {
    const rows = database.prepare(`
        SELECT name FROM sqlite_schema
        WHERE type IN ('table', 'index', 'view', 'trigger')
          AND name NOT LIKE 'sqlite_%'
        ORDER BY type, name
    `).all() as Array<Record<string, unknown>>;
    return rows
        .map((row) => String(row.name || '').trim())
        .filter(Boolean);
}

function applyConnectionSafetyPragmas(database: CatalogDatabase): void {
    database.exec([
        'PRAGMA foreign_keys = ON;',
        'PRAGMA trusted_schema = OFF;',
        `PRAGMA busy_timeout = ${SQLITE_CATALOG_BUSY_TIMEOUT_MS};`
    ].join('\n'));
}

function rollbackQuietly(database: CatalogDatabase): void {
    try {
        database.exec('ROLLBACK;');
    } catch {
        // Preserve the migration failure that caused rollback.
    }
}

function applyMigration(
    database: CatalogDatabase,
    migration: SqliteCatalogMigration,
    appVersion: string,
    appliedAtUtc: string
): void {
    database.exec('PRAGMA synchronous = FULL;');
    database.exec('BEGIN IMMEDIATE;');
    try {
        if (migration.version === 1) {
            database.exec(`PRAGMA application_id = ${SQLITE_CATALOG_APPLICATION_ID};`);
        }
        database.exec(migration.sql);
        database.prepare(`
            INSERT INTO schema_migrations (
                version, name, checksum, applied_at_utc, app_version
            ) VALUES (?, ?, ?, ?, ?)
        `).run(migration.version, migration.name, migration.checksum, appliedAtUtc, appVersion);
        database.exec(`PRAGMA user_version = ${migration.version};`);
        database.exec('COMMIT;');
    } catch (error: unknown) {
        rollbackQuietly(database);
        const contention = contentionReason(error);
        if (contention) {
            throw new CatalogOpenError(
                contention,
                `SQLite catalog migration deferred by contention: ${errorMessage(error)}`
            );
        }
        throw new CatalogOpenError(
            'migration_failed',
            `SQLite catalog migration ${migration.version} failed: ${errorMessage(error)}`
        );
    }
}

function migrateUnderMaintenanceLock(
    database: CatalogDatabase,
    catalogPath: string,
    appVersion: string,
    appliedAtUtc: string
): void {
    const lockPath = path.join(path.dirname(catalogPath), '.maintenance.lock');
    database.exec(`PRAGMA busy_timeout = ${SQLITE_CATALOG_MAINTENANCE_TIMEOUT_MS};`);
    try {
        withFilesystemLock(lockPath, {
            timeoutMs: SQLITE_CATALOG_MAINTENANCE_TIMEOUT_MS,
            retryMs: 25,
            ownerLabel: 'sqlite-catalog-migration'
        }, () => migrateOrValidateCatalog(database, appVersion, appliedAtUtc));
    } catch (error: unknown) {
        if (error instanceof CatalogOpenError) throw error;
        throw new CatalogOpenError(
            'locked',
            `SQLite catalog maintenance lock is unavailable: ${errorMessage(error)}`
        );
    } finally {
        database.exec(`PRAGMA busy_timeout = ${SQLITE_CATALOG_BUSY_TIMEOUT_MS};`);
    }
}

function initializeOrValidateCatalog(
    database: CatalogDatabase,
    catalogPath: string,
    appVersion: string,
    appliedAtUtc: string
): void {
    const schemaVersion = readPragmaNumber(database, 'PRAGMA user_version', 'PRAGMA user_version');
    if (schemaVersion < SQLITE_CATALOG_SCHEMA_VERSION) {
        migrateUnderMaintenanceLock(database, catalogPath, appVersion, appliedAtUtc);
        return;
    }
    migrateOrValidateCatalog(database, appVersion, appliedAtUtc);
}

function verifyQuickCheck(database: CatalogDatabase): void {
    const result = readPragmaString(database, 'PRAGMA quick_check', 'PRAGMA quick_check');
    if (result.toLowerCase() !== 'ok') {
        throw new CatalogOpenError('corrupt_catalog', `SQLite quick_check failed: ${result}`);
    }
}

function readMigrationLedgerRows(database: CatalogDatabase): Array<Record<string, unknown>> {
    try {
        return database.prepare(`
            SELECT version, name, checksum FROM schema_migrations ORDER BY version
        `).all() as Array<Record<string, unknown>>;
    } catch (error: unknown) {
        throw new CatalogOpenError(
            'invalid_schema',
            `SQLite migration ledger is unreadable: ${errorMessage(error)}`
        );
    }
}

function verifyMigrationLedger(database: CatalogDatabase, schemaVersion: number): void {
    const rows = readMigrationLedgerRows(database);
    const expected = SQLITE_CATALOG_MIGRATIONS.filter((migration) => migration.version <= schemaVersion);
    if (rows.length !== expected.length) {
        throw new CatalogOpenError('invalid_schema', 'SQLite migration ledger length does not match user_version.');
    }
    for (let index = 0; index < expected.length; index += 1) {
        const row = rows[index];
        const migration = expected[index];
        if (
            Number(row.version) !== migration.version
            || row.name !== migration.name
            || row.checksum !== migration.checksum
        ) {
            throw new CatalogOpenError(
                'invalid_schema',
                `SQLite migration ledger mismatch at version ${migration.version}.`
            );
        }
    }
}

function readTableColumns(database: CatalogDatabase, tableName: string): Set<string> {
    try {
        const rows = database.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<Record<string, unknown>>;
        return new Set(rows.map((row) => String(row.name || '')));
    } catch (error: unknown) {
        throw new CatalogOpenError(
            'invalid_schema',
            `SQLite table '${tableName}' cannot be inspected: ${errorMessage(error)}`
        );
    }
}

function verifyRequiredColumns(database: CatalogDatabase): void {
    for (const [tableName, requiredColumns] of Object.entries(SQLITE_CATALOG_REQUIRED_COLUMNS)) {
        const columns = readTableColumns(database, tableName);
        const missing = requiredColumns.filter((column) => !columns.has(column));
        if (missing.length > 0) {
            throw new CatalogOpenError(
                'invalid_schema',
                `SQLite table '${tableName}' is missing required column(s): ${missing.join(', ')}.`
            );
        }
    }
}

function normalizeSchemaSql(value: unknown): string {
    return String(value || '')
        .replace(/;\s*$/u, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function readCatalogSchemaSignatures(database: CatalogDatabase): string[] {
    try {
        const rows = database.prepare(`
            SELECT type, name, tbl_name, sql
            FROM sqlite_schema
            WHERE type IN ('table', 'index', 'view', 'trigger')
              AND (name NOT LIKE 'sqlite_%' OR name LIKE 'sqlite_autoindex_%')
            ORDER BY type, name
        `).all() as Array<Record<string, unknown>>;
        return rows.map((row) => [
            String(row.type || ''),
            String(row.name || ''),
            String(row.tbl_name || ''),
            normalizeSchemaSql(row.sql)
        ].join('\u0000'));
    } catch (error: unknown) {
        throw new CatalogOpenError(
            'invalid_schema',
            `SQLite schema objects cannot be inspected: ${errorMessage(error)}`
        );
    }
}

function getExpectedCatalogSchemaSignatures(): readonly string[] {
    if (expectedCatalogSchemaSignatures) return expectedCatalogSchemaSignatures;
    const DatabaseSync = loadSqliteDatabaseConstructor();
    if (!DatabaseSync) {
        throw new CatalogOpenError(
            'open_failed',
            'node:sqlite DatabaseSync became unavailable while validating catalog schema.'
        );
    }
    let referenceDatabase: CatalogDatabase | null = null;
    try {
        referenceDatabase = new DatabaseSync(':memory:');
        for (const migration of SQLITE_CATALOG_MIGRATIONS) {
            referenceDatabase.exec(migration.sql);
        }
        expectedCatalogSchemaSignatures = Object.freeze(
            readCatalogSchemaSignatures(referenceDatabase)
        );
        return expectedCatalogSchemaSignatures;
    } finally {
        closeQuietly(referenceDatabase);
    }
}

function verifyImmutableSchema(database: CatalogDatabase): void {
    const actual = readCatalogSchemaSignatures(database);
    const expected = getExpectedCatalogSchemaSignatures();
    const mismatchIndex = actual.findIndex((signature, index) => signature !== expected[index]);
    if (actual.length !== expected.length || mismatchIndex >= 0) {
        throw new CatalogOpenError(
            'invalid_schema',
            'SQLite schema definitions or indexes do not match the immutable migration contract.'
        );
    }
}

function verifyCatalogSchema(database: CatalogDatabase): void {
    const applicationId = readPragmaNumber(database, 'PRAGMA application_id', 'PRAGMA application_id');
    const schemaVersion = readPragmaNumber(database, 'PRAGMA user_version', 'PRAGMA user_version');
    if (applicationId !== SQLITE_CATALOG_APPLICATION_ID || schemaVersion !== SQLITE_CATALOG_SCHEMA_VERSION) {
        throw new CatalogOpenError('invalid_schema', 'SQLite catalog identity or schema version changed during open.');
    }
    verifyMigrationLedger(database, schemaVersion);
    verifyRequiredColumns(database);
    verifyImmutableSchema(database);
}

function migrateOrValidateCatalog(
    database: CatalogDatabase,
    appVersion: string,
    appliedAtUtc: string
): void {
    const applicationId = readPragmaNumber(database, 'PRAGMA application_id', 'PRAGMA application_id');
    const schemaVersion = readPragmaNumber(database, 'PRAGMA user_version', 'PRAGMA user_version');
    const userSchemaObjects = readUserSchemaObjectNames(database);
    if (applicationId !== 0 && applicationId !== SQLITE_CATALOG_APPLICATION_ID) {
        throw new CatalogOpenError('foreign_database', 'Database application_id does not belong to Garda.');
    }
    if (applicationId === 0 && userSchemaObjects.length > 0) {
        throw new CatalogOpenError('foreign_database', 'Non-empty database has no Garda application identity.');
    }
    if (schemaVersion > SQLITE_CATALOG_SCHEMA_VERSION) {
        throw new CatalogOpenError('newer_schema', `Catalog schema ${schemaVersion} is newer than supported schema ${SQLITE_CATALOG_SCHEMA_VERSION}.`);
    }
    if (schemaVersion === 0 && userSchemaObjects.length > 0) {
        throw new CatalogOpenError('invalid_schema', 'Schema version 0 database must be empty.');
    }
    if (schemaVersion > 0) {
        verifyMigrationLedger(database, schemaVersion);
    }
    let migrated = false;
    for (const migration of SQLITE_CATALOG_MIGRATIONS) {
        if (migration.version > schemaVersion) {
            applyMigration(database, migration, appVersion, appliedAtUtc);
            migrated = true;
        }
    }
    verifyCatalogSchema(database);
    if (migrated) verifyQuickCheck(database);
}

function enableNormalConnectionPolicy(database: CatalogDatabase): void {
    const journalMode = readPragmaString(database, 'PRAGMA journal_mode = WAL', 'PRAGMA journal_mode');
    if (journalMode.toLowerCase() !== 'wal') {
        throw new CatalogOpenError('wal_unavailable', `SQLite returned journal_mode '${journalMode}', not WAL.`);
    }
    database.exec([
        'PRAGMA synchronous = NORMAL;',
        'PRAGMA wal_autocheckpoint = 1000;'
    ].join('\n'));
    const foreignKeys = readPragmaNumber(database, 'PRAGMA foreign_keys', 'PRAGMA foreign_keys');
    const busyTimeout = readPragmaNumber(database, 'PRAGMA busy_timeout', 'PRAGMA busy_timeout');
    if (foreignKeys !== 1 || busyTimeout !== SQLITE_CATALOG_BUSY_TIMEOUT_MS) {
        throw new CatalogOpenError('open_failed', 'SQLite connection policy verification failed.');
    }
}

function classifyWriteFailure(error: unknown): SqliteCatalogWriteDeferredReason {
    return contentionReason(error) || 'write_error';
}

function classifyUnexpectedOpenFailure(error: unknown): SqliteCatalogUnavailableReason {
    const message = errorMessage(error).toLowerCase();
    const contention = contentionReason(error);
    if (contention) return contention;
    return /malformed|corrupt|not a database/u.test(message)
        ? 'corrupt_catalog'
        : 'open_failed';
}

class OpenCatalog implements DerivedSqliteCatalog {
    readonly catalogPath: string;
    readonly schemaVersion = SQLITE_CATALOG_SCHEMA_VERSION;
    private readonly database: CatalogDatabase;
    private closed = false;

    constructor(catalogPath: string, database: CatalogDatabase) {
        this.catalogPath = catalogPath;
        this.database = database;
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('SQLite catalog connection is closed.');
    }

    replaceProjection(projection: DerivedCatalogProjection): SqliteCatalogWriteResult {
        this.assertOpen();
        try {
            const result = replaceCatalogProjection(this.database, projection);
            return { status: 'applied', generation: result.generation, counts: result.counts };
        } catch (error: unknown) {
            if (error instanceof CatalogProjectionValidationError) {
                throw error;
            }
            if (error instanceof CatalogProjectionRebuildRequiredError) {
                return {
                    status: 'rebuild_required',
                    reason: 'projection_too_large',
                    minimumRows: error.minimumRows,
                    maximumTransactionRows: error.maximumTransactionRows,
                    diagnostic: error.message
                };
            }
            return {
                status: 'deferred',
                reason: classifyWriteFailure(error),
                diagnostic: errorMessage(error)
            };
        }
    }

    inspect(): SqliteCatalogInspection {
        this.assertOpen();
        const state = this.database.prepare(`
            SELECT generation, projection_status, snapshot_sha256, refreshed_at_utc
            FROM catalog_state WHERE singleton_id = 1
        `).get() as Record<string, unknown> | undefined;
        const projectionStatus = String(state?.projection_status || '');
        if (!['empty', 'ready', 'stale'].includes(projectionStatus)) {
            throw new Error('SQLite catalog state has an invalid projection status.');
        }
        const generation = Number(state?.generation);
        if (!Number.isSafeInteger(generation) || generation < 0) {
            throw new Error('SQLite catalog state has an invalid generation.');
        }
        return {
            catalogPath: this.catalogPath,
            applicationId: readPragmaNumber(this.database, 'PRAGMA application_id', 'PRAGMA application_id'),
            schemaVersion: readPragmaNumber(this.database, 'PRAGMA user_version', 'PRAGMA user_version'),
            journalMode: readPragmaString(this.database, 'PRAGMA journal_mode', 'PRAGMA journal_mode'),
            foreignKeysEnabled: readPragmaNumber(this.database, 'PRAGMA foreign_keys', 'PRAGMA foreign_keys') === 1,
            busyTimeoutMs: readPragmaNumber(this.database, 'PRAGMA busy_timeout', 'PRAGMA busy_timeout'),
            generation,
            projectionStatus: projectionStatus as SqliteCatalogInspection['projectionStatus'],
            snapshotSha256: typeof state?.snapshot_sha256 === 'string' ? state.snapshot_sha256 : null,
            refreshedAtUtc: typeof state?.refreshed_at_utc === 'string' ? state.refreshed_at_utc : null,
            counts: readCatalogCounts(this.database)
        };
    }

    close(): void {
        if (this.closed) return;
        this.database.close();
        this.closed = true;
        ACTIVE_CATALOG_PATHS.delete(this.catalogPath);
    }
}

function unavailableResult(
    reason: SqliteCatalogUnavailableReason,
    diagnostic: string,
    catalogPath: string | null
): OpenDerivedSqliteCatalogResult {
    return { status: 'unavailable', catalogPath, reason, diagnostic };
}

export function openDerivedSqliteCatalog(
    repoRoot: string,
    options: OpenDerivedSqliteCatalogOptions = {}
): OpenDerivedSqliteCatalogResult {
    let catalogPath: string | null = null;
    let database: CatalogDatabase | null = null;
    const assessFilesystem = createSqliteWalFilesystemAssessmentSession();
    try {
        catalogPath = resolveDerivedSqliteCatalogPathWithAssessment(repoRoot, assessFilesystem);
        const capability = probeSqliteCatalogCapability();
        if (!capability.available) {
            return unavailableResult('capability_unavailable', capability.diagnostic, catalogPath);
        }
        if (ACTIVE_CATALOG_PATHS.has(catalogPath)) {
            return unavailableResult('already_open', 'This process already owns the workspace catalog connection.', catalogPath);
        }
        const DatabaseSync = loadSqliteDatabaseConstructor();
        if (!DatabaseSync) {
            return unavailableResult('capability_unavailable', 'node:sqlite DatabaseSync became unavailable.', catalogPath);
        }
        ensureCatalogDirectory(catalogPath);
        catalogPath = resolveDerivedSqliteCatalogPathWithAssessment(repoRoot, assessFilesystem);
        assertCatalogDirectoryInsideWorkspace(repoRoot, catalogPath);
        assertCatalogFilesInsideWorkspace(repoRoot, catalogPath);
        database = new DatabaseSync(catalogPath);
        applyConnectionSafetyPragmas(database);
        const appliedAtUtc = (options.clock || (() => new Date().toISOString()))();
        initializeOrValidateCatalog(
            database,
            catalogPath,
            readAppVersion(repoRoot, options.appVersion),
            appliedAtUtc
        );
        enforceCatalogFilePermissions(catalogPath);
        enableNormalConnectionPolicy(database);
        enforceCatalogFilePermissions(catalogPath);
        ACTIVE_CATALOG_PATHS.add(catalogPath);
        const catalog = new OpenCatalog(catalogPath, database);
        database = null;
        return { status: 'available', catalog };
    } catch (error: unknown) {
        closeQuietly(database);
        if (error instanceof CatalogOpenError) {
            return unavailableResult(error.reason, error.message, catalogPath);
        }
        return unavailableResult(classifyUnexpectedOpenFailure(error), errorMessage(error), catalogPath);
    }
}
