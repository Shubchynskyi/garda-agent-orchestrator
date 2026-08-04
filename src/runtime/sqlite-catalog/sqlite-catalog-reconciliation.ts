import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import type {
    SqliteCatalogCounts,
    SqliteCatalogRebuildProgress,
    SqliteCatalogSourceInspection
} from './sqlite-catalog-contracts';
import {
    CanonicalCatalogInputError,
    buildCanonicalCatalogProjection,
    type CanonicalCatalogBuildOptions,
    type CanonicalCatalogBuildResult,
    type CanonicalCatalogSourceFingerprint
} from './sqlite-catalog-ingestion';
import {
    assertNoActiveDerivedSqliteCatalogConnectionLeases,
    openDerivedSqliteCatalog,
    openDerivedSqliteCatalogDuringMaintenance,
    openDerivedSqliteCatalogReadOnly,
    resolveDerivedSqliteCatalogPath,
    withExclusiveDerivedSqliteCatalogMaintenance
} from './sqlite-catalog';
import { loadSqliteDatabaseConstructor } from './sqlite-catalog-driver';

export type CatalogHealthStatus =
    | 'healthy'
    | 'missing'
    | 'drifted'
    | 'stale'
    | 'corrupt'
    | 'unavailable'
    | 'canonical_invalid';

export interface DerivedCatalogHealthReport {
    readonly status: CatalogHealthStatus;
    readonly canonicalReadable: boolean;
    readonly parity: boolean;
    readonly catalogPath: string | null;
    readonly canonicalSnapshotSha256: string | null;
    readonly catalogSnapshotSha256: string | null;
    readonly generation: number | null;
    readonly canonicalGeneration?: number | null;
    readonly changedSources: readonly string[];
    readonly diagnostic: string;
}

export type CatalogReconciliationStatus =
    | 'applied'
    | 'current'
    | 'rebuild_required'
    | 'deferred'
    | 'unavailable'
    | 'canonical_invalid';

export interface CatalogReconciliationResult {
    readonly status: CatalogReconciliationStatus;
    readonly canonicalReadable: boolean;
    readonly catalogPath: string | null;
    readonly canonicalSnapshotSha256: string | null;
    readonly generation: number | null;
    readonly counts?: SqliteCatalogCounts;
    readonly changedSources: readonly string[];
    readonly diagnostic: string;
}

export interface DerivedCatalogRebuildOptions extends CanonicalCatalogBuildOptions {
    readonly batchSize?: number;
    readonly onProgress?: (event: SqliteCatalogRebuildProgress) => void;
}

export interface CatalogRebuildResult {
    readonly status: 'rebuilt' | 'deferred' | 'unavailable' | 'canonical_invalid';
    readonly canonicalReadable: boolean;
    readonly catalogPath: string | null;
    readonly canonicalSnapshotSha256: string | null;
    readonly generation: number | null;
    readonly counts?: SqliteCatalogCounts;
    readonly diagnostic: string;
}

export interface DerivedCatalogRepairOptions extends DerivedCatalogRebuildOptions {
    readonly apply?: boolean;
}

export interface CatalogRepairResult {
    readonly status: 'dry_run' | 'repaired' | 'healthy' | 'deferred' | 'canonical_invalid';
    readonly canonicalReadable: boolean;
    readonly catalogPath: string | null;
    readonly quarantinePath: string | null;
    readonly diagnostic: string;
}

const scheduledCatalogReconciliations = new Map<
    string,
    Promise<CatalogReconciliationResult | null>
>();

// Automatic write-through is a preview-stage convenience, not a license to
// put an unbounded canonical scan on every writer's event loop. Larger
// catalogs remain safely stale until an explicit reconciliation or rebuild.
const MAX_AUTOMATIC_RECONCILIATION_STORAGE_BYTES = 512 * 1024;
const MAX_AUTOMATIC_RECONCILIATION_CANONICAL_ENTRIES = 512;

interface AutomaticCanonicalWorkloadInspection {
    readonly storageBytes: number;
    readonly entryCount: number;
    readonly limitExceeded: boolean;
}

function emitScheduledReconciliationDiagnostic(repoRoot: string, diagnostic: string): void {
    const boundedDiagnostic = diagnostic.replace(/\s+/gu, ' ').trim().slice(0, 512);
    process.stderr.write(
        `WARNING: Derived SQLite catalog reconciliation was deferred for '${repoRoot}': `
        + `${boundedDiagnostic || 'unknown projection error'}\n`
    );
}

function scheduledReconciliationDeferral(
    catalogPath: string | null,
    diagnostic: string
): CatalogReconciliationResult {
    return {
        status: 'deferred',
        canonicalReadable: false,
        catalogPath,
        canonicalSnapshotSha256: null,
        generation: null,
        changedSources: [],
        diagnostic
    };
}

function catalogRecoveryUnitSize(catalogPath: string): number {
    let totalBytes = 0;
    for (const candidatePath of [catalogPath, `${catalogPath}-wal`]) {
        if (!fs.existsSync(candidatePath)) continue;
        const state = fs.lstatSync(candidatePath);
        if (state.isSymbolicLink() || !state.isFile()) {
            throw new Error(`SQLite catalog recovery-unit member must be a real file: ${candidatePath}`);
        }
        totalBytes += state.size;
        if (totalBytes > MAX_AUTOMATIC_RECONCILIATION_STORAGE_BYTES) break;
    }
    return totalBytes;
}

