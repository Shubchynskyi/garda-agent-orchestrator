import type { SQLInputValue, StatementSync } from 'node:sqlite';

import type {
    CatalogRowProvenance,
    DerivedCatalogProjection,
    SqliteCatalogCounts
} from './sqlite-catalog-contracts';
import type { CatalogDatabase } from './sqlite-catalog-driver';
import { SQLITE_CATALOG_PROJECTION_TABLES_DELETE_ORDER } from './sqlite-catalog-migration';
import {
    type CanonicalSourceRow,
    sourceIdForProvenance,
    validateCatalogProjection
} from './sqlite-catalog-validation';

export const SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS = 10_000;

export class CatalogProjectionRebuildRequiredError extends Error {
    readonly minimumRows: number;
    readonly maximumTransactionRows = SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS;

    constructor(minimumRows: number) {
        super(
            `Catalog projection requires at least ${minimumRows} normalized rows; `
            + `the synchronous transaction limit is ${SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS}. `
            + 'Use explicit rebuild orchestration.'
        );
        this.name = 'CatalogProjectionRebuildRequiredError';
        this.minimumRows = minimumRows;
    }
}

function projectionRowLowerBound(projection: DerivedCatalogProjection): number | null {
    if (!projection || typeof projection !== 'object') return null;
    const collections = [
        projection.tasks,
        projection.lifecycleEvents,
        projection.reviewAttempts,
        projection.reviewReceipts,
        projection.artifacts,
        projection.taskLedgers,
        projection.retentionStates,
        projection.metricSamples
    ];
    if (collections.some((collection) => !Array.isArray(collection))) return null;

    let rows = collections.reduce((total, collection) => total + collection.length, 0);
    if (rows > SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS) return rows;
    for (const sample of projection.metricSamples) {
        const labels = sample && typeof sample === 'object' ? sample.labels : null;
        if (!labels || typeof labels !== 'object' || Array.isArray(labels)) continue;
        for (const label in labels) {
            if (!Object.prototype.hasOwnProperty.call(labels, label)) continue;
            rows += 1;
            if (rows > SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS) return rows;
        }
    }
    return rows;
}

function totalProjectionRows(counts: SqliteCatalogCounts): number {
    return Object.values(counts).reduce((total, count) => total + count, 0);
}

function run(statement: StatementSync, values: readonly SQLInputValue[]): void {
    statement.run(...values);
}

function provenanceValues(provenance: CatalogRowProvenance): SQLInputValue[] {
    return [
        sourceIdForProvenance(provenance),
        provenance.sourceSequence,
        provenance.sourceOffset,
        provenance.sourceTimestampUtc,
        provenance.recordContentSha256
    ];
}

function clearProjectionTables(database: CatalogDatabase): void {
    for (const tableName of SQLITE_CATALOG_PROJECTION_TABLES_DELETE_ORDER) {
        database.exec(`DELETE FROM ${tableName};`);
    }
}

function insertSources(database: CatalogDatabase, sources: readonly CanonicalSourceRow[]): void {
    const statement = database.prepare(`
        INSERT INTO canonical_sources (
            source_id, source_kind, source_path, content_sha256, observed_at_utc
        ) VALUES (?, ?, ?, ?, ?)
    `);
    for (const source of sources) {
        run(statement, [
            source.sourceId,
            source.sourceKind,
            source.sourcePath,
            source.contentSha256,
            source.observedAtUtc
        ]);
    }
}

