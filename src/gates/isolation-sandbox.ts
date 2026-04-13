import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_BUNDLE_NAME } from '../core/constants';
import {
    fileSha256,
    isOrchestratorSourceCheckout,
    joinOrchestratorPath,
    normalizePath,
    scanProtectedPathHashes,
    getProtectedControlPlaneRoots,
    toPosix,
    writeProtectedControlPlaneManifest
} from './helpers';
import { loadIsolationModeConfig, type IsolationModeConfig } from './isolation-mode';

// ── Constants ────────────────────────────────────────────────────────

export const ISOLATION_SANDBOX_DIR = '.isolation-sandbox';
const SANDBOX_MANIFEST_NAME = 'sandbox-manifest.json';

// ── Types ────────────────────────────────────────────────────────────

export interface SandboxManifest {
    schema_version: 1;
    event_source: 'prepare-isolation-sandbox';
    timestamp_utc: string;
    source_orchestrator_root: string;
    sandbox_root: string;
    file_count: number;
    snapshot: Record<string, string>;
    read_only_applied: boolean;
    is_source_checkout: boolean;
    same_user_limitation_notice: string;
}

export interface PrepareSandboxResult {
    sandbox_root: string;
    sandbox_manifest_path: string;
    file_count: number;
    read_only_applied: boolean;
    skipped_directories: string[];
    errors: string[];
}

export interface SandboxResolutionResult {
    resolved_root: string;
    using_sandbox: boolean;
    sandbox_root: string | null;
    reason: string;
}

// Directories within the orchestrator bundle that form the control plane.
// When running in sandbox mode, gates resolve paths from this isolated copy.
const CONTROL_PLANE_COPY_DIRS = [
    'bin',
    'dist',
    'live',
    'template',
    'MANIFEST.md',
    'VERSION',
    'package.json'
];

// Directories that are explicitly excluded from the sandbox copy
// because they contain mutable runtime state or large dependency trees.
const SANDBOX_EXCLUDE_DIRS = new Set([
    'node_modules',
    'runtime',
    '.isolation-sandbox'
]);

// ── Sandbox Lifecycle ────────────────────────────────────────────────

/**
 * Resolve the sandbox root directory for a given workspace.
 */
export function resolveSandboxRoot(repoRoot: string): string {
    return path.join(
        joinOrchestratorPath(repoRoot, ''),
        'runtime',
        ISOLATION_SANDBOX_DIR
    );
}

/**
 * Prepare (create or refresh) the isolation sandbox.
 * Copies control-plane files from the live orchestrator bundle into a
 * read-only sandbox directory under runtime/.isolation-sandbox/.
 *
 * The sandbox is a shallow copy: it contains only the files needed for
 * gate resolution and rule loading, not mutable runtime state.
 */
