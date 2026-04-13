import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { selectRulePackFiles } from './build-review-context';
import { fileSha256, joinOrchestratorPath, normalizePath, resolvePathInsideRepo } from './helpers';
import { resolveGateExecutionPath } from './isolation-sandbox';
import { validatePreflightForReview } from './required-reviews-check';
import { getTaskModeEvidence, getTaskModeEvidenceViolations } from './task-mode';

export const RULE_PACK_STAGE_LABELS = Object.freeze([
    'TASK_ENTRY',
    'POST_PREFLIGHT'
] as const);

export type RulePackStageLabel = (typeof RULE_PACK_STAGE_LABELS)[number];

const RULE_PACK_STAGE_KEYS = Object.freeze({
    TASK_ENTRY: 'task_entry',
    POST_PREFLIGHT: 'post_preflight'
} satisfies Record<RulePackStageLabel, 'task_entry' | 'post_preflight'>);

const RULE_PACK_ENTRY_FILE_NAMES = Object.freeze([
    '00-core.md',
    '40-commands.md',
    '80-task-workflow.md',
    '90-skill-catalog.md'
]);

interface RulePackStageArtifact {
    timestamp_utc: string;
    stage: RulePackStageLabel;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';
    actor: string;
    required_rule_files: string[];
    loaded_rule_files: string[];
    missing_rule_files: string[];
    extra_rule_files: string[];
    required_rule_hashes: Record<string, string | null>;
    loaded_rule_hashes: Record<string, string | null>;
    required_rule_count: number;
    loaded_rule_count: number;
    effective_depth: number | null;
    preflight_path: string | null;
    preflight_hash_sha256: string | null;
    required_reviews: Record<string, boolean> | null;
    violations: string[];
}

export interface RulePackArtifact {
    timestamp_utc: string;
    event_source: 'load-rule-pack';
    task_id: string;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';
    latest_stage: RulePackStageLabel;
    stages: {
        task_entry?: RulePackStageArtifact;
        post_preflight?: RulePackStageArtifact;
    };
}

export interface BuildRulePackArtifactOptions {
    repoRoot: string;
    taskId: string;
    stage: RulePackStageLabel;
    loadedRuleFiles: string[];
    preflightPath?: string;
    taskModePath?: string;
    actor?: string;
    artifactPath?: string;
}

export interface RulePackEvidenceResult {
    task_id: string | null;
    stage: RulePackStageLabel;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    evidence_stage: string | null;
    evidence_preflight_path: string | null;
    evidence_preflight_hash: string | null;
    effective_depth: number | null;
    required_rule_files: string[];
    loaded_rule_files: string[];
    missing_rule_files: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getRulePackStageKey(stage: RulePackStageLabel): 'task_entry' | 'post_preflight' {
    return RULE_PACK_STAGE_KEYS[stage];
}

function getRulePackRulesRoot(repoRoot: string): string {
    return resolveGateExecutionPath(repoRoot, path.join('live', 'docs', 'agent-rules'));
}

function getRulePackRequiredEntryFiles(repoRoot: string): string[] {
    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return RULE_PACK_ENTRY_FILE_NAMES.map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

function getRulePackRequiredFilesFromPreflight(
    repoRoot: string,
    requiredReviews: Record<string, boolean>,
    effectiveDepth: number
): string[] {
    const fileNames = new Set<string>(RULE_PACK_ENTRY_FILE_NAMES);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (!required) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    return [...fileNames].map(function (fileName) {
        return normalizePath(path.join(rulesRoot, fileName));
    }).sort();
}

function normalizeLoadedRuleFilePath(repoRoot: string, ruleFile: string): string {
    const rawValue = String(ruleFile || '').trim();
    if (!rawValue) {
        throw new Error('LoadedRuleFiles contains an empty value.');
    }

    const rulesRoot = getRulePackRulesRoot(repoRoot);
    const resolvedPath = (path.isAbsolute(rawValue) || rawValue.includes('/') || rawValue.includes('\\'))
        ? resolvePathInsideRepo(rawValue, repoRoot)
        : path.join(rulesRoot, rawValue);
    if (!resolvedPath) {
        throw new Error(`Loaded rule file '${rawValue}' could not be resolved.`);
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        throw new Error(`Loaded rule file not found: ${resolvedPath}`);
    }

    const normalizedRulesRoot = normalizePath(rulesRoot).toLowerCase();
    const normalizedResolvedPath = normalizePath(resolvedPath);
    const normalizedResolvedLower = normalizedResolvedPath.toLowerCase();
    if (
        normalizedResolvedLower !== normalizedRulesRoot
        && !normalizedResolvedLower.startsWith(`${normalizedRulesRoot}/`)
    ) {
        throw new Error(
            `Loaded rule file must resolve inside '${normalizePath(rulesRoot)}'. Got '${normalizedResolvedPath}'.`
        );
    }

    return normalizedResolvedPath;
}

function normalizeLoadedRuleFiles(repoRoot: string, loadedRuleFiles: string[]): string[] {
    const normalized = loadedRuleFiles.map(function (ruleFile) {
        return normalizeLoadedRuleFilePath(repoRoot, ruleFile);
    });
    const seen = new Set<string>();
    const unique: string[] = [];
    for (const ruleFile of normalized) {
        const key = ruleFile.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            unique.push(ruleFile);
        }
    }
    return unique.sort();
}

function buildRuleFileHashes(ruleFiles: string[]): Record<string, string | null> {
    return Object.fromEntries(ruleFiles.map(function (ruleFile) {
        return [ruleFile, fileSha256(ruleFile)];
    }));
}

function readExistingRulePackArtifact(artifactPath: string): RulePackArtifact | null {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        if (!isRecord(parsed) || !isRecord(parsed.stages)) {
            return null;
        }
        return parsed as unknown as RulePackArtifact;
    } catch {
        return null;
    }
}

