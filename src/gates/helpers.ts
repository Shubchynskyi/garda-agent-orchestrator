import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
    ALL_BUNDLE_NAMES,
    ALL_AGENT_ENTRYPOINT_FILES,
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES,
    DEFAULT_BUNDLE_NAME,
    isRecognizedPackageName,
    resolveBundleNameForTarget
} from '../core/constants';
import {
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from '../materialization/common';
import { recordToxinMetricsSnapshot } from '../runtime/toxin-metrics';
import { scanProtectedPathHashesIncremental } from './protected-hash-cache';

export interface ResolvePathOptions {
    allowMissing?: boolean;
}

export interface ToStringArrayOptions {
    trimValues?: boolean;
}

export interface ProtectedControlPlaneManifest {
    schema_version: 1;
    event_source: 'refresh-protected-control-plane-manifest';
    timestamp_utc: string;
    workspace_root: string;
    orchestrator_root: string;
    protected_roots: string[];
    protected_snapshot: Record<string, string>;
    protected_snapshot_sha256?: string;
    is_source_checkout: boolean;
}

export interface ProtectedControlPlaneManifestEvidence {
    status: 'MISSING' | 'INVALID' | 'MATCH' | 'DRIFT';
    manifest_path: string;
    changed_files: string[];
    manifest: ProtectedControlPlaneManifest | null;
}

/**
 * Normalize a path to Unix-style, trimming whitespace and stripping leading ./
 */
export function normalizePath(pathValue: unknown): string {
    if (pathValue == null) return '';
    let text = String(pathValue).trim().replace(/\\/g, '/');
    text = text.replace(/^\.\//, '');
    text = text.replace(/\/+/g, '/');
    return text;
}

/**
 * Convert any path to POSIX forward-slash style.
 */
export function toPosix(pathValue: unknown): string {
    if (pathValue == null) return '';
    return String(pathValue).replace(/\\/g, '/');
}

/**
 * Resolve project root from a script directory by walking up to find the bundle.
 */
export function resolveProjectRoot(startDir: string): string {
    let current = path.resolve(startDir);
    for (let i = 0; i < 20; i++) {
        if (fs.existsSync(path.join(current, 'MANIFEST.md')) && fs.existsSync(path.join(current, 'VERSION'))) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return path.resolve(startDir);
}

/**
 * Convert unknown value to a plain object record or null.
 */
export function toPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Detect whether repoRoot is the orchestrator source checkout itself.
 */
export function isOrchestratorSourceCheckout(repoRoot: string): boolean {
    const packageJsonPath = path.join(path.resolve(repoRoot), 'package.json');
    if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
        return false;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
        return isRecognizedPackageName(parsed.name);
    } catch {
        return false;
    }
}

/**
 * Return protected control-plane roots for this workspace.
 * Ordinary workspaces protect only the deployed bundle.
 * The orchestrator source checkout additionally protects root-level runtime sources.
 */
export function getProtectedControlPlaneRoots(repoRoot: string): string[] {
    const effectiveName = resolveBundleNameForTarget(repoRoot);
    const roots = [
        `${effectiveName}/src/bin/`,
        `${effectiveName}/src/cli/`,
        `${effectiveName}/src/gates/`,
        `${effectiveName}/src/gate-runtime/`,
        `${effectiveName}/src/lifecycle/`,
        `${effectiveName}/src/materialization/`,
        `${effectiveName}/bin/`,
        `${effectiveName}/dist/`,
        `${effectiveName}/live/docs/agent-rules/`,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        ...ALL_AGENT_ENTRYPOINT_FILES,
        ...getProviderOrchestratorProfileDefinitions().map((profile) => profile.orchestratorRelativePath),
        ...getGitHubSkillBridgeProfileDefinitions().map((profile) => profile.relativePath)
    ];

    if (isOrchestratorSourceCheckout(repoRoot)) {
        roots.push(
            'src/bin/',
            'src/cli/',
            'src/gates/',
            'src/gate-runtime/',
            'src/lifecycle/',
            'src/materialization/',
            'bin/',
            'dist/',
            'live/docs/agent-rules/'
        );
    }

    return normalizeProtectedControlPlaneRoots(roots);
}

/**
 * Scan protected roots recursively and return a map of path -> sha256 hash.
 * Delegates to the incremental implementation that uses a persisted metadata
 * cache (mtime + size) to skip unchanged files while preserving identical
 * drift-detection semantics.
 */
export function scanProtectedPathHashes(repoRoot: string, protectedRoots: string[], readOnly: boolean = false): Record<string, string> {
    return scanProtectedPathHashesIncremental(repoRoot, protectedRoots, readOnly);
}

/**
 * Resolve the persisted protected control-plane manifest path.
 */
export function resolveProtectedControlPlaneManifestPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'protected-control-plane-manifest.json'));
}

