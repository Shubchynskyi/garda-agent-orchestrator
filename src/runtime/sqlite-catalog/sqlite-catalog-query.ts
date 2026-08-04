import type {
    CatalogArtifact,
    CatalogLifecycleEvent,
    CatalogMetricSample,
    CatalogRetentionState,
    CatalogReviewAttempt,
    CatalogReviewReceipt,
    CatalogRowProvenance,
    CatalogTaskLedger,
    CatalogTaskActivitySummary,
    CatalogTaskRow
} from './sqlite-catalog-contracts';
import type { CatalogDatabase } from './sqlite-catalog-driver';

type QueryRow = Record<string, unknown>;

const PROVENANCE_SELECT = `
    source.source_kind, source.source_path,
    source.content_sha256 AS source_content_sha256,
    source.observed_at_utc AS source_observed_at_utc,
    domain.source_sequence, domain.source_offset,
    domain.source_timestamp_utc, domain.record_content_sha256
`;

function text(value: unknown): string {
    return String(value ?? '');
}

function nullableText(value: unknown): string | null {
    return value === null || value === undefined ? null : String(value);
}

function integer(value: unknown): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error('SQLite catalog query returned an invalid integer.');
    return parsed;
}

function nullableInteger(value: unknown): number | null {
    return value === null || value === undefined ? null : integer(value);
}

function nullableNumber(value: unknown): number | null {
    if (value === null || value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error('SQLite catalog query returned an invalid number.');
    return parsed;
}

function provenance(row: QueryRow): CatalogRowProvenance {
    return {
        sourceKind: text(row.source_kind),
        sourcePath: text(row.source_path),
        sourceContentSha256: text(row.source_content_sha256),
        sourceObservedAtUtc: text(row.source_observed_at_utc),
        sourceSequence: nullableInteger(row.source_sequence),
        sourceOffset: nullableInteger(row.source_offset),
        sourceTimestampUtc: nullableText(row.source_timestamp_utc),
        recordContentSha256: text(row.record_content_sha256)
    };
}

function rowsForTask(
    database: CatalogDatabase,
    sql: string,
    taskId: string | undefined,
    orderBy: string
): QueryRow[] {
    const statement = database.prepare(
        `${sql}${taskId === undefined ? '' : ' WHERE domain.task_id = ?'} ORDER BY ${orderBy}`
    );
    return (taskId === undefined ? statement.all() : statement.all(taskId)) as QueryRow[];
}

export function queryCatalogTasks(database: CatalogDatabase, taskId?: string): readonly CatalogTaskRow[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM task_queue_rows AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.queue_position').map((row) => ({
        taskId: text(row.task_id),
        status: nullableText(row.status),
        priority: nullableText(row.priority),
        area: nullableText(row.area),
        title: nullableText(row.title),
        owner: nullableText(row.owner),
        updatedText: nullableText(row.updated_text),
        profile: nullableText(row.profile),
        notes: nullableText(row.notes),
        queuePosition: integer(row.queue_position),
        provenance: provenance(row)
    }));
}

export function queryCatalogLifecycleEvents(
    database: CatalogDatabase,
    taskId?: string
): readonly CatalogLifecycleEvent[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM lifecycle_events AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.task_id, domain.task_sequence').map((row) => ({
        taskId: text(row.task_id),
        taskSequence: integer(row.task_sequence),
        eventType: text(row.event_type),
        outcome: text(row.outcome),
        actor: text(row.actor),
        message: text(row.message),
        lifecyclePhase: nullableText(row.lifecycle_phase),
        statusSignal: nullableText(row.status_signal),
        healthState: nullableText(row.health_state),
        terminalOutcome: nullableText(row.terminal_outcome),
        previousEventSha256: nullableText(row.previous_event_sha256),
        eventSha256: text(row.event_sha256),
        provenance: provenance(row)
    }));
}

export function queryCatalogReviewAttempts(
    database: CatalogDatabase,
    taskId?: string
): readonly CatalogReviewAttempt[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM review_attempts AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.attempt_id').map((row) => ({
        attemptId: text(row.attempt_id),
        taskId: text(row.task_id),
        reviewType: text(row.review_type),
        attemptNumber: integer(row.attempt_number),
        status: text(row.status),
        verdict: nullableText(row.verdict),
        reviewerIdentity: nullableText(row.reviewer_identity),
        executionMode: nullableText(row.execution_mode),
        startedAtUtc: nullableText(row.started_at_utc),
        completedAtUtc: nullableText(row.completed_at_utc),
        reviewContextSha256: nullableText(row.review_context_sha256),
        reviewTreeStateSha256: nullableText(row.review_tree_state_sha256),
        reviewScopeSha256: nullableText(row.review_scope_sha256),
        codeScopeSha256: nullableText(row.code_scope_sha256),
        provenance: provenance(row)
    }));
}

