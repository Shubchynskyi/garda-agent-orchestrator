import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    auditReviewArtifactCompaction,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatReviewVerdictTokenList
} from '../../../gate-runtime/review-context';
import { getWorkspaceSnapshot } from '../../../gates/compile-gate';
import * as gateHelpers from '../../../gates/helpers';
import {
    REVIEW_CONTRACTS
} from '../../../gates/required-reviews-check';
import {
    getWorkspaceSnapshotCached
} from '../../../gates/workspace-snapshot-cache';
import {
    resolveDefaultReviewsPath,
    resolveReviewContextPath
} from '../gates-artifacts';
import {
    toReviewCompactionAuditSummary
} from '../gates-formatter';
import {
    expandValueList
} from '../gates-parser';
import { requireResolvedPath } from '../shared-command-utils';
import {
    getErrorMessage,
    isPlainObject
} from './gate-flow-helpers';

type WorkspaceSnapshot = ReturnType<typeof getWorkspaceSnapshot>;
type ReviewCompactionAudit = ReturnType<typeof auditReviewArtifactCompaction>;

const reviewContracts = REVIEW_CONTRACTS as Array<[string, string]>;

export interface ReviewArtifactCheckEntry {
    review: string;
    path: string;
    pass_token: string;
    present: boolean;
    token_found: boolean;
    sha256: string | null;
    review_context_path: string | null;
    review_context_present: boolean;
    review_context_valid: boolean;
    compaction_audit: ReviewCompactionAudit | null;
}

export interface ReviewArtifactsAuditResult {
    reviews_root: string;
    checked: ReviewArtifactCheckEntry[];
    violations: string[];
    compaction_warnings: string[];
    compaction_warning_count: number;
}

export function isReviewArtifactPathInsideRoots(
    repoRoot: string,
    reviewsRoot: string,
    artifactPath: string,
    options: { allowMissing?: boolean } = {}
): boolean {
    return gateHelpers.isPathRealpathInsideRoot(reviewsRoot, repoRoot, { allowMissing: true })
        && gateHelpers.isPathRealpathInsideRoot(artifactPath, repoRoot, options)
        && gateHelpers.isPathRealpathInsideRoot(artifactPath, reviewsRoot, options);
}

export function formatReviewArtifactRootEscapeViolation(reviewsRoot: string): string {
    return `ReviewsRoot must resolve inside repo root without symlink or junction escape: ${gateHelpers.normalizePath(reviewsRoot)}`;
}

export function formatReviewArtifactPathEscapeViolation(label: string, artifactPath: string): string {
    return `${label} must resolve inside repo root and reviews root without symlink or junction escape: ${gateHelpers.normalizePath(artifactPath)}`;
}

export interface CompileGateEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string | null;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_preflight_path: string | null;
    evidence_preflight_hash: string | null;
    evidence_source: string | null;
    evidence_scope_detection_source: string | null;
    evidence_scope_include_untracked: boolean | null;
    evidence_scope_changed_files: string[];
    evidence_scope_changed_files_count: number;
    evidence_scope_changed_lines_total: number;
    evidence_scope_changed_files_sha256: string | null;
    evidence_scope_sha256: string | null;
    status: string;
}

export interface CompileScopeDriftResult {
    status: string;
    detection_source: string | null;
    include_untracked: boolean | null;
    current_scope: WorkspaceSnapshot | null;
    evidence_scope_sha256: string | null;
    evidence_changed_files_sha256: string | null;
    evidence_changed_lines_total: number | null;
    violations: string[];
}

