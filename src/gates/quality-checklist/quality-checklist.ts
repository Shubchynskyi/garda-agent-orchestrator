import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    formatOptionalQualityChecksRuleSetDiagnostics,
    getOptionalQualityCheckRuleScopeSkipReason,
    getWorkflowConfigPath,
    normalizeOptionalQualityCheckChangedFileRegexes,
    normalizeOptionalQualityCheckScopeCategories,
    normalizeOptionalQualityChecksConfig,
    type OptionalQualityCheckRule
} from '../../core/workflow-config';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    fileSha256,
    isPathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    stringSha256
} from '../shared/helpers';
import { computeQualityChecklistEffectivePolicySha256 } from './quality-checklist-policy';

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
    included_scope_categories: string[];
    included_changed_file_regexes: string[];
    excluded_scope_categories: string[];
    scope_applicability: 'active' | 'disabled' | 'skipped_by_scope';
    scope_skip_reason: string | null;
}

export interface QualityChecklistChangedFileEvidence {
    changed_files: string[];
    changed_files_count: number;
    changed_files_sha256: string;
    scope_sha256: string | null;
    scope_content_sha256: string | null;
    scope_category: string | null;
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
    effective_policy_sha256: string;
    preflight_path: string;
    preflight_sha256: string | null;
    changed_file_evidence: QualityChecklistChangedFileEvidence;
    scope_category: string | null;
    enabled_rule_count: number;
    active_rule_count: number;
    skipped_by_scope_rule_count: number;
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

export const QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE = 'quality-checklist-answers-template';

export interface QualityChecklistAnswersTemplateAnswer {
    rule_id: string;
    title: string;
    prompt: string;
    status: '';
    answer: '';
    evidence_files: string[];
    actions_taken: string[];
    actions_required: string[];
}

export interface QualityChecklistAnswersTemplate {
    schema_version: 1;
    timestamp_utc: string;
    event_source: typeof QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE;
    task_id: string;
    checklist_id: typeof QUALITY_CHECKLIST_ID;
    preflight_path: string;
    preflight_sha256: string;
    workflow_config_path: string;
    workflow_config_sha256: string | null;
    effective_policy_sha256: string;
    answers: QualityChecklistAnswersTemplateAnswer[];
}

export interface QualityChecklistAnswersTemplateAssessment {
    status: 'missing' | 'invalid' | 'stale' | 'current';
    reason: string;
    template: QualityChecklistAnswersTemplate | null;
}

export interface MaterializeQualityChecklistAnswersTemplateResult {
    status: 'created' | 'refreshed' | 'current';
    answers_path: string;
    template: QualityChecklistAnswersTemplate;
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

function normalizeScopeCategory(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
}

function normalizeRuleForArtifact(
    rule: OptionalQualityCheckRule,
    scopeCategory: string | null,
    changedFiles: readonly string[]
): QualityChecklistRuleArtifact {
    const enabled = rule.enabled !== false;
    const includedScopeCategories = normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories);
    const includedChangedFileRegexes = normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes);
    const excludedScopeCategories = normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories);
    const scopeSkipReason = getOptionalQualityCheckRuleScopeSkipReason(rule, scopeCategory, changedFiles);
    const scopeApplicability: QualityChecklistRuleArtifact['scope_applicability'] = !enabled
        ? 'disabled'
        : scopeSkipReason
            ? 'skipped_by_scope'
            : 'active';
    return {
        id: normalizeRuleId(rule.id),
        title: String(rule.title || '').trim(),
        prompt: String(rule.prompt || '').trim(),
        enabled,
        included_scope_categories: includedScopeCategories,
        included_changed_file_regexes: includedChangedFileRegexes,
        excluded_scope_categories: excludedScopeCategories,
        scope_applicability: scopeApplicability,
        scope_skip_reason: scopeSkipReason
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

function findConfiguredDuplicateRuleIds(optionalQualityChecksInput: unknown): string[] {
    if (!isRecord(optionalQualityChecksInput) || !Array.isArray(optionalQualityChecksInput.rules)) {
        return [];
    }
    const configuredRules = optionalQualityChecksInput.rules
        .filter(isRecord)
        .map((rule) => normalizeRuleId(rule.id))
        .filter(Boolean)
        .map((id) => ({
            id,
            title: '',
            prompt: '',
            enabled: true,
            included_scope_categories: [],
            included_changed_file_regexes: [],
            excluded_scope_categories: [],
            scope_applicability: 'active' as const,
            scope_skip_reason: null
        }));
    return findDuplicateRuleIds(configuredRules);
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
        scope_content_sha256: null,
        scope_category: null
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
            scope_content_sha256: typeof metrics.scope_content_sha256 === 'string' ? metrics.scope_content_sha256.trim().toLowerCase() : null,
            scope_category: normalizeScopeCategory(preflight.scope_category)
        },
        violation: null
    };
}