function inspectAutomaticCanonicalWorkload(repoRoot: string): AutomaticCanonicalWorkloadInspection {
    const orchestratorRoot = joinOrchestratorPath(repoRoot, '');
    const pendingPaths = [
        path.join(repoRoot, 'TASK.md'),
        path.join(orchestratorRoot, 'runtime', 'task-events'),
        path.join(orchestratorRoot, 'runtime', 'task-ledger'),
        path.join(orchestratorRoot, 'runtime', 'metrics.jsonl'),
        path.join(orchestratorRoot, 'runtime', 'reviews')
    ];
    let storageBytes = 0;
    let entryCount = 0;

    while (pendingPaths.length > 0) {
        const candidatePath = pendingPaths.pop() as string;
        if (!fs.existsSync(candidatePath)) continue;
        const state = fs.lstatSync(candidatePath);
        entryCount += 1;
        if (entryCount > MAX_AUTOMATIC_RECONCILIATION_CANONICAL_ENTRIES) {
            return { storageBytes, entryCount, limitExceeded: true };
        }
        if (state.isSymbolicLink()) {
            throw new Error(`Automatic canonical workload member must not be a filesystem link: ${candidatePath}`);
        }
        if (state.isFile()) {
            storageBytes += state.size;
            if (storageBytes > MAX_AUTOMATIC_RECONCILIATION_STORAGE_BYTES) {
                return { storageBytes, entryCount, limitExceeded: true };
            }
            continue;
        }
        if (!state.isDirectory()) {
            throw new Error(`Automatic canonical workload member must be a real file or directory: ${candidatePath}`);
        }

        const directory = fs.opendirSync(candidatePath);
        try {
            let entry = directory.readSync();
            while (entry !== null) {
                if (
                    entryCount + pendingPaths.length
                    >= MAX_AUTOMATIC_RECONCILIATION_CANONICAL_ENTRIES
                ) {
                    return {
                        storageBytes,
                        entryCount: entryCount + pendingPaths.length + 1,
                        limitExceeded: true
                    };
                }
                pendingPaths.push(path.join(candidatePath, entry.name));
                entry = directory.readSync();
            }
        } finally {
            directory.closeSync();
        }
    }

    return { storageBytes, entryCount, limitExceeded: false };
}

function preflightScheduledReconciliation(
    repoRoot: string,
    catalogPath: string
): CatalogReconciliationResult | null {
    try {
        const storageBytes = catalogRecoveryUnitSize(catalogPath);
        if (storageBytes > MAX_AUTOMATIC_RECONCILIATION_STORAGE_BYTES) {
            return scheduledReconciliationDeferral(
                catalogPath,
                `Automatic reconciliation skipped before canonical scanning because the SQLite catalog recovery unit `
                + `uses ${storageBytes} bytes, above the bounded automatic limit of `
                + `${MAX_AUTOMATIC_RECONCILIATION_STORAGE_BYTES} bytes. Run explicit catalog reconciliation or rebuild; `
                + `canonical readers remain authoritative.`
            );
        }
        const canonicalWorkload = inspectAutomaticCanonicalWorkload(repoRoot);
        if (canonicalWorkload.limitExceeded) {
            return scheduledReconciliationDeferral(
                catalogPath,
                `Automatic reconciliation skipped before canonical scanning because the canonical workload `
                + `exceeds the bounded automatic limit of ${MAX_AUTOMATIC_RECONCILIATION_STORAGE_BYTES} bytes `
                + `or ${MAX_AUTOMATIC_RECONCILIATION_CANONICAL_ENTRIES} filesystem entries `
                + `(observed ${canonicalWorkload.storageBytes} bytes across at least `
                + `${canonicalWorkload.entryCount} entries). Run explicit catalog reconciliation or rebuild; `
                + `canonical readers remain authoritative.`
            );
        }
        assertNoActiveDerivedSqliteCatalogConnectionLeases(catalogPath);
    } catch (error: unknown) {
        return scheduledReconciliationDeferral(
            catalogPath,
            `Automatic reconciliation skipped before canonical scanning: ${errorMessage(error)}`
        );
    }
    return null;
}

/**
 * Coalesces production canonical commits into one best-effort projection update
 * per event-loop turn. A missing catalog is intentionally not bootstrapped from
 * a normal canonical writer; repair/rebuild owns first-time materialization.
 */
export function scheduleDerivedSqliteCatalogReconciliation(repoRoot: string): void {
    const resolvedRepoRoot = path.resolve(repoRoot);
    if (scheduledCatalogReconciliations.has(resolvedRepoRoot)) return;

    let catalogPath: string;
    try {
        catalogPath = resolveDerivedSqliteCatalogPath(resolvedRepoRoot);
    } catch (error: unknown) {
        emitScheduledReconciliationDiagnostic(
            resolvedRepoRoot,
            error instanceof Error ? error.message : String(error)
        );
        return;
    }
    if (!fs.existsSync(catalogPath)) return;

    let resolvePending!: (result: CatalogReconciliationResult | null) => void;
    const pending = new Promise<CatalogReconciliationResult | null>((resolve) => {
        resolvePending = resolve;
    });
    scheduledCatalogReconciliations.set(resolvedRepoRoot, pending);
    setImmediate(() => {
        let result: CatalogReconciliationResult | null = null;
        try {
            if (fs.existsSync(catalogPath)) {
                result = preflightScheduledReconciliation(resolvedRepoRoot, catalogPath)
                    ?? reconcileDerivedSqliteCatalog(resolvedRepoRoot);
                if (result.status !== 'applied' && result.status !== 'current') {
                    emitScheduledReconciliationDiagnostic(resolvedRepoRoot, result.diagnostic);
                }
            }
        } catch (error: unknown) {
            emitScheduledReconciliationDiagnostic(
                resolvedRepoRoot,
                error instanceof Error ? error.message : String(error)
            );
        } finally {
            scheduledCatalogReconciliations.delete(resolvedRepoRoot);
            resolvePending(result);
        }
    });
}