export function prepareSandbox(repoRoot: string): PrepareSandboxResult {
    const orchestratorRoot = joinOrchestratorPath(repoRoot, '');
    const sandboxRoot = resolveSandboxRoot(repoRoot);
    const errors: string[] = [];
    const skippedDirectories: string[] = [];

    // Clean previous sandbox if present
    if (fs.existsSync(sandboxRoot)) {
        clearReadOnlyRecursive(sandboxRoot);
        fs.rmSync(sandboxRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(sandboxRoot, { recursive: true });

    let fileCount = 0;
    let readOnlyApplied = false;

    for (const entry of CONTROL_PLANE_COPY_DIRS) {
        const sourcePath = path.join(orchestratorRoot, entry);
        if (!fs.existsSync(sourcePath)) {
            skippedDirectories.push(entry);
            continue;
        }

        const stat = fs.statSync(sourcePath);
        if (stat.isFile()) {
            const destPath = path.join(sandboxRoot, entry);
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(sourcePath, destPath);
            fileCount++;
        } else if (stat.isDirectory()) {
            const copied = copyDirectoryRecursive(
                sourcePath, path.join(sandboxRoot, entry), SANDBOX_EXCLUDE_DIRS
            );
            fileCount += copied.count;
            errors.push(...copied.errors);
        }
    }

    // Mark all sandbox files read-only
    readOnlyApplied = applyReadOnlyRecursive(sandboxRoot);

    // Write sandbox manifest (writable, lives alongside the sandbox)
    const snapshot = buildSandboxSnapshot(sandboxRoot);
    const manifest: SandboxManifest = {
        schema_version: 1,
        event_source: 'prepare-isolation-sandbox',
        timestamp_utc: new Date().toISOString(),
        source_orchestrator_root: normalizePath(orchestratorRoot),
        sandbox_root: normalizePath(sandboxRoot),
        file_count: fileCount,
        snapshot,
        read_only_applied: readOnlyApplied,
        is_source_checkout: isOrchestratorSourceCheckout(repoRoot),
        same_user_limitation_notice:
            loadIsolationModeConfig(repoRoot).same_user_limitation_notice
    };

    const manifestPath = path.join(
        joinOrchestratorPath(repoRoot, ''),
        'runtime',
        SANDBOX_MANIFEST_NAME
    );
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    return {
        sandbox_root: sandboxRoot,
        sandbox_manifest_path: manifestPath,
        file_count: fileCount,
        read_only_applied: readOnlyApplied,
        skipped_directories: skippedDirectories,
        errors
    };
}

/**
 * Resolve which orchestrator root to use for gate execution.
 * When isolation mode is enabled and a valid sandbox exists,
 * returns the sandbox root. Otherwise returns the live orchestrator root.
 */
export function resolveIsolatedOrchestratorRoot(
    repoRoot: string
): SandboxResolutionResult {
    const liveRoot = joinOrchestratorPath(repoRoot, '');
    const config = loadIsolationModeConfig(repoRoot);

    if (!config.enabled) {
        return {
            resolved_root: liveRoot,
            using_sandbox: false,
            sandbox_root: null,
            reason: 'Isolation mode is disabled.'
        };
    }

    const sandboxRoot = resolveSandboxRoot(repoRoot);
    const validation = validateSandbox(repoRoot);

    if (!validation.exists) {
        return {
            resolved_root: liveRoot,
            using_sandbox: false,
            sandbox_root: null,
            reason: 'Sandbox directory does not exist. Run prepare-isolation first.'
        };
    }

    if (!validation.manifest_valid) {
        return {
            resolved_root: liveRoot,
            using_sandbox: false,
            sandbox_root: sandboxRoot,
            reason: 'Sandbox manifest is missing or invalid. Run prepare-isolation to refresh.'
        };
    }

    if (validation.drift_files.length > 0 && config.enforcement === 'STRICT') {
        return {
            resolved_root: liveRoot,
            using_sandbox: false,
            sandbox_root: sandboxRoot,
            reason: `Sandbox has drifted (${validation.drift_files.length} file(s) changed). ` +
                    'Run prepare-isolation to refresh.'
        };
    }

    return {
        resolved_root: sandboxRoot,
        using_sandbox: true,
        sandbox_root: sandboxRoot,
        reason: 'Using isolation sandbox for gate execution.'
    };
}

// ── Sandbox Validation ───────────────────────────────────────────────

export interface SandboxValidationResult {
    exists: boolean;
    manifest_valid: boolean;
    manifest: SandboxManifest | null;
    file_count: number;
    drift_files: string[];
    read_only_intact: boolean;
    errors: string[];
}

/**
 * Validate the current state of the isolation sandbox against its manifest.
 */
export function validateSandbox(repoRoot: string): SandboxValidationResult {
    const sandboxRoot = resolveSandboxRoot(repoRoot);
    const manifestPath = path.join(
        joinOrchestratorPath(repoRoot, ''),
        'runtime',
        SANDBOX_MANIFEST_NAME
    );
    const errors: string[] = [];

    if (!fs.existsSync(sandboxRoot) || !fs.statSync(sandboxRoot).isDirectory()) {
        return {
            exists: false,
            manifest_valid: false,
            manifest: null,
            file_count: 0,
            drift_files: [],
            read_only_intact: false,
            errors: ['Sandbox directory does not exist.']
        };
    }

    let manifest: SandboxManifest | null = null;
    let manifestValid = false;

    if (fs.existsSync(manifestPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
            if (
                parsed &&
                typeof parsed === 'object' &&
                parsed.schema_version === 1 &&
                parsed.event_source === 'prepare-isolation-sandbox' &&
                typeof parsed.snapshot === 'object'
            ) {
                manifest = parsed as SandboxManifest;
                manifestValid = true;
            }
        } catch {
            errors.push('Sandbox manifest is malformed JSON.');
        }
    } else {
        errors.push('Sandbox manifest file not found.');
    }

    const currentSnapshot = buildSandboxSnapshot(sandboxRoot);
    const fileCount = Object.keys(currentSnapshot).length;
    const driftFiles: string[] = [];

    if (manifest) {
        const allPaths = new Set([
            ...Object.keys(manifest.snapshot),
            ...Object.keys(currentSnapshot)
        ]);
        for (const p of allPaths) {
            if (manifest.snapshot[p] !== currentSnapshot[p]) {
                driftFiles.push(p);
            }
        }
    }

    // Spot-check read-only status on a sample of files
    const readOnlyIntact = checkReadOnlySample(sandboxRoot, Object.keys(currentSnapshot));

    return {
        exists: true,
        manifest_valid: manifestValid,
        manifest,
        file_count: fileCount,
        drift_files: driftFiles,
        read_only_intact: readOnlyIntact,
        errors
    };
}

/**
 * Compare sandbox files against the live orchestrator root to verify
 * the sandbox is a faithful copy.
 */
export function compareSandboxToLive(repoRoot: string): {
    match: boolean;
    live_only: string[];
    sandbox_only: string[];
    content_differs: string[];
} {
    const liveRoot = joinOrchestratorPath(repoRoot, '');
    const sandboxRoot = resolveSandboxRoot(repoRoot);

    if (!fs.existsSync(sandboxRoot)) {
        return { match: false, live_only: [], sandbox_only: [], content_differs: [] };
    }

    const liveSnapshot: Record<string, string> = {};
    const sandboxSnapshot = buildSandboxSnapshot(sandboxRoot);

    for (const entry of CONTROL_PLANE_COPY_DIRS) {
        const sourcePath = path.join(liveRoot, entry);
        if (!fs.existsSync(sourcePath)) continue;

        const stat = fs.statSync(sourcePath);
        if (stat.isFile()) {
            const hash = fileSha256(sourcePath);
            if (hash) {
                liveSnapshot[normalizePath(entry)] = hash;
            }
        } else if (stat.isDirectory()) {
            collectHashes(sourcePath, liveRoot, liveSnapshot, SANDBOX_EXCLUDE_DIRS);
        }
    }

    // Rebased sandbox snapshot: strip sandbox-root prefix for comparison
    const rebasedSandbox: Record<string, string> = {};
    const sandboxPrefix = normalizePath(path.relative(liveRoot, sandboxRoot));
    for (const [key, val] of Object.entries(sandboxSnapshot)) {
        // Sandbox snapshot keys are relative to sandboxRoot; rebase to orchestratorRoot
        rebasedSandbox[key] = val;
    }

    const liveOnly: string[] = [];
    const sandboxOnly: string[] = [];
    const contentDiffers: string[] = [];

    const allPaths = new Set([...Object.keys(liveSnapshot), ...Object.keys(rebasedSandbox)]);
    for (const p of allPaths) {
        // Normalize: live paths are relative to liveRoot, sandbox paths relative to sandboxRoot
        // Both should use the same relative scheme from their respective roots
        const liveHash = liveSnapshot[p];
        const sbHash = rebasedSandbox[p];

        if (liveHash && !sbHash) {
            liveOnly.push(p);
        } else if (!liveHash && sbHash) {
            sandboxOnly.push(p);
        } else if (liveHash !== sbHash) {
            contentDiffers.push(p);
        }
    }

    return {
        match: liveOnly.length === 0 && sandboxOnly.length === 0 && contentDiffers.length === 0,
        live_only: liveOnly.sort(),
        sandbox_only: sandboxOnly.sort(),
        content_differs: contentDiffers.sort()
    };
}

// ── Gate Execution Path Resolution ───────────────────────────────────

// Control-plane path prefixes: files under these roots are read-only
// inputs that define gate behavior and should come from the sandbox
// when isolation mode is active.
const CONTROL_PLANE_PATH_PREFIXES = [
    'live/',
    'bin/',
    'dist/',
    'template/'
];

const CONTROL_PLANE_EXACT_FILES = new Set([
    'manifest.md',
    'version',
    'package.json'
]);

// Meta-configuration that must always be read from the live root because
// it determines whether the sandbox itself is active.
const ISOLATION_META_PATHS = new Set([
    'live/config/isolation-mode.json'
]);

/**
 * Determine whether a normalized relative path is a control-plane read
 * (eligible for sandbox routing) vs. a mutable runtime path.
 */
export function isControlPlanePath(normalizedRelativePath: string): boolean {
    const lower = normalizedRelativePath.toLowerCase();
    if (!lower) return false;
    if (ISOLATION_META_PATHS.has(lower)) return false;
    if (lower.startsWith('runtime/') || lower === 'runtime') return false;
    if (CONTROL_PLANE_EXACT_FILES.has(lower)) return true;
    return CONTROL_PLANE_PATH_PREFIXES.some(prefix => lower.startsWith(prefix));
}

/**
 * Resolve a path for gate execution. Control-plane paths are routed
 * through the sandbox when isolation mode is active and the sandbox
 * is valid. Mutable runtime paths always resolve against the live root.
 *
 * Callers may pass a pre-computed SandboxResolutionResult to avoid
 * repeated config/manifest I/O within a single gate invocation.
 */
export function resolveGateExecutionPath(
    repoRoot: string,
    relativePath: string,
    resolution?: SandboxResolutionResult | null
): string {
    const normalized = normalizePath(relativePath);
    if (!isControlPlanePath(normalized)) {
        return joinOrchestratorPath(repoRoot, relativePath);
    }

    const effectiveResolution = resolution ?? resolveIsolatedOrchestratorRoot(repoRoot);
    if (effectiveResolution.using_sandbox && effectiveResolution.sandbox_root) {
        return path.resolve(effectiveResolution.sandbox_root, normalized);
    }

    return joinOrchestratorPath(repoRoot, relativePath);
}

/**
 * POSIX variant of resolveGateExecutionPath for paths used in artifacts.
 */
export function resolveGateExecutionPathPosix(
    repoRoot: string,
    relativePath: string,
    resolution?: SandboxResolutionResult | null
): string {
    return toPosix(resolveGateExecutionPath(repoRoot, relativePath, resolution));
}

// ── Internal Helpers ─────────────────────────────────────────────────

function copyDirectoryRecursive(
    sourceDir: string,
    destDir: string,
    excludes: Set<string>
): { count: number; errors: string[] } {
    let count = 0;
    const errors: string[] = [];

    fs.mkdirSync(destDir, { recursive: true });

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    } catch (err: unknown) {
        errors.push(`Failed to read directory: ${sourceDir}: ${String(err)}`);
        return { count, errors };
    }

    for (const entry of entries) {
        if (excludes.has(entry.name)) continue;

        const srcPath = path.join(sourceDir, entry.name);
        const dstPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            const sub = copyDirectoryRecursive(srcPath, dstPath, excludes);
            count += sub.count;
            errors.push(...sub.errors);
        } else if (entry.isFile()) {
            try {
                fs.copyFileSync(srcPath, dstPath);
                count++;
            } catch (err: unknown) {
                errors.push(`Failed to copy ${srcPath}: ${String(err)}`);
            }
        }
    }

    return { count, errors };
}