function readChecklistRules(repoRoot: string): {
    workflowConfigPath: string;
    workflowConfigSha256: string | null;
    rules: OptionalQualityCheckRule[];
    enabled: boolean;
    violation: string | null;
    ruleSetDiagnostic: string | null;
} {
    const workflowConfigPath = getWorkflowConfigPath(joinOrchestratorPath(repoRoot, ''));
    if (!fs.existsSync(workflowConfigPath) || !fs.statSync(workflowConfigPath).isFile()) {
        return {
            workflowConfigPath,
            workflowConfigSha256: null,
            rules: [],
            enabled: false,
            violation: `Workflow config not found: ${normalizePath(workflowConfigPath)}.`,
            ruleSetDiagnostic: null
        };
    }
    const workflowConfig = readJsonRecord(workflowConfigPath);
    if (!workflowConfig) {
        return {
            workflowConfigPath,
            workflowConfigSha256: fileSha256(workflowConfigPath),
            rules: [],
            enabled: false,
            violation: `Workflow config is not valid JSON object: ${normalizePath(workflowConfigPath)}.`,
            ruleSetDiagnostic: null
        };
    }
    const configuredDuplicateRuleIds = findConfiguredDuplicateRuleIds(workflowConfig.optional_quality_checks);
    const optionalQualityChecks = normalizeOptionalQualityChecksConfig(workflowConfig.optional_quality_checks);
    const normalizedRules = optionalQualityChecks.rules.map((rule) => ({
        id: normalizeRuleId(rule.id),
        title: String(rule.title || '').trim(),
        prompt: String(rule.prompt || '').trim(),
        enabled: rule.enabled !== false,
        included_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories),
        included_changed_file_regexes: normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes),
        excluded_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories),
        scope_applicability: rule.enabled === false ? 'disabled' as const : 'active' as const,
        scope_skip_reason: null
    }));
    const duplicateRuleIds = [...new Set([
        ...configuredDuplicateRuleIds,
        ...findDuplicateRuleIds(normalizedRules)
    ])].sort();
    return {
        workflowConfigPath,
        workflowConfigSha256: fileSha256(workflowConfigPath),
        rules: optionalQualityChecks.rules,
        enabled: optionalQualityChecks.enabled,
        violation: duplicateRuleIds.length > 0
            ? `Workflow config has duplicate quality-check rule id(s): ${duplicateRuleIds.map((id) => `'${id}'`).join(', ')}.`
            : null,
        ruleSetDiagnostic: formatOptionalQualityChecksRuleSetDiagnostics(workflowConfig.optional_quality_checks)
    };
}