export function flushScheduledDerivedSqliteCatalogReconciliation(
    repoRoot: string
): Promise<CatalogReconciliationResult | null> {
    return scheduledCatalogReconciliations.get(path.resolve(repoRoot)) ?? Promise.resolve(null);
}

export interface CanonicalFirstCatalogWriteResult<T> {
    readonly canonicalResult: T;
    readonly projectionStatus: 'applied' | 'deferred';
    readonly diagnostic: string | null;
}

function errorMessage(error: unknown): string {
    return error instanceof Error && error.message ? error.message : String(error || 'unknown error');
}

function sourceKey(sourceKind: string, sourcePath: string): string {
    return `${sourceKind}\0${sourcePath}`;
}

function changedSourcePaths(
    canonical: readonly CanonicalCatalogSourceFingerprint[],
    catalog: readonly SqliteCatalogSourceInspection[]
): string[] {
    const canonicalByKey = new Map(
        canonical.map((entry) => [sourceKey(entry.sourceKind, entry.sourcePath), entry] as const)
    );
    const catalogByKey = new Map(
        catalog.map((entry) => [sourceKey(entry.sourceKind, entry.sourcePath), entry] as const)
    );
    const changed = new Set<string>();
    for (const [key, source] of canonicalByKey) {
        if (catalogByKey.get(key)?.contentSha256 !== source.contentSha256) changed.add(source.sourcePath);
    }
    for (const [key, source] of catalogByKey) {
        if (!canonicalByKey.has(key)) changed.add(source.sourcePath);
    }
    return [...changed].sort((left, right) => left.localeCompare(right));
}

function buildCanonical(
    repoRoot: string,
    options: CanonicalCatalogBuildOptions
): { status: 'valid'; build: CanonicalCatalogBuildResult } | {
    status: 'invalid';
    diagnostic: string;
} {
    try {
        return { status: 'valid', build: buildCanonicalCatalogProjection(repoRoot, options) };
    } catch (error: unknown) {
        return {
            status: 'invalid',
            diagnostic: error instanceof CanonicalCatalogInputError
                ? error.message
                : `Canonical catalog scan failed: ${errorMessage(error)}`
        };
    }
}

function isCorruptionReason(reason: string): boolean {
    return reason === 'corrupt_catalog' || reason === 'invalid_schema' || reason === 'foreign_database';
}

export function inspectDerivedCatalogHealth(
    repoRoot: string,
    options: CanonicalCatalogBuildOptions = {}
): DerivedCatalogHealthReport {
    const canonical = buildCanonical(repoRoot, options);
    let catalogPath: string | null = null;
    try {
        catalogPath = resolveDerivedSqliteCatalogPath(repoRoot);
    } catch (error: unknown) {
        return {
            status: canonical.status === 'valid' ? 'unavailable' : 'canonical_invalid',
            canonicalReadable: canonical.status === 'valid',
            parity: false,
            catalogPath: null,
            canonicalSnapshotSha256: canonical.status === 'valid' ? canonical.build.projection.snapshotSha256 : null,
            catalogSnapshotSha256: null,
            generation: null,
            changedSources: [],
            diagnostic: canonical.status === 'valid' ? errorMessage(error) : canonical.diagnostic
        };
    }
    if (canonical.status === 'invalid') {
        return {
            status: 'canonical_invalid',
            canonicalReadable: false,
            parity: false,
            catalogPath,
            canonicalSnapshotSha256: null,
            catalogSnapshotSha256: null,
            generation: null,
            changedSources: [],
            diagnostic: canonical.diagnostic
        };
    }
    if (!fs.existsSync(catalogPath)) {
        return {
            status: 'missing',
            canonicalReadable: true,
            parity: false,
            catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            catalogSnapshotSha256: null,
            generation: null,
            changedSources: canonical.build.sourcePaths,
            diagnostic: 'Derived SQLite catalog is missing; canonical readers remain available.'
        };
    }

    const opened = openDerivedSqliteCatalogReadOnly(repoRoot);
    if (opened.status === 'unavailable') {
        return {
            status: isCorruptionReason(opened.reason) ? 'corrupt' : 'unavailable',
            canonicalReadable: true,
            parity: false,
            catalogPath: opened.catalogPath || catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            catalogSnapshotSha256: null,
            generation: null,
            changedSources: canonical.build.sourcePaths,
            diagnostic: opened.diagnostic
        };
    }
    try {
        const inspection = opened.catalog.inspect();
        const changedSources = changedSourcePaths(
            canonical.build.sourceFingerprints,
            opened.catalog.inspectSources()
        );
        const generationParity = canonical.build.projection.canonicalGeneration === null
            || canonical.build.projection.canonicalGeneration === undefined
            || inspection.canonicalGeneration === canonical.build.projection.canonicalGeneration;
        const snapshotParity = inspection.projectionStatus === 'ready'
            && inspection.snapshotSha256 === canonical.build.projection.snapshotSha256;
        const rowParity = snapshotParity
            ? opened.catalog.inspectParity(canonical.build.projection)
            : { parity: false, mismatchedTables: [] as readonly string[] };
        const parity = snapshotParity && generationParity && rowParity.parity;
        return {
            status: parity ? 'healthy' : inspection.projectionStatus === 'stale' ? 'stale' : 'drifted',
            canonicalReadable: true,
            parity,
            catalogPath: inspection.catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            catalogSnapshotSha256: inspection.snapshotSha256,
            generation: inspection.generation,
            canonicalGeneration: inspection.canonicalGeneration,
            changedSources: rowParity.mismatchedTables.length > 0
                ? [...changedSources, ...rowParity.mismatchedTables.map((table) => `sqlite:${table}`)]
                : !generationParity
                ? [...changedSources, 'runtime-generation']
                : changedSources,
            diagnostic: parity
                ? 'Derived SQLite catalog matches the validated canonical snapshot.'
                : !generationParity
                ? 'Derived SQLite catalog canonical mutation generation is stale.'
                : rowParity.mismatchedTables.length > 0
                ? `Derived SQLite catalog row parity failed for: ${rowParity.mismatchedTables.join(', ')}.`
                : 'Derived SQLite catalog does not match the validated canonical snapshot.'
        };
    } finally {
        opened.catalog.close();
    }
}

