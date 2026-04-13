import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    evaluateProtectedControlPlaneManifest,
    getProtectedControlPlaneRoots,
    joinOrchestratorPath,
    normalizePath,
    scanProtectedPathHashes,
    type ProtectedControlPlaneManifestEvidence
} from './helpers';

// ── Configuration ────────────────────────────────────────────────────

export const ISOLATION_ENFORCEMENT_MODES = Object.freeze([
    'STRICT',
    'LOG_ONLY'
] as const);

export type IsolationEnforcementMode = (typeof ISOLATION_ENFORCEMENT_MODES)[number];

export interface IsolationModeConfig {
    readonly enabled: boolean;
    readonly enforcement: IsolationEnforcementMode;
    readonly require_manifest_match_before_task: boolean;
    readonly refuse_on_preflight_drift: boolean;
    readonly use_sandbox: boolean;
    readonly same_user_limitation_notice: string;
}

const DEFAULT_CONFIG: IsolationModeConfig = Object.freeze({
    enabled: false,
    enforcement: 'LOG_ONLY',
    require_manifest_match_before_task: true,
    refuse_on_preflight_drift: true,
    use_sandbox: true,
    same_user_limitation_notice:
        'Control-plane isolation is a practical hardening measure, not a security boundary. ' +
        'An agent running under the same OS user can bypass read-only file attributes, ' +
        'rewrite ACLs, or replace source files before running gates. ' +
        'Enable isolation mode to reduce accidental mutation, not to prevent a determined adversary.'
});

// ── Config Loading ───────────────────────────────────────────────────

export function resolveIsolationModeConfigPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('live', 'config', 'isolation-mode.json'));
}

export function loadIsolationModeConfig(repoRoot: string): IsolationModeConfig {
    const configPath = resolveIsolationModeConfigPath(repoRoot);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return { ...DEFAULT_CONFIG };
    }

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const enforcement = normalizeEnforcementMode(raw.enforcement);
        return {
            enabled: raw.enabled === true,
            enforcement,
            require_manifest_match_before_task: raw.require_manifest_match_before_task !== false,
            refuse_on_preflight_drift: raw.refuse_on_preflight_drift !== false,
            use_sandbox: raw.use_sandbox !== false,
            same_user_limitation_notice:
                typeof raw.same_user_limitation_notice === 'string' && raw.same_user_limitation_notice.trim()
                    ? raw.same_user_limitation_notice.trim()
                    : DEFAULT_CONFIG.same_user_limitation_notice
        };
    } catch {
        return { ...DEFAULT_CONFIG };
    }
}

function normalizeEnforcementMode(value: unknown): IsolationEnforcementMode {
    const raw = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (ISOLATION_ENFORCEMENT_MODES.includes(raw as IsolationEnforcementMode)) {
        return raw as IsolationEnforcementMode;
    }
    return 'LOG_ONLY';
}

// ── Isolation Evidence ───────────────────────────────────────────────

export interface IsolationModeEvidence {
    isolation_enabled: boolean;
    enforcement: IsolationEnforcementMode;
    manifest_status: 'MISSING' | 'INVALID' | 'MATCH' | 'DRIFT';
    manifest_path: string;
    protected_roots: string[];
    protected_file_count: number;
    drift_files: string[];
    violations: string[];
    warnings: string[];
    same_user_limitation_notice: string;
}

/**
 * Evaluate isolation mode constraints before task execution begins.
 * Called during preflight or task-mode entry to determine whether
 * the control plane is in an acceptable state.
 */
export function evaluateIsolationModePreTask(repoRoot: string): IsolationModeEvidence {
    const config = loadIsolationModeConfig(repoRoot);
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const snapshot = scanProtectedPathHashes(repoRoot, protectedRoots);
    const manifestEvidence = evaluateProtectedControlPlaneManifest(repoRoot, snapshot);
    const violations: string[] = [];
    const warnings: string[] = [];

    if (config.enabled) {
        if (config.require_manifest_match_before_task) {
            validateManifestStatus(manifestEvidence, violations, warnings, config);
        }
    } else {
        warnings.push('Control-plane isolation mode is disabled. Enable in live/config/isolation-mode.json.');
    }

    return {
        isolation_enabled: config.enabled,
        enforcement: config.enforcement,
        manifest_status: manifestEvidence.status,
        manifest_path: normalizePath(manifestEvidence.manifest_path),
        protected_roots: protectedRoots,
        protected_file_count: Object.keys(snapshot).length,
        drift_files: manifestEvidence.changed_files,
        violations,
        warnings,
        same_user_limitation_notice: config.same_user_limitation_notice
    };
}

