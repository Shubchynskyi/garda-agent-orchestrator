import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { selectRulePackFiles } from './build-review-context';
import { fileSha256, joinOrchestratorPath, normalizePath, resolvePathInsideRepo, stringSha256 } from './helpers';
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
    '15-project-memory.md',
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
    preflight_rule_pack_binding_sha256: string | null;
    preflight_event_sequence: number | null;
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
    timeline_artifact_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    evidence_stage: string | null;
    evidence_preflight_path: string | null;
    evidence_preflight_hash: string | null;
    evidence_preflight_rule_pack_binding_sha256: string | null;
    binding_equivalent_to_current_preflight: boolean;
    effective_depth: number | null;
    required_rule_files: string[];
    loaded_rule_files: string[];
    missing_rule_files: string[];
    stale_loaded_rule_file: string | null;
}

interface TimelineEventEntry {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

export interface PostPreflightSequenceEvidence {
    timeline_path: string;
    latest_preflight_sequence: number | null;
    latest_preflight_path: string | null;
    latest_post_preflight_rule_pack_sequence: number | null;
    latest_post_preflight_rule_pack_path: string | null;
    current_preflight_rule_pack_binding_sha256: string | null;
    latest_post_preflight_rule_pack_binding_sha256: string | null;
    binding_equivalent_to_current_preflight: boolean;
    violations: string[];
}

export interface PostPreflightRulePackRebindDecision {
    can_bind: boolean;
    reason: string;
    loaded_rule_files: string[];
    required_rule_files: string[];
    previous_preflight_path: string | null;
    previous_rule_pack_sequence: number | null;
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

function getTaskTimelinePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
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

function normalizeRequiredReviewRecord(requiredReviews: unknown): Record<string, boolean> | null {
    if (!isRecord(requiredReviews)) {
        return null;
    }

    const normalizedEntries = Object.entries(requiredReviews)
        .filter(([, required]) => typeof required === 'boolean')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(function ([reviewType, required]) {
            return [reviewType, required] as const;
        });

    if (normalizedEntries.length === 0) {
        return null;
    }

    return Object.fromEntries(normalizedEntries) as Record<string, boolean>;
}

function stringifyNormalizedRequiredReviews(requiredReviews: unknown): string {
    return JSON.stringify(normalizeRequiredReviewRecord(requiredReviews) || {});
}

function sameStringSet(left: string[], right: string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    const rightSet = new Set(right.map(function (item) {
        return item.toLowerCase();
    }));
    return left.every(function (item) {
        return rightSet.has(item.toLowerCase());
    });
}

function normalizeRuleFileList(repoRoot: string, value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    try {
        return normalizeLoadedRuleFiles(repoRoot, value.map(function (item) { return String(item || ''); }).filter(Boolean));
    } catch {
        return [];
    }
}

function readRuleHash(record: unknown, ruleFile: string): string | null {
    if (!isRecord(record)) {
        return null;
    }
    const exact = record[ruleFile];
    if (typeof exact === 'string' && exact.trim()) {
        return exact.trim().toLowerCase();
    }
    const normalizedRuleFile = normalizePath(ruleFile).toLowerCase();
    for (const [key, value] of Object.entries(record)) {
        if (normalizePath(key).toLowerCase() === normalizedRuleFile && typeof value === 'string' && value.trim()) {
            return value.trim().toLowerCase();
        }
    }
    return null;
}

function findStaleLoadedRuleFile(loadedRuleHashes: unknown, loadedRuleFiles: readonly string[]): string | null {
    return loadedRuleFiles.find(function (ruleFile) {
        const previousHash = readRuleHash(loadedRuleHashes, ruleFile);
        const currentHash = fileSha256(ruleFile);
        return !previousHash || !currentHash || previousHash !== currentHash.toLowerCase();
    }) || null;
}

function getLatestTaskModeSequence(events: TimelineEventEntry[]): number | null {
    const latestTaskMode = findLatestTimelineEvent(events, function (entry) {
        return entry.event_type === 'TASK_MODE_ENTERED';
    });
    return latestTaskMode ? latestTaskMode.sequence : null;
}

function getLatestPostPreflightRulePackEventAfter(
    events: TimelineEventEntry[],
    sequence: number,
    expectedArtifactPath?: string
): TimelineEventEntry | null {
    const normalizedExpectedArtifactPath = expectedArtifactPath
        ? normalizePath(expectedArtifactPath).toLowerCase()
        : null;
    return findLatestTimelineEvent(events, function (entry) {
        if (entry.sequence <= sequence || entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        if (stage !== 'POST_PREFLIGHT') {
            return false;
        }
        if (!normalizedExpectedArtifactPath) {
            return true;
        }
        const eventArtifactPath = normalizeTimelinePathDetail(
            entry.details?.artifact_path ?? entry.details?.artifactPath
        );
        return (eventArtifactPath || '').toLowerCase() === normalizedExpectedArtifactPath;
    });
}

function stripVolatilePreflightFields(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map(stripVolatilePreflightFields);
    }
    if (!isRecord(value)) {
        return value;
    }

    const sanitizedEntries = Object.entries(value)
        .filter(([key]) => key !== 'timestamp_utc')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(function ([key, nestedValue]) {
            return [key, stripVolatilePreflightFields(nestedValue)] as const;
        });

    return Object.fromEntries(sanitizedEntries);
}

function buildChangedFileContentBindingSha256(repoRoot: string, changedFiles: unknown): string | null {
    const normalizedChangedFiles = Array.isArray(changedFiles)
        ? [...new Set(changedFiles.map(function (entry) {
            return normalizePath(String(entry || '').trim());
        }).filter(Boolean))].sort()
        : [];

    return stringSha256(JSON.stringify(normalizedChangedFiles.map(function (changedFile) {
        const resolvedPath = resolvePathInsideRepo(changedFile, repoRoot, { allowMissing: true });
        return {
            path: changedFile,
            sha256: resolvedPath ? fileSha256(resolvedPath) : null
        };
    })));
}

function buildRulePackBindingSha256(options: {
    repoRoot: string;
    preflightPath: string | null;
    preflightPayload?: unknown;
    effectiveDepth: number | null;
    requiredRuleFiles: string[];
    requiredReviews: Record<string, boolean> | null;
}): string | null {
    if (!options.preflightPath) {
        return null;
    }

    return stringSha256(JSON.stringify({
        preflight_path: normalizePath(options.preflightPath),
        preflight_payload: stripVolatilePreflightFields(options.preflightPayload),
        changed_file_contents_sha256: buildChangedFileContentBindingSha256(
            options.repoRoot,
            isRecord(options.preflightPayload) ? options.preflightPayload.changed_files : []
        ),
        effective_depth: typeof options.effectiveDepth === 'number' ? options.effectiveDepth : null,
        required_rule_files: [...options.requiredRuleFiles].map(normalizePath).sort(),
        required_reviews: normalizeRequiredReviewRecord(options.requiredReviews)
    }));
}

function getStageRulePackBindingSha256(stageArtifact: Record<string, unknown>): string | null {
    const explicitBindingHash = String(stageArtifact.preflight_rule_pack_binding_sha256 || '').trim().toLowerCase();
    return explicitBindingHash || null;
}

function resolveCurrentPostPreflightRulePackBinding(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath = ''
): {
    bindingSha256: string | null;
    violations: string[];
} {
    const validatedPreflight = validatePreflightForReview(preflightPath, taskId);
    const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, String(taskModePath || ''));
    const violations = [
        ...validatedPreflight.errors,
        ...getTaskModeEvidenceViolations(taskModeEvidence)
    ];