function decideStatus(
    activeRules: readonly QualityChecklistRuleArtifact[],
    skippedByScopeRules: readonly QualityChecklistRuleArtifact[],
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
    for (const rule of activeRules) {
        if (!answerByRuleId.has(rule.id)) {
            violations.push(`Missing answer for active quality-check rule '${rule.id}'.`);
        }
    }
    const activeRuleIds = new Set(activeRules.map((rule) => rule.id));
    const skippedByScopeRuleIds = new Set(skippedByScopeRules.map((rule) => rule.id));
    for (const answer of answers) {
        if (skippedByScopeRuleIds.has(answer.rule_id)) {
            violations.push(`Answer references quality-check rule '${answer.rule_id}' skipped for the current preflight scope.`);
        } else if (!activeRuleIds.has(answer.rule_id)) {
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
    const scopeCategory = preflight.evidence.scope_category;
    const rules = config.rules.map((rule) => normalizeRuleForArtifact(
        rule,
        scopeCategory,
        preflight.evidence.changed_files
    ));
    const enabledRules = rules.filter((rule) => rule.enabled);
    const activeRules = enabledRules.filter((rule) => rule.scope_applicability === 'active');
    const skippedByScopeRules = enabledRules.filter((rule) => rule.scope_applicability === 'skipped_by_scope');
    const answers = normalizeAnswers(options.answers);
    const explicitActionsTaken = toTextArray(options.actionsTaken);
    const explicitActionsRequired = toTextArray(options.actionsRequired);

    let status: QualityChecklistStatus;
    if (violations.length > 0) {
        status = 'CONFIG_ERROR';
    } else if (!config.enabled) {
        status = 'SKIPPED_DISABLED';
    } else {
        status = decideStatus(activeRules, skippedByScopeRules, answers, violations);
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
    if (status === 'CONFIG_ERROR' && config.ruleSetDiagnostic) {
        violations.unshift(config.ruleSetDiagnostic);
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
        effective_policy_sha256: computeQualityChecklistEffectivePolicySha256(
            config.rules,
            scopeCategory,
            preflight.evidence.changed_files
        ),
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: preflight.sha256,
        changed_file_evidence: preflight.evidence,
        scope_category: scopeCategory,
        enabled_rule_count: enabledRules.length,
        active_rule_count: activeRules.length,
        skipped_by_scope_rule_count: skippedByScopeRules.length,
        rules,
        answers: status === 'SKIPPED_DISABLED' ? [] : answers,
        actions_taken: [...new Set(actionsTaken)].sort(),
        actions_required: [...new Set(actionsRequired)].sort(),
        violations
    };
}

function nonAnswerTemplateViolations(artifact: QualityChecklistArtifact): string[] {
    return artifact.violations.filter((violation) => (
        !violation.startsWith('Missing answer for active quality-check rule ')
        && !violation.startsWith('Quality-checklist workflow config baseline_version ')
    ));
}

export function buildQualityChecklistAnswersTemplate(
    options: Omit<BuildQualityChecklistOptions, 'answers' | 'actionsTaken' | 'actionsRequired'>
): QualityChecklistAnswersTemplate {
    const artifact = buildQualityChecklistArtifact({ ...options, answers: [] });
    const blockingViolations = nonAnswerTemplateViolations(artifact);
    if (blockingViolations.length > 0) {
        throw new Error(`Cannot prepare quality checklist answers template: ${blockingViolations.join(' ')}`);
    }
    if (!artifact.preflight_sha256) {
        throw new Error('Cannot prepare quality checklist answers template without current preflight evidence.');
    }
    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE,
        task_id: artifact.task_id,
        checklist_id: QUALITY_CHECKLIST_ID,
        preflight_path: artifact.preflight_path,
        preflight_sha256: artifact.preflight_sha256,
        workflow_config_path: artifact.workflow_config_path,
        workflow_config_sha256: artifact.workflow_config_sha256,
        effective_policy_sha256: artifact.effective_policy_sha256,
        answers: artifact.rules
            .filter((rule) => rule.scope_applicability === 'active')
            .map((rule) => ({
                rule_id: rule.id,
                title: rule.title,
                prompt: rule.prompt,
                status: '',
                answer: '',
                evidence_files: [],
                actions_taken: [],
                actions_required: []
            }))
    };
}

function invalidAnswersTemplate(reason: string): QualityChecklistAnswersTemplateAssessment {
    return { status: 'invalid', reason, template: null };
}

function staleAnswersTemplate(
    reason: string,
    template: QualityChecklistAnswersTemplate
): QualityChecklistAnswersTemplateAssessment {
    return { status: 'stale', reason, template };
}

function templateRuleIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }
    const ruleIds = value.map((entry) => isRecord(entry) ? normalizeRuleId(entry.rule_id) : '');
    return ruleIds.every(Boolean) ? ruleIds : null;
}

