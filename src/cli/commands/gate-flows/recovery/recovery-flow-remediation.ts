import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeReviewArtifactJson } from '../../../../gate-runtime/review-artifacts';
import { getWorkspaceSnapshot } from '../../../../gates/compile/compile-gate';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    assessReviewRemediationScopeBoundary,
    getTaskManualValidationBoundaryFiles,
    isTestLikeRemediationPath
} from '../../../../gates/review-remediation/review-remediation-scope-boundary';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    ResolvedReplayScope,
    RestartReviewCycleCommandOptions,
    ReviewRemediationFixClassification,
    ReviewRemediationImpactAnalysis,
    ReviewRemediationScopeBoundary,
    ReviewRemediationScopeCategory,
    ReviewRemediationSemanticCategory
} from './recovery-flow-types';

export { assessReviewRemediationScopeBoundary, getTaskManualValidationBoundaryFiles };

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getPreflightReuseBlockReason(preflightPayload?: unknown): string | null {
    if (!isRecord(preflightPayload) || !isRecord(preflightPayload.triggers)) {
        return null;
    }
    const changedProtectedFiles = Array.isArray(preflightPayload.triggers.changed_protected_files)
        ? preflightPayload.triggers.changed_protected_files
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
        : [];
    if (preflightPayload.triggers.protected_control_plane_changed === true || changedProtectedFiles.length > 0) {
        return changedProtectedFiles.length > 0
            ? `refreshed preflight includes protected-control-plane changes: ${changedProtectedFiles.join(', ')}`
            : 'refreshed preflight includes protected-control-plane changes';
    }
    return null;
}

const REMEDIATION_IMPACT_ANALYSIS_MIN_CHARS = 120;
export const REMEDIATION_IMPACT_ANALYSIS_TOPICS = Object.freeze([
    'reviewer finding',
    'intended fix',
    'affected files and contracts',
    'api/runtime/artifact/test impact',
    'possible side effects',
    'required targeted checks',
    'scope or review-type changes',
    'related blocker or follow-up decision'
]);
const REMEDIATION_IMPACT_ANALYSIS_PLACEHOLDERS = Object.freeze([
    '<replace with main-agent remediation impact analysis>',
    '<analysis>',
    '<reviewer finding; intended fix',
    'reviewer finding; intended fix; affected files/contracts'
]);
const REMEDIATION_IMPACT_ANALYSIS_TOPIC_CHECKS = Object.freeze([
    { topic: 'reviewer finding', pattern: /\b(reviewer\s+finding|finding|reviewer)\b/iu },
    { topic: 'intended fix', pattern: /\b(intended\s+fix|fix)\b/iu },
    { topic: 'affected files and contracts', pattern: /\b(affected\s+files?|affected\s+contracts?|contracts?)\b/iu },
    { topic: 'api/runtime/artifact/test impact', pattern: /\b(api|runtime|artifact|test)\s+impact\b|\bimpact\b/iu },
    { topic: 'possible side effects', pattern: /\b(possible\s+side\s+effects?|side\s+effects?|risk)\b/iu },
    { topic: 'required targeted checks', pattern: /\b(required\s+targeted\s+checks?|targeted\s+checks?|checks?|validation)\b/iu },
    { topic: 'scope or review-type changes', pattern: /\b(scope|review[-\s]?type|review\s+impact)\b/iu },
    { topic: 'related blocker or follow-up decision', pattern: /\b(related\s+blocker|follow[-\s]?up|separate\s+task|in[-\s]?scope)\b/iu }
]);
const REMEDIATION_IMPACT_ANALYSIS_DETAIL_MIN_CHARS = 8;
const REMEDIATION_IMPACT_ANALYSIS_FILE_MAX_BYTES = 64 * 1024;

function normalizeImpactAnalysisText(value: unknown): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return Object.entries(record)
            .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && String(entryValue).trim())
            .map(([key, entryValue]) => `${key}: ${Array.isArray(entryValue) ? entryValue.join(', ') : String(entryValue).trim()}`)
            .join('; ');
    }
    return String(value || '').trim();
}

function isPathInsideDirectory(candidatePath: string, rootPath: string): boolean {
    const relativePath = path.relative(rootPath, candidatePath);
    return relativePath === '' || Boolean(relativePath) && !relativePath.startsWith('..') && !path.isAbsolute(relativePath);
}