export function queryCatalogReviewReceipts(
    database: CatalogDatabase,
    taskId?: string
): readonly CatalogReviewReceipt[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM review_receipts AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.receipt_id').map((row) => ({
        receiptId: text(row.receipt_id),
        attemptId: nullableText(row.attempt_id),
        taskId: text(row.task_id),
        reviewType: text(row.review_type),
        verdict: nullableText(row.verdict),
        trustLevel: nullableText(row.trust_level),
        reviewerIdentity: nullableText(row.reviewer_identity),
        reviewerExecutionMode: nullableText(row.reviewer_execution_mode),
        reusedExistingReview: integer(row.reused_existing_review) === 1,
        recordedAtUtc: text(row.recorded_at_utc),
        preflightSha256: nullableText(row.preflight_sha256),
        scopeSha256: nullableText(row.scope_sha256),
        reviewContextSha256: nullableText(row.review_context_sha256),
        reviewTreeStateSha256: nullableText(row.review_tree_state_sha256),
        reviewArtifactSha256: nullableText(row.review_artifact_sha256),
        provenance: provenance(row)
    }));
}

export function queryCatalogArtifacts(database: CatalogDatabase, taskId?: string): readonly CatalogArtifact[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM artifacts AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.artifact_path').map((row) => ({
        artifactId: text(row.artifact_id),
        taskId: nullableText(row.task_id),
        reviewAttemptId: nullableText(row.review_attempt_id),
        kind: text(row.artifact_kind),
        path: text(row.artifact_path),
        contentSha256: text(row.content_sha256),
        sizeBytes: nullableInteger(row.size_bytes),
        modifiedAtUtc: nullableText(row.modified_at_utc),
        provenance: provenance(row)
    }));
}

export function queryCatalogTaskLedgers(database: CatalogDatabase, taskId?: string): readonly CatalogTaskLedger[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM task_ledgers AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.task_id').map((row) => ({
        taskId: text(row.task_id),
        auditStatus: text(row.audit_status),
        verificationStatus: text(row.verification_status),
        queueStatus: nullableText(row.queue_status),
        healthState: nullableText(row.health_state),
        retentionTier: nullableText(row.retention_tier),
        integrityStatus: text(row.integrity_status),
        pointInTimeStatus: text(row.point_in_time_status),
        blockerCount: integer(row.blocker_count),
        firstEventUtc: nullableText(row.first_event_utc),
        lastEventUtc: nullableText(row.last_event_utc),
        changedFilesCount: integer(row.changed_files_count),
        changedLinesTotal: integer(row.changed_lines_total),
        generatedAtUtc: text(row.generated_at_utc),
        provenance: provenance(row)
    }));
}

export function queryCatalogRetentionStates(
    database: CatalogDatabase,
    taskId?: string
): readonly CatalogRetentionState[] {
    return rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM retention_state AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.retention_id').map((row) => ({
        retentionId: text(row.retention_id),
        taskId: nullableText(row.task_id),
        artifactId: nullableText(row.artifact_id),
        state: text(row.retention_state),
        tier: nullableText(row.retention_tier),
        eligibleAtUtc: nullableText(row.eligible_at_utc),
        reason: nullableText(row.reason),
        policySha256: nullableText(row.policy_sha256),
        provenance: provenance(row)
    }));
}

export function queryCatalogMetricSamples(database: CatalogDatabase, taskId?: string): readonly CatalogMetricSample[] {
    const samples = rowsForTask(database, `
        SELECT domain.*, ${PROVENANCE_SELECT}
        FROM metric_samples AS domain
        JOIN canonical_sources AS source ON source.source_id = domain.source_id
    `, taskId, 'domain.metric_id');
    const labelStatement = database.prepare(`
        SELECT labels.metric_id, labels.label_key, labels.label_value
        FROM metric_labels AS labels
        JOIN metric_samples AS domain ON domain.metric_id = labels.metric_id
        ${taskId === undefined ? '' : 'WHERE domain.task_id = ?'}
        ORDER BY labels.metric_id, labels.label_key
    `);
    const labelRows = (taskId === undefined ? labelStatement.all() : labelStatement.all(taskId)) as QueryRow[];
    const labelsByMetricId = new Map<string, Record<string, string>>();
    for (const row of labelRows) {
        const metricId = text(row.metric_id);
        const labels = labelsByMetricId.get(metricId) ?? {};
        labels[text(row.label_key)] = text(row.label_value);
        labelsByMetricId.set(metricId, labels);
    }
    return samples.map((row) => ({
        metricId: text(row.metric_id),
        taskId: nullableText(row.task_id),
        name: text(row.metric_name),
        valueNumeric: nullableNumber(row.value_numeric),
        valueText: nullableText(row.value_text),
        unit: nullableText(row.unit),
        labels: labelsByMetricId.get(text(row.metric_id)) ?? {},
        recordedAtUtc: text(row.recorded_at_utc),
        provenance: provenance(row)
    }));
}

