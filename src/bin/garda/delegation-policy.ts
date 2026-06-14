import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    findDeployedBundleRoot,
    findSourceCheckoutRoot,
    isPackageInstalledUnderNodeModules,
    isPathInsideOrEqual,
    isRecognizedPackageName,
    looksLikeDeployedBundleRoot,
    looksLikeSourceCheckout,
    readPackageMetadata,
    resolveDelegationStartDirs,
    resolvePreferredCliPath
} from './root-discovery';

export type DelegationRuntimeKind = 'source_checkout' | 'deployed_bundle' | 'packaged_npm' | 'unknown';
export type DelegationTrustLevel = 'trusted_self_hosted' | 'trusted_local_workspace' | 'packaged_runtime' | 'unknown';
export type DelegationDecision = 'not_required' | 'allowed' | 'blocked';
export type DelegationTargetReason =
    | 'target_root_source_checkout'
    | 'target_root_deployed_bundle'
    | 'cwd_source_checkout'
    | 'cwd_deployed_bundle';

export interface DelegatedRuntimeEvidence {
    cli_path: string;
    root: string;
    runtime_kind: Extract<DelegationRuntimeKind, 'source_checkout' | 'deployed_bundle'>;
    reason: DelegationTargetReason;
    package_name: string;
    package_version: string | null;
    path_containment: 'validated';
}

export interface CurrentRuntimeEvidence {
    package_root: string;
    runtime_kind: DelegationRuntimeKind;
    package_installed_under_node_modules: boolean;
    recognized_package_name: boolean;
    package_name: string | null;
    package_version: string | null;
}

export interface DelegationTrustDecision {
    decision: DelegationDecision;
    trust_level: DelegationTrustLevel;
    reason: string;
}

export interface DelegationTrustEvidence {
    current_runtime: CurrentRuntimeEvidence;
    delegated_runtime: DelegatedRuntimeEvidence | null;
    implementation_delegation: DelegationTrustDecision;
    mandatory_review_delegation: DelegationTrustDecision & {
        requires_provider_launch_attestation: boolean;
    };
}

function buildMandatoryReviewDelegation(
    decision: DelegationDecision,
    trustLevel: DelegationTrustLevel,
    reason: string
): DelegationTrustEvidence['mandatory_review_delegation'] {
    return {
        decision,
        trust_level: trustLevel,
        reason,
        requires_provider_launch_attestation: true
    };
}

export function buildDelegationTrustEvidence(
    currentRuntime: CurrentRuntimeEvidence,
    delegatedRuntime: DelegatedRuntimeEvidence | null
): DelegationTrustEvidence {
    const installedUnderNodeModules = currentRuntime.package_installed_under_node_modules;

    if (!currentRuntime.recognized_package_name) {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: installedUnderNodeModules ? 'blocked' : 'not_required',
                trust_level: 'unknown',
                reason: 'Current runtime package name is not recognized; it cannot be trusted as a Garda runtime.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                'Mandatory reviewer delegation cannot rely on an unrecognized current runtime identity.'
            )
        };
    }

    if (currentRuntime.runtime_kind === 'unknown') {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: 'blocked',
                trust_level: 'unknown',
                reason: 'Current runtime kind is unknown; workspace delegation must fail closed.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'blocked',
                'unknown',
                'Mandatory reviewer delegation cannot rely on an unknown current runtime kind.'
            )
        };
    }

    if (!installedUnderNodeModules && currentRuntime.runtime_kind === 'source_checkout') {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: null,
            implementation_delegation: {
                decision: 'not_required',
                trust_level: 'trusted_self_hosted',
                reason: 'Current runtime is the self-hosted source checkout; implementation delegation to another workspace runtime is not required.'
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'allowed',
                'trusted_self_hosted',
                'Self-hosted source checkout is trusted, but reviewer launch still requires provider-native delegated reviewer attestation.'
            )
        };
    }

    if (delegatedRuntime) {
        return {
            current_runtime: currentRuntime,
            delegated_runtime: delegatedRuntime,
            implementation_delegation: {
                decision: 'allowed',
                trust_level: 'trusted_local_workspace',
                reason: `Delegated ${delegatedRuntime.runtime_kind} runtime was resolved from ${delegatedRuntime.reason}.`
            },
            mandatory_review_delegation: buildMandatoryReviewDelegation(
                'allowed',
                'trusted_local_workspace',
                'Delegated workspace runtime is recognized; mandatory reviews still require provider-native delegated reviewer attestation.'
            )
        };
    }

    return {
        current_runtime: currentRuntime,
        delegated_runtime: null,
        implementation_delegation: {
            decision: installedUnderNodeModules ? 'blocked' : 'not_required',
            trust_level: installedUnderNodeModules ? 'unknown' : 'packaged_runtime',
            reason: installedUnderNodeModules
                ? 'Installed packaged runtime could not resolve a trusted local source checkout or deployed bundle target for workspace delegation.'
                : 'Current runtime is not installed under node_modules; launcher delegation is not required.'
        },
        mandatory_review_delegation: buildMandatoryReviewDelegation(
            installedUnderNodeModules ? 'blocked' : 'allowed',
            installedUnderNodeModules ? 'unknown' : 'packaged_runtime',
            installedUnderNodeModules
                ? 'Mandatory reviewer delegation cannot rely on an unknown workspace runtime target.'
                : 'Packaged runtime may continue only with provider-native delegated reviewer attestation.'
        )
    };
}

