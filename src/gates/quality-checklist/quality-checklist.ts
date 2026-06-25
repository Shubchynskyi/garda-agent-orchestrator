import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getWorkflowConfigPath,
    normalizeOptionalQualityChecksConfig,
    type OptionalQualityCheckRule
} from '../../core/workflow-config';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    stringSha256
} from '../shared/helpers';

export const QUALITY_CHECKLIST_ID = 'optional_quality_checks';

export const QUALITY_CHECKLIST_STATUSES = Object.freeze([
    'PASS',
    'WARN',
    'ACTION_REQUIRED',
    'SKIPPED_DISABLED',
    'CONFIG_ERROR'
] as const);

export const QUALITY_CHECKLIST_ANSWER_STATUSES = Object.freeze([
    'PASS',
    'WARN',
    'ACTION_REQUIRED'
] as const);

export type QualityChecklistStatus = typeof QUALITY_CHECKLIST_STATUSES[number];
export type QualityChecklistAnswerStatus = typeof QUALITY_CHECKLIST_ANSWER_STATUSES[number];

export interface QualityChecklistAnswerInput {
    rule_id?: unknown;
    status?: unknown;
    answer?: unknown;
    evidence_files?: unknown;
    actions_taken?: unknown;
    actions_required?: unknown;
}

export interface QualityChecklistAnswer {
    rule_id: string;
    status: QualityChecklistAnswerStatus;
    answer: string;
    evidence_files: string[];
    actions_taken: string[];
    actions_required: string[];
}

export interface QualityChecklistRuleArtifact {
    id: string;
    title: string;
    prompt: string;
    enabled: boolean;
}

export interface QualityChecklistChangedFileEvidence {
    changed_files: string[];
    changed_files_count: number;
    changed_files_sha256: string;
    scope_sha256: string | null;
    scope_content_sha256: string | null;
}

export interface QualityChecklistArtifact {
    schema_version: 1;
    timestamp_utc: string;
    event_source: 'quality-checklist';
    task_id: string;
    checklist_id: typeof QUALITY_CHECKLIST_ID;
    status: QualityChecklistStatus;
    outcome: 'PASS' | 'WARN' | 'FAIL' | 'INFO';
    workflow_config_path: string;
    workflow_config_sha256: string | null;
    preflight_path: string;
    preflight_sha256: string | null;
    changed_file_evidence: QualityChecklistChangedFileEvidence;
    rules: QualityChecklistRuleArtifact[];
    answers: QualityChecklistAnswer[];
    actions_taken: string[];
    actions_required: string[];
    violations: string[];
}

export interface BuildQualityChecklistOptions {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answers?: unknown;
    actionsTaken?: unknown;
    actionsRequired?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toTextArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((entry) => String(entry || '').trim()).filter(Boolean);
    }
    const text = String(value || '').trim();
    return text ? [text] : [];
}

function normalizeRuleId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeAnswerStatus(value: unknown): QualityChecklistAnswerStatus | null {
    const normalized = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (normalized === 'OK' || normalized === 'PASSED') {
        return 'PASS';
    }
    if (normalized === 'WARNING' || normalized === 'WARNED') {
        return 'WARN';
    }
    if (normalized === 'ACTION' || normalized === 'REQUIRED' || normalized === 'NEEDS_ACTION') {
        return 'ACTION_REQUIRED';
    }
    return QUALITY_CHECKLIST_ANSWER_STATUSES.includes(normalized as QualityChecklistAnswerStatus)
        ? normalized as QualityChecklistAnswerStatus
        : null;
}

function normalizeAnswerInput(input: unknown): QualityChecklistAnswer | null {
    if (!isRecord(input)) {
        return null;
    }
    const ruleId = normalizeRuleId(input.rule_id ?? input.ruleId ?? input.id);
    const status = normalizeAnswerStatus(input.status);
    const answer = String(input.answer ?? input.summary ?? '').trim();
    if (!ruleId || !status || !answer) {
        return null;
    }
    return {
        rule_id: ruleId,
        status,
        answer,
        evidence_files: toTextArray(input.evidence_files ?? input.evidenceFiles).map(normalizePath).filter(Boolean),
        actions_taken: toTextArray(input.actions_taken ?? input.actionsTaken),
        actions_required: toTextArray(input.actions_required ?? input.actionsRequired)
    };
}

function normalizeAnswers(value: unknown): QualityChecklistAnswer[] {
    const source = isRecord(value) && Array.isArray(value.answers) ? value.answers : value;
    if (!Array.isArray(source)) {
        return [];
    }
    return source
        .map((entry) => normalizeAnswerInput(entry))
        .filter((entry): entry is QualityChecklistAnswer => entry !== null);
}

function normalizeRuleForArtifact(rule: OptionalQualityCheckRule): QualityChecklistRuleArtifact {
    return {
        id: normalizeRuleId(rule.id),
        title: String(rule.title || '').trim(),
        prompt: String(rule.prompt || '').trim(),
        enabled: rule.enabled !== false
    };
}

