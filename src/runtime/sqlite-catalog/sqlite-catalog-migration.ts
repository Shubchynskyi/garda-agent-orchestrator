import { createHash } from 'node:crypto';

// Immutable database identity and migration contract for the derived catalog.
export const SQLITE_CATALOG_APPLICATION_ID = 0x47415231;
export const SQLITE_CATALOG_SCHEMA_VERSION = 3;
export const SQLITE_CATALOG_BUSY_TIMEOUT_MS = 250;

export interface SqliteCatalogMigration {
    readonly version: number;
    readonly name: string;
    readonly sql: string;
    readonly checksum: string;
}

const MIGRATION_V1_NAME = 'initial-derived-orchestration-catalog';
const MIGRATION_V1_SQL = [
    `CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        checksum TEXT NOT NULL CHECK (length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
        applied_at_utc TEXT NOT NULL,
        app_version TEXT NOT NULL
    );`,
    `CREATE TABLE catalog_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        projection_status TEXT NOT NULL CHECK (projection_status IN ('empty', 'ready', 'stale')),
        snapshot_sha256 TEXT NULL CHECK (
            snapshot_sha256 IS NULL OR
            (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        refreshed_at_utc TEXT NULL,
        stale_reason TEXT NULL
    );`,
    `INSERT INTO catalog_state (
        singleton_id, generation, projection_status, snapshot_sha256, refreshed_at_utc, stale_reason
    ) VALUES (1, 0, 'empty', NULL, NULL, NULL);`,
    `CREATE TABLE canonical_sources (
        source_id TEXT PRIMARY KEY,
        source_kind TEXT NOT NULL,
        source_path TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (
            length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        observed_at_utc TEXT NOT NULL,
        UNIQUE (source_kind, source_path)
    );`,
    `CREATE TABLE task_queue_rows (
        task_id TEXT PRIMARY KEY,
        status TEXT NULL,
        priority TEXT NULL,
        area TEXT NULL,
        title TEXT NULL,
        owner TEXT NULL,
        updated_text TEXT NULL,
        profile TEXT NULL,
        notes TEXT NULL,
        queue_position INTEGER NOT NULL UNIQUE CHECK (queue_position >= 0),
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    );`,
    `CREATE TABLE lifecycle_events (
        task_id TEXT NOT NULL,
        task_sequence INTEGER NOT NULL CHECK (task_sequence > 0),
        event_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        actor TEXT NOT NULL,
        message TEXT NOT NULL,
        lifecycle_phase TEXT NULL,
        status_signal TEXT NULL,
        health_state TEXT NULL,
        terminal_outcome TEXT NULL,
        previous_event_sha256 TEXT NULL CHECK (
            previous_event_sha256 IS NULL OR
            (length(previous_event_sha256) = 64 AND previous_event_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        event_sha256 TEXT NOT NULL UNIQUE CHECK (
            length(event_sha256) = 64 AND event_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NOT NULL CHECK (source_sequence > 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NOT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        PRIMARY KEY (task_id, task_sequence)
    );`,
    `CREATE TABLE review_attempts (
        attempt_id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        review_type TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL,
        verdict TEXT NULL,
        reviewer_identity TEXT NULL,
        execution_mode TEXT NULL,
        started_at_utc TEXT NULL,
        completed_at_utc TEXT NULL,
        review_context_sha256 TEXT NULL CHECK (
            review_context_sha256 IS NULL OR
            (length(review_context_sha256) = 64 AND review_context_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        review_tree_state_sha256 TEXT NULL CHECK (
            review_tree_state_sha256 IS NULL OR
            (length(review_tree_state_sha256) = 64 AND review_tree_state_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        review_scope_sha256 TEXT NULL CHECK (
            review_scope_sha256 IS NULL OR
            (length(review_scope_sha256) = 64 AND review_scope_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        code_scope_sha256 TEXT NULL CHECK (
            code_scope_sha256 IS NULL OR
            (length(code_scope_sha256) = 64 AND code_scope_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        UNIQUE (task_id, review_type, attempt_number),
        UNIQUE (attempt_id, task_id, review_type)
    );`,
    `CREATE TABLE review_receipts (
        receipt_id TEXT PRIMARY KEY,
        attempt_id TEXT NULL,
        task_id TEXT NOT NULL,
        review_type TEXT NOT NULL,
        verdict TEXT NULL,
        trust_level TEXT NULL,
        reviewer_identity TEXT NULL,
        reviewer_execution_mode TEXT NULL,
        reused_existing_review INTEGER NOT NULL CHECK (reused_existing_review IN (0, 1)),
        recorded_at_utc TEXT NOT NULL,
        preflight_sha256 TEXT NULL CHECK (
            preflight_sha256 IS NULL OR
            (length(preflight_sha256) = 64 AND preflight_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        scope_sha256 TEXT NULL CHECK (
            scope_sha256 IS NULL OR
            (length(scope_sha256) = 64 AND scope_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        review_context_sha256 TEXT NULL CHECK (
            review_context_sha256 IS NULL OR
            (length(review_context_sha256) = 64 AND review_context_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        review_tree_state_sha256 TEXT NULL CHECK (
            review_tree_state_sha256 IS NULL OR
            (length(review_tree_state_sha256) = 64 AND review_tree_state_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        review_artifact_sha256 TEXT NULL CHECK (
            review_artifact_sha256 IS NULL OR
            (length(review_artifact_sha256) = 64 AND review_artifact_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        FOREIGN KEY (attempt_id, task_id, review_type)
            REFERENCES review_attempts(attempt_id, task_id, review_type)
    );`,
    `CREATE TABLE artifacts (
        artifact_id TEXT PRIMARY KEY,
        task_id TEXT NULL,
        review_attempt_id TEXT NULL REFERENCES review_attempts(attempt_id),
        artifact_kind TEXT NOT NULL,
        artifact_path TEXT NOT NULL UNIQUE,
        content_sha256 TEXT NOT NULL CHECK (
            length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        size_bytes INTEGER NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
        modified_at_utc TEXT NULL,
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    );`,
    `CREATE TABLE task_ledgers (
        task_id TEXT PRIMARY KEY,
        audit_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        queue_status TEXT NULL,
        health_state TEXT NULL,
        retention_tier TEXT NULL,
        integrity_status TEXT NOT NULL,
        point_in_time_status TEXT NOT NULL,
        blocker_count INTEGER NOT NULL CHECK (blocker_count >= 0),
        first_event_utc TEXT NULL,
        last_event_utc TEXT NULL,
        changed_files_count INTEGER NOT NULL CHECK (changed_files_count >= 0),
        changed_lines_total INTEGER NOT NULL CHECK (changed_lines_total >= 0),
        generated_at_utc TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    );`,
    `CREATE TABLE retention_state (
        retention_id TEXT PRIMARY KEY,
        task_id TEXT NULL,
        artifact_id TEXT NULL REFERENCES artifacts(artifact_id),
        retention_state TEXT NOT NULL,
        retention_tier TEXT NULL,
        eligible_at_utc TEXT NULL,
        reason TEXT NULL,
        policy_sha256 TEXT NULL CHECK (
            policy_sha256 IS NULL OR
            (length(policy_sha256) = 64 AND policy_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NULL CHECK (source_offset IS NULL OR source_offset >= 0),
        source_timestamp_utc TEXT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        )
    );`,
    `CREATE TABLE metric_samples (
        metric_id TEXT PRIMARY KEY,
        task_id TEXT NULL,
        metric_name TEXT NOT NULL,
        value_numeric REAL NULL,
        value_text TEXT NULL,
        unit TEXT NULL,
        recorded_at_utc TEXT NOT NULL,
        source_id TEXT NOT NULL REFERENCES canonical_sources(source_id),
        source_sequence INTEGER NULL CHECK (source_sequence IS NULL OR source_sequence >= 0),
        source_offset INTEGER NOT NULL CHECK (source_offset >= 0),
        source_timestamp_utc TEXT NOT NULL,
        record_content_sha256 TEXT NOT NULL CHECK (
            length(record_content_sha256) = 64 AND record_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK ((value_numeric IS NOT NULL) <> (value_text IS NOT NULL))
    );`,
    `CREATE TABLE metric_labels (
        metric_id TEXT NOT NULL REFERENCES metric_samples(metric_id) ON DELETE CASCADE,
        label_key TEXT NOT NULL,
        label_value TEXT NOT NULL,
        PRIMARY KEY (metric_id, label_key)
    );`,
    `CREATE TRIGGER artifacts_review_attempt_task_insert_guard
    BEFORE INSERT ON artifacts
    WHEN NEW.review_attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM review_attempts
        WHERE attempt_id = NEW.review_attempt_id AND task_id IS NEW.task_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'artifact review attempt task mismatch');
    END;`,
    `CREATE TRIGGER artifacts_review_attempt_task_update_guard
    BEFORE UPDATE OF review_attempt_id, task_id ON artifacts
    WHEN NEW.review_attempt_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM review_attempts
        WHERE attempt_id = NEW.review_attempt_id AND task_id IS NEW.task_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'artifact review attempt task mismatch');
    END;`,
    `CREATE TRIGGER retention_artifact_task_insert_guard
    BEFORE INSERT ON retention_state
    WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM artifacts
        WHERE artifact_id = NEW.artifact_id AND task_id IS NEW.task_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'retention artifact task mismatch');
    END;`,
    `CREATE TRIGGER retention_artifact_task_update_guard
    BEFORE UPDATE OF artifact_id, task_id ON retention_state
    WHEN NEW.artifact_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM artifacts
        WHERE artifact_id = NEW.artifact_id AND task_id IS NEW.task_id
    )
    BEGIN
        SELECT RAISE(ABORT, 'retention artifact task mismatch');
    END;`,
    'CREATE INDEX task_queue_status_priority_idx ON task_queue_rows(status, priority, queue_position);',
    'CREATE INDEX lifecycle_events_timestamp_idx ON lifecycle_events(source_timestamp_utc, task_id);',
    'CREATE INDEX lifecycle_events_type_idx ON lifecycle_events(event_type, task_id);',
    'CREATE INDEX review_attempts_task_type_idx ON review_attempts(task_id, review_type, attempt_number);',
    'CREATE INDEX review_receipts_task_type_idx ON review_receipts(task_id, review_type, recorded_at_utc);',
    'CREATE INDEX artifacts_task_kind_idx ON artifacts(task_id, artifact_kind);',
    'CREATE INDEX task_ledgers_verification_idx ON task_ledgers(verification_status, task_id);',
    'CREATE INDEX retention_state_selection_idx ON retention_state(retention_state, eligible_at_utc);',
    'CREATE INDEX metric_samples_name_time_idx ON metric_samples(metric_name, recorded_at_utc);',
    'CREATE INDEX metric_samples_task_time_idx ON metric_samples(task_id, recorded_at_utc);'
].join('\n');