function insertTasks(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO task_queue_rows (
            task_id, status, priority, area, title, owner, updated_text, profile, notes,
            queue_position, source_id, source_sequence, source_offset,
            source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.tasks) {
        run(statement, [
            row.taskId,
            row.status,
            row.priority,
            row.area,
            row.title,
            row.owner,
            row.updatedText,
            row.profile,
            row.notes,
            row.queuePosition,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertLifecycleEvents(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO lifecycle_events (
            task_id, task_sequence, event_type, outcome, actor, message, lifecycle_phase,
            status_signal, health_state, terminal_outcome, previous_event_sha256, event_sha256,
            source_id, source_sequence, source_offset, source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.lifecycleEvents) {
        run(statement, [
            row.taskId,
            row.taskSequence,
            row.eventType,
            row.outcome,
            row.actor,
            row.message,
            row.lifecyclePhase,
            row.statusSignal,
            row.healthState,
            row.terminalOutcome,
            row.previousEventSha256,
            row.eventSha256,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertReviewAttempts(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO review_attempts (
            attempt_id, task_id, review_type, attempt_number, status, verdict,
            reviewer_identity, execution_mode, started_at_utc, completed_at_utc,
            review_context_sha256, review_tree_state_sha256, review_scope_sha256,
            code_scope_sha256, source_id, source_sequence, source_offset,
            source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.reviewAttempts) {
        run(statement, [
            row.attemptId,
            row.taskId,
            row.reviewType,
            row.attemptNumber,
            row.status,
            row.verdict,
            row.reviewerIdentity,
            row.executionMode,
            row.startedAtUtc,
            row.completedAtUtc,
            row.reviewContextSha256,
            row.reviewTreeStateSha256,
            row.reviewScopeSha256,
            row.codeScopeSha256,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertReviewReceipts(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO review_receipts (
            receipt_id, attempt_id, task_id, review_type, verdict, trust_level,
            reviewer_identity, reviewer_execution_mode, reused_existing_review, recorded_at_utc,
            preflight_sha256, scope_sha256, review_context_sha256, review_tree_state_sha256,
            review_artifact_sha256, source_id, source_sequence, source_offset,
            source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.reviewReceipts) {
        run(statement, [
            row.receiptId,
            row.attemptId,
            row.taskId,
            row.reviewType,
            row.verdict,
            row.trustLevel,
            row.reviewerIdentity,
            row.reviewerExecutionMode,
            row.reusedExistingReview ? 1 : 0,
            row.recordedAtUtc,
            row.preflightSha256,
            row.scopeSha256,
            row.reviewContextSha256,
            row.reviewTreeStateSha256,
            row.reviewArtifactSha256,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertArtifacts(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO artifacts (
            artifact_id, task_id, review_attempt_id, artifact_kind, artifact_path,
            content_sha256, size_bytes, modified_at_utc, source_id, source_sequence,
            source_offset, source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.artifacts) {
        run(statement, [
            row.artifactId,
            row.taskId,
            row.reviewAttemptId,
            row.kind,
            row.path,
            row.contentSha256,
            row.sizeBytes,
            row.modifiedAtUtc,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertTaskLedgers(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO task_ledgers (
            task_id, audit_status, verification_status, queue_status, health_state,
            retention_tier, integrity_status, point_in_time_status, blocker_count,
            first_event_utc, last_event_utc, changed_files_count, changed_lines_total,
            generated_at_utc, source_id, source_sequence, source_offset,
            source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.taskLedgers) {
        run(statement, [
            row.taskId,
            row.auditStatus,
            row.verificationStatus,
            row.queueStatus,
            row.healthState,
            row.retentionTier,
            row.integrityStatus,
            row.pointInTimeStatus,
            row.blockerCount,
            row.firstEventUtc,
            row.lastEventUtc,
            row.changedFilesCount,
            row.changedLinesTotal,
            row.generatedAtUtc,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertRetentionState(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const statement = database.prepare(`
        INSERT INTO retention_state (
            retention_id, task_id, artifact_id, retention_state, retention_tier,
            eligible_at_utc, reason, policy_sha256, source_id, source_sequence,
            source_offset, source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of projection.retentionStates) {
        run(statement, [
            row.retentionId,
            row.taskId,
            row.artifactId,
            row.state,
            row.tier,
            row.eligibleAtUtc,
            row.reason,
            row.policySha256,
            ...provenanceValues(row.provenance)
        ]);
    }
}

function insertMetricSamples(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    const sampleStatement = database.prepare(`
        INSERT INTO metric_samples (
            metric_id, task_id, metric_name, value_numeric, value_text, unit,
            recorded_at_utc, source_id, source_sequence, source_offset,
            source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const labelStatement = database.prepare(`
        INSERT INTO metric_labels (metric_id, label_key, label_value) VALUES (?, ?, ?)
    `);
    for (const row of projection.metricSamples) {
        run(sampleStatement, [
            row.metricId,
            row.taskId,
            row.name,
            row.valueNumeric,
            row.valueText,
            row.unit,
            row.recordedAtUtc,
            ...provenanceValues(row.provenance)
        ]);
        for (const [key, value] of Object.entries(row.labels).sort(([left], [right]) => left.localeCompare(right))) {
            run(labelStatement, [row.metricId, key, value]);
        }
    }
}

const COUNT_QUERIES = Object.freeze({
    sources: 'SELECT count(*) AS count FROM canonical_sources',
    tasks: 'SELECT count(*) AS count FROM task_queue_rows',
    lifecycleEvents: 'SELECT count(*) AS count FROM lifecycle_events',
    reviewAttempts: 'SELECT count(*) AS count FROM review_attempts',
    reviewReceipts: 'SELECT count(*) AS count FROM review_receipts',
    artifacts: 'SELECT count(*) AS count FROM artifacts',
    taskLedgers: 'SELECT count(*) AS count FROM task_ledgers',
    retentionStates: 'SELECT count(*) AS count FROM retention_state',
    metricSamples: 'SELECT count(*) AS count FROM metric_samples',
    metricLabels: 'SELECT count(*) AS count FROM metric_labels'
});

function readCount(database: CatalogDatabase, sql: string): number {
    const row = database.prepare(sql).get() as Record<string, unknown> | undefined;
    const count = Number(row?.count);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`Catalog count query returned invalid value for '${sql}'.`);
    }
    return count;
}

export function readCatalogCounts(database: CatalogDatabase): SqliteCatalogCounts {
    return {
        sources: readCount(database, COUNT_QUERIES.sources),
        tasks: readCount(database, COUNT_QUERIES.tasks),
        lifecycleEvents: readCount(database, COUNT_QUERIES.lifecycleEvents),
        reviewAttempts: readCount(database, COUNT_QUERIES.reviewAttempts),
        reviewReceipts: readCount(database, COUNT_QUERIES.reviewReceipts),
        artifacts: readCount(database, COUNT_QUERIES.artifacts),
        taskLedgers: readCount(database, COUNT_QUERIES.taskLedgers),
        retentionStates: readCount(database, COUNT_QUERIES.retentionStates),
        metricSamples: readCount(database, COUNT_QUERIES.metricSamples),
        metricLabels: readCount(database, COUNT_QUERIES.metricLabels)
    };
}

function readCurrentGeneration(database: CatalogDatabase): number {
    const row = database.prepare(
        'SELECT generation FROM catalog_state WHERE singleton_id = 1'
    ).get() as Record<string, unknown> | undefined;
    const generation = Number(row?.generation);
    if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new Error('Catalog state has an invalid generation.');
    }
    return generation;
}

function updateCatalogState(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection,
    generation: number
): void {
    database.prepare(`
        UPDATE catalog_state
        SET generation = ?, projection_status = 'ready', snapshot_sha256 = ?,
            refreshed_at_utc = ?, stale_reason = NULL
        WHERE singleton_id = 1
    `).run(generation, projection.snapshotSha256, projection.generatedAtUtc);
}

function projectedCounts(
    projection: DerivedCatalogProjection,
    sourceCount: number
): SqliteCatalogCounts {
    return {
        sources: sourceCount,
        tasks: projection.tasks.length,
        lifecycleEvents: projection.lifecycleEvents.length,
        reviewAttempts: projection.reviewAttempts.length,
        reviewReceipts: projection.reviewReceipts.length,
        artifacts: projection.artifacts.length,
        taskLedgers: projection.taskLedgers.length,
        retentionStates: projection.retentionStates.length,
        metricSamples: projection.metricSamples.length,
        metricLabels: projection.metricSamples.reduce(
            (total, sample) => total + Object.keys(sample.labels).length,
            0
        )
    };
}

function insertProjectionRows(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection,
    sources: readonly CanonicalSourceRow[]
): void {
    insertSources(database, sources);
    insertTasks(database, projection);
    insertLifecycleEvents(database, projection);
    insertReviewAttempts(database, projection);
    insertReviewReceipts(database, projection);
    insertArtifacts(database, projection);
    insertTaskLedgers(database, projection);
    insertRetentionState(database, projection);
    insertMetricSamples(database, projection);
}

function markCatalogStateStale(database: CatalogDatabase): void {
    database.prepare(`
        UPDATE catalog_state
        SET projection_status = 'stale', stale_reason = 'projection_refresh_failed'
        WHERE singleton_id = 1
    `).run();
}

function commitStaleStateAfterProjectionFailure(database: CatalogDatabase): void {
    try {
        database.exec('ROLLBACK TO projection_refresh;');
        database.exec('RELEASE projection_refresh;');
        database.exec('COMMIT;');
    } catch {
        try {
            database.exec('ROLLBACK;');
        } catch {
            // Preserve the original projection failure.
        }
    }
}

export function replaceCatalogProjection(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection
): { generation: number; counts: SqliteCatalogCounts } {
    const lowerBound = projectionRowLowerBound(projection);
    if (lowerBound !== null && lowerBound > SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS) {
        throw new CatalogProjectionRebuildRequiredError(lowerBound);
    }
    const sources = validateCatalogProjection(projection);
    const counts = projectedCounts(projection, sources.length);
    const totalRows = totalProjectionRows(counts);
    if (totalRows > SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS) {
        throw new CatalogProjectionRebuildRequiredError(totalRows);
    }
    database.exec('BEGIN IMMEDIATE;');
    try {
        const generation = readCurrentGeneration(database) + 1;
        markCatalogStateStale(database);
        database.exec('SAVEPOINT projection_refresh;');
        clearProjectionTables(database);
        insertProjectionRows(database, projection, sources);
        updateCatalogState(database, projection, generation);
        const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeyFailures.length > 0) {
            throw new Error(`Catalog projection has ${foreignKeyFailures.length} foreign-key violation(s).`);
        }
        database.exec('RELEASE projection_refresh;');
        database.exec('COMMIT;');
        return { generation, counts };
    } catch (error: unknown) {
        commitStaleStateAfterProjectionFailure(database);
        throw error;
    }
}