function findDuplicateRuleIds(rules: readonly QualityChecklistRuleArtifact[]): string[] {
    const countsById = new Map<string, number>();
    for (const rule of rules) {
        countsById.set(rule.id, (countsById.get(rule.id) || 0) + 1);
    }
    return [...countsById.entries()]
        .filter(([, count]) => count > 1)
        .map(([id]) => id)
        .sort();
}

function resolveQualityChecklistArtifactPath(repoRoot: string, taskId: string, artifactPath = ''): string {
    const explicit = String(artifactPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (!resolved) {
            throw new Error('QualityChecklistArtifactPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-quality-checklist.json`));
}

export function resolveDefaultQualityChecklistArtifactPath(repoRoot: string, taskId: string): string {
    return resolveQualityChecklistArtifactPath(repoRoot, taskId);
}

function resolvePreflightPath(repoRoot: string, taskId: string, preflightPath: unknown): string {
    const explicit = String(preflightPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true, enforceInside: true });
        if (!resolved) {
            throw new Error('PreflightPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
}

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function readPreflightEvidence(preflightPath: string, expectedTaskId: string): {
    sha256: string | null;
    evidence: QualityChecklistChangedFileEvidence;
    violation: string | null;
} {
    const emptyChangedFilesSha256 = stringSha256('') || '';
    const emptyEvidence = {
        changed_files: [],
        changed_files_count: 0,
        changed_files_sha256: emptyChangedFilesSha256,
        scope_sha256: null,
        scope_content_sha256: null
    };
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            sha256: null,
            evidence: emptyEvidence,
            violation: `Preflight artifact not found: ${normalizePath(preflightPath)}.`
        };
    }
    const preflight = readJsonRecord(preflightPath);
    if (!preflight) {
        return {
            sha256: fileSha256(preflightPath),
            evidence: emptyEvidence,
            violation: `Preflight artifact is not valid JSON object: ${normalizePath(preflightPath)}.`
        };
    }
    const preflightTaskId = typeof preflight.task_id === 'string' ? preflight.task_id.trim() : '';
    if (preflightTaskId && preflightTaskId !== expectedTaskId) {
        return {
            sha256: fileSha256(preflightPath),
            evidence: emptyEvidence,
            violation: `Preflight artifact task_id '${preflightTaskId}' does not match quality-checklist task_id '${expectedTaskId}'.`
        };
    }
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map(normalizePath).filter(Boolean))].sort()
        : [];
    const metrics = isRecord(preflight.metrics) ? preflight.metrics : {};
    return {
        sha256: fileSha256(preflightPath),
        evidence: {
            changed_files: changedFiles,
            changed_files_count: changedFiles.length,
            changed_files_sha256: stringSha256(changedFiles.join('\n')) || '',
            scope_sha256: typeof metrics.scope_sha256 === 'string' ? metrics.scope_sha256.trim().toLowerCase() : null,
            scope_content_sha256: typeof metrics.scope_content_sha256 === 'string' ? metrics.scope_content_sha256.trim().toLowerCase() : null
        },
        violation: null
    };
}

function readChecklistRules(repoRoot: string): {
    workflowConfigPath: string;
    workflowConfigSha256: string | null;
    rules: QualityChecklistRuleArtifact[];
    enabled: boolean;
    violation: string | null;
} {
    const workflowConfigPath = getWorkflowConfigPath(joinOrchestratorPath(repoRoot, ''));
    if (!fs.existsSync(workflowConfigPath) || !fs.statSync(workflowConfigPath).isFile()) {
        return {
            workflowConfigPath,
            workflowConfigSha256: null,
            rules: [],
            enabled: false,
            violation: `Workflow config not found: ${normalizePath(workflowConfigPath)}.`
        };
    }
    const workflowConfig = readJsonRecord(workflowConfigPath);
    if (!workflowConfig) {
        return {
            workflowConfigPath,
            workflowConfigSha256: fileSha256(workflowConfigPath),
            rules: [],
            enabled: false,
            violation: `Workflow config is not valid JSON object: ${normalizePath(workflowConfigPath)}.`
        };
    }
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(workflowConfig.optional_quality_checks);
    const rules = optionalQualityChecks.rules.map(normalizeRuleForArtifact);
    const duplicateRuleIds = findDuplicateRuleIds(rules);
    return {
        workflowConfigPath,
        workflowConfigSha256: fileSha256(workflowConfigPath),
        rules,
        enabled: optionalQualityChecks.enabled,
        violation: duplicateRuleIds.length > 0
            ? `Workflow config has duplicate quality-check rule id(s): ${duplicateRuleIds.map((id) => `'${id}'`).join(', ')}.`
            : null
    };
}

