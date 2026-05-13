import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../core/constants';
import { buildReviewContextSections, type ReviewContextSectionsResult } from '../gate-runtime/review-context';
import { stringSha256 } from '../gate-runtime/hash';
import { withReviewArtifactLock, writeArtifactFileAtomically } from '../gate-runtime/review-artifacts';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../gate-runtime/reviewer-session-contract';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    parseBool,
    resolvePathInsideRepo,
    toStringArray
} from './helpers';
import { resolveGateExecutionPathPosix } from './isolation-sandbox';
import { getCanonicalReviewContextPath } from './review-context-paths';
import {
    buildGitDiffSummary,
    readReviewContextChangedFiles,
    REVIEW_CONTEXT_DIFF_MAX_CHARS,
    REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS,
    type GitDiffSummary
} from './review-context-diff';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations,
} from './review-context-contract';
import { collectOrderedTimelineEvents } from './completion-evidence';
import {
    loadFullSuiteValidationConfig,
    type FullSuiteValidationResult
} from './full-suite-validation';
import {
    getCycleBindingSnapshotFromPayload,
    normalizeTaskCycleScopeBinding,
    resolveTaskCycleBindingSnapshot,
    taskCycleScopeBindingsMatch,
    type TaskCycleBindingSnapshot
} from './task-events-summary';
import {
    buildReviewTreeState,
    getReviewTreeStateBlockingViolations,
    type ReviewTreeState
} from './review-tree-state';
import { resolveRuntimeReviewerIdentity, type RuntimeReviewerIdentity } from './reviewer-routing';
import { getTaskModeEvidence } from './task-mode';
import { getReviewSkillCandidates, hasSkillEntrypoint } from '../core/review-capabilities';

/**
 * Rule pack configuration by review type.
 * Matches Python get_rule_pack.
 */
export function getRulePack(reviewType: string) {
    if (reviewType === 'code') {
        return {
            full: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md'],
            depth1: ['00-core.md', '80-task-workflow.md'],
            depth2: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md']
        };
    }
    if (reviewType === 'db' || reviewType === 'security') {
        return {
            full: ['00-core.md', '35-strict-coding-rules.md', '70-security.md', '80-task-workflow.md'],
            depth1: ['00-core.md', '80-task-workflow.md'],
            depth2: ['00-core.md', '35-strict-coding-rules.md', '70-security.md', '80-task-workflow.md']
        };
    }
    if (reviewType === 'refactor') {
        return {
            full: ['00-core.md', '30-code-style.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '80-task-workflow.md'],
            depth1: ['00-core.md', '80-task-workflow.md'],
            depth2: ['00-core.md', '30-code-style.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '80-task-workflow.md']
        };
    }
    return {
        full: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md'],
        depth1: ['00-core.md', '80-task-workflow.md'],
        depth2: ['00-core.md', '35-strict-coding-rules.md', '50-structure-and-docs.md', '70-security.md', '80-task-workflow.md']
    };
}

export function selectRulePackFiles(reviewType: string, depth: number): string[] {
    const rulePack = getRulePack(reviewType);
    if (depth >= 3) {
        return [...rulePack.full];
    }
    if (depth <= 1) {
        return [...rulePack.depth1];
    }
    return [...rulePack.depth2];
}

export function resolveReviewSkillId(reviewType: string, repoRoot: string): string {
    const rulesRoot = path.resolve(repoRoot);
    for (const candidate of getReviewSkillCandidates(reviewType)) {
        const skillRoot = path.join(rulesRoot, resolveBundleName(), 'live', 'skills', candidate);
        if (hasSkillEntrypoint(skillRoot)) {
            return candidate;
        }
    }
    return getReviewSkillCandidates(reviewType)[0];
}

/**
 * Resolve the output path for review context.
 */
export function resolveContextOutputPath(explicitOutputPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitOutputPath && explicitOutputPath.trim()) {
        return resolvePathInsideRepo(explicitOutputPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return getCanonicalReviewContextPath(preflightDir, baseName, reviewType);
}

/**
 * Resolve scoped diff metadata path.
 */
export function resolveScopedDiffMetadataPath(explicitPath: string, preflightPath: string, reviewType: string, repoRoot: string): string {
    if (explicitPath && explicitPath.trim()) {
        return resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true }) as string;
    }
    const preflightDir = path.dirname(preflightPath);
    const baseName = path.basename(preflightPath, path.extname(preflightPath)).replace(/-preflight$/, '');
    return path.resolve(preflightDir, `${baseName}-${reviewType}-scoped.json`);
}

/**
 * Convert a value to non-negative integer or null.
 */
export function toNonNegativeInt(value: unknown): number | null {
    if (value == null || typeof value === 'boolean') return null;
    if (typeof value === 'number') return value >= 0 ? Math.floor(value) : null;
    try {
        const parsed = parseInt(String(value).trim(), 10);
        return parsed >= 0 ? parsed : null;
    } catch { return null; }
}

function summarizeBooleanRecord(record: unknown): string[] {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return [];
    }
    return Object.entries(record as Record<string, unknown>)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
        .sort();
}

function buildReviewerOutputContractMarkdown(reviewType: string): string[] {
    const reviewLabel = reviewType ? `${reviewType} review` : 'review';
    return [
        '## Reviewer Output Contract',
        `- Return a canonical ${reviewLabel} report using exactly this section order and heading text:`,
        '```markdown',
        '## Findings by Severity',
        '<active findings by Critical/High/Medium/Low, or none>',
        '',
        '## Deferred Findings',
        '<accepted non-blocking follow-up with Justification:, or none>',
        '',
        '## Residual Risks',
        '<active open risks, or none>',
        '',
        '## Verdict',
        '<recognized PASS or FAIL verdict token>',
        '```',
        '- A no-findings PASS must still include 1-3 concise sentences naming the reviewed files and behavior checked.',
        '- Do not return only headings, `none`, and a PASS verdict; record-review-result rejects trivial or obviously synthetic reports.',
        '- Keep PASS analysis compact and concrete; put accepted non-blocking follow-ups only in Deferred Findings with `Justification:`.',
        ''
    ];
}

