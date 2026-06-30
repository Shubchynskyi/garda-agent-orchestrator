import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../src/gate-runtime/task-events';
import {
    GARDA_LOW_NOISE_RUNTIME_WRITES_ENV,
    GARDA_RUNTIME_WRITES_MODE_ENV,
    type RuntimeWritesMode
} from '../../../src/gate-runtime/derived-runtime-writes';
import { appendMetricsEvent } from '../../../src/gates/shared/hashing-metrics';

const SAMPLE_SIZE = 5;
const MEASUREMENT_COMMAND = 'node scripts/node-foundation/build-scripts.cjs test.js tests/node/gate-runtime/low-noise-runtime-write-measurement.test.ts';

type ObservationKind = 'json' | 'jsonl';

interface RuntimeWriteTargetMeasurement {
    path: string;
    kind: ObservationKind;
    exists: boolean;
    observation_count: number;
    bytes: number;
}

interface ModeMeasurement {
    mode: RuntimeWritesMode;
    sample_size: number;
    command: string;
    environment: Record<string, string>;
    runtime_root: string;
    write_targets: RuntimeWriteTargetMeasurement[];
    existing_write_target_count: number;
    total_write_observations: number;
    task_lock_elapsed_ms_total: number;
    aggregate_lock_elapsed_ms_total: number;
    aggregate_append_modes: string[];
    lock_wait_elapsed_ms_scope: string;
}

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-low-noise-write-measurement-'));
}

function seedBundleRoot(bundleRoot: string): void {
    fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '', 'utf8');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
}

function countNonEmptyLines(filePath: string): number {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return 0;
    }
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(line => line.trimEnd() !== '').length;
}

function measureTarget(runtimeRoot: string, relativePath: string, kind: ObservationKind): RuntimeWriteTargetMeasurement {
    const targetPath = path.join(runtimeRoot, ...relativePath.split('/'));
    if (!fs.existsSync(targetPath) || !fs.statSync(targetPath).isFile()) {
        return {
            path: relativePath,
            kind,
            exists: false,
            observation_count: 0,
            bytes: 0
        };
    }

    const bytes = fs.statSync(targetPath).size;
    return {
        path: relativePath,
        kind,
        exists: true,
        observation_count: kind === 'jsonl' ? countNonEmptyLines(targetPath) : 1,
        bytes
    };
}

function withRuntimeWritesEnv<T>(mode: RuntimeWritesMode, callback: () => T): T {
    const previousLowNoise = process.env[GARDA_LOW_NOISE_RUNTIME_WRITES_ENV];
    const previousMode = process.env[GARDA_RUNTIME_WRITES_MODE_ENV];

    try {
        process.env[GARDA_RUNTIME_WRITES_MODE_ENV] = mode;
        if (mode === 'low-noise') {
            process.env[GARDA_LOW_NOISE_RUNTIME_WRITES_ENV] = '1';
        } else {
            delete process.env[GARDA_LOW_NOISE_RUNTIME_WRITES_ENV];
        }
        return callback();
    } finally {
        if (previousLowNoise === undefined) {
            delete process.env[GARDA_LOW_NOISE_RUNTIME_WRITES_ENV];
        } else {
            process.env[GARDA_LOW_NOISE_RUNTIME_WRITES_ENV] = previousLowNoise;
        }
        if (previousMode === undefined) {
            delete process.env[GARDA_RUNTIME_WRITES_MODE_ENV];
        } else {
            process.env[GARDA_RUNTIME_WRITES_MODE_ENV] = previousMode;
        }
    }
}

