/**
 * Thin compatibility re-export surface.
 *
 * The implementation has been decomposed into focused modules:
 *   - `./path-utils`            — path normalization, root resolution, prefix matching
 *   - `./hashing-metrics`       — SHA-256 hashing, file metrics, coercion helpers
 *   - `./protected-control-plane` — manifest types, build/evaluate/write, protected roots
 *
 * All existing call sites that import from `./helpers` continue to work unchanged.
 */

export {
    normalizePath,
    toPosix,
    resolveProjectRoot,
    joinOrchestratorPath,
    orchestratorRelativePath,
    resolvePathInsideRepo,
    resolveTaskId,
    normalizeRootPrefixes,
    testPathPrefix,
    resolveGitRoot
} from './path-utils';
export type { ResolvePathOptions } from './path-utils';

export {
    toPlainRecord,
    parseBool,
    stringSha256,
    fileSha256,
    countFileLines,
    appendMetricsEvent,
    toStringArray
} from './hashing-metrics';
export type { ToStringArrayOptions } from './hashing-metrics';

export {
    isOrchestratorSourceCheckout,
    getProtectedControlPlaneRoots,
    scanProtectedPathHashes,
    resolveProtectedControlPlaneManifestPath,
    buildProtectedControlPlaneManifest,
    writeProtectedControlPlaneManifest,
    evaluateProtectedControlPlaneManifest,
    normalizeProtectedControlPlaneRoots,
    computeProtectedSnapshotDigest
} from './protected-control-plane';
export type {
    ProtectedControlPlaneManifest,
    ProtectedControlPlaneManifestEvidence
} from './protected-control-plane';