export function reconcileDerivedSqliteCatalog(
    repoRoot: string,
    options: CanonicalCatalogBuildOptions = {}
): CatalogReconciliationResult {
    const canonical = buildCanonical(repoRoot, options);
    if (canonical.status === 'invalid') {
        return {
            status: 'canonical_invalid',
            canonicalReadable: false,
            catalogPath: null,
            canonicalSnapshotSha256: null,
            generation: null,
            changedSources: [],
            diagnostic: canonical.diagnostic
        };
    }
    const opened = openDerivedSqliteCatalog(repoRoot, options);
    if (opened.status === 'unavailable') {
        return {
            status: opened.reason === 'busy' || opened.reason === 'locked' || opened.reason === 'already_open'
                ? 'deferred'
                : 'unavailable',
            canonicalReadable: true,
            catalogPath: opened.catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            generation: null,
            changedSources: canonical.build.sourcePaths,
            diagnostic: opened.diagnostic
        };
    }
    try {
        const inspection = opened.catalog.inspect();
        let changedSources = changedSourcePaths(
            canonical.build.sourceFingerprints,
            opened.catalog.inspectSources()
        );
        const generationCurrent = canonical.build.projection.canonicalGeneration === null
            || canonical.build.projection.canonicalGeneration === undefined
            || inspection.canonicalGeneration === canonical.build.projection.canonicalGeneration;
        const snapshotCurrent = inspection.projectionStatus === 'ready'
            && inspection.snapshotSha256 === canonical.build.projection.snapshotSha256;
        const rowParity = snapshotCurrent
            ? opened.catalog.inspectParity(canonical.build.projection)
            : { parity: false, mismatchedTables: [] as readonly string[] };
        if (snapshotCurrent && generationCurrent && rowParity.parity) {
            return {
                status: 'current',
                canonicalReadable: true,
                catalogPath: inspection.catalogPath,
                canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
                generation: inspection.generation,
                counts: inspection.counts,
                changedSources: [],
                diagnostic: 'Derived SQLite catalog is already current.'
            };
        }
        if (!generationCurrent) changedSources = [...changedSources, 'runtime-generation'];
        if (rowParity.mismatchedTables.length > 0) {
            changedSources = [
                ...changedSources,
                ...rowParity.mismatchedTables.map((table) => `sqlite:${table}`)
            ];
        }

        const result = rowParity.mismatchedTables.length > 0 || inspection.projectionStatus === 'stale'
            ? opened.catalog.replaceProjection(canonical.build.projection)
            : opened.catalog.reconcileProjection(canonical.build.projection);
        if (result.status === 'applied') {
            return {
                status: 'applied',
                canonicalReadable: true,
                catalogPath: opened.catalog.catalogPath,
                canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
                generation: result.generation,
                counts: result.counts,
                changedSources,
                diagnostic: 'Canonical snapshot was applied to the derived SQLite catalog.'
            };
        }
        return {
            status: result.status,
            canonicalReadable: true,
            catalogPath: opened.catalog.catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            generation: inspection.generation,
            changedSources,
            diagnostic: result.diagnostic
        };
    } finally {
        opened.catalog.close();
    }
}

function createRebuildStagingRoot(catalogDirectory: string, appVersion: string): string {
    const stagingRoot = path.join(catalogDirectory, `.rebuild-${randomUUID()}`);
    fs.mkdirSync(stagingRoot, { recursive: false });
    fs.writeFileSync(path.join(stagingRoot, 'MANIFEST.md'), '# SQLite catalog rebuild staging\n', 'utf8');
    fs.writeFileSync(path.join(stagingRoot, 'VERSION'), `${appVersion.trim() || '0.0.0'}\n`, 'utf8');
    return stagingRoot;
}