export function queryCatalogTaskActivitySummaries(
    database: CatalogDatabase,
    taskId?: string
): readonly CatalogTaskActivitySummary[] {
    const where = taskId === undefined ? '' : 'WHERE tasks.task_id = ?';
    const statement = database.prepare(`
        WITH event_summary AS (
            SELECT task_id, COUNT(*) AS event_count,
                MIN(source_timestamp_utc) AS first_event_utc,
                MAX(source_timestamp_utc) AS last_event_utc
            FROM lifecycle_events GROUP BY task_id
        ), attempt_summary AS (
            SELECT task_id, COUNT(*) AS attempt_count FROM review_attempts GROUP BY task_id
        ), receipt_summary AS (
            SELECT task_id, COUNT(*) AS receipt_count FROM review_receipts GROUP BY task_id
        ), artifact_summary AS (
            SELECT task_id, COUNT(*) AS artifact_count FROM artifacts
            WHERE task_id IS NOT NULL GROUP BY task_id
        ), metric_summary AS (
            SELECT task_id, COUNT(*) AS metric_count FROM metric_samples
            WHERE task_id IS NOT NULL GROUP BY task_id
        ), retention_summary AS (
            SELECT task_id,
                COALESCE(
                    MAX(CASE WHEN artifact_id IS NULL THEN retention_state END),
                    MAX(retention_state)
                ) AS retention_state,
                COALESCE(
                    MAX(CASE WHEN artifact_id IS NULL THEN retention_tier END),
                    MAX(retention_tier)
                ) AS retention_tier
            FROM retention_state WHERE task_id IS NOT NULL GROUP BY task_id
        )
        SELECT tasks.task_id, tasks.queue_position, tasks.status,
            COALESCE(events.event_count, 0) AS event_count,
            events.first_event_utc, events.last_event_utc,
            COALESCE(attempts.attempt_count, 0) AS attempt_count,
            COALESCE(receipts.receipt_count, 0) AS receipt_count,
            COALESCE(artifacts.artifact_count, 0) AS artifact_count,
            COALESCE(metrics.metric_count, 0) AS metric_count,
            ledgers.audit_status, ledgers.verification_status, ledgers.health_state,
            retention.retention_state, retention.retention_tier
        FROM task_queue_rows AS tasks
        LEFT JOIN event_summary AS events ON events.task_id = tasks.task_id
        LEFT JOIN attempt_summary AS attempts ON attempts.task_id = tasks.task_id
        LEFT JOIN receipt_summary AS receipts ON receipts.task_id = tasks.task_id
        LEFT JOIN artifact_summary AS artifacts ON artifacts.task_id = tasks.task_id
        LEFT JOIN metric_summary AS metrics ON metrics.task_id = tasks.task_id
        LEFT JOIN task_ledgers AS ledgers ON ledgers.task_id = tasks.task_id
        LEFT JOIN retention_summary AS retention ON retention.task_id = tasks.task_id
        ${where}
        ORDER BY tasks.queue_position
    `);
    const rows = (taskId === undefined ? statement.all() : statement.all(taskId)) as QueryRow[];
    return rows.map((row) => ({
        taskId: text(row.task_id),
        queuePosition: integer(row.queue_position),
        status: nullableText(row.status),
        lifecycleEventCount: integer(row.event_count),
        firstLifecycleEventUtc: nullableText(row.first_event_utc),
        lastLifecycleEventUtc: nullableText(row.last_event_utc),
        reviewAttemptCount: integer(row.attempt_count),
        reviewReceiptCount: integer(row.receipt_count),
        artifactCount: integer(row.artifact_count),
        metricSampleCount: integer(row.metric_count),
        auditStatus: nullableText(row.audit_status),
        verificationStatus: nullableText(row.verification_status),
        healthState: nullableText(row.health_state),
        retentionState: nullableText(row.retention_state),
        retentionTier: nullableText(row.retention_tier)
    }));
}