/**
 * Build the current trusted protected control-plane manifest from the workspace.
 */
export function buildProtectedControlPlaneManifest(repoRoot: string): ProtectedControlPlaneManifest {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const protectedRoots = getProtectedControlPlaneRoots(normalizedRepoRoot);
    const manifestPath = resolveProtectedControlPlaneManifestPath(normalizedRepoRoot);
    const protectedSnapshot = scanProtectedPathHashes(normalizedRepoRoot, protectedRoots);
    return {
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: new Date().toISOString(),
        workspace_root: normalizePath(normalizedRepoRoot),
        orchestrator_root: normalizePath(path.dirname(path.dirname(manifestPath))),
        protected_roots: protectedRoots,
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: isOrchestratorSourceCheckout(normalizedRepoRoot)
    };
}

/**
 * Persist the trusted protected control-plane manifest after a lifecycle action.
 */
export function writeProtectedControlPlaneManifest(repoRoot: string): string {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const manifest = buildProtectedControlPlaneManifest(repoRoot);
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    return manifestPath;
}

/**
 * Compare the current protected snapshot with the last trusted lifecycle manifest.
 */
export function evaluateProtectedControlPlaneManifest(
    repoRoot: string,
    currentSnapshot?: Record<string, string> | null,
    readOnly: boolean = false
): ProtectedControlPlaneManifestEvidence {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const normalizedManifestPath = normalizePath(manifestPath);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        return {
            status: 'MISSING',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: null
        };
    }

    let manifestObject: ProtectedControlPlaneManifest;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        if (
            !parsed
            || typeof parsed !== 'object'
            || Array.isArray(parsed)
            || !parsed.protected_snapshot
            || typeof parsed.protected_snapshot !== 'object'
            || Array.isArray(parsed.protected_snapshot)
        ) {
            return {
                status: 'INVALID',
                manifest_path: normalizedManifestPath,
                changed_files: [],
                manifest: null
            };
        }
        manifestObject = parsed as unknown as ProtectedControlPlaneManifest;
    } catch {
        return {
            status: 'INVALID',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: null
        };
    }

    const snapshot = currentSnapshot || scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), readOnly);
    const snapshotDigest = computeProtectedSnapshotDigest(snapshot);
    const manifestSnapshot = manifestObject.protected_snapshot || {};
    const manifestDigest = typeof manifestObject.protected_snapshot_sha256 === 'string'
        ? String(manifestObject.protected_snapshot_sha256).trim().toLowerCase()
        : '';
    if (manifestDigest && snapshotDigest === manifestDigest) {
        return {
            status: 'MATCH',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: manifestObject
        };
    }
    const changedFiles: string[] = [];
    const allProtectedPaths = new Set([...Object.keys(manifestSnapshot), ...Object.keys(snapshot)]);
    for (const protectedPath of allProtectedPaths) {
        if (manifestSnapshot[protectedPath] !== snapshot[protectedPath]) {
            changedFiles.push(protectedPath);
        }
    }

    return {
        status: changedFiles.length > 0 ? 'DRIFT' : 'MATCH',
        manifest_path: normalizedManifestPath,
        changed_files: changedFiles.sort(),
        manifest: manifestObject
    };
}

/**
 * Join orchestrator-relative path: if repoRoot already ends with the bundle name
 * use it directly; otherwise prefer a deployed bundle when present and fall back
 * to the workspace root when the bundle has not been materialized yet.
 */