function readImpactAnalysisPath(
    repoRoot: string,
    impactAnalysisPath: string
): { summary: string; source: 'file' } {
    const resolvedRepoRoot = fs.realpathSync.native(path.resolve(repoRoot));
    const candidatePath = path.isAbsolute(impactAnalysisPath)
        ? path.resolve(impactAnalysisPath)
        : path.resolve(resolvedRepoRoot, impactAnalysisPath);
    if (!isPathInsideDirectory(candidatePath, resolvedRepoRoot)) {
        throw new Error(
            'Remediation impact analysis file must stay inside the repository root: '
            + gateHelpers.normalizePath(candidatePath)
        );
    }
    const resolvedPath = candidatePath;
    if (!fs.existsSync(resolvedPath)) {
        throw new Error(`Remediation impact analysis file does not exist: ${gateHelpers.normalizePath(resolvedPath)}`);
    }
    const realImpactPath = fs.realpathSync.native(resolvedPath);
    if (!isPathInsideDirectory(realImpactPath, resolvedRepoRoot)) {
        throw new Error(
            'Remediation impact analysis file must stay inside the repository root: '
            + gateHelpers.normalizePath(realImpactPath)
        );
    }
    const stat = fs.statSync(realImpactPath);
    if (!stat.isFile()) {
        throw new Error(`Remediation impact analysis file does not exist: ${gateHelpers.normalizePath(resolvedPath)}`);
    }
    if (stat.size > REMEDIATION_IMPACT_ANALYSIS_FILE_MAX_BYTES) {
        throw new Error(
            `Remediation impact analysis file must be <= ${REMEDIATION_IMPACT_ANALYSIS_FILE_MAX_BYTES} bytes: `
            + gateHelpers.normalizePath(realImpactPath)
        );
    }
    const rawContent = fs.readFileSync(realImpactPath, 'utf8').trim();
    if (!rawContent) {
        return { summary: '', source: 'file' };
    }
    try {
        return {
            summary: normalizeImpactAnalysisText(JSON.parse(rawContent) as unknown),
            source: 'file'
        };
    } catch {
        return {
            summary: rawContent,
            source: 'file'
        };
    }
}