export function assessQualityChecklistAnswersTemplate(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    template: unknown;
}): QualityChecklistAnswersTemplateAssessment {
    if (!isRecord(options.template)) {
        return invalidAnswersTemplate('Quality checklist answers template must be a JSON object.');
    }
    const template = options.template as unknown as QualityChecklistAnswersTemplate;
    if (template.schema_version !== 1 || template.event_source !== QUALITY_CHECKLIST_ANSWERS_TEMPLATE_EVENT_SOURCE) {
        return invalidAnswersTemplate('Quality checklist answers template has an unsupported schema or event_source.');
    }
    const expected = buildQualityChecklistAnswersTemplate(options);
    if (template.task_id !== expected.task_id || template.checklist_id !== expected.checklist_id) {
        return invalidAnswersTemplate('Quality checklist answers template belongs to a different task or checklist.');
    }
    if (template.preflight_path !== expected.preflight_path || template.preflight_sha256 !== expected.preflight_sha256) {
        return staleAnswersTemplate('Quality checklist answers template is stale for the current preflight.', template);
    }
    if (
        template.workflow_config_path !== expected.workflow_config_path
        || template.workflow_config_sha256 !== expected.workflow_config_sha256
        || template.effective_policy_sha256 !== expected.effective_policy_sha256
    ) {
        return staleAnswersTemplate('Quality checklist answers template is stale for the current quality policy.', template);
    }
    const actualRuleIds = templateRuleIds(template.answers);
    const expectedRuleIds = expected.answers.map((answer) => answer.rule_id);
    if (!actualRuleIds || actualRuleIds.length !== expectedRuleIds.length
        || actualRuleIds.some((ruleId, index) => ruleId !== expectedRuleIds[index])) {
        return invalidAnswersTemplate('Quality checklist answers template rule ids do not match the active rules.');
    }
    const scaffoldIsValid = template.answers.every((answer, index) => {
        const expectedAnswer = expected.answers[index];
        return isRecord(answer)
            && answer.title === expectedAnswer.title
            && answer.prompt === expectedAnswer.prompt
            && typeof answer.status === 'string'
            && typeof answer.answer === 'string'
            && Array.isArray(answer.evidence_files)
            && answer.evidence_files.every((entry) => typeof entry === 'string')
            && Array.isArray(answer.actions_taken)
            && answer.actions_taken.every((entry) => typeof entry === 'string')
            && Array.isArray(answer.actions_required)
            && answer.actions_required.every((entry) => typeof entry === 'string');
    });
    if (!scaffoldIsValid) {
        return invalidAnswersTemplate(
            'Quality checklist answers template prompts or editable answer fields do not match the active rule scaffold.'
        );
    }
    return { status: 'current', reason: 'Quality checklist answers template is current.', template };
}

export function assessQualityChecklistAnswersTemplateFile(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answersPath: string;
}): QualityChecklistAnswersTemplateAssessment {
    const repoRoot = path.resolve(options.repoRoot);
    const resolvedPath = resolvePathInsideRepo(options.answersPath, repoRoot, { allowMissing: true, enforceInside: true });
    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        return { status: 'missing', reason: 'Quality checklist answers template is missing.', template: null };
    }
    try {
        assertQualityChecklistAnswersPathHasNoSymlinks(resolvedPath, repoRoot);
        const repoRealPath = fs.realpathSync.native(repoRoot);
        const answersRealPath = fs.realpathSync.native(resolvedPath);
        if (!isPathInsideRoot(answersRealPath, repoRealPath) || !fs.statSync(answersRealPath).isFile()) {
            return invalidAnswersTemplate('Quality checklist answers template must resolve to a file inside the repo root.');
        }
        const template = JSON.parse(fs.readFileSync(answersRealPath, 'utf8'));
        return assessQualityChecklistAnswersTemplate({ ...options, repoRoot, template });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return invalidAnswersTemplate(`Quality checklist answers template is unreadable: ${message}`);
    }
}

export function resolveDefaultQualityChecklistAnswersTemplatePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'tmp', `${assertValidTaskId(taskId)}-quality-checklist-answers.json`));
}