/**
 * Mark all files in a directory tree as read-only.
 * Returns true if at least one file was successfully marked.
 * This is advisory hardening — same-user processes can override.
 */
function applyReadOnlyRecursive(dirPath: string): boolean {
    let applied = false;

    const walk = (currentDir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch { return; }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                try {
                    // Remove write permission: keep read + execute, strip write
                    fs.chmodSync(fullPath, 0o444);
                    applied = true;
                } catch {
                    // Best-effort on Windows; NTFS ACLs may not fully honor chmod
                }
            }
        }
    };

    walk(dirPath);
    return applied;
}

/**
 * Clear read-only flags before removal. Required on Windows where
 * rmSync fails on read-only files.
 */
function clearReadOnlyRecursive(dirPath: string): void {
    const walk = (currentDir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch { return; }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                try {
                    fs.chmodSync(fullPath, 0o666);
                } catch { /* best-effort */ }
            }
        }
    };

    walk(dirPath);
}

/**
 * Build a relative-path → SHA256 snapshot of all files in the sandbox.
 */
function buildSandboxSnapshot(sandboxRoot: string): Record<string, string> {
    const snapshot: Record<string, string> = {};

    const walk = (currentDir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch { return; }

        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.isFile()) {
                const relPath = normalizePath(path.relative(sandboxRoot, fullPath));
                const hash = fileSha256(fullPath);
                if (hash) {
                    snapshot[relPath] = hash;
                }
            }
        }
    };

    walk(sandboxRoot);
    return snapshot;
}

