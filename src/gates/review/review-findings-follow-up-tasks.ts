import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleNameForTarget
} from '../../core/constants';
import { isPlainRecord } from '../../core/records';
import {
    assertCanonicalTaskId,
    isCanonicalTaskId
} from '../../core/task-ids';
import { allocateParentDerivedTaskIds } from '../../core/task-id-allocation';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell,
    type CanonicalActiveTaskQueueRow
} from '../../core/task-md-table';
import {
    withTaskQueueStatusSyncLock
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import { buildOperatorNextActionBlock } from '../shared/operator-action-output';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION,
    REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE,
    type ReviewFindingsDispositionArtifact,
    type ReviewFindingsDispositionArtifactItem
} from './review-findings-disposition-artifact';
import {
    validateReviewFindingsValidationArtifact,
    type NormalizedReviewFindingInventoryEntry,
    type NormalizedReviewResidualRiskInventoryEntry,
    type ReviewFindingsValidationArtifact
} from './review-findings-validation-artifact';
export const REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE = 'review_findings_follow_up_tasks';
export const REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION = 1;

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
const REVIEW_TYPE_TOKEN_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const REVIEW_TYPE_MAX_LENGTH = 64;

type ReviewFollowUpMaterializationStatus =
    | 'MATERIALIZED'
    | 'ALREADY_MATERIALIZED'
    | 'NOT_REQUIRED'
    | 'BLOCKED';

type ReviewFindingFollowUpItemStatus =
    | 'created'
    | 'already_materialized'
    | 'not_required'
    | 'requires_fix_now'
    | 'blocked';

type SourceInventoryEntry =
    | {
        kind: 'finding';
        finding: NormalizedReviewFindingInventoryEntry;
    }
    | {
        kind: 'residual_risk';
        residual_risk: NormalizedReviewResidualRiskInventoryEntry;
    };

interface SourceInventoryIndex {
    findings: Map<string, NormalizedReviewFindingInventoryEntry>;
    residual_risks: Map<string, NormalizedReviewResidualRiskInventoryEntry>;
}

type ReviewFindingSeverity = typeof REVIEW_FINDING_SEVERITIES[number];

interface FollowUpObligation {
    disposition_item: ReviewFindingsDispositionArtifactItem;
    source_inventory: SourceInventoryEntry;
    title: string;
    description: string;
    evidence_locations: string[];
    remediation: string;
    fingerprint: string;
}

interface MaterializedTaskReference {
    task_id: string;
    fingerprint: string;
}

interface TaskQueueMaterializationResult {
    outcome:
        | 'updated'
        | 'already_materialized'
        | 'not_required'
        | 'task_file_missing'
        | 'task_not_found'
        | 'write_failed';
    task_path: string;
    created: MaterializedTaskReference[];
    reused: MaterializedTaskReference[];
    blocked_fingerprints: string[];
    error_message: string | null;
    rollback_content: string | null;
}

export interface ReviewFindingsFollowUpTaskMaterializationItem {
    source_item_id: string;
    source_item_kind: ReviewFindingsDispositionArtifactItem['kind'];
    severity: ReviewFindingsDispositionArtifactItem['severity'];
    action: ReviewFindingsDispositionArtifactItem['action'];
    source_rule: string;
    source_policy: string;
    blocking: boolean;
    fingerprint: string | null;
    materialization_status: ReviewFindingFollowUpItemStatus;
    task_id: string | null;
    title: string | null;
    description: string | null;
    evidence_locations: string[];
    remediation: string | null;
}

export interface ReviewFindingsFollowUpTasksArtifact {
    schema_version: typeof REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION;
    artifact_type: typeof REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE;
    task_id: string;
    review_type: string;
    status: ReviewFollowUpMaterializationStatus;
    created_at_utc: string;
    source_disposition: {
        artifact_path: string;
        artifact_sha256: string | null;
        disposition_result_sha256: string | null;
    };
    source_validation: {
        artifact_path: string | null;
        artifact_sha256: string | null;
        validation_result_sha256: string | null;
        status: 'accepted' | 'rejected' | 'unknown';
        accepted: boolean | null;
    };
    source_receipt: {
        receipt_path: string | null;
        receipt_sha256: string | null;
    };
    items: ReviewFindingsFollowUpTaskMaterializationItem[];
    summary: {
        item_count: number;
        follow_up_obligation_count: number;
        created_task_count: number;
        reused_task_count: number;
        blocked_task_count: number;
        not_required_count: number;
    };
    violations: string[];
}

export interface ReviewFindingsFollowUpTaskMaterializationResult {
    status: ReviewFollowUpMaterializationStatus;
    task_id: string;
    review_type: string;
    artifact_path: string;
    created_task_ids: string[];
    reused_task_ids: string[];
    violations: string[];
    output_lines: string[];
}

export interface MaterializeReviewFindingsFollowUpTasksOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    dispositionArtifactPath?: string | null;
    receiptPath?: string | null;
    artifactPath?: string | null;
    reviewsRoot?: string | null;
}

function nowIso(): string {
    return new Date().toISOString();
}

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function normalizeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function assertReviewTypeToken(value: unknown): string {
    const reviewType = normalizeText(value).toLowerCase();
    if (!reviewType) {
        throw new Error('ReviewType must not be empty.');
    }
    if (reviewType.length > REVIEW_TYPE_MAX_LENGTH) {
        throw new Error(`ReviewType must be ${REVIEW_TYPE_MAX_LENGTH} characters or fewer.`);
    }
    if (!REVIEW_TYPE_TOKEN_PATTERN.test(reviewType)) {
        throw new Error('ReviewType must be a file-safe token matching <letter>[a-z0-9_-]*.');
    }
    return reviewType;
}

function isReviewTypeToken(value: unknown): boolean {
    try {
        assertReviewTypeToken(value);
        return true;
    } catch {
        return false;
    }
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function tryWriteJson(filePath: string, value: unknown, label: string): string | null {
    try {
        writeJson(filePath, value);
        return null;
    } catch (error: unknown) {
        return `${label} write failed: ${errorMessage(error)}.`;
    }
}

function readJsonFile(filePath: string, label: string): { value: Record<string, unknown> | null; violations: string[] } {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
            value: null,
            violations: [`${label} is missing: ${normalizePath(filePath)}.`]
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return {
                value: null,
                violations: [`${label} must contain a JSON object: ${normalizePath(filePath)}.`]
            };
        }
        return { value: parsed, violations: [] };
    } catch {
        return {
            value: null,
            violations: [`${label} is not valid JSON: ${normalizePath(filePath)}.`]
        };
    }
}

function resolveInputPathInsideRepo(repoRoot: string, inputPath: string, label: string): string {
    const rawPath = String(inputPath || '').trim();
    if (!rawPath) {
        throw new Error(`${label} must not be empty.`);
    }
    const resolved = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(repoRoot, rawPath);
    const root = path.resolve(repoRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`${label} escapes repo root: ${inputPath}`);
    }
    return resolved;
}

function resolveFollowUpArtifactPath(repoRoot: string, reviewsRoot: string, inputPath: string): string {
    const resolved = resolveInputPathInsideRepo(repoRoot, inputPath, 'ArtifactPath');
    const root = path.resolve(reviewsRoot);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
        throw new Error(`ArtifactPath must stay inside reviews root: ${inputPath}`);
    }
    if (!path.basename(resolved).endsWith('-follow-ups.json')) {
        throw new Error('ArtifactPath must be a follow-up JSON artifact path ending in -follow-ups.json.');
    }
    return resolved;
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleNameForTarget(repoRoot));
}

