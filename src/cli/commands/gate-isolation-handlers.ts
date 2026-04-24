import * as path from 'node:path';
import { appendTaskEventAsync } from '../../gate-runtime/task-events';
import * as gateHelpers from '../../gates/helpers';
import { normalizePath } from '../../gates/helpers';
import {
    evaluateIsolationModePreTask,
    loadIsolationModeConfig
} from '../../gates/isolation-mode';
import {
    compareSandboxToLive,
    prepareSandbox,
    resolveIsolatedOrchestratorRoot,
    validateSandbox
} from '../../gates/isolation-sandbox';
import { parseOptions } from './cli-helpers';
import { EXIT_GATE_FAILURE } from '../exit-codes';

export async function handleValidateIsolation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const isolationRepoRoot = path.resolve(String(options.repoRoot || '.'));
    const evidence = evaluateIsolationModePreTask(isolationRepoRoot);
    const sandboxValidation = validateSandbox(isolationRepoRoot);
    const sandboxResolution = resolveIsolatedOrchestratorRoot(isolationRepoRoot);
    const lines: string[] = [];
    lines.push(evidence.isolation_enabled ? 'ISOLATION_MODE_ENABLED' : 'ISOLATION_MODE_DISABLED');
    lines.push(`Enforcement: ${evidence.enforcement}`);
    lines.push(`ManifestStatus: ${evidence.manifest_status}`);
    lines.push(`ProtectedFileCount: ${evidence.protected_file_count}`);
    if (evidence.drift_files.length > 0) {
        lines.push(`DriftFiles: ${evidence.drift_files.join(', ')}`);
    }
    lines.push(`SandboxExists: ${sandboxValidation.exists}`);
    lines.push(`SandboxManifestValid: ${sandboxValidation.manifest_valid}`);
    lines.push(`SandboxFileCount: ${sandboxValidation.file_count}`);
    lines.push(`SandboxReadOnlyIntact: ${sandboxValidation.read_only_intact}`);
    lines.push(`SandboxDriftFiles: ${sandboxValidation.drift_files.length}`);
    lines.push(`UsingSandbox: ${sandboxResolution.using_sandbox}`);
    lines.push(`ResolvedRoot: ${normalizePath(sandboxResolution.resolved_root)}`);
    lines.push(`SandboxReason: ${sandboxResolution.reason}`);
    if (evidence.violations.length > 0) {
        lines.push('Violations:');
        for (const v of evidence.violations) {
            lines.push(`  - ${v}`);
        }
    }
    if (evidence.warnings.length > 0) {
        lines.push('Warnings:');
        for (const w of evidence.warnings) {
            lines.push(`  - ${w}`);
        }
    }
    if (sandboxValidation.errors.length > 0) {
        lines.push('SandboxErrors:');
        for (const e of sandboxValidation.errors) {
            lines.push(`  - ${e}`);
        }
    }
    lines.push(`SameUserNotice: ${evidence.same_user_limitation_notice}`);
    console.log(lines.join('\n'));

    if (evidence.violations.length > 0 && evidence.enforcement === 'STRICT') {
        process.exitCode = EXIT_GATE_FAILURE;
    }

    if (options.taskId) {
        const orchestratorRoot = gateHelpers.joinOrchestratorPath(isolationRepoRoot, '');
        const eventType = evidence.isolation_enabled
            ? 'ISOLATION_MODE_VALIDATED'
            : 'ISOLATION_MODE_SKIPPED';
        await appendTaskEventAsync(
            orchestratorRoot,
            String(options.taskId),
            eventType,
            evidence.violations.length > 0 ? 'WARN' : 'PASS',
            `Isolation mode ${evidence.isolation_enabled ? 'enabled' : 'disabled'}, enforcement=${evidence.enforcement}, manifest=${evidence.manifest_status}, sandbox=${sandboxResolution.using_sandbox}`,
            {
                isolation_enabled: evidence.isolation_enabled,
                enforcement: evidence.enforcement,
                manifest_status: evidence.manifest_status,
                violations_count: evidence.violations.length,
                warnings_count: evidence.warnings.length,
                sandbox_exists: sandboxValidation.exists,
                sandbox_using: sandboxResolution.using_sandbox,
                sandbox_reason: sandboxResolution.reason
            }
        );
    }
}

export async function handlePrepareIsolation(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const isolationRepoRoot = path.resolve(String(options.repoRoot || '.'));
    const config = loadIsolationModeConfig(isolationRepoRoot);

    if (!config.enabled) {
        console.log('ISOLATION_MODE_DISABLED');
        console.log('Enable isolation mode in live/config/isolation-mode.json before preparing the sandbox.');
        return;
    }

    const result = prepareSandbox(isolationRepoRoot);
    const lines: string[] = [];
    lines.push('ISOLATION_SANDBOX_PREPARED');
    lines.push(`SandboxRoot: ${normalizePath(result.sandbox_root)}`);
    lines.push(`ManifestPath: ${normalizePath(result.sandbox_manifest_path)}`);
    lines.push(`FileCount: ${result.file_count}`);
    lines.push(`ReadOnlyApplied: ${result.read_only_applied}`);
    if (result.skipped_directories.length > 0) {
        lines.push(`SkippedDirectories: ${result.skipped_directories.join(', ')}`);
    }
    if (result.errors.length > 0) {
        lines.push('Errors:');
        for (const e of result.errors) {
            lines.push(`  - ${e}`);
        }
    }

    const comparison = compareSandboxToLive(isolationRepoRoot);
    lines.push(`SandboxMatchesLive: ${comparison.match}`);
    if (!comparison.match) {
        if (comparison.live_only.length > 0) {
            lines.push(`LiveOnly: ${comparison.live_only.length} file(s)`);
        }
        if (comparison.content_differs.length > 0) {
            lines.push(`ContentDiffers: ${comparison.content_differs.length} file(s)`);
        }
    }

    lines.push(`SameUserNotice: ${config.same_user_limitation_notice}`);
    console.log(lines.join('\n'));

    if (options.taskId) {
        const orchestratorRoot = gateHelpers.joinOrchestratorPath(isolationRepoRoot, '');
        await appendTaskEventAsync(
            orchestratorRoot,
            String(options.taskId),
            'ISOLATION_SANDBOX_PREPARED',
            result.errors.length > 0 ? 'WARN' : 'PASS',
            `Sandbox prepared: ${result.file_count} files, read_only=${result.read_only_applied}, matches_live=${comparison.match}`,
            {
                file_count: result.file_count,
                read_only_applied: result.read_only_applied,
                sandbox_matches_live: comparison.match,
                errors_count: result.errors.length,
                sandbox_root: normalizePath(result.sandbox_root)
            }
        );
    }
}
