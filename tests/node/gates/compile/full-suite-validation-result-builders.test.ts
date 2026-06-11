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
        it('omits raw output only for clean PASSED full-suite results', () => {
            assert.equal(shouldOmitSuccessfulFullSuiteOutput({
                status: 'PASSED',
                warnings: []
            }), true);
            assert.equal(shouldOmitSuccessfulFullSuiteOutput({
                status: 'PASSED',
                warnings: ['warning']
            }), false);
            assert.equal(shouldOmitSuccessfulFullSuiteOutput({
                status: 'WARNED',
                warnings: []
            }), false);
        });

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

            assert.equal(isFullSuiteNotRequiredForDocsOnlyScope({
                scope_category: 'docs-only',
                changed_files: ['docs/security.md'],
                triggers: {
                    runtime_code_changed: false,
                    security: true,
                    test: false
                },
                required_reviews: { security: true }
            }), true);
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

        it('formatFullSuiteValidationResult labels optimized sharded full-suite commands as mandatory evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run test:sharded'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('PerformanceMode: mode=optimized_sharded; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run test:sharded"; fallback_command="npm test"'));
        });

        it('formatFullSuiteValidationResult labels reuse-aware full-suite commands as mandatory evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run build-prep && npm test'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('PerformanceMode: mode=optimized_reuse_aware; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run build-prep && npm test"; fallback_command="npm test"'));
        });

        it('formatFullSuiteValidationResult labels sharded reuse-aware full-suite commands as mandatory evidence', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run build-prep && npm run test:sharded'
            };
            const result = buildValidationResult(config, 0, false, ['# pass 1'], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('PerformanceMode: mode=optimized_sharded_reuse_aware; optimized=true; boundary=mandatory_full_suite_not_smoke_or_fast; optimized_command="npm run build-prep && npm run test:sharded"; fallback_command="npm test"'));
        });

        it('formatFullSuiteValidationResult surfaces slowest known tests from sharded runner output', () => {
            const config = {
                ...loadFullSuiteValidationConfig('/nonexistent'),
                enabled: true,
                command: 'npm run test:sharded',
                green_summary_max_lines: 5
            };
            const result = buildValidationResult(config, 0, false, [
                'NODE_FOUNDATION_TEST_SHARD_PLAN source=duration duration_known=2/2',
                'NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-a.test.ts duration_ms=42000',
                'NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-b.test.ts duration_ms=39000',
                '# tests 20',
                '# pass 20',
                '# fail 0',
                '# duration_ms 120000'
            ], null, ['src/changed.ts'], {
                task_id: 'T-123',
                preflight_path: 'runtime/reviews/T-123-preflight.json',
                preflight_sha256: 'abc123',
                compile_gate_timestamp: null
            });
            const text = formatFullSuiteValidationResult(result);

            assert.ok(text.includes('NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-a.test.ts duration_ms=42000'));
            assert.ok(text.includes('NODE_FOUNDATION_TEST_SLOWEST tests/node/slow-b.test.ts duration_ms=39000'));
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
});
