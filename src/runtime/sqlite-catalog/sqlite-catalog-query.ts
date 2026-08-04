import type { CatalogTaskActivitySummary } from './sqlite-catalog-contracts';
import type { CatalogDatabase } from './sqlite-catalog-driver';

type QueryRow = Record<string, unknown>;

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

export function queryCatalogTaskActivitySummaries(
    database: CatalogDatabase
): readonly CatalogTaskActivitySummary[] {
    const rows = database.prepare(`
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
        ORDER BY tasks.queue_position
    `).all() as QueryRow[];
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
