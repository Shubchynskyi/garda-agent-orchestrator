import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    recordFullSuiteValidationDuration,
    resolveFullSuiteDurationHistoryPath,
    type FullSuiteValidationConfig
} from '../../../../src/gates/full-suite/full-suite-validation';

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
                    status: 'PASSED',
                    duration_ms: (index + 1) * 10_000,
                    timed_out: false,
                    exit_code: 0
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
            assert.equal(forecast.excluded_sample_count, 0);
        });

        it('excludes timed-out and interrupted runs from timeout forecasts without dropping diagnostic history', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-hygiene-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig();

            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:00.000Z',
                task_id: 'T-GREEN',
                status: 'PASSED',
                duration_ms: 100_000,
                timed_out: false,
                exit_code: 0
            });
            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:01.000Z',
                task_id: 'T-TIMEOUT',
                status: 'FAILED',
                duration_ms: 29_547_989,
                timed_out: true,
                exit_code: 1
            });
            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:02.000Z',
                task_id: 'T-CANCELLED',
                status: 'FAILED',
                duration_ms: 600_000,
                timed_out: false,
                cancelled: true,
                exit_code: 1
            });

            const history = JSON.parse(fs.readFileSync(resolveFullSuiteDurationHistoryPath(repoRoot), 'utf8')) as {
                entries: Array<{
                    task_id: string;
                    forecast_sample_eligible: boolean;
                    forecast_exclusion_reason: string;
                }>;
            };
            assert.equal(history.entries.length, 3);
            assert.deepEqual(history.entries.map((entry) => entry.task_id), ['T-GREEN', 'T-TIMEOUT', 'T-CANCELLED']);
            assert.deepEqual(history.entries.map((entry) => entry.forecast_sample_eligible), [true, false, false]);
            assert.deepEqual(history.entries.map((entry) => entry.forecast_exclusion_reason), ['none', 'timed_out', 'interrupted_or_cancelled']);

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 1);
            assert.equal(forecast.excluded_sample_count, 2);
            assert.equal(forecast.excluded_sample_reasons.timed_out, 1);
            assert.equal(forecast.excluded_sample_reasons.interrupted_or_cancelled, 1);
            assert.equal(forecast.average_duration_seconds, 100);
            assert.equal(forecast.high_watermark_duration_seconds, 100);
            assert.equal(forecast.recommended_timeout_seconds, 130);
            const text = formatFullSuiteTimeoutForecast(forecast);
            assert.match(text, /target sample 5 recent run\(s\); eligible 1 run\(s\) avg 100s/);
            assert.match(text, /2 matching run\(s\) excluded from forecast/);
            assert.match(text, /interrupted_or_cancelled=1/);
            assert.match(text, /timed_out=1/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('excludes only implausible successful outlier durations while preserving normal slow successful runs', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-outlier-hygiene-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig();

            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:00.000Z',
                task_id: 'T-SLOW-SUCCESS',
                status: 'PASSED',
                duration_ms: 500_000,
                timed_out: false,
                exit_code: 0
            });
            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:01.000Z',
                task_id: 'T-SUSPENDED-WALLCLOCK',
                status: 'PASSED',
                duration_ms: 24 * 60 * 60 * 1000 + 1,
                timed_out: false,
                exit_code: 0
            });

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 1);
            assert.equal(forecast.excluded_sample_count, 1);
            assert.equal(forecast.excluded_sample_reasons.outlier_duration, 1);
            assert.equal(forecast.high_watermark_duration_seconds, 500);
            assert.equal(forecast.recommended_timeout_seconds, 600);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('surfaces excluded matching runs when no eligible forecast samples remain', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-all-excluded-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig();

            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:00.000Z',
                task_id: 'T-TIMEOUT',
                status: 'FAILED',
                duration_ms: 600_000,
                timed_out: true,
                exit_code: 1
            });
            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:01.000Z',
                task_id: 'T-CANCELLED',
                status: 'FAILED',
                duration_ms: 500_000,
                timed_out: false,
                cancelled: true,
                exit_code: 1
            });

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 0);
            assert.equal(forecast.excluded_sample_count, 2);
            const text = formatFullSuiteTimeoutForecast(forecast);
            assert.match(text, /no eligible recent matching full-suite duration history/);
            assert.match(text, /2 matching run\(s\) excluded from forecast/);
            assert.match(text, /interrupted_or_cancelled=1/);
            assert.match(text, /timed_out=1/);
            fs.rmSync(tempDir, { recursive: true, force: true });
        });

        it('uses retry-contaminated successful runs as conservative timeout forecast samples', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-fsv-duration-retry-contaminated-'));
            const repoRoot = path.join(tempDir, 'repo');
            fs.mkdirSync(repoRoot, { recursive: true });
            const config = buildFullSuiteDurationTestConfig();

            recordFullSuiteValidationDuration(repoRoot, config, {
                timestamp_utc: '2099-01-01T00:00:00.000Z',
                task_id: 'T-RETRY-PASS',
                status: 'PASSED',
                duration_ms: 600_000,
                timed_out: false,
                retry_contaminated: true,
                exit_code: 0
            });

            const forecast = buildFullSuiteTimeoutForecast(repoRoot, config);
            assert.equal(forecast.sample_count, 1);
            assert.equal(forecast.excluded_sample_count, 0);
            assert.equal(forecast.excluded_sample_reasons.retry_contaminated, undefined);
            assert.equal(forecast.high_watermark_duration_seconds, 600);
            assert.equal(forecast.recommended_timeout_seconds, 720);
            const text = formatFullSuiteTimeoutForecast(forecast);
            assert.match(text, /eligible 1 run\(s\) avg 600s/);
            assert.doesNotMatch(text, /retry_contaminated=1/);
            fs.rmSync(tempDir, { recursive: true, force: true });
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
