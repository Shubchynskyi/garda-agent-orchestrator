import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../src/cli/exit-codes';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../src/core/constants';
import {
    buildFullSuiteValidationOutputTelemetry,
    buildSkippedResult,
    buildValidationResult,
    compactGreenSummary,
    compactRedFailureChunks,
    detectOutOfScopeFailures,
    formatFullSuiteValidationResult,
    loadFullSuiteValidationConfig
} from '../../../src/gates/full-suite-validation';
import { countTextChars } from '../../../src/gate-runtime/text-utils';
import { runCliWithCapturedOutput } from '../cli/commands/gate-test-helpers';

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
                    out_of_scope_failure_policy: 'AUDIT_AND_WARN'
                }
            }));

            const config = loadFullSuiteValidationConfig(tempDir);
            assert.equal(config.enabled, true);
            assert.equal(config.command, 'npm run test:all');
            assert.equal(config.timeout_ms, 300000);
            assert.equal(config.green_summary_max_lines, 3);
            assert.equal(config.red_failure_chunk_lines, 25);
            assert.equal(config.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
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

    describe('CLI integration', () => {
        it('gate full-suite-validation prints SKIPPED and writes JSON artifact when disabled', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-skip-'));
            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const eventsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });
            const preflightPath = path.join(reviewsDir, 'T-SKIP-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-SKIP',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-WARN',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
                    'for (let index = 0; index < 12; index += 1) {',
                    '  process.stdout.write(`detail line ${index} with verbose raw output that should not survive compaction\\n`);',
                    '}',
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
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-PASS',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
            assert.ok(artifact.output_telemetry);
            assert.ok(Number(artifact.output_telemetry.estimated_saved_tokens) > 0);
            const timelinePath = path.join(eventsDir, 'T-PASS.jsonl');
            assert.ok(fs.existsSync(timelinePath));
            const timeline = fs.readFileSync(timelinePath, 'utf8');
            assert.match(timeline, /"event_type":"FULL_SUITE_VALIDATION_PASSED"/);
            assert.match(timeline, /"output_telemetry":\{/);
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
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-PASS-AGGREGATE',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-UNCONFIGURED',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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

        it('fails loudly and removes the canonical artifact when lifecycle event emission fails', async () => {
            const repoRoot = path.resolve(process.cwd());
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-cli-emit-fail-'));
            const runtimeDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime');
            const reviewsDir = path.join(runtimeDir, 'reviews');
            const blockedEventsPath = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(blockedEventsPath, 'blocked', 'utf8');

            const preflightPath = path.join(reviewsDir, 'T-EMIT-FAIL-preflight.json');
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-EMIT-FAIL',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-PROMOTE-RECOVER',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: 'T-STALE-PENDING',
                changed_files: ['src/changed.ts']
            }), 'utf8');

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
