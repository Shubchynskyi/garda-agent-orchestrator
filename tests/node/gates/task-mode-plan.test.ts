import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildTaskModeArtifact,
    getTaskModeEvidence,
    type TaskModePlanMetadata
} from '../../../src/gates/task-mode';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
    const base = path.join(process.cwd(), 'garda-agent-orchestrator', 'runtime', '.test-scratch');
    fs.mkdirSync(base, { recursive: true });
    const dir = fs.mkdtempSync(path.join(base, 'tm-plan-'));
    return dir;
}

function cleanupDir(dir: string): void {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

const PLAN_METADATA: TaskModePlanMetadata = {
    plan_path: 'garda-agent-orchestrator/runtime/reviews/T-099-task-plan.json',
    plan_sha256: 'a'.repeat(64),
    plan_summary: 'Implement the widget feature end to end'
};

// ---------------------------------------------------------------------------
// buildTaskModeArtifact — plan threading
// ---------------------------------------------------------------------------

test('buildTaskModeArtifact includes plan metadata when provided', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        plan: PLAN_METADATA
    });
    assert.ok(artifact.plan);
    assert.equal(artifact.plan.plan_path, PLAN_METADATA.plan_path);
    assert.equal(artifact.plan.plan_sha256, PLAN_METADATA.plan_sha256);
    assert.equal(artifact.plan.plan_summary, PLAN_METADATA.plan_summary);
});

test('buildTaskModeArtifact sets plan to null when not provided', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end'
    });
    assert.equal(artifact.plan, null);
});

test('buildTaskModeArtifact sets plan to null for incomplete plan metadata', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        plan: { plan_path: '', plan_sha256: '', plan_summary: '' }
    });
    assert.equal(artifact.plan, null);
});

test('buildTaskModeArtifact sets plan to null for null plan', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        plan: null
    });
    assert.equal(artifact.plan, null);
});

// ---------------------------------------------------------------------------
// getTaskModeEvidence — plan round-trip
// ---------------------------------------------------------------------------

test('getTaskModeEvidence reads plan metadata from artifact', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end',
            plan: PLAN_METADATA
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.ok(evidence.plan);
        assert.equal(evidence.plan.plan_path, PLAN_METADATA.plan_path);
        assert.equal(evidence.plan.plan_sha256, PLAN_METADATA.plan_sha256);
        assert.equal(evidence.plan.plan_summary, PLAN_METADATA.plan_summary);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence returns null plan when artifact has no plan', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end'
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.plan, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence ignores malformed plan object in artifact', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end'
        });
        // Write artifact with a partial plan (missing plan_summary)
        const raw = JSON.parse(JSON.stringify(artifact));
        raw.plan = { plan_path: 'some/path', plan_sha256: 'abc' };
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.plan, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence ignores non-object plan value in artifact', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end'
        });
        const raw = JSON.parse(JSON.stringify(artifact));
        raw.plan = 'not-an-object';
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.plan, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence ignores array plan value in artifact', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end'
        });
        const raw = JSON.parse(JSON.stringify(artifact));
        raw.plan = ['not', 'an', 'object'];
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.plan, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Partial plan field combinations
// ---------------------------------------------------------------------------

test('buildTaskModeArtifact returns null plan when only plan_path is set', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        plan: { plan_path: 'some/path.json', plan_sha256: '', plan_summary: '' }
    });
    assert.equal(artifact.plan, null);
});

test('buildTaskModeArtifact returns null plan when only plan_sha256 is set', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        plan: { plan_path: '', plan_sha256: 'b'.repeat(64), plan_summary: '' }
    });
    assert.equal(artifact.plan, null);
});

test('buildTaskModeArtifact returns null plan when plan_summary is missing', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        plan: { plan_path: 'some/path.json', plan_sha256: 'b'.repeat(64), plan_summary: '' }
    });
    assert.equal(artifact.plan, null);
});

// ---------------------------------------------------------------------------
// CLI validation: runEnterTaskModeCommand plan-path scenarios
// ---------------------------------------------------------------------------

import { runEnterTaskModeCommand } from '../../../src/cli/commands/gates';
import { serializeTaskPlan, validateTaskPlan } from '../../../src/schemas/task-plan';