function readWorkspaceAppVersion(catalogPath: string): string {
    const orchestratorRoot = path.dirname(path.dirname(path.dirname(catalogPath)));
    try {
        return fs.readFileSync(path.join(orchestratorRoot, 'VERSION'), 'utf8').trim() || '0.0.0';
    } catch {
        return '0.0.0';
    }
}

function flushCatalogFile(catalogPath: string): void {
    const fileDescriptor = fs.openSync(catalogPath, 'r+');
    try {
        fs.fsyncSync(fileDescriptor);
    } finally {
        fs.closeSync(fileDescriptor);
    }
}

function sealCatalogRecoveryUnit(
    catalogPath: string,
    label: 'Rebuild' | 'Live',
    validateIntegrity: boolean
): void {
    const DatabaseSync = loadSqliteDatabaseConstructor();
    if (!DatabaseSync) throw new Error(`node:sqlite DatabaseSync is unavailable for ${label.toLowerCase()} sealing.`);
    const database = new DatabaseSync(catalogPath);
    try {
        database.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;');
        const checkpoint = database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as Record<string, unknown> | undefined;
        const checkpointValues = Object.values(checkpoint || {}).map(Number);
        if (
            checkpointValues.length < 3
            || checkpointValues.some((value) => !Number.isFinite(value))
            || checkpointValues[0] !== 0
            || checkpointValues[1] !== checkpointValues[2]
        ) {
            throw new Error(`${label} WAL checkpoint did not prove that every frame was checkpointed.`);
        }
        if (validateIntegrity) {
            const quickCheck = database.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
            if (String(Object.values(quickCheck || {})[0] || '').toLowerCase() !== 'ok') {
                throw new Error(`${label} quick_check did not return ok.`);
            }
            const integrityCheck = database.prepare('PRAGMA integrity_check').all() as Record<string, unknown>[];
            if (
                integrityCheck.length !== 1
                || String(Object.values(integrityCheck[0] || {})[0] || '').toLowerCase() !== 'ok'
            ) {
                throw new Error(`${label} integrity_check did not return exactly one ok result.`);
            }
            if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
                throw new Error(`${label} foreign_key_check reported violations.`);
            }
        }
    } finally {
        database.close();
    }
    const walPath = `${catalogPath}-wal`;
    if (fs.existsSync(walPath) && fs.statSync(walPath).size > 0) {
        throw new Error(`${label} sealing left a non-empty WAL file.`);
    }
    for (const transientPath of [walPath, `${catalogPath}-shm`]) {
        if (fs.existsSync(transientPath)) fs.rmSync(transientPath, { force: true });
    }
    flushCatalogFile(catalogPath);
}

function sealRebuildCatalog(catalogPath: string): void {
    sealCatalogRecoveryUnit(catalogPath, 'Rebuild', true);
}

function sealLiveCatalogForPromotion(catalogPath: string): void {
    sealCatalogRecoveryUnit(catalogPath, 'Live', false);
}

function isMissingPathError(error: unknown): boolean {
    const code = String((error as NodeJS.ErrnoException)?.code || '');
    return code === 'ENOENT' || code === 'ENOTDIR';
}