export function joinOrchestratorPath(repoRoot: string, relativePath: string): string {
    const repoRootResolved = path.resolve(repoRoot);
    const effectiveName = resolveBundleNameForTarget(repoRootResolved);
    const deployedRoot = path.resolve(repoRootResolved, effectiveName);
    const looksLikeBundleRoot = (candidatePath: string): boolean => (
        fs.existsSync(path.join(candidatePath, 'MANIFEST.md'))
        && fs.existsSync(path.join(candidatePath, 'VERSION'))
    );

    let orchestratorRoot = repoRootResolved;
    if (looksLikeBundleRoot(deployedRoot)) {
        orchestratorRoot = deployedRoot;
    } else if (looksLikeBundleRoot(repoRootResolved)) {
        orchestratorRoot = repoRootResolved;
    } else if (fs.existsSync(deployedRoot)) {
        orchestratorRoot = deployedRoot;
    }

    let normalizedRelativePath = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const bundlePrefixes = [...new Set([effectiveName, ...ALL_BUNDLE_NAMES].map((bundleName) => bundleName.toLowerCase()))];
    for (const bundlePrefix of bundlePrefixes) {
        if (normalizedRelativePath.toLowerCase().startsWith(`${bundlePrefix}/`)) {
            normalizedRelativePath = normalizedRelativePath.slice(bundlePrefix.length + 1);
            break;
        }
    }

    if (!normalizedRelativePath.trim()) {
        return path.resolve(orchestratorRoot);
    }
    return path.resolve(orchestratorRoot, normalizedRelativePath);
}

/**
 * Get orchestrator-relative path as a posix string.
 */
export function orchestratorRelativePath(repoRoot: string, relativePath: string): string {
    return toPosix(joinOrchestratorPath(repoRoot, relativePath));
}

/**
 * Resolve a path inside the repo root. If relative, resolve against repoRoot.
 */
export function resolvePathInsideRepo(pathValue: string, repoRoot: string, options: ResolvePathOptions = {}): string | null {
    const allowMissing = options.allowMissing || false;
    const text = String(pathValue).trim();
    if (!text) return null;

    let resolved;
    if (path.isAbsolute(text)) {
        resolved = path.resolve(text);
    } else {
        resolved = path.resolve(repoRoot, text);
    }

    if (!allowMissing && !fs.existsSync(resolved)) {
        throw new Error(`Path not found: ${resolved}`);
    }

    return resolved;
}

/**
 * Resolve task ID from explicit value or output path hint.
 */
export function resolveTaskId(explicitTaskId: unknown, outputPathHint: unknown): string | null {
    if (explicitTaskId && String(explicitTaskId).trim()) {
        return String(explicitTaskId).trim();
    }
    if (!outputPathHint || !String(outputPathHint).trim()) {
        return null;
    }
    const baseName = path.basename(String(outputPathHint), path.extname(String(outputPathHint)));
    const candidate = baseName.replace(/-preflight$/, '').trim();
    return candidate || null;
}

/**
 * Parse boolean-like values, matching Python/PS parse_bool.
 */
export function parseBool(value: unknown, defaultValue = false): boolean {
    if (value == null) return !!defaultValue;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(text)) return true;
    if (BOOLEAN_FALSE_VALUES.includes(text)) return false;
    return !!defaultValue;
}

/**
 * SHA-256 hash of a string.
 */
export function stringSha256(value: unknown): string | null {
    if (value == null) return null;
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').toLowerCase();
}

/**
 * SHA-256 hash of a file.
 */
export function fileSha256(filePath: string): string | null {
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Count non-empty lines in a file.
 */
export function countFileLines(filePath: string): number {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0;
        const content = fs.readFileSync(filePath, 'utf8');
        return content.split('\n').filter(line => line.trimEnd() !== '').length;
    } catch {
        return 0;
    }
}

/**
 * Normalize root prefixes: ensure trailing /, deduplicate, sort.
 */
