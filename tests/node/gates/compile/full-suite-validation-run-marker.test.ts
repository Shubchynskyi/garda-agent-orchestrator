import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    parseWindowsProcessRows,
    readInterruptedFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath
} from '../../../../src/gates/full-suite/full-suite-validation-run-marker';
import {
    runFullSuiteRunMarkerRecoveryCommand
} from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-run-marker-recovery';
import { fileSha256, normalizePath } from '../../../../src/gates/shared/helpers';

describe('full-suite validation run marker', () => {
    function writeCurrentMarker(options: {
        repoRoot: string;
        taskId: string;
        preflightPath: string;
        preflightSha256: string;
        gatePid?: number;
        childPid?: number | null;
    }): string {
        const markerPath = resolveFullSuiteValidationRunMarkerPath(options.repoRoot, options.taskId);
        fs.writeFileSync(markerPath, `${JSON.stringify({
            schema_version: 1,
            task_id: options.taskId,
            status: 'running',
            started_at_utc: '2026-06-07T01:01:00.000Z',
            updated_at_utc: '2026-06-07T01:01:00.000Z',
            repo_root: normalizePath(options.repoRoot),
            cwd: normalizePath(options.repoRoot),
            command: 'npm test',
            timeout_ms: 600000,
            gate_pid: options.gatePid ?? 999999,
            child_pid: options.childPid ?? null,
            child_command: options.childPid == null ? null : 'node.exe',
            child_args: [],
            child_shell: null,
            preflight_path: normalizePath(options.preflightPath),
            preflight_sha256: options.preflightSha256,
            cycle_binding: {
                task_id: options.taskId,
                preflight_path: normalizePath(options.preflightPath),
                preflight_sha256: options.preflightSha256,
                compile_gate_timestamp: null,
                scope_binding: null
            }
        }, null, 2)}\n`, 'utf8');
        return markerPath;
    }

    it('rejects stale interrupted markers from a prior compile cycle with the same preflight', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-'));
        try {
            const taskId = 'T-MARKER';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath);
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            const cycleBinding = {
                task_id: taskId,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                compile_gate_timestamp: '2026-06-07T01:00:00.000Z',
                scope_binding: null
            };
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: null,
                child_command: null,
                child_args: [],
                child_shell: null,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                cycle_binding: cycleBinding
            }, null, 2)}\n`, 'utf8');

            const stale = readInterruptedFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T02:00:00.000Z'
            );
            const current = readInterruptedFullSuiteValidationRunMarker(
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                '2026-06-07T01:00:00.000Z'
            );

            assert.equal(stale, null);
            assert.equal(current?.command, 'npm test');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('parses Windows process snapshots for descendant detection', () => {
        const entries = parseWindowsProcessRows([
            { ProcessId: 1200, ParentProcessId: 1100, CommandLine: 'node.exe scripts/node-foundation/build-scripts.cjs' },
            { ProcessId: 1300, ParentProcessId: 1200, CommandLine: 'powershell.exe -NoProfile' },
            { ProcessId: 'bad', ParentProcessId: 1200, CommandLine: 'ignored.exe' }
        ]);

        assert.deepEqual(entries, [
            {
                pid: 1200,
                parentPid: 1100,
                commandLine: 'node.exe scripts/node-foundation/build-scripts.cjs'
            },
            {
                pid: 1300,
                parentPid: 1200,
                commandLine: 'powershell.exe -NoProfile'
            }
        ]);
    });

    it('clears dead current-cycle markers only after preserving recovery evidence', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-clear-'));
        try {
            const taskId = 'T-MARKER-CLEAR';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath);
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: null,
                child_command: null,
                child_args: [],
                child_shell: null,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: preflightSha256,
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: normalizePath(preflightPath),
                    preflight_sha256: preflightSha256,
                    compile_gate_timestamp: null,
                    scope_binding: null
                }
            }, null, 2)}\n`, 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes'
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: CLEARED_DEAD_MARKER')));
            assert.equal(fs.existsSync(markerPath), false);
            const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(artifact.status, 'CLEARED_DEAD_MARKER');
            assert.equal(artifact.marker_path, normalizePath(markerPath));
            const fullSuiteArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
            const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuiteArtifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(fullSuiteArtifact.status, 'FAILED');
            assert.equal(fullSuiteArtifact.timed_out, true);
            assert.equal(fullSuiteArtifact.output_retention && typeof fullSuiteArtifact.output_retention === 'object'
                ? (fullSuiteArtifact.output_retention as Record<string, unknown>).raw_output_retained
                : null, true);
            assert.equal(fullSuiteArtifact.failure_evidence && typeof fullSuiteArtifact.failure_evidence === 'object'
                ? (fullSuiteArtifact.failure_evidence as Record<string, unknown>).copied_logs_count
                : null, 0);
            const compactSummary = fullSuiteArtifact.compact_summary;
            assert.ok(Array.isArray(compactSummary));
            const compactSummaryText = compactSummary.join('\n');
            assert.match(compactSummaryText, new RegExp(`NextRecoveryCommand: .+next-step "${taskId}" --repo-root "\\."`, 'u'));
            assert.match(compactSummaryText, new RegExp(`CleanupCommand: .+gate full-suite-run-marker-recovery --task-id "${taskId}"`, 'u'));
            const outputLog = fs.readFileSync(path.join(reviewsRoot, `${taskId}-full-suite-output.log`), 'utf8');
            assert.match(outputLog, /FULL_SUITE_INTERRUPTED_TIMEOUT_RECOVERY/u);
            assert.match(outputLog, new RegExp(`CleanupCommand: .+gate full-suite-run-marker-recovery --task-id "${taskId}"`, 'u'));
            const timeline = fs.readFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('preserves existing current-cycle successful full-suite evidence when clearing a dead marker', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-preserve-pass-'));
        try {
            const taskId = 'T-MARKER-PRESERVE-PASS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 600000
                }
            }), 'utf8');
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });
            const fullSuiteArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
            fs.writeFileSync(fullSuiteArtifactPath, `${JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command: 'npm test',
                exit_code: 0,
                timed_out: false,
                output_artifact_path: null,
                compact_summary: ['preexisting pass evidence'],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: [],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: normalizePath(preflightPath),
                    preflight_sha256: preflightSha256,
                    compile_gate_timestamp: null,
                    scope_binding: null
                }
            }, null, 2)}\n`, 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes'
            });

            assert.equal(result.exitCode, 0);
            assert.equal(fs.existsSync(markerPath), false);
            const fullSuiteArtifact = JSON.parse(fs.readFileSync(fullSuiteArtifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(fullSuiteArtifact.status, 'PASSED');
            assert.deepEqual(fullSuiteArtifact.compact_summary, ['preexisting pass evidence']);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-full-suite-output.log`)), false);
            const recoveryArtifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
                'utf8'
            )) as Record<string, unknown>;
            const terminalEvidence = recoveryArtifact.terminal_full_suite_evidence as Record<string, unknown>;
            assert.equal(terminalEvidence.status, 'PRESERVED_CURRENT_TERMINAL');
            assert.equal(terminalEvidence.full_suite_status, 'PASSED');
            const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
            const timeline = fs.existsSync(timelinePath) ? fs.readFileSync(timelinePath, 'utf8') : '';
            assert.doesNotMatch(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/u);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not claim cleared cleanup when terminal evidence materialization fails', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-materialize-fail-'));
        try {
            const taskId = 'T-MARKER-MATERIALIZE-FAIL';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });
            const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(path.dirname(eventsRoot), { recursive: true });
            fs.writeFileSync(eventsRoot, 'not a directory', 'utf8');

            await assert.rejects(() => runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes'
            }));

            assert.equal(fs.existsSync(markerPath), true);
            const recoveryArtifact = JSON.parse(fs.readFileSync(
                path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`),
                'utf8'
            )) as Record<string, unknown>;
            assert.equal(recoveryArtifact.status, 'DEAD_MARKER');
            assert.equal(recoveryArtifact.terminal_full_suite_evidence, null);
            const fullSuiteArtifactPath = path.join(reviewsRoot, `${taskId}-full-suite-validation.json`);
            assert.equal(fs.existsSync(fullSuiteArtifactPath), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prints a bundle-relative cleanup command outside source checkouts', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-bundle-command-'));
        try {
            const taskId = 'T-MARKER-BUNDLE-COMMAND';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: DEAD_MARKER')));
            assert.ok(result.outputLines.some((line) => line.includes('CleanupCommand: node garda-agent-orchestrator/bin/garda.js gate full-suite-run-marker-recovery')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects recovery artifact paths that alias the run marker path', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-alias-'));
        try {
            const taskId = 'T-MARKER-ALIAS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });

            await assert.rejects(
                () => runFullSuiteRunMarkerRecoveryCommand({
                    repoRoot,
                    taskId,
                    preflightPath,
                    artifactPath: markerPath,
                    clearDeadMarker: true,
                    operatorConfirmed: 'yes'
                }),
                /ArtifactPath must not equal the full-suite run marker path/u
            );
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses to clear current-cycle markers with Windows descendant process evidence', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-descendants-'));
        try {
            const taskId = 'T-MARKER-DESCENDANTS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 1200
            });
            const entries = parseWindowsProcessRows([
                { ProcessId: 1300, ParentProcessId: 1200, CommandLine: 'node.exe shard-one.js' },
                { ProcessId: 1400, ParentProcessId: 1300, CommandLine: 'powershell.exe nested.ps1' }
            ]);

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: {
                    isProcessAlive: () => false,
                    processTableSnapshot: { entries, warning: null }
                }
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: REFUSED_LIVE_CLEAR')));
            assert.ok(result.outputLines.some((line) => line.includes('DescendantCandidates: pid=1300,ppid=1200; pid=1400,ppid=1300')));
            assert.equal(fs.existsSync(markerPath), true);
            const artifactPath = path.join(reviewsRoot, `${taskId}-full-suite-run-marker-recovery.json`);
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Record<string, unknown>;
            assert.equal(artifact.status, 'REFUSED_LIVE_CLEAR');
            const summary = artifact.recovery_summary as { descendant_process_candidates: unknown[] };
            assert.equal(summary.descendant_process_candidates.length, 2);
            assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-full-suite-validation.json`)), false);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses cleanup when process scanning warning makes descendant state unknown', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-scan-warning-'));
        try {
            const taskId = 'T-MARKER-SCAN-WARNING';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({
                repoRoot,
                taskId,
                preflightPath,
                preflightSha256,
                childPid: 1200
            });

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes',
                inspectionOptions: {
                    isProcessAlive: () => false,
                    processTableSnapshot: {
                        entries: [],
                        warning: 'Unable to scan live process descendants: powershell failed'
                    }
                }
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: REFUSED_LIVE_CLEAR')));
            assert.ok(result.outputLines.some((line) => line.includes('ProcessScanWarning: Unable to scan live process descendants: powershell failed')));
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses to clear stale or unknown marker state automatically', async () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-unknown-'));
        try {
            const taskId = 'T-MARKER-UNKNOWN';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
            fs.writeFileSync(markerPath, `${JSON.stringify({
                schema_version: 1,
                task_id: taskId,
                status: 'running',
                started_at_utc: '2026-06-07T01:01:00.000Z',
                updated_at_utc: '2026-06-07T01:01:00.000Z',
                repo_root: normalizePath(repoRoot),
                cwd: normalizePath(repoRoot),
                command: 'npm test',
                timeout_ms: 600000,
                gate_pid: 999999,
                child_pid: null,
                child_command: null,
                child_args: [],
                child_shell: null,
                preflight_path: normalizePath(preflightPath),
                preflight_sha256: '0'.repeat(64),
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: normalizePath(preflightPath),
                    preflight_sha256: '0'.repeat(64),
                    compile_gate_timestamp: null,
                    scope_binding: null
                }
            }, null, 2)}\n`, 'utf8');

            const result = await runFullSuiteRunMarkerRecoveryCommand({
                repoRoot,
                taskId,
                preflightPath,
                clearDeadMarker: true,
                operatorConfirmed: 'yes'
            });

            assert.notEqual(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('Status: UNKNOWN_STATE')));
            assert.equal(fs.existsSync(markerPath), true);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