test('runEnterTaskModeCommand without --plan-path produces plan: null', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const result = runEnterTaskModeCommand({
            repoRoot: tmpDir,
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end',
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(l => l.includes('PlanGuided: false')));

        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.plan, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand with valid approved plan attaches plan metadata', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: 'T-099',
            status: 'approved',
            goal: 'Build the widget',
            scope_files: ['src/widget.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Create module' }]
        });
        const planPath = path.join(bundleDir, 'T-099-task-plan.json');
        fs.writeFileSync(planPath, serializeTaskPlan(plan));

        const result = runEnterTaskModeCommand({
            repoRoot: tmpDir,
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end',
            planPath: planPath,
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(l => l.includes('PlanGuided: true')));
        assert.ok(result.outputLines.some(l => l.includes('PlanPath:')));

        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.ok(artifact.plan);
        assert.equal(artifact.plan.plan_summary, 'Build the widget');
        assert.equal(artifact.plan.plan_sha256.length, 64);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand rejects plan with mismatched task_id', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: 'T-999',
            status: 'approved',
            goal: 'Wrong task',
            scope_files: ['src/other.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Something' }]
        });
        const planPath = path.join(bundleDir, 'T-999-task-plan.json');
        fs.writeFileSync(planPath, serializeTaskPlan(plan));

        assert.throws(
            () => runEnterTaskModeCommand({
                repoRoot: tmpDir,
                taskId: 'T-099',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Implement the widget feature end to end',
                planPath: planPath,
                emitMetrics: false
            }),
            /does not match/
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand rejects draft plan', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: 'T-099',
            status: 'draft',
            goal: 'Not yet approved',
            scope_files: ['src/widget.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Draft step' }]
        });
        const planPath = path.join(bundleDir, 'T-099-task-plan.json');
        fs.writeFileSync(planPath, serializeTaskPlan(plan));

        assert.throws(
            () => runEnterTaskModeCommand({
                repoRoot: tmpDir,
                taskId: 'T-099',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Implement the widget feature end to end',
                planPath: planPath,
                emitMetrics: false
            }),
            /only approved plans/
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand rejects plan with sha256 mismatch', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: 'T-099',
            status: 'approved',
            goal: 'Build the widget',
            scope_files: ['src/widget.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Create module' }]
        });
        // Write plan with wrong embedded sha256
        const raw = JSON.parse(serializeTaskPlan(plan));
        raw.plan_sha256 = 'c'.repeat(64);
        const planPath = path.join(bundleDir, 'T-099-task-plan.json');
        fs.writeFileSync(planPath, JSON.stringify(raw, null, 2) + '\n');

        assert.throws(
            () => runEnterTaskModeCommand({
                repoRoot: tmpDir,
                taskId: 'T-099',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Implement the widget feature end to end',
                planPath: planPath,
                emitMetrics: false
            }),
            /plan_sha256 mismatch/
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

// ---------------------------------------------------------------------------
// Completion gate plan evidence formatting
// ---------------------------------------------------------------------------

import { formatCompletionGateResult } from '../../../src/gates/completion';

test('formatCompletionGateResult shows PlanGuided: true when plan present', () => {
    const result = {
        outcome: 'PASS',
        task_id: 'T-099',
        status: 'PASSED',
        review_artifacts: {},
        plan: { plan_guided: true, plan_path: 'some/plan.json', plan_sha256: 'a'.repeat(64), plan_summary: 'Build widget' },
        violations: [],
        isolation_mode_warnings: []
    };
    const output = formatCompletionGateResult(result);
    assert.ok(output.includes('PlanGuided: true'));
    assert.ok(output.includes('PlanPath: some/plan.json'));
});

test('formatCompletionGateResult shows PlanGuided: false when no plan', () => {
    const result = {
        outcome: 'PASS',
        task_id: 'T-099',
        status: 'PASSED',
        review_artifacts: {},
        plan: { plan_guided: false, plan_path: null, plan_sha256: null, plan_summary: null },
        violations: [],
        isolation_mode_warnings: []
    };
    const output = formatCompletionGateResult(result);
    assert.ok(output.includes('PlanGuided: false'));
    assert.ok(!output.includes('PlanPath:'));
});

// ---------------------------------------------------------------------------
// Plan-guided vs freeform detection
// ---------------------------------------------------------------------------

test('plan-guided detection: artifact plan presence implies plan-guided execution', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-100',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Execute task with approved plan',
        plan: PLAN_METADATA
    });
    assert.ok(artifact.plan, 'plan should be present for plan-guided mode');
    assert.equal(artifact.plan.plan_sha256, PLAN_METADATA.plan_sha256);
});

test('freeform detection: artifact without plan implies freeform execution', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-100',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Execute task without a plan'
    });
    assert.equal(artifact.plan, null, 'plan should be null for freeform mode');
});

// ---------------------------------------------------------------------------
// T-055: Profile metadata in task-mode artifact
// ---------------------------------------------------------------------------

test('buildTaskModeArtifact includes activeProfile and profileSource when provided', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-100',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Profile-aware task',
        activeProfile: 'strict',
        profileSource: 'built_in'
    });
    assert.equal(artifact.active_profile, 'strict');
    assert.equal(artifact.profile_source, 'built_in');
});

test('buildTaskModeArtifact sets profile fields to null when not provided', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-100',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'No profile task'
    });
    assert.equal(artifact.active_profile, null);
    assert.equal(artifact.profile_source, null);
});

test('buildTaskModeArtifact normalises empty profile strings to null', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-100',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Empty profile',
        activeProfile: '  ',
        profileSource: null
    });
    assert.equal(artifact.active_profile, null);
    assert.equal(artifact.profile_source, null);
});

test('getTaskModeEvidence reads profile metadata from artifact', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-100-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-100',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Profile metadata round-trip',
            activeProfile: 'fast',
            profileSource: 'built_in'
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-100');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.active_profile, 'fast');
        assert.equal(evidence.profile_source, 'built_in');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence returns null profile fields when absent', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-100-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-100',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'No profile metadata'
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-100');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.active_profile, null);
        assert.equal(evidence.profile_source, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand banner includes ActiveProfile when profile is set', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');
        const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
        const configDir = path.join(bundleDir, 'live', 'config');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'strict',
            built_in_profiles: { strict: { description: 'Strict', depth: 3 } },
            user_profiles: {}
        }), 'utf8');

        const result = runEnterTaskModeCommand({
            repoRoot: tmpDir,
            taskId: 'T-100',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Profile banner test',
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(l => l.includes('ActiveProfile: strict')));

        const artifactPath = path.join(reviewsDir, 'T-100-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.active_profile, 'strict');
        assert.equal(artifact.profile_source, 'built_in');
    } finally {
        cleanupDir(tmpDir);
    }
});