function buildNextStepCommand(repoRoot: string, taskId: string): string {
    return `${buildCliPrefix(repoRoot)} next-step "${taskId}" --repo-root "."`;
}

function formatOutput(params: {
    repoRoot: string;
    taskId: string;
    status: ReviewFollowUpMaterializationStatus;
    marker: string;
    action: string;
    reason?: string | null;
    artifactPath: string;
    violations: readonly string[];
}): string[] {
    const blocked = params.status === 'BLOCKED';
    return [
        ...buildOperatorNextActionBlock({
            status: params.status,
            gate: 'review-findings-follow-up-tasks',
            action: params.action,
            reason: params.reason,
            command: blocked ? null : buildNextStepCommand(params.repoRoot, params.taskId),
            commandReference: blocked ? 'resolve blockers listed in details before retrying materialization' : null,
            detailsPath: params.artifactPath,
            detailsHint: blocked ? `${params.violations.length} blocker(s) recorded in the materialization artifact.` : null
        }),
        '',
        params.marker,
        `ArtifactPath: ${normalizePath(params.artifactPath)}`,
        ...(params.violations.length > 0
            ? ['Violations:', ...params.violations.map((violation) => `- ${violation}`)]
            : [])
    ];
}

function getFallbackArtifactPath(repoRoot: string, taskId: string, reviewType: string): string {
    const safeTaskId = isCanonicalTaskId(taskId) ? normalizeText(taskId) : 'UNKNOWN-TASK';
    const safeReviewType = isReviewTypeToken(reviewType) ? assertReviewTypeToken(reviewType) : 'unknown-review';
    return joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${safeTaskId}-${safeReviewType}-findings-follow-ups.json`)
    );
}

export function getReviewFindingsFollowUpTasksArtifactPath(dispositionArtifactPath: string): string {
    const normalized = String(dispositionArtifactPath || '').trim();
    if (/-findings-disposition\.json$/u.test(normalized)) {
        return normalized.replace(/-findings-disposition\.json$/u, '-findings-follow-ups.json');
    }
    return normalized.replace(/\.json$/u, '-follow-ups.json');
}

function parseDispositionArtifact(value: Record<string, unknown>): ReviewFindingsDispositionArtifact | null {
    if (
        value.schema_version !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_SCHEMA_VERSION
        || value.artifact_type !== REVIEW_FINDINGS_DISPOSITION_ARTIFACT_TYPE
        || !isPlainRecord(value.source_validation)
        || !Array.isArray(value.items)
        || !value.items.every((item) => isPlainRecord(item))
        || !isPlainRecord(value.policy)
        || !isPlainRecord(value.disposition_result)
        || typeof value.disposition_result_sha256 !== 'string'
    ) {
        return null;
    }
    return value as unknown as ReviewFindingsDispositionArtifact;
}

function isReviewFindingSeverity(value: unknown): value is ReviewFindingSeverity {
    return typeof value === 'string' && (REVIEW_FINDING_SEVERITIES as readonly string[]).includes(value);
}

function expectedSourceRuleForItem(item: ReviewFindingsDispositionArtifactItem): string | null {
    if (item.kind === 'residual_risk') {
        return 'review_finding_policy.residual_risk';
    }
    if (isReviewFindingSeverity(item.severity)) {
        return `review_finding_policy.findings.${item.severity}`;
    }
    return null;
}

function expectedMaterializationStatusForAction(action: unknown): string | null {
    if (action === 'fix_now') {
        return 'requires_fix_now';
    }
    if (action === 'create_follow_up') {
        return 'pending_follow_up_materialization';
    }
    if (action === 'ignore') {
        return 'audited_ignored';
    }
    return null;
}

function dispositionBucketActionForId(bucket: unknown, id: string): string | null {
    if (!isPlainRecord(bucket) || typeof bucket.action !== 'string' || !Array.isArray(bucket.ids)) {
        return null;
    }
    return bucket.ids.includes(id) ? bucket.action : null;
}

function dispositionResultActionForItem(
    artifact: ReviewFindingsDispositionArtifact,
    item: ReviewFindingsDispositionArtifactItem
): string | null {
    const result = artifact.disposition_result as unknown as Record<string, unknown>;
    if (item.kind === 'residual_risk') {
        return dispositionBucketActionForId(result.residual_risks, item.id);
    }
    if (!isReviewFindingSeverity(item.severity) || !isPlainRecord(result.findings)) {
        return null;
    }
    return dispositionBucketActionForId(result.findings[item.severity], item.id);
}

function dispositionItemKey(kind: ReviewFindingsDispositionArtifactItem['kind'], severity: string, id: string): string {
    return `${kind}:${severity}:${id}`;
}

function dispositionResultItemKeys(artifact: ReviewFindingsDispositionArtifact): Array<{
    key: string;
    path: string;
    id: string;
}> {
    const result = artifact.disposition_result as unknown as Record<string, unknown>;
    const keys: Array<{ key: string; path: string; id: string }> = [];
    const findings = isPlainRecord(result.findings) ? result.findings : {};
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        const bucket = findings[severity];
        if (!isPlainRecord(bucket) || !Array.isArray(bucket.ids)) {
            continue;
        }
        for (const rawId of bucket.ids) {
            const id = normalizeText(rawId);
            if (!id) {
                continue;
            }
            keys.push({
                key: dispositionItemKey('finding', severity, id),
                path: `disposition_result.findings.${severity}`,
                id
            });
        }
    }

    const residualRiskBucket = result.residual_risks;
    if (isPlainRecord(residualRiskBucket) && Array.isArray(residualRiskBucket.ids)) {
        for (const rawId of residualRiskBucket.ids) {
            const id = normalizeText(rawId);
            if (!id) {
                continue;
            }
            keys.push({
                key: dispositionItemKey('residual_risk', 'residual_risk', id),
                path: 'disposition_result.residual_risks',
                id
            });
        }
    }

    return keys;
}

function validateDispositionArtifactShape(params: {
    artifact: ReviewFindingsDispositionArtifact;
    artifactPath: string;
    taskId: string;
    reviewType: string;
}): string[] {
    const { artifact, artifactPath, taskId, reviewType } = params;
    const violations: string[] = [];
    if (artifact.task_id !== taskId) {
        violations.push(
            `Review findings disposition artifact task_id mismatch: expected ${taskId}, found ${artifact.task_id || 'missing'}.`
        );
    }
    if (artifact.review_type !== reviewType) {
        violations.push(
            `Review findings disposition artifact review_type mismatch: expected ${reviewType}, found ${artifact.review_type || 'missing'}.`
        );
    }
    if (artifact.derivation_source !== 'garda_locked_policy_evaluation') {
        violations.push('Review findings disposition artifact derivation_source must be garda_locked_policy_evaluation.');
    }
    const sourceValidation = artifact.source_validation;
    if (sourceValidation.status !== 'accepted' || sourceValidation.accepted !== true) {
        violations.push('Review findings disposition artifact must be bound to an accepted system validation artifact.');
    }
    if (!sourceValidation.artifact_path) {
        violations.push('Review findings disposition artifact source_validation.artifact_path is missing.');
    }
    if (!normalizeHash(sourceValidation.artifact_sha256)) {
        violations.push('Review findings disposition artifact source_validation.artifact_sha256 is missing or invalid.');
    }
    if (!normalizeHash(sourceValidation.validation_result_sha256)) {
        violations.push('Review findings disposition artifact source_validation.validation_result_sha256 is missing or invalid.');
    }
    const actualDispositionResultSha256 = sha256JsonPayload(artifact.disposition_result);
    if (artifact.disposition_result_sha256 !== actualDispositionResultSha256) {
        violations.push(
            `Review findings disposition artifact '${normalizePath(artifactPath)}' disposition_result_sha256 mismatch: ` +
            `expected ${actualDispositionResultSha256}, found ${artifact.disposition_result_sha256 || 'missing'}.`
        );
    }
    const artifactPolicySource = normalizeText(artifact.policy.policy_source);
    if (!artifactPolicySource) {
        violations.push('Review findings disposition artifact policy.policy_source is missing.');
    }
    const dispositionItemKeys = new Set<string>();
    for (const item of artifact.items) {
        const itemId = normalizeText(item.id);
        if (!itemId) {
            violations.push('Review findings disposition item is missing id.');
        }
        if (item.kind !== 'finding' && item.kind !== 'residual_risk') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid kind.`);
        }
        if (item.kind === 'finding' && !isReviewFindingSeverity(item.severity)) {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid finding severity.`);
        }
        if (item.kind === 'residual_risk' && item.severity !== 'residual_risk') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' residual risk severity must be residual_risk.`);
        }
        if (item.action !== 'fix_now' && item.action !== 'create_follow_up' && item.action !== 'ignore') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' has invalid action.`);
        }
        const dispositionResultAction = dispositionResultActionForItem(artifact, item);
        if (!dispositionResultAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' is not present in disposition_result.`
            );
        } else if (item.action !== dispositionResultAction) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' action '${item.action}' does not match ` +
                `disposition_result action '${dispositionResultAction}'.`
            );
        }
        const expectedSourceRule = expectedSourceRuleForItem(item);
        if (!expectedSourceRule || normalizeText(item.source_rule) !== expectedSourceRule) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' source_rule must be ` +
                `${expectedSourceRule || 'valid for its kind and severity'}.`
            );
        }
        if (normalizeText(item.policy_source) !== artifactPolicySource) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' policy_source must match the disposition artifact policy_source.`
            );
        }
        const expectedBlocking = item.action === 'fix_now';
        if (typeof item.blocking !== 'boolean') {
            violations.push(`Review findings disposition item '${item.id || 'missing'}' blocking flag must be boolean.`);
        } else if (item.blocking !== expectedBlocking) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' blocking flag does not match action '${item.action}'.`
            );
        }
        const key = item.kind === 'residual_risk'
            ? dispositionItemKey('residual_risk', 'residual_risk', itemId)
            : isReviewFindingSeverity(item.severity)
                ? dispositionItemKey('finding', item.severity, itemId)
                : null;
        if (key) {
            if (dispositionItemKeys.has(key)) {
                violations.push(`Review findings disposition item '${item.id || 'missing'}' is duplicated.`);
            }
            dispositionItemKeys.add(key);
        }
        const expectedMaterializationStatus = expectedMaterializationStatusForAction(item.action);
        if (expectedMaterializationStatus && item.materialization_status !== expectedMaterializationStatus) {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' materialization_status must be ` +
                `${expectedMaterializationStatus} for action '${item.action}'.`
            );
        }
        if (item.audit_status !== 'retained_in_disposition_artifact') {
            violations.push(
                `Review findings disposition item '${item.id || 'missing'}' audit_status must be retained_in_disposition_artifact.`
            );
        }
    }
    for (const resultItem of dispositionResultItemKeys(artifact)) {
        if (!dispositionItemKeys.has(resultItem.key)) {
            violations.push(
                `Review findings ${resultItem.path} id '${resultItem.id}' is missing a matching disposition item.`
            );
        }
    }
    return violations;
}

