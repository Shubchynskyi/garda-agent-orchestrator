import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    normalizeOptionalQualityChecksConfig
} from '../../core/workflow-config';
import {
    QUALITY_CHECKLIST_ID,
    QUALITY_CHECKLIST_STATUSES
} from '../quality-checklist';
import {
    fileSha256
} from '../shared/helpers';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    formatNextStepInlineValue,
    toRepoDisplayPath
} from './next-step-command-formatters';

export type NextStepQualityChecklistEvidenceStatus = 'disabled' | 'not_required' | 'missing' | 'invalid' | 'stale' | 'current';
export type NextStepQualityChecklistEffect = 'disabled' | 'not_required' | 'missing' | 'invalid' | 'stale' | 'passed' | 'helped' | 'warned' | 'required_rework';

export interface NextStepQualityChecklistReadiness {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    status: string | null;
    evidenceStatus: NextStepQualityChecklistEvidenceStatus;
    effect: NextStepQualityChecklistEffect;
    reason: string;
    actionRequiredSummary: string | null;
    actionTakenSummary: string | null;
    actionsRequiredCount: number;
    actionsTakenCount: number;
    answerCount: number;
    changedFilesCount: number | null;
    artifactPath: string | null;
}

export interface NextStepQualityChecklistSummary {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    status: string | null;
    evidence_status: NextStepQualityChecklistEvidenceStatus;
    effect: NextStepQualityChecklistEffect;
    artifact_path: string | null;
    action_required_summary: string | null;
    action_taken_summary: string | null;
    actions_required_count: number;
    actions_taken_count: number;
    answer_count: number;
    changed_files_count: number | null;
    visible_summary_line: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function parseOptionalNumberField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function preflightHasChangedFiles(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) {
        return false;
    }
    if (Array.isArray(preflight.changed_files) && preflight.changed_files.length > 0) {
        return true;
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const changedFilesCount = parseOptionalNumberField(metrics.changed_files_count);
    return changedFilesCount !== null && changedFilesCount > 0;
}

function preflightChangedFilesCount(preflight: Record<string, unknown> | null): number | null {
    if (!preflight) {
        return null;
    }
    if (Array.isArray(preflight.changed_files)) {
        return preflight.changed_files.length;
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    return parseOptionalNumberField(metrics.changed_files_count);
}

function readJsonRecordOrNull(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function formatQualityChecklistActions(actions: unknown): string | null {
    if (!Array.isArray(actions)) {
        return null;
    }
    const normalizedActions = actions
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    if (normalizedActions.length === 0) {
        return null;
    }
    const preview = normalizedActions.slice(0, 3).join('; ');
    const remainder = normalizedActions.length > 3
        ? `; +${normalizedActions.length - 3} more`
        : '';
    return `${preview}${remainder}`;
}

function countArray(value: unknown): number {
    return Array.isArray(value) ? value.length : 0;
}

function buildQualityChecklistReadiness(options: {
    enabled: boolean;
    required: boolean;
    ready: boolean;
    status?: string | null;
    evidenceStatus: NextStepQualityChecklistEvidenceStatus;
    effect: NextStepQualityChecklistEffect;
    reason: string;
    artifactPath?: string | null;
    artifact?: Record<string, unknown> | null;
    changedFilesCount?: number | null;
}): NextStepQualityChecklistReadiness {
    const artifact = options.artifact || null;
    return {
        enabled: options.enabled,
        required: options.required,
        ready: options.ready,
        status: options.status || null,
        evidenceStatus: options.evidenceStatus,
        effect: options.effect,
        reason: options.reason,
        actionRequiredSummary: formatQualityChecklistActions(artifact?.actions_required),
        actionTakenSummary: formatQualityChecklistActions(artifact?.actions_taken),
        actionsRequiredCount: countArray(artifact?.actions_required),
        actionsTakenCount: countArray(artifact?.actions_taken),
        answerCount: countArray(artifact?.answers),
        changedFilesCount: options.changedFilesCount ?? null,
        artifactPath: options.artifactPath || null
    };
}

export function readQualityChecklistReadiness(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    workflowConfig: Record<string, unknown> | null;
}): NextStepQualityChecklistReadiness {
    const hasOptionalQualityChecksConfig = options.workflowConfig?.optional_quality_checks !== undefined;
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(options.workflowConfig?.optional_quality_checks);
    const required = preflightHasChangedFiles(options.preflight);
    const changedFilesCount = preflightChangedFilesCount(options.preflight);
    const enabledRuleCount = optionalQualityChecks.rules.filter((rule) => rule.enabled).length;
    const sourceCheckoutDefaultEnabled = !hasOptionalQualityChecksConfig && isOrchestratorSourceCheckout(options.repoRoot);
    const enabled = (hasOptionalQualityChecksConfig || sourceCheckoutDefaultEnabled) && optionalQualityChecks.enabled && enabledRuleCount > 0;
    if (!enabled) {
        return buildQualityChecklistReadiness({
            enabled: false,
            required,
            ready: true,
            evidenceStatus: 'disabled',
            effect: 'disabled',
            reason: 'Optional quality checks are disabled for the effective workflow configuration.',
            changedFilesCount
        });
    }
    if (!required) {
        return buildQualityChecklistReadiness({
            enabled,
            required: false,
            ready: true,
            evidenceStatus: 'not_required',
            effect: 'not_required',
            reason: 'The current preflight has no changed files, so optional quality checks are not required for this cycle.',
            changedFilesCount
        });
    }

    const artifactPath = path.join(options.reviewsRoot, `${options.taskId}-quality-checklist.json`);
    if (!fileExists(artifactPath)) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            evidenceStatus: 'missing',
            effect: 'missing',
            reason: 'Optional quality checks are enabled and the current changed-file preflight has no quality checklist evidence yet.',
            artifactPath,
            changedFilesCount
        });
    }

    const artifact = readJsonRecordOrNull(artifactPath);
    if (!artifact) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence at ${formatNextStepInlineValue(toRepoDisplayPath(options.repoRoot, artifactPath))} is not a valid JSON object.`,
            artifactPath,
            changedFilesCount
        });
    }

    const status = String(artifact.status || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!QUALITY_CHECKLIST_STATUSES.includes(status as typeof QUALITY_CHECKLIST_STATUSES[number])) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            status: null,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence has unsupported status ${formatNextStepInlineValue(status || '<empty>')}.`,
            artifactPath,
            artifact,
            changedFilesCount
        });
    }
    if (artifact.task_id !== options.taskId) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence belongs to task ${formatNextStepInlineValue(String(artifact.task_id || '<missing>'))}, not ${formatNextStepInlineValue(options.taskId)}.`,
            artifactPath,
            artifact,
            changedFilesCount
        });
    }
    if (artifact.checklist_id !== QUALITY_CHECKLIST_ID) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'invalid',
            effect: 'invalid',
            reason: `Quality checklist evidence has checklist_id ${formatNextStepInlineValue(String(artifact.checklist_id || '<missing>'))}, not ${formatNextStepInlineValue(QUALITY_CHECKLIST_ID)}.`,
            artifactPath,
            artifact,
            changedFilesCount
        });
    }

    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase()
        || (fileExists(options.preflightPath) ? fileSha256(options.preflightPath) : '');
    const artifactPreflightSha256 = String(artifact.preflight_sha256 || '').trim().toLowerCase();
    if (expectedPreflightSha256 && artifactPreflightSha256 !== expectedPreflightSha256) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'stale',
            effect: 'stale',
            reason:
                'Quality checklist evidence is stale for the current preflight hash. ' +
                `Expected ${formatNextStepInlineValue(expectedPreflightSha256)}, found ${formatNextStepInlineValue(artifactPreflightSha256 || '<missing>')}.`,
            artifactPath,
            artifact,
            changedFilesCount
        });
    }

    const expectedWorkflowConfigSha256 = fileExists(resolveWorkflowConfigPath(options.repoRoot))
        ? fileSha256(resolveWorkflowConfigPath(options.repoRoot))
        : null;
    const artifactWorkflowConfigSha256 = typeof artifact.workflow_config_sha256 === 'string'
        ? artifact.workflow_config_sha256.trim().toLowerCase()
        : null;
    if (expectedWorkflowConfigSha256 !== artifactWorkflowConfigSha256) {
        return buildQualityChecklistReadiness({
            enabled,
            required,
            ready: false,
            status,
            evidenceStatus: 'stale',
            effect: 'stale',
            reason:
                'Quality checklist evidence is stale for the current workflow configuration. ' +
                `Expected ${formatNextStepInlineValue(expectedWorkflowConfigSha256 || '<missing>')}, found ${formatNextStepInlineValue(artifactWorkflowConfigSha256 || '<missing>')}.`,
            artifactPath,
            artifact,
            changedFilesCount
        });
    }

    const effect = status === 'ACTION_REQUIRED'
        ? 'required_rework'
        : status === 'WARN'
            ? 'warned'
            : status === 'SKIPPED_DISABLED'
                ? 'disabled'
                : status === 'CONFIG_ERROR'
                    ? 'invalid'
                    : countArray(artifact.actions_taken) > 0
                        ? 'helped'
                    : 'passed';
    return buildQualityChecklistReadiness({
        enabled,
        required,
        ready: true,
        status,
        evidenceStatus: 'current',
        effect,
        reason:
            `Quality checklist evidence is current with status ${formatNextStepInlineValue(status)} at ` +
            `${formatNextStepInlineValue(toRepoDisplayPath(options.repoRoot, artifactPath))}.`,
        artifactPath,
        artifact,
        changedFilesCount
    });
}

export function buildNextStepQualityChecklistSummary(
    readiness: NextStepQualityChecklistReadiness
): NextStepQualityChecklistSummary {
    return {
        enabled: readiness.enabled,
        required: readiness.required,
        ready: readiness.ready,
        status: readiness.status,
        evidence_status: readiness.evidenceStatus,
        effect: readiness.effect,
        artifact_path: readiness.artifactPath,
        action_required_summary: readiness.actionRequiredSummary,
        action_taken_summary: readiness.actionTakenSummary,
        actions_required_count: readiness.actionsRequiredCount,
        actions_taken_count: readiness.actionsTakenCount,
        answer_count: readiness.answerCount,
        changed_files_count: readiness.changedFilesCount,
        visible_summary_line:
            `QualityChecklist: enabled=${readiness.enabled}; required=${readiness.required}; ready=${readiness.ready}; ` +
            `evidence=${readiness.evidenceStatus}; status=${readiness.status || 'none'}; effect=${readiness.effect}; ` +
            `answers=${readiness.answerCount}; actions_taken=${readiness.actionsTakenCount}; ` +
            `actions_required=${readiness.actionsRequiredCount}; changed_files=${readiness.changedFilesCount ?? 'unknown'}`
    };
}

export function markQualityChecklistReadinessStaleForWorkspace(
    readiness: NextStepQualityChecklistReadiness,
    reason: string
): NextStepQualityChecklistReadiness {
    if (readiness.evidenceStatus !== 'current') {
        return readiness;
    }
    return {
        ...readiness,
        ready: false,
        evidenceStatus: 'stale',
        effect: 'stale',
        reason:
            'Quality checklist evidence is stale because the current preflight/workspace freshness guard is not satisfied. ' +
            reason
    };
}
