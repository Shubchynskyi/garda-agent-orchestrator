import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { assertCanonicalTaskId } from '../../core/task-ids';
import type {
    CatalogCanonicalSource,
    CatalogArtifact,
    CatalogLifecycleEvent,
    CatalogMetricSample,
    CatalogRetentionState,
    CatalogReviewAttempt,
    CatalogReviewReceipt,
    CatalogRowProvenance,
    CatalogTaskLedger,
    CatalogTaskRow,
    DerivedCatalogProjection
} from './sqlite-catalog-contracts';

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UTC_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/u;

export interface CanonicalSourceRow {
    readonly sourceId: string;
    readonly sourceKind: string;
    readonly sourcePath: string;
    readonly contentSha256: string;
    readonly observedAtUtc: string;
}

export class CatalogProjectionValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogProjectionValidationError';
    }
}

function fail(label: string, expectation: string): never {
    throw new CatalogProjectionValidationError(`${label} ${expectation}`);
}

function assertText(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !value.trim()) {
        fail(label, 'must be a non-empty string.');
    }
}

function assertNullableText(value: unknown, label: string): void {
    if (value !== null && typeof value !== 'string') {
        fail(label, 'must be a string or null.');
    }
}

function assertRowObject(value: unknown, label: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        fail(label, 'must be an object.');
    }
}

function assertNullableIdentifier(value: unknown, label: string): void {
    if (value !== null) {
        assertText(value, label);
    }
}

function assertInteger(value: unknown, label: string, minimum: number): asserts value is number {
    if (!Number.isSafeInteger(value) || Number(value) < minimum) {
        fail(label, `must be a safe integer greater than or equal to ${minimum}.`);
    }
}

function assertNullableInteger(value: unknown, label: string, minimum: number): void {
    if (value !== null) {
        assertInteger(value, label, minimum);
    }
}

function assertSha256(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        fail(label, 'must be a lowercase SHA-256 value.');
    }
}

function assertNullableSha256(value: unknown, label: string): void {
    if (value !== null) {
        assertSha256(value, label);
    }
}

function assertUtcTimestamp(value: unknown, label: string): asserts value is string {
    if (typeof value !== 'string') {
        fail(label, 'must be a UTC ISO-8601 timestamp.');
    }
    const match = UTC_TIMESTAMP_PATTERN.exec(value);
    const timestampMs = match ? Date.parse(value) : Number.NaN;
    if (!match || !Number.isFinite(timestampMs)) {
        fail(label, 'must be a valid UTC ISO-8601 timestamp.');
    }
    const parsed = new Date(timestampMs);
    const [, year, month, day, hour, minute, second] = match.map(Number);
    if (
        parsed.getUTCFullYear() !== year
        || parsed.getUTCMonth() + 1 !== month
        || parsed.getUTCDate() !== day
        || parsed.getUTCHours() !== hour
        || parsed.getUTCMinutes() !== minute
        || parsed.getUTCSeconds() !== second
    ) {
        fail(label, 'must identify a real UTC calendar timestamp.');
    }
}

function assertNullableUtcTimestamp(value: unknown, label: string): void {
    if (value !== null) {
        assertUtcTimestamp(value, label);
    }
}

function assertRelativePortablePath(value: unknown, label: string): asserts value is string {
    assertText(value, label);
    const portable = value.replace(/\\/gu, '/');
    const normalized = path.posix.normalize(portable);
    if (
        value !== portable
        || normalized !== portable
        || portable === '.'
        || portable.startsWith('/')
        || /^[a-z]:\//iu.test(portable)
        || portable === '..'
        || portable.startsWith('../')
        || portable.includes('\0')
    ) {
        fail(label, 'must be a normalized workspace-relative POSIX path.');
    }
}

function assertTaskId(value: unknown, label: string): void {
    try {
        assertCanonicalTaskId(value);
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        fail(label, `is invalid: ${detail}`);
    }
}

