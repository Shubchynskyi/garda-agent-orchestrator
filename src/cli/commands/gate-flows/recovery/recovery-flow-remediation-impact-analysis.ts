import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    extractGuardedIgnoredRemediationTargets,
    type GuardedIgnoredRemediationTarget
} from '../../../../gates/review-remediation/ignored-remediation-targets';
import { normalizeChangedFiles } from './recovery-flow-shared';
import type {
    RestartReviewCycleCommandOptions,
    ReviewRemediationImpactAnalysis
} from './recovery-flow-types';

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