function assertRealDirectoryInsideCatalog(catalogDirectory: string, directoryPath: string): void {
    const state = fs.lstatSync(directoryPath);
    if (state.isSymbolicLink() || !state.isDirectory()) {
        throw new Error(`Recovery directory must be a real non-symlink directory: ${directoryPath}`);
    }
    const catalogRealPath = fs.realpathSync.native(catalogDirectory);
    const directoryRealPath = fs.realpathSync.native(directoryPath);
    const relative = path.relative(catalogRealPath, directoryRealPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Recovery directory escapes the catalog directory: ${directoryPath}`);
    }
}

function ensureContainedRecoveryDirectory(
    catalogDirectory: string,
    destinationDirectory: string,
    createMissing: boolean
): void {
    const resolvedCatalogDirectory = path.resolve(catalogDirectory);
    const resolvedDestination = path.resolve(destinationDirectory);
    const relative = path.relative(resolvedCatalogDirectory, resolvedDestination);
    if (
        !relative
        || relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
    ) {
        throw new Error(`Recovery directory must be a child of the catalog directory: ${destinationDirectory}`);
    }
    assertRealDirectoryInsideCatalog(resolvedCatalogDirectory, resolvedCatalogDirectory);
    let currentPath = resolvedCatalogDirectory;
    for (const segment of relative.split(path.sep)) {
        currentPath = path.join(currentPath, segment);
        try {
            fs.lstatSync(currentPath);
        } catch (error: unknown) {
            if (!isMissingPathError(error)) throw error;
            if (!createMissing) {
                throw new Error(`Recovery directory is missing: ${currentPath}`);
            }
            fs.mkdirSync(currentPath, { recursive: false, mode: 0o700 });
            if (process.platform !== 'win32') fs.chmodSync(currentPath, 0o700);
        }
        assertRealDirectoryInsideCatalog(resolvedCatalogDirectory, currentPath);
    }
}

function copyCatalogRecoveryUnit(sourceMain: string, destinationDirectory: string): void {
    const catalogDirectory = path.dirname(sourceMain);
    ensureContainedRecoveryDirectory(catalogDirectory, destinationDirectory, true);
    for (const sourcePath of [sourceMain, `${sourceMain}-wal`, `${sourceMain}-shm`]) {
        if (!fs.existsSync(sourcePath)) continue;
        ensureContainedRecoveryDirectory(catalogDirectory, destinationDirectory, false);
        const destinationPath = path.join(destinationDirectory, path.basename(sourcePath));
        fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
        ensureContainedRecoveryDirectory(catalogDirectory, destinationDirectory, false);
        flushCatalogFile(destinationPath);
    }
}

function moveCatalogRecoveryUnit(sourceMain: string, destinationDirectory: string): void {
    const catalogDirectory = path.dirname(sourceMain);
    ensureContainedRecoveryDirectory(catalogDirectory, destinationDirectory, true);
    const moved: Array<{ sourcePath: string; destinationPath: string }> = [];
    try {
        for (const sourcePath of [sourceMain, `${sourceMain}-wal`, `${sourceMain}-shm`]) {
            if (!fs.existsSync(sourcePath)) continue;
            ensureContainedRecoveryDirectory(catalogDirectory, destinationDirectory, false);
            const destinationPath = path.join(destinationDirectory, path.basename(sourcePath));
            fs.renameSync(sourcePath, destinationPath);
            ensureContainedRecoveryDirectory(catalogDirectory, destinationDirectory, false);
            moved.push({ sourcePath, destinationPath });
        }
    } catch (error: unknown) {
        const rollbackFailures: string[] = [];
        for (const entry of [...moved].reverse()) {
            try {
                if (fs.existsSync(entry.destinationPath)) fs.renameSync(entry.destinationPath, entry.sourcePath);
            } catch (rollbackError: unknown) {
                rollbackFailures.push(errorMessage(rollbackError));
            }
        }
        throw new Error(
            rollbackFailures.length > 0
                ? `${errorMessage(error)} Recovery-unit rollback also failed: ${rollbackFailures.join('; ')}`
                : errorMessage(error)
        );
    }
}

function restoreCatalogRecoveryUnit(catalogPath: string, backupDirectory: string): void {
    ensureContainedRecoveryDirectory(path.dirname(catalogPath), backupDirectory, false);
    const backupMain = path.join(backupDirectory, path.basename(catalogPath));
    for (const transientPath of [`${catalogPath}-wal`, `${catalogPath}-shm`]) {
        if (fs.existsSync(transientPath)) fs.rmSync(transientPath, { force: true });
    }
    fs.renameSync(backupMain, catalogPath);
    flushCatalogFile(catalogPath);
}

function removeSuccessfulStagingRoot(stagingRoot: string, catalogDirectory: string): void {
    if (
        path.dirname(stagingRoot) !== catalogDirectory
        || !path.basename(stagingRoot).startsWith('.rebuild-')
    ) {
        throw new Error(`Refusing to remove unexpected rebuild staging root: ${stagingRoot}`);
    }
    fs.rmSync(stagingRoot, { recursive: true, force: true });
}

function assertCanonicalProjectionCurrent(
    repoRoot: string,
    options: CanonicalCatalogBuildOptions,
    projection: CanonicalCatalogBuildResult['projection'],
    phase: string
): void {
    const refreshedCanonical = buildCanonical(repoRoot, options);
    if (refreshedCanonical.status === 'invalid') {
        throw new Error(`Canonical sources could not be validated ${phase}: ${refreshedCanonical.diagnostic}`);
    }
    if (
        refreshedCanonical.build.projection.snapshotSha256 !== projection.snapshotSha256
        || refreshedCanonical.build.projection.canonicalGeneration !== projection.canonicalGeneration
    ) {
        throw new Error(`Canonical sources changed ${phase}.`);
    }
}

function assertStagingCatalogReadyForPromotion(
    stagingRoot: string,
    projection: CanonicalCatalogBuildResult['projection']
): void {
    const opened = openDerivedSqliteCatalogReadOnly(stagingRoot);
    if (opened.status === 'unavailable') {
        throw new Error(`Staging catalog validation failed: ${opened.diagnostic}`);
    }
    try {
        const inspection = opened.catalog.inspect();
        const parity = opened.catalog.inspectParity(projection);
        if (
            inspection.projectionStatus !== 'ready'
            || inspection.snapshotSha256 !== projection.snapshotSha256
            || inspection.canonicalGeneration !== (projection.canonicalGeneration ?? null)
            || !parity.parity
        ) {
            throw new Error(
                `Staging catalog parity failed${parity.mismatchedTables.length > 0
                    ? `: ${parity.mismatchedTables.join(', ')}`
                    : '.'}`
            );
        }
    } finally {
        opened.catalog.close();
    }
}

function promoteRebuildCatalog(
    repoRoot: string,
    catalogPath: string,
    stagingCatalogPath: string,
    stagingRoot: string,
    projection: CanonicalCatalogBuildResult['projection'],
    options: CanonicalCatalogBuildOptions
): { generation: number; counts: SqliteCatalogCounts } {
    const catalogDirectory = path.dirname(catalogPath);
    const backupDirectory = path.join(
        catalogDirectory,
        'backups',
        `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
    );
    return withExclusiveDerivedSqliteCatalogMaintenance(
        catalogPath,
        'sqlite-catalog-rebuild-promotion',
        () => {
            assertCanonicalProjectionCurrent(repoRoot, options, projection, 'before catalog promotion');
            assertStagingCatalogReadyForPromotion(stagingRoot, projection);
            const hadLiveCatalog = fs.existsSync(catalogPath);
            if (hadLiveCatalog) {
                sealLiveCatalogForPromotion(catalogPath);
                copyCatalogRecoveryUnit(catalogPath, backupDirectory);
            }
            let promotedMainInstalled = false;
            try {
                fs.renameSync(stagingCatalogPath, catalogPath);
                promotedMainInstalled = true;
                const verified = openDerivedSqliteCatalogDuringMaintenance(repoRoot);
                if (verified.status === 'unavailable') {
                    throw new Error(`Promoted catalog validation failed: ${verified.diagnostic}`);
                }
                let promoted: { generation: number; counts: SqliteCatalogCounts };
                try {
                    const inspection = verified.catalog.inspect();
                    const parity = verified.catalog.inspectParity(projection);
                    if (
                        inspection.projectionStatus !== 'ready'
                        || inspection.snapshotSha256 !== projection.snapshotSha256
                        || inspection.canonicalGeneration !== (projection.canonicalGeneration ?? null)
                        || !parity.parity
                    ) {
                        throw new Error(
                            `Promoted catalog parity failed${parity.mismatchedTables.length > 0
                                ? `: ${parity.mismatchedTables.join(', ')}`
                                : '.'}`
                        );
                    }
                    promoted = { generation: inspection.generation, counts: inspection.counts };
                } finally {
                    verified.catalog.close();
                }
                assertCanonicalProjectionCurrent(repoRoot, options, projection, 'during catalog promotion');
                return promoted;
            } catch (error: unknown) {
                if (!promotedMainInstalled) throw error;
                try {
                    if (hadLiveCatalog && fs.existsSync(catalogPath)) {
                        const quarantineDirectory = path.join(
                            catalogDirectory,
                            'quarantine',
                            `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
                        );
                        copyCatalogRecoveryUnit(catalogPath, quarantineDirectory);
                    }
                } finally {
                    if (hadLiveCatalog) restoreCatalogRecoveryUnit(catalogPath, backupDirectory);
                    else if (fs.existsSync(catalogPath)) quarantineCatalog(catalogPath);
                }
                throw error;
            }
        }
    );
}

export function rebuildDerivedSqliteCatalog(
    repoRoot: string,
    options: DerivedCatalogRebuildOptions = {}
): CatalogRebuildResult {
    const canonical = buildCanonical(repoRoot, options);
    if (canonical.status === 'invalid') {
        return {
            status: 'canonical_invalid',
            canonicalReadable: false,
            catalogPath: null,
            canonicalSnapshotSha256: null,
            generation: null,
            diagnostic: canonical.diagnostic
        };
    }
    let catalogPath: string;
    try {
        catalogPath = resolveDerivedSqliteCatalogPath(repoRoot);
    } catch (error: unknown) {
        return {
            status: 'unavailable',
            canonicalReadable: true,
            catalogPath: null,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            generation: null,
            diagnostic: errorMessage(error)
        };
    }
    const catalogDirectory = path.dirname(catalogPath);
    fs.mkdirSync(catalogDirectory, { recursive: true });
    if (fs.existsSync(catalogPath)) {
        const live = openDerivedSqliteCatalog(repoRoot, options);
        if (live.status === 'unavailable') {
            const deferred = live.reason === 'busy' || live.reason === 'locked' || live.reason === 'already_open';
            return {
                status: deferred ? 'deferred' : 'unavailable',
                canonicalReadable: true,
                catalogPath,
                canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
                generation: null,
                diagnostic: `Live catalog cannot be safely closed for rebuild: ${live.diagnostic}`
            };
        }
        live.catalog.close();
    }
    const stagingRoot = createRebuildStagingRoot(
        catalogDirectory,
        readWorkspaceAppVersion(catalogPath)
    );
    const opened = openDerivedSqliteCatalog(stagingRoot, options);
    if (opened.status === 'unavailable') {
        return {
            status: 'unavailable',
            canonicalReadable: true,
            catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            generation: null,
            diagnostic: `Rebuild staging catalog is unavailable at '${stagingRoot.replace(/\\/gu, '/')}': ${opened.diagnostic}`
        };
    }
    const stagingCatalogPath = opened.catalog.catalogPath;
    try {
        const result = opened.catalog.rebuildProjection(canonical.build.projection, {
            batchSize: options.batchSize,
            onProgress: options.onProgress
        });
        if (result.status !== 'applied') {
            return {
                status: 'deferred',
                canonicalReadable: true,
                catalogPath,
                canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
                generation: opened.catalog.inspect().generation,
                diagnostic: `${result.diagnostic} Staging retained at '${stagingRoot.replace(/\\/gu, '/')}.'`
            };
        }
    } finally {
        opened.catalog.close();
    }
    try {
        sealRebuildCatalog(stagingCatalogPath);
        const promoted = promoteRebuildCatalog(
            repoRoot,
            catalogPath,
            stagingCatalogPath,
            stagingRoot,
            canonical.build.projection,
            options
        );
        removeSuccessfulStagingRoot(stagingRoot, catalogDirectory);
        return {
            status: 'rebuilt',
            canonicalReadable: true,
            catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            generation: promoted.generation,
            counts: promoted.counts,
            diagnostic: 'Derived SQLite catalog was rebuilt in staging, sealed, parity-validated, and promoted.'
        };
    } catch (error: unknown) {
        return {
            status: 'deferred',
            canonicalReadable: true,
            catalogPath,
            canonicalSnapshotSha256: canonical.build.projection.snapshotSha256,
            generation: null,
            diagnostic: `Catalog rebuild promotion failed: ${errorMessage(error)} Staging retained at '${stagingRoot.replace(/\\/gu, '/')}'.`
        };
    }
}

function quarantineCatalog(catalogPath: string): string {
    const catalogDirectory = path.dirname(catalogPath);
    const quarantineRoot = path.join(catalogDirectory, 'quarantine');
    const quarantinePath = path.join(
        quarantineRoot,
        `${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID()}`
    );
    moveCatalogRecoveryUnit(catalogPath, quarantinePath);
    return quarantinePath.replace(/\\/gu, '/');
}

export function repairDerivedSqliteCatalog(
    repoRoot: string,
    options: DerivedCatalogRepairOptions = {}
): CatalogRepairResult {
    const health = inspectDerivedCatalogHealth(repoRoot, options);
    if (health.status === 'canonical_invalid') {
        return {
            status: 'canonical_invalid',
            canonicalReadable: false,
            catalogPath: health.catalogPath,
            quarantinePath: null,
            diagnostic: health.diagnostic
        };
    }
    if (health.status === 'healthy') {
        return {
            status: 'healthy',
            canonicalReadable: true,
            catalogPath: health.catalogPath,
            quarantinePath: null,
            diagnostic: 'No catalog repair is required.'
        };
    }
    if (options.apply !== true) {
        return {
            status: 'dry_run',
            canonicalReadable: health.canonicalReadable,
            catalogPath: health.catalogPath,
            quarantinePath: null,
            diagnostic: `Repair preview: ${health.status}; no files were changed.`
        };
    }

    let quarantinePath: string | null = null;
    if (health.status === 'corrupt' && health.catalogPath && fs.existsSync(health.catalogPath)) {
        try {
            quarantinePath = withExclusiveDerivedSqliteCatalogMaintenance(
                health.catalogPath,
                'sqlite-catalog-corruption-quarantine',
                () => quarantineCatalog(health.catalogPath as string)
            );
        } catch (error: unknown) {
            return {
                status: 'deferred',
                canonicalReadable: true,
                catalogPath: health.catalogPath,
                quarantinePath: null,
                diagnostic: `Catalog quarantine failed: ${errorMessage(error)}`
            };
        }
    }

    let result = reconcileDerivedSqliteCatalog(repoRoot, options);
    if (result.status === 'rebuild_required') {
        const rebuilt = rebuildDerivedSqliteCatalog(repoRoot, options);
        if (rebuilt.status !== 'rebuilt') {
            return {
                status: rebuilt.status === 'canonical_invalid' ? 'canonical_invalid' : 'deferred',
                canonicalReadable: rebuilt.canonicalReadable,
                catalogPath: rebuilt.catalogPath,
                quarantinePath,
                diagnostic: rebuilt.diagnostic
            };
        }
        result = {
            status: 'applied',
            canonicalReadable: true,
            catalogPath: rebuilt.catalogPath,
            canonicalSnapshotSha256: rebuilt.canonicalSnapshotSha256,
            generation: rebuilt.generation,
            counts: rebuilt.counts,
            changedSources: health.changedSources,
            diagnostic: rebuilt.diagnostic
        };
    }
    if (result.status !== 'applied' && result.status !== 'current') {
        return {
            status: result.status === 'canonical_invalid' ? 'canonical_invalid' : 'deferred',
            canonicalReadable: result.canonicalReadable,
            catalogPath: result.catalogPath,
            quarantinePath,
            diagnostic: result.diagnostic
        };
    }
    return {
        status: 'repaired',
        canonicalReadable: true,
        catalogPath: result.catalogPath,
        quarantinePath,
        diagnostic: quarantinePath
            ? 'Corrupt catalog was quarantined and rebuilt from canonical sources.'
            : 'Catalog drift was repaired from canonical sources.'
    };
}

export function canonicalFirstCatalogWrite<T>(
    canonicalWrite: () => T,
    projectionUpdate: (canonicalResult: T) => unknown
): CanonicalFirstCatalogWriteResult<T> {
    const canonicalResult = canonicalWrite();
    try {
        const projectionResult = projectionUpdate(canonicalResult);
        if (
            isRecord(projectionResult)
            && typeof projectionResult.status === 'string'
            && projectionResult.status !== 'applied'
            && projectionResult.status !== 'current'
        ) {
            return {
                canonicalResult,
                projectionStatus: 'deferred',
                diagnostic: typeof projectionResult.diagnostic === 'string'
                    ? projectionResult.diagnostic
                    : `Projection update returned ${projectionResult.status}.`
            };
        }
        return { canonicalResult, projectionStatus: 'applied', diagnostic: null };
    } catch (error: unknown) {
        return {
            canonicalResult,
            projectionStatus: 'deferred',
            diagnostic: errorMessage(error)
        };
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
