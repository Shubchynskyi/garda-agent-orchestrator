import {
    buildDomainScopeFingerprints,
    type DomainScopeFingerprintEntry,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    isReviewReuseNeutralCloseoutEvidencePath
} from '../scope/closeout-evidence-paths';
import {
    normalizePath
} from '../shared/helpers';

const COMPILE_RELEVANT_DOMAIN_NAMES = ['implementation', 'test', 'docs', 'config'] as const;

function domainFingerprintEntryMatches(
    expected: DomainScopeFingerprintEntry,
    current: DomainScopeFingerprintEntry
): boolean {
    return expected.changed_files_sha256 === current.changed_files_sha256
        && expected.scope_content_sha256 === current.scope_content_sha256
        && expected.scope_sha256 === current.scope_sha256;
}

export function onlyNeutralCloseoutDomainChanged(
    expected: DomainScopeFingerprints | null,
    current: DomainScopeFingerprints | null
): boolean {
    if (!expected || !current) {
        return false;
    }
    for (const domainName of COMPILE_RELEVANT_DOMAIN_NAMES) {
        if (!domainFingerprintEntryMatches(expected.domains[domainName], current.domains[domainName])) {
            return false;
        }
    }
    const closeoutFiles = new Set([
        ...expected.domains.closeout.changed_files,
        ...current.domains.closeout.changed_files
    ]);
    if ([...closeoutFiles].some((filePath) => !isReviewReuseNeutralCloseoutEvidencePath(filePath))) {
        return false;
    }
    return !domainFingerprintEntryMatches(expected.domains.closeout, current.domains.closeout);
}

export function buildCurrentDomainScopeFingerprints(params: {
    repoRoot: string;
    detectionSource: string;
    includeUntracked: boolean;
    changedFiles: readonly string[];
}): DomainScopeFingerprints {
    return buildDomainScopeFingerprints({
        repoRoot: params.repoRoot,
        detectionSource: params.detectionSource,
        includeUntracked: params.includeUntracked,
        changedFiles: params.changedFiles.map((entry) => normalizePath(entry)).filter(Boolean)
    });
}
