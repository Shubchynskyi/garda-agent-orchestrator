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
    describe('full-suite duration timeout forecast', () => {
        it('records only the last five matching durations and recommends high-watermark plus 20 percent or at least 30 seconds', () => {
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
            assert.equal(forecast.high_watermark_duration_seconds, 60);
            assert.equal(forecast.recommended_timeout_seconds, 90);
            assert.equal(forecast.safety_margin_seconds, 30);
            assert.equal(forecast.recommendation_source, 'history');
            assert.match(formatFullSuiteTimeoutForecast(forecast), /Recommended full-suite command timeout: 90s/);
            assert.match(formatFullSuiteTimeoutForecast(forecast), /max 60s/);
        });

        it('uses the slowest matching duration instead of hiding outliers behind the average', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-outlier-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig();

            for (const [index, durationMs] of [100_000, 100_000, 100_000, 100_000, 500_000].entries()) {
                recordFullSuiteValidationDuration(repoRoot, config, {
                    timestamp_utc: `2099-01-01T00:00:0${index}.000Z`,
                    task_id: `T-OUTLIER-${index}`,
                    status: 'PASSED',
                    duration_ms: durationMs,
                    timed_out: false,
                    exit_code: 0
                });
            }

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.average_duration_seconds, 180);
            assert.equal(forecast.high_watermark_duration_seconds, 500);
            assert.equal(forecast.recommended_timeout_seconds, 600);
            assert.equal(forecast.safety_margin_seconds, 100);
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
            assert.equal(forecast.high_watermark_duration_seconds, null);
            assert.equal(forecast.recommended_timeout_seconds, 300);
            assert.equal(forecast.recommendation_source, 'config_timeout');

            fs.writeFileSync(resolveFullSuiteDurationHistoryPath(repoRoot), '{not json', 'utf8');
            forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 0);
            assert.equal(forecast.recommended_timeout_seconds, 300);
            assert.match(forecast.warning || '', /unreadable/);
        });
    });
});