export function resolveRulePackArtifactPath(repoRoot: string, taskId: string, artifactPath: string): string {
    const explicitPath = String(artifactPath || '').trim();
    if (explicitPath) {
        const resolvedPath = resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            throw new Error('RulePackArtifactPath must not be empty.');
        }
        return resolvedPath;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-rule-pack.json`));
}

export function buildRulePackArtifact(options: BuildRulePackArtifactOptions): RulePackArtifact {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = assertValidTaskId(options.taskId);
    const stage = options.stage;
    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const loadedRuleFiles = normalizeLoadedRuleFiles(repoRoot, options.loadedRuleFiles || []);

    const violations: string[] = [];
    if (loadedRuleFiles.length === 0) {
        violations.push('Explicit loaded rule file list is required. Pass --loaded-rule-file for every opened downstream rule file.');
    }

    let preflightPath: string | null = null;
    let preflightHash: string | null = null;
    let requiredReviews: Record<string, boolean> | null = null;
    let effectiveDepth: number | null = null;
    let requiredRuleFiles: string[] = [];

    if (stage === 'TASK_ENTRY') {
        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, String(options.taskModePath || ''));
        const taskModeViolations = getTaskModeEvidenceViolations(taskModeEvidence);
        if (taskModeViolations.length > 0) {
            violations.push(...taskModeViolations);
            effectiveDepth = taskModeEvidence.effective_depth || null;
        } else {
            effectiveDepth = taskModeEvidence.effective_depth;
        }
        requiredRuleFiles = getRulePackRequiredEntryFiles(repoRoot);
    } else {
        const resolvedPreflightPath = resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot);
        if (!resolvedPreflightPath) {
            throw new Error('PreflightPath is required for POST_PREFLIGHT rule-pack evidence.');
        }
        const validatedPreflight = validatePreflightForReview(resolvedPreflightPath, taskId);
        preflightPath = normalizePath(validatedPreflight.preflight_path);
        preflightHash = validatedPreflight.preflight_hash;
        requiredReviews = validatedPreflight.required_reviews;
        violations.push(...validatedPreflight.errors);

        const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, String(options.taskModePath || ''));
        const taskModeViolations = getTaskModeEvidenceViolations(taskModeEvidence);
        if (taskModeViolations.length > 0) {
            violations.push(...taskModeViolations);
            effectiveDepth = taskModeEvidence.effective_depth || null;
        } else {
            effectiveDepth = taskModeEvidence.effective_depth;
        }

        // T-030: Prefer risk-aware promoted depth from preflight when available
        const preflightRiskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
        if (preflightRiskAwareDepth && typeof preflightRiskAwareDepth.effective_depth === 'number') {
            effectiveDepth = preflightRiskAwareDepth.effective_depth;
        }

        requiredRuleFiles = getRulePackRequiredFilesFromPreflight(
            repoRoot,
            requiredReviews,
            effectiveDepth || 2
        );
    }

    const requiredRuleSet = new Set(requiredRuleFiles.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    const loadedRuleSet = new Set(loadedRuleFiles.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    const missingRuleFiles = requiredRuleFiles.filter(function (ruleFile) {
        return !loadedRuleSet.has(ruleFile.toLowerCase());
    });
    if (missingRuleFiles.length > 0) {
        violations.push(
            `Missing required downstream rule files for ${stage}: ${missingRuleFiles.join(', ')}.`
        );
    }
    const extraRuleFiles = loadedRuleFiles.filter(function (ruleFile) {
        return !requiredRuleSet.has(ruleFile.toLowerCase());
    });

    const stageArtifact: RulePackStageArtifact = {
        timestamp_utc: new Date().toISOString(),
        stage,
        status: violations.length > 0 ? 'FAILED' : 'PASSED',
        outcome: violations.length > 0 ? 'FAIL' : 'PASS',
        actor,
        required_rule_files: requiredRuleFiles,
        loaded_rule_files: loadedRuleFiles,
        missing_rule_files: missingRuleFiles,
        extra_rule_files: extraRuleFiles,
        required_rule_hashes: buildRuleFileHashes(requiredRuleFiles),
        loaded_rule_hashes: buildRuleFileHashes(loadedRuleFiles),
        required_rule_count: requiredRuleFiles.length,
        loaded_rule_count: loadedRuleFiles.length,
        effective_depth: effectiveDepth,
        preflight_path: preflightPath,
        preflight_hash_sha256: preflightHash,
        required_reviews: requiredReviews,
        violations
    };

    const existingArtifact = readExistingRulePackArtifact(
        resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''))
    );
    const stages = isRecord(existingArtifact?.stages) ? { ...existingArtifact.stages } : {};
    stages[getRulePackStageKey(stage)] = stageArtifact;

    return {
        timestamp_utc: stageArtifact.timestamp_utc,
        event_source: 'load-rule-pack',
        task_id: taskId,
        status: stageArtifact.status,
        outcome: stageArtifact.outcome,
        latest_stage: stage,
        stages
    };
}

export function getRulePackEvidence(
    repoRoot: string,
    taskId: string | null,
    stage: RulePackStageLabel,
    options: {
        artifactPath?: string;
        preflightPath?: string;
        taskModePath?: string;
    } = {}
): RulePackEvidenceResult {
    const result: RulePackEvidenceResult = {
        task_id: taskId,
        stage,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        evidence_stage: null,
        evidence_preflight_path: null,
        evidence_preflight_hash: null,
        effective_depth: null,
        required_rule_files: [],
        loaded_rule_files: [],
        missing_rule_files: []
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveRulePackArtifactPath(repoRoot, resolvedTaskId, String(options.artifactPath || ''));
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);

    let artifact: Record<string, unknown>;
    try {
        const parsedArtifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
        artifact = isRecord(parsedArtifact) ? parsedArtifact : {};
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_task_id = String(artifact.task_id || '').trim() || null;
    result.evidence_source = String(artifact.event_source || '').trim() || null;
    if (result.evidence_task_id !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').toLowerCase() !== 'load-rule-pack') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }

    const stages = isRecord(artifact.stages) ? artifact.stages : null;
    const stageKey = getRulePackStageKey(stage);
    const stageArtifact = stages && isRecord(stages[stageKey]) ? stages[stageKey] : null;
    if (!stageArtifact) {
        result.evidence_status = 'EVIDENCE_STAGE_MISSING';
        return result;
    }

    result.evidence_stage = String(stageArtifact.stage || '').trim() || null;
    result.evidence_status = String(stageArtifact.status || '').trim().toUpperCase();
    result.evidence_outcome = String(stageArtifact.outcome || '').trim().toUpperCase() || null;
    result.evidence_preflight_path = String(stageArtifact.preflight_path || '').trim() || null;
    result.evidence_preflight_hash = String(stageArtifact.preflight_hash_sha256 || '').trim() || null;
    result.effective_depth = typeof stageArtifact.effective_depth === 'number' ? stageArtifact.effective_depth : null;
    result.required_rule_files = Array.isArray(stageArtifact.required_rule_files)
        ? stageArtifact.required_rule_files.map(function (item) { return normalizePath(item); })
        : [];
    result.loaded_rule_files = Array.isArray(stageArtifact.loaded_rule_files)
        ? stageArtifact.loaded_rule_files.map(function (item) { return normalizePath(item); })
        : [];
    result.missing_rule_files = Array.isArray(stageArtifact.missing_rule_files)
        ? stageArtifact.missing_rule_files.map(function (item) { return normalizePath(item); })
        : [];

    if (result.evidence_stage !== stage) {
        result.evidence_status = 'EVIDENCE_STAGE_INVALID';
        return result;
    }

    let expectedRuleFiles: string[] = [];
    if (stage === 'TASK_ENTRY') {
        expectedRuleFiles = getRulePackRequiredEntryFiles(repoRoot);
    } else {
        const resolvedPreflightPath = resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot);
        if (!resolvedPreflightPath) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_REQUIRED';
            return result;
        }
        const validatedPreflight = validatePreflightForReview(resolvedPreflightPath, resolvedTaskId);
        const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
        if (getTaskModeEvidenceViolations(taskModeEvidence).length > 0) {
            result.evidence_status = 'EVIDENCE_TASK_MODE_INVALID';
            return result;
        }
        // T-030: Prefer risk-aware promoted depth from preflight when available
        let evidenceEffectiveDepth = taskModeEvidence.effective_depth || 2;
        const evidenceRiskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
        if (evidenceRiskAwareDepth && typeof evidenceRiskAwareDepth.effective_depth === 'number') {
            evidenceEffectiveDepth = evidenceRiskAwareDepth.effective_depth;
        }
        expectedRuleFiles = getRulePackRequiredFilesFromPreflight(
            repoRoot,
            validatedPreflight.required_reviews,
            evidenceEffectiveDepth
        );

        const normalizedPreflightPath = normalizePath(validatedPreflight.preflight_path);
        if ((result.evidence_preflight_path || '').toLowerCase() !== normalizedPreflightPath.toLowerCase()) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_PATH_MISMATCH';
            return result;
        }
        if ((result.evidence_preflight_hash || '').toLowerCase() !== String(validatedPreflight.preflight_hash || '').toLowerCase()) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_HASH_MISMATCH';
            return result;
        }
    }

    const expectedSet = new Set(expectedRuleFiles.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    const actualSet = new Set(result.required_rule_files.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    if (
        expectedRuleFiles.length !== result.required_rule_files.length
        || expectedRuleFiles.some(function (ruleFile) { return !actualSet.has(ruleFile.toLowerCase()); })
    ) {
        result.evidence_status = 'EVIDENCE_RULE_SET_INVALID';
        return result;
    }

    if (result.required_rule_files.some(function (ruleFile) { return !expectedSet.has(ruleFile.toLowerCase()); })) {
        result.evidence_status = 'EVIDENCE_RULE_SET_INVALID';
        return result;
    }

    const loadedSet = new Set(result.loaded_rule_files.map(function (ruleFile) {
        return ruleFile.toLowerCase();
    }));
    if (
        result.missing_rule_files.length > 0
        || expectedRuleFiles.some(function (ruleFile) { return !loadedSet.has(ruleFile.toLowerCase()); })
    ) {
        result.evidence_status = 'EVIDENCE_REQUIRED_RULES_MISSING';
        return result;
    }

    if (result.evidence_status === 'PASSED' && result.evidence_outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    result.evidence_status = 'EVIDENCE_NOT_PASS';
    return result;
}

export function getRulePackEvidenceViolations(result: RulePackEvidenceResult): string[] {
    const evidencePath = result.evidence_path || '<missing>';
    switch (result.evidence_status) {
        case 'PASS':
            return [];
        case 'TASK_ID_MISSING':
            return ['Rule-pack evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return [
                `Rule-pack evidence missing: file not found at '${evidencePath}'. Run load-rule-pack before continuing task execution.`
            ];
        case 'EVIDENCE_INVALID_JSON':
            return [`Rule-pack evidence is invalid JSON at '${evidencePath}'. Re-run load-rule-pack.`];
        case 'EVIDENCE_TASK_MISMATCH':
            return [`Rule-pack evidence task mismatch. Expected '${result.task_id}', got '${result.evidence_task_id}'.`];
        case 'EVIDENCE_SOURCE_INVALID':
            return [`Rule-pack evidence source is invalid. Expected 'load-rule-pack', got '${result.evidence_source}'.`];
        case 'EVIDENCE_STAGE_MISSING':
            return [`Rule-pack evidence is missing required stage '${result.stage}' in '${evidencePath}'.`];
        case 'EVIDENCE_STAGE_INVALID':
            return [`Rule-pack evidence stage is invalid. Expected '${result.stage}', got '${result.evidence_stage}'.`];
        case 'EVIDENCE_PREFLIGHT_REQUIRED':
            return ['Rule-pack evidence for POST_PREFLIGHT requires the current preflight artifact path.'];
        case 'EVIDENCE_PREFLIGHT_PATH_MISMATCH':
            return [`Rule-pack evidence preflight path mismatch. Evidence path='${result.evidence_preflight_path}'.`];
        case 'EVIDENCE_PREFLIGHT_HASH_MISMATCH':
            return ['Rule-pack evidence preflight hash mismatch. Re-run load-rule-pack for the current preflight artifact.'];
        case 'EVIDENCE_TASK_MODE_INVALID':
            return ['Rule-pack evidence cannot be verified because task-mode evidence is missing or invalid for the same task.'];
        case 'EVIDENCE_RULE_SET_INVALID':
            return [`Rule-pack evidence does not match the required downstream rule set for stage '${result.stage}'. Re-run load-rule-pack.`];
        case 'EVIDENCE_REQUIRED_RULES_MISSING':
            return [
                `Rule-pack evidence is missing required downstream rule files for stage '${result.stage}': ${result.missing_rule_files.join(', ')}.`
            ];
        case 'EVIDENCE_NOT_PASS':
            return [
                `Rule-pack evidence must be PASSED/PASS, got status='${result.evidence_status}', outcome='${result.evidence_outcome}'.`
            ];
        default:
            return ['Rule-pack evidence is missing or invalid. Re-run load-rule-pack.'];
    }
}