    let effectiveDepth = taskModeEvidence.effective_depth || null;
    const riskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
    if (riskAwareDepth && typeof riskAwareDepth.effective_depth === 'number') {
        effectiveDepth = riskAwareDepth.effective_depth;
    }

    const requiredRuleFiles = getRulePackRequiredFilesFromPreflight(
        repoRoot,
        validatedPreflight.required_reviews,
        effectiveDepth || 2
    );

    return {
        bindingSha256: buildRulePackBindingSha256({
            repoRoot,
            preflightPath: normalizePath(validatedPreflight.preflight_path),
            preflightPayload: validatedPreflight.preflight,
            effectiveDepth,
            requiredRuleFiles,
            requiredReviews: validatedPreflight.required_reviews
        }),
        violations
    };
}

function collectOrderedTimelineEvents(timelinePath: string, violations: string[]): TimelineEventEntry[] {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        violations.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
        return [];
    }

    const events: TimelineEventEntry[] = [];
    const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n').filter(function (line) {
        return line.trim().length > 0;
    });

    let sequence = 0;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            const details = isRecord(parsed.details) ? parsed.details : null;
            if (eventType) {
                events.push({
                    event_type: eventType,
                    sequence,
                    details
                });
            }
            sequence += 1;
        } catch {
            violations.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
            return [];
        }
    }

    return events;
}