export function normalizeRootPrefixes(prefixes: unknown[] | null | undefined): string[] {
    const set = new Set<string>();
    for (const prefix of (prefixes || [])) {
        let value = normalizePath(prefix);
        if (!value) continue;
        if (!value.endsWith('/')) value += '/';
        set.add(value);
    }
    return [...set].sort();
}

/**
 * Normalize protected control-plane roots.
 * Directory roots should end with `/`; file targets should not.
 */
export function normalizeProtectedControlPlaneRoots(roots: unknown[] | null | undefined): string[] {
    const set = new Set<string>();
    for (const root of (roots || [])) {
        const original = String(root == null ? '' : root).replace(/\\/g, '/');
        const isDirectoryLike = /\/$/.test(original);
        let value = normalizePath(root);
        if (!value) continue;
        value = value.replace(/\/+$/, '');
        if (!value) continue;
        if (isDirectoryLike) value += '/';
        set.add(value);
    }
    return [...set].sort();
}

/**
 * Build a deterministic aggregate digest for a protected snapshot.
 * Used as a compact pre/post-task integrity token.
 */
export function computeProtectedSnapshotDigest(snapshot: Record<string, string> | null | undefined): string {
    const normalizedEntries = Object.entries(snapshot || {})
        .map(([protectedPath, sha256]) => [normalizePath(protectedPath), String(sha256 || '').trim().toLowerCase()] as const)
        .filter(([protectedPath]) => protectedPath !== '')
        .sort(([a], [b]) => a.localeCompare(b));
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(normalizedEntries), 'utf8')
        .digest('hex')
        .toLowerCase();
}

/**
 * Test if a path starts with any of the given prefixes (case-insensitive).
 */
export function testPathPrefix(pathValue: string, prefixes: string[]): boolean {
    const lower = pathValue.toLowerCase();
    for (const prefix of prefixes) {
        const normalizedPrefix = prefix.toLowerCase();
        if (normalizedPrefix.endsWith('/')) {
            if (lower.startsWith(normalizedPrefix)) return true;
            continue;
        }
        if (lower === normalizedPrefix || lower.startsWith(`${normalizedPrefix}/`)) return true;
    }
    return false;
}

/**
 * Append a JSON line to a metrics file.
 */
export function appendMetricsEvent(
    metricsPath: string,
    eventObject: Record<string, unknown>,
    emitMetrics: boolean,
    repoRoot?: string
): void {
    if (!emitMetrics || !metricsPath) return;
    const resolvedMetricsPath = String(metricsPath);
    try {
        fs.mkdirSync(path.dirname(resolvedMetricsPath), { recursive: true });
        fs.appendFileSync(resolvedMetricsPath, JSON.stringify(eventObject) + '\n', 'utf8');
    } catch {
        // metrics are best-effort
        return;
    }
    if (!repoRoot) {
        return;
    }
    try {
        recordToxinMetricsSnapshot(repoRoot, { metricsPath: resolvedMetricsPath });
    } catch {
        // toxin metrics are best-effort
    }
}

/**
 * Convert value(s) to a flat string array, matching gate_utils.to_string_array.
 */
export function toStringArray(value: unknown, options: ToStringArrayOptions = {}): string[] {
    const trimValues = options.trimValues || false;
    if (value == null) return [];
    if (typeof value === 'string') {
        const text = trimValues ? value.trim() : value;
        return (text && text.trim()) ? [text] : [];
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            if (item == null) continue;
            let text = String(item);
            if (trimValues) text = text.trim();
            if (!text || !text.trim()) continue;
            result.push(text);
        }
        return result;
    }
    const text = trimValues ? String(value).trim() : String(value);
    return (text && text.trim()) ? [text] : [];
}

/**
 * Resolve git root from a repo root.
 */
export function resolveGitRoot(repoRoot: string): string {
    const resolved = path.resolve(repoRoot);
    if (fs.existsSync(path.join(resolved, '.git'))) return resolved;
    const bundleCandidate = path.resolve(resolved, resolveBundleNameForTarget(resolved));
    if (fs.existsSync(path.join(bundleCandidate, '.git'))) return bundleCandidate;
    return resolved;
}
