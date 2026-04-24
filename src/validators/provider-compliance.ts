import * as fs from 'node:fs';
import * as path from 'node:path';
import { ALL_AGENT_ENTRYPOINT_FILES } from '../core/constants';
import { pathExists, readTextFile } from '../core/fs';
import {
    getProviderOrchestratorProfileDefinitions,
    normalizeAgentEntrypointToken,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from '../materialization/common';
import { MANAGED_START, MANAGED_END } from '../materialization/content-builders';
import { getBundlePath } from './workspace-layout';
import {
    loadIndex,
    entriesByArtifactSuffix,
    type ReviewsIndex,
    type ReviewsIndexEntry
} from '../gate-runtime/reviews-index';

const START_TASK_ROUTER_REFERENCE = '.agents/workflows/start-task.md';

export interface EntrypointComplianceItem {
    file: string;
    kind: 'root-entrypoint' | 'provider-bridge';
    exists: boolean;
    referencesRouter: boolean;
    routerReferenceMissing: string | null;
    hasManagedBlock: boolean;
    violations: string[];
}

export interface HandshakeArtifactSummary {
    taskId: string;
    artifactPath: string;
    status: string;
    provider: string | null;
    stale: boolean;
    violations: string[];
}

export interface ProviderComplianceResult {
    routerPath: string;
    routerExists: boolean;
    entrypoints: EntrypointComplianceItem[];
    handshakeArtifacts: HandshakeArtifactSummary[];
    violations: string[];
    passed: boolean;
}

function readFileSafe(filePath: string): string | null {
    try {
        if (!pathExists(filePath)) return null;
        if (!fs.lstatSync(filePath).isFile()) return null;
        return readTextFile(filePath);
    } catch {
        return null;
    }
}

function checkRouterReference(content: string): boolean {
    return content.includes(START_TASK_ROUTER_REFERENCE);
}

function checkManagedBlock(content: string): boolean {
    return content.includes(MANAGED_START) && content.includes(MANAGED_END);
}

function checkEntrypoint(
    targetRoot: string,
    relativePath: string,
    kind: 'root-entrypoint' | 'provider-bridge'
): EntrypointComplianceItem {
    const fullPath = path.join(targetRoot, relativePath);
    const item: EntrypointComplianceItem = {
        file: relativePath,
        kind,
        exists: false,
        referencesRouter: false,
        routerReferenceMissing: null,
        hasManagedBlock: false,
        violations: []
    };

    const content = readFileSafe(fullPath);
    if (content === null) {
        item.exists = false;
        item.violations.push(
            `${relativePath} is active but not materialized. Run setup or install to create it.`
        );
        return item;
    }

    item.exists = true;
    item.hasManagedBlock = checkManagedBlock(content);
    item.referencesRouter = checkRouterReference(content);

    if (!item.hasManagedBlock) {
        item.violations.push(
            `${relativePath} is missing managed block markers. May have been manually edited or not materialized.`
        );
    }

    if (!item.referencesRouter) {
        item.routerReferenceMissing = START_TASK_ROUTER_REFERENCE;
        item.violations.push(
            `${relativePath} does not reference the shared start-task router '${START_TASK_ROUTER_REFERENCE}'.`
        );
    }

    return item;
}

function scanHandshakeArtifacts(targetRoot: string): HandshakeArtifactSummary[] {
    const bundlePath = getBundlePath(targetRoot);
    const reviewsDir = path.join(bundlePath, 'runtime', 'reviews');
    if (!pathExists(reviewsDir)) return [];

    let index: ReviewsIndex;
    try {
        const result = loadIndex(reviewsDir, { readOnly: true });
        index = result.index;
    } catch {
        return [];
    }

    const handshakeEntries = entriesByArtifactSuffix(index, 'handshake.json');
    const taskModeEntries = entriesByArtifactSuffix(index, 'task-mode.json');
    const taskModeMap = new Map<string, ReviewsIndexEntry>();
    for (const entry of taskModeEntries) {
        taskModeMap.set(entry.taskId, entry);
    }

    const artifacts: HandshakeArtifactSummary[] = [];

    for (const entry of handshakeEntries) {
        const taskId = entry.taskId;
        const artifactPath = path.join(reviewsDir, entry.fileName);
        const summary: HandshakeArtifactSummary = {
            taskId,
            artifactPath: artifactPath.replace(/\\/g, '/'),
            status: 'UNKNOWN',
            provider: null,
            stale: false,
            violations: []
        };

        try {
            const raw = readTextFile(artifactPath);
            const parsed = JSON.parse(raw) as Record<string, unknown>;

            summary.status = String(parsed.status || 'UNKNOWN').toUpperCase();
            summary.provider = typeof parsed.provider === 'string' ? parsed.provider : null;

            if (summary.status === 'FAILED') {
                const artifactViolations = Array.isArray(parsed.violations) ? parsed.violations : [];
                for (const v of artifactViolations) {
                    summary.violations.push(String(v));
                }
            }

            // Detect staleness using index metadata when possible,
            // falling back to filesystem stat for precision
            const taskModeEntry = taskModeMap.get(taskId);
            if (taskModeEntry) {
                if (taskModeEntry.mtimeMs > entry.mtimeMs + 1000) {
                    summary.stale = true;
                    summary.violations.push(
                        `Handshake artifact for ${taskId} is older than task-mode artifact; may be from a previous run.`
                    );
                }
            } else {
                // Fallback to filesystem for task-mode artifacts not in index
                const taskModeArtifact = path.join(reviewsDir, `${taskId}-task-mode.json`);
                if (pathExists(taskModeArtifact)) {
                    try {
                        const handshakeStat = fs.statSync(artifactPath);
                        const taskModeStat = fs.statSync(taskModeArtifact);
                        if (taskModeStat.mtimeMs > handshakeStat.mtimeMs + 1000) {
                            summary.stale = true;
                            summary.violations.push(
                                `Handshake artifact for ${taskId} is older than task-mode artifact; may be from a previous run.`
                            );
                        }
                    } catch {
                        // stat errors are not critical for staleness check
                    }
                }
            }
        } catch {
            summary.status = 'UNREADABLE';
            summary.violations.push(`Handshake artifact for ${taskId} is unreadable or invalid JSON.`);
        }

        artifacts.push(summary);
    }

    // Detect tasks with task-mode but no handshake artifact
    const handshakeTaskIds = new Set(handshakeEntries.map((e) => e.taskId));
    for (const entry of taskModeEntries) {
        if (handshakeTaskIds.has(entry.taskId)) continue;
        artifacts.push({
            taskId: entry.taskId,
            artifactPath: path.join(reviewsDir, `${entry.taskId}-handshake.json`).replace(/\\/g, '/'),
            status: 'MISSING',
            provider: null,
            stale: false,
            violations: [
                `Handshake artifact missing for ${entry.taskId}. Task entered task-mode but handshake-diagnostics was not run.`
            ]
        });
    }

    return artifacts;
}

export interface ProviderComplianceOptions {
    /** When set, only handshake violations for this task affect `passed`. */
    activeTaskId?: string;
}

function normalizeActiveAgentFilesForCompliance(activeAgentFiles: readonly string[]): {
    activeSet: Set<string>;
    violations: string[];
} {
    const activeSet = new Set<string>();
    const violations: string[] = [];

    for (const token of activeAgentFiles) {
        const raw = String(token || '').trim();
        if (!raw) continue;
        try {
            const normalized = normalizeAgentEntrypointToken(raw);
            if (normalized) {
                activeSet.add(normalized);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            violations.push(`ActiveAgentFiles token '${raw}' is invalid for provider compliance scan: ${message}`);
        }
    }

    return { activeSet, violations };
}

/**
 * Runs a full provider-control compliance scan for the workspace.
 * Checks root entrypoints, provider bridges, shared start-task router,
 * and handshake artifacts for drift, staleness, and missing references.
 *
 * Handshake artifacts are per-task execution evidence, not workspace-level
 * structural state.  Without `activeTaskId`, their violations are
 * informational only and do not affect the `passed` verdict.
 */
export function scanProviderCompliance(
    targetRoot: string,
    activeAgentFiles: readonly string[],
    options?: ProviderComplianceOptions
): ProviderComplianceResult {
    const resolvedRoot = path.resolve(targetRoot);
    const violations: string[] = [];
    const normalizedActive = normalizeActiveAgentFilesForCompliance(activeAgentFiles);
    const activeSet = normalizedActive.activeSet;
    violations.push(...normalizedActive.violations);

    // 1. Check shared start-task router exists
    const routerFullPath = path.join(resolvedRoot, SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
    const routerExists = pathExists(routerFullPath) && fs.lstatSync(routerFullPath).isFile();

    if (!routerExists) {
        violations.push(
            `Shared start-task router '${SHARED_START_TASK_WORKFLOW_RELATIVE_PATH}' is missing. ` +
            'Root entrypoints and provider bridges cannot route to the canonical workflow without it.'
        );
    }

    // 2. Check each active root entrypoint
    const entrypoints: EntrypointComplianceItem[] = [];
    const profiles = getProviderOrchestratorProfileDefinitions();

    for (const entrypointFile of ALL_AGENT_ENTRYPOINT_FILES) {
        if (!activeSet.has(entrypointFile)) continue;
        const item = checkEntrypoint(resolvedRoot, entrypointFile, 'root-entrypoint');
        entrypoints.push(item);
        for (const v of item.violations) {
            violations.push(v);
        }
    }

    // 3. Check provider bridges for active entrypoints
    for (const profile of profiles) {
        if (!activeSet.has(profile.entrypointFile)) continue;
        const bridgeItem = checkEntrypoint(resolvedRoot, profile.orchestratorRelativePath, 'provider-bridge');
        entrypoints.push(bridgeItem);
        for (const v of bridgeItem.violations) {
            violations.push(v);
        }
    }

    // 4. Providers with self-referential bridge requirements must reference
    // their own bridge path consistently.
    for (const profile of profiles) {
        if (profile.selfReferenceRequirement !== 'bridge_path') continue;
        if (!activeSet.has(profile.entrypointFile)) continue;

        const bridgePath = path.join(resolvedRoot, profile.orchestratorRelativePath);
        const bridgeContent = readFileSafe(bridgePath);
        if (bridgeContent !== null && !bridgeContent.includes(profile.orchestratorRelativePath)) {
            violations.push(
                `${profile.providerLabel} bridge '${profile.orchestratorRelativePath}' does not reference its own bridge path. ` +
                'Provider alias may be misaligned.'
            );
        }
    }

    // 5. Scan handshake artifacts
    const handshakeArtifacts = scanHandshakeArtifacts(resolvedRoot);
    const activeTaskId = options?.activeTaskId;
    for (const artifact of handshakeArtifacts) {
        if (artifact.status === 'FAILED' || artifact.status === 'UNREADABLE' || artifact.status === 'MISSING' || artifact.stale) {
            // Only the active task's handshake violations affect workspace
            // compliance.  Historical task artifacts are informational; they
            // must not poison the current readiness verdict.
            if (activeTaskId && artifact.taskId === activeTaskId) {
                for (const v of artifact.violations) {
                    violations.push(v);
                }
            }
        }
    }

    return {
        routerPath: SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        routerExists,
        entrypoints,
        handshakeArtifacts,
        violations,
        passed: violations.length === 0
    };
}

export function formatProviderComplianceSummary(result: ProviderComplianceResult): string[] {
    const lines: string[] = [];
    lines.push('Provider Control Compliance');

    const routerBadge = result.routerExists ? '[x]' : '[ ]';
    lines.push(`  ${routerBadge} Shared router: ${result.routerPath}`);

    const activeEntrypoints = result.entrypoints.filter((e) => e.kind === 'root-entrypoint');
    const activeBridges = result.entrypoints.filter((e) => e.kind === 'provider-bridge');

    if (activeEntrypoints.length > 0) {
        for (const ep of activeEntrypoints) {
            const badge = ep.exists && ep.violations.length === 0 ? '[x]' : '[ ]';
            const suffix = !ep.exists ? ' (missing)' : '';
            lines.push(`  ${badge} Entrypoint: ${ep.file}${suffix}`);
        }
    }

    if (activeBridges.length > 0) {
        for (const bridge of activeBridges) {
            const badge = bridge.exists && bridge.violations.length === 0 ? '[x]' : '[ ]';
            const suffix = !bridge.exists ? ' (missing)' : '';
            lines.push(`  ${badge} Bridge: ${bridge.file}${suffix}`);
        }
    }

    if (result.handshakeArtifacts.length > 0) {
        const presentCount = result.handshakeArtifacts.filter((a) => a.status !== 'MISSING').length;
        const issueCount = result.handshakeArtifacts.filter(
            (a) => a.status === 'FAILED' || a.status === 'UNREADABLE' || a.status === 'MISSING' || a.stale
        ).length;
        lines.push(
            `  Handshake artifacts: ${presentCount} found, ${result.handshakeArtifacts.length} tracked` +
            (issueCount > 0 ? `, ${issueCount} with issues` : '')
        );
    }

    if (!result.passed) {
        for (const v of result.violations) {
            lines.push(`  Drift: ${v}`);
        }
    }

    return lines;
}

export function formatProviderComplianceDetail(result: ProviderComplianceResult): string[] {
    const lines: string[] = [];
    lines.push('Provider Control Compliance');

    // Router
    if (result.routerExists) {
        lines.push(`  Router: ${result.routerPath} (exists)`);
    } else {
        lines.push(`  Router: ${result.routerPath} (MISSING)`);
    }

    // Entrypoints and bridges
    for (const ep of result.entrypoints) {
        const statusText = !ep.exists
            ? 'not materialized'
            : ep.violations.length === 0
                ? 'OK'
                : `${ep.violations.length} issue(s)`;
        lines.push(`  ${ep.kind}: ${ep.file} (${statusText})`);
        if (ep.exists) {
            lines.push(`    managed_block: ${ep.hasManagedBlock ? 'yes' : 'MISSING'}`);
            lines.push(`    references_router: ${ep.referencesRouter ? 'yes' : 'NO'}`);
        }
        for (const v of ep.violations) {
            lines.push(`    Violation: ${v}`);
        }
    }

    // Handshake artifacts
    if (result.handshakeArtifacts.length > 0) {
        lines.push('  Handshake Artifacts');
        for (const artifact of result.handshakeArtifacts) {
            const staleTag = artifact.stale ? ' [STALE]' : '';
            lines.push(
                `    ${artifact.taskId}: status=${artifact.status}` +
                (artifact.provider ? ` provider=${artifact.provider}` : '') +
                staleTag
            );
            for (const v of artifact.violations) {
                lines.push(`      - ${v}`);
            }
        }
    }

    // Summary
    if (result.passed) {
        lines.push('  Status: PASS');
    } else {
        lines.push('  Status: DRIFT_DETECTED');
        lines.push(`  ViolationCount: ${result.violations.length}`);
    }

    return lines;
}