function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (predicate(entry)) {
            return entry;
        }
    }
    return null;
}

function normalizeTimelinePathDetail(value: unknown): string | null {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return null;
    }
    return normalizePath(rawValue);
}

function getLatestRulePackTimelineArtifactPath(
    events: readonly TimelineEventEntry[],
    stage: RulePackStageLabel,
    expectedPreflightPath: string | null
): string | null {
    const latestRulePackEvent = findLatestTimelineEvent(events, function (entry) {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const eventStage = String(entry.details?.stage || '').trim().toUpperCase();
        if (eventStage !== stage) {
            return false;
        }
        if (stage !== 'POST_PREFLIGHT') {
            return true;
        }
        const eventPreflightPath = normalizeTimelinePathDetail(
            entry.details?.preflight_path ?? entry.details?.preflightPath
        );
        if (!expectedPreflightPath) {
            return true;
        }
        return (eventPreflightPath || '').toLowerCase() === expectedPreflightPath.toLowerCase();
    });
    return normalizeTimelinePathDetail(
        latestRulePackEvent?.details?.artifact_path ?? latestRulePackEvent?.details?.artifactPath
    );
}

function getPreflightClassificationBinding(
    repoRoot: string,
    taskId: string,
    preflightPath: string
): {
    timeline_path: string;
    latest_preflight_sequence: number | null;
    latest_preflight_path: string | null;
    violations: string[];
} {
    const normalizedPreflightPath = normalizePath(preflightPath);
    const timelinePath = getTaskTimelinePath(repoRoot, taskId);
    const violations: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, violations);
    if (violations.length > 0) {
        return {
            timeline_path: normalizePath(timelinePath),
            latest_preflight_sequence: null,
            latest_preflight_path: null,
            violations
        };
    }
    const latestPreflight = findLatestTimelineEvent(events, function (entry) {
        return entry.event_type === 'PREFLIGHT_CLASSIFIED';
    });
    if (!latestPreflight) {
        violations.push(
            `Task timeline '${normalizePath(timelinePath)}' is missing PREFLIGHT_CLASSIFIED for '${normalizedPreflightPath}'. ` +
            'Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT or compile-gate.'
        );
        return {
            timeline_path: normalizePath(timelinePath),
            latest_preflight_sequence: null,
            latest_preflight_path: null,
            violations
        };
    }

    const latestPreflightPath = normalizeTimelinePathDetail(
        latestPreflight.details?.output_path ?? latestPreflight.details?.outputPath
    );
    if (!latestPreflightPath) {
        violations.push(
            `Latest PREFLIGHT_CLASSIFIED evidence in '${normalizePath(timelinePath)}' is missing output_path details. ` +
            'Re-run classify-change before continuing the current task cycle.'
        );
    } else if (latestPreflightPath.toLowerCase() !== normalizedPreflightPath.toLowerCase()) {
        violations.push(
            `Current preflight artifact '${normalizedPreflightPath}' is not the latest PREFLIGHT_CLASSIFIED evidence in ` +
            `'${normalizePath(timelinePath)}'. Latest classified preflight path='${latestPreflightPath}'. ` +
            'Rejecting stale or parallel same-task overlap. Use the latest preflight artifact, then rerun downstream gates sequentially ' +
            "(classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate)."
        );
    }

    return {
        timeline_path: normalizePath(timelinePath),
        latest_preflight_sequence: latestPreflight.sequence,
        latest_preflight_path: latestPreflightPath,
        violations
    };
}

