import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../../src/core/constants';
import {
    buildDocsOnlyNotRequiredResult,
    buildFullSuiteTimeoutForecast,
    buildFullSuiteValidationOutputTelemetry,
    buildSkippedResult,
    buildValidationResult,
    compactGreenSummary,
    compactRedFailureChunks,
    detectOutOfScopeFailures,
    formatFullSuiteTimeoutForecast,
    formatFullSuiteValidationResult,
    isFullSuiteNotRequiredForDocsOnlyScope,
    loadFullSuiteValidationConfig,
    recordFullSuiteValidationDuration,
    resolveFullSuiteDurationHistoryPath,
    type FullSuiteValidationConfig
} from '../../../../src/gates/full-suite/full-suite-validation';
import { shouldOmitSuccessfulFullSuiteOutput } from '../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-flow';
import { getCurrentWorkflowConfigFileHashes } from '../../../../src/gates/workflow-config/workflow-config-work';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { countTextChars } from '../../../../src/gate-runtime/text-utils';
import { runCliWithCapturedOutput } from '../../cli/commands/gate-test-helpers';
import {
    classifyChange,
    getClassificationConfig
} from '../../../../src/gates/preflight/classify-change';

function writeFullSuitePreflight(
    repoRoot: string,
    preflightPath: string,
    preflight: Record<string, unknown>
): void {
    fs.writeFileSync(preflightPath, JSON.stringify(preflight), 'utf8');
    const taskId = String(preflight.task_id || '').trim();
    if (taskId) {
        writeFullSuiteTaskModeBaseline(repoRoot, taskId);
    }
}

function writeFullSuiteTaskModeBaseline(repoRoot: string, taskId: string): void {
    const reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.writeFileSync(
        path.join(reviewsDir, `${taskId}-task-mode.json`),
        `${JSON.stringify(buildTaskModeArtifact({
            taskId,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: `Full-suite validation fixture for ${taskId}`,
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            workflowConfigFileHashes: getCurrentWorkflowConfigFileHashes(repoRoot)
        }), null, 2)}\n`,
        'utf8'
    );
}

function buildFullSuiteDurationTestConfig(command = 'npm test'): FullSuiteValidationConfig {
    return {
        enabled: true,
        command,
        timeout_ms: 300_000,
        green_summary_max_lines: 5,
        red_failure_chunk_lines: 50,
        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
        placement: 'before_test_review'
    };
}