function validateValidationInventoryShape(artifact: ReviewFindingsValidationArtifact): string[] {
    const violations: string[] = [];
    const inventory = artifact.validation_result.normalized_inventory as unknown;
    if (!isPlainRecord(inventory)) {
        return ['Review findings validation artifact normalized_inventory must be an object.'];
    }
    if (!isPlainRecord(inventory.findings_by_severity)) {
        violations.push('Review findings validation artifact normalized_inventory.findings_by_severity must be an object.');
    } else {
        const seenFindingIds = new Set<string>();
        for (const severity of REVIEW_FINDING_SEVERITIES) {
            const bucket = inventory.findings_by_severity[severity];
            if (!Array.isArray(bucket)) {
                violations.push(
                    `Review findings validation artifact normalized_inventory.findings_by_severity.${severity} must be an array.`
                );
                continue;
            }
            bucket.forEach((entry, index) => {
                if (!isPlainRecord(entry)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} must be an object.`
                    );
                    return;
                }
                const id = normalizeText(entry.id);
                if (!id) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing id.`
                    );
                } else {
                    if (seenFindingIds.has(id)) {
                        violations.push(
                            `Review findings validation artifact duplicate finding inventory id '${id}' for severity '${severity}'.`
                        );
                    }
                    seenFindingIds.add(id);
                }
                if (entry.severity !== severity) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} has mismatched severity.`
                    );
                }
                if (!normalizeText(entry.title)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing title.`
                    );
                }
                if (!normalizeText(entry.description)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} is missing description.`
                    );
                }
                if (!Array.isArray(entry.evidence_locations)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} evidence_locations must be an array.`
                    );
                }
                if (!Array.isArray(entry.coverage_obligation_ids)) {
                    violations.push(
                        `Review findings validation artifact ${severity} finding inventory entry ${index} coverage_obligation_ids must be an array.`
                    );
                }
            });
        }
    }
    if (!Array.isArray(inventory.residual_risks)) {
        violations.push('Review findings validation artifact normalized_inventory.residual_risks must be an array.');
    } else {
        const seenResidualRiskIds = new Set<string>();
        inventory.residual_risks.forEach((entry, index) => {
            if (!isPlainRecord(entry)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} must be an object.`
                );
                return;
            }
            const id = normalizeText(entry.id);
            if (!id) {
                violations.push(`Review findings validation artifact residual risk inventory entry ${index} is missing id.`);
            } else {
                if (seenResidualRiskIds.has(id)) {
                    violations.push(
                        `Review findings validation artifact duplicate residual risk inventory id '${id}'.`
                    );
                }
                seenResidualRiskIds.add(id);
            }
            if (!normalizeText(entry.description)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} is missing description.`
                );
            }
            if (!Array.isArray(entry.evidence_locations)) {
                violations.push(
                    `Review findings validation artifact residual risk inventory entry ${index} evidence_locations must be an array.`
                );
            }
        });
    }
    return violations;
}

function sourceFindingIndexKey(id: string, severity: string): string {
    return `${severity}\0${id}`;
}

function buildSourceInventoryIndex(artifact: ReviewFindingsValidationArtifact): SourceInventoryIndex {
    const findings = new Map<string, NormalizedReviewFindingInventoryEntry>();
    const findingsBySeverity = artifact.validation_result.normalized_inventory.findings_by_severity;
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of findingsBySeverity[severity]) {
            findings.set(sourceFindingIndexKey(finding.id, finding.severity), finding);
        }
    }

    const residualRisks = new Map<string, NormalizedReviewResidualRiskInventoryEntry>();
    for (const residualRisk of artifact.validation_result.normalized_inventory.residual_risks) {
        residualRisks.set(residualRisk.id, residualRisk);
    }

    return {
        findings,
        residual_risks: residualRisks
    };
}