const MIGRATION_V2_NAME = 'canonical-mutation-generation-checkpoint';
const MIGRATION_V2_SQL = `
    ALTER TABLE catalog_state
    ADD COLUMN canonical_generation INTEGER NULL
        CHECK (canonical_generation IS NULL OR canonical_generation >= 0);
`;

const MIGRATION_V3_NAME = 'project-memory-search-and-relationship-index';
const MIGRATION_V3_SQL = [
    `CREATE TABLE project_memory_index_state (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        index_status TEXT NOT NULL CHECK (index_status IN ('empty', 'ready', 'stale')),
        snapshot_sha256 TEXT NULL CHECK (
            snapshot_sha256 IS NULL OR
            (length(snapshot_sha256) = 64 AND snapshot_sha256 NOT GLOB '*[^0-9a-f]*')
        ),
        indexed_at_utc TEXT NULL,
        source_count INTEGER NOT NULL CHECK (source_count >= 0),
        entity_count INTEGER NOT NULL CHECK (entity_count >= 0),
        relationship_count INTEGER NOT NULL CHECK (relationship_count >= 0)
    );`,
    `INSERT INTO project_memory_index_state (
        singleton_id, index_status, snapshot_sha256, indexed_at_utc,
        source_count, entity_count, relationship_count
    ) VALUES (1, 'empty', NULL, NULL, 0, 0, 0);`,
    `CREATE TABLE project_memory_documents (
        document_id TEXT PRIMARY KEY,
        source_path TEXT NOT NULL UNIQUE,
        file_name TEXT NOT NULL UNIQUE,
        read_role TEXT NOT NULL CHECK (read_role IN ('read_first', 'focused')),
        title TEXT NOT NULL,
        content_sha256 TEXT NOT NULL CHECK (
            length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        indexed_content_sha256 TEXT NOT NULL CHECK (
            length(indexed_content_sha256) = 64 AND indexed_content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        redaction_applied INTEGER NOT NULL CHECK (redaction_applied IN (0, 1)),
        indexed_at_utc TEXT NOT NULL
    );`,
    `CREATE TABLE project_memory_entities (
        entity_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL REFERENCES project_memory_documents(document_id) ON DELETE CASCADE,
        entity_kind TEXT NOT NULL CHECK (entity_kind IN ('document', 'section')),
        label TEXT NOT NULL,
        normalized_label TEXT NOT NULL,
        source_path TEXT NOT NULL,
        source_line INTEGER NOT NULL CHECK (source_line > 0),
        ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
        content_sha256 TEXT NOT NULL CHECK (
            length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
        ),
        UNIQUE (document_id, ordinal)
    );`,
    `CREATE TABLE project_memory_relationships (
        relationship_id TEXT PRIMARY KEY,
        source_entity_id TEXT NOT NULL REFERENCES project_memory_entities(entity_id) ON DELETE CASCADE,
        target_entity_id TEXT NOT NULL REFERENCES project_memory_entities(entity_id) ON DELETE CASCADE,
        relationship_kind TEXT NOT NULL CHECK (relationship_kind IN ('contains', 'links_to')),
        source_path TEXT NOT NULL,
        source_line INTEGER NOT NULL CHECK (source_line > 0),
        UNIQUE (source_entity_id, target_entity_id, relationship_kind)
    );`,
    `CREATE VIRTUAL TABLE project_memory_fts USING fts5(
        entity_id UNINDEXED,
        document_id UNINDEXED,
        source_path UNINDEXED,
        source_line UNINDEXED,
        title,
        heading,
        body,
        tokenize = 'unicode61 remove_diacritics 2'
    );`,
    'CREATE INDEX project_memory_entities_document_idx ON project_memory_entities(document_id, ordinal);',
    'CREATE INDEX project_memory_entities_path_line_idx ON project_memory_entities(source_path, source_line);',
    'CREATE INDEX project_memory_relationships_source_idx ON project_memory_relationships(source_entity_id, relationship_kind);',
    'CREATE INDEX project_memory_relationships_target_idx ON project_memory_relationships(target_entity_id, relationship_kind);'
].join('\n');

