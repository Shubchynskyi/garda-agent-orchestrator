import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getCycleBindingSnapshotFromPayload,
    taskCycleScopeBindingsMatch,
    type TaskCycleBindingSnapshot
} from '../../../../gates/task-events-summary/task-events-summary';
import type {
    FullSuiteValidationCycleBinding,
    FullSuiteValidationResult
} from '../../../../gates/full-suite/full-suite-validation';
import * as gateHelpers from '../../../../gates/shared/helpers';

export function readLatestCompileGatePassedTimestamp(repoRoot: string, taskId: string): string | null {
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return null;
    }

    let latestTimestamp: string | null = null;
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            if (String(parsed.event_type || '').trim() !== 'COMPILE_GATE_PASSED') {
                continue;
            }
            const timestamp = String(parsed.timestamp_utc || '').trim();
            if (timestamp) {
                latestTimestamp = timestamp;
            }
        } catch {
            // Best-effort only; timeline integrity is validated elsewhere.
        }
    }

    return latestTimestamp;
}

function normalizeSha256Text(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export function readFullSuiteScopeBinding(
    repoRoot: string,
    taskId: string,
    preflight: Record<string, unknown>
): NonNullable<FullSuiteValidationCycleBinding['scope_binding']> | null {
    const compileGatePath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-compile-gate.json`)
    );
    const compileGate = fs.existsSync(compileGatePath) && fs.statSync(compileGatePath).isFile()
        ? JSON.parse(fs.readFileSync(compileGatePath, 'utf8')) as Record<string, unknown>
        : null;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const changedFilesSha256 = normalizeSha256Text(compileGate?.preflight_changed_files_sha256)
        || normalizeSha256Text(compileGate?.scope_changed_files_sha256)
        || normalizeSha256Text(metrics.changed_files_sha256);
    const scopeSha256 = normalizeSha256Text(compileGate?.preflight_scope_sha256)
        || normalizeSha256Text(metrics.scope_sha256);
    const scopeContentSha256 = normalizeSha256Text(compileGate?.preflight_scope_content_sha256)
        || normalizeSha256Text(metrics.scope_content_sha256);
    if (!changedFilesSha256 && !scopeSha256 && !scopeContentSha256) {
        return null;
    }
    return {
        changed_files_sha256: changedFilesSha256,
        scope_sha256: scopeSha256,
        scope_content_sha256: scopeContentSha256
    };
}

function buildCurrentTaskCycleBinding(cycleBinding: FullSuiteValidationCycleBinding): TaskCycleBindingSnapshot {
    return {
        preflight_path: gateHelpers.normalizePath(cycleBinding.preflight_path),
        preflight_sha256: String(cycleBinding.preflight_sha256 || '').trim().toLowerCase() || null,
        compile_gate_timestamp: cycleBinding.compile_gate_timestamp,
        scope_binding: cycleBinding.scope_binding ?? null
    };
}

export function tryReadRebindableFullSuiteValidationArtifact(options: {
    artifactPath: string;
    repoRoot: string;
    taskId: string;
    configCommand: string;
    cycleBinding: FullSuiteValidationCycleBinding;
}): FullSuiteValidationResult | null {
    if (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile()) {
        return null;
    }

    try {
        const raw = JSON.parse(fs.readFileSync(options.artifactPath, 'utf8')) as Record<string, unknown>;
        const status = String(raw.status || '').trim().toUpperCase();
        if (status !== 'PASSED' && status !== 'WARNED') {
            return null;
        }
        if (raw.enabled !== true) {
            return null;
        }
        if (String(raw.command || '').trim() !== options.configCommand) {
            return null;
        }
        const currentCycle = buildCurrentTaskCycleBinding(options.cycleBinding);
        const candidateCycle = getCycleBindingSnapshotFromPayload(raw, options.repoRoot);
        if (!candidateCycle?.compile_gate_timestamp || !currentCycle.compile_gate_timestamp) {
            return null;
        }
        const strictCurrent =
            candidateCycle.preflight_path === currentCycle.preflight_path
            && candidateCycle.preflight_sha256 === currentCycle.preflight_sha256
            && candidateCycle.compile_gate_timestamp === currentCycle.compile_gate_timestamp;
        if (strictCurrent) {
            return null;
        }
        const rawCycleBinding = raw.cycle_binding;
        if (!rawCycleBinding || typeof rawCycleBinding !== 'object' || Array.isArray(rawCycleBinding)) {
            return null;
        }
        if (String((rawCycleBinding as Record<string, unknown>).task_id || '').trim() !== options.taskId) {
            return null;
        }
        if (candidateCycle.preflight_path !== currentCycle.preflight_path) {
            return null;
        }
        if (!taskCycleScopeBindingsMatch(currentCycle, candidateCycle)) {
            return null;
        }
        return {
            ...(raw as unknown as FullSuiteValidationResult),
            cycle_binding: options.cycleBinding
        };
    } catch {
        return null;
    }
}