function isTestLikeChangedFile(filePath: string): boolean {
    const normalized = normalizePath(filePath).toLowerCase();
    return normalized.includes('/test/')
        || normalized.includes('/tests/')
        || normalized.includes('/__tests__/')
        || /(^|\/)tests?\//u.test(normalized)
        || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(normalized);
}

function splitGitDiffSections(diffText: string): string[] {
    const starts = [...diffText.matchAll(/^diff --git /gmu)].map((match) => match.index ?? -1).filter((index) => index >= 0);
    if (starts.length === 0) {
        return [diffText];
    }
    return starts.map((start, index) => diffText.slice(start, starts[index + 1] ?? diffText.length));
}

function getDiffSectionFilePath(section: string): string {
    const firstLine = section.split(/\r?\n/, 1)[0] || '';
    const match = /^diff --git a\/.+ b\/(.+)$/u.exec(firstLine);
    return match ? normalizePath(match[1] || '') : '';
}

function getPromptDiffSectionPriority(reviewType: string, filePath: string): number {
    const normalized = normalizePath(filePath).toLowerCase();
    if (reviewType === 'test') {
        return isTestLikeChangedFile(normalized) ? 0 : 1;
    }
    if (reviewType !== 'api') {
        return 0;
    }
    if (normalized === 'src/gates/rule-pack.ts') {
        return 0;
    }
    if (normalized.startsWith('src/cli/') || normalized.startsWith('src/compat/')) {
        return 1;
    }
    if (normalized === 'docs/cli-reference.md') {
        return 2;
    }
    if (normalized.startsWith('tests/node/cli/') || normalized === 'tests/node/gates/build-review-context.test.ts') {
        return 3;
    }
    if (normalized.startsWith('src/gates/')) {
        return 4;
    }
    if (isTestLikeChangedFile(normalized)) {
        return 5;
    }
    if (normalized.startsWith('docs/') || normalized.startsWith('template/')) {
        return 6;
    }
    if (normalized.startsWith('src/') && !isTestLikeChangedFile(normalized)) {
        return 4;
    }
    if (normalized.startsWith('bin/') || normalized.startsWith('scripts/')) {
        return 4;
    }
    return 5;
}

function prioritizePromptDiffForReview(reviewType: string, diffText: string): string {
    if ((reviewType !== 'test' && reviewType !== 'api') || !diffText.trim()) {
        return diffText;
    }
    const sections = splitGitDiffSections(diffText);
    if (sections.length <= 1) {
        return diffText;
    }
    return sections
        .map((section, index) => ({
            section,
            index,
            priority: getPromptDiffSectionPriority(reviewType, getDiffSectionFilePath(section))
        }))
        .sort((left, right) => left.priority - right.priority || left.index - right.index)
        .map((entry) => entry.section)
        .join('');
}

function buildTaskScopeMarkdown(options: {
    taskId: string | null;
    reviewType: string;
    depth: number;
    preflightPath: string;
    preflightSha256: string | null;
    preflight: Record<string, unknown>;
    changedFiles: string[];
    requiredReviews: string[];
    activeTriggers: string[];
    gitDiff: GitDiffSummary;
    treeState: ReviewTreeState | null;
    fullSuiteValidation: ReviewContextFullSuiteValidationEvidence | null;
}): string {
    const lines: string[] = [];
    const fullDiffText = options.gitDiff.diff || '';
    const promptDiffSourceText = prioritizePromptDiffForReview(options.reviewType, fullDiffText);
    const promptDiffMaxChars = options.reviewType === 'code' || options.reviewType === 'api'
        ? REVIEW_CONTEXT_DIFF_MAX_CHARS
        : REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS;
    const promptDiffText = promptDiffSourceText.slice(0, promptDiffMaxChars);
    const promptDiffExcerptTruncated = promptDiffSourceText.length > promptDiffMaxChars;
    const diffFence = buildMarkdownFence(promptDiffText, 'diff');
    const statFence = buildMarkdownFence(options.gitDiff.stat || '', 'text');
    lines.push(`# Review Context: ${options.taskId || '<unknown>'} ${options.reviewType}`);
    lines.push('');
    lines.push('## Task Scope');
    lines.push(`- Review type: ${options.reviewType}`);
    lines.push(`- Depth: ${options.depth}`);
    lines.push(`- Path mode: ${String(options.preflight.mode || 'unknown')}`);
    lines.push(`- Scope category: ${String(options.preflight.scope_category || 'unknown')}`);
    lines.push(`- Preflight path: ${normalizePath(options.preflightPath)}`);
    lines.push(`- Preflight sha256: ${options.preflightSha256 || 'unknown'}`);
    lines.push(`- Required reviews: ${options.requiredReviews.length > 0 ? options.requiredReviews.join(', ') : 'none'}`);
    lines.push(`- Active triggers: ${options.activeTriggers.length > 0 ? options.activeTriggers.join(', ') : 'none'}`);
    lines.push('');
    lines.push('## Changed Files');
    if (options.changedFiles.length === 0) {
        lines.push('- none');
    } else {
        for (const changedFile of options.changedFiles) {
            lines.push(`- ${changedFile}`);
        }
    }
    lines.push('');
    lines.push('## Review Tree State');
    if (options.treeState) {
        lines.push(`- Detection source: ${options.treeState.detection_source}`);
        lines.push(`- Use staged snapshot: ${options.treeState.use_staged}`);
        lines.push(`- Include untracked files: ${options.treeState.include_untracked}`);
        lines.push(`- Tree state sha256: ${options.treeState.tree_state_sha256 || 'unknown'}`);
        lines.push(`- Scope sha256: ${options.treeState.scope_sha256 || 'unknown'}`);
        lines.push(`- Stale staged snapshot files: ${options.treeState.stale_staged_snapshot_files.length > 0 ? options.treeState.stale_staged_snapshot_files.join(', ') : 'none'}`);
    } else {
        lines.push('- unavailable');
    }
    lines.push('');
    lines.push('## Current Diff Stat');
    if (options.gitDiff.stat) {
        lines.push(statFence.open);
        lines.push(options.gitDiff.stat);
        lines.push(statFence.close);
    } else {
        lines.push(options.gitDiff.error ? `Unavailable: ${options.gitDiff.error}` : 'none');
    }
    lines.push('');
    lines.push('## Current Scoped Diff');
    if (promptDiffText) {
        lines.push(diffFence.open);
        lines.push(promptDiffText);
        if (options.gitDiff.diff_truncated || promptDiffExcerptTruncated) {
            lines.push('');
            if (options.reviewType === 'code' && !promptDiffExcerptTruncated) {
                lines.push(`[diff truncated at ${REVIEW_CONTEXT_DIFF_MAX_CHARS} chars from ${options.gitDiff.diff_char_count} chars]`);
            } else {
                const fullBoundedNote = options.gitDiff.diff_truncated
                    ? ` from ${options.gitDiff.diff_char_count} chars`
                    : '';
                const cacheNote = options.gitDiff.cache_path
                    ? `; full bounded scoped diff cache: ${options.gitDiff.cache_path}`
                    : '';
                lines.push(`[diff excerpt truncated at ${promptDiffMaxChars} chars${fullBoundedNote}${cacheNote}]`);
            }
        }
        lines.push(diffFence.close);
    } else {
        lines.push(options.gitDiff.error ? `Unavailable: ${options.gitDiff.error}` : 'none');
    }
    lines.push('');
    if (options.fullSuiteValidation) {
        lines.push(...buildFullSuiteValidationEvidenceMarkdown(options.fullSuiteValidation));
        lines.push('');
    }
    lines.push(...buildReviewerOutputContractMarkdown(options.reviewType));
    lines.push('## Rule Context');
    return lines.join('\n');
}

