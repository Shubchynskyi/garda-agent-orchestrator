import { isPlainRecord } from '../../core/records';
import {
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprintEntry,
    type DomainScopeName
} from '../scope/domain-scope-fingerprints';
import type { ReviewArtifactState } from './next-step-review-artifact-readers';
import { buildCurrentDomainScopeFingerprints } from './next-step-readiness-domain-scope';
import type { PreflightWorkspaceReadiness } from './next-step-preflight-workspace-readiness';

const SOURCE_MUTATION_DOMAINS = Object.freeze([
    'implementation',
    'test',
    'config'
] as const satisfies readonly DomainScopeName[]);

export interface PostReviewSourceMutationGuardEvaluation {
    blocked: boolean;
    reason: string;
    accepted_review_types: string[];
    mutated_domains: string[];
    mutated_files: string[];
}

function domainEntryMatches(
    expected: DomainScopeFingerprintEntry,
    current: DomainScopeFingerprintEntry
): boolean {
    return expected.changed_files_sha256 === current.changed_files_sha256
        && expected.scope_content_sha256 === current.scope_content_sha256
        && expected.scope_sha256 === current.scope_sha256;
}

function emptyEvaluation(reason: string): PostReviewSourceMutationGuardEvaluation {
    return {
        blocked: false,
        reason,
        accepted_review_types: [],
        mutated_domains: [],
        mutated_files: []
    };
}

export function hasAuthenticatedFixNowDisposition(state: ReviewArtifactState): boolean {
    const disposition = state.frozenReviewFindingsDisposition ?? state.reviewFindingsDisposition;
    return (
        state.frozenReviewFindingsValidationAccepted === true
        || state.reviewFindingsValidationAccepted === true
    )
        && disposition !== null
        && disposition.blocking_count > 0
        && disposition.counts_by_action.fix_now > 0;
}

export function resolveAuthenticatedFixNowRemediationState(
    reviewStates: readonly ReviewArtifactState[],
    preferredReviewType: string | null
): ReviewArtifactState | null {
    const preferredState = preferredReviewType
        ? reviewStates.find((state) => (
            state.reviewType === preferredReviewType && hasAuthenticatedFixNowDisposition(state)
        ))
        : null;
    return preferredState ?? reviewStates.find(hasAuthenticatedFixNowDisposition) ?? null;
}

function hasAcceptedDeferredOrIgnoredDisposition(state: ReviewArtifactState): boolean {
    const disposition = state.frozenReviewFindingsDisposition ?? state.reviewFindingsDisposition;
    return (
        state.frozenReviewFindingsValidationAccepted === true
        || state.reviewFindingsValidationAccepted === true
    )
        && disposition !== null
        && disposition.blocking_count === 0
        && (
            disposition.counts_by_action.create_follow_up
            + disposition.counts_by_action.ignore
        ) > 0;
}

function describeDisposition(state: ReviewArtifactState): string {
    const counts = (
        state.frozenReviewFindingsDisposition ?? state.reviewFindingsDisposition
    )?.counts_by_action;
    return `${state.reviewType}(create_follow_up=${counts?.create_follow_up || 0}, ignore=${counts?.ignore || 0})`;
}