function findSourceInventoryEntry(
    index: SourceInventoryIndex,
    item: ReviewFindingsDispositionArtifactItem
): SourceInventoryEntry | null {
    if (item.kind === 'finding') {
        const finding = index.findings.get(sourceFindingIndexKey(item.id, item.severity));
        return finding ? { kind: 'finding', finding } : null;
    }
    const residualRisk = index.residual_risks.get(item.id);
    return residualRisk ? { kind: 'residual_risk', residual_risk: residualRisk } : null;
}

function sourceTitle(entry: SourceInventoryEntry): string {
    if (entry.kind === 'finding') {
        return entry.finding.title;
    }
    return entry.residual_risk.description.split(/[.?!]\s/u)[0] || entry.residual_risk.description;
}

function sourceDescription(entry: SourceInventoryEntry): string {
    return entry.kind === 'finding'
        ? entry.finding.description
        : entry.residual_risk.description;
}

function sourceEvidenceLocations(entry: SourceInventoryEntry): string[] {
    return entry.kind === 'finding'
        ? [...entry.finding.evidence_locations]
        : [...entry.residual_risk.evidence_locations];
}

function buildRemediationText(item: ReviewFindingsDispositionArtifactItem): string {
    const severity = item.severity === 'residual_risk'
        ? 'residual risk'
        : `${item.severity} finding`;
    return `Address accepted ${severity} ${item.id} according to ${item.source_rule}; keep validation and receipt hashes in the follow-up notes.`;
}

function buildFingerprint(params: {
    taskId: string;
    reviewType: string;
    item: ReviewFindingsDispositionArtifactItem;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
}): string {
    return sha256JsonPayload({
        schema_version: 1,
        parent_task_id: params.taskId,
        review_type: params.reviewType,
        item_id: params.item.id,
        item_kind: params.item.kind,
        severity: params.item.severity,
        action: params.item.action,
        source_rule: params.item.source_rule,
        validation_artifact_sha256: params.validationArtifactSha256,
        validation_result_sha256: params.validationResultSha256,
        disposition_artifact_sha256: params.dispositionArtifactSha256,
        disposition_result_sha256: params.dispositionResultSha256
    });
}

function buildObligations(params: {
    taskId: string;
    reviewType: string;
    disposition: ReviewFindingsDispositionArtifact;
    validation: ReviewFindingsValidationArtifact;
    dispositionArtifactSha256: string;
}): { obligations: FollowUpObligation[]; items: ReviewFindingsFollowUpTaskMaterializationItem[]; violations: string[] } {
    const obligations: FollowUpObligation[] = [];
    const items: ReviewFindingsFollowUpTaskMaterializationItem[] = [];
    const violations: string[] = [];
    const validationArtifactSha256 = params.disposition.source_validation.artifact_sha256;
    const validationResultSha256 = params.disposition.source_validation.validation_result_sha256;
    const sourceInventoryIndex = buildSourceInventoryIndex(params.validation);

    for (const item of params.disposition.items) {
        const sourceInventory = findSourceInventoryEntry(sourceInventoryIndex, item);
        if (!sourceInventory) {
            violations.push(
                `Review findings disposition item '${item.id}' is not present in the accepted validation inventory.`
            );
            items.push(buildArtifactItem({
                item,
                status: blockedStatusForDispositionItem(item),
                taskId: null,
                fingerprint: null,
                title: null,
                description: null,
                evidenceLocations: [],
                remediation: null
            }));
            continue;
        }

        const title = sourceTitle(sourceInventory);
        const description = sourceDescription(sourceInventory);
        const evidenceLocations = sourceEvidenceLocations(sourceInventory);
        const remediation = buildRemediationText(item);
        const fingerprint = buildFingerprint({
            taskId: params.taskId,
            reviewType: params.reviewType,
            item,
            validationArtifactSha256,
            validationResultSha256,
            dispositionArtifactSha256: params.dispositionArtifactSha256,
            dispositionResultSha256: params.disposition.disposition_result_sha256
        });

        if (item.action === 'create_follow_up') {
            obligations.push({
                disposition_item: item,
                source_inventory: sourceInventory,
                title,
                description,
                evidence_locations: evidenceLocations,
                remediation,
                fingerprint
            });
            continue;
        }

        items.push(buildArtifactItem({
            item,
            status: materializationStatusForNonFollowUpItem(item),
            taskId: null,
            fingerprint,
            title,
            description,
            evidenceLocations,
            remediation
        }));
    }

    return { obligations, items, violations };
}

function materializationStatusForNonFollowUpItem(
    item: ReviewFindingsDispositionArtifactItem
): ReviewFindingFollowUpItemStatus {
    return item.action === 'fix_now' ? 'requires_fix_now' : 'not_required';
}

function blockedStatusForDispositionItem(
    item: ReviewFindingsDispositionArtifactItem
): ReviewFindingFollowUpItemStatus {
    return item.action === 'create_follow_up'
        ? 'blocked'
        : materializationStatusForNonFollowUpItem(item);
}

function buildArtifactItem(params: {
    item: ReviewFindingsDispositionArtifactItem;
    status: ReviewFindingFollowUpItemStatus;
    taskId: string | null;
    fingerprint: string | null;
    title: string | null;
    description: string | null;
    evidenceLocations: readonly string[];
    remediation: string | null;
}): ReviewFindingsFollowUpTaskMaterializationItem {
    return {
        source_item_id: params.item.id,
        source_item_kind: params.item.kind,
        severity: params.item.severity,
        action: params.item.action,
        source_rule: params.item.source_rule,
        source_policy: params.item.policy_source,
        blocking: params.item.blocking,
        fingerprint: params.fingerprint,
        materialization_status: params.status,
        task_id: params.taskId,
        title: params.title,
        description: params.description,
        evidence_locations: [...params.evidenceLocations],
        remediation: params.remediation
    };
}

function sanitizeTaskCell(value: unknown, fallback: string, maxLength = 180): string {
    const text = String(value || '').trim() || fallback;
    const compact = text
        .replace(/[\u0000-\u001F\u007F]/gu, ' ')
        .replace(/\|/gu, '/')
        .replace(/\s+/gu, ' ')
        .trim();
    if (compact.length <= maxLength) {
        return compact;
    }
    return `${compact.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function priorityForSeverity(severity: ReviewFindingsDispositionArtifactItem['severity'], fallback: string): string {
    if (severity === 'critical' || severity === 'high') {
        return 'P1';
    }
    if (severity === 'medium' || severity === 'residual_risk') {
        return 'P2';
    }
    if (severity === 'low') {
        return 'P3';
    }
    return fallback || 'P2';
}

function evidenceNote(evidenceLocations: readonly string[]): string {
    const firstLocations = evidenceLocations.slice(0, 3).map((entry) => sanitizeTaskCell(entry, 'unknown evidence', 80));
    if (firstLocations.length === 0) {
        return 'none recorded';
    }
    const suffix = evidenceLocations.length > firstLocations.length
        ? `, +${evidenceLocations.length - firstLocations.length} more`
        : '';
    return `${firstLocations.join(', ')}${suffix}`;
}

function buildTaskTitle(reviewType: string, obligation: FollowUpObligation): string {
    const severity = obligation.disposition_item.severity === 'residual_risk'
        ? 'residual risk'
        : obligation.disposition_item.severity;
    return sanitizeTaskCell(
        `[${reviewType}] Follow up ${severity} ${obligation.disposition_item.id}: ${obligation.title}`,
        `Follow up ${reviewType} review finding ${obligation.disposition_item.id}`,
        140
    );
}

function buildTaskNotes(params: {
    parentTaskId: string;
    reviewType: string;
    obligation: FollowUpObligation;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
}): string {
    const item = params.obligation.disposition_item;
    return sanitizeTaskCell([
        `Child of \`${params.parentTaskId}\`.`,
        `Follow-up from accepted \`${params.reviewType}\` ${item.kind} \`${item.id}\` severity \`${item.severity}\`.`,
        `Evidence: ${evidenceNote(params.obligation.evidence_locations)}.`,
        `Remediation: ${params.obligation.remediation}`,
        `validation_sha256=${params.validationArtifactSha256};`,
        `validation_result_sha256=${params.validationResultSha256};`,
        `receipt_sha256=${params.receiptSha256};`,
        `disposition_sha256=${params.dispositionArtifactSha256};`,
        `disposition_result_sha256=${params.dispositionResultSha256};`,
        `review_follow_up_fingerprint=${params.obligation.fingerprint}.`
    ].join(' '), 'Review follow-up task.', 1200);
}