function decideStatus(
    enabledRules: readonly QualityChecklistRuleArtifact[],
    answers: readonly QualityChecklistAnswer[],
    violations: string[]
): QualityChecklistStatus {
    if (violations.length > 0) {
        return 'CONFIG_ERROR';
    }
    const answerCountsByRuleId = new Map<string, number>();
    for (const answer of answers) {
        answerCountsByRuleId.set(answer.rule_id, (answerCountsByRuleId.get(answer.rule_id) || 0) + 1);
    }
    for (const [ruleId, count] of answerCountsByRuleId) {
        if (count > 1) {
            violations.push(`Duplicate answer for quality-check rule '${ruleId}'.`);
        }
    }
    const answerByRuleId = new Map(answers.map((answer) => [answer.rule_id, answer]));
    for (const rule of enabledRules) {
        if (!answerByRuleId.has(rule.id)) {
            violations.push(`Missing answer for enabled quality-check rule '${rule.id}'.`);
        }
    }
    for (const answer of answers) {
        if (!enabledRules.some((rule) => rule.id === answer.rule_id)) {
            violations.push(`Answer references unknown or disabled quality-check rule '${answer.rule_id}'.`);
        }
        if (answer.status === 'ACTION_REQUIRED' && answer.actions_required.length === 0) {
            violations.push(`Answer '${answer.rule_id}' is ACTION_REQUIRED but has no actions_required entry.`);
        }
    }
    if (violations.length > 0) {
        return 'CONFIG_ERROR';
    }
    if (answers.some((answer) => answer.status === 'ACTION_REQUIRED')) {
        return 'ACTION_REQUIRED';
    }
    if (answers.some((answer) => answer.status === 'WARN')) {
        return 'WARN';
    }
    return 'PASS';
}

function outcomeForStatus(status: QualityChecklistStatus): QualityChecklistArtifact['outcome'] {
    if (status === 'PASS') return 'PASS';
    if (status === 'WARN') return 'WARN';
    if (status === 'SKIPPED_DISABLED') return 'INFO';
    return 'FAIL';
}

export function buildQualityChecklistArtifact(options: BuildQualityChecklistOptions): QualityChecklistArtifact {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const preflightPath = resolvePreflightPath(repoRoot, taskId, options.preflightPath);
    const config = readChecklistRules(repoRoot);
    const preflight = readPreflightEvidence(preflightPath, taskId);
    const violations = [config.violation, preflight.violation].filter((entry): entry is string => !!entry);
    const rules = config.rules;
    const enabledRules = rules.filter((rule) => rule.enabled);
    const answers = normalizeAnswers(options.answers);
    const explicitActionsTaken = toTextArray(options.actionsTaken);
    const explicitActionsRequired = toTextArray(options.actionsRequired);

    let status: QualityChecklistStatus;
    if (violations.length > 0) {
        status = 'CONFIG_ERROR';
    } else if (!config.enabled) {
        status = 'SKIPPED_DISABLED';
    } else {
        status = decideStatus(enabledRules, answers, violations);
    }

    const actionsTaken = [
        ...explicitActionsTaken,
        ...answers.flatMap((answer) => answer.actions_taken)
    ].filter(Boolean);
    const actionsRequired = [
        ...explicitActionsRequired,
        ...answers.flatMap((answer) => answer.actions_required)
    ].filter(Boolean);
    if ((status === 'PASS' || status === 'WARN') && actionsRequired.length > 0) {
        status = 'ACTION_REQUIRED';
    }

    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'quality-checklist',
        task_id: taskId,
        checklist_id: QUALITY_CHECKLIST_ID,
        status,
        outcome: outcomeForStatus(status),
        workflow_config_path: normalizePath(config.workflowConfigPath),
        workflow_config_sha256: config.workflowConfigSha256,
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: preflight.sha256,
        changed_file_evidence: preflight.evidence,
        rules,
        answers: status === 'SKIPPED_DISABLED' ? [] : answers,
        actions_taken: [...new Set(actionsTaken)].sort(),
        actions_required: [...new Set(actionsRequired)].sort(),
        violations
    };
}

export function formatQualityChecklistResult(artifact: QualityChecklistArtifact): string[] {
    const headline = {
        PASS: 'QUALITY_CHECKLIST_PASSED',
        WARN: 'QUALITY_CHECKLIST_WARNED',
        ACTION_REQUIRED: 'QUALITY_CHECKLIST_ACTION_REQUIRED',
        SKIPPED_DISABLED: 'QUALITY_CHECKLIST_SKIPPED_DISABLED',
        CONFIG_ERROR: 'QUALITY_CHECKLIST_CONFIG_ERROR'
    }[artifact.status];
    const enabledRules = artifact.rules.filter((rule) => rule.enabled);
    const lines = [
        headline,
        `TaskId: ${artifact.task_id}`,
        `Status: ${artifact.status}`,
        `Outcome: ${artifact.outcome}`,
        `ChecklistId: ${artifact.checklist_id}`,
        `EnabledRuleCount: ${enabledRules.length}`,
        `AnswersRecorded: ${artifact.answers.length}`,
        `ChangedFilesCount: ${artifact.changed_file_evidence.changed_files_count}`,
        `ActionsRequiredCount: ${artifact.actions_required.length}`
    ];
    if (artifact.actions_required.length > 0) {
        lines.push('ActionsRequired:');
        for (const action of artifact.actions_required) {
            lines.push(`  - ${action}`);
        }
    }
    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of artifact.violations) {
            lines.push(`  - ${violation}`);
        }
    }
    return lines;
}