function measureMode(mode: RuntimeWritesMode): ModeMeasurement {
    const repoRoot = makeTmpDir();
    seedBundleRoot(repoRoot);
    const runtimeRoot = path.join(repoRoot, 'runtime');
    const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');
    const taskId = mode === 'low-noise' ? 'T-MEASURE-LOW-NOISE' : 'T-MEASURE-NORMAL';
    let taskLockElapsedMsTotal = 0;
    let aggregateLockElapsedMsTotal = 0;
    const aggregateAppendModes = new Set<string>();

    withRuntimeWritesEnv(mode, () => {
        for (let sample = 1; sample <= SAMPLE_SIZE; sample++) {
            const result = appendTaskEvent(
                repoRoot,
                taskId,
                'TASK_MODE_ENTERED',
                'INFO',
                `Low-noise runtime write measurement sample ${sample}`,
                { mode, sample },
                { passThru: true, runtimeWritesMode: mode }
            );

            assert.ok(result);
            assert.equal(result.canonical_committed, true);
            assert.equal(result.commit_status, 'committed');
            taskLockElapsedMsTotal += result.lock_telemetry?.task_lock_elapsed_ms ?? 0;
            aggregateLockElapsedMsTotal += result.lock_telemetry?.aggregate_lock_elapsed_ms ?? 0;
            aggregateAppendModes.add(result.lock_telemetry?.aggregate_append_mode ?? 'unknown');

            appendMetricsEvent(
                metricsPath,
                {
                    gate: 'low_noise_runtime_write_measurement',
                    mode,
                    sample
                },
                true,
                repoRoot
            );
        }
    });

    const writeTargets = [
        measureTarget(runtimeRoot, `task-events/${taskId}.jsonl`, 'jsonl'),
        measureTarget(runtimeRoot, 'task-events/all-tasks.jsonl', 'jsonl'),
        measureTarget(runtimeRoot, 'task-events/.timeline-summary.json', 'json'),
        measureTarget(runtimeRoot, 'metrics.jsonl', 'jsonl'),
        measureTarget(runtimeRoot, 'metrics.jsonl.toxin-snapshot-state.json', 'json')
    ];

    return {
        mode,
        sample_size: SAMPLE_SIZE,
        command: MEASUREMENT_COMMAND,
        environment: {
            [GARDA_RUNTIME_WRITES_MODE_ENV]: mode,
            [GARDA_LOW_NOISE_RUNTIME_WRITES_ENV]: mode === 'low-noise' ? '1' : '<unset>'
        },
        runtime_root: runtimeRoot,
        write_targets: writeTargets,
        existing_write_target_count: writeTargets.filter(target => target.exists).length,
        total_write_observations: writeTargets.reduce((total, target) => total + target.observation_count, 0),
        task_lock_elapsed_ms_total: taskLockElapsedMsTotal,
        aggregate_lock_elapsed_ms_total: aggregateLockElapsedMsTotal,
        aggregate_append_modes: Array.from(aggregateAppendModes).sort(),
        lock_wait_elapsed_ms_scope: 'appendTaskEvent exposes task and aggregate lock telemetry; metrics append has no public elapsed telemetry'
    };
}

function targetByPath(measurement: ModeMeasurement, relativePath: string): RuntimeWriteTargetMeasurement {
    const target = measurement.write_targets.find(candidate => candidate.path === relativePath);
    assert.ok(target, `missing measured target ${relativePath}`);
    return target;
}

test('low-noise runtime writes include repeatable before/after write target measurement', () => {
    const normal = measureMode('normal');
    const lowNoise = measureMode('low-noise');

    try {
        const normalTaskPath = 'task-events/T-MEASURE-NORMAL.jsonl';
        const lowNoiseTaskPath = 'task-events/T-MEASURE-LOW-NOISE.jsonl';

        assert.equal(targetByPath(normal, normalTaskPath).observation_count, SAMPLE_SIZE);
        assert.equal(targetByPath(lowNoise, lowNoiseTaskPath).observation_count, SAMPLE_SIZE);
        assert.equal(targetByPath(normal, 'task-events/all-tasks.jsonl').exists, true);
        assert.equal(targetByPath(normal, 'task-events/.timeline-summary.json').exists, true);
        assert.equal(targetByPath(normal, 'metrics.jsonl').exists, true);
        assert.equal(targetByPath(normal, 'metrics.jsonl.toxin-snapshot-state.json').exists, true);

        assert.equal(targetByPath(lowNoise, 'task-events/all-tasks.jsonl').exists, false);
        assert.equal(targetByPath(lowNoise, 'task-events/.timeline-summary.json').exists, false);
        assert.equal(targetByPath(lowNoise, 'metrics.jsonl').exists, false);
        assert.equal(targetByPath(lowNoise, 'metrics.jsonl.toxin-snapshot-state.json').exists, false);
        assert.deepEqual(lowNoise.aggregate_append_modes, ['skipped_low_noise']);

        const report = {
            metric: 'runtime_write_target_count',
            sample_size: SAMPLE_SIZE,
            command: MEASUREMENT_COMMAND,
            normal,
            low_noise: lowNoise,
            reduction: {
                write_target_count_delta: normal.existing_write_target_count - lowNoise.existing_write_target_count,
                write_observation_delta: normal.total_write_observations - lowNoise.total_write_observations,
                write_target_count_percent: Math.round(
                    ((normal.existing_write_target_count - lowNoise.existing_write_target_count) / normal.existing_write_target_count) * 100
                )
            }
        };

        assert.ok(report.reduction.write_target_count_delta > 0);
        assert.ok(report.reduction.write_observation_delta > 0);
        process.stdout.write(`LOW_NOISE_RUNTIME_WRITE_MEASUREMENT ${JSON.stringify(report)}\n`);
    } finally {
        fs.rmSync(path.dirname(normal.runtime_root), { recursive: true, force: true });
        fs.rmSync(path.dirname(lowNoise.runtime_root), { recursive: true, force: true });
    }
});