export function getPostPreflightSequenceEvidence(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    options: {
        artifactPath?: string;
        taskModePath?: string;
    } = {}
): PostPreflightSequenceEvidence {
    const currentBinding = resolveCurrentPostPreflightRulePackBinding(
        repoRoot,
        taskId,
        preflightPath,
        String(options.taskModePath || '')
    );
    const binding = getPreflightClassificationBinding(repoRoot, taskId, preflightPath);
    const result: PostPreflightSequenceEvidence = {
        timeline_path: binding.timeline_path,
        latest_preflight_sequence: binding.latest_preflight_sequence,
        latest_preflight_path: binding.latest_preflight_path,
        latest_post_preflight_rule_pack_sequence: null,
        latest_post_preflight_rule_pack_path: null,
        current_preflight_rule_pack_binding_sha256: currentBinding.bindingSha256,
        latest_post_preflight_rule_pack_binding_sha256: null,
        binding_equivalent_to_current_preflight: false,
        violations: [...currentBinding.violations, ...binding.violations]
    };
    if (result.violations.length > 0) {
        return result;
    }

    const normalizedPreflightPath = normalizePath(preflightPath);
    const events = collectOrderedTimelineEvents(result.timeline_path, result.violations);
    if (result.violations.length > 0) {
        return result;
    }
    const latestTaskModeSequence = getLatestTaskModeSequence(events);

    const latestPostPreflightRulePack = findLatestTimelineEvent(events, function (entry) {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        if (stage !== 'POST_PREFLIGHT') {
            return false;
        }
        const eventPreflightPath = normalizeTimelinePathDetail(
            entry.details?.preflight_path ?? entry.details?.preflightPath
        );
        return (eventPreflightPath || '').toLowerCase() === normalizedPreflightPath.toLowerCase();
    });

    if (!latestPostPreflightRulePack) {
        result.violations.push(
            `Task timeline '${result.timeline_path}' is missing POST_PREFLIGHT RULE_PACK_LOADED evidence for '${normalizedPreflightPath}'. ` +
            'Run load-rule-pack --stage POST_PREFLIGHT after classify-change completes. These same-task transitions are not safe to parallelize.'
        );
        return result;
    }

    result.latest_post_preflight_rule_pack_sequence = latestPostPreflightRulePack.sequence;
    result.latest_post_preflight_rule_pack_path = normalizeTimelinePathDetail(
        latestPostPreflightRulePack.details?.preflight_path ?? latestPostPreflightRulePack.details?.preflightPath
    );
    const existingArtifact = readExistingRulePackArtifact(
        resolveRulePackArtifactPath(repoRoot, taskId, String(options.artifactPath || ''))
    );
    const storedStage = isRecord(existingArtifact?.stages?.post_preflight)
        ? existingArtifact?.stages?.post_preflight as unknown as Record<string, unknown>
        : null;
    result.latest_post_preflight_rule_pack_binding_sha256 = storedStage
        ? getStageRulePackBindingSha256(storedStage)
        : null;
    result.binding_equivalent_to_current_preflight = !!(
        result.current_preflight_rule_pack_binding_sha256
        && result.latest_post_preflight_rule_pack_binding_sha256
        && result.current_preflight_rule_pack_binding_sha256 === result.latest_post_preflight_rule_pack_binding_sha256
    );

    if (
        binding.latest_preflight_sequence != null
        && latestPostPreflightRulePack.sequence <= binding.latest_preflight_sequence
        && !result.binding_equivalent_to_current_preflight
    ) {
        result.violations.push(
            `Unsafe same-task overlap detected in '${result.timeline_path}': POST_PREFLIGHT RULE_PACK_LOADED (seq ${latestPostPreflightRulePack.sequence}) ` +
            `does not occur after the latest PREFLIGHT_CLASSIFIED (seq ${binding.latest_preflight_sequence}) for '${normalizedPreflightPath}'. ` +
            'Re-run load-rule-pack --stage POST_PREFLIGHT after classify-change completes, then rerun compile-gate. ' +
            'Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate for the same task cycle.'
        );
    }
    if (
        latestTaskModeSequence != null
        && latestPostPreflightRulePack.sequence <= latestTaskModeSequence
    ) {
        result.violations.push(
            `Unsafe stale task-mode cycle detected in '${result.timeline_path}': POST_PREFLIGHT RULE_PACK_LOADED (seq ${latestPostPreflightRulePack.sequence}) ` +
            `does not occur after the latest TASK_MODE_ENTERED (seq ${latestTaskModeSequence}) for '${normalizedPreflightPath}'. ` +
            'Re-run load-rule-pack --stage POST_PREFLIGHT or bind-rule-pack-to-preflight in the current task-mode cycle, then rerun compile-gate.'
        );
    }

    return result;
}

