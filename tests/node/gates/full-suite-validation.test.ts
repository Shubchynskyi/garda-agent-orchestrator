import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../src/cli/exit-codes';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from '../../../src/core/constants';
import {
    buildSkippedResult,
    buildValidationResult,
    compactGreenSummary,
    compactRedFailureChunks,
    detectOutOfScopeFailures,
    formatFullSuiteValidationResult,
    loadFullSuiteValidationConfig
} from '../../../src/gates/full-suite-validation';
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
                'process.stdout.write("FAIL at src/unrelated.ts:5 detail\\n"); process.exit(1);',
                'utf8'
            );
            fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: `"${process.execPath.replace(/\\/g, '/')}" "${helperScript.replace(/\\/g, '/')}"`,
                    timeout_ms: 30000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
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
            fs.rmSync(tempDir, { recursive: true, force: true });
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
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    });
});