function assertProvenance(provenance: CatalogRowProvenance, label: string): void {
    if (!provenance || typeof provenance !== 'object') {
        fail(label, 'must be an object.');
    }
    assertText(provenance.sourceKind, `${label}.sourceKind`);
    assertRelativePortablePath(provenance.sourcePath, `${label}.sourcePath`);
    assertSha256(provenance.sourceContentSha256, `${label}.sourceContentSha256`);
    assertUtcTimestamp(provenance.sourceObservedAtUtc, `${label}.sourceObservedAtUtc`);
    assertNullableInteger(provenance.sourceSequence, `${label}.sourceSequence`, 0);
    assertNullableInteger(provenance.sourceOffset, `${label}.sourceOffset`, 0);
    assertNullableUtcTimestamp(provenance.sourceTimestampUtc, `${label}.sourceTimestampUtc`);
    assertSha256(provenance.recordContentSha256, `${label}.recordContentSha256`);
}

function assertTaskRow(row: CatalogTaskRow, index: number): void {
    const label = `tasks[${index}]`;
    assertRowObject(row, label);
    assertTaskId(row.taskId, `${label}.taskId`);
    for (const [key, value] of Object.entries({
        status: row.status,
        priority: row.priority,
        area: row.area,
        title: row.title,
        owner: row.owner,
        updatedText: row.updatedText,
        profile: row.profile,
        notes: row.notes
    })) {
        assertNullableText(value, `${label}.${key}`);
    }
    assertInteger(row.queuePosition, `${label}.queuePosition`, 0);
    assertProvenance(row.provenance, `${label}.provenance`);
}

function assertLifecycleEvent(row: CatalogLifecycleEvent, index: number): void {
    const label = `lifecycleEvents[${index}]`;
    assertRowObject(row, label);
    assertTaskId(row.taskId, `${label}.taskId`);
    assertInteger(row.taskSequence, `${label}.taskSequence`, 1);
    for (const [key, value] of Object.entries({
        eventType: row.eventType,
        outcome: row.outcome,
        actor: row.actor,
        message: row.message
    })) {
        assertText(value, `${label}.${key}`);
    }
    for (const [key, value] of Object.entries({
        lifecyclePhase: row.lifecyclePhase,
        statusSignal: row.statusSignal,
        healthState: row.healthState,
        terminalOutcome: row.terminalOutcome
    })) {
        assertNullableText(value, `${label}.${key}`);
    }
    assertNullableSha256(row.previousEventSha256, `${label}.previousEventSha256`);
    assertSha256(row.eventSha256, `${label}.eventSha256`);
    assertProvenance(row.provenance, `${label}.provenance`);
    if (row.provenance.sourceSequence !== row.taskSequence || row.provenance.sourceTimestampUtc === null) {
        fail(`${label}.provenance`, 'must retain the event task sequence and timestamp.');
    }
}

function assertReviewAttempt(row: CatalogReviewAttempt, index: number): void {
    const label = `reviewAttempts[${index}]`;
    assertRowObject(row, label);
    assertText(row.attemptId, `${label}.attemptId`);
    assertTaskId(row.taskId, `${label}.taskId`);
    assertText(row.reviewType, `${label}.reviewType`);
    assertInteger(row.attemptNumber, `${label}.attemptNumber`, 1);
    assertText(row.status, `${label}.status`);
    for (const [key, value] of Object.entries({
        verdict: row.verdict,
        reviewerIdentity: row.reviewerIdentity,
        executionMode: row.executionMode
    })) {
        assertNullableText(value, `${label}.${key}`);
    }
    assertNullableUtcTimestamp(row.startedAtUtc, `${label}.startedAtUtc`);
    assertNullableUtcTimestamp(row.completedAtUtc, `${label}.completedAtUtc`);
    assertNullableSha256(row.reviewContextSha256, `${label}.reviewContextSha256`);
    assertNullableSha256(row.reviewTreeStateSha256, `${label}.reviewTreeStateSha256`);
    assertNullableSha256(row.reviewScopeSha256, `${label}.reviewScopeSha256`);
    assertNullableSha256(row.codeScopeSha256, `${label}.codeScopeSha256`);
    assertProvenance(row.provenance, `${label}.provenance`);
}

