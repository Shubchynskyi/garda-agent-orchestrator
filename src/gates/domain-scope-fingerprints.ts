import { matchAnyRegex } from '../gate-runtime/text-utils';
import { buildScopeContentFingerprint } from './compile-gate';
import {
    getClassificationConfig,
    isConfigLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath
} from './classify-change';
import { normalizePath, stringSha256, testPathPrefix } from './helpers';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from './review-reuse';

export const DOMAIN_SCOPE_NAMES = ['implementation', 'test', 'docs', 'config', 'closeout'] as const;

export type DomainScopeName = typeof DOMAIN_SCOPE_NAMES[number];

export interface DomainScopeFingerprintEntry {
    changed_files: string[];
    changed_files_count: number;
    changed_files_sha256: string | null;
    scope_content_sha256: string | null;
    scope_sha256: string | null;
}

export interface DomainScopeFingerprints {
    schema_version: 1;
    detection_source: string;
    include_untracked: boolean;
    use_staged: boolean;
    domains: Record<DomainScopeName, DomainScopeFingerprintEntry>;
    legacy: {
        review_scope_sha256: string | null;
        code_scope_sha256: string | null;
        non_test_review_scope_sha256?: string | null;
        code_review_scope_sha256?: string | null;
    };
}

const CLOSEOUT_DOC_PATH_PATTERNS = [
    '^garda-agent-orchestrator/live/docs/project-memory/'
] as const;

function normalizeDomainScopeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function normalizeDomainScopeFiles(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
}

function isCloseoutDocumentationPath(filePath: string): boolean {
    return CLOSEOUT_DOC_PATH_PATTERNS.some((pattern) => new RegExp(pattern, 'i').test(filePath));
}

function isCloseoutEvidencePath(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath);
    if (!normalizedPath) {
        return false;
    }
    if (normalizedPath === 'TASK.md') {
        return true;
    }
    if (normalizedPath.startsWith('.agents/')) {
        return true;
    }
    if (normalizedPath.startsWith('garda-agent-orchestrator/runtime/')) {
        return true;
    }
    return isCloseoutDocumentationPath(normalizedPath);
}

function classifyDomainFile(repoRoot: string, filePath: string): DomainScopeName {
    const normalizedPath = normalizePath(filePath);
    const classificationConfig = getClassificationConfig(repoRoot);
    if (isCloseoutEvidencePath(normalizedPath)) {
        return 'closeout';
    }
    if (isSafeOrdinaryDocumentationPath(normalizedPath, classificationConfig)) {
        return 'docs';
    }
    const testTriggered = matchAnyRegex(normalizedPath, classificationConfig.test_trigger_regexes, {
        skipInvalidRegex: true,
        caseInsensitive: true
    });
    if (testTriggered) {
        return 'test';
    }
    const protectedControlPlane = testPathPrefix(normalizedPath, classificationConfig.protected_control_plane_roots);
    if (protectedControlPlane && isRuntimeCodeLikePath(
        normalizedPath,
        classificationConfig.code_like_regexes,
        classificationConfig.runtime_roots
    )) {
        return 'implementation';
    }
    if (protectedControlPlane || isConfigLikePath(normalizedPath)) {
        return 'config';
    }
    return 'implementation';
}