/**
 * Collect file hashes relative to a base root, excluding named directories.
 */
function collectHashes(
    dirPath: string,
    baseRoot: string,
    output: Record<string, string>,
    excludes: Set<string>
): void {
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch { return; }

    for (const entry of entries) {
        if (excludes.has(entry.name)) continue;
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            collectHashes(fullPath, baseRoot, output, excludes);
        } else if (entry.isFile()) {
            const relPath = normalizePath(path.relative(baseRoot, fullPath));
            const hash = fileSha256(fullPath);
            if (hash) {
                output[relPath] = hash;
            }
        }
    }
}

/**
 * Spot-check a sample of files for read-only status.
 * Returns true if the sample is entirely read-only (or empty).
 */
function checkReadOnlySample(sandboxRoot: string, relPaths: string[]): boolean {
    const sampleSize = Math.min(relPaths.length, 10);
    for (let i = 0; i < sampleSize; i++) {
        const fullPath = path.join(sandboxRoot, relPaths[i].replace(/\//g, path.sep));
        try {
            // Try opening for write; if it throws EACCES/EPERM, it's read-only
            const fd = fs.openSync(fullPath, 'r+');
            fs.closeSync(fd);
            return false; // writable file found
        } catch (err: unknown) {
            const code = (err as NodeJS.ErrnoException).code;
            if (code === 'EACCES' || code === 'EPERM') {
                continue; // correctly read-only
            }
            if (code === 'ENOENT') {
                continue; // file removed — count as acceptable
            }
            return false; // unexpected error
        }
    }
    return true;
}
