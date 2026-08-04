import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath } from '../../core/orchestrator-paths';
import { isPathInsideRoot } from '../../core/paths';
import { isCanonicalTaskId, parseTaskIdJsonlFileName } from '../../core/task-ids';
import {
    readRuntimeMutationGeneration,
    RuntimeMutationGenerationError,
    type RuntimeMutationGenerationSnapshot
} from '../../gate-runtime/runtime-mutation-generation';
import type {
    CatalogTaskActivitySummary,
    DerivedSqliteCatalog,
    SqliteCatalogInspection,
    SqliteCatalogSourceInspection
} from './sqlite-catalog-contracts';
import { openDerivedSqliteCatalogReadOnly } from './sqlite-catalog';

export type SqliteQueryFallbackReason =
    | 'catalog_unavailable'
    | 'projection_not_ready'
    | 'generation_unavailable'
    | 'generation_mismatch'
    | 'source_missing'
    | 'source_changed'
    | 'not_performance_qualified'
    | 'query_failed';

export const SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES = 1_000;

export type SqliteQueryResult<T> =
    | {
        readonly source: 'sqlite';
        readonly value: T;
        readonly inspection: SqliteCatalogInspection;
    }
    | {
        readonly source: 'files';
        readonly reason: SqliteQueryFallbackReason;
        readonly diagnostic: string;
    };

type SqliteQueryFallback = Extract<SqliteQueryResult<never>, { readonly source: 'files' }>;

interface QuerySpec<T> {
    readonly sourceKinds: readonly string[];
    readonly query: (catalog: DerivedSqliteCatalog) => T;
}

function fallback(reason: SqliteQueryFallbackReason, diagnostic: string): SqliteQueryFallback {
    return { source: 'files', reason, diagnostic };
}

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function relevantSources(
    sources: readonly SqliteCatalogSourceInspection[],
    sourceKinds: readonly string[]
): readonly SqliteCatalogSourceInspection[] {
    const allowedKinds = new Set(sourceKinds);
    return sources.filter((source) => allowedKinds.has(source.sourceKind));
}

// Review artifacts are indirect canonical sources: their ownership and integrity
// declarations live in task events. A new canonical artifact therefore changes
// a task-event source first, while an unreferenced file under runtime/reviews is
// not part of the canonical artifact universe and must not invalidate the catalog.
const SOURCE_UNIVERSE_DRIVER_KINDS = new Set(['task_queue', 'task_events', 'task_ledger', 'metrics']);

function portableSourcePath(repoRoot: string, sourcePath: string): string {
    return path.relative(repoRoot, sourcePath).replace(/\\/gu, '/');
}

function sameSourceUniverse(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((sourcePath, index) => sourcePath === right[index]);
}

function discoverCanonicalSourceUniverse(
    repoRoot: string,
    sourceKinds: readonly string[]
): readonly string[] | SqliteQueryFallback {
    const allowedKinds = new Set(sourceKinds);
    const discovered: string[] = [];
    const orchestratorRoot = joinOrchestratorPath(repoRoot, '');
    const runtimeRoot = path.join(orchestratorRoot, 'runtime');

    if (allowedKinds.has('task_queue')) discovered.push(portableSourcePath(repoRoot, path.join(repoRoot, 'TASK.md')));

    const discoverDirectory = (
        sourceKind: string,
        directory: string,
        parseTaskId: (name: string) => string | null
    ): SqliteQueryFallback | null => {
        if (!allowedKinds.has(sourceKind)) return null;
        let directoryStat: fs.Stats;
        try {
            directoryStat = fs.lstatSync(directory);
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            return fallback('source_changed', `Cannot inspect canonical source directory: ${portableSourcePath(repoRoot, directory)}`);
        }
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
            return fallback(
                'source_changed',
                `Canonical source directory is not a regular non-symlink directory: ${portableSourcePath(repoRoot, directory)}`
            );
        }
        try {
            const entries = fs.readdirSync(directory, { withFileTypes: true });
            for (const entry of entries) {
                const entryTaskId = parseTaskId(entry.name);
                if (entryTaskId === null) continue;
                if (entry.isSymbolicLink() || !entry.isFile()) {
                    return fallback(
                        'source_changed',
                        `Canonical source is not a regular non-symlink file: ${portableSourcePath(repoRoot, path.join(directory, entry.name))}`
                    );
                }
                discovered.push(portableSourcePath(repoRoot, path.join(directory, entry.name)));
            }
            const finalDirectoryStat = fs.lstatSync(directory);
            if (
                finalDirectoryStat.isSymbolicLink()
                || !finalDirectoryStat.isDirectory()
                || finalDirectoryStat.dev !== directoryStat.dev
                || finalDirectoryStat.ino !== directoryStat.ino
                || finalDirectoryStat.mtimeMs !== directoryStat.mtimeMs
            ) {
                return fallback(
                    'source_changed',
                    `Canonical source directory changed while it was inspected: ${portableSourcePath(repoRoot, directory)}`
                );
            }
        } catch {
            return fallback('source_changed', `Canonical source directory changed while it was inspected: ${portableSourcePath(repoRoot, directory)}`);
        }
        return null;
    };

    const eventFailure = discoverDirectory(
        'task_events',
        path.join(runtimeRoot, 'task-events'),
        parseTaskIdJsonlFileName
    );
    if (eventFailure) return eventFailure;
    const ledgerFailure = discoverDirectory(
        'task_ledger',
        path.join(runtimeRoot, 'task-ledger'),
        (name) => {
            if (!name.endsWith('.json')) return null;
            const candidateTaskId = name.slice(0, -'.json'.length);
            return isCanonicalTaskId(candidateTaskId) ? candidateTaskId : null;
        }
    );
    if (ledgerFailure) return ledgerFailure;

    if (allowedKinds.has('metrics')) {
        const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');
        try {
            const metricsStat = fs.lstatSync(metricsPath);
            if (metricsStat.isSymbolicLink() || !metricsStat.isFile()) {
                return fallback('source_changed', `Canonical metrics source is not a regular non-symlink file: ${portableSourcePath(repoRoot, metricsPath)}`);
            }
            discovered.push(portableSourcePath(repoRoot, metricsPath));
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                return fallback('source_changed', `Cannot inspect canonical metrics source: ${portableSourcePath(repoRoot, metricsPath)}`);
            }
        }
    }
    return discovered.sort((left, right) => left.localeCompare(right));
}