function assertReviewReceipt(row: CatalogReviewReceipt, index: number): void {
    const label = `reviewReceipts[${index}]`;
    assertRowObject(row, label);
    assertText(row.receiptId, `${label}.receiptId`);
    assertNullableIdentifier(row.attemptId, `${label}.attemptId`);
    assertTaskId(row.taskId, `${label}.taskId`);
    assertText(row.reviewType, `${label}.reviewType`);
    assertNullableText(row.verdict, `${label}.verdict`);
    assertNullableText(row.trustLevel, `${label}.trustLevel`);
    assertNullableText(row.reviewerIdentity, `${label}.reviewerIdentity`);
    assertNullableText(row.reviewerExecutionMode, `${label}.reviewerExecutionMode`);
    if (typeof row.reusedExistingReview !== 'boolean') {
        fail(`${label}.reusedExistingReview`, 'must be boolean.');
    }
    assertUtcTimestamp(row.recordedAtUtc, `${label}.recordedAtUtc`);
    assertNullableSha256(row.preflightSha256, `${label}.preflightSha256`);
    assertNullableSha256(row.scopeSha256, `${label}.scopeSha256`);
    assertNullableSha256(row.reviewContextSha256, `${label}.reviewContextSha256`);
    assertNullableSha256(row.reviewTreeStateSha256, `${label}.reviewTreeStateSha256`);
    assertNullableSha256(row.reviewArtifactSha256, `${label}.reviewArtifactSha256`);
    assertProvenance(row.provenance, `${label}.provenance`);
}

function assertReviewReceiptRelationships(projection: DerivedCatalogProjection): void {
    const attemptsById = new Map(
        projection.reviewAttempts.map((attempt) => [attempt.attemptId, attempt] as const)
    );
    projection.reviewReceipts.forEach((receipt, index) => {
        if (receipt.attemptId === null) return;
        const attempt = attemptsById.get(receipt.attemptId);
        if (!attempt) {
            fail(
                `reviewReceipts[${index}].attemptId`,
                'must reference a review attempt in the same projection.'
            );
        }
        if (receipt.taskId !== attempt.taskId || receipt.reviewType !== attempt.reviewType) {
            fail(
                `reviewReceipts[${index}]`,
                'must match the taskId and reviewType of its referenced review attempt.'
            );
        }
    });
}

function assertArtifact(row: CatalogArtifact, index: number): void {
    const label = `artifacts[${index}]`;
    assertRowObject(row, label);
    assertText(row.artifactId, `${label}.artifactId`);
    if (row.taskId !== null) assertTaskId(row.taskId, `${label}.taskId`);
    assertNullableIdentifier(row.reviewAttemptId, `${label}.reviewAttemptId`);
    assertText(row.kind, `${label}.kind`);
    assertRelativePortablePath(row.path, `${label}.path`);
    assertSha256(row.contentSha256, `${label}.contentSha256`);
    assertNullableInteger(row.sizeBytes, `${label}.sizeBytes`, 0);
    assertNullableUtcTimestamp(row.modifiedAtUtc, `${label}.modifiedAtUtc`);
    assertProvenance(row.provenance, `${label}.provenance`);
}

function assertArtifactRelationships(projection: DerivedCatalogProjection): void {
    const attemptsById = new Map(
        projection.reviewAttempts.map((attempt) => [attempt.attemptId, attempt] as const)
    );
    projection.artifacts.forEach((artifact, index) => {
        if (artifact.reviewAttemptId === null) return;
        const attempt = attemptsById.get(artifact.reviewAttemptId);
        if (!attempt) {
            fail(
                `artifacts[${index}].reviewAttemptId`,
                'must reference a review attempt in the same projection.'
            );
        }
        if (artifact.taskId !== attempt.taskId) {
            fail(
                `artifacts[${index}].taskId`,
                'must match the taskId of its referenced review attempt.'
            );
        }
    });
}