export function testReviewArtifacts(
    repoRoot: string,
    resolvedTaskId: string | null,
    requiredReviews: Record<string, boolean>,
    verdicts: Record<string, string>,
    skipReviewsList: string[],
    reviewsRootValue: string
): ReviewArtifactsAuditResult {
    const reviewsRoot = reviewsRootValue
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(reviewsRootValue, repoRoot, { allowMissing: true }),
            'ReviewsRoot'
        )
        : gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const result: ReviewArtifactsAuditResult = {
        reviews_root: gateHelpers.normalizePath(reviewsRoot),
        checked: [],
        violations: [],
        compaction_warnings: [],
        compaction_warning_count: 0
    };
    if (!gateHelpers.isPathRealpathInsideRoot(reviewsRoot, repoRoot, { allowMissing: true })) {
        result.violations.push(formatReviewArtifactRootEscapeViolation(reviewsRoot));
        return result;
    }

    const skipSet = new Set(skipReviewsList.map(function (item: string) { return String(item || '').toLowerCase(); }));

    for (const [reviewKey, passToken] of reviewContracts) {
        if (!requiredReviews[reviewKey]) {
            continue;
        }
        const actualVerdict = verdicts[reviewKey] || 'NOT_REQUIRED';
        if (actualVerdict !== passToken || skipSet.has(reviewKey)) {
            continue;
        }

        const artifactPath = path.join(reviewsRoot, `${resolvedTaskId}-${reviewKey}.md`);
        const entry: ReviewArtifactCheckEntry = {
            review: reviewKey,
            path: gateHelpers.normalizePath(artifactPath),
            pass_token: passToken,
            present: false,
            token_found: false,
            sha256: null,
            review_context_path: null,
            review_context_present: false,
            review_context_valid: false,
            compaction_audit: null
        };

        if (!isReviewArtifactPathInsideRoots(repoRoot, reviewsRoot, artifactPath, { allowMissing: true })) {
            result.violations.push(formatReviewArtifactPathEscapeViolation('Review artifact path', artifactPath));
            result.checked.push(entry);
            continue;
        }

        if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
            result.violations.push(`Review artifact not found for claimed '${passToken}': ${entry.path}`);
            result.checked.push(entry);
            continue;
        }

        entry.present = true;
        entry.sha256 = gateHelpers.fileSha256(artifactPath);
        const content = fs.readFileSync(artifactPath, 'utf8');
        const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
        const acceptedTokens = buildReviewVerdictTokenSet(reviewKey, passToken, failToken);
        entry.token_found = extractReviewVerdictToken(content, passToken, failToken, reviewKey) === passToken;
        if (!entry.token_found) {
            result.violations.push(
                `Review artifact '${entry.path}' does not contain an accepted pass token ` +
                `(${formatReviewVerdictTokenList(acceptedTokens.passTokens)}).`
            );
        }

        let reviewContextPath: string | null = null;
        let reviewContextPathSafe = true;
        try {
            reviewContextPath = resolveReviewContextPath(reviewsRoot, resolvedTaskId, reviewKey);
            entry.review_context_path = gateHelpers.normalizePath(reviewContextPath);
            reviewContextPathSafe = isReviewArtifactPathInsideRoots(repoRoot, reviewsRoot, reviewContextPath, { allowMissing: true });
            if (!reviewContextPathSafe) {
                result.violations.push(formatReviewArtifactPathEscapeViolation('Review context artifact path', reviewContextPath));
            }
        } catch (error) {
            reviewContextPathSafe = false;
            result.violations.push(
                `Review context artifact path is invalid for claimed '${passToken}': ${getErrorMessage(error)}`
            );
        }
        let reviewContext: Record<string, unknown> | undefined;
        if (reviewContextPath && reviewContextPathSafe && fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
            entry.review_context_present = true;
            try {
                const parsedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
                reviewContext = isPlainObject(parsedReviewContext) ? parsedReviewContext : undefined;
                entry.review_context_valid = true;
            } catch (error) {
                result.compaction_warnings.push(
                    `Review context artifact '${entry.review_context_path}' is invalid JSON: ${getErrorMessage(error)}`
                );
            }
        }
        if (reviewContextPathSafe && !entry.review_context_present) {
            result.violations.push(
                `Review context artifact not found for claimed '${passToken}': ${entry.review_context_path}`
            );
        } else if (!entry.review_context_valid) {
            result.violations.push(
                `Review context artifact '${entry.review_context_path}' is invalid and cannot support a required review receipt.`
            );
        }

        const compactionAudit = auditReviewArtifactCompaction({
            artifactPath: entry.path,
            content,
            reviewContext
        });
        entry.compaction_audit = compactionAudit;
        const compactionSummary = toReviewCompactionAuditSummary(compactionAudit);
        if (compactionSummary.warning_count > 0) {
            result.compaction_warnings.push(...compactionSummary.warnings);
        }

        result.checked.push(entry);
    }

    result.compaction_warning_count = result.compaction_warnings.length;
    return result;
}

