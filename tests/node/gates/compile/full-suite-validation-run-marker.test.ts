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

    it('clears dead current-cycle markers only after preserving recovery evidence', () => {
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

            const result = runFullSuiteRunMarkerRecoveryCommand({
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
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prints a bundle-relative cleanup command outside source checkouts', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-bundle-command-'));
        try {
            const taskId = 'T-MARKER-BUNDLE-COMMAND';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });

            const result = runFullSuiteRunMarkerRecoveryCommand({
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

    it('rejects recovery artifact paths that alias the run marker path', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-marker-alias-'));
        try {
            const taskId = 'T-MARKER-ALIAS';
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
            fs.writeFileSync(preflightPath, JSON.stringify({ task_id: taskId }), 'utf8');
            const preflightSha256 = fileSha256(preflightPath) || '';
            const markerPath = writeCurrentMarker({ repoRoot, taskId, preflightPath, preflightSha256 });

            assert.throws(
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

    it('refuses to clear current-cycle markers with Windows descendant process evidence', () => {
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

            const result = runFullSuiteRunMarkerRecoveryCommand({
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
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('refuses cleanup when process scanning warning makes descendant state unknown', () => {
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

            const result = runFullSuiteRunMarkerRecoveryCommand({
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

    it('refuses to clear stale or unknown marker state automatically', () => {
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

            const result = runFullSuiteRunMarkerRecoveryCommand({
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