function extractExistingFingerprint(notes: string): string | null {
    return normalizeHash(String(notes || '').match(/review_follow_up_fingerprint=([0-9a-f]{64})/iu)?.[1] || null);
}

function isParentFollowUpTaskId(parentTaskId: string, taskId: string): boolean {
    const prefix = `${parentTaskId}-F`;
    if (!taskId.startsWith(prefix)) {
        return false;
    }
    return /^[1-9][0-9]*$/u.test(taskId.slice(prefix.length));
}

function appendParentFollowUpNote(existingNotes: string, childTaskIds: readonly string[], artifactPath: string): string {
    const newTaskIds = childTaskIds.filter((taskId) => !existingNotes.includes(taskId));
    if (newTaskIds.length === 0) {
        return existingNotes;
    }
    const suffix = `Review follow-up tasks materialized: ${newTaskIds.map((taskId) => `\`${taskId}\``).join(', ')}; artifact \`${normalizePath(artifactPath)}\`.`;
    return existingNotes.trim() ? `${existingNotes.trim()} ${suffix}` : suffix;
}

function findInsertionLineIndex(parentRow: CanonicalActiveTaskQueueRow, rows: readonly CanonicalActiveTaskQueueRow[]): number {
    const prefix = `${parentRow.taskId}-F`.toLowerCase();
    return rows.reduce((lineIndex, row) => {
        if (row.taskId.toLowerCase().startsWith(prefix)) {
            return Math.max(lineIndex, row.lineIndex);
        }
        return lineIndex;
    }, parentRow.lineIndex);
}