export function evaluatePostReviewSourceMutationGuard(options: {
    repoRoot: string;
    preflight: Record<string, unknown> | null;
    workspaceReadiness: PreflightWorkspaceReadiness;
    reviewStates: readonly ReviewArtifactState[];
    authorizedImplementationTransition: boolean;
}): PostReviewSourceMutationGuardEvaluation {
    if (options.workspaceReadiness.ready) {
        return emptyEvaluation('Workspace still matches the frozen preflight scope.');
    }
    if (!options.preflight) {
        return emptyEvaluation('No preflight exists, so no post-review source-mutation boundary is active.');
    }
    if (options.authorizedImplementationTransition) {
        return emptyEvaluation('A current authenticated remediation transition authorizes implementation changes.');
    }

    const deferredStates = options.reviewStates.filter(hasAcceptedDeferredOrIgnoredDisposition);
    if (deferredStates.length === 0) {
        return emptyEvaluation('No current accepted deferred or ignored review finding disposition exists.');
    }

    const metrics = isPlainRecord(options.preflight.metrics) ? options.preflight.metrics : {};
    const expectedFingerprints = normalizeDomainScopeFingerprints(metrics.domain_scope_fingerprints);
    const currentChangedFiles = options.workspaceReadiness.currentChangedFiles || [];
    if (!expectedFingerprints) {
        const acceptedReviewTypes = deferredStates.map((state) => state.reviewType);
        return {
            blocked: true,
            reason:
                `Accepted review findings are frozen as non-remediation dispositions `
                + `[${deferredStates.map(describeDisposition).join(', ')}], but the stale workspace cannot be `
                + 'authenticated against domain-scope fingerprints. Refusing ordinary classify-change recovery. '
                + 'Restore the workspace to the frozen preflight state or move the change into the materialized follow-up task; '
                + 'an operator hotfix must run outside this task cycle through its explicit maintenance authorization.',
            accepted_review_types: acceptedReviewTypes,
            mutated_domains: ['unknown'],
            mutated_files: currentChangedFiles
        };
    }

    const currentFingerprintFiles = currentChangedFiles.length > 0
        ? currentChangedFiles
        : [...new Set(SOURCE_MUTATION_DOMAINS.flatMap((domainName) => (
            expectedFingerprints.domains[domainName].changed_files
        )))].sort();
    if (currentFingerprintFiles.length === 0) {
        const acceptedReviewTypes = deferredStates.map((state) => state.reviewType);
        return {
            blocked: true,
            reason:
                `Accepted review findings are frozen as non-remediation dispositions `
                + `[${deferredStates.map(describeDisposition).join(', ')}], but the stale workspace cannot be `
                + 'authenticated against domain-scope fingerprints. Refusing ordinary classify-change recovery. '
                + 'Restore the workspace to the frozen preflight state or move the change into the materialized follow-up task; '
                + 'an operator hotfix must run outside this task cycle through its explicit maintenance authorization.',
            accepted_review_types: acceptedReviewTypes,
            mutated_domains: ['unknown'],
            mutated_files: currentChangedFiles
        };
    }

    const currentFingerprints = buildCurrentDomainScopeFingerprints({
        repoRoot: options.repoRoot,
        detectionSource: String(options.preflight.detection_source || 'git_auto'),
        includeUntracked: options.preflight.include_untracked !== false,
        changedFiles: currentFingerprintFiles
    });
    const mutatedDomains = SOURCE_MUTATION_DOMAINS.filter((domainName) => (
        !domainEntryMatches(
            expectedFingerprints.domains[domainName],
            currentFingerprints.domains[domainName]
        )
    ));
    if (mutatedDomains.length === 0) {
        return emptyEvaluation('Only documentation or closeout domains changed after accepted review evidence.');
    }

    const mutatedFiles = [...new Set(mutatedDomains.flatMap((domainName) => [
        ...expectedFingerprints.domains[domainName].changed_files,
        ...currentFingerprints.domains[domainName].changed_files
    ]))].sort();
    const acceptedReviewTypes = deferredStates.map((state) => state.reviewType);
    return {
        blocked: true,
        reason:
            `Post-review source mutation is not authorized for domain(s) ${mutatedDomains.join(', ')} `
            + `and file(s) ${mutatedFiles.join(', ') || '(content-only mutation)'}. `
            + `Current accepted findings are frozen as non-remediation dispositions `
            + `[${deferredStates.map(describeDisposition).join(', ')}]. `
            + 'Do not normalize these changes through classify-change or a new coherent parent cycle. '
            + 'Restore source/test/config to the frozen preflight state and continue pending review lanes, or move the change '
            + 'into the materialized follow-up task. An operator hotfix must run outside this task cycle through explicit maintenance authorization.',
        accepted_review_types: acceptedReviewTypes,
        mutated_domains: [...mutatedDomains],
        mutated_files: mutatedFiles
    };
}