function assertTaskLedger(row: CatalogTaskLedger, index: number): void {
    const label = `taskLedgers[${index}]`;
    assertRowObject(row, label);
    assertTaskId(row.taskId, `${label}.taskId`);
    assertText(row.auditStatus, `${label}.auditStatus`);
    assertText(row.verificationStatus, `${label}.verificationStatus`);
    assertNullableText(row.queueStatus, `${label}.queueStatus`);
    assertNullableText(row.healthState, `${label}.healthState`);
    assertNullableText(row.retentionTier, `${label}.retentionTier`);
    assertText(row.integrityStatus, `${label}.integrityStatus`);
    assertText(row.pointInTimeStatus, `${label}.pointInTimeStatus`);
    assertInteger(row.blockerCount, `${label}.blockerCount`, 0);
    assertNullableUtcTimestamp(row.firstEventUtc, `${label}.firstEventUtc`);
    assertNullableUtcTimestamp(row.lastEventUtc, `${label}.lastEventUtc`);
    assertInteger(row.changedFilesCount, `${label}.changedFilesCount`, 0);
    assertInteger(row.changedLinesTotal, `${label}.changedLinesTotal`, 0);
    assertUtcTimestamp(row.generatedAtUtc, `${label}.generatedAtUtc`);
    assertProvenance(row.provenance, `${label}.provenance`);
}

function assertRetentionState(row: CatalogRetentionState, index: number): void {
    const label = `retentionStates[${index}]`;
    assertRowObject(row, label);
    assertText(row.retentionId, `${label}.retentionId`);
    if (row.taskId !== null) assertTaskId(row.taskId, `${label}.taskId`);
    assertNullableIdentifier(row.artifactId, `${label}.artifactId`);
    assertText(row.state, `${label}.state`);
    assertNullableText(row.tier, `${label}.tier`);
    assertNullableUtcTimestamp(row.eligibleAtUtc, `${label}.eligibleAtUtc`);
    assertNullableText(row.reason, `${label}.reason`);
    assertNullableSha256(row.policySha256, `${label}.policySha256`);
    assertProvenance(row.provenance, `${label}.provenance`);
}

function assertRetentionRelationships(projection: DerivedCatalogProjection): void {
    const artifactsById = new Map(
        projection.artifacts.map((artifact) => [artifact.artifactId, artifact] as const)
    );
    projection.retentionStates.forEach((retention, index) => {
        if (retention.artifactId === null) return;
        const artifact = artifactsById.get(retention.artifactId);
        if (!artifact) {
            fail(
                `retentionStates[${index}].artifactId`,
                'must reference an artifact in the same projection.'
            );
        }
        if (retention.taskId !== artifact.taskId) {
            fail(
                `retentionStates[${index}].taskId`,
                'must match the taskId of its referenced artifact.'
            );
        }
    });
}

function assertMetricSample(row: CatalogMetricSample, index: number): void {
    const label = `metricSamples[${index}]`;
    assertRowObject(row, label);
    assertText(row.metricId, `${label}.metricId`);
    if (row.taskId !== null) assertTaskId(row.taskId, `${label}.taskId`);
    assertText(row.name, `${label}.name`);
    const numericPresent = typeof row.valueNumeric === 'number' && Number.isFinite(row.valueNumeric);
    const textPresent = typeof row.valueText === 'string';
    if (numericPresent === textPresent) {
        fail(label, 'must provide exactly one finite valueNumeric or string valueText.');
    }
    assertNullableText(row.unit, `${label}.unit`);
    assertUtcTimestamp(row.recordedAtUtc, `${label}.recordedAtUtc`);
    if (!row.labels || typeof row.labels !== 'object' || Array.isArray(row.labels)) {
        fail(`${label}.labels`, 'must be a string record.');
    }
    for (const [key, value] of Object.entries(row.labels)) {
        assertText(key, `${label}.labels key`);
        if (typeof value !== 'string') fail(`${label}.labels.${key}`, 'must be a string.');
    }
    assertProvenance(row.provenance, `${label}.provenance`);
    if (row.provenance.sourceOffset === null || row.provenance.sourceTimestampUtc === null) {
        fail(`${label}.provenance`, 'must retain the metric source offset and timestamp.');
    }
}