export function assertQualityChecklistAnswersPathHasNoSymlinks(pathValue: string, repoRoot: string): void {
    const absoluteRoot = path.resolve(repoRoot);
    const absolutePath = path.resolve(pathValue);
    const relativePath = path.relative(absoluteRoot, absolutePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new Error(`Quality checklist answers path must stay inside repo root: ${normalizePath(absolutePath)}`);
    }
    let currentPath = absoluteRoot;
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (!fs.existsSync(currentPath)) break;
        if (fs.lstatSync(currentPath).isSymbolicLink()) {
            throw new Error(`Quality checklist answers path must not contain symbolic links: ${normalizePath(currentPath)}`);
        }
    }
}

function resolveAnswersTemplateWritePath(pathValue: string, repoRoot: string): string {
    const resolvedPath = resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true, enforceInside: true });
    if (!resolvedPath) {
        throw new Error('QualityChecklistAnswersTemplatePath must not be empty.');
    }
    assertQualityChecklistAnswersPathHasNoSymlinks(resolvedPath, repoRoot);
    let existingAncestor = fs.existsSync(resolvedPath) ? resolvedPath : path.dirname(resolvedPath);
    while (!fs.existsSync(existingAncestor) && existingAncestor !== path.dirname(existingAncestor)) {
        existingAncestor = path.dirname(existingAncestor);
    }
    const repoRealPath = fs.realpathSync.native(repoRoot);
    const ancestorRealPath = fs.realpathSync.native(existingAncestor);
    if (!isPathInsideRoot(ancestorRealPath, repoRealPath)) {
        throw new Error(`Quality checklist answers template path must resolve inside repo root: ${normalizePath(resolvedPath)}`);
    }
    return resolvedPath;
}

export function materializeQualityChecklistAnswersTemplate(options: {
    repoRoot: string;
    taskId: string;
    preflightPath?: unknown;
    answersPath?: string;
    refreshIfOlderThanUtc?: string | null;
}): MaterializeQualityChecklistAnswersTemplateResult {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = assertValidTaskId(options.taskId);
    const answersPath = resolveAnswersTemplateWritePath(
        options.answersPath || resolveDefaultQualityChecklistAnswersTemplatePath(repoRoot, taskId),
        repoRoot
    );
    const assessment = assessQualityChecklistAnswersTemplateFile({
        repoRoot,
        taskId,
        preflightPath: options.preflightPath,
        answersPath
    });
    const refreshThreshold = Date.parse(String(options.refreshIfOlderThanUtc || ''));
    const currentTimestamp = Date.parse(String(assessment.template?.timestamp_utc || ''));
    const currentIsNewerThanThreshold = Number.isFinite(refreshThreshold)
        && Number.isFinite(currentTimestamp)
        && currentTimestamp > refreshThreshold;
    if (assessment.status === 'current' && (!Number.isFinite(refreshThreshold) || currentIsNewerThanThreshold)) {
        return { status: 'current', answers_path: normalizePath(answersPath), template: assessment.template! };
    }

    const template = buildQualityChecklistAnswersTemplate({ repoRoot, taskId, preflightPath: options.preflightPath });
    fs.mkdirSync(path.dirname(answersPath), { recursive: true });
    fs.writeFileSync(answersPath, JSON.stringify(template, null, 2) + '\n', 'utf8');
    return {
        status: assessment.status === 'missing' ? 'created' : 'refreshed',
        answers_path: normalizePath(answersPath),
        template
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
    const lines = [
        headline,
        `TaskId: ${artifact.task_id}`,
        `Status: ${artifact.status}`,
        `Outcome: ${artifact.outcome}`,
        `ChecklistId: ${artifact.checklist_id}`,
        `ScopeCategory: ${artifact.scope_category || 'unknown'}`,
        `EnabledRuleCount: ${artifact.enabled_rule_count}`,
        `ActiveRuleCount: ${artifact.active_rule_count}`,
        `SkippedByScopeRuleCount: ${artifact.skipped_by_scope_rule_count}`,
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
