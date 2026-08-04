import { createHash } from 'node:crypto';
import type { SQLInputValue, StatementSync } from 'node:sqlite';

import type {
    CatalogMetricSample,
    CatalogRowProvenance,
    DerivedCatalogProjection,
    SqliteCatalogCounts,
    SqliteCatalogParityInspection,
    SqliteCatalogRebuildOptions
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
        projection.canonicalSources,
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

function normalizeRebuildBatchSize(value: number | undefined): number {
    if (value === undefined) return 1_000;
    if (!Number.isSafeInteger(value) || value < 1 || value > SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS) {
        throw new Error(
            `Catalog rebuild batchSize must be an integer from 1 through ${SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS}.`
        );
    }
    return value;
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

function insertMetricSampleRows(database: CatalogDatabase, samples: readonly CatalogMetricSample[]): void {
    const sampleStatement = database.prepare(`
        INSERT INTO metric_samples (
            metric_id, task_id, metric_name, value_numeric, value_text, unit,
            recorded_at_utc, source_id, source_sequence, source_offset,
            source_timestamp_utc, record_content_sha256
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of samples) {
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
    }
}

interface CatalogMetricLabelRow {
    readonly metricId: string;
    readonly key: string;
    readonly value: string;
}

function insertMetricLabelRows(database: CatalogDatabase, labels: readonly CatalogMetricLabelRow[]): void {
    const labelStatement = database.prepare(`
        INSERT INTO metric_labels (metric_id, label_key, label_value) VALUES (?, ?, ?)
    `);
    for (const label of labels) {
        run(labelStatement, [label.metricId, label.key, label.value]);
    }
}

function insertMetricSamples(database: CatalogDatabase, projection: DerivedCatalogProjection): void {
    insertMetricSampleRows(database, projection.metricSamples);
    const labelStatement = database.prepare(`
        INSERT INTO metric_labels (metric_id, label_key, label_value) VALUES (?, ?, ?)
    `);
    for (const row of projection.metricSamples) {
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

function parityDigest(rows: readonly (readonly unknown[])[]): string {
    return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function sortedRows(rows: readonly (readonly unknown[])[]): readonly (readonly unknown[])[] {
    return [...rows].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function readParityRows(
    database: CatalogDatabase,
    tableName: string,
    columns: readonly string[]
): readonly (readonly unknown[])[] {
    const rows = database.prepare(
        `SELECT ${columns.join(', ')} FROM ${tableName}`
    ).all() as Record<string, unknown>[];
    return sortedRows(rows.map((row) => columns.map((column) => {
        const value = row[column];
        return typeof value === 'bigint' ? Number(value) : value;
    })));
}

interface ParityTableExpectation {
    readonly tableName: string;
    readonly columns: readonly string[];
    readonly rows: readonly (readonly unknown[])[];
}

function provenanceParityValues(provenance: CatalogRowProvenance): readonly unknown[] {
    return [
        sourceIdForProvenance(provenance),
        provenance.sourceSequence,
        provenance.sourceOffset,
        provenance.sourceTimestampUtc,
        provenance.recordContentSha256
    ];
}

function buildParityExpectations(
    projection: DerivedCatalogProjection,
    sources: readonly CanonicalSourceRow[]
): readonly ParityTableExpectation[] {
    const metricLabels = projection.metricSamples.flatMap((sample) => (
        Object.entries(sample.labels).map(([key, value]) => [sample.metricId, key, value])
    ));
    return [
        {
            tableName: 'canonical_sources',
            columns: ['source_id', 'source_kind', 'source_path', 'content_sha256'],
            rows: sources.map((source) => [
                source.sourceId,
                source.sourceKind,
                source.sourcePath,
                source.contentSha256
            ])
        },
        {
            tableName: 'task_queue_rows',
            columns: [
                'task_id', 'status', 'priority', 'area', 'title', 'owner', 'updated_text',
                'profile', 'notes', 'queue_position', 'source_id', 'source_sequence',
                'source_offset', 'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.tasks.map((row) => [
                row.taskId, row.status, row.priority, row.area, row.title, row.owner,
                row.updatedText, row.profile, row.notes, row.queuePosition,
                ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'lifecycle_events',
            columns: [
                'task_id', 'task_sequence', 'event_type', 'outcome', 'actor', 'message',
                'lifecycle_phase', 'status_signal', 'health_state', 'terminal_outcome',
                'previous_event_sha256', 'event_sha256', 'source_id', 'source_sequence',
                'source_offset', 'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.lifecycleEvents.map((row) => [
                row.taskId, row.taskSequence, row.eventType, row.outcome, row.actor, row.message,
                row.lifecyclePhase, row.statusSignal, row.healthState, row.terminalOutcome,
                row.previousEventSha256, row.eventSha256, ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'review_attempts',
            columns: [
                'attempt_id', 'task_id', 'review_type', 'attempt_number', 'status', 'verdict',
                'reviewer_identity', 'execution_mode', 'started_at_utc', 'completed_at_utc',
                'review_context_sha256', 'review_tree_state_sha256', 'review_scope_sha256',
                'code_scope_sha256', 'source_id', 'source_sequence', 'source_offset',
                'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.reviewAttempts.map((row) => [
                row.attemptId, row.taskId, row.reviewType, row.attemptNumber, row.status,
                row.verdict, row.reviewerIdentity, row.executionMode, row.startedAtUtc,
                row.completedAtUtc, row.reviewContextSha256, row.reviewTreeStateSha256,
                row.reviewScopeSha256, row.codeScopeSha256, ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'review_receipts',
            columns: [
                'receipt_id', 'attempt_id', 'task_id', 'review_type', 'verdict', 'trust_level',
                'reviewer_identity', 'reviewer_execution_mode', 'reused_existing_review',
                'recorded_at_utc', 'preflight_sha256', 'scope_sha256', 'review_context_sha256',
                'review_tree_state_sha256', 'review_artifact_sha256', 'source_id',
                'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.reviewReceipts.map((row) => [
                row.receiptId, row.attemptId, row.taskId, row.reviewType, row.verdict,
                row.trustLevel, row.reviewerIdentity, row.reviewerExecutionMode,
                row.reusedExistingReview ? 1 : 0, row.recordedAtUtc, row.preflightSha256,
                row.scopeSha256, row.reviewContextSha256, row.reviewTreeStateSha256,
                row.reviewArtifactSha256, ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'artifacts',
            columns: [
                'artifact_id', 'task_id', 'review_attempt_id', 'artifact_kind', 'artifact_path',
                'content_sha256', 'size_bytes', 'modified_at_utc', 'source_id', 'source_sequence',
                'source_offset', 'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.artifacts.map((row) => [
                row.artifactId, row.taskId, row.reviewAttemptId, row.kind, row.path,
                row.contentSha256, row.sizeBytes, row.modifiedAtUtc,
                ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'task_ledgers',
            columns: [
                'task_id', 'audit_status', 'verification_status', 'queue_status', 'health_state',
                'retention_tier', 'integrity_status', 'point_in_time_status', 'blocker_count',
                'first_event_utc', 'last_event_utc', 'changed_files_count', 'changed_lines_total',
                'generated_at_utc', 'source_id', 'source_sequence', 'source_offset',
                'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.taskLedgers.map((row) => [
                row.taskId, row.auditStatus, row.verificationStatus, row.queueStatus,
                row.healthState, row.retentionTier, row.integrityStatus, row.pointInTimeStatus,
                row.blockerCount, row.firstEventUtc, row.lastEventUtc, row.changedFilesCount,
                row.changedLinesTotal, row.generatedAtUtc, ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'retention_state',
            columns: [
                'retention_id', 'task_id', 'artifact_id', 'retention_state', 'retention_tier',
                'eligible_at_utc', 'reason', 'policy_sha256', 'source_id', 'source_sequence',
                'source_offset', 'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.retentionStates.map((row) => [
                row.retentionId, row.taskId, row.artifactId, row.state, row.tier,
                row.eligibleAtUtc, row.reason, row.policySha256,
                ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'metric_samples',
            columns: [
                'metric_id', 'task_id', 'metric_name', 'value_numeric', 'value_text', 'unit',
                'recorded_at_utc', 'source_id', 'source_sequence', 'source_offset',
                'source_timestamp_utc', 'record_content_sha256'
            ],
            rows: projection.metricSamples.map((row) => [
                row.metricId, row.taskId, row.name, row.valueNumeric, row.valueText, row.unit,
                row.recordedAtUtc, ...provenanceParityValues(row.provenance)
            ])
        },
        {
            tableName: 'metric_labels',
            columns: ['metric_id', 'label_key', 'label_value'],
            rows: metricLabels
        }
    ];
}

export function inspectCatalogProjectionParity(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection
): SqliteCatalogParityInspection {
    const sources = validateCatalogProjection(projection);
    const mismatchedTables: string[] = [];
    for (const expectation of buildParityExpectations(projection, sources)) {
        const expected = parityDigest(sortedRows(expectation.rows));
        const actual = parityDigest(readParityRows(
            database,
            expectation.tableName,
            expectation.columns
        ));
        if (expected !== actual) mismatchedTables.push(expectation.tableName);
    }
    return { parity: mismatchedTables.length === 0, mismatchedTables };
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
            refreshed_at_utc = ?, stale_reason = NULL, canonical_generation = ?
        WHERE singleton_id = 1
    `).run(
        generation,
        projection.snapshotSha256,
        projection.generatedAtUtc,
        projection.canonicalGeneration ?? null
    );
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

function projectionForSourceIds(
    projection: DerivedCatalogProjection,
    sourceIds: ReadonlySet<string>
): DerivedCatalogProjection {
    const includes = (row: { provenance: CatalogRowProvenance }): boolean => (
        sourceIds.has(sourceIdForProvenance(row.provenance))
    );
    return {
        ...projection,
        tasks: projection.tasks.filter(includes),
        lifecycleEvents: projection.lifecycleEvents.filter(includes),
        reviewAttempts: projection.reviewAttempts.filter(includes),
        reviewReceipts: projection.reviewReceipts.filter(includes),
        artifacts: projection.artifacts.filter(includes),
        taskLedgers: projection.taskLedgers.filter(includes),
        retentionStates: projection.retentionStates.filter(includes),
        metricSamples: projection.metricSamples.filter(includes)
    };
}

function readCurrentSourceHashes(database: CatalogDatabase): Map<string, string> {
    const rows = database.prepare(
        'SELECT source_id, content_sha256 FROM canonical_sources'
    ).all() as Record<string, unknown>[];
    return new Map(rows.map((row) => [String(row.source_id), String(row.content_sha256)]));
}

function determineChangedSourceIds(
    database: CatalogDatabase,
    sources: readonly CanonicalSourceRow[]
): Set<string> {
    const current = readCurrentSourceHashes(database);
    const next = new Map(sources.map((source) => [source.sourceId, source.contentSha256] as const));
    const changed = new Set<string>();
    for (const [sourceId, contentSha256] of next) {
        if (current.get(sourceId) !== contentSha256) changed.add(sourceId);
    }
    for (const sourceId of current.keys()) {
        if (!next.has(sourceId)) changed.add(sourceId);
    }
    return changed;
}

function populateChangedSourcesTable(database: CatalogDatabase, sourceIds: ReadonlySet<string>): void {
    database.exec(`
        CREATE TEMP TABLE IF NOT EXISTS catalog_changed_sources (
            source_id TEXT PRIMARY KEY
        ) WITHOUT ROWID;
        DELETE FROM catalog_changed_sources;
    `);
    const insert = database.prepare(
        'INSERT INTO catalog_changed_sources (source_id) VALUES (?)'
    );
    for (const sourceId of sourceIds) insert.run(sourceId);
}

function includeDependentArtifactSourceIds(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection,
    changedSourceIds: Set<string>
): void {
    if (changedSourceIds.size === 0) return;
    populateChangedSourcesTable(database, changedSourceIds);
    const currentDependentSources = database.prepare(`
        SELECT DISTINCT artifact.source_id
        FROM artifacts AS artifact
        INNER JOIN review_attempts AS attempt
            ON attempt.attempt_id = artifact.review_attempt_id
        WHERE attempt.source_id IN (SELECT source_id FROM catalog_changed_sources)
    `).all() as Array<{ source_id: string }>;
    for (const row of currentDependentSources) changedSourceIds.add(row.source_id);

    const nextAttemptSourceIds = new Map(
        projection.reviewAttempts.map((attempt) => [
            attempt.attemptId,
            sourceIdForProvenance(attempt.provenance)
        ] as const)
    );
    for (const artifact of projection.artifacts) {
        if (!artifact.reviewAttemptId) continue;
        const attemptSourceId = nextAttemptSourceIds.get(artifact.reviewAttemptId);
        if (attemptSourceId && changedSourceIds.has(attemptSourceId)) {
            changedSourceIds.add(sourceIdForProvenance(artifact.provenance));
        }
    }
}

function readChangedSourceRowCount(database: CatalogDatabase, sourceIds: ReadonlySet<string>): number {
    if (sourceIds.size === 0) return 0;
    populateChangedSourcesTable(database, sourceIds);
    const sourceTables = [
        'retention_state',
        'review_receipts',
        'artifacts',
        'review_attempts',
        'metric_samples',
        'lifecycle_events',
        'task_ledgers',
        'task_queue_rows'
    ];
    let count = sourceIds.size;
    for (const tableName of sourceTables) {
        const row = database.prepare(`
            SELECT count(*) AS count FROM ${tableName}
            WHERE source_id IN (SELECT source_id FROM catalog_changed_sources)
        `).get() as Record<string, unknown> | undefined;
        count += Number(row?.count || 0);
    }
    const labels = database.prepare(`
        SELECT count(*) AS count FROM metric_labels
        WHERE metric_id IN (
            SELECT metric_id FROM metric_samples
            WHERE source_id IN (SELECT source_id FROM catalog_changed_sources)
        )
    `).get() as Record<string, unknown> | undefined;
    return count + Number(labels?.count || 0);
}

function deleteChangedSourceRows(database: CatalogDatabase): void {
    database.exec(`
        DELETE FROM metric_labels
        WHERE metric_id IN (
            SELECT metric_id FROM metric_samples
            WHERE source_id IN (SELECT source_id FROM catalog_changed_sources)
        );
        DELETE FROM retention_state
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM review_receipts
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM artifacts
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM review_attempts
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM metric_samples
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM lifecycle_events
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM task_ledgers
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM task_queue_rows
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
        DELETE FROM canonical_sources
        WHERE source_id IN (SELECT source_id FROM catalog_changed_sources);
    `);
}

function sameCounts(left: SqliteCatalogCounts, right: SqliteCatalogCounts): boolean {
    return (Object.keys(left) as (keyof SqliteCatalogCounts)[])
        .every((key) => left[key] === right[key]);
}

/**
 * Replace only canonical sources whose content hash changed. The complete next
 * projection is validated before the writer transaction, while unchanged rows
 * stay in place. This is the normal incremental reconciliation path.
 */
export function reconcileCatalogProjection(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection
): { generation: number; counts: SqliteCatalogCounts } {
    const sources = validateCatalogProjection(projection);
    const changedSourceIds = determineChangedSourceIds(database, sources);
    includeDependentArtifactSourceIds(database, projection, changedSourceIds);
    const changedProjection = projectionForSourceIds(projection, changedSourceIds);
    const changedSources = sources.filter((source) => changedSourceIds.has(source.sourceId));
    const changedInsertCounts = projectedCounts(changedProjection, changedSources.length);
    const currentChangedRows = readChangedSourceRowCount(database, changedSourceIds);
    const changedRows = totalProjectionRows(changedInsertCounts) + currentChangedRows;
    if (changedRows > SQLITE_CATALOG_MAX_SYNC_PROJECTION_ROWS) {
        throw new CatalogProjectionRebuildRequiredError(changedRows);
    }
    const expectedCounts = projectedCounts(projection, sources.length);

    database.exec('BEGIN IMMEDIATE;');
    try {
        const generation = readCurrentGeneration(database) + 1;
        markCatalogStateStale(database);
        database.exec('SAVEPOINT projection_reconcile;');
        populateChangedSourcesTable(database, changedSourceIds);
        deleteChangedSourceRows(database);
        insertProjectionRows(database, changedProjection, changedSources);
        const actualCounts = readCatalogCounts(database);
        if (!sameCounts(expectedCounts, actualCounts)) {
            throw new Error(
                `Catalog incremental reconciliation count mismatch: expected ${JSON.stringify(expectedCounts)}, `
                + `found ${JSON.stringify(actualCounts)}.`
            );
        }
        updateCatalogState(database, projection, generation);
        const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
        if (foreignKeyFailures.length > 0) {
            throw new Error(`Catalog projection has ${foreignKeyFailures.length} foreign-key violation(s).`);
        }
        database.exec('RELEASE projection_reconcile;');
        database.exec('COMMIT;');
        return { generation, counts: actualCounts };
    } catch (error: unknown) {
        try {
            database.exec('ROLLBACK TO projection_reconcile;');
            database.exec('RELEASE projection_reconcile;');
            database.exec('COMMIT;');
        } catch {
            try {
                database.exec('ROLLBACK;');
            } catch {
                // Preserve the primary reconciliation failure.
            }
        }
        throw error;
    }
}


function runRebuildBatch(
    database: CatalogDatabase,
    callback: () => void
): void {
    database.exec('BEGIN IMMEDIATE;');
    try {
        callback();
        database.exec('COMMIT;');
    } catch (error: unknown) {
        try {
            database.exec('ROLLBACK;');
        } catch {
            // Preserve the original rebuild failure.
        }
        throw error;
    }
}

function forEachBatch<T>(
    rows: readonly T[],
    batchSize: number,
    callback: (batch: readonly T[]) => void
): void {
    for (let offset = 0; offset < rows.length; offset += batchSize) {
        callback(rows.slice(offset, offset + batchSize));
    }
}

function forEachMetricLabelBatch(
    samples: readonly CatalogMetricSample[],
    batchSize: number,
    callback: (batch: readonly CatalogMetricLabelRow[]) => void
): void {
    let batch: CatalogMetricLabelRow[] = [];
    for (const sample of samples) {
        for (const [key, value] of Object.entries(sample.labels).sort(([left], [right]) => left.localeCompare(right))) {
            batch.push({ metricId: sample.metricId, key, value });
            if (batch.length === batchSize) {
                callback(batch);
                batch = [];
            }
        }
    }
    if (batch.length > 0) callback(batch);
}

function projectionWith<K extends keyof DerivedCatalogProjection>(
    projection: DerivedCatalogProjection,
    key: K,
    value: DerivedCatalogProjection[K]
): DerivedCatalogProjection {
    return { ...projection, [key]: value };
}

/**
 * Explicit maintenance rebuild. Unlike the interactive replacement path this
 * accepts large projections, keeps catalog_state stale throughout the rebuild,
 * and commits bounded batches so one synchronous transaction is never
 * unbounded. Callers must provide canonical fallback while it runs.
 */
export function rebuildCatalogProjection(
    database: CatalogDatabase,
    projection: DerivedCatalogProjection,
    options: SqliteCatalogRebuildOptions = {}
): { generation: number; counts: SqliteCatalogCounts } {
    const sources = validateCatalogProjection(projection);
    const counts = projectedCounts(projection, sources.length);
    const totalRows = totalProjectionRows(counts);
    const batchSize = normalizeRebuildBatchSize(options.batchSize);
    const nextGeneration = readCurrentGeneration(database) + 1;
    let completedRows = 0;
    const report = (phase: string, delta: number): void => {
        completedRows += delta;
        options.onProgress?.({ phase, completedRows, totalRows });
    };

    runRebuildBatch(database, () => {
        markCatalogStateStale(database);
        clearProjectionTables(database);
    });

    try {
        forEachBatch(sources, batchSize, (batch) => {
            runRebuildBatch(database, () => insertSources(database, batch));
            report('canonical_sources', batch.length);
        });
        forEachBatch(projection.tasks, batchSize, (batch) => {
            runRebuildBatch(database, () => insertTasks(database, projectionWith(projection, 'tasks', batch)));
            report('task_queue_rows', batch.length);
        });
        forEachBatch(projection.lifecycleEvents, batchSize, (batch) => {
            runRebuildBatch(database, () => insertLifecycleEvents(
                database,
                projectionWith(projection, 'lifecycleEvents', batch)
            ));
            report('lifecycle_events', batch.length);
        });
        forEachBatch(projection.reviewAttempts, batchSize, (batch) => {
            runRebuildBatch(database, () => insertReviewAttempts(
                database,
                projectionWith(projection, 'reviewAttempts', batch)
            ));
            report('review_attempts', batch.length);
        });
        forEachBatch(projection.reviewReceipts, batchSize, (batch) => {
            runRebuildBatch(database, () => insertReviewReceipts(
                database,
                projectionWith(projection, 'reviewReceipts', batch)
            ));
            report('review_receipts', batch.length);
        });
        forEachBatch(projection.artifacts, batchSize, (batch) => {
            runRebuildBatch(database, () => insertArtifacts(
                database,
                projectionWith(projection, 'artifacts', batch)
            ));
            report('artifacts', batch.length);
        });
        forEachBatch(projection.taskLedgers, batchSize, (batch) => {
            runRebuildBatch(database, () => insertTaskLedgers(
                database,
                projectionWith(projection, 'taskLedgers', batch)
            ));
            report('task_ledgers', batch.length);
        });
        forEachBatch(projection.retentionStates, batchSize, (batch) => {
            runRebuildBatch(database, () => insertRetentionState(
                database,
                projectionWith(projection, 'retentionStates', batch)
            ));
            report('retention_state', batch.length);
        });
        forEachBatch(projection.metricSamples, batchSize, (batch) => {
            runRebuildBatch(database, () => insertMetricSampleRows(database, batch));
            report('metric_samples', batch.length);
        });
        forEachMetricLabelBatch(projection.metricSamples, batchSize, (batch) => {
            runRebuildBatch(database, () => insertMetricLabelRows(database, batch));
            report('metric_labels', batch.length);
        });

        runRebuildBatch(database, () => {
            const foreignKeyFailures = database.prepare('PRAGMA foreign_key_check').all();
            if (foreignKeyFailures.length > 0) {
                throw new Error(`Catalog rebuild has ${foreignKeyFailures.length} foreign-key violation(s).`);
            }
            updateCatalogState(database, projection, nextGeneration);
        });
        options.onProgress?.({ phase: 'complete', completedRows: totalRows, totalRows });
        return { generation: nextGeneration, counts };
    } catch (error: unknown) {
        try {
            runRebuildBatch(database, () => markCatalogStateStale(database));
        } catch {
            // The live catalog remains ineligible; preserve the primary failure.
        }
        throw error;
    }
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
