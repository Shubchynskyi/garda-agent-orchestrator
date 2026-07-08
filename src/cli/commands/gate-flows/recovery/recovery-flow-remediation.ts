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
import {
    extractGuardedIgnoredRemediationTargets,
    type GuardedIgnoredRemediationTarget
} from '../../../../gates/review-remediation/ignored-remediation-targets';
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

function pathsReferToSameRelativeFile(left: string, right: string): boolean {
    return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function getPreflightReuseBlockReason(
    preflightPayload?: unknown,
    remediationChangedFiles: readonly string[] = []
): string | null {
    if (!isRecord(preflightPayload) || !isRecord(preflightPayload.triggers)) {
        return null;
    }
    const changedProtectedFiles = Array.isArray(preflightPayload.triggers.changed_protected_files)
        ? normalizeChangedFiles(preflightPayload.triggers.changed_protected_files)
        : [];
    if (preflightPayload.triggers.protected_control_plane_changed === true || changedProtectedFiles.length > 0) {
        const remediationFileSet = new Set(normalizeChangedFiles(remediationChangedFiles));
        if (remediationFileSet.size > 0 && changedProtectedFiles.length > 0) {
            const protectedRemediationFiles = changedProtectedFiles.filter((protectedFile) => (
                [...remediationFileSet].some((remediationFile) => (
                    pathsReferToSameRelativeFile(protectedFile, remediationFile)
                ))
            ));
            if (protectedRemediationFiles.length === 0) {
                return null;
            }
            return `remediation delta includes protected-control-plane changes: ${protectedRemediationFiles.join(', ')}`;
        }
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

function normalizeImpactAnalysisEntryValue(value: unknown): string {
    if (Array.isArray(value)) {
        return value.map((entry) => normalizeImpactAnalysisEntryValue(entry)).filter(Boolean).join(', ');
    }
    if (value && typeof value === 'object') {
        return Object.entries(value as Record<string, unknown>)
            .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && String(entryValue).trim())
            .map(([key, entryValue]) => `${key}: ${normalizeImpactAnalysisEntryValue(entryValue)}`)
            .join(', ');
    }
    return String(value || '').trim();
}

function normalizeImpactAnalysisText(value: unknown): string {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        return Object.entries(record)
            .filter(([, entryValue]) => entryValue !== null && entryValue !== undefined && String(entryValue).trim())
            .map(([key, entryValue]) => `${key}: ${normalizeImpactAnalysisEntryValue(entryValue)}`)
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
): { summary: string; source: 'file'; ignoredRemediationTargets: GuardedIgnoredRemediationTarget[] } {
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
        return { summary: '', source: 'file', ignoredRemediationTargets: [] };
    }
    try {
        const parsed = JSON.parse(rawContent) as unknown;
        return {
            summary: normalizeImpactAnalysisText(parsed),
            source: 'file',
            ignoredRemediationTargets: extractGuardedIgnoredRemediationTargets(parsed)
        };
    } catch {
        return {
            summary: rawContent,
            source: 'file',
            ignoredRemediationTargets: []
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
        source: 'inline' as const,
        ignoredRemediationTargets: extractGuardedIgnoredRemediationTargets(options.impactAnalysis)
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
        affected_files: normalizeChangedFiles(affectedFiles),
        ignored_remediation_targets: source.ignoredRemediationTargets
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

const DEFAULT_TEST_REFACTOR_CHANGED_LINES_THRESHOLD = 20;
const TEST_DOMAIN_STRUCTURAL_PATH_PATTERN =
    /(^|\/)(?:__fixtures__|fixtures?|__mocks__|mocks?|helpers?|harness|support|setup|factories|factory|snapshots?)(?:\/|\.|-|_|$)|(?:test|spec)[-_]?(?:helpers?|fixtures?|harness|support|setup|factories?|mocks?)|(?:helpers?|fixtures?|harness|support|setup|factories?|mocks?)[-_]?(?:test|spec)/iu;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeImpactAnalysisSearchText(summary: string): string {
    return summary.replace(/\\/gu, '/').toLocaleLowerCase();
}

function findAllNeedleIndexes(haystack: string, needle: string): number[] {
    const indexes: number[] = [];
    if (!needle) {
        return indexes;
    }
    let fromIndex = 0;
    while (fromIndex < haystack.length) {
        const index = haystack.indexOf(needle, fromIndex);
        if (index < 0) {
            break;
        }
        indexes.push(index);
        fromIndex = index + Math.max(needle.length, 1);
    }
    return indexes;
}

function isNegatedFileMention(summary: string, index: number, needleLength: number): boolean {
    const before = summary.slice(Math.max(0, index - 120), index);
    const after = summary.slice(index + needleLength, Math.min(summary.length, index + needleLength + 140));
    const marker = '__remediation_file__';
    const around = `${before}${marker}${after}`;
    const markerPattern = escapeRegExp(marker);
    const directNegationPatterns = [
        new RegExp(`\\b(?:no|without)\\s+(?:product\\s+|source\\s+)?(?:changes?|edits?|modifications?|touches?)\\s+(?:to|in|for)?\\s*[^.;,]{0,60}${markerPattern}`, 'iu'),
        new RegExp(`\\b(?:not|never)\\s+(?:changed|modified|touched)\\s+[^.;,]{0,60}${markerPattern}`, 'iu'),
        new RegExp(`${markerPattern}[^.;,]{0,80}\\b(?:unchanged|unmodified|untouched|not\\s+(?:changed|modified|touched)|stay(?:s|ed)?\\s+unchanged|remain(?:s|ed)?\\s+unchanged)\\b`, 'iu')
    ];
    return directNegationPatterns.some((pattern) => pattern.test(around));
}

function getPositiveSummaryClauses(summary: string): string[] {
    return summary
        .replace(/\\/gu, '/')
        .split(/[.;\n\r]+/u)
        .map((clause) => clause.trim())
        .filter(Boolean)
        .filter((clause) => !/\b(?:no|not|never|without)\b[^.;\n\r]{0,80}\b(?:api|public\s+api|runtime|behavior|contract|security|artifact|product|source)\b|\b(?:api|public\s+api|runtime|behavior|contract|security|artifact|product|source)\b[^.;\n\r]{0,80}\b(?:unchanged|unmodified|untouched|not\s+(?:changed|modified|touched)|stay(?:s|ed)?\s+unchanged|remain(?:s|ed)?\s+unchanged)\b/iu.test(clause));
}

function getReviewRemediationSemanticFileScope(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = []
): { files: string[]; source: 'expanded_files' | 'impact_analysis_files' | 'current_changed_files' } {
    const expandedFiles = normalizeChangedFiles(scopeBoundary.expandedFiles);
    if (expandedFiles.length > 0) {
        return {
            files: expandedFiles,
            source: 'expanded_files'
        };
    }
    const impactAnalysisFiles = getTestOnlyImpactAnalysisFileScope(
        scopeBoundary,
        impactAnalysis,
        testTriggerRegexes
    );
    if (impactAnalysisFiles.length > 0) {
        return {
            files: impactAnalysisFiles,
            source: 'impact_analysis_files'
        };
    }
    return {
        files: scopeBoundary.currentChangedFiles,
        source: 'current_changed_files'
    };
}

function getMentionedCurrentChangedFiles(
    summary: string,
    currentChangedFiles: readonly string[]
): string[] {
    const normalizedSummary = normalizeImpactAnalysisSearchText(summary);
    return normalizeChangedFiles(currentChangedFiles).filter((entry) => {
        const normalizedEntry = entry.toLocaleLowerCase();
        const mentionIndexes = findAllNeedleIndexes(normalizedSummary, normalizedEntry);
        return mentionIndexes.some((index) => (
            !isNegatedFileMention(normalizedSummary, index, normalizedEntry.length)
        ));
    });
}

function getTestOnlyImpactAnalysisFileScope(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis: ReviewRemediationImpactAnalysis | undefined,
    testTriggerRegexes: readonly string[]
): string[] {
    if (!impactAnalysis || scopeBoundary.status !== 'OK') {
        return [];
    }
    const mentionedFiles = getMentionedCurrentChangedFiles(
        impactAnalysis.summary,
        scopeBoundary.currentChangedFiles
    );
    if (mentionedFiles.length === 0) {
        return [];
    }
    return mentionedFiles.every((entry) => isTestLikeRemediationPath(entry, testTriggerRegexes))
        ? mentionedFiles
        : [];
}

function getReviewRemediationSemanticSignals(
    scopeBoundary: ReviewRemediationScopeBoundary,
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = []
): {
    category: ReviewRemediationSemanticCategory;
    matchedSignals: string[];
    rationale: string;
    changedFiles: string[];
    scopeSource: 'expanded_files' | 'impact_analysis_files' | 'current_changed_files';
} {
    const summary = impactAnalysis?.summary || '';
    const semanticFileScope = getReviewRemediationSemanticFileScope(
        scopeBoundary,
        impactAnalysis,
        testTriggerRegexes
    );
    if (impactAnalysis && semanticFileScope.source === 'impact_analysis_files') {
        return {
            category: 'test_coverage_only',
            matchedSignals: ['test-only impact analysis files'],
            rationale: 'remediation impact analysis names only classifier-recognized test files inside the previous failed-review scope',
            changedFiles: semanticFileScope.files,
            scopeSource: semanticFileScope.source
        };
    }
    const files = semanticFileScope.files.join('\n').toLocaleLowerCase();
    const positiveSummary = getPositiveSummaryClauses(summary).join('\n').toLocaleLowerCase();
    const text = `${positiveSummary}\n${files}`;
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

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? value
        : fallback;
}

function getPreflightChangedFileStats(
    preflightPayload?: unknown,
    changedFileStatsOverride?: unknown
): Record<string, { changed_lines: number }> {
    const stats: Record<string, { changed_lines: number }> = {};
    for (const statsSource of [
        isRecord(preflightPayload) && isRecord(preflightPayload.metrics)
            ? preflightPayload.metrics.changed_file_stats
            : undefined,
        changedFileStatsOverride
    ]) {
        if (!isRecord(statsSource)) {
            continue;
        }
        for (const [rawPath, rawStats] of Object.entries(statsSource)) {
            if (!isRecord(rawStats)) {
                continue;
            }
            const [normalizedPath] = normalizeChangedFiles([rawPath]);
            if (!normalizedPath) {
                continue;
            }
            const changedLines = Number(rawStats.changed_lines);
            if (Number.isFinite(changedLines) && changedLines >= 0) {
                stats[normalizedPath] = { changed_lines: changedLines };
            }
        }
    }
    return stats;
}

function getChangedLinesForFiles(
    preflightPayload: unknown,
    files: readonly string[],
    changedFileStatsOverride?: unknown
): number | null {
    const stats = getPreflightChangedFileStats(preflightPayload, changedFileStatsOverride);
    const normalizedFiles = normalizeChangedFiles(files);
    let matchedStats = 0;
    let changedLinesTotal = 0;
    for (const file of normalizedFiles) {
        const directStats = stats[file];
        const relatedStats = directStats
            ?? Object.entries(stats).find(([statsFile]) => pathsReferToSameRelativeFile(statsFile, file))?.[1];
        if (!relatedStats) {
            continue;
        }
        matchedStats += 1;
        changedLinesTotal += relatedStats.changed_lines;
    }
    return matchedStats > 0 ? changedLinesTotal : null;
}

function getStructuralTestDomainFiles(files: readonly string[]): string[] {
    return normalizeChangedFiles(files).filter((file) => TEST_DOMAIN_STRUCTURAL_PATH_PATTERN.test(file));
}

function assessTestRefactorInvalidation(options: {
    semanticChangedFiles: readonly string[];
    scopeBoundary: ReviewRemediationScopeBoundary;
    preflightPayload?: unknown;
    changedLinesThreshold?: number;
    changedFileStats?: unknown;
}): {
    invalidatesRefactor: boolean;
    reason: string | null;
    triggerFiles: string[];
    changedLinesThreshold: number;
    changedLinesTotal: number | null;
} {
    const changedLinesThreshold = normalizePositiveInteger(
        options.changedLinesThreshold,
        DEFAULT_TEST_REFACTOR_CHANGED_LINES_THRESHOLD
    );
    const semanticChangedFiles = normalizeChangedFiles(options.semanticChangedFiles);
    const expandedTestFiles = normalizeChangedFiles(options.scopeBoundary.allowedTestOnlyExpansionFiles)
        .filter((file) => semanticChangedFiles.some((semanticFile) => pathsReferToSameRelativeFile(file, semanticFile)));
    if (expandedTestFiles.length > 0) {
        return {
            invalidatesRefactor: true,
            reason: 'new_test_file',
            triggerFiles: expandedTestFiles,
            changedLinesThreshold,
            changedLinesTotal: getChangedLinesForFiles(options.preflightPayload, semanticChangedFiles, options.changedFileStats)
        };
    }
    const structuralTestFiles = getStructuralTestDomainFiles(semanticChangedFiles);
    if (structuralTestFiles.length > 0) {
        return {
            invalidatesRefactor: true,
            reason: 'structural_test_domain_file',
            triggerFiles: structuralTestFiles,
            changedLinesThreshold,
            changedLinesTotal: getChangedLinesForFiles(options.preflightPayload, semanticChangedFiles, options.changedFileStats)
        };
    }
    const changedLinesTotal = getChangedLinesForFiles(options.preflightPayload, semanticChangedFiles, options.changedFileStats);
    if (changedLinesTotal !== null && changedLinesTotal > changedLinesThreshold) {
        return {
            invalidatesRefactor: true,
            reason: 'test_domain_changed_lines_threshold',
            triggerFiles: semanticChangedFiles,
            changedLinesThreshold,
            changedLinesTotal
        };
    }
    return {
        invalidatesRefactor: false,
        reason: null,
        triggerFiles: [],
        changedLinesThreshold,
        changedLinesTotal
    };
}

export function classifyReviewRemediationFix(
    scopeBoundary: ReviewRemediationScopeBoundary,
    requiredReviewTypes: readonly string[] = [],
    impactAnalysis?: ReviewRemediationImpactAnalysis,
    testTriggerRegexes: readonly string[] = [],
    preflightPayload?: unknown,
    options: { testRefactorChangedLinesThreshold?: number; changedFileStats?: unknown } = {}
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
    const semantic = getReviewRemediationSemanticSignals(scopeBoundary, impactAnalysis, testTriggerRegexes);
    const affectedFileGroups = groupReviewRemediationFiles(scopeBoundary.currentChangedFiles, testTriggerRegexes);
    const preflightReuseBlockReason = getPreflightReuseBlockReason(
        preflightPayload,
        semantic.category === 'test_coverage_only' ? semantic.changedFiles : []
    );
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
    const testRefactorInvalidation = assessTestRefactorInvalidation({
        semanticChangedFiles: semantic.category === 'test_coverage_only' ? semantic.changedFiles : [],
        scopeBoundary,
        preflightPayload,
        changedLinesThreshold: options.testRefactorChangedLinesThreshold,
        changedFileStats: options.changedFileStats
    });
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
            semantic_scope_source: semantic.scopeSource,
            test_refactor_trigger_reason: testRefactorInvalidation.reason,
            test_refactor_trigger_files: testRefactorInvalidation.triggerFiles,
            test_refactor_changed_lines_threshold: testRefactorInvalidation.changedLinesThreshold,
            test_refactor_changed_lines_total: testRefactorInvalidation.changedLinesTotal
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
    if (scopeBoundary.allowedTestOnlyExpansionFiles.length > 0 || semantic.category === 'test_coverage_only') {
        const testRefactorInvalidatedReviewTypes = !failClosed
            && testRefactorInvalidation.invalidatesRefactor
            && normalizedRequiredReviewTypes.includes('refactor')
            ? ['refactor']
            : [];
        const invalidatedReviewTypes = normalizedRequiredReviewTypes.includes('test')
            ? ['test', ...testRefactorInvalidatedReviewTypes, ...(failClosed ? nonTestReviewTypes : [])].sort()
            : failClosed ? nonTestReviewTypes : testRefactorInvalidatedReviewTypes;
        return {
            ...base,
            non_test_review_reuse_candidate: !failClosed,
            test_review_reuse_candidate: false,
            blocked_before_reuse: false,
            invalidated_review_types: invalidatedReviewTypes,
            preserved_review_types: failClosed
                ? []
                : nonTestReviewTypes.filter((entry) => !invalidatedReviewTypes.includes(entry))
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
    scopeBoundary: ReviewRemediationScopeBoundary,
    extraChangedFiles: readonly string[] = []
): string[] | undefined {
    const normalizedExtraChangedFiles = normalizeChangedFiles(extraChangedFiles);
    if (replayScope.changedFiles === undefined && normalizedExtraChangedFiles.length === 0) {
        return undefined;
    }
    return normalizeChangedFiles([
        ...scopeBoundary.previousChangedFiles,
        ...(replayScope.changedFiles ?? []),
        ...scopeBoundary.allowedTestOnlyExpansionFiles,
        ...normalizedExtraChangedFiles
    ]);
}