function verifySourceUniverse(
    repoRoot: string,
    sources: readonly SqliteCatalogSourceInspection[],
    sourceKinds: readonly string[]
): SqliteQueryFallback | null {
    const discovered = discoverCanonicalSourceUniverse(repoRoot, sourceKinds);
    if ('source' in discovered) return discovered;
    const projected = sources
        .filter((source) => SOURCE_UNIVERSE_DRIVER_KINDS.has(source.sourceKind))
        .map((source) => source.sourcePath.replace(/\\/gu, '/'))
        .sort((left, right) => left.localeCompare(right));
    if (sameSourceUniverse(discovered, projected)) return null;
    const discoveredSet = new Set(discovered);
    const projectedSet = new Set(projected);
    const unprojectedSource = discovered.find((sourcePath) => !projectedSet.has(sourcePath));
    const removedSource = projected.find((sourcePath) => !discoveredSet.has(sourcePath));
    return fallback(
        'source_changed',
        `Canonical source inventory differs from the SQLite projection: unprojected=${unprojectedSource || 'none'}; removed=${removedSource || 'none'}.`
    );
}

function verifySourceMetadata(
    repoRoot: string,
    sources: readonly SqliteCatalogSourceInspection[]
): SqliteQueryFallback | null {
    for (const source of sources) {
        const sourcePath = path.resolve(repoRoot, source.sourcePath);
        if (!isPathInsideRoot(repoRoot, sourcePath)) {
            return fallback('source_changed', `Catalog source escaped the workspace: ${source.sourcePath}`);
        }
        let stat: fs.Stats;
        try {
            stat = fs.lstatSync(sourcePath);
        } catch {
            return fallback('source_missing', `Catalog source is missing: ${source.sourcePath}`);
        }
        if (stat.isSymbolicLink() || !stat.isFile()) {
            return fallback(
                'source_changed',
                `Catalog source is not a regular non-symlink file: ${source.sourcePath}`
            );
        }
        const observedAtMs = Date.parse(source.observedAtUtc);
        if (!Number.isFinite(observedAtMs) || stat.mtimeMs > observedAtMs) {
            return fallback('source_changed', `Catalog source changed after projection: ${source.sourcePath}`);
        }
        try {
            if (sha256File(sourcePath) !== source.contentSha256) {
                return fallback('source_changed', `Catalog source differs from the projection: ${source.sourcePath}`);
            }
        } catch {
            return fallback('source_missing', `Catalog source is unavailable for freshness validation: ${source.sourcePath}`);
        }
    }
    return null;
}

function readCanonicalRuntimeGeneration(
    repoRoot: string
): RuntimeMutationGenerationSnapshot | SqliteQueryFallback {
    try {
        return readRuntimeMutationGeneration(joinOrchestratorPath(repoRoot, ''));
    } catch (error: unknown) {
        const diagnostic = error instanceof RuntimeMutationGenerationError
            ? `${error.code}: ${error.message}`
            : error instanceof Error ? error.message : String(error);
        return fallback('generation_unavailable', diagnostic);
    }
}