function buildScopeFingerprintEntry(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    domainFiles: string[]
): DomainScopeFingerprintEntry {
    const changedFiles = [...new Set(domainFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    const changedFilesSha256 = stringSha256(changedFiles.join('\n'));
    const scopeContentSha256 = buildScopeContentFingerprint(repoRoot, detectionSource, changedFiles);
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(detectionSource);
    return {
        changed_files: changedFiles,
        changed_files_count: changedFiles.length,
        changed_files_sha256: changedFilesSha256,
        scope_content_sha256: scopeContentSha256,
        scope_sha256: stringSha256(
            [
                detectionSource,
                String(useStaged),
                String(includeUntracked),
                String(changedFiles.length),
                changedFilesSha256 || '',
                scopeContentSha256 || ''
            ].join('|')
        )
    };
}

export function buildDomainScopeFingerprints(options: {
    repoRoot: string;
    detectionSource: string;
    includeUntracked: boolean;
    changedFiles: string[];
}): DomainScopeFingerprints {
    const detectionSource = String(options.detectionSource || 'git_auto').trim().toLowerCase() || 'git_auto';
    const includeUntracked = options.includeUntracked === true;
    const useStaged = ['git_staged_only', 'git_staged_plus_untracked'].includes(detectionSource);
    const changedFiles = [...new Set(options.changedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    const byDomain = new Map<DomainScopeName, string[]>(
        DOMAIN_SCOPE_NAMES.map((domain) => [domain, []])
    );
    for (const changedFile of changedFiles) {
        byDomain.get(classifyDomainFile(options.repoRoot, changedFile))?.push(changedFile);
    }
    const domains = Object.fromEntries(
        DOMAIN_SCOPE_NAMES.map((domain) => [
            domain,
            buildScopeFingerprintEntry(options.repoRoot, detectionSource, includeUntracked, byDomain.get(domain) || [])
        ])
    ) as Record<DomainScopeName, DomainScopeFingerprintEntry>;
    const fingerprints: DomainScopeFingerprints = {
        schema_version: 1,
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        use_staged: useStaged,
        domains,
        legacy: {
            review_scope_sha256: null,
            code_scope_sha256: null,
            non_test_review_scope_sha256: null,
            code_review_scope_sha256: null
        }
    };
    const legacyPreflight = {
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        changed_files: changedFiles
    };
    fingerprints.legacy.review_scope_sha256 = computeReviewRelevantScopeFingerprint(
        legacyPreflight,
        options.repoRoot
    ).review_scope_sha256;
    fingerprints.legacy.non_test_review_scope_sha256 = computeReviewReuseCodeScopeFingerprint(
        'security',
        legacyPreflight,
        options.repoRoot
    ).code_scope_sha256;
    fingerprints.legacy.code_review_scope_sha256 = computeReviewReuseCodeScopeFingerprint(
        'code',
        legacyPreflight,
        options.repoRoot
    ).code_scope_sha256;
    fingerprints.legacy.code_scope_sha256 = fingerprints.legacy.code_review_scope_sha256;
    return fingerprints;
}

function isDomainScopeRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeDomainScopeFingerprintEntry(value: unknown): DomainScopeFingerprintEntry {
    const record = isDomainScopeRecord(value) ? value : {};
    return {
        changed_files: normalizeDomainScopeFiles(record.changed_files),
        changed_files_count: typeof record.changed_files_count === 'number'
            ? record.changed_files_count
            : normalizeDomainScopeFiles(record.changed_files).length,
        changed_files_sha256: normalizeDomainScopeHash(record.changed_files_sha256),
        scope_content_sha256: normalizeDomainScopeHash(record.scope_content_sha256),
        scope_sha256: normalizeDomainScopeHash(record.scope_sha256)
    };
}

export function normalizeDomainScopeFingerprints(value: unknown): DomainScopeFingerprints | null {
    if (!isDomainScopeRecord(value)) {
        return null;
    }
    const domainsRecord = isDomainScopeRecord(value.domains) ? value.domains : {};
    const legacyRecord = isDomainScopeRecord(value.legacy) ? value.legacy : {};
    return {
        schema_version: 1,
        detection_source: String(value.detection_source || '').trim().toLowerCase() || 'git_auto',
        include_untracked: value.include_untracked === true,
        use_staged: value.use_staged === true,
        domains: Object.fromEntries(
            DOMAIN_SCOPE_NAMES.map((domain) => [domain, normalizeDomainScopeFingerprintEntry(domainsRecord[domain])])
        ) as Record<DomainScopeName, DomainScopeFingerprintEntry>,
        legacy: {
            review_scope_sha256: normalizeDomainScopeHash(legacyRecord.review_scope_sha256),
            code_scope_sha256: normalizeDomainScopeHash(legacyRecord.code_scope_sha256),
            non_test_review_scope_sha256: normalizeDomainScopeHash(legacyRecord.non_test_review_scope_sha256),
            code_review_scope_sha256: normalizeDomainScopeHash(legacyRecord.code_review_scope_sha256)
        }
    };
}

export function getReviewLaneScopeSha256(
    reviewType: string,
    fingerprints: DomainScopeFingerprints | null
): string | null {
    if (!fingerprints) {
        return null;
    }
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    if (normalizedReviewType === 'test') {
        return fingerprints.legacy.review_scope_sha256;
    }
    if (normalizedReviewType === 'code') {
        return fingerprints.legacy.code_review_scope_sha256
            || fingerprints.legacy.code_scope_sha256
            || fingerprints.legacy.non_test_review_scope_sha256
            || fingerprints.legacy.review_scope_sha256;
    }
    return fingerprints.legacy.non_test_review_scope_sha256
        || fingerprints.legacy.code_scope_sha256
        || fingerprints.legacy.review_scope_sha256;
}

export function reviewLaneScopeSha256Matches(
    reviewType: string,
    fingerprints: Array<DomainScopeFingerprints | null>
): boolean {
    if (fingerprints.length === 0) {
        return false;
    }
    const laneScopeSha256s = fingerprints.map((entry) => getReviewLaneScopeSha256(reviewType, entry));
    const firstLaneScopeSha256 = laneScopeSha256s[0];
    return !!firstLaneScopeSha256
        && laneScopeSha256s.every((entry) => !!entry && entry === firstLaneScopeSha256);
}

export function reviewContextLaneScopeMatchesCurrentPreflight(
    reviewType: string,
    reviewContext: Record<string, unknown> | null | undefined,
    currentPreflight: Record<string, unknown> | null | undefined
): boolean {
    if (!reviewContext || !currentPreflight) {
        return false;
    }
    const contextTreeState = isDomainScopeRecord(reviewContext.tree_state)
        ? reviewContext.tree_state
        : null;
    const contextDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        contextTreeState?.domain_scope_fingerprints
    );
    const metrics = isDomainScopeRecord(currentPreflight.metrics)
        ? currentPreflight.metrics
        : {};
    const currentDomainScopeFingerprints = normalizeDomainScopeFingerprints(
        metrics.domain_scope_fingerprints
    );
    if (!contextDomainScopeFingerprints || !currentDomainScopeFingerprints) {
        return false;
    }
    return reviewLaneScopeSha256Matches(reviewType, [
        contextDomainScopeFingerprints,
        currentDomainScopeFingerprints
    ]);
}

export function getCombinedDomainScopeFingerprint(
    fingerprints: DomainScopeFingerprints | null,
    domains: DomainScopeName[]
): DomainScopeFingerprintEntry | null {
    if (!fingerprints) {
        return null;
    }
    const changedFiles = [...new Set(domains.flatMap((domain) => fingerprints.domains[domain].changed_files))].sort();
    return {
        changed_files: changedFiles,
        changed_files_count: changedFiles.length,
        changed_files_sha256: stringSha256(changedFiles.join('\n')),
        scope_content_sha256: stringSha256(
            domains.map((domain) => `${domain}:${fingerprints.domains[domain].scope_content_sha256 || ''}`).join('\n')
        ),
        scope_sha256: stringSha256(
            domains.map((domain) => `${domain}:${fingerprints.domains[domain].scope_sha256 || ''}`).join('\n')
        )
    };
}