export function getCompileGateEvidence(
    repoRoot: string,
    resolvedTaskId: string | null,
    preflightPathValue: string,
    preflightHashValue: string | null,
    compileEvidencePathValue: string
): CompileGateEvidenceResult {
    const result: CompileGateEvidenceResult = {
        task_id: resolvedTaskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: null,
        evidence_outcome: null,
        evidence_task_id: null,
        evidence_preflight_path: null,
        evidence_preflight_hash: null,
        evidence_source: null,
        evidence_scope_detection_source: null,
        evidence_scope_include_untracked: null,
        evidence_scope_changed_files: [],
        evidence_scope_changed_files_count: 0,
        evidence_scope_changed_lines_total: 0,
        evidence_scope_changed_files_sha256: null,
        evidence_scope_sha256: null,
        status: 'UNKNOWN'
    };

    if (!resolvedTaskId) {
        result.status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedEvidencePath = compileEvidencePathValue
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(compileEvidencePathValue, repoRoot, { allowMissing: true }),
            'CompileEvidencePath'
        )
        : resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-compile-gate.json`);
    result.evidence_path = gateHelpers.normalizePath(resolvedEvidencePath);

    if (!gateHelpers.isPathRealpathInsideRoot(resolvedEvidencePath, repoRoot, { allowMissing: true })) {
        result.status = 'EVIDENCE_PATH_OUTSIDE_REPO';
        return result;
    }

    if (!fs.existsSync(resolvedEvidencePath) || !fs.statSync(resolvedEvidencePath).isFile()) {
        result.status = 'EVIDENCE_FILE_MISSING';
        return result;
    }

    result.evidence_hash = gateHelpers.fileSha256(resolvedEvidencePath);

    let evidenceObject: Record<string, unknown>;
    try {
        const parsedEvidence = JSON.parse(fs.readFileSync(resolvedEvidencePath, 'utf8'));
        evidenceObject = isPlainObject(parsedEvidence) ? parsedEvidence : {};
    } catch (_error) {
        result.status = 'EVIDENCE_INVALID_JSON';
        return result;
    }

    result.evidence_task_id = String(evidenceObject.task_id || '');
    result.evidence_status = String(evidenceObject.status || '');
    result.evidence_outcome = String(evidenceObject.outcome || '');
    result.evidence_preflight_path = gateHelpers.normalizePath(String(evidenceObject.preflight_path || ''));
    result.evidence_preflight_hash = String(evidenceObject.preflight_hash_sha256 || '');
    result.evidence_source = String(evidenceObject.event_source || '');
    result.evidence_scope_detection_source = String(evidenceObject.scope_detection_source || '');
    result.evidence_scope_include_untracked = evidenceObject.scope_include_untracked == null ? true : !!evidenceObject.scope_include_untracked;
    result.evidence_scope_changed_files = expandValueList(evidenceObject.scope_changed_files || [], { splitDelimiters: false });
    result.evidence_scope_changed_files_count = Number.parseInt(String(evidenceObject.scope_changed_files_count || 0), 10) || 0;
    result.evidence_scope_changed_lines_total = Number.parseInt(String(evidenceObject.scope_changed_lines_total || 0), 10) || 0;
    result.evidence_scope_changed_files_sha256 = String(evidenceObject.scope_changed_files_sha256 || '');
    result.evidence_scope_sha256 = String(evidenceObject.scope_sha256 || '');

    if ((result.evidence_task_id || '').trim() !== resolvedTaskId) {
        result.status = 'EVIDENCE_TASK_MISMATCH';
        return result;
    }
    if ((result.evidence_source || '').trim().toLowerCase() !== 'compile-gate') {
        result.status = 'EVIDENCE_SOURCE_INVALID';
        return result;
    }
    if ((result.evidence_preflight_hash || '').trim().toLowerCase() !== String(preflightHashValue || '').trim().toLowerCase()) {
        result.status = 'EVIDENCE_PREFLIGHT_HASH_MISMATCH';
        return result;
    }
    if (result.evidence_preflight_path) {
        const expectedPreflightPath = gateHelpers.normalizePath(preflightPathValue);
        if (result.evidence_preflight_path.toLowerCase() !== expectedPreflightPath.toLowerCase()) {
            result.status = 'EVIDENCE_PREFLIGHT_PATH_MISMATCH';
            return result;
        }
    }
    if (!result.evidence_scope_detection_source || !result.evidence_scope_changed_files_sha256 || !result.evidence_scope_sha256) {
        result.status = 'EVIDENCE_SCOPE_MISSING';
        return result;
    }
    if ((result.evidence_status || '').trim().toUpperCase() === 'PASSED' && (result.evidence_outcome || '').trim().toUpperCase() === 'PASS') {
        result.status = 'PASS';
        return result;
    }
    result.status = 'EVIDENCE_NOT_PASS';
    return result;
}

export function testCompileScopeDrift(
    repoRoot: string,
    compileEvidence: CompileGateEvidenceResult | null
): CompileScopeDriftResult {
    const result: CompileScopeDriftResult = {
        status: 'UNKNOWN',
        detection_source: null,
        include_untracked: null,
        current_scope: null,
        evidence_scope_sha256: null,
        evidence_changed_files_sha256: null,
        evidence_changed_lines_total: null,
        violations: []
    };

    if (!compileEvidence || !compileEvidence.evidence_scope_detection_source) {
        result.status = 'EVIDENCE_SCOPE_MISSING';
        result.violations.push('Compile gate evidence does not include scope snapshot.');
        return result;
    }

    const snapshot = getWorkspaceSnapshotCached(
        repoRoot,
        compileEvidence.evidence_scope_detection_source,
        !!compileEvidence.evidence_scope_include_untracked,
        compileEvidence.evidence_scope_changed_files,
        { noCache: true }
    );
    result.status = 'PASS';
    result.detection_source = compileEvidence.evidence_scope_detection_source;
    result.include_untracked = !!compileEvidence.evidence_scope_include_untracked;
    result.current_scope = snapshot;
    result.evidence_scope_sha256 = compileEvidence.evidence_scope_sha256;
    result.evidence_changed_files_sha256 = compileEvidence.evidence_scope_changed_files_sha256;
    result.evidence_changed_lines_total = compileEvidence.evidence_scope_changed_lines_total;

    if (compileEvidence.evidence_scope_sha256 !== snapshot.scope_sha256) {
        result.violations.push('Workspace scope fingerprint changed after compile gate.');
    }
    if (compileEvidence.evidence_scope_changed_files_sha256 !== snapshot.changed_files_sha256) {
        result.violations.push('Workspace changed_files fingerprint differs from compile evidence.');
    }
    if (compileEvidence.evidence_scope_changed_lines_total !== snapshot.changed_lines_total) {
        result.violations.push(
            `Workspace changed_lines_total=${snapshot.changed_lines_total} differs from compile evidence changed_lines_total=${compileEvidence.evidence_scope_changed_lines_total}.`
        );
    }
    if (result.violations.length > 0) {
        result.status = 'DRIFT_DETECTED';
    }
    return result;
}