function allProvenance(projection: DerivedCatalogProjection): CatalogRowProvenance[] {
    return [
        ...projection.tasks,
        ...projection.lifecycleEvents,
        ...projection.reviewAttempts,
        ...projection.reviewReceipts,
        ...projection.artifacts,
        ...projection.taskLedgers,
        ...projection.retentionStates,
        ...projection.metricSamples
    ].map((row) => row.provenance);
}

function assertCanonicalSource(source: CatalogCanonicalSource, index: number): void {
    const label = `canonicalSources[${index}]`;
    assertRowObject(source, label);
    assertText(source.sourceKind, `${label}.sourceKind`);
    assertRelativePortablePath(source.sourcePath, `${label}.sourcePath`);
    assertSha256(source.contentSha256, `${label}.contentSha256`);
    assertUtcTimestamp(source.observedAtUtc, `${label}.observedAtUtc`);
}

export function sourceIdForProvenance(provenance: CatalogRowProvenance): string {
    return createHash('sha256')
        .update(`${provenance.sourceKind}\0${provenance.sourcePath}`, 'utf8')
        .digest('hex');
}

export function validateCatalogProjection(projection: DerivedCatalogProjection): CanonicalSourceRow[] {
    if (!projection || typeof projection !== 'object') {
        fail('projection', 'must be an object.');
    }
    assertUtcTimestamp(projection.generatedAtUtc, 'projection.generatedAtUtc');
    assertSha256(projection.snapshotSha256, 'projection.snapshotSha256');
    if (projection.canonicalGeneration !== undefined && projection.canonicalGeneration !== null) {
        assertInteger(projection.canonicalGeneration, 'projection.canonicalGeneration', 0);
    }
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
    if (collections.some((collection) => !Array.isArray(collection))) {
        fail('projection', 'must provide every catalog collection as an array.');
    }
    projection.canonicalSources.forEach(assertCanonicalSource);
    projection.tasks.forEach(assertTaskRow);
    projection.lifecycleEvents.forEach(assertLifecycleEvent);
    projection.reviewAttempts.forEach(assertReviewAttempt);
    projection.reviewReceipts.forEach(assertReviewReceipt);
    assertReviewReceiptRelationships(projection);
    projection.artifacts.forEach(assertArtifact);
    assertArtifactRelationships(projection);
    projection.taskLedgers.forEach(assertTaskLedger);
    projection.retentionStates.forEach(assertRetentionState);
    assertRetentionRelationships(projection);
    projection.metricSamples.forEach(assertMetricSample);

    const sourcesByKey = new Map<string, CanonicalSourceRow>();
    for (const source of projection.canonicalSources) {
        const sourceId = sourceIdForProvenance({
            sourceKind: source.sourceKind,
            sourcePath: source.sourcePath,
            sourceContentSha256: source.contentSha256,
            sourceObservedAtUtc: source.observedAtUtc,
            sourceSequence: null,
            sourceOffset: null,
            sourceTimestampUtc: null,
            recordContentSha256: source.contentSha256
        });
        if (sourcesByKey.has(sourceId)) {
            fail(`source ${source.sourcePath}`, 'is duplicated in the canonical source inventory.');
        }
        sourcesByKey.set(sourceId, {
            sourceId,
            sourceKind: source.sourceKind,
            sourcePath: source.sourcePath,
            contentSha256: source.contentSha256,
            observedAtUtc: source.observedAtUtc
        });
    }
    for (const provenance of allProvenance(projection)) {
        const sourceId = sourceIdForProvenance(provenance);
        const existing = sourcesByKey.get(sourceId);
        if (!existing) {
            fail(`source ${provenance.sourcePath}`, 'is absent from the canonical source inventory.');
        }
        if (
            existing.contentSha256 !== provenance.sourceContentSha256
            || existing.observedAtUtc !== provenance.sourceObservedAtUtc
        ) {
            fail(`source ${provenance.sourcePath}`, 'has inconsistent snapshot provenance.');
        }
    }
    return [...sourcesByKey.values()].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}