function migrationChecksum(version: number, name: string, sql: string): string {
    return createHash('sha256')
        .update(`${version}:${name}\n${sql}`, 'utf8')
        .digest('hex');
}

export const SQLITE_CATALOG_MIGRATIONS: readonly SqliteCatalogMigration[] = Object.freeze([
    Object.freeze({
        version: 1,
        name: MIGRATION_V1_NAME,
        sql: MIGRATION_V1_SQL,
        checksum: migrationChecksum(1, MIGRATION_V1_NAME, MIGRATION_V1_SQL)
    }),
    Object.freeze({
        version: 2,
        name: MIGRATION_V2_NAME,
        sql: MIGRATION_V2_SQL,
        checksum: migrationChecksum(2, MIGRATION_V2_NAME, MIGRATION_V2_SQL)
    }),
    Object.freeze({
        version: 3,
        name: MIGRATION_V3_NAME,
        sql: MIGRATION_V3_SQL,
        checksum: migrationChecksum(3, MIGRATION_V3_NAME, MIGRATION_V3_SQL)
    })
]);

export const SQLITE_CATALOG_REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = Object.freeze({
    schema_migrations: Object.freeze(['version', 'name', 'checksum', 'applied_at_utc', 'app_version']),
    catalog_state: Object.freeze([
        'singleton_id',
        'generation',
        'projection_status',
        'snapshot_sha256',
        'refreshed_at_utc',
        'stale_reason',
        'canonical_generation'
    ]),
    canonical_sources: Object.freeze(['source_id', 'source_kind', 'source_path', 'content_sha256', 'observed_at_utc']),
    task_queue_rows: Object.freeze(['task_id', 'queue_position', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    lifecycle_events: Object.freeze(['task_id', 'task_sequence', 'event_type', 'event_sha256', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    review_attempts: Object.freeze(['attempt_id', 'task_id', 'review_type', 'attempt_number', 'status', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    review_receipts: Object.freeze(['receipt_id', 'attempt_id', 'task_id', 'review_type', 'recorded_at_utc', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    artifacts: Object.freeze(['artifact_id', 'task_id', 'review_attempt_id', 'artifact_kind', 'artifact_path', 'content_sha256', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    task_ledgers: Object.freeze(['task_id', 'audit_status', 'verification_status', 'generated_at_utc', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    retention_state: Object.freeze(['retention_id', 'task_id', 'artifact_id', 'retention_state', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    metric_samples: Object.freeze(['metric_id', 'task_id', 'metric_name', 'recorded_at_utc', 'source_id', 'source_sequence', 'source_offset', 'source_timestamp_utc', 'record_content_sha256']),
    metric_labels: Object.freeze(['metric_id', 'label_key', 'label_value']),
    project_memory_index_state: Object.freeze([
        'singleton_id',
        'index_status',
        'snapshot_sha256',
        'indexed_at_utc',
        'source_count',
        'entity_count',
        'relationship_count'
    ]),
    project_memory_documents: Object.freeze([
        'document_id',
        'source_path',
        'file_name',
        'read_role',
        'title',
        'content_sha256',
        'indexed_content_sha256',
        'redaction_applied',
        'indexed_at_utc'
    ]),
    project_memory_entities: Object.freeze([
        'entity_id',
        'document_id',
        'entity_kind',
        'label',
        'normalized_label',
        'source_path',
        'source_line',
        'ordinal',
        'content_sha256'
    ]),
    project_memory_relationships: Object.freeze([
        'relationship_id',
        'source_entity_id',
        'target_entity_id',
        'relationship_kind',
        'source_path',
        'source_line'
    ]),
    project_memory_fts: Object.freeze([
        'entity_id',
        'document_id',
        'source_path',
        'source_line',
        'title',
        'heading',
        'body'
    ])
});

export const SQLITE_CATALOG_PROJECTION_TABLES_DELETE_ORDER = Object.freeze([
    'metric_labels',
    'retention_state',
    'review_receipts',
    'artifacts',
    'review_attempts',
    'metric_samples',
    'lifecycle_events',
    'task_ledgers',
    'task_queue_rows',
    'canonical_sources'
] as const);