function validateManifestStatus(
    evidence: ProtectedControlPlaneManifestEvidence,
    violations: string[],
    warnings: string[],
    config: IsolationModeConfig
): void {
    const isStrict = config.enforcement === 'STRICT';
    const target = isStrict ? violations : warnings;
    const suffix = isStrict ? '' : ' (LOG_ONLY mode — task may continue)';

    switch (evidence.status) {
        case 'MISSING':
            target.push(
                'Control-plane isolation requires a trusted manifest, but none was found. ' +
                'Run setup/update/reinit to generate one.' + suffix
            );
            break;
        case 'INVALID':
            target.push(
                `Trusted control-plane manifest at '${normalizePath(evidence.manifest_path)}' is malformed. ` +
                'Re-run setup/update/reinit to regenerate.' + suffix
            );
            break;
        case 'DRIFT':
            if (config.refuse_on_preflight_drift) {
                target.push(
                    `Control-plane isolation detected drift in ${evidence.changed_files.length} file(s): ` +
                    `${evidence.changed_files.join(', ')}. ` +
                    'Refresh the trusted manifest or disable isolation mode.' + suffix
                );
            } else {
                warnings.push(
                    `Control-plane drift detected in ${evidence.changed_files.length} file(s): ` +
                    `${evidence.changed_files.join(', ')}. ` +
                    'Isolation mode is configured to allow continued execution.'
                );
            }
            break;
        case 'MATCH':
            break;
    }
}

/**
 * Evaluate isolation mode constraints at completion time.
 * Compares the post-task snapshot against the preflight snapshot
 * to detect unauthorized mutations of the control plane.
 */
export function evaluateIsolationModePostTask(
    repoRoot: string,
    preflightSnapshot: Record<string, string>
): IsolationModeEvidence {
    const config = loadIsolationModeConfig(repoRoot);
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const currentSnapshot = scanProtectedPathHashes(repoRoot, protectedRoots);
    const manifestEvidence = evaluateProtectedControlPlaneManifest(repoRoot, currentSnapshot);
    const violations: string[] = [];
    const warnings: string[] = [];

    if (!config.enabled) {
        return {
            isolation_enabled: false,
            enforcement: config.enforcement,
            manifest_status: manifestEvidence.status,
            manifest_path: normalizePath(manifestEvidence.manifest_path),
            protected_roots: protectedRoots,
            protected_file_count: Object.keys(currentSnapshot).length,
            drift_files: [],
            violations: [],
            warnings: [],
            same_user_limitation_notice: config.same_user_limitation_notice
        };
    }

    // Detect files that changed between preflight and completion snapshots
    const driftFiles: string[] = [];
    const allPaths = new Set([...Object.keys(preflightSnapshot), ...Object.keys(currentSnapshot)]);
    for (const p of allPaths) {
        if (preflightSnapshot[p] !== currentSnapshot[p]) {
            driftFiles.push(p);
        }
    }

    if (driftFiles.length > 0) {
        const message =
            `Control-plane isolation violation: ${driftFiles.length} protected file(s) changed during task execution: ` +
            `${driftFiles.join(', ')}.`;
        if (config.enforcement === 'STRICT') {
            violations.push(message);
        } else {
            warnings.push(message + ' (LOG_ONLY mode — task may continue)');
        }
    }

    return {
        isolation_enabled: true,
        enforcement: config.enforcement,
        manifest_status: manifestEvidence.status,
        manifest_path: normalizePath(manifestEvidence.manifest_path),
        protected_roots: protectedRoots,
        protected_file_count: Object.keys(currentSnapshot).length,
        drift_files: driftFiles,
        violations,
        warnings,
        same_user_limitation_notice: config.same_user_limitation_notice
    };
}

/**
 * Convenience predicate: does the current config enable isolation?
 */
export function isIsolationModeEnabled(repoRoot: string): boolean {
    return loadIsolationModeConfig(repoRoot).enabled;
}