function resolveCliPathIfExternal(candidateRoot: string | null, currentScriptPath: string): string | null {
    if (!candidateRoot) {
        return null;
    }

    const candidateCli = resolvePreferredCliPath(candidateRoot);
    if (!candidateCli) {
        return null;
    }

    const currentRealPath = fs.realpathSync.native(currentScriptPath);
    const candidateRealPath = fs.realpathSync.native(candidateCli);
    const candidateRootRealPath = fs.realpathSync.native(candidateRoot);
    if (!isPathInsideOrEqual(candidateRootRealPath, candidateRealPath)) {
        return null;
    }
    if (candidateRealPath === currentRealPath) {
        return null;
    }

    return candidateCli;
}

function hasLauncherOwnershipEvidence(packageRoot: string, currentScriptPath: string): boolean {
    try {
        const expectedCliPath = resolvePreferredCliPath(path.resolve(packageRoot));
        if (!expectedCliPath) {
            return false;
        }
        return fs.realpathSync.native(expectedCliPath) === fs.realpathSync.native(currentScriptPath);
    } catch {
        return false;
    }
}

function resolveCurrentRuntimeKind(packageRoot: string, currentScriptPath: string): DelegationRuntimeKind {
    if (!hasLauncherOwnershipEvidence(packageRoot, currentScriptPath)) {
        return 'unknown';
    }
    if (isPackageInstalledUnderNodeModules(packageRoot)) {
        return 'packaged_npm';
    }
    if (looksLikeSourceCheckout(packageRoot)) {
        return 'source_checkout';
    }
    if (looksLikeDeployedBundleRoot(packageRoot)) {
        return 'deployed_bundle';
    }
    return 'unknown';
}

function buildDelegationTargetReason(
    source: 'target_root' | 'cwd',
    runtimeKind: Extract<DelegationRuntimeKind, 'source_checkout' | 'deployed_bundle'>
): DelegationTargetReason {
    if (source === 'target_root' && runtimeKind === 'source_checkout') {
        return 'target_root_source_checkout';
    }
    if (source === 'target_root' && runtimeKind === 'deployed_bundle') {
        return 'target_root_deployed_bundle';
    }
    if (runtimeKind === 'source_checkout') {
        return 'cwd_source_checkout';
    }
    return 'cwd_deployed_bundle';
}

function resolveDelegatedRuntimeEvidence(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): DelegatedRuntimeEvidence | null {
    if (!isPackageInstalledUnderNodeModules(packageRoot)) {
        return null;
    }

    for (const candidate of resolveDelegationStartDirs(argv, cwd)) {
        const sourceRoot = findSourceCheckoutRoot(candidate.startDir);
        const sourceCli = resolveCliPathIfExternal(sourceRoot, currentScriptPath);
        if (sourceRoot && sourceCli) {
            const packageMetadata = readPackageMetadata(sourceRoot);
            return {
                cli_path: sourceCli,
                root: path.dirname(path.dirname(sourceCli)),
                runtime_kind: 'source_checkout',
                reason: buildDelegationTargetReason(candidate.source, 'source_checkout'),
                package_name: packageMetadata.name || '',
                package_version: packageMetadata.version,
                path_containment: 'validated'
            };
        }

        const bundleRoot = findDeployedBundleRoot(candidate.startDir);
        const bundleCli = resolveCliPathIfExternal(bundleRoot, currentScriptPath);
        if (bundleRoot && bundleCli) {
            const packageMetadata = readPackageMetadata(bundleRoot);
            return {
                cli_path: bundleCli,
                root: path.dirname(path.dirname(bundleCli)),
                runtime_kind: 'deployed_bundle',
                reason: buildDelegationTargetReason(candidate.source, 'deployed_bundle'),
                package_name: packageMetadata.name || '',
                package_version: packageMetadata.version,
                path_containment: 'validated'
            };
        }
    }

    return null;
}

export function resolveDelegatedLauncherTrustEvidence(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): DelegationTrustEvidence {
    const normalizedPackageRoot = path.resolve(packageRoot);
    const currentRuntimeKind = resolveCurrentRuntimeKind(normalizedPackageRoot, currentScriptPath);
    const installedUnderNodeModules = isPackageInstalledUnderNodeModules(normalizedPackageRoot);
    const packageMetadata = readPackageMetadata(normalizedPackageRoot);
    const delegatedRuntime = resolveDelegatedRuntimeEvidence(argv, cwd, currentScriptPath, normalizedPackageRoot);
    const currentRuntime: CurrentRuntimeEvidence = {
        package_root: normalizedPackageRoot,
        runtime_kind: currentRuntimeKind,
        package_installed_under_node_modules: installedUnderNodeModules,
        recognized_package_name: isRecognizedPackageName(packageMetadata.name),
        package_name: packageMetadata.name,
        package_version: packageMetadata.version
    };

    return buildDelegationTrustEvidence(currentRuntime, delegatedRuntime);
}

export function resolveDelegatedLauncherTarget(
    argv: string[],
    cwd: string,
    currentScriptPath: string,
    packageRoot: string
): string | null {
    const evidence = resolveDelegatedLauncherTrustEvidence(argv, cwd, currentScriptPath, packageRoot);
    return evidence.implementation_delegation.decision === 'allowed'
        ? evidence.delegated_runtime?.cli_path ?? null
        : null;
}