function materializeTaskQueueRows(params: {
    repoRoot: string;
    parentTaskId: string;
    reviewType: string;
    artifactPath: string;
    obligations: readonly FollowUpObligation[];
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
}): TaskQueueMaterializationResult {
    const taskPath = path.join(params.repoRoot, 'TASK.md');
    if (params.obligations.length === 0) {
        return {
            outcome: 'not_required',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: [],
            error_message: null,
            rollback_content: null
        };
    }
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
            error_message: null,
            rollback_content: null
        };
    }

    return withTaskQueueStatusSyncLock<TaskQueueMaterializationResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            created: [],
            reused: [],
            blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
            error_message: message,
            rollback_content: null
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const parsed = parseCanonicalActiveTaskQueue(original);
            if (!parsed.found) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                    error_message: parsed.unavailableReason || 'Canonical Active Queue table not found.',
                    rollback_content: null
                };
            }
            const parentRow = parsed.rows.find((row) => row.taskId === params.parentTaskId);
            if (!parentRow) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    created: [],
                    reused: [],
                    blocked_fingerprints: params.obligations.map((obligation) => obligation.fingerprint),
                    error_message: null,
                    rollback_content: null
                };
            }

            const existingByFingerprint = new Map<string, string>();
            for (const row of parsed.rows) {
                if (!isParentFollowUpTaskId(params.parentTaskId, row.taskId)) {
                    continue;
                }
                const fingerprint = extractExistingFingerprint(row.notes);
                if (fingerprint) {
                    existingByFingerprint.set(fingerprint, row.taskId);
                }
            }

            const reused: MaterializedTaskReference[] = [];
            const toCreate: FollowUpObligation[] = [];
            for (const obligation of params.obligations) {
                const existingTaskId = existingByFingerprint.get(obligation.fingerprint);
                if (existingTaskId) {
                    reused.push({
                        task_id: existingTaskId,
                        fingerprint: obligation.fingerprint
                    });
                    continue;
                }
                toCreate.push(obligation);
            }

            const allocatedTaskIds = allocateParentDerivedTaskIds({
                parentTaskId: params.parentTaskId,
                existingTaskIds: parsed.rows.map((row) => row.taskId),
                kind: 'followup',
                count: toCreate.length
            });
            const created: MaterializedTaskReference[] = [];
            const today = nowIso().slice(0, 10);
            const insertedRows = toCreate.map((obligation, index) => {
                const taskId = allocatedTaskIds[index];
                created.push({
                    task_id: taskId,
                    fingerprint: obligation.fingerprint
                });
                const row = [
                    taskId,
                    'TODO',
                    priorityForSeverity(obligation.disposition_item.severity, parentRow.priority),
                    sanitizeTaskCell(parentRow.area, 'workflow/review-follow-up-tasks', 80),
                    buildTaskTitle(params.reviewType, obligation),
                    sanitizeTaskCell(parentRow.owner, 'gpt-5.5', 80),
                    today,
                    sanitizeTaskCell(parentRow.profile, 'balanced', 40),
                    buildTaskNotes({
                        parentTaskId: params.parentTaskId,
                        reviewType: params.reviewType,
                        obligation,
                        validationArtifactSha256: params.validationArtifactSha256,
                        validationResultSha256: params.validationResultSha256,
                        dispositionArtifactSha256: params.dispositionArtifactSha256,
                        dispositionResultSha256: params.dispositionResultSha256,
                        receiptSha256: params.receiptSha256
                    })
                ];
                return `| ${row.join(' | ')} |`;
            });

            if (created.length > 0) {
                const nextParentNotes = appendParentFollowUpNote(
                    parentRow.notes,
                    created.map((item) => item.task_id),
                    params.artifactPath
                );
                const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextParentNotes} `);
                if (!updatedParentLine) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        created: [],
                        reused,
                        blocked_fingerprints: toCreate.map((obligation) => obligation.fingerprint),
                        error_message: 'Failed to replace TASK.md parent notes cell.',
                        rollback_content: null
                    };
                }
                lines[parentRow.lineIndex] = updatedParentLine;
                const insertionLineIndex = findInsertionLineIndex(parentRow, parsed.rows);
                lines.splice(insertionLineIndex + 1, 0, ...insertedRows);
            }

            const nextContent = formatActiveTaskQueueTable(lines.join(newline));
            if (nextContent !== original) {
                fs.writeFileSync(taskPath, nextContent, 'utf8');
            }

            return {
                outcome: created.length > 0 ? 'updated' : 'already_materialized',
                task_path: normalizePath(taskPath),
                created,
                reused,
                blocked_fingerprints: [],
                error_message: null,
                rollback_content: nextContent !== original ? original : null
            };
        }
    );
}

function rollbackTaskQueueRows(taskPath: string, rollbackContent: string | null): string | null {
    if (rollbackContent === null) {
        return null;
    }
    return withTaskQueueStatusSyncLock<string | null>(
        taskPath,
        (message) => `TASK.md rollback failed after follow-up artifact write failure: ${message}.`,
        () => {
            fs.writeFileSync(taskPath, rollbackContent, 'utf8');
            return null;
        }
    );
}

function buildMaterializationItems(params: {
    baseItems: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    obligations: readonly FollowUpObligation[];
    queueResult: TaskQueueMaterializationResult | null;
}): ReviewFindingsFollowUpTaskMaterializationItem[] {
    const created = new Map((params.queueResult?.created || []).map((item) => [item.fingerprint, item.task_id]));
    const reused = new Map((params.queueResult?.reused || []).map((item) => [item.fingerprint, item.task_id]));
    const blockedFingerprints = new Set(params.queueResult?.blocked_fingerprints || []);
    const obligationItems = params.obligations.map((obligation) => {
        const taskId = created.get(obligation.fingerprint) || reused.get(obligation.fingerprint) || null;
        const status: ReviewFindingFollowUpItemStatus = created.has(obligation.fingerprint)
            ? 'created'
            : (reused.has(obligation.fingerprint)
                ? 'already_materialized'
                : (blockedFingerprints.has(obligation.fingerprint) ? 'blocked' : 'blocked'));
        return buildArtifactItem({
            item: obligation.disposition_item,
            status,
            taskId,
            fingerprint: obligation.fingerprint,
            title: obligation.title,
            description: obligation.description,
            evidenceLocations: obligation.evidence_locations,
            remediation: obligation.remediation
        });
    });
    return [...params.baseItems, ...obligationItems].sort((left, right) => (
        `${left.source_item_kind}:${left.source_item_id}`.localeCompare(`${right.source_item_kind}:${right.source_item_id}`)
    ));
}

function toValidationStatus(artifact: ReviewFindingsValidationArtifact | null): 'accepted' | 'rejected' | 'unknown' {
    if (!artifact) {
        return 'unknown';
    }
    return artifact.validation_result.status;
}

function buildArtifact(params: {
    taskId: string;
    reviewType: string;
    status: ReviewFollowUpMaterializationStatus;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
    validationArtifactPath: string | null;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTasksArtifact {
    const createdTaskCount = params.items.filter((item) => item.materialization_status === 'created').length;
    const reusedTaskCount = params.items.filter((item) => item.materialization_status === 'already_materialized').length;
    const blockedTaskCount = params.items.filter((item) => (
        item.materialization_status === 'blocked'
        || item.materialization_status === 'requires_fix_now'
    )).length;
    const notRequiredCount = params.items.filter((item) => item.materialization_status === 'not_required').length;
    return {
        schema_version: REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_SCHEMA_VERSION,
        artifact_type: REVIEW_FINDINGS_FOLLOW_UP_TASKS_ARTIFACT_TYPE,
        task_id: params.taskId,
        review_type: params.reviewType,
        status: params.status,
        created_at_utc: nowIso(),
        source_disposition: {
            artifact_path: normalizePath(params.dispositionArtifactPath),
            artifact_sha256: params.dispositionArtifactSha256,
            disposition_result_sha256: params.dispositionResultSha256
        },
        source_validation: {
            artifact_path: params.validationArtifactPath ? normalizePath(params.validationArtifactPath) : null,
            artifact_sha256: params.validationArtifactSha256,
            validation_result_sha256: params.validationResultSha256,
            status: toValidationStatus(params.validationArtifact),
            accepted: params.validationArtifact ? params.validationArtifact.validation_result.accepted : null
        },
        source_receipt: {
            receipt_path: params.receiptPath ? normalizePath(params.receiptPath) : null,
            receipt_sha256: params.receiptSha256
        },
        items: [...params.items],
        summary: {
            item_count: params.items.length,
            follow_up_obligation_count: params.items.filter((item) => item.action === 'create_follow_up').length,
            created_task_count: createdTaskCount,
            reused_task_count: reusedTaskCount,
            blocked_task_count: blockedTaskCount,
            not_required_count: notRequiredCount
        },
        violations: [...params.violations]
    };
}

function deriveReceiptPath(params: {
    repoRoot: string;
    explicitReceiptPath?: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    dispositionArtifactPath: string;
}): string | null {
    if (params.explicitReceiptPath) {
        return resolveInputPathInsideRepo(params.repoRoot, params.explicitReceiptPath, 'ReceiptPath');
    }
    const reviewArtifactPath = normalizeText(
        params.validationArtifact?.validation_result.bindings.output.review_artifact_path || ''
    );
    if (reviewArtifactPath && /\.md$/u.test(reviewArtifactPath)) {
        return resolveInputPathInsideRepo(params.repoRoot, reviewArtifactPath, 'ReviewArtifactPath')
            .replace(/\.md$/u, '-receipt.json');
    }
    if (/-findings-disposition\.json$/u.test(params.dispositionArtifactPath)) {
        return params.dispositionArtifactPath.replace(/-findings-disposition\.json$/u, '-receipt.json');
    }
    return null;
}

function hasFixNowMaterializationItems(
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[]
): boolean {
    return items.some((item) => item.materialization_status === 'requires_fix_now');
}

function validateHashField(
    violations: string[],
    subject: string,
    actual: unknown,
    expected: string | null
): void {
    const normalizedActual = normalizeHash(actual);
    if (!expected) {
        return;
    }
    if (normalizedActual !== expected) {
        violations.push(`${subject} mismatch: expected ${expected}, found ${normalizedActual || 'missing'}.`);
    }
}

function validatePathField(
    violations: string[],
    subject: string,
    actual: unknown,
    expectedPath: string
): void {
    const actualText = normalizeText(actual);
    if (!actualText) {
        violations.push(`${subject} is missing.`);
        return;
    }
    const normalizedActual = normalizePath(path.isAbsolute(actualText) ? path.resolve(actualText) : actualText);
    const normalizedExpected = normalizePath(expectedPath);
    if (normalizedActual !== normalizedExpected) {
        violations.push(`${subject} mismatch: expected ${normalizedExpected}, found ${normalizedActual}.`);
    }
}

function validateReceiptEvidence(params: {
    receipt: Record<string, unknown> | null;
    receiptPath: string | null;
    taskId: string;
    reviewType: string;
    validationArtifactPath: string;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
}): { receiptSha256: string | null; violations: string[] } {
    const violations: string[] = [];
    const receiptSha256 = params.receiptPath ? fileSha256(params.receiptPath) : null;
    if (!params.receiptPath || !params.receipt) {
        return {
            receiptSha256,
            violations: ['Review receipt is required to carry receipt hash evidence for materialized follow-up tasks.']
        };
    }
    if (normalizeText(params.receipt.task_id) !== params.taskId) {
        violations.push(`Review receipt task_id mismatch: expected ${params.taskId}, found ${normalizeText(params.receipt.task_id) || 'missing'}.`);
    }
    if (normalizeText(params.receipt.review_type) !== params.reviewType) {
        violations.push(`Review receipt review_type mismatch: expected ${params.reviewType}, found ${normalizeText(params.receipt.review_type) || 'missing'}.`);
    }
    const validationReference = isPlainRecord(params.receipt.review_findings_validation)
        ? params.receipt.review_findings_validation
        : null;
    if (!validationReference) {
        violations.push('Review receipt is missing review_findings_validation evidence.');
    } else {
        validatePathField(violations, 'Review receipt review_findings_validation.artifact_path', validationReference.artifact_path, normalizePath(params.validationArtifactPath));
        validateHashField(violations, 'Review receipt review_findings_validation.artifact_sha256', validationReference.artifact_sha256, params.validationArtifactSha256);
        validateHashField(violations, 'Review receipt review_findings_validation.validation_result_sha256', validationReference.validation_result_sha256, params.validationResultSha256);
        if (validationReference.accepted !== true) {
            violations.push('Review receipt review_findings_validation.accepted must be true.');
        }
        if (validationReference.status !== 'accepted') {
            violations.push('Review receipt review_findings_validation.status must be accepted.');
        }
    }
    const dispositionReference = isPlainRecord(params.receipt.review_findings_disposition_artifact)
        ? params.receipt.review_findings_disposition_artifact
        : null;
    if (!dispositionReference) {
        violations.push('Review receipt is missing review_findings_disposition_artifact evidence.');
    } else {
        validatePathField(violations, 'Review receipt review_findings_disposition_artifact.artifact_path', dispositionReference.artifact_path, normalizePath(params.dispositionArtifactPath));
        validateHashField(violations, 'Review receipt review_findings_disposition_artifact.artifact_sha256', dispositionReference.artifact_sha256, params.dispositionArtifactSha256);
        validateHashField(violations, 'Review receipt review_findings_disposition_artifact.disposition_result_sha256', dispositionReference.disposition_result_sha256, params.dispositionResultSha256);
    }
    const contract = isPlainRecord(params.receipt.review_output_contract)
        ? params.receipt.review_output_contract
        : null;
    if (!contract) {
        violations.push('Review receipt is missing review_output_contract evidence.');
    } else {
        validateHashField(violations, 'Review receipt review_output_contract.validation_artifact_sha256', contract.validation_artifact_sha256, params.validationArtifactSha256);
        validateHashField(violations, 'Review receipt review_output_contract.validation_result_sha256', contract.validation_result_sha256, params.validationResultSha256);
        validateHashField(violations, 'Review receipt review_output_contract.disposition_artifact_sha256', contract.disposition_artifact_sha256, params.dispositionArtifactSha256);
        validateHashField(violations, 'Review receipt review_output_contract.disposition_result_sha256', contract.disposition_result_sha256, params.dispositionResultSha256);
    }
    return { receiptSha256, violations };
}

function buildBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPath: string;
    dispositionArtifactPath: string;
    dispositionArtifactSha256: string | null;
    dispositionResultSha256: string | null;
    validationArtifactPath: string | null;
    validationArtifactSha256: string | null;
    validationResultSha256: string | null;
    validationArtifact: ReviewFindingsValidationArtifact | null;
    receiptPath: string | null;
    receiptSha256: string | null;
    items: readonly ReviewFindingsFollowUpTaskMaterializationItem[];
    violations: readonly string[];
}): ReviewFindingsFollowUpTaskMaterializationResult {
    const violations = [...params.violations];
    const artifact = buildArtifact({
        taskId: params.taskId,
        reviewType: params.reviewType,
        status: 'BLOCKED',
        dispositionArtifactPath: params.dispositionArtifactPath,
        dispositionArtifactSha256: params.dispositionArtifactSha256,
        dispositionResultSha256: params.dispositionResultSha256,
        validationArtifactPath: params.validationArtifactPath,
        validationArtifactSha256: params.validationArtifactSha256,
        validationResultSha256: params.validationResultSha256,
        validationArtifact: params.validationArtifact,
        receiptPath: params.receiptPath,
        receiptSha256: params.receiptSha256,
        items: params.items,
        violations
    });
    const writeViolation = tryWriteJson(params.artifactPath, artifact, 'Review findings follow-up materialization artifact');
    if (writeViolation) {
        violations.push(writeViolation);
    }
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        review_type: params.reviewType,
        artifact_path: normalizePath(params.artifactPath),
        created_task_ids: [],
        reused_task_ids: [],
        violations,
        output_lines: formatOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            marker: 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED',
            action: 'Resolve review findings follow-up materialization blockers, then rerun this gate.',
            reason: violations.join(' '),
            artifactPath: params.artifactPath,
            violations
        })
    };
}

export function materializeReviewFindingsFollowUpTasks(
    options: MaterializeReviewFindingsFollowUpTasksOptions
): ReviewFindingsFollowUpTaskMaterializationResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    let taskId = normalizeText(options.taskId);
    let reviewType = normalizeText(options.reviewType).toLowerCase();
    let reviewsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    let dispositionArtifactPath = '';
    let artifactPath = getFallbackArtifactPath(repoRoot, taskId, reviewType);

    try {
        taskId = assertCanonicalTaskId(taskId);
        reviewType = assertReviewTypeToken(reviewType);
        artifactPath = getFallbackArtifactPath(repoRoot, taskId, reviewType);
        reviewsRoot = options.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, options.reviewsRoot, 'ReviewsRoot')
            : reviewsRoot;
        dispositionArtifactPath = options.dispositionArtifactPath
            ? resolveInputPathInsideRepo(repoRoot, options.dispositionArtifactPath, 'DispositionArtifactPath')
            : path.join(reviewsRoot, `${taskId}-${reviewType}-findings-disposition.json`);
        artifactPath = options.artifactPath
            ? resolveFollowUpArtifactPath(repoRoot, reviewsRoot, options.artifactPath)
            : resolveFollowUpArtifactPath(
                repoRoot,
                reviewsRoot,
                getReviewFindingsFollowUpTasksArtifactPath(dispositionArtifactPath)
            );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const blockedTaskId = isCanonicalTaskId(taskId) ? taskId : 'UNKNOWN-TASK';
        const blockedReviewType = isReviewTypeToken(reviewType) ? assertReviewTypeToken(reviewType) : 'unknown-review';
        return buildBlockedResult({
            repoRoot,
            taskId: blockedTaskId,
            reviewType: blockedReviewType,
            artifactPath,
            dispositionArtifactPath: dispositionArtifactPath || normalizePath(path.resolve(repoRoot, String(options.dispositionArtifactPath || ''))),
            dispositionArtifactSha256: null,
            dispositionResultSha256: null,
            validationArtifactPath: null,
            validationArtifactSha256: null,
            validationResultSha256: null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        });
    }

    const dispositionRead = readJsonFile(dispositionArtifactPath, 'Review findings disposition artifact');
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);
    const disposition = dispositionRead.value ? parseDispositionArtifact(dispositionRead.value) : null;
    const parsedDispositionViolations = disposition
        ? validateDispositionArtifactShape({ artifact: disposition, artifactPath: dispositionArtifactPath, taskId, reviewType })
        : ['Review findings disposition artifact has invalid shape.'];
    const initialViolations = [
        ...dispositionRead.violations,
        ...(dispositionRead.value ? parsedDispositionViolations : [])
    ];

    if (!disposition || initialViolations.length > 0 || !dispositionArtifactSha256) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition?.disposition_result_sha256 || null,
            validationArtifactPath: disposition?.source_validation.artifact_path || null,
            validationArtifactSha256: disposition?.source_validation.artifact_sha256 || null,
            validationResultSha256: disposition?.source_validation.validation_result_sha256 || null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: initialViolations
        });
    }

    let validationArtifactPath = '';
    try {
        validationArtifactPath = resolveInputPathInsideRepo(
            repoRoot,
            disposition.source_validation.artifact_path || '',
            'ValidationArtifactPath'
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath: disposition.source_validation.artifact_path || null,
            validationArtifactSha256: disposition.source_validation.artifact_sha256 || null,
            validationResultSha256: disposition.source_validation.validation_result_sha256 || null,
            validationArtifact: null,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        });
    }
    const validationResult = validateReviewFindingsValidationArtifact({
        artifactPath: validationArtifactPath,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        requireAccepted: true,
        expectedArtifactSha256: disposition.source_validation.artifact_sha256,
        expectedValidationResultSha256: disposition.source_validation.validation_result_sha256
    });
    const validationArtifact = validationResult.artifact;
    let receiptPath: string | null = null;
    try {
        receiptPath = deriveReceiptPath({
            repoRoot,
            explicitReceiptPath: options.receiptPath,
            validationArtifact,
            dispositionArtifactPath
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact?.validation_result_sha256 || disposition.source_validation.validation_result_sha256,
            validationArtifact,
            receiptPath: null,
            receiptSha256: null,
            items: [],
            violations: [message]
        });
    }
    const receiptRead = receiptPath
        ? readJsonFile(receiptPath, 'Review receipt')
        : { value: null, violations: ['Review receipt path could not be derived from validation or disposition artifact bindings.'] };
    const receiptValidation = validateReceiptEvidence({
        receipt: receiptRead.value,
        receiptPath,
        taskId,
        reviewType,
        validationArtifactPath,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact?.validation_result_sha256 || null,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256
    });
    const validationInventoryViolations = validationArtifact
        ? validateValidationInventoryShape(validationArtifact)
        : [];
    const sourceViolations = [
        ...validationResult.violations,
        ...validationInventoryViolations,
        ...receiptRead.violations,
        ...receiptValidation.violations
    ];
    if (validationArtifact && validationArtifact.validation_result.status !== 'accepted') {
        sourceViolations.push(
            `Review findings validation artifact status must be accepted before follow-up materialization; ` +
            `found ${validationArtifact.validation_result.status}.`
        );
    }
    if (validationArtifact && validationArtifact.validation_result.accepted !== true) {
        sourceViolations.push('Review findings validation artifact accepted flag must be true before follow-up materialization.');
    }
    if (!validationArtifact || sourceViolations.length > 0 || !validationResult.artifact_sha256 || !receiptValidation.receiptSha256) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact?.validation_result_sha256 || disposition.source_validation.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: [],
            violations: sourceViolations
        });
    }

    const built = buildObligations({
        taskId,
        reviewType,
        disposition,
        validation: validationArtifact,
        dispositionArtifactSha256
    });
    if (built.violations.length > 0) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: built.items,
            violations: built.violations
        });
    }

    const queueResult = materializeTaskQueueRows({
        repoRoot,
        parentTaskId: taskId,
        reviewType,
        artifactPath,
        obligations: built.obligations,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact.validation_result_sha256,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256,
        receiptSha256: receiptValidation.receiptSha256
    });
    const queueViolations = ['task_file_missing', 'task_not_found', 'write_failed'].includes(queueResult.outcome)
        ? [`TASK.md follow-up task materialization failed: ${queueResult.outcome}${queueResult.error_message ? ` (${queueResult.error_message})` : ''}.`]
        : [];
    const items = buildMaterializationItems({
        baseItems: built.items,
        obligations: built.obligations,
        queueResult
    });
    if (queueViolations.length > 0) {
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items,
            violations: queueViolations
        });
    }

    const hasFixNowItems = hasFixNowMaterializationItems(items);
    const status: ReviewFollowUpMaterializationStatus = hasFixNowItems
        ? 'BLOCKED'
        : (queueResult.outcome === 'not_required'
            ? 'NOT_REQUIRED'
            : (queueResult.created.length > 0 ? 'MATERIALIZED' : 'ALREADY_MATERIALIZED'));
    const artifact = buildArtifact({
        taskId,
        reviewType,
        status,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionResultSha256: disposition.disposition_result_sha256,
        validationArtifactPath,
        validationArtifactSha256: validationResult.artifact_sha256,
        validationResultSha256: validationArtifact.validation_result_sha256,
        validationArtifact,
        receiptPath,
        receiptSha256: receiptValidation.receiptSha256,
        items,
        violations: []
    });
    const artifactWriteViolation = tryWriteJson(
        artifactPath,
        artifact,
        'Review findings follow-up materialization artifact'
    );
    if (artifactWriteViolation) {
        const rollbackViolation = rollbackTaskQueueRows(queueResult.task_path, queueResult.rollback_content);
        const rollbackNote = rollbackViolation
            || (queueResult.rollback_content === null
                ? 'No TASK.md rollback was required after follow-up artifact write failure.'
                : 'TASK.md changes were rolled back after follow-up artifact write failure.');
        const failureQueueResult: TaskQueueMaterializationResult = rollbackViolation
            ? queueResult
            : {
                ...queueResult,
                outcome: 'write_failed',
                created: [],
                blocked_fingerprints: queueResult.created.map((item) => item.fingerprint),
                error_message: artifactWriteViolation,
                rollback_content: null
            };
        return buildBlockedResult({
            repoRoot,
            taskId,
            reviewType,
            artifactPath,
            dispositionArtifactPath,
            dispositionArtifactSha256,
            dispositionResultSha256: disposition.disposition_result_sha256,
            validationArtifactPath,
            validationArtifactSha256: validationResult.artifact_sha256,
            validationResultSha256: validationArtifact.validation_result_sha256,
            validationArtifact,
            receiptPath,
            receiptSha256: receiptValidation.receiptSha256,
            items: buildMaterializationItems({
                baseItems: built.items,
                obligations: built.obligations,
                queueResult: failureQueueResult
            }),
            violations: [
                artifactWriteViolation,
                rollbackNote
            ]
        });
    }

    const marker = status === 'MATERIALIZED'
        ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_MATERIALIZED'
        : (status === 'ALREADY_MATERIALIZED'
            ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_ALREADY_MATERIALIZED'
            : (status === 'BLOCKED'
                ? 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED'
                : 'REVIEW_FINDINGS_FOLLOW_UP_TASKS_NOT_REQUIRED'));
    return {
        status,
        task_id: taskId,
        review_type: reviewType,
        artifact_path: normalizePath(artifactPath),
        created_task_ids: queueResult.created.map((item) => item.task_id),
        reused_task_ids: queueResult.reused.map((item) => item.task_id),
        violations: [],
        output_lines: formatOutput({
            repoRoot,
            taskId,
            status,
            marker,
            action: status === 'BLOCKED'
                ? 'Resolve review findings marked fix_now, then rerun review validation.'
                : (status === 'NOT_REQUIRED'
                    ? 'Continue through the navigator; no deferred review findings required follow-up tasks.'
                    : 'Continue through the navigator with review follow-up tasks linked in TASK.md.'),
            reason: status === 'MATERIALIZED'
                ? `${queueResult.created.length} follow-up task(s) created.`
                : (status === 'ALREADY_MATERIALIZED'
                    ? `${queueResult.reused.length} follow-up task(s) already linked.`
                    : (status === 'BLOCKED'
                        ? 'Disposition artifact contains review findings that require fix_now remediation.'
                        : 'Disposition artifact contained no create_follow_up obligations.')),
            artifactPath,
            violations: []
        })
    };
}