describe('gates/full-suite-validation', () => {
    describe('CLI integration reuse and rebind', () => {
        it('rebinds same-scope passed evidence to the current compile cycle without rerunning the command', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-rebind-current-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const executedMarker = path.join(tempDir, 'command-executed.txt');
            const helperScript = path.join(tempDir, 'pass-rebind-current.js');
            fs.writeFileSync(
                helperScript,
                `require('node:fs').writeFileSync(${JSON.stringify(executedMarker)}, 'executed\\n', 'utf8'); process.stdout.write("should not run\\n"); process.exit(0);`,
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-REBIND-CURRENT';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });
            const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
            const changedFilesSha = '1'.repeat(64);
            const scopeSha = '2'.repeat(64);
            const scopeContentSha = '3'.repeat(64);
            const currentCompileTimestamp = '2026-01-01T00:00:02.000Z';
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-compile-gate.json`), JSON.stringify({
                status: 'PASSED',
                timestamp_utc: currentCompileTimestamp,
                preflight_path: preflightPath,
                preflight_hash_sha256: preflightSha256,
                preflight_changed_files_sha256: changedFilesSha,
                preflight_scope_sha256: scopeSha,
                preflight_scope_content_sha256: scopeContentSha
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(eventsDir, `${taskId}.jsonl`), [
                JSON.stringify({
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    timestamp_utc: '2026-01-01T00:00:01.000Z',
                    outcome: 'PASS',
                    details: {
                        cycle_binding: {
                            task_id: taskId,
                            preflight_path: preflightPath.replace(/\\/g, '/'),
                            preflight_sha256: 'old-cycle',
                            compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                            scope_binding: {
                                changed_files_sha256: changedFilesSha,
                                scope_sha256: scopeSha,
                                scope_content_sha256: scopeContentSha
                            }
                        }
                    }
                }),
                JSON.stringify({
                    event_type: 'COMPILE_GATE_PASSED',
                    timestamp_utc: currentCompileTimestamp,
                    outcome: 'PASS',
                    details: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_hash_sha256: preflightSha256,
                        preflight_changed_files_sha256: changedFilesSha,
                        preflight_scope_sha256: scopeSha,
                        preflight_scope_content_sha256: scopeContentSha
                    }
                }),
                ''
            ].join('\n'), 'utf8');
            const outputArtifactPath = path.join(reviewsDir, `${taskId}-full-suite-output.log`);
            fs.writeFileSync(outputArtifactPath, 'cached pass output\n', 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                exit_code: 0,
                timed_out: false,
                output_artifact_path: outputArtifactPath,
                compact_summary: ['cached pass output'],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: [],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_sha256: 'old-cycle',
                    compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                    scope_binding: {
                        changed_files_sha256: changedFilesSha,
                        scope_sha256: scopeSha,
                        scope_content_sha256: scopeContentSha
                    }
                }
            }, null, 2), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(executedMarker), false);
            assert.ok(result.logs.some((line) => line.includes('Rebound existing full-suite evidence')));
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(artifact.cycle_binding.preflight_sha256, preflightSha256);
            assert.equal(artifact.cycle_binding.compile_gate_timestamp, currentCompileTimestamp);
            const timelineLines = fs.readFileSync(path.join(eventsDir, `${taskId}.jsonl`), 'utf8')
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => JSON.parse(line) as Record<string, unknown>);
            const latestEvent = timelineLines[timelineLines.length - 1];
            assert.equal(latestEvent.event_type, 'FULL_SUITE_VALIDATION_PASSED');
            assert.equal(((latestEvent.details as Record<string, unknown>).reused_existing_evidence), true);
            assert.equal((((latestEvent.details as Record<string, unknown>).cycle_binding as Record<string, unknown>).compile_gate_timestamp), currentCompileTimestamp);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('retains raw output when rebinding PASSED evidence that carries warnings', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-rebind-warning-pass-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const executedMarker = path.join(tempDir, 'command-executed.txt');
            const helperScript = path.join(tempDir, 'pass-rebind-warning-pass.js');
            fs.writeFileSync(
                helperScript,
                `require('node:fs').writeFileSync(${JSON.stringify(executedMarker)}, 'executed\\n', 'utf8'); process.stdout.write("should not run\\n"); process.exit(0);`,
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const taskId = 'T-REBIND-WARNING-PASS';
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: taskId,
                changed_files: ['src/changed.ts']
            });
            const preflightSha256 = createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
            const changedFilesSha = '4'.repeat(64);
            const scopeSha = '5'.repeat(64);
            const scopeContentSha = '6'.repeat(64);
            const currentCompileTimestamp = '2026-01-01T00:00:02.000Z';
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-compile-gate.json`), JSON.stringify({
                status: 'PASSED',
                timestamp_utc: currentCompileTimestamp,
                preflight_path: preflightPath,
                preflight_hash_sha256: preflightSha256,
                preflight_changed_files_sha256: changedFilesSha,
                preflight_scope_sha256: scopeSha,
                preflight_scope_content_sha256: scopeContentSha
            }, null, 2), 'utf8');
            fs.writeFileSync(path.join(eventsDir, `${taskId}.jsonl`), [
                JSON.stringify({
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    timestamp_utc: '2026-01-01T00:00:01.000Z',
                    outcome: 'PASS',
                    details: {
                        cycle_binding: {
                            task_id: taskId,
                            preflight_path: preflightPath.replace(/\\/g, '/'),
                            preflight_sha256: 'old-cycle',
                            compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                            scope_binding: {
                                changed_files_sha256: changedFilesSha,
                                scope_sha256: scopeSha,
                                scope_content_sha256: scopeContentSha
                            }
                        }
                    }
                }),
                JSON.stringify({
                    event_type: 'COMPILE_GATE_PASSED',
                    timestamp_utc: currentCompileTimestamp,
                    outcome: 'PASS',
                    details: {
                        preflight_path: preflightPath.replace(/\\/g, '/'),
                        preflight_hash_sha256: preflightSha256,
                        preflight_changed_files_sha256: changedFilesSha,
                        preflight_scope_sha256: scopeSha,
                        preflight_scope_content_sha256: scopeContentSha
                    }
                }),
                ''
            ].join('\n'), 'utf8');
            const outputArtifactPath = path.join(reviewsDir, `${taskId}-full-suite-output.log`);
            fs.writeFileSync(outputArtifactPath, 'cached pass output with warning\n', 'utf8');
            fs.writeFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), JSON.stringify({
                status: 'PASSED',
                enabled: true,
                command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                exit_code: 0,
                timed_out: false,
                output_artifact_path: outputArtifactPath,
                compact_summary: ['cached pass output with warning'],
                failure_chunks: [],
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                out_of_scope_failure_detected: false,
                out_of_scope_audit_verdict: 'NOT_APPLICABLE',
                violations: [],
                warnings: ['non-blocking warning'],
                cycle_binding: {
                    task_id: taskId,
                    preflight_path: preflightPath.replace(/\\/g, '/'),
                    preflight_sha256: 'old-cycle',
                    compile_gate_timestamp: '2026-01-01T00:00:00.000Z',
                    scope_binding: {
                        changed_files_sha256: changedFilesSha,
                        scope_sha256: scopeSha,
                        scope_content_sha256: scopeContentSha
                    }
                }
            }, null, 2), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', taskId,
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(executedMarker), false);
            const artifact = JSON.parse(fs.readFileSync(path.join(reviewsDir, `${taskId}-full-suite-validation.json`), 'utf8'));
            assert.equal(String(artifact.output_artifact_path).replace(/\\/g, '/'), outputArtifactPath.replace(/\\/g, '/'));
            assert.equal(artifact.output_retention, undefined);
            assert.equal(fs.existsSync(outputArtifactPath), true);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('drops stale pending full-suite artifacts when the transaction id does not match the latest lifecycle event', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-stale-pending-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-stale-pending.js');
            fs.writeFileSync(
                helperScript,
                'process.stdout.write(\"all good\\\\n\"); process.exit(0);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-STALE-PENDING-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-STALE-PENDING',
                changed_files: ['src/changed.ts']
            });

            const artifactPath = path.join(reviewsDir, 'T-STALE-PENDING-full-suite-validation.json');
            const pendingArtifactPath = `${artifactPath}.pending`;
            const pendingMetaPath = `${artifactPath}.pending.meta.json`;
            const timelinePath = path.join(eventsDir, 'T-STALE-PENDING.jsonl');

            fs.writeFileSync(pendingArtifactPath, `${JSON.stringify({ status: 'FAILED', marker: 'stale-pending' }, null, 2)}\n`, 'utf8');
            fs.writeFileSync(pendingMetaPath, `${JSON.stringify({ transaction_id: 'stale-transaction-id' }, null, 2)}\n`, 'utf8');
            fs.writeFileSync(
                timelinePath,
                `${JSON.stringify({
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    details: {
                        artifact_transaction_id: 'different-transaction-id'
                    }
                })}\n`,
                'utf8'
            );

            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalCopyFileSync = fsModule.copyFileSync;
            let promotionCount = 0;
            try {
                fsModule.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
                    const normalizedSrc = path.resolve(String(src));
                    const normalizedDest = path.resolve(String(dest));
                    if (
                        normalizedSrc === path.resolve(pendingArtifactPath)
                        && normalizedDest === path.resolve(artifactPath)
                    ) {
                        promotionCount += 1;
                    }
                    return originalCopyFileSync(src, dest, mode);
                }) as typeof fsModule.copyFileSync;

                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-STALE-PENDING',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            } finally {
                fsModule.copyFileSync = originalCopyFileSync;
            }

            assert.equal(promotionCount, 1);
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal((artifact as Record<string, unknown>).marker, undefined);
            assert.equal(fs.existsSync(pendingArtifactPath), false);
            assert.equal(fs.existsSync(pendingMetaPath), false);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });
});
