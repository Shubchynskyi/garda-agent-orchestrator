import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../src/cli/exit-codes';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../src/core/constants';
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
} from '../../../src/gates/full-suite-validation';
import { getCurrentWorkflowConfigFileHashes } from '../../../src/gates/workflow-config-work';
import { buildTaskModeArtifact } from '../../../src/gates/task-mode';
import { countTextChars } from '../../../src/gate-runtime/text-utils';
import { runCliWithCapturedOutput } from '../cli/commands/gate-test-helpers';

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
    describe('loadFullSuiteValidationConfig', () => {
        it('returns defaults when config file does not exist', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent/path');
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(config.timeout_ms, 600_000);
            assert.equal(config.green_summary_max_lines, 5);
            assert.equal(config.red_failure_chunk_lines, 50);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_BLOCK');
            assert.equal(config.placement, 'before_test_review');
        });

        it('loads enabled config from valid JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm run test:all',
                    timeout_ms: 300000,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN',
                    placement: 'before completion'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, true);
            assert.equal(config.command, 'npm run test:all');
            assert.equal(config.timeout_ms, 300000);
            assert.equal(config.green_summary_max_lines, 3);
            assert.equal(config.red_failure_chunk_lines, 25);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
            assert.equal(config.placement, 'before_completion');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('returns defaults for malformed JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), 'not json');
            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('returns defaults for parseable non-object JSON', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), 'null');
            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, false);
            assert.equal(config.command, UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND);
            assert.equal(config.placement, 'before_test_review');
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects invalid explicit placement values', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(configDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 300000,
                    green_summary_max_lines: 3,
                    red_failure_chunk_lines: 25,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after lunch'
                }
            }));

            assert.throws(
                () => loadFullSuiteValidationConfig(tempDir),
                /workflow-config\.full_suite_validation\.placement must be one of/
            );
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });

    describe('compactGreenSummary', () => {
        it('returns pass message for empty output', () => {
            const result = compactGreenSummary([], 5);
            assert.equal(result.length, 1);
            assert.ok(result[0].includes('passed'));
        });

        it('extracts node:test tail summary', () => {
            const lines = [
                '# tests 15',
                '# suites 3',
                '# pass 15',
                '# fail 0',
                '# duration_ms 1234'
            ];
            const result = compactGreenSummary(lines, 5);
            assert.ok(result.some((line) => line.includes('# pass 15')));
            assert.ok(result.some((line) => line.includes('# duration_ms 1234')));
        });
    });

    describe('compactRedFailureChunks', () => {
        it('extracts failure chunks with context', () => {
            const lines = [
                'ok 1 - a',
                'not ok 2 - b',
                'error at src/unrelated.ts:5',
                'detail line',
                'ok 3 - c'
            ];
            const result = compactRedFailureChunks(lines, 10);
            assert.ok(result.length >= 1);
            assert.ok(result.flat().some((line) => line.includes('not ok 2 - b')));
        });
    });

    describe('detectOutOfScopeFailures', () => {
        it('returns true when failure references unrelated file', () => {
            assert.equal(
                detectOutOfScopeFailures(['error at src/unrelated/bar.ts:5 something'], ['src/gates/foo.ts']),
                true
            );
        });

        it('returns false when failure matches changed file', () => {
            assert.equal(
                detectOutOfScopeFailures(['error at src/gates/foo.ts:10'], ['src/gates/foo.ts']),
                false
            );
        });
    });

    describe('result builders', () => {
        it('buildSkippedResult keeps cycle binding', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildSkippedResult(config, {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: '2026-04-20T12:00:00.000Z'
            });
            assert.equal(result.status, 'SKIPPED');
            assert.equal(result.cycle_binding?.task_id, 'T-123');
        });

        it('detects docs-only scopes where full-suite validation is not required', () => {
            assert.equal(isFullSuiteNotRequiredForDocsOnlyScope({
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                triggers: {
                    runtime_code_changed: false,
                    test: false
                },
                required_reviews: {}
            }), true);

            assert.equal(isFullSuiteNotRequiredForDocsOnlyScope({
                scope_category: 'docs-only',
                changed_files: ['tests/README.md'],
                triggers: {
                    test: true
                },
                required_reviews: { test: true }
            }), false);
        });

        it('buildDocsOnlyNotRequiredResult records an explicit skip reason', () => {
            const config = { ...loadFullSuiteValidationConfig('/nonexistent'), enabled: true, command: 'npm test' };
            const result = buildDocsOnlyNotRequiredResult(config, {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });

            assert.equal(result.status, 'SKIPPED');
            assert.equal(result.enabled, true);
            assert.equal(result.required, false);
            assert.equal(result.skip_reason, 'DOCS_ONLY_SCOPE_NOT_REQUIRED');
            assert.ok(formatFullSuiteValidationResult(result).includes('SkipReason: DOCS_ONLY_SCOPE_NOT_REQUIRED'));
        });

        it('buildValidationResult returns WARNED for AUDIT_AND_WARN out-of-scope failures', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_WARN' },
                1,
                false,
                ['FAIL at src/unrelated.ts:10 something'],
                null,
                ['src/changed.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );
            assert.equal(result.status, 'WARNED');
            assert.equal(result.out_of_scope_audit_verdict, 'WARNED');
            assert.equal(result.violations.length, 0);
            assert.ok(result.warnings.length > 0);
        });

        it('buildValidationResult records out-of-scope harness timeouts as WARNED', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_BLOCK' },
                1,
                true,
                [
                    'not ok 1 - failed at tests/node/cli/commands/gates.test.ts:10',
                    'WARNING: task-event append failed: Timed out acquiring file lock: runtime/task-events/.T-001.lock;',
                    'Process timed out after 600000 ms.'
                ],
                null,
                ['src/gates/full-suite-validation.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );

            assert.equal(result.status, 'WARNED');
            assert.equal(result.out_of_scope_audit_verdict, 'WARNED');
            assert.equal(result.harness_failure_detected, true);
            assert.equal(result.harness_failure_audit_verdict, 'WARNED');
            assert.equal(result.violations.length, 0);
            assert.ok(result.warnings.some((line) => line.includes('out-of-scope test harness or lock surface')));
        });

        it('buildValidationResult keeps in-scope harness timeouts blocking', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildValidationResult(
                { ...config, enabled: true, out_of_scope_failure_policy: 'AUDIT_AND_BLOCK' },
                1,
                true,
                [
                    'not ok 1 - failed at tests/node/cli/commands/gates.test.ts:10',
                    'WARNING: task-event append failed: Timed out acquiring file lock: runtime/task-events/.T-001.lock;',
                    'Process timed out after 600000 ms.'
                ],
                null,
                ['tests/node/cli/commands/gates.test.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );

            assert.equal(result.status, 'FAILED');
            assert.equal(result.harness_failure_detected, false);
            assert.ok(result.violations.some((line) => line.includes('timed out')));
        });

        it('formatFullSuiteValidationResult includes cycle binding', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const result = buildSkippedResult(config, {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);
            assert.ok(text.includes('FULL_SUITE_VALIDATION_SKIPPED'));
            assert.ok(text.includes('CycleBinding: task_id=T-123;'));
        });

        it('formatFullSuiteValidationResult redacts secrets from configured command output', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm test -- ACCESS_TOKEN=full-suite-command-secret'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(!text.includes('full-suite-command-secret'));
            assert.ok(text.includes('Command: npm test -- ACCESS_TOKEN=<redacted>'));
        });

        it('buildFullSuiteValidationOutputTelemetry measures savings against compacted visible output', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const rawOutputLines = [
                'detail line 1 with verbose raw output that should not survive compaction',
                'detail line 2 with verbose raw output that should not survive compaction',
                'detail line 3 with verbose raw output that should not survive compaction',
                'detail line 4 with verbose raw output that should not survive compaction',
                'detail line 5 with verbose raw output that should not survive compaction',
                'detail line 6 with verbose raw output that should not survive compaction',
                'detail line 7 with verbose raw output that should not survive compaction',
                'detail line 8 with verbose raw output that should not survive compaction',
                'detail line 9 with verbose raw output that should not survive compaction',
                'detail line 10 with verbose raw output that should not survive compaction',
                'detail line 11 with verbose raw output that should not survive compaction',
                'detail line 12 with verbose raw output that should not survive compaction',
                '# tests 20',
                '# pass 20',
                '# fail 0',
                '# duration_ms 1234'
            ];
            const result = buildValidationResult(
                { ...config, enabled: true, command: 'npm test' },
                0,
                false,
                rawOutputLines,
                'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-output.log',
                ['src/changed.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );
            const telemetry = buildFullSuiteValidationOutputTelemetry(
                rawOutputLines,
                result
            );

            assert.ok(telemetry);
            assert.equal((telemetry as Record<string, unknown>).filter_mode, 'full_suite_validation_compaction');
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_chars) > 0);
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_tokens) > 0);

            const formatted = formatFullSuiteValidationResult({
                ...result,
                output_telemetry: telemetry
            });
            assert.match(formatted, /\[full-suite-validation\] suppressed ~\d+ chars/);
            assert.equal(
                Number((telemetry as Record<string, unknown>).filtered_char_count),
                countTextChars(formatted.split('\n'))
            );
        });

        it('buildFullSuiteValidationOutputTelemetry measures savings for failure_chunks output', () => {
            const config = loadFullSuiteValidationConfig('/nonexistent');
            const rawOutputLines = [
                'not ok 1 - full suite telemetry branch failed at src/changed.ts:5',
                ...Array.from(
                    { length: 60 },
                    (_, index) => `verbose failure detail line ${index + 1} that should be compacted away`
                )
            ];
            const result = buildValidationResult(
                { ...config, enabled: true, command: 'npm test', red_failure_chunk_lines: 10 },
                1,
                false,
                rawOutputLines,
                'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-output.log',
                ['src/changed.ts'],
                {
                    task_id: 'T-123',
                    preflight_path: 'runtime/reviews/T-123-preflight.json',
                    preflight_sha256: 'abc123',
                    compile_gate_timestamp: null
                }
            );
            const telemetry = buildFullSuiteValidationOutputTelemetry(rawOutputLines, result);

            assert.equal(result.status, 'FAILED');
            assert.ok(result.failure_chunks.length > 0);
            assert.ok(telemetry);
            assert.equal((telemetry as Record<string, unknown>).parser_strategy, 'failure_chunks');
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_chars) > 0);
            assert.ok(Number((telemetry as Record<string, unknown>).estimated_saved_tokens) > 0);
            const formatted = formatFullSuiteValidationResult({
                ...result,
                output_telemetry: telemetry
            });
            assert.equal(
                Number((telemetry as Record<string, unknown>).filtered_char_count),
                countTextChars(formatted.split('\n'))
            );
        });
    });

    describe('full-suite duration timeout forecast', () => {
        it('records only the last five matching durations and recommends average plus 20 percent or at least 30 seconds', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig();

            for (let index = 0; index < 6; index += 1) {
                recordFullSuiteValidationDuration(repoRoot, config, {
                    timestamp_utc: `2099-01-01T00:00:0${index}.000Z`,
                    task_id: `T-${index}`,
                    status: index % 2 === 0 ? 'PASSED' : 'FAILED',
                    duration_ms: (index + 1) * 10_000,
                    timed_out: false,
                    exit_code: index % 2 === 0 ? 0 : 1
                });
            }

            const historyPath = resolveFullSuiteDurationHistoryPath(repoRoot);
            const history = JSON.parse(fs.readFileSync(historyPath, 'utf8')) as { entries: Array<{ task_id: string; }>; };
            assert.equal(history.entries.length, 5);
            assert.equal(history.entries[0].task_id, 'T-1');

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 5);
            assert.equal(forecast.average_duration_seconds, 40);
            assert.equal(forecast.recommended_timeout_seconds, 70);
            assert.equal(forecast.safety_margin_seconds, 30);
            assert.equal(forecast.recommendation_source, 'history');
            assert.match(formatFullSuiteTimeoutForecast(forecast), /Recommended full-suite command timeout: 70s/);
        });

        it('redacts secrets from recorded duration history command fields', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-redacted-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig('npm test -- ACCESS_TOKEN=duration-secret');

            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:00.000Z',
                task_id: 'T-SECRET',
                status: 'PASSED',
                duration_ms: 10_000,
                timed_out: false,
                exit_code: 0
            });

            const historyText = fs.readFileSync(resolveFullSuiteDurationHistoryPath(repoRoot), 'utf8');
            assert.ok(!historyText.includes('duration-secret'));
            assert.ok(historyText.includes('ACCESS_TOKEN=<redacted>'));

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 1);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('uses the configured timeout when duration history is missing, corrupt, or for another workflow config signature', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-fallback-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig('npm test');
            const otherConfig = buildFullSuiteDurationTestConfig('npm run test:other');

            recordFullSuiteValidationDuration(repoRoot, otherConfig, {
                timestamp_utc: '2099-01-01T00:00:00.000Z',
                task_id: 'T-OTHER',
                status: 'PASSED',
                duration_ms: 100_000,
                timed_out: false,
                exit_code: 0
            });
            let forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 0);
            assert.equal(forecast.recommended_timeout_seconds, 300);
            assert.equal(forecast.recommendation_source, 'config_timeout');

            fs.writeFileSync(resolveFullSuiteDurationHistoryPath(repoRoot), '{not json', 'utf8');
            forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 0);
            assert.equal(forecast.recommended_timeout_seconds, 300);
            assert.match(forecast.warning || '', /unreadable/);
        });
    });

    describe('CLI integration', () => {
        it('gate full-suite-validation prints SKIPPED and writes JSON artifact when disabled', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-skip-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, 'T-SKIP-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-SKIP',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-SKIP',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const artifactPath = path.join(reviewsDir, 'T-SKIP-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'SKIPPED');
            assert.equal(artifact.cycle_binding.task_id, 'T-SKIP');
            const timelinePath = path.join(eventsDir, 'T-SKIP.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_SKIPPED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation records NOT_REQUIRED for enabled docs-only scopes without running the command', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-docs-skip-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" -e "process.exit(9)"`,
                    timeout_ms: 30000
                }
            }), 'utf8');
            const preflightPath = path.join(reviewsDir, 'T-DOCS-SKIP-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-DOCS-SKIP',
                scope_category: 'docs-only',
                changed_files: ['docs/runbook.md'],
                triggers: {
                    runtime_code_changed: false,
                    test: false,
                    db: false,
                    security: false,
                    api: false,
                    performance: false,
                    infra: false,
                    dependency: false,
                    refactor: false
                },
                required_reviews: {}
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-DOCS-SKIP',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, result.errors.join('\n'));
            const artifactPath = path.join(reviewsDir, 'T-DOCS-SKIP-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'SKIPPED');
            assert.equal(artifact.enabled, true);
            assert.equal(artifact.required, false);
            assert.equal(artifact.skip_reason, 'DOCS_ONLY_SCOPE_NOT_REQUIRED');
            const timeline = fs.readFileSync(path.join(eventsDir, 'T-DOCS-SKIP.jsonl'), 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_SKIPPED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation exits 0 for WARNED under AUDIT_AND_WARN', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-warn-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'fail-unrelated.js');
            fs.writeFileSync(
                helperScript,
                [
                    'process.stdout.write("FAIL at src/unrelated.ts:5 detail\\n");',
                    'for (let index = 0; index < 40; index += 1) {',
                    '  process.stdout.write(`warn-path verbose detail ${index} that should be compacted away\\n`);',
                    '}',
                    'process.exit(1);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-WARN-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-WARN',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-WARN',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-WARN-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'WARNED');
            assert.equal(artifact.out_of_scope_audit_verdict, 'WARNED');
            assert.equal(artifact.cycle_binding.task_id, 'T-WARN');
            assert.ok(artifact.output_telemetry);
            assert.ok(Number(artifact.output_telemetry.estimated_saved_tokens) > 0);
            const timelinePath = path.join(eventsDir, 'T-WARN.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_WARNED"/);
            assert.match(timeline, /"output_telemetry":\{/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation records FULL_SUITE_VALIDATION_PASSED for an enabled successful run', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-pass-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass.js');
            fs.writeFileSync(
                helperScript,
                [
                    'for (let index = 0; index < 40; index += 1) {',
                    '  process.stdout.write(`detail line ${index} with verbose raw output that should not survive compaction\\n`);',
                    '}',
                    'process.stdout.write("ACCESS_TOKEN=full-suite-secret-value\\n");',
                    'process.stdout.write("API_TOKEN=\\"full suite line one\\nfull suite line two\\"\\n");',
                    'process.stdout.write("# tests 20\\n# pass 20\\n# fail 0\\n# duration_ms 1234\\n");',
                    'process.exit(0);'
                ].join('\n'),
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

            const preflightPath = path.join(reviewsDir, 'T-PASS-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-PASS',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-PASS',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-PASS-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(typeof artifact.duration_ms, 'number');
            assert.equal(artifact.timeout_forecast.recommendation_source, 'history');
            assert.ok(artifact.output_telemetry);
            assert.ok(Number(artifact.output_telemetry.estimated_saved_tokens) > 0);
            const outputArtifactPath = path.join(reviewsDir, 'T-PASS-full-suite-output.log');
            const outputArtifact = fs.readFileSync(outputArtifactPath, 'utf8');
            assert.ok(!outputArtifact.includes('full-suite-secret-value'));
            assert.ok(!outputArtifact.includes('full suite line one'));
            assert.ok(!outputArtifact.includes('full suite line two'));
            assert.ok(outputArtifact.includes('ACCESS_TOKEN=<redacted>'));
            assert.ok(outputArtifact.includes('API_TOKEN="<redacted>"'));
            assert.ok(!fs.readFileSync(artifactPath, 'utf8').includes('full-suite-secret-value'));
            assert.ok(!fs.readFileSync(artifactPath, 'utf8').includes('full suite line one'));
            assert.ok(!fs.readFileSync(artifactPath, 'utf8').includes('full suite line two'));
            const timelinePath = path.join(eventsDir, 'T-PASS.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            assert.match(timeline, /"output_telemetry":\{/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('rejects mutable preflight workflow-config hashes without task-mode baseline evidence', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-preflight-baseline-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass.js');
            fs.writeFileSync(helperScript, 'process.stdout.write("all good\\n"); process.exit(0);', 'utf8');
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

            const preflightPath = path.join(reviewsDir, 'T-PREFLIGHT-BASELINE-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-PREFLIGHT-BASELINE',
                changed_files: ['src/changed.ts'],
                triggers: {
                    workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(tempDir)
                }
            }), 'utf8');

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-PREFLIGHT-BASELINE',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-PREFLIGHT-BASELINE-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.ok(artifact.violations.some((line: string) => line.includes('baseline hashes are missing')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('records duration history for failed post-run workflow-config guard violations', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-post-workflow-config-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'mutate-workflow-config.js');
            const workflowConfigPath = path.join(configDir, 'workflow-config.json');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'fs.appendFileSync(process.argv[2], "\\n", "utf8");',
                    'process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n");',
                    'process.exit(0);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(workflowConfigPath, JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}" "${workflowConfigPath.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-POST-WORKFLOW-CONFIG-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-POST-WORKFLOW-CONFIG',
                changed_files: ['src/changed.ts'],
                triggers: {
                    workflow_config_file_hashes: getCurrentWorkflowConfigFileHashes(tempDir)
                }
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-POST-WORKFLOW-CONFIG',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-POST-WORKFLOW-CONFIG-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(typeof artifact.duration_ms, 'number');
            assert.equal(artifact.timeout_forecast.recommendation_source, 'history');
            const durationHistory = JSON.parse(
                fs.readFileSync(resolveFullSuiteDurationHistoryPath(tempDir), 'utf8')
            ) as { entries: Array<{ task_id: string; status: string; }>; };
            assert.deepEqual(
                durationHistory.entries.map((entry) => ({ task_id: entry.task_id, status: entry.status })),
                [{ task_id: 'T-POST-WORKFLOW-CONFIG', status: 'FAILED' }]
            );
            assert.ok(artifact.violations.some((line: string) => line.includes('Workflow config')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation clears bundle selector env only for the test subprocess', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-env-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'env-pass.js');
            const envReportPath = path.join(tempDir, 'env-report.json');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'fs.writeFileSync(process.argv[2], JSON.stringify({',
                    '  bundleName: process.env.GARDA_BUNDLE_NAME ?? null,',
                    '  executionProvider: process.env.GARDA_EXECUTION_PROVIDER ?? null',
                    '}, null, 2) + "\\n", "utf8");',
                    'if (process.env.GARDA_BUNDLE_NAME !== undefined) process.exit(41);',
                    'if (process.env.GARDA_EXECUTION_PROVIDER !== "Codex") process.exit(42);',
                    'process.stdout.write("# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n");',
                    'process.exit(0);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}" "${envReportPath.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-ENV-PASS-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-ENV-PASS',
                changed_files: ['src/changed.ts']
            });

            const previousBundleName = process.env.GARDA_BUNDLE_NAME;
            const previousExecutionProvider = process.env.GARDA_EXECUTION_PROVIDER;
            process.env.GARDA_BUNDLE_NAME = 'garda-agent-orchestrator';
            process.env.GARDA_EXECUTION_PROVIDER = 'Codex';
            try {
                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-ENV-PASS',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                const artifactPath = path.join(reviewsDir, 'T-ENV-PASS-full-suite-validation.json');
                const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                assert.equal(artifact.status, 'PASSED');
                const envReport = JSON.parse(fs.readFileSync(envReportPath, 'utf8'));
                assert.equal(envReport.bundleName, null);
                assert.equal(envReport.executionProvider, 'Codex');
            } finally {
                if (previousBundleName == null) {
                    delete process.env.GARDA_BUNDLE_NAME;
                } else {
                    process.env.GARDA_BUNDLE_NAME = previousBundleName;
                }
                if (previousExecutionProvider == null) {
                    delete process.env.GARDA_EXECUTION_PROVIDER;
                } else {
                    process.env.GARDA_EXECUTION_PROVIDER = previousExecutionProvider;
                }
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation still fails real subprocess test failures after env sanitization', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-env-fail-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'env-fail.js');
            fs.writeFileSync(
                helperScript,
                [
                    'if (process.env.GARDA_BUNDLE_NAME !== undefined) process.exit(41);',
                    'process.stdout.write("not ok 1 - failed at src/changed.ts:1\\n");',
                    'process.exit(13);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-ENV-FAIL-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-ENV-FAIL',
                changed_files: ['src/changed.ts']
            });

            const previousBundleName = process.env.GARDA_BUNDLE_NAME;
            process.env.GARDA_BUNDLE_NAME = 'garda-agent-orchestrator';
            try {
                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-ENV-FAIL',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                const artifactPath = path.join(reviewsDir, 'T-ENV-FAIL-full-suite-validation.json');
                const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                assert.equal(artifact.status, 'FAILED');
                assert.equal(artifact.exit_code, 13);
            } finally {
                if (previousBundleName == null) {
                    delete process.env.GARDA_BUNDLE_NAME;
                } else {
                    process.env.GARDA_BUNDLE_NAME = previousBundleName;
                }
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation streams over 1 MiB stdout without maxBuffer failure', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-large-output-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'large-pass.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'const chunk = "x".repeat(64 * 1024);',
                    'for (let index = 0; index < 17; index += 1) {',
                    '  fs.writeSync(1, `${chunk}\\n`);',
                    '}',
                    'fs.writeSync(1, "# tests 1\\n# pass 1\\n# fail 0\\n# duration_ms 1\\n");',
                    'process.exit(0);'
                ].join('\n'),
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

            const preflightPath = path.join(reviewsDir, 'T-LARGE-PASS-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-LARGE-PASS',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-LARGE-PASS',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-LARGE-PASS-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.exit_code, 0);
            assert.equal(artifact.timed_out, false);
            assert.ok(artifact.compact_summary.some((line: string) => line.includes('# pass 1')));
            assert.ok(Number(artifact.output_telemetry.estimated_saved_tokens) > 0);

            const outputArtifactPath = path.join(reviewsDir, 'T-LARGE-PASS-full-suite-output.log');
            assert.ok(fs.statSync(outputArtifactPath).size > 1024 * 1024);
            const timelinePath = path.join(eventsDir, 'T-LARGE-PASS.jsonl');
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation reports real command failure after over 1 MiB stdout', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-large-fail-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'large-fail.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'fs.writeSync(1, "not ok 1 - failed at src/changed.ts:1\\n");',
                    'for (let index = 0; index < 70000; index += 1) {',
                    '  fs.writeSync(1, `verbose detail line ${index}\\n`);',
                    '}',
                    'process.exit(7);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-LARGE-FAIL-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-LARGE-FAIL',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-LARGE-FAIL',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-LARGE-FAIL-full-suite-validation.json');
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.exit_code, 7);
            assert.equal(artifact.timed_out, false);
            assert.ok(artifact.violations.some((line: string) => line.includes('exit code 7')));

            const outputArtifactPath = path.join(reviewsDir, 'T-LARGE-FAIL-full-suite-output.log');
            assert.ok(fs.statSync(outputArtifactPath).size > 1024 * 1024);
            const timelinePath = path.join(eventsDir, 'T-LARGE-FAIL.jsonl');
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('keeps the canonical artifact and task timeline when only aggregate append warns after FULL_SUITE_VALIDATION_PASSED', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-pass-aggregate-warning-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            const aggregatePath = path.join(eventsDir, 'all-tasks.jsonl');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-aggregate-warning.js');
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

            const preflightPath = path.join(reviewsDir, 'T-PASS-AGGREGATE-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-PASS-AGGREGATE',
                changed_files: ['src/changed.ts']
            });

            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalAppendFileSync = fsModule.appendFileSync;
            let injectedAggregateFailure = false;
            try {
                fsModule.appendFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
                    const normalizedPath = typeof filePath === 'string' ? path.resolve(filePath) : '';
                    const payload = typeof data === 'string' ? data : '';
                    if (
                        !injectedAggregateFailure
                        && normalizedPath === path.resolve(aggregatePath)
                        && payload.includes('"event_type":"FULL_SUITE_VALIDATION_PASSED"')
                    ) {
                        injectedAggregateFailure = true;
                        throw new Error('Injected aggregate append failure');
                    }
                    return originalAppendFileSync(filePath, data, options);
                }) as typeof fsModule.appendFileSync;

                const result = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-PASS-AGGREGATE',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
                assert.equal(injectedAggregateFailure, true);
                const artifactPath = path.join(reviewsDir, 'T-PASS-AGGREGATE-full-suite-validation.json');
                assert.ok(fs.existsSync(artifactPath));
                const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
                assert.equal(artifact.status, 'PASSED');
                const timelinePath = path.join(eventsDir, 'T-PASS-AGGREGATE.jsonl');
                assert.ok(fs.existsSync(timelinePath));
                const timeline = fs.readFileSync(timelinePath, 'utf8');
                assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            } finally {
                fsModule.appendFileSync = originalAppendFileSync;
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('gate full-suite-validation fails clearly when enabled but the command is still unconfigured', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-unconfigured-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-UNCONFIGURED-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-UNCONFIGURED',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-UNCONFIGURED',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-UNCONFIGURED-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.ok(artifact.violations.some((line: string) => line.includes('not configured')));
            const timelinePath = path.join(eventsDir, 'T-UNCONFIGURED.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_FAILED"/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation uses forecast timeout when it exceeds configured timeout', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-forecast-timeout-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-after-configured-timeout.js');
            fs.writeFileSync(
                helperScript,
                'setTimeout(() => { process.stdout.write("forecast timeout pass\\n"); process.exit(0); }, 250);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 100,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const config = loadFullSuiteValidationConfig(tempDir);
            recordFullSuiteValidationDuration(tempDir, config, {
                timestamp_utc: new Date().toISOString(),
                task_id: 'T-FORECAST-TIMEOUT-SEED',
                status: 'PASSED',
                duration_ms: 250,
                timed_out: false,
                exit_code: 0
            });

            const preflightPath = path.join(reviewsDir, 'T-FORECAST-TIMEOUT-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-FORECAST-TIMEOUT',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-FORECAST-TIMEOUT',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const artifactPath = path.join(reviewsDir, 'T-FORECAST-TIMEOUT-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(artifact.timed_out, false);
            assert.equal(artifact.timeout_forecast.recommendation_source, 'history');
            assert.ok(artifact.timeout_forecast.recommended_timeout_seconds > 1);
            const history = fs.readFileSync(resolveFullSuiteDurationHistoryPath(tempDir), 'utf8');
            assert.match(history, /T-FORECAST-TIMEOUT/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation supplies prebuilt node test env to npm test subprocesses', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-shard-env-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'print-shard-env.js');
            fs.writeFileSync(
                helperScript,
                [
                    'process.stdout.write(`prebuilt=${process.env.GARDA_NODE_FOUNDATION_TEST_PREBUILT || ""}\\n`);',
                    'process.stdout.write(`reuse=${process.env.GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME || ""}\\n`);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                    placement: 'after_compile_before_reviews'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-SHARD-ENV-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-SHARD-ENV',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-SHARD-ENV',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            const outputPath = path.join(reviewsDir, 'T-SHARD-ENV-full-suite-output.log');
            const outputText = fs.readFileSync(outputPath, 'utf8');
            assert.match(outputText, /prebuilt=1/);
            assert.match(outputText, /reuse=1/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('gate full-suite-validation removes dead generated build locks after command timeout', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-timeout-lock-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'hang-with-lock.js');
            fs.writeFileSync(
                helperScript,
                [
                    'const fs = require("node:fs");',
                    'const os = require("node:os");',
                    'const path = require("node:path");',
                    'const lockPath = path.join(process.cwd(), ".scripts-build.lock");',
                    'fs.mkdirSync(lockPath, { recursive: true });',
                    'fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({',
                    '  hostname: os.hostname(),',
                    '  pid: process.pid,',
                    '  startedAtUtc: new Date().toISOString()',
                    '}, null, 2) + "\\n", "utf8");',
                    'process.stdout.write("helper acquired generated lock\\n");',
                    'setInterval(() => {}, 1000);'
                ].join('\n'),
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 300,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 10,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                }
            }), 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-TIMEOUT-LOCK-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-TIMEOUT-LOCK',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-TIMEOUT-LOCK',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.equal(fs.existsSync(path.join(tempDir, '.scripts-build.lock')), false);
            const artifactPath = path.join(reviewsDir, 'T-TIMEOUT-LOCK-full-suite-validation.json');
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'FAILED');
            assert.equal(artifact.timed_out, true);
            assert.ok(artifact.warnings.some((line: string) => line.includes('timeout cleanup removed generated lock')));
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('fails loudly and removes the canonical artifact when lifecycle event emission fails', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-emit-fail-'));
            const runtimeDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime');
            const reviewsDir = path.join(runtimeDir, 'reviews');
            const blockedEventsPath = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(blockedEventsPath, 'blocked', 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-EMIT-FAIL-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-EMIT-FAIL',
                changed_files: ['src/changed.ts']
            });

            const result = await runCliWithCapturedOutput([
                'gate', 'full-suite-validation',
                '--task-id', 'T-EMIT-FAIL',
                '--preflight-path', preflightPath,
                '--repo-root', tempDir
            ], { cwd: repoRoot });

            assert.notEqual(result.exitCode, 0, `stdout=${result.logs.join('\n')}\nstderr=${result.errors.join('\n')}`);
            assert.ok(result.errors.some((line) => line.includes('Mandatory lifecycle event')));
            const artifactPath = path.join(reviewsDir, 'T-EMIT-FAIL-full-suite-validation.json');
            const pendingArtifactPath = `${artifactPath}.pending`;
            const pendingMetaPath = `${artifactPath}.pending.meta.json`;
            assert.equal(fs.existsSync(artifactPath), false);
            assert.equal(fs.existsSync(pendingArtifactPath), false);
            assert.equal(fs.existsSync(pendingMetaPath), false);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('recovers a pending canonical artifact when lifecycle event append succeeded before artifact promotion failed', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-promote-recover-'));
            const configDir = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config');
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            const helperScript = path.join(tempDir, 'pass-promote-recover.js');
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

            const preflightPath = path.join(reviewsDir, 'T-PROMOTE-RECOVER-preflight.json');
            writeFullSuitePreflight(tempDir, preflightPath, {
                task_id: 'T-PROMOTE-RECOVER',
                changed_files: ['src/changed.ts']
            });

            const artifactPath = path.join(reviewsDir, 'T-PROMOTE-RECOVER-full-suite-validation.json');
            const pendingArtifactPath = `${artifactPath}.pending`;
            const pendingMetaPath = `${artifactPath}.pending.meta.json`;
            const timelinePath = path.join(eventsDir, 'T-PROMOTE-RECOVER.jsonl');

            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalCopyFileSync = fsModule.copyFileSync;
            let injectedPromotionFailure = false;
            try {
                fsModule.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
                    const normalizedSrc = path.resolve(String(src));
                    const normalizedDest = path.resolve(String(dest));
                    if (
                        !injectedPromotionFailure
                        && normalizedSrc === path.resolve(pendingArtifactPath)
                        && normalizedDest === path.resolve(artifactPath)
                    ) {
                        injectedPromotionFailure = true;
                        throw new Error('Injected artifact promotion failure');
                    }
                    return originalCopyFileSync(src, dest, mode);
                }) as typeof fsModule.copyFileSync;

                const firstRun = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-PROMOTE-RECOVER',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.notEqual(firstRun.exitCode, 0, `stdout=${firstRun.logs.join('\n')}\nstderr=${firstRun.errors.join('\n')}`);
                assert.equal(injectedPromotionFailure, true);
                assert.ok(firstRun.errors.some((line) => line.includes('canonical artifact promotion failed')));
                assert.equal(fs.existsSync(artifactPath), false);
                assert.equal(fs.existsSync(pendingArtifactPath), true);
                assert.equal(fs.existsSync(pendingMetaPath), true);
                const pendingMeta = JSON.parse(fs.readFileSync(pendingMetaPath, 'utf8'));
                assert.ok(fs.existsSync(timelinePath));
                const timeline = fs.readFileSync(timelinePath, 'utf8');
                assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
                assert.match(timeline, new RegExp(String(pendingMeta.transaction_id)));
            } finally {
                fsModule.copyFileSync = originalCopyFileSync;
            }

            let recoveryPromotionCount = 0;
            try {
                fsModule.copyFileSync = ((src: fs.PathLike, dest: fs.PathLike, mode?: number) => {
                    const normalizedSrc = path.resolve(String(src));
                    const normalizedDest = path.resolve(String(dest));
                    if (
                        normalizedSrc === path.resolve(pendingArtifactPath)
                        && normalizedDest === path.resolve(artifactPath)
                    ) {
                        recoveryPromotionCount += 1;
                    }
                    return originalCopyFileSync(src, dest, mode);
                }) as typeof fsModule.copyFileSync;

                const secondRun = await runCliWithCapturedOutput([
                    'gate', 'full-suite-validation',
                    '--task-id', 'T-PROMOTE-RECOVER',
                    '--preflight-path', preflightPath,
                    '--repo-root', tempDir
                ], { cwd: repoRoot });

                assert.equal(secondRun.exitCode, 0, `stdout=${secondRun.logs.join('\n')}\nstderr=${secondRun.errors.join('\n')}`);
            } finally {
                fsModule.copyFileSync = originalCopyFileSync;
            }

            assert.equal(recoveryPromotionCount, 2);
            assert.ok(fs.existsSync(artifactPath));
            const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
            assert.equal(artifact.status, 'PASSED');
            assert.equal(fs.existsSync(pendingArtifactPath), false);
            assert.equal(fs.existsSync(pendingMetaPath), false);
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