export function getPostPreflightRulePackRebindDecision(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    options: {
        artifactPath?: string;
        taskModePath?: string;
    } = {}
): PostPreflightRulePackRebindDecision {
    const resolvedTaskId = assertValidTaskId(taskId);
    const artifactPath = resolveRulePackArtifactPath(repoRoot, resolvedTaskId, String(options.artifactPath || ''));
    const artifact = readExistingRulePackArtifact(artifactPath);
    const stageArtifact = isRecord(artifact?.stages?.post_preflight)
        ? artifact?.stages?.post_preflight as unknown as Record<string, unknown>
        : null;
    const emptyDecision = function (reason: string): PostPreflightRulePackRebindDecision {
        return {
            can_bind: false,
            reason,
            loaded_rule_files: [],
            required_rule_files: [],
            previous_preflight_path: null,
            previous_rule_pack_sequence: null
        };
    };

    if (!stageArtifact) {
        return emptyDecision('No prior POST_PREFLIGHT rule-pack stage exists; rule files must be read and recorded.');
    }
    const stageStatus = String(stageArtifact.status || '').trim().toUpperCase();
    const stageOutcome = String(stageArtifact.outcome || '').trim().toUpperCase();
    if (stageStatus !== 'PASSED' || stageOutcome !== 'PASS') {
        return emptyDecision('Prior POST_PREFLIGHT rule-pack evidence did not pass; rule files must be read and recorded again.');
    }

    const timelineViolations: string[] = [];
    const timelinePath = getTaskTimelinePath(repoRoot, resolvedTaskId);
    const timelineEvents = collectOrderedTimelineEvents(timelinePath, timelineViolations);
    if (timelineViolations.length > 0) {
        return emptyDecision(`Rule-pack rebinding cannot verify the current task-mode cycle: ${timelineViolations.join(' ')}`);
    }
    const latestTaskModeSequence = getLatestTaskModeSequence(timelineEvents);
    if (latestTaskModeSequence == null) {
        return emptyDecision('Rule-pack rebinding requires current task-mode evidence; read the rule files in the active task cycle.');
    }
    const latestPostPreflightRulePack = getLatestPostPreflightRulePackEventAfter(timelineEvents, latestTaskModeSequence, artifactPath);
    if (!latestPostPreflightRulePack) {
        return emptyDecision('No POST_PREFLIGHT rule-pack evidence exists for this rule-pack artifact in the current task-mode cycle; rule files must be read again.');
    }

    const loadedRuleFiles = normalizeRuleFileList(repoRoot, stageArtifact.loaded_rule_files);
    if (loadedRuleFiles.length === 0) {
        return emptyDecision('Prior POST_PREFLIGHT rule-pack evidence has no loaded rule files to reuse.');
    }

    const validatedPreflight = validatePreflightForReview(preflightPath, resolvedTaskId);
    const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const validationErrors = [
        ...validatedPreflight.errors,
        ...getTaskModeEvidenceViolations(taskModeEvidence)
    ];
    if (validationErrors.length > 0) {
        return emptyDecision(`Rule-pack rebinding cannot validate the current preflight/task-mode evidence: ${validationErrors.join(' ')}`);
    }

    let effectiveDepth = taskModeEvidence.effective_depth || null;
    const riskAwareDepth = validatedPreflight.preflight?.risk_aware_depth;
    if (riskAwareDepth && typeof riskAwareDepth.effective_depth === 'number') {
        effectiveDepth = riskAwareDepth.effective_depth;
    }
    const requiredRuleFiles = getRulePackRequiredFilesFromPreflight(
        repoRoot,
        validatedPreflight.required_reviews,
        effectiveDepth || 2
    );
    const previousRequiredRuleFiles = normalizeRuleFileList(repoRoot, stageArtifact.required_rule_files);
    if (!sameStringSet(previousRequiredRuleFiles, requiredRuleFiles)) {
        return {
            can_bind: false,
            reason: 'Current preflight requires a different downstream rule set; rule files must be read and recorded.',
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }
    if (
        stringifyNormalizedRequiredReviews(stageArtifact.required_reviews)
        !== stringifyNormalizedRequiredReviews(validatedPreflight.required_reviews)
    ) {
        return {
            can_bind: false,
            reason: 'Current preflight changed required review decisions; rule files must be read and recorded.',
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }
    if (!requiredRuleFiles.every(function (ruleFile) {
        return loadedRuleFiles.some(function (loadedRuleFile) {
            return loadedRuleFile.toLowerCase() === ruleFile.toLowerCase();
        });
    })) {
        return {
            can_bind: false,
            reason: 'Prior POST_PREFLIGHT evidence did not load every rule file required by the current preflight.',
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }

    const loadedRuleHashes = stageArtifact.loaded_rule_hashes;
    const staleRuleFile = findStaleLoadedRuleFile(loadedRuleHashes, loadedRuleFiles);
    if (staleRuleFile) {
        return {
            can_bind: false,
            reason: `Previously loaded rule file '${normalizePath(staleRuleFile)}' changed or cannot be hashed; read the rule file again.`,
            loaded_rule_files: loadedRuleFiles,
            required_rule_files: requiredRuleFiles,
            previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
            previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
        };
    }

    return {
        can_bind: true,
        reason: 'Required downstream rule files and rule hashes are unchanged in the current task-mode cycle; only the preflight binding must be refreshed.',
        loaded_rule_files: loadedRuleFiles,
        required_rule_files: requiredRuleFiles,
        previous_preflight_path: String(stageArtifact.preflight_path || '').trim() || null,
        previous_rule_pack_sequence: latestPostPreflightRulePack.sequence
    };
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
    let preflightEventSequence: number | null = null;
    let preflightPayload: unknown = null;

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
        preflightPayload = validatedPreflight.preflight;
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

        const preflightBinding = getPreflightClassificationBinding(repoRoot, taskId, preflightPath);
        preflightEventSequence = preflightBinding.latest_preflight_sequence;
        violations.push(...preflightBinding.violations);
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
        preflight_rule_pack_binding_sha256: buildRulePackBindingSha256({
            repoRoot,
            preflightPath,
            preflightPayload,
            effectiveDepth,
            requiredRuleFiles,
            requiredReviews
        }),
        preflight_event_sequence: preflightEventSequence,
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
        timeline_artifact_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_source: null,
        evidence_stage: null,
        evidence_preflight_path: null,
        evidence_preflight_hash: null,
        evidence_preflight_rule_pack_binding_sha256: null,
        binding_equivalent_to_current_preflight: false,
        effective_depth: null,
        required_rule_files: [],
        loaded_rule_files: [],
        missing_rule_files: [],
        stale_loaded_rule_file: null
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
    result.evidence_preflight_rule_pack_binding_sha256 = getStageRulePackBindingSha256(stageArtifact);
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

    const timelineViolations: string[] = [];
    const timelineEvents = collectOrderedTimelineEvents(getTaskTimelinePath(repoRoot, resolvedTaskId), timelineViolations);
    if (timelineViolations.length === 0) {
        result.timeline_artifact_path = getLatestRulePackTimelineArtifactPath(
            timelineEvents,
            stage,
            result.evidence_preflight_path
        );
        if (
            result.timeline_artifact_path
            && result.evidence_path
            && result.timeline_artifact_path.toLowerCase() !== result.evidence_path.toLowerCase()
        ) {
            result.evidence_status = 'EVIDENCE_ARTIFACT_PATH_MISMATCH';
            return result;
        }
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
        const expectedBindingSha256 = buildRulePackBindingSha256({
            repoRoot,
            preflightPath: validatedPreflight.preflight_path,
            preflightPayload: validatedPreflight.preflight,
            effectiveDepth: evidenceEffectiveDepth,
            requiredRuleFiles: expectedRuleFiles,
            requiredReviews: validatedPreflight.required_reviews
        });
        result.binding_equivalent_to_current_preflight = !!(
            expectedBindingSha256
            && result.evidence_preflight_rule_pack_binding_sha256
            && expectedBindingSha256 === result.evidence_preflight_rule_pack_binding_sha256
        );

        const normalizedPreflightPath = normalizePath(validatedPreflight.preflight_path);
        if ((result.evidence_preflight_path || '').toLowerCase() !== normalizedPreflightPath.toLowerCase()) {
            result.evidence_status = 'EVIDENCE_PREFLIGHT_PATH_MISMATCH';
            return result;
        }
        if (
            (result.evidence_preflight_hash || '').toLowerCase() !== String(validatedPreflight.preflight_hash || '').toLowerCase()
            && !result.binding_equivalent_to_current_preflight
        ) {
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

    const staleLoadedRuleFile = findStaleLoadedRuleFile(stageArtifact.loaded_rule_hashes, result.loaded_rule_files);
    if (staleLoadedRuleFile) {
        result.stale_loaded_rule_file = staleLoadedRuleFile;
        result.evidence_status = 'EVIDENCE_LOADED_RULE_STALE';
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
        case 'EVIDENCE_ARTIFACT_PATH_MISMATCH':
            return [
                `Rule-pack evidence artifact path mismatch. Timeline recorded '${result.timeline_artifact_path}', ` +
                `but current evidence path is '${evidencePath}'. Re-run downstream gates with the rule-pack artifact path recorded by RULE_PACK_LOADED.`
            ];
        case 'EVIDENCE_PREFLIGHT_REQUIRED':
            return ['Rule-pack evidence for POST_PREFLIGHT requires the current preflight artifact path.'];
        case 'EVIDENCE_PREFLIGHT_PATH_MISMATCH':
            return [
                `Rule-pack evidence preflight path mismatch. Evidence path='${result.evidence_preflight_path}'. ` +
                'Refresh the current task cycle sequentially: classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate.'
            ];
        case 'EVIDENCE_PREFLIGHT_HASH_MISMATCH':
            return [
                'Rule-pack evidence preflight hash mismatch. Re-run load-rule-pack --stage POST_PREFLIGHT for the current preflight artifact, ' +
                'then rerun compile-gate. Do not parallelize classify-change, POST_PREFLIGHT load-rule-pack, and compile-gate for the same task cycle.'
            ];
        case 'EVIDENCE_TASK_MODE_INVALID':
            return ['Rule-pack evidence cannot be verified because task-mode evidence is missing or invalid for the same task.'];
        case 'EVIDENCE_RULE_SET_INVALID':
            return [`Rule-pack evidence does not match the required downstream rule set for stage '${result.stage}'. Re-run load-rule-pack.`];
        case 'EVIDENCE_REQUIRED_RULES_MISSING':
            return [
                `Rule-pack evidence is missing required downstream rule files for stage '${result.stage}': ${result.missing_rule_files.join(', ')}.`
            ];
        case 'EVIDENCE_LOADED_RULE_STALE':
            return [
                `Rule-pack evidence loaded rule file '${normalizePath(result.stale_loaded_rule_file || '<unknown>')}' changed or cannot be hashed. Re-run load-rule-pack.`
            ];
        case 'EVIDENCE_NOT_PASS':
            return [
                `Rule-pack evidence must be PASSED/PASS, got status='${result.evidence_status}', outcome='${result.evidence_outcome}'.`
            ];
        default:
            return ['Rule-pack evidence is missing or invalid. Re-run load-rule-pack.'];
    }
}
