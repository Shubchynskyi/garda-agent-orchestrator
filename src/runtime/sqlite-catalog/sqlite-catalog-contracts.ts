export interface CatalogRowProvenance {
    readonly sourceKind: string;
    readonly sourcePath: string;
    readonly sourceContentSha256: string;
    readonly sourceObservedAtUtc: string;
    readonly sourceSequence: number | null;
    readonly sourceOffset: number | null;
    readonly sourceTimestampUtc: string | null;
    readonly recordContentSha256: string;
}

export interface CatalogTaskRow {
    readonly taskId: string;
    readonly status: string | null;
    readonly priority: string | null;
    readonly area: string | null;
    readonly title: string | null;
    readonly owner: string | null;
    readonly updatedText: string | null;
    readonly profile: string | null;
    readonly notes: string | null;
    readonly queuePosition: number;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogLifecycleEvent {
    readonly taskId: string;
    readonly taskSequence: number;
    readonly eventType: string;
    readonly outcome: string;
    readonly actor: string;
    readonly message: string;
    readonly lifecyclePhase: string | null;
    readonly statusSignal: string | null;
    readonly healthState: string | null;
    readonly terminalOutcome: string | null;
    readonly previousEventSha256: string | null;
    readonly eventSha256: string;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogReviewAttempt {
    readonly attemptId: string;
    readonly taskId: string;
    readonly reviewType: string;
    readonly attemptNumber: number;
    readonly status: string;
    readonly verdict: string | null;
    readonly reviewerIdentity: string | null;
    readonly executionMode: string | null;
    readonly startedAtUtc: string | null;
    readonly completedAtUtc: string | null;
    readonly reviewContextSha256: string | null;
    readonly reviewTreeStateSha256: string | null;
    readonly reviewScopeSha256: string | null;
    readonly codeScopeSha256: string | null;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogReviewReceipt {
    readonly receiptId: string;
    readonly attemptId: string | null;
    readonly taskId: string;
    readonly reviewType: string;
    readonly verdict: string | null;
    readonly trustLevel: string | null;
    readonly reviewerIdentity: string | null;
    readonly reviewerExecutionMode: string | null;
    readonly reusedExistingReview: boolean;
    readonly recordedAtUtc: string;
    readonly preflightSha256: string | null;
    readonly scopeSha256: string | null;
    readonly reviewContextSha256: string | null;
    readonly reviewTreeStateSha256: string | null;
    readonly reviewArtifactSha256: string | null;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogArtifact {
    readonly artifactId: string;
    readonly taskId: string | null;
    readonly reviewAttemptId: string | null;
    readonly kind: string;
    readonly path: string;
    readonly contentSha256: string;
    readonly sizeBytes: number | null;
    readonly modifiedAtUtc: string | null;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogTaskLedger {
    readonly taskId: string;
    readonly auditStatus: string;
    readonly verificationStatus: string;
    readonly queueStatus: string | null;
    readonly healthState: string | null;
    readonly retentionTier: string | null;
    readonly integrityStatus: string;
    readonly pointInTimeStatus: string;
    readonly blockerCount: number;
    readonly firstEventUtc: string | null;
    readonly lastEventUtc: string | null;
    readonly changedFilesCount: number;
    readonly changedLinesTotal: number;
    readonly generatedAtUtc: string;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogRetentionState {
    readonly retentionId: string;
    readonly taskId: string | null;
    readonly artifactId: string | null;
    readonly state: string;
    readonly tier: string | null;
    readonly eligibleAtUtc: string | null;
    readonly reason: string | null;
    readonly policySha256: string | null;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogMetricSample {
    readonly metricId: string;
    readonly taskId: string | null;
    readonly name: string;
    readonly valueNumeric: number | null;
    readonly valueText: string | null;
    readonly unit: string | null;
    readonly labels: Readonly<Record<string, string>>;
    readonly recordedAtUtc: string;
    readonly provenance: CatalogRowProvenance;
}

export interface CatalogTaskActivitySummary {
    readonly taskId: string;
    readonly queuePosition: number;
    readonly status: string | null;
    readonly lifecycleEventCount: number;
    readonly firstLifecycleEventUtc: string | null;
    readonly lastLifecycleEventUtc: string | null;
    readonly reviewAttemptCount: number;
    readonly reviewReceiptCount: number;
    readonly artifactCount: number;
    readonly metricSampleCount: number;
    readonly auditStatus: string | null;
    readonly verificationStatus: string | null;
    readonly healthState: string | null;
    readonly retentionState: string | null;
    readonly retentionTier: string | null;
}

export interface CatalogCanonicalSource {
    readonly sourceKind: string;
    readonly sourcePath: string;
    readonly contentSha256: string;
    readonly observedAtUtc: string;
}

export interface DerivedCatalogProjection {
    readonly generatedAtUtc: string;
    readonly snapshotSha256: string;
    readonly canonicalGeneration?: number | null;
    readonly canonicalSources: readonly CatalogCanonicalSource[];
    readonly tasks: readonly CatalogTaskRow[];
    readonly lifecycleEvents: readonly CatalogLifecycleEvent[];
    readonly reviewAttempts: readonly CatalogReviewAttempt[];
    readonly reviewReceipts: readonly CatalogReviewReceipt[];
    readonly artifacts: readonly CatalogArtifact[];
    readonly taskLedgers: readonly CatalogTaskLedger[];
    readonly retentionStates: readonly CatalogRetentionState[];
    readonly metricSamples: readonly CatalogMetricSample[];
}

export interface SqliteCatalogCounts {
    readonly sources: number;
    readonly tasks: number;
    readonly lifecycleEvents: number;
    readonly reviewAttempts: number;
    readonly reviewReceipts: number;
    readonly artifacts: number;
    readonly taskLedgers: number;
    readonly retentionStates: number;
    readonly metricSamples: number;
    readonly metricLabels: number;
}

export interface SqliteCatalogInspection {
    readonly catalogPath: string;
    readonly applicationId: number;
    readonly schemaVersion: number;
    readonly journalMode: string;
    readonly foreignKeysEnabled: boolean;
    readonly busyTimeoutMs: number;
    readonly generation: number;
    readonly canonicalGeneration: number | null;
    readonly projectionStatus: 'empty' | 'ready' | 'stale';
    readonly snapshotSha256: string | null;
    readonly refreshedAtUtc: string | null;
    readonly counts: SqliteCatalogCounts;
}

export interface SqliteCatalogSourceInspection {
    readonly sourceKind: string;
    readonly sourcePath: string;
    readonly contentSha256: string;
    readonly observedAtUtc: string;
}

export interface SqliteCatalogParityInspection {
    readonly parity: boolean;
    readonly mismatchedTables: readonly string[];
}

export interface SqliteCatalogRebuildProgress {
    readonly phase: string;
    readonly completedRows: number;
    readonly totalRows: number;
}

export type ProjectMemoryIndexStatus = 'empty' | 'ready' | 'stale' | 'unavailable';

export interface ProjectMemoryIndexInspection {
    readonly status: ProjectMemoryIndexStatus;
    readonly snapshotSha256: string | null;
    readonly indexedAtUtc: string | null;
    readonly sourceCount: number;
    readonly entityCount: number;
    readonly relationshipCount: number;
    readonly changedSources: readonly string[];
    readonly diagnostic: string;
}

export interface ProjectMemoryIndexRefreshResult extends ProjectMemoryIndexInspection {
    readonly outcome: 'applied' | 'current' | 'deferred';
}

export interface ProjectMemorySearchHit {
    readonly entityId: string;
    readonly sourcePath: string;
    readonly sourceLine: number;
    readonly title: string;
    readonly heading: string;
    readonly snippet: string;
    readonly rank: number;
}

export interface ProjectMemorySearchResult {
    readonly status: ProjectMemoryIndexStatus | 'invalid_query';
    readonly snapshotSha256: string | null;
    readonly hits: readonly ProjectMemorySearchHit[];
    readonly changedSources: readonly string[];
    readonly diagnostic: string;
}

export interface ProjectMemoryRelationship {
    readonly relationshipId: string;
    readonly sourceEntityId: string;
    readonly targetEntityId: string;
    readonly kind: 'contains' | 'links_to';
    readonly sourcePath: string;
    readonly targetSourcePath: string;
    readonly sourceLine: number;
}

export interface ProjectMemoryRelationshipResult {
    readonly status: ProjectMemoryIndexStatus;
    readonly snapshotSha256: string | null;
    readonly relationships: readonly ProjectMemoryRelationship[];
    readonly changedSources: readonly string[];
    readonly diagnostic: string;
}

export interface ProjectMemoryIndexRefreshOptions {
    readonly clock?: () => string;
}

export interface ProjectMemorySearchOptions {
    readonly limit?: number;
}

export interface SqliteCatalogRebuildOptions {
    readonly batchSize?: number;
    readonly onProgress?: (event: SqliteCatalogRebuildProgress) => void;
}

export type SqliteCatalogWriteDeferredReason = 'busy' | 'locked' | 'write_error';

export type SqliteCatalogWriteResult =
    | {
        readonly status: 'applied';
        readonly generation: number;
        readonly counts: SqliteCatalogCounts;
    }
    | {
        readonly status: 'rebuild_required';
        readonly reason: 'projection_too_large';
        readonly minimumRows: number;
        readonly maximumTransactionRows: number;
        readonly diagnostic: string;
    }
    | {
        readonly status: 'deferred';
        readonly reason: SqliteCatalogWriteDeferredReason;
        readonly diagnostic: string;
    };

export interface DerivedSqliteCatalog {
    readonly catalogPath: string;
    readonly schemaVersion: number;
    replaceProjection(projection: DerivedCatalogProjection): SqliteCatalogWriteResult;
    reconcileProjection(projection: DerivedCatalogProjection): SqliteCatalogWriteResult;
    rebuildProjection(
        projection: DerivedCatalogProjection,
        options?: SqliteCatalogRebuildOptions
    ): SqliteCatalogWriteResult;
    inspect(): SqliteCatalogInspection;
    inspectSources(): readonly SqliteCatalogSourceInspection[];
    inspectParity(projection: DerivedCatalogProjection): SqliteCatalogParityInspection;
    queryTasks(taskId?: string): readonly CatalogTaskRow[];
    queryLifecycleEvents(taskId?: string): readonly CatalogLifecycleEvent[];
    queryReviewAttempts(taskId?: string): readonly CatalogReviewAttempt[];
    queryReviewReceipts(taskId?: string): readonly CatalogReviewReceipt[];
    queryArtifacts(taskId?: string): readonly CatalogArtifact[];
    queryTaskLedgers(taskId?: string): readonly CatalogTaskLedger[];
    queryRetentionStates(taskId?: string): readonly CatalogRetentionState[];
    queryMetricSamples(taskId?: string): readonly CatalogMetricSample[];
    queryTaskActivitySummaries(taskId?: string): readonly CatalogTaskActivitySummary[];
    refreshProjectMemoryIndex(options?: ProjectMemoryIndexRefreshOptions): ProjectMemoryIndexRefreshResult;
    inspectProjectMemoryIndex(): ProjectMemoryIndexInspection;
    searchProjectMemory(query: string, options?: ProjectMemorySearchOptions): ProjectMemorySearchResult;
    queryProjectMemoryRelationships(sourcePath?: string): ProjectMemoryRelationshipResult;
    close(): void;
}

export type SqliteCatalogUnavailableReason =
    | 'capability_unavailable'
    | 'unsafe_path'
    | 'path_unavailable'
    | 'already_open'
    | 'busy'
    | 'locked'
    | 'foreign_database'
    | 'newer_schema'
    | 'invalid_schema'
    | 'corrupt_catalog'
    | 'migration_failed'
    | 'wal_unavailable'
    | 'open_failed';

export type OpenDerivedSqliteCatalogResult =
    | {
        readonly status: 'available';
        readonly catalog: DerivedSqliteCatalog;
    }
    | {
        readonly status: 'unavailable';
        readonly catalogPath: string | null;
        readonly reason: SqliteCatalogUnavailableReason;
        readonly diagnostic: string;
    };

export interface SqliteCatalogCapability {
    readonly available: boolean;
    readonly sqliteVersion: string | null;
    readonly fts5Available: boolean;
    readonly diagnostic: string;
}

export interface OpenDerivedSqliteCatalogOptions {
    readonly appVersion?: string;
    readonly clock?: () => string;
}