function sameRuntimeGeneration(
    left: RuntimeMutationGenerationSnapshot,
    right: RuntimeMutationGenerationSnapshot
): boolean {
    return left.generation === right.generation
        && left.transition_sequence === right.transition_sequence
        && left.state_sha256 === right.state_sha256;
}

function queryCurrentCatalog<T>(repoRoot: string, spec: QuerySpec<T>): SqliteQueryResult<T> {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const opened = openDerivedSqliteCatalogReadOnly(resolvedRepoRoot);
    if (opened.status !== 'available') {
        return fallback('catalog_unavailable', `${opened.reason}: ${opened.diagnostic}`);
    }
    try {
        const inspection = opened.catalog.inspect();
        if (inspection.projectionStatus !== 'ready' || inspection.canonicalGeneration === null) {
            return fallback('projection_not_ready', 'SQLite projection is not ready for current reads.');
        }
        const runtimeGenerationBefore = readCanonicalRuntimeGeneration(resolvedRepoRoot);
        if ('source' in runtimeGenerationBefore) return runtimeGenerationBefore;
        if (runtimeGenerationBefore.generation !== inspection.canonicalGeneration) {
            return fallback(
                'generation_mismatch',
                `Catalog generation ${inspection.canonicalGeneration} does not match canonical generation ${runtimeGenerationBefore.generation}.`
            );
        }
        const sources = relevantSources(opened.catalog.inspectSources(), spec.sourceKinds);
        const sourceUniverseFailure = verifySourceUniverse(
            resolvedRepoRoot,
            sources,
            spec.sourceKinds
        );
        if (sourceUniverseFailure) return sourceUniverseFailure;
        const metadataFailure = verifySourceMetadata(resolvedRepoRoot, sources);
        if (metadataFailure) return metadataFailure;
        const value = spec.query(opened.catalog);
        const runtimeGenerationAfter = readCanonicalRuntimeGeneration(resolvedRepoRoot);
        if ('source' in runtimeGenerationAfter) return runtimeGenerationAfter;
        if (!sameRuntimeGeneration(runtimeGenerationBefore, runtimeGenerationAfter)) {
            return fallback('generation_mismatch', 'Canonical runtime generation changed during the SQLite query.');
        }
        const postQuerySourceUniverseFailure = verifySourceUniverse(
            resolvedRepoRoot,
            sources,
            spec.sourceKinds
        );
        if (postQuerySourceUniverseFailure) return postQuerySourceUniverseFailure;
        const postQueryMetadataFailure = verifySourceMetadata(resolvedRepoRoot, sources);
        if (postQueryMetadataFailure) return postQueryMetadataFailure;
        return {
            source: 'sqlite',
            value,
            inspection
        };
    } catch (error: unknown) {
        return fallback('query_failed', error instanceof Error ? error.message : String(error));
    } finally {
        opened.catalog.close();
    }
}

function queryQualifiedTaskActivityCatalog(
    repoRoot: string
): SqliteQueryResult<readonly CatalogTaskActivitySummary[]> {
    return queryCurrentCatalog(repoRoot, {
        sourceKinds: ['task_queue', 'task_events', 'review_artifact', 'task_ledger', 'metrics'],
        query: (catalog) => catalog.queryTaskActivitySummaries()
    });
}

function hasBulkTaskEventWorkload(repoRoot: string): boolean {
    const eventsRoot = path.join(joinOrchestratorPath(path.resolve(repoRoot), ''), 'runtime', 'task-events');
    try {
        let taskEventFileCount = 0;
        for (const entry of fs.readdirSync(eventsRoot, { withFileTypes: true })) {
            if (entry.isFile() && parseTaskIdJsonlFileName(entry.name) !== null) {
                taskEventFileCount += 1;
                if (taskEventFileCount >= SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES) return true;
            }
        }
    } catch {
        return false;
    }
    return false;
}

export function queryPerformanceQualifiedTaskActivitySummaries(
    repoRoot: string
): SqliteQueryResult<readonly CatalogTaskActivitySummary[]> {
    if (!hasBulkTaskEventWorkload(repoRoot)) {
        return fallback(
            'not_performance_qualified',
            `Bulk SQLite summaries require at least ${SQLITE_BULK_QUERY_MIN_TASK_EVENT_FILES} task event files.`
        );
    }
    return queryQualifiedTaskActivityCatalog(repoRoot);
}