function getImpactAnalysisClauses(summary: string): string[] {
    return summary
        .split(/[\n;]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function stripTopicLikeText(value: string, topic: string): string {
    return value
        .replace(new RegExp(topic.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'giu'), '')
        .replace(/\b(reviewer\s+finding|finding|reviewer|intended\s+fix|fix|affected\s+files?|affected\s+contracts?|contracts?|api|runtime|artifact|test|impact|possible\s+side\s+effects?|side\s+effects?|risk|required\s+targeted\s+checks?|targeted\s+checks?|checks?|validation|scope|review[-\s]?type|review\s+impact|related\s+blocker|follow[-\s]?up|separate\s+task|in[-\s]?scope|decision)\b/giu, '')
        .replace(/[:\-()[\]{}<>"'`.,/\\|_]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function validateReviewRemediationImpactAnalysis(
    summary: string,
    affectedFiles: readonly string[]
): string[] {
    const lowerSummary = summary.toLocaleLowerCase();
    const violations: string[] = [];
    if (summary.length < REMEDIATION_IMPACT_ANALYSIS_MIN_CHARS) {
        violations.push(`analysis must be at least ${REMEDIATION_IMPACT_ANALYSIS_MIN_CHARS} characters`);
    }
    if (REMEDIATION_IMPACT_ANALYSIS_PLACEHOLDERS.some((placeholder) => lowerSummary.includes(placeholder))) {
        violations.push('analysis must replace help/command placeholders with task-specific text');
    }

    const clauses = getImpactAnalysisClauses(summary);
    for (const check of REMEDIATION_IMPACT_ANALYSIS_TOPIC_CHECKS) {
        const matchedClause = clauses.find((clause) => check.pattern.test(clause));
        if (!matchedClause) {
            violations.push(`analysis is missing topic: ${check.topic}`);
            continue;
        }
        const detail = stripTopicLikeText(matchedClause, check.topic);
        if (detail.length < REMEDIATION_IMPACT_ANALYSIS_DETAIL_MIN_CHARS) {
            violations.push(`analysis topic '${check.topic}' needs task-specific detail`);
        }
    }

    const normalizedAffectedFiles = normalizeChangedFiles(affectedFiles);
    if (
        normalizedAffectedFiles.length > 0
        && !normalizedAffectedFiles.some((entry) => lowerSummary.includes(entry.toLocaleLowerCase()))
    ) {
        violations.push(`analysis must mention at least one affected file: ${normalizedAffectedFiles.join(', ')}`);
    }

    return violations;
}

export function resolveReviewRemediationImpactAnalysis(
    repoRoot: string,
    options: RestartReviewCycleCommandOptions,
    affectedFiles: readonly string[]
): ReviewRemediationImpactAnalysis {
    const pathValue = String(options.impactAnalysisPath || '').trim();
    const source = pathValue ? readImpactAnalysisPath(repoRoot, pathValue) : {
        summary: normalizeImpactAnalysisText(options.impactAnalysis),
        source: 'inline' as const
    };
    const summary = source.summary.trim();
    const violations = validateReviewRemediationImpactAnalysis(summary, affectedFiles);
    if (violations.length > 0) {
        throw new Error(
            'restart-review-cycle requires main-agent remediation impact analysis before failed-review remediation. ' +
            `Provide --impact-analysis covering: ${REMEDIATION_IMPACT_ANALYSIS_TOPICS.join('; ')}. ` +
            `Violations: ${violations.join('; ')}.`
        );
    }
    return {
        status: 'RECORDED',
        source: source.source,
        summary,
        required_topics: [...REMEDIATION_IMPACT_ANALYSIS_TOPICS],
        affected_files: normalizeChangedFiles(affectedFiles)
    };
}

export function resolveCurrentRemediationChangedFiles(
    repoRoot: string,
    replayScope: ResolvedReplayScope
): string[] {
    const detectionSource = replayScope.useStaged
        ? (replayScope.includeUntracked ? 'git_staged_plus_untracked' : 'git_staged_only')
        : 'git_auto';
    const includeUntracked = replayScope.includeUntracked ?? !replayScope.useStaged;
    const snapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, []);
    return normalizeChangedFiles([
        ...(replayScope.changedFiles ?? []),
        ...(snapshot.changed_files as string[])
    ]);
}

function groupReviewRemediationFiles(
    files: readonly string[],
    testTriggerRegexes: readonly string[]
): Record<string, string[]> {
    const groups: Record<string, string[]> = {
        source: [],
        test: [],
        docs: [],
        config: [],
        runtime_artifact: [],
        other: []
    };
    for (const file of normalizeChangedFiles(files)) {
        if (isTestLikeRemediationPath(file, testTriggerRegexes)) {
            groups.test.push(file);
        } else if (/^(docs|docs_local)\//iu.test(file) || /\.(md|mdx)$/iu.test(file)) {
            groups.docs.push(file);
        } else if (/^(package(-lock)?\.json|tsconfig[^/]*\.json|\.github\/|live\/config\/|garda-agent-orchestrator\/live\/config\/)/iu.test(file)) {
            groups.config.push(file);
        } else if (/^(garda-agent-orchestrator\/runtime\/|runtime\/)/iu.test(file)) {
            groups.runtime_artifact.push(file);
        } else if (/^(src|bin|template|live)\//iu.test(file) || /^garda-agent-orchestrator\/(src|bin|template|live)\//iu.test(file)) {
            groups.source.push(file);
        } else {
            groups.other.push(file);
        }
    }
    return Object.fromEntries(Object.entries(groups).filter(([, entries]) => entries.length > 0));
}

function getReviewRemediationSemanticFileScope(
    scopeBoundary: ReviewRemediationScopeBoundary
): { files: string[]; source: 'expanded_files' | 'current_changed_files' } {
    const expandedFiles = normalizeChangedFiles(scopeBoundary.expandedFiles);
    if (expandedFiles.length > 0) {
        return {
            files: expandedFiles,
            source: 'expanded_files'
        };
    }
    return {
        files: scopeBoundary.currentChangedFiles,
        source: 'current_changed_files'
    };
}

function getReviewRemediationSemanticSignals(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis?: ReviewRemediationImpactAnalysis
): {
    category: ReviewRemediationSemanticCategory;
    matchedSignals: string[];
    rationale: string;
    changedFiles: string[];
    scopeSource: 'expanded_files' | 'current_changed_files';
} {
    const summary = impactAnalysis?.summary.toLocaleLowerCase() || '';
    const semanticFileScope = getReviewRemediationSemanticFileScope(scopeBoundary);
    const files = semanticFileScope.files.join('\n').toLocaleLowerCase();
    const text = `${summary}\n${files}`;
    const matches: Array<{ category: ReviewRemediationSemanticCategory; signal: string; pattern: RegExp }> = [
        {
            category: 'security_sensitive',
            signal: 'security-sensitive surface',
            pattern: /\b(security[-\s]?sensitive|auth(?:entication|orization)?|token|secret|credential|crypto|signature|provenance|trust|redaction)\b/iu
        },
        {
            category: 'api_surface',
            signal: 'public API surface',
            pattern: /\b(public\s+(?:api|surface)|api\s+surface|exported\s+(?:api|contract|symbol)|breaking\s+change)\b/iu
        },
        {
            category: 'runtime_behavior',
            signal: 'runtime behavior change',
            pattern: /\b(runtime\s+(?:behavior|deletion|change)|behavior\s+change|observable\s+behavior|execution\s+path)\b/iu
        },
        {
            category: 'test_hook_isolation',
            signal: 'test hook isolation',
            pattern: /(?:_testhooks?|test[-\s_]?hooks?|test[-\s]?only\s+hook|hook\s+isolation)/iu
        },
        {
            category: 'refactor_structure',
            signal: 'refactor structure',
            pattern: /\b(refactor(?:ing)?\s+structure|structural\s+refactor|decomposition|extraction|rename|move)\b/iu
        }
    ];
    const matched = matches.filter((entry) => entry.pattern.test(text));
    const matchedCategories = [...new Set(matched.map((entry) => entry.category))];
    if (matchedCategories.length === 1) {
        const category = matchedCategories[0] as ReviewRemediationSemanticCategory;
        return {
            category,
            matchedSignals: matched.map((entry) => entry.signal),
            rationale: `remediation impact analysis and file scope matched ${category}`,
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    if (matchedCategories.length > 1) {
        return {
            category: 'unknown',
            matchedSignals: matched.map((entry) => entry.signal),
            rationale: 'remediation matched multiple semantic classes; fail closed before reuse',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    if (
        impactAnalysis
        && scopeBoundary.status === 'OK'
        && scopeBoundary.allowedTestOnlyExpansionFiles.length > 0
        && scopeBoundary.expandedNonTestFiles.length === 0
    ) {
        return {
            category: 'test_coverage_only',
            matchedSignals: ['test-only expansion'],
            rationale: 'remediation only added classifier-recognized test coverage outside the previous failed-review scope',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    return {
        category: 'unknown',
        matchedSignals: impactAnalysis ? [] : ['missing remediation impact analysis'],
        rationale: impactAnalysis
            ? 'remediation impact analysis did not identify a single supported semantic class'
            : 'remediation impact analysis is missing; fail closed before reuse',
        changedFiles: semanticFileScope.files,
        scopeSource: semanticFileScope.source
    };
}

export function classifyReviewRemediationFix(
    scopeBoundary: ReviewRemediationScopeBoundary,
    requiredReviewTypes: readonly string[] = [],
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = [],
    preflightPayload?: unknown
): ReviewRemediationFixClassification {
    const normalizedRequiredReviewTypes = [...new Set(
        requiredReviewTypes.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    )].sort();
    const nonTestReviewTypes = normalizedRequiredReviewTypes.filter((entry) => entry !== 'test');
    const scopeCategory: ReviewRemediationScopeCategory = scopeBoundary.status === 'BLOCKED'
        ? 'expanded_non_test_blocked'
        : scopeBoundary.allowedTestOnlyExpansionFiles.length > 0
            ? 'test_only_expansion'
            : 'previous_scope_only';
    const semantic = getReviewRemediationSemanticSignals(scopeBoundary, impactAnalysis);
    const affectedFileGroups = groupReviewRemediationFiles(scopeBoundary.currentChangedFiles, testTriggerRegexes);
    const preflightReuseBlockReason = getPreflightReuseBlockReason(preflightPayload);
    const failClosed = !!preflightReuseBlockReason
        || semantic.category === 'unknown'
        || semantic.category === 'security_sensitive'
        || semantic.category === 'api_surface'
        || semantic.category === 'runtime_behavior'
        || scopeBoundary.status === 'BLOCKED';
    const classificationReason = preflightReuseBlockReason
        ? `${semantic.rationale}; ${preflightReuseBlockReason}; fail closed before reuse`
        : semantic.rationale;
    const impactAnalysisSource: ReviewRemediationFixClassification['evidence']['impact_analysis_source'] =
        impactAnalysis?.source || 'missing';
    const base = {
        status: 'CLASSIFIED' as const,
        category: semantic.category,
        scope_category: scopeCategory,
        rationale: classificationReason,
        reason: classificationReason,
        affected_file_groups: affectedFileGroups,
        evidence: {
            scope_boundary_status: scopeBoundary.status,
            impact_analysis_source: impactAnalysisSource,
            matched_signals: semantic.matchedSignals,
            semantic_changed_files: semantic.changedFiles,
            semantic_scope_source: semantic.scopeSource
        },
        review_reuse_decision_order: 'classification_before_reuse' as const
    };
    if (scopeBoundary.status === 'BLOCKED') {
        return {
            ...base,
            rationale: `${semantic.rationale}; remediation changed non-test files outside the failed-review scope`,
            reason: `${semantic.rationale}; remediation changed non-test files outside the failed-review scope`,
            non_test_review_reuse_candidate: false,
            test_review_reuse_candidate: false,
            blocked_before_reuse: true,
            invalidated_review_types: normalizedRequiredReviewTypes,
            preserved_review_types: []
        };
    }
    if (scopeBoundary.allowedTestOnlyExpansionFiles.length > 0) {
        return {
            ...base,
            non_test_review_reuse_candidate: !failClosed,
            test_review_reuse_candidate: false,
            blocked_before_reuse: false,
            invalidated_review_types: normalizedRequiredReviewTypes.includes('test')
                ? ['test', ...(failClosed ? nonTestReviewTypes : [])].sort()
                : failClosed ? nonTestReviewTypes : [],
            preserved_review_types: failClosed ? [] : nonTestReviewTypes
        };
    }
    if (semantic.category === 'test_hook_isolation' && !failClosed) {
        const invalidatedReviewTypes = normalizedRequiredReviewTypes.includes('code') ? ['code'] : [];
        return {
            ...base,
            non_test_review_reuse_candidate: true,
            test_review_reuse_candidate: true,
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: normalizedRequiredReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
        };
    }
    if (semantic.category === 'refactor_structure' && !failClosed) {
        const invalidatedReviewTypes = normalizedRequiredReviewTypes.includes('refactor') ? ['refactor'] : [];
        return {
            ...base,
            non_test_review_reuse_candidate: true,
            test_review_reuse_candidate: true,
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: normalizedRequiredReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
        };
    }
    return {
        ...base,
        non_test_review_reuse_candidate: !failClosed,
        test_review_reuse_candidate: !failClosed,
        blocked_before_reuse: false,
        invalidated_review_types: failClosed ? normalizedRequiredReviewTypes : [],
        preserved_review_types: failClosed ? [] : normalizedRequiredReviewTypes
    };
}

export function writeReviewRemediationCycleArtifact(
    repoRoot: string,
    taskId: string,
    artifact: Record<string, unknown>
): string {
    const artifactPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-review-remediation-cycle.json`)
    );
    writeReviewArtifactJson(artifactPath, artifact);
    return artifactPath;
}

export function resolveReviewRemediationClassifyChangedFiles(
    replayScope: ResolvedReplayScope,
    scopeBoundary: ReviewRemediationScopeBoundary
): string[] | undefined {
    if (replayScope.changedFiles === undefined) {
        return undefined;
    }
    return normalizeChangedFiles([
        ...scopeBoundary.previousChangedFiles,
        ...replayScope.changedFiles,
        ...scopeBoundary.allowedTestOnlyExpansionFiles
    ]);
}