function buildMarkdownFence(content: string, info: string): { open: string; close: string } {
    const longestFence = [...content.matchAll(/`{3,}/g)]
        .reduce((maxLength, match) => Math.max(maxLength, match[0].length), 2);
    const fence = '`'.repeat(longestFence + 1);
    return {
        open: `${fence}${info}`,
        close: fence
    };
}

function shouldIncludeUntrackedForReviewTreeState(preflight: Record<string, unknown>): boolean {
    const detectionSource = String(preflight.detection_source || '').trim().toLowerCase();
    return detectionSource === 'git_staged_plus_untracked'
        || detectionSource === 'git_auto'
        || detectionSource === 'explicit_changed_files';
}

function asPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export interface TokenEconomyConfig {
    enabled?: unknown;
    enabled_depths?: unknown;
    strip_examples?: unknown;
    strip_code_blocks?: unknown;
    scoped_diffs?: unknown;
    compact_reviewer_output?: unknown;
    fail_tail_lines?: unknown;
}

export interface ReviewContextFullSuiteValidationEvidence {
    required_for_review: boolean;
    artifact_path: string | null;
    artifact_sha256: string | null;
    available: boolean;
    status: FullSuiteValidationResult['status'] | null;
    enabled: boolean | null;
    command: string | null;
    exit_code: number | null;
    timed_out: boolean | null;
    output_artifact_path: string | null;
    compact_summary: string[];
    violations: string[];
    warnings: string[];
    cycle_binding: FullSuiteValidationResult['cycle_binding'] | null;
    matches_current_preflight: boolean | null;
    compile_gate_artifact_path: string | null;
    compile_gate_timestamp_utc: string | null;
    compile_gate_status: string | null;
    matches_current_compile_gate: boolean | null;
    cycle_binding_valid: boolean | null;
    mismatch_reason: string | null;
    parse_error?: string;
}

interface CurrentCompileGateEvidence {
    artifact_path: string | null;
    artifact_timestamp_utc: string | null;
    timeline_timestamp_utc: string | null;
    status: string | null;
    cycle_binding: TaskCycleBindingSnapshot | null;
}

export interface BuildReviewContextOptions {
    reviewType: string;
    depth: number;
    preflightPath: string;
    preflightPayload?: Record<string, unknown> | null;
    taskModePath?: string | null;
    taskModeEvidence?: ReturnType<typeof getTaskModeEvidence> | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
    tokenEconomyConfigPath: string;
    tokenEconomyConfigData?: TokenEconomyConfig | null;
    scopedDiffMetadataPath: string;
    outputPath: string;
    repoRoot: string;
    ruleContextSectionsCache?: Map<string, ReviewContextSectionsResult> | null;
    ruleFileContentCache?: Map<string, string> | null;
}

function normalizeFullSuiteValidationStatus(value: unknown): FullSuiteValidationResult['status'] | null {
    const text = String(value || '').trim().toUpperCase();
    if (text === 'PASSED' || text === 'FAILED' || text === 'WARNED' || text === 'SKIPPED') {
        return text;
    }
    return null;
}

function normalizeNullableNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeNullableBoolean(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

function normalizeNullablePath(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? normalizePath(text) : null;
}

function readCurrentCompileGateEvidence(repoRoot: string, taskId: string | null): CurrentCompileGateEvidence {
    if (!taskId) {
        return {
            artifact_path: null,
            artifact_timestamp_utc: null,
            timeline_timestamp_utc: null,
            status: null,
            cycle_binding: null
        };
    }
    const compileGateArtifactPath = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-compile-gate.json`));
    const normalizedArtifactPath = normalizePath(compileGateArtifactPath);
    const timelinePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineErrors: string[] = [];
    const timelineEvents = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    const latestCompileGatePassedTimestamp = [...timelineEvents]
        .reverse()
        .find((entry) => entry.event_type === 'COMPILE_GATE_PASSED')
        ?.timestamp_utc || null;
    const currentCycle = resolveTaskCycleBindingSnapshot(
        taskId,
        timelineEvents as unknown as ReadonlyArray<Record<string, unknown>>,
        repoRoot,
        path.dirname(compileGateArtifactPath)
    );
    if (!fs.existsSync(compileGateArtifactPath) || !fs.statSync(compileGateArtifactPath).isFile()) {
        return {
            artifact_path: normalizedArtifactPath,
            artifact_timestamp_utc: null,
            timeline_timestamp_utc: latestCompileGatePassedTimestamp,
            status: null,
            cycle_binding: currentCycle
        };
    }
    try {
        const raw = asPlainRecord(JSON.parse(fs.readFileSync(compileGateArtifactPath, 'utf8'))) || {};
        return {
            artifact_path: normalizedArtifactPath,
            artifact_timestamp_utc: String(raw.timestamp_utc || '').trim() || null,
            timeline_timestamp_utc: latestCompileGatePassedTimestamp,
            status: String(raw.status || '').trim() || null,
            cycle_binding: currentCycle || {
                preflight_path: normalizeNullablePath(raw.preflight_path),
                preflight_sha256: typeof raw.preflight_hash_sha256 === 'string' ? raw.preflight_hash_sha256 : null,
                compile_gate_timestamp: latestCompileGatePassedTimestamp,
                scope_binding: normalizeTaskCycleScopeBinding(raw)
            }
        };
    } catch {
        return {
            artifact_path: normalizedArtifactPath,
            artifact_timestamp_utc: null,
            timeline_timestamp_utc: latestCompileGatePassedTimestamp,
            status: null,
            cycle_binding: currentCycle
        };
    }
}

function buildFullSuiteValidationEvidence(options: {
    repoRoot: string;
    taskId: string | null;
    reviewType: string;
    preflightPath: string;
    preflightSha256: string | null;
}): ReviewContextFullSuiteValidationEvidence | null {
    if (options.reviewType !== 'test') {
        return null;
    }
    const fullSuiteValidationConfig = loadFullSuiteValidationConfig(options.repoRoot);
    const requiredForReview = fullSuiteValidationConfig.enabled === true;

    const compileGateEvidence = readCurrentCompileGateEvidence(options.repoRoot, options.taskId);
    const artifactPath = options.taskId
        ? joinOrchestratorPath(options.repoRoot, path.join('runtime', 'reviews', `${options.taskId}-full-suite-validation.json`))
        : null;
    if (!artifactPath) {
        return {
            required_for_review: requiredForReview,
            artifact_path: null,
            artifact_sha256: null,
            available: false,
            status: null,
            enabled: fullSuiteValidationConfig.enabled,
            command: fullSuiteValidationConfig.command,
            exit_code: null,
            timed_out: null,
            output_artifact_path: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            cycle_binding: null,
            matches_current_preflight: null,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: null,
            cycle_binding_valid: null,
            mismatch_reason: requiredForReview
                ? 'Task id is unavailable, so full-suite validation evidence cannot be resolved.'
                : null
        };
    }

    const normalizedArtifactPath = normalizePath(artifactPath);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            required_for_review: requiredForReview,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: null,
            available: false,
            status: null,
            enabled: fullSuiteValidationConfig.enabled,
            command: fullSuiteValidationConfig.command,
            exit_code: null,
            timed_out: null,
            output_artifact_path: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            cycle_binding: null,
            matches_current_preflight: null,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: null,
            cycle_binding_valid: null,
            mismatch_reason: requiredForReview
                ? 'Full-suite validation evidence artifact is missing.'
                : null
        };
    }

    try {
        const raw = asPlainRecord(JSON.parse(fs.readFileSync(artifactPath, 'utf8'))) || {};
        const cycleBinding = asPlainRecord(raw.cycle_binding) as FullSuiteValidationResult['cycle_binding'] | null;
        let matchesCurrentPreflight: boolean | null = null;
        let matchesCurrentCompileGate: boolean | null = null;
        let cycleBindingValid: boolean | null = null;
        let mismatchReason: string | null = null;
        if (cycleBinding) {
            const expectedPreflightPath = normalizePath(options.preflightPath);
            const actualPreflightPath = normalizeNullablePath(cycleBinding.preflight_path);
            const actualPreflightSha256 = String(cycleBinding.preflight_sha256 || '').trim().toLowerCase();
            const actualTaskId = String(cycleBinding.task_id || '').trim();
            const actualCompileGateTimestamp = cycleBinding.compile_gate_timestamp == null
                ? null
                : String(cycleBinding.compile_gate_timestamp || '').trim() || null;
            const currentCycle = compileGateEvidence.cycle_binding;
            const candidateCycle = getCycleBindingSnapshotFromPayload({ cycle_binding: cycleBinding }, options.repoRoot);
            const sameScopeBinding = taskCycleScopeBindingsMatch(currentCycle, candidateCycle);
            matchesCurrentPreflight = actualPreflightPath === expectedPreflightPath
                && !!actualPreflightSha256
                && actualPreflightSha256 === String(options.preflightSha256 || '').trim().toLowerCase();
            matchesCurrentCompileGate = !!compileGateEvidence.timeline_timestamp_utc
                && actualCompileGateTimestamp === compileGateEvidence.timeline_timestamp_utc;
            cycleBindingValid = actualTaskId === String(options.taskId || '').trim()
                && (
                    (matchesCurrentPreflight === true && matchesCurrentCompileGate === true)
                    || (
                        sameScopeBinding === true
                        && actualPreflightPath === expectedPreflightPath
                    )
                );
            const mismatchReasons: string[] = [];
            if (actualTaskId !== String(options.taskId || '').trim()) {
                mismatchReasons.push('task id');
            }
            if (!matchesCurrentPreflight && !cycleBindingValid) {
                mismatchReasons.push('preflight artifact');
            }
            if (!matchesCurrentCompileGate && !cycleBindingValid) {
                mismatchReasons.push('compile gate cycle');
            }
            if (mismatchReasons.length > 0) {
                mismatchReason = `Full-suite validation cycle binding does not match the current ${mismatchReasons.join(', ')}.`;
            }
        } else {
            matchesCurrentPreflight = false;
            matchesCurrentCompileGate = false;
            cycleBindingValid = false;
            mismatchReason = 'Full-suite validation artifact is missing cycle_binding.';
        }

        return {
            required_for_review: requiredForReview,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: fileSha256(artifactPath),
            available: true,
            status: normalizeFullSuiteValidationStatus(raw.status),
            enabled: normalizeNullableBoolean(raw.enabled),
            command: typeof raw.command === 'string' ? raw.command : null,
            exit_code: normalizeNullableNumber(raw.exit_code),
            timed_out: normalizeNullableBoolean(raw.timed_out),
            output_artifact_path: normalizeNullablePath(raw.output_artifact_path),
            compact_summary: toStringArray(raw.compact_summary, { trimValues: true }),
            violations: toStringArray(raw.violations, { trimValues: true }),
            warnings: toStringArray(raw.warnings, { trimValues: true }),
            cycle_binding: cycleBinding,
            matches_current_preflight: matchesCurrentPreflight,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: matchesCurrentCompileGate,
            cycle_binding_valid: cycleBindingValid,
            mismatch_reason: mismatchReason
        };
    } catch (error) {
        return {
            required_for_review: requiredForReview,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: fileSha256(artifactPath),
            available: false,
            status: null,
            enabled: null,
            command: null,
            exit_code: null,
            timed_out: null,
            output_artifact_path: null,
            compact_summary: [],
            violations: [],
            warnings: [],
            cycle_binding: null,
            matches_current_preflight: null,
            compile_gate_artifact_path: compileGateEvidence.artifact_path,
            compile_gate_timestamp_utc: compileGateEvidence.timeline_timestamp_utc,
            compile_gate_status: compileGateEvidence.status,
            matches_current_compile_gate: null,
            cycle_binding_valid: null,
            mismatch_reason: 'Full-suite validation evidence artifact could not be parsed.',
            parse_error: error instanceof Error ? error.message : String(error)
        };
    }
}

function buildFullSuiteValidationEvidenceMarkdown(evidence: ReviewContextFullSuiteValidationEvidence): string[] {
    const lines = [
        '## Full-Suite Validation Evidence',
        `- Required before this review: ${evidence.required_for_review ? 'yes' : 'no'}`,
        `- Evidence artifact: ${evidence.artifact_path || 'unavailable'}`,
        `- Evidence sha256: ${evidence.artifact_sha256 || 'unavailable'}`,
        `- Status: ${evidence.status || 'unavailable'}`,
        `- Enabled: ${evidence.enabled == null ? 'unknown' : String(evidence.enabled)}`,
        `- Command: ${evidence.command || 'unavailable'}`,
        `- Exit code: ${evidence.exit_code == null ? 'unknown' : String(evidence.exit_code)}`,
        `- Timed out: ${evidence.timed_out == null ? 'unknown' : String(evidence.timed_out)}`,
        `- Output artifact: ${evidence.output_artifact_path || 'unavailable'}`,
        `- Matches current preflight: ${evidence.matches_current_preflight == null ? 'unknown' : String(evidence.matches_current_preflight)}`,
        `- Compile gate artifact: ${evidence.compile_gate_artifact_path || 'unavailable'}`,
        `- Compile gate timestamp: ${evidence.compile_gate_timestamp_utc || 'unavailable'}`,
        `- Compile gate status: ${evidence.compile_gate_status || 'unavailable'}`,
        `- Matches current compile gate: ${evidence.matches_current_compile_gate == null ? 'unknown' : String(evidence.matches_current_compile_gate)}`,
        `- Cycle binding valid: ${evidence.cycle_binding_valid == null ? 'unknown' : String(evidence.cycle_binding_valid)}`
    ];
    if (evidence.mismatch_reason) {
        lines.push(`- Mismatch reason: ${evidence.mismatch_reason}`);
    }
    lines.push('- Compact summary:');
    if (evidence.compact_summary.length === 0) {
        lines.push('  - none');
    } else {
        for (const summaryLine of evidence.compact_summary) {
            lines.push(`  - ${summaryLine}`);
        }
    }
    if (evidence.violations.length > 0) {
        lines.push('- Violations:');
        for (const violation of evidence.violations) {
            lines.push(`  - ${violation}`);
        }
    }
    if (evidence.warnings.length > 0) {
        lines.push('- Warnings:');
        for (const warning of evidence.warnings) {
            lines.push(`  - ${warning}`);
        }
    }
    return lines;
}

function assertArtifactRealpathInsideRepo(
    repoRoot: string,
    artifactPath: string,
    label: string,
    options: { allowMissing?: boolean } = {}
): void {
    if (!isPathRealpathInsideRoot(artifactPath, repoRoot, { allowMissing: options.allowMissing === true })) {
        throw new Error(`${label} must resolve inside repo root without symlink or junction escape: ${normalizePath(artifactPath)}.`);
    }
}

function buildRuleContextSectionsCacheKey(
    selectedRulePaths: readonly string[],
    stripExamples: boolean,
    stripCodeBlocks: boolean
): string {
    return JSON.stringify({
        selectedRulePaths,
        stripExamples,
        stripCodeBlocks
    });
}

/**
 * Build review context for a specific review type and depth.
 * Builds the review-context artifact shape for the Node gate runtime.
 */
export function buildReviewContext(options: BuildReviewContextOptions) {
    const reviewType = options.reviewType;
    const depth = options.depth;
    const preflightPath = options.preflightPath;
    const tokenEconomyConfigPath = options.tokenEconomyConfigPath;
    const scopedDiffMetadataPath = options.scopedDiffMetadataPath;
    const outputPath = options.outputPath;
    const repoRoot = options.repoRoot;

    assertArtifactRealpathInsideRepo(repoRoot, preflightPath, 'PreflightPath');
    assertArtifactRealpathInsideRepo(repoRoot, outputPath, 'OutputPath', { allowMissing: true });
    if (scopedDiffMetadataPath) {
        assertArtifactRealpathInsideRepo(repoRoot, scopedDiffMetadataPath, 'ScopedDiffMetadataPath', { allowMissing: true });
    }
    if (tokenEconomyConfigPath) {
        assertArtifactRealpathInsideRepo(repoRoot, tokenEconomyConfigPath, 'TokenEconomyConfigPath', { allowMissing: true });
    }

    const preflight = options.preflightPayload ?? JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    let tokenConfig: TokenEconomyConfig = options.tokenEconomyConfigData || {};
    if (
        !options.tokenEconomyConfigData
        && tokenEconomyConfigPath
        && fs.existsSync(tokenEconomyConfigPath)
        && fs.statSync(tokenEconomyConfigPath).isFile()
    ) {
        tokenConfig = JSON.parse(fs.readFileSync(tokenEconomyConfigPath, 'utf8')) as TokenEconomyConfig;
    }

    const enabled = parseBool(tokenConfig.enabled);
    const enabledDepths = [...new Set(
        toStringArray(tokenConfig.enabled_depths).filter(s => /^\d+$/.test(String(s).trim())).map(s => parseInt(String(s).trim(), 10))
    )].sort();
    const tokenEconomyActive = enabled && enabledDepths.includes(depth);

    const rulePack = getRulePack(reviewType);
    const fullRuleFiles = [...rulePack.full];
    const selectedRuleFiles = (!tokenEconomyActive || depth >= 3)
        ? [...fullRuleFiles]
        : selectRulePackFiles(reviewType, depth);

    const omittedRuleFiles = fullRuleFiles.filter(f => !selectedRuleFiles.includes(f));
    const ruleFilesBasePath = resolveGateExecutionPathPosix(repoRoot, 'live/docs/agent-rules');
    const selectedRulePaths = selectedRuleFiles.map(f => `${ruleFilesBasePath}/${f}`);
    const fullRulePaths = fullRuleFiles.map(f => `${ruleFilesBasePath}/${f}`);
    const omittedRulePaths = omittedRuleFiles.map(f => `${ruleFilesBasePath}/${f}`);
    const rulePackOmissionReason = omittedRulePaths.length > 0 ? 'deferred_by_depth' : 'none';

    const requiredReviews = preflight.required_reviews || {};
    const requiredReview = parseBool(requiredReviews[reviewType]);
    const taskId = String(preflight.task_id || '').trim() || null;
    const taskModeEvidence = options.taskModeEvidence || (
        taskId
            ? getTaskModeEvidence(repoRoot, taskId, options.taskModePath || '')
            : null
    );
    const runtimeIdentity = options.runtimeReviewerIdentity || resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        taskModePath: options.taskModePath || '',
        taskModeEvidence,
        allowLegacyFallback: true
    });
    const runtimeIdentityViolations = [...runtimeIdentity.violations];
    if (!runtimeIdentity.canonical_source_of_truth) {
        runtimeIdentityViolations.push('Pinned canonical_source_of_truth is missing from task-mode identity evidence.');
    }
    if (!runtimeIdentity.execution_provider) {
        runtimeIdentityViolations.push('Pinned execution_provider is missing from task-mode identity evidence.');
    }
    if (runtimeIdentity.identity_status !== 'resolved') {
        runtimeIdentityViolations.push(
            `Active runtime identity for task '${taskId || '<unknown>'}' is '${runtimeIdentity.identity_status}'. ` +
            'Re-enter task mode with explicit runtime identity before preparing review context.'
        );
    }
    if (runtimeIdentityViolations.length > 0) {
        throw new Error(
            `Review context cannot be built because runtime identity is invalid. ${runtimeIdentityViolations.join(' ')}`
        );
    }
    if (runtimeIdentity.reviewer_subagent_launch_status !== 'launchable') {
        const launchReason = runtimeIdentity.reviewer_subagent_launch_reason || 'Reviewer subagent launch is unavailable for this runtime session.';
        const launchRemediation = runtimeIdentity.reviewer_subagent_launch_remediation
            ? ` ${runtimeIdentity.reviewer_subagent_launch_remediation}`
            : '';
        throw new Error(
            `Review context cannot be built for review '${reviewType}' because delegated reviewer launch is not attested. ` +
            `${launchReason}${launchRemediation} Re-enter task mode, rerun handshake-diagnostics, and then rerun build-review-context.`
        );
    }

    // Read plan metadata from task-mode evidence (optional, never blocks)
    let planMetadata: { plan_guided: boolean; plan_path: string | null; plan_sha256: string | null; plan_summary: string | null } = {
        plan_guided: false,
        plan_path: null,
        plan_sha256: null,
        plan_summary: null
    };
    if (taskModeEvidence?.plan) {
            planMetadata = {
                plan_guided: true,
                plan_path: taskModeEvidence.plan.plan_path,
                plan_sha256: taskModeEvidence.plan.plan_sha256,
                plan_summary: taskModeEvidence.plan.plan_summary
            };
    }

    const stripExamplesFlag = parseBool(tokenConfig.strip_examples);
    const stripCodeBlocksFlag = parseBool(tokenConfig.strip_code_blocks);
    const scopedDiffsFlag = parseBool(tokenConfig.scoped_diffs);
    const compactReviewerOutputFlag = parseBool(tokenConfig.compact_reviewer_output);
    const failTailLines = toNonNegativeInt(tokenConfig.fail_tail_lines);
    const stripExamplesApplied = tokenEconomyActive && stripExamplesFlag;
    const stripCodeBlocksApplied = tokenEconomyActive && stripCodeBlocksFlag;
    const changedFiles = readReviewContextChangedFiles(preflight.changed_files);
    const diffExpectations = buildReviewContextPreflightDiffExpectations(preflight, reviewType);
    const scopedDiffExpected = diffExpectations.expectedScopedDiff;

    let scopedDiffMetadata = null;
    if (scopedDiffMetadataPath && fs.existsSync(scopedDiffMetadataPath) && fs.statSync(scopedDiffMetadataPath).isFile()) {
        try {
            scopedDiffMetadata = JSON.parse(fs.readFileSync(scopedDiffMetadataPath, 'utf8'));
        } catch (exc) {
            scopedDiffMetadata = { metadata_path: normalizePath(scopedDiffMetadataPath), parse_error: String(exc) };
        }
    }

    const omittedSections = [];
    if (tokenEconomyActive && depth === 1) {
        omittedSections.push({
            section: 'rule_pack',
            reason: 'deferred_by_depth',
            details: 'Only minimal reviewer rule context is selected at depth=1.'
        });
    }
    if (tokenEconomyActive && stripExamplesFlag) {
        omittedSections.push({
            section: 'examples',
            reason: 'token_economy_strip_examples',
            details: 'Examples may be omitted from reviewer context.'
        });
    }
    if (tokenEconomyActive && stripCodeBlocksFlag) {
        omittedSections.push({
            section: 'code_blocks',
            reason: 'token_economy_strip_code_blocks',
            details: 'Code blocks may be omitted from reviewer context.'
        });
    }

    const tokenEconomyFlags = {
        enabled: !!enabled,
        enabled_depths: enabledDepths,
        strip_examples: stripExamplesFlag,
        strip_code_blocks: stripCodeBlocksFlag,
        scoped_diffs: scopedDiffsFlag,
        compact_reviewer_output: compactReviewerOutputFlag,
        fail_tail_lines: failTailLines
    };
    const tokenEconomyOmissionReason = (omittedSections.length > 0 || omittedRulePaths.length > 0) ? 'token_economy_compaction' : 'none';
    const requiredReviewTypes = summarizeBooleanRecord(preflight.required_reviews);
    const activeTriggers = summarizeBooleanRecord(preflight.triggers);
    const preflightMetrics = asPlainRecord(preflight.metrics);
    const treeState = buildReviewTreeState({
        repoRoot,
        detectionSource: preflight.detection_source,
        includeUntracked: shouldIncludeUntrackedForReviewTreeState(preflight),
        changedFiles,
        metrics: preflightMetrics
    });
    const treeStateViolations = getReviewTreeStateBlockingViolations(treeState);
    if (treeStateViolations.length > 0) {
        throw new Error(
            `Review context cannot be built because reviewer-visible tree state is incoherent. ` +
            treeStateViolations.join(' ')
        );
    }
    const gitDiff = buildGitDiffSummary(repoRoot, changedFiles, preflight, preflightPath);
    const preflightSha256 = fileSha256(preflightPath);
    const fullSuiteValidationEvidence = buildFullSuiteValidationEvidence({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        preflightSha256
    });
    const taskScopeMarkdown = buildTaskScopeMarkdown({
        taskId,
        reviewType,
        depth,
        preflightPath,
        preflightSha256,
        preflight,
        changedFiles,
        requiredReviews: requiredReviewTypes,
        activeTriggers,
        gitDiff,
        treeState,
        fullSuiteValidation: fullSuiteValidationEvidence
    });

    const ruleContextArtifactPath = outputPath.replace(/\.json$/, '.md');
    assertArtifactRealpathInsideRepo(repoRoot, ruleContextArtifactPath, 'RuleContextArtifactPath', { allowMissing: true });
    const readFileCallback = (rulePath: string): string => {
        if (options.ruleFileContentCache?.has(rulePath)) {
            return String(options.ruleFileContentCache.get(rulePath) || '');
        }
        const resolved = path.isAbsolute(rulePath) ? rulePath : path.resolve(repoRoot, rulePath);
        try {
            const content = fs.readFileSync(resolved, 'utf8');
            options.ruleFileContentCache?.set(rulePath, content);
            return content;
        } catch {
            options.ruleFileContentCache?.set(rulePath, '');
            return '';
        }
    };
    const ruleContextSectionsCacheKey = buildRuleContextSectionsCacheKey(
        selectedRulePaths,
        stripExamplesApplied,
        stripCodeBlocksApplied
    );
    let ruleContextSections = options.ruleContextSectionsCache?.get(ruleContextSectionsCacheKey) || null;
    if (!ruleContextSections) {
        ruleContextSections = buildReviewContextSections(selectedRulePaths, readFileCallback, {
            stripExamples: stripExamplesApplied,
            stripCodeBlocks: stripCodeBlocksApplied
        });
        options.ruleContextSectionsCache?.set(ruleContextSectionsCacheKey, ruleContextSections);
    }
    const promptArtifactText = `${taskScopeMarkdown}\n\n${ruleContextSections.artifact_text}`;

    const ruleContextArtifact = {
        artifact_path: normalizePath(ruleContextArtifactPath),
        artifact_sha256: stringSha256(promptArtifactText),
        source_file_count: ruleContextSections.source_file_count,
        strip_examples_applied: stripExamplesApplied,
        strip_code_blocks_applied: stripCodeBlocksApplied,
        summary: ruleContextSections.summary,
        source_files: ruleContextSections.source_files,
        preferred_prompt_artifact: normalizePath(ruleContextArtifactPath)
    };

    const compatibility = {
        note: 'Use nested rule_pack.* and token_economy.* fields. Legacy top-level duplicates were removed in schema_version=2.',
        legacy_top_level_fields_removed: {
            selected_rule_files: 'rule_pack.selected_rule_files',
            selected_rule_count: 'rule_pack.selected_rule_count',
            full_rule_pack_files: 'rule_pack.full_rule_pack_files',
            omitted_rule_files: 'rule_pack.omitted_rule_files',
            omitted_rule_count: 'rule_pack.omitted_rule_count',
            omission_reason: 'rule_pack.omission_reason',
            token_economy_flags: 'token_economy.flags',
            omitted_sections: 'token_economy.omitted_sections',
            omitted_sections_count: 'token_economy.omitted_sections_count'
        }
    };

    const result = {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        depth,
        token_economy_active: !!tokenEconomyActive,
        required_review: !!requiredReview,
        preflight_path: normalizePath(preflightPath),
        preflight_sha256: preflightSha256,
        output_path: normalizePath(outputPath),
        token_economy_config_path: normalizePath(tokenEconomyConfigPath),
        compatibility,
        rule_pack: {
            selected_rule_files: selectedRulePaths,
            selected_rule_count: selectedRulePaths.length,
            full_rule_pack_files: fullRulePaths,
            omitted_rule_files: omittedRulePaths,
            omitted_rule_count: omittedRulePaths.length,
            omission_reason: rulePackOmissionReason
        },
        token_economy: {
            active: !!tokenEconomyActive,
            flags: tokenEconomyFlags,
            omitted_sections: omittedSections,
            omitted_sections_count: omittedSections.length,
            omission_reason: tokenEconomyOmissionReason
        },
        rule_context: ruleContextArtifact,
        task_scope: {
            changed_files: changedFiles,
            changed_file_count: changedFiles.length,
            required_reviews: requiredReviewTypes,
            active_triggers: activeTriggers,
            diff_stat: gitDiff.stat,
            diff: {
                available: !!gitDiff.diff,
                source: gitDiff.source,
                char_count: gitDiff.diff_char_count,
                truncated: gitDiff.diff_truncated,
                max_chars: REVIEW_CONTEXT_DIFF_MAX_CHARS,
                prompt_max_chars: reviewType === 'code' || reviewType === 'api'
                    ? REVIEW_CONTEXT_DIFF_MAX_CHARS
                    : REVIEW_CONTEXT_NON_CODE_PROMPT_DIFF_MAX_CHARS,
                command_status: gitDiff.command_status,
                error: gitDiff.error,
                cache_path: gitDiff.cache_path,
                cached: gitDiff.cached,
                diff_sha256: stringSha256(gitDiff.diff || '') || null
            }
        },
        tree_state: treeState,
        scoped_diff: {
            expected: !!scopedDiffExpected,
            metadata_path: normalizePath(scopedDiffMetadataPath),
            metadata: scopedDiffMetadata
        },
        full_suite_validation: fullSuiteValidationEvidence,
        reviewer_routing: {
            source_of_truth: runtimeIdentity.execution_provider,
            canonical_source_of_truth: runtimeIdentity.canonical_source_of_truth,
            canonical_entrypoint: runtimeIdentity.canonical_entrypoint,
            execution_provider: runtimeIdentity.execution_provider,
            execution_provider_source: runtimeIdentity.execution_provider_source,
            routed_to: runtimeIdentity.routed_to,
            provider_bridge: runtimeIdentity.provider_bridge,
            identity_status: runtimeIdentity.identity_status,
            capability_level: runtimeIdentity.capability_level,
            delegation_required: !!requiredReview && runtimeIdentity.delegation_required,
            expected_execution_mode: runtimeIdentity.expected_execution_mode,
            fallback_allowed: runtimeIdentity.fallback_allowed,
            fallback_reason_required: runtimeIdentity.fallback_reason_required,
            reviewer_subagent_launch_status: runtimeIdentity.reviewer_subagent_launch_status,
            reviewer_subagent_launch_route: runtimeIdentity.reviewer_subagent_launch_route,
            reviewer_subagent_launch_reason: runtimeIdentity.reviewer_subagent_launch_reason,
            reviewer_subagent_launch_remediation: runtimeIdentity.reviewer_subagent_launch_remediation,
            reviewer_execution_mode_required: !!requiredReview,
            reviewer_identity_required: !!requiredReview,
            fresh_context_required: !!requiredReview,
            fresh_context_instruction: requiredReview ? REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION : null,
            opaque_handoff_required: !!requiredReview,
            opaque_handoff_instruction: requiredReview ? REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION : null,
            reviewer_session_reuse_forbidden: !!requiredReview,
            reviewer_session_reuse_note: requiredReview ? REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION : null,
            cleanup_required_after_receipt: !!requiredReview,
            cleanup_instruction: requiredReview ? REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION : null,
            actual_execution_mode: null as string | null,
            reviewer_session_id: null as string | null,
            fallback_reason: null as string | null,
            note: runtimeIdentity.note,
            identity_violations: runtimeIdentity.violations
        },
        plan: planMetadata
    };

    const diffMaterialViolations = getReviewContextContractViolations({
        contextPath: outputPath,
        reviewContext: result,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedPreflightPath: preflightPath,
        expectedPreflightSha256: preflightSha256,
        requireReviewType: true,
        requireTaskId: true,
        requirePreflightPath: true,
        requirePreflightSha256: true,
        ...diffExpectations
    });
    if (diffMaterialViolations.length > 0) {
        throw new Error(
            `Review context cannot be built because required diff material is missing. ` +
            diffMaterialViolations.join(' ')
        );
    }

    withReviewArtifactLock(outputPath, () => {
        writeArtifactFileAtomically(ruleContextArtifactPath, promptArtifactText);
        writeArtifactFileAtomically(outputPath, JSON.stringify(result, null, 2) + '\n');
    });

    return result;
}
