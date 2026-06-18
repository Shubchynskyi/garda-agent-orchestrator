import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { ORCHESTRATOR_START_BANNERS } from '../../../../src/core/orchestrator-start-banner';
import {
    buildTaskModeArtifact,
    getTaskModeEvidence,
    getTaskModeEvidenceViolations,
    resolveMarkdownWorkingPlanPath,
    type TaskModePlanMetadata
} from '../../../../src/gates/task-mode';
import {runEnterTaskModeCommand} from '../../../../src/cli/commands/gates';
import {serializeTaskPlan, validateTaskPlan} from '../../../../src/schemas/task-plan';
import {formatCompletionGateResult} from '../../../../src/gates/completion';


const ownedScratchRoots = new Set<string>();

function makeTempDir(): string {
    const bundleRoot = path.join(process.cwd(), 'garda-agent-orchestrator');
    const runtimeRoot = path.join(bundleRoot, 'runtime');
    const base = path.join(runtimeRoot, '.test-scratch');

    for (const dirPath of [bundleRoot, runtimeRoot, base]) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath);
            ownedScratchRoots.add(dirPath);
        }
    }

    return fs.mkdtempSync(path.join(base, 'tm-plan-'));
}

function cleanupDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        // Best-effort cleanup only.
    }

    const base = path.dirname(dir);
    const runtimeRoot = path.dirname(base);
    const bundleRoot = path.dirname(runtimeRoot);

    for (const dirPath of [base, runtimeRoot, bundleRoot]) {
        try {
            if (dirPath !== base && !ownedScratchRoots.has(dirPath)) {
                continue;
            }
            if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
                continue;
            }
            if (fs.readdirSync(dirPath).length !== 0) {
                continue;
            }
            fs.rmdirSync(dirPath);
            ownedScratchRoots.delete(dirPath);
        } catch {
            // Another test may still be using the parent directory.
        }
    }
}

const PLAN_METADATA: TaskModePlanMetadata = {
    plan_path: 'garda-agent-orchestrator/runtime/reviews/T-099-task-plan.json',
    plan_sha256: 'a'.repeat(64),
    plan_summary: 'Implement the widget feature end to end'
};

function buildResolvedTaskModeArtifact(
    options: Parameters<typeof buildTaskModeArtifact>[0]
) {
    return buildTaskModeArtifact({
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'provider_entrypoint',
        reviewerSubagentLaunchStatus: 'launchable',
        reviewerSubagentLaunchRoute: 'AGENTS.md',
        reviewerSubagentLaunchReason: "Reviewer subagent launch is attested via provider_entrypoint 'AGENTS.md'.",
        runtimeIdentityStatus: 'resolved',
        routedTo: 'AGENTS.md',
        ...options
    });
}

function runEnterTaskModeWithDefaultRouting(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    const routedTo = 'AGENTS.md';
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    if (!fs.existsSync(initAnswersPath)) {
        fs.writeFileSync(initAnswersPath, JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        }, null, 2), 'utf8');
    }
    const routedFilePath = path.join(repoRoot, routedTo);
    fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
    if (!fs.existsSync(routedFilePath)) {
        fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
    }

    return runEnterTaskModeCommand({
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        routedTo,
        ...options
    });
}

// buildTaskModeArtifact — plan threading

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

test('buildTaskModeArtifact includes separate Markdown working-plan metadata', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        markdownWorkingPlan: {
            format: 'markdown',
            working_plan_path: 'garda-agent-orchestrator/runtime/plans/T-099.md',
            working_plan_sha256: 'b'.repeat(64),
            byte_count: 42
        }
    });
    assert.equal(artifact.plan, null);
    assert.deepEqual(artifact.markdown_working_plan, {
        format: 'markdown',
        working_plan_path: 'garda-agent-orchestrator/runtime/plans/T-099.md',
        working_plan_sha256: 'b'.repeat(64),
        byte_count: 42
    });
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

test('buildTaskModeArtifact omits start banner unless explicit telemetry is supplied', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end'
    });
    assert.equal(artifact.start_banner, null);

    const artifactWithMarker = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        startBanner: 'Garda captures my mind'
    });
    assert.equal(artifactWithMarker.start_banner, 'Garda captures my mind');

    const artifactWithOperatorMarker = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Implement the widget feature end to end',
        startBanner: 'Garda task workflow engaged.'
    });
    assert.equal(artifactWithOperatorMarker.start_banner, 'Garda task workflow engaged.');
});

test('orchestrator start banner list includes operator-provided Garda phrases', () => {
    const expectedOperatorPhrases = [
        'Garda orchestrator active.',
        'Garda task workflow engaged.',
        'Garda guarded workflow active.',
        'Garda navigator active.',
        'Garda task mode entered.',
        'Garda orchestration loop started.',
        'Garda task lifecycle started.',
        'Garda next-step workflow active.',
        'Garda guarded task run started.',
        'Garda operator workflow engaged.',
        'Garda task route engaged.',
        'Garda control-plane workflow active.',
        'Garda workflow controls loaded.',
        'Garda queue route active.',
        'Garda task execution path active.'
    ];

    assert.deepEqual(
        ORCHESTRATOR_START_BANNERS.slice(-expectedOperatorPhrases.length),
        expectedOperatorPhrases
    );
});

test('buildTaskModeArtifact preserves blocked reviewer-subagent launch metadata when provided', () => {
    const artifact = buildTaskModeArtifact({
        taskId: 'T-099',
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Record reviewer subagent launch diagnostics for an unavailable reviewer runtime',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        reviewerSubagentLaunchStatus: 'blocked',
        reviewerSubagentLaunchRoute: 'AGENTS.md',
        reviewerSubagentLaunchReason: "Reviewer subagent launchability is unavailable for runtime provider 'Codex'.",
        reviewerSubagentLaunchRemediation: "Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics before preparing required reviews.",
        runtimeIdentityStatus: 'resolved'
    });
    assert.equal(artifact.reviewer_subagent_launch_status, 'blocked');
    assert.equal(artifact.reviewer_subagent_launch_route, 'AGENTS.md');
    assert.match(String(artifact.reviewer_subagent_launch_reason || ''), /Codex/i);
});

// getTaskModeEvidence — plan round-trip

test('getTaskModeEvidence reads plan metadata from artifact', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildResolvedTaskModeArtifact({
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
        assert.equal(evidence.reviewer_subagent_launch_status, 'launchable');
        assert.equal(evidence.reviewer_subagent_launch_route, 'AGENTS.md');
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
        const artifact = buildResolvedTaskModeArtifact({
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
        const artifact = buildResolvedTaskModeArtifact({
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
        const artifact = buildResolvedTaskModeArtifact({
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
        const artifact = buildResolvedTaskModeArtifact({
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

test('getTaskModeEvidence rejects task-mode artifacts that omit pinned runtime identity metadata', () => {
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
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        });
        const raw = JSON.parse(JSON.stringify(artifact));
        delete raw.canonical_source_of_truth;
        delete raw.execution_provider_source;
        delete raw.runtime_identity_status;
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID');
        assert.ok(getTaskModeEvidenceViolations(evidence).some((entry) => entry.includes('canonical_source_of_truth')));
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence rejects implicit runtime-provider fallback at task-mode entry', () => {
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
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'legacy_source_of_truth',
            runtimeIdentityStatus: 'legacy_fallback'
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'EVIDENCE_EXECUTION_PROVIDER_SOURCE_INVALID');
        assert.ok(getTaskModeEvidenceViolations(evidence).some((entry) => entry.includes('execution_provider_source')));
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence ignores invalid repo-external start banners as non-gate telemetry', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(bundleDir, { recursive: true });
        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = buildResolvedTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end'
        });
        const raw = JSON.parse(JSON.stringify(artifact));
        raw.start_banner = 'not from this repo';
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2));

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.start_banner, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence ignores mismatched task-mode and timeline start banners as non-gate telemetry', () => {
    const tmpDir = makeTempDir();
    try {
        const orchestratorRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const runtimeRoot = path.join(orchestratorRoot, 'runtime');
        const reviewsRoot = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
            SourceOfTruth: 'Codex'
        }, null, 2), 'utf8');
        const artifactPath = path.join(reviewsRoot, 'T-099-task-mode.json');
        const artifact = buildResolvedTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Reject mismatched task-mode and timeline start banners'
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

        appendTaskEvent(orchestratorRoot, 'T-099', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry with mismatched timeline banner.', {
            artifact_path: artifactPath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject mismatched task-mode and timeline start banners',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_entrypoint',
            runtime_identity_status: 'resolved',
            start_banner: 'Garda rewrites my code'
        });

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.start_banner, null);
        assert.equal(evidence.timeline_start_banner, 'Garda rewrites my code');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence backfills legacy runtime identity for pre-change task-mode artifacts', () => {
    const tmpDir = makeTempDir();
    try {
        const runtimeRoot = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
        const reviewsRoot = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
            SourceOfTruth: 'Codex'
        }, null, 2), 'utf8');
        const artifactPath = path.join(reviewsRoot, 'T-099-task-mode.json');
        fs.writeFileSync(artifactPath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: 'T-099',
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume a legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2), 'utf8');

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.canonical_source_of_truth, 'Codex');
        assert.equal(evidence.execution_provider_source, 'provider_entrypoint');
        assert.equal(evidence.runtime_identity_status, 'resolved');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence still backfills honest legacy artifacts that include pre-split execution metadata', () => {
    const tmpDir = makeTempDir();
    try {
        const runtimeRoot = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
        const reviewsRoot = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
            SourceOfTruth: 'Codex'
        }, null, 2), 'utf8');
        const artifactPath = path.join(reviewsRoot, 'T-099-task-mode.json');
        fs.writeFileSync(artifactPath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: 'T-099',
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume an honest legacy task-mode artifact after upgrade',
            orchestrator_work: false,
            provider: 'Codex',
            routed_to: 'AGENTS.md',
            actor: 'orchestrator'
        }, null, 2), 'utf8');

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.canonical_source_of_truth, 'Codex');
        assert.equal(evidence.execution_provider_source, 'provider_entrypoint');
        assert.equal(evidence.runtime_identity_status, 'resolved');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence does not backfill stripped current-style artifacts when current-era task-mode provenance remains', () => {
    const tmpDir = makeTempDir();
    try {
        const orchestratorRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const runtimeRoot = path.join(orchestratorRoot, 'runtime');
        const reviewsRoot = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
            SourceOfTruth: 'Codex'
        }, null, 2), 'utf8');
        const artifactPath = path.join(reviewsRoot, 'T-099-task-mode.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Reject stripped current-style task-mode artifacts',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            reviewerCapabilityLevel: 'delegation_required',
            reviewerExpectedExecutionMode: 'delegated_subagent',
            reviewerFallbackAllowed: false,
            reviewerFallbackReasonRequired: false,
            runtimeIdentityStatus: 'resolved'
        });
        const raw = JSON.parse(JSON.stringify(artifact));
        delete raw.canonical_source_of_truth;
        delete raw.execution_provider_source;
        delete raw.reviewer_capability_level;
        delete raw.reviewer_expected_execution_mode;
        delete raw.reviewer_fallback_allowed;
        delete raw.reviewer_fallback_reason_required;
        delete raw.runtime_identity_status;
        delete raw.runtime_identity_violations;
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2), 'utf8');
        appendTaskEvent(orchestratorRoot, 'T-099', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry before tampering.', {
            artifact_path: artifactPath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject stripped current-style task-mode artifacts',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'explicit_provider',
            runtime_identity_status: 'resolved'
        });

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.timeline_declares_runtime_identity_metadata, true);
        assert.equal(evidence.evidence_status, 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID');
        assert.ok(getTaskModeEvidenceViolations(evidence).some((entry) => entry.includes('canonical_source_of_truth')));
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence skips malformed tail lines and keeps the latest valid current-era TASK_MODE_ENTERED', () => {
    const tmpDir = makeTempDir();
    try {
        const orchestratorRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        const runtimeRoot = path.join(orchestratorRoot, 'runtime');
        const reviewsRoot = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
            SourceOfTruth: 'Codex'
        }, null, 2), 'utf8');
        const artifactPath = path.join(reviewsRoot, 'T-099-task-mode.json');
        const legacyArtifactPath = path.join(reviewsRoot, 'T-099-task-mode-legacy.json');
        const artifact = buildTaskModeArtifact({
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Skip malformed tail lines after current task-mode entry',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            reviewerCapabilityLevel: 'delegation_required',
            reviewerExpectedExecutionMode: 'delegated_subagent',
            reviewerFallbackAllowed: false,
            reviewerFallbackReasonRequired: false,
            runtimeIdentityStatus: 'resolved'
        });
        const raw = JSON.parse(JSON.stringify(artifact));
        delete raw.canonical_source_of_truth;
        delete raw.execution_provider_source;
        delete raw.reviewer_capability_level;
        delete raw.reviewer_expected_execution_mode;
        delete raw.reviewer_fallback_allowed;
        delete raw.reviewer_fallback_reason_required;
        delete raw.runtime_identity_status;
        delete raw.runtime_identity_violations;
        fs.writeFileSync(artifactPath, JSON.stringify(raw, null, 2), 'utf8');
        appendTaskEvent(orchestratorRoot, 'T-099', 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before current cycle.', {
            artifact_path: legacyArtifactPath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Legacy task-mode entry before current cycle'
        });
        appendTaskEvent(orchestratorRoot, 'T-099', 'TASK_MODE_ENTERED', 'PASS', 'Current task-mode entry before malformed tail.', {
            artifact_path: artifactPath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Skip malformed tail lines after current task-mode entry',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'explicit_provider',
            runtime_identity_status: 'resolved'
        });
        fs.appendFileSync(path.join(runtimeRoot, 'task-events', 'T-099.jsonl'), '{"event_type":"TASK_MODE_ENTERED"', 'utf8');

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.timeline_artifact_path, artifactPath.replace(/\\/g, '/'));
        assert.equal(evidence.timeline_declares_runtime_identity_metadata, true);
        assert.equal(evidence.evidence_status, 'EVIDENCE_CANONICAL_SOURCE_OF_TRUTH_INVALID');
        assert.ok(getTaskModeEvidenceViolations(evidence).some((entry) => entry.includes('canonical_source_of_truth')));
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence backfills legacy provider-bridge task-mode artifacts without breaking canonical ownership', () => {
    const tmpDir = makeTempDir();
    try {
        const runtimeRoot = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
        const reviewsRoot = path.join(runtimeRoot, 'reviews');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
            SourceOfTruth: 'Codex'
        }, null, 2), 'utf8');
        const artifactPath = path.join(reviewsRoot, 'T-099-task-mode.json');
        fs.writeFileSync(artifactPath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: 'T-099',
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume a legacy bridge-started task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2), 'utf8');

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.provider, 'Antigravity');
        assert.equal(evidence.canonical_source_of_truth, 'Codex');
        assert.equal(evidence.execution_provider_source, 'provider_bridge');
        assert.equal(evidence.runtime_identity_status, 'resolved');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('getTaskModeEvidence treats routed_to as telemetry when execution_provider_source differs but provider stays the same', () => {
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
            taskSummary: 'Preserve routed telemetry without invalidating same-provider runtime identity',
            provider: 'GitHubCopilot',
            canonicalSourceOfTruth: 'GitHubCopilot',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            routedTo: '.github/copilot-instructions.md'
        });
        fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.execution_provider_source, 'explicit_provider');
        assert.equal(evidence.routed_to, '.github/copilot-instructions.md');
    } finally {
        cleanupDir(tmpDir);
    }
});


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


test('runEnterTaskModeCommand without --plan-path produces plan: null', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const result = runEnterTaskModeWithDefaultRouting({
            repoRoot: tmpDir,
            taskId: 'T-099',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Implement the widget feature end to end',
            startBanner: undefined,
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(l => l.includes('PlanGuided: false')));
        assert.equal(result.outputLines.some(l => l.includes('StartBanner: ')), false);

        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.plan, null);
        assert.equal(artifact.start_banner, null);
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand does not infer runtime provider from SourceOfTruth', () => {
    const tmpDir = makeTempDir();
    try {
        const runtimeDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
        fs.writeFileSync(path.join(runtimeDir, 'init-answers.json'), JSON.stringify({
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Claude',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'CLAUDE.md'
        }, null, 2), 'utf8');

        assert.throws(
            () => runEnterTaskModeCommand({
                repoRoot: tmpDir,
                taskId: 'T-099',
                entryMode: 'EXPLICIT_TASK_EXECUTION',
                requestedDepth: 2,
                effectiveDepth: 2,
                taskSummary: 'Implement the widget feature end to end',
                emitMetrics: false
            }),
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                assert.match(message, /Runtime execution identity is 'missing'/);
                assert.match(message, /Do not infer runtime provider from canonical SourceOfTruth/);
                assert.equal(message.includes("--provider \"Claude\""), false);
                return true;
            }
        );
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand surfaces optional Markdown working plan without enabling plan-guided mode', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        const workingPlanPath = resolveMarkdownWorkingPlanPath(tmpDir, 'T-099');
        fs.mkdirSync(path.dirname(workingPlanPath), { recursive: true });
        fs.writeFileSync(workingPlanPath, '# T-099 working plan\n\n- Keep this optional.\n', 'utf8');

        const result = runEnterTaskModeWithDefaultRouting({
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
        assert.ok(result.outputLines.some(l => l.includes('MarkdownWorkingPlanPath: garda-agent-orchestrator/runtime/plans/T-099.md')));
        assert.ok(result.outputLines.some(l => l.includes('MarkdownWorkingPlanSha256:')));

        const artifactPath = path.join(bundleDir, 'T-099-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.plan, null);
        assert.equal(artifact.markdown_working_plan.format, 'markdown');
        assert.equal(artifact.markdown_working_plan.working_plan_path, 'garda-agent-orchestrator/runtime/plans/T-099.md');
        assert.equal(artifact.markdown_working_plan.working_plan_sha256.length, 64);

        const evidence = getTaskModeEvidence(tmpDir, 'T-099');
        assert.equal(evidence.plan, null);
        assert.equal(evidence.markdown_working_plan?.working_plan_path, 'garda-agent-orchestrator/runtime/plans/T-099.md');
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

        const result = runEnterTaskModeWithDefaultRouting({
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
            () => runEnterTaskModeWithDefaultRouting({
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
            () => runEnterTaskModeWithDefaultRouting({
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
            () => runEnterTaskModeWithDefaultRouting({
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
        const artifact = buildResolvedTaskModeArtifact({
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
        const artifact = buildResolvedTaskModeArtifact({
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
            built_in_profiles: {
                strict: {
                    description: 'Strict',
                    depth: 3,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: false,
                        strip_code_blocks: false,
                        scoped_diffs: true,
                        compact_reviewer_output: false
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }), 'utf8');

        const result = runEnterTaskModeWithDefaultRouting({
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

test('runEnterTaskModeCommand records task-selected and runtime profiles separately', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');
        const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
        const configDir = path.join(bundleDir, 'live', 'config');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-100 | TODO | P1 | orchestration | Profile routing test | gpt-5.4 | 2026-04-27 | fast | fixture |',
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                },
                fast: {
                    description: 'Fast',
                    depth: 1,
                    review_policy: { code: true, test: false },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }), 'utf8');

        const result = runEnterTaskModeWithDefaultRouting({
            repoRoot: tmpDir,
            taskId: 'T-100',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Profile routing test',
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(l => l.includes('TaskProfile: fast (task_queue)')));
        assert.ok(result.outputLines.some(l => l.includes('ActiveProfile: fast (built_in)')));
        assert.ok(result.outputLines.some(l => l.includes('RuntimeActiveProfile: balanced (built_in)')));

        const artifactPath = path.join(reviewsDir, 'T-100-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.task_profile, 'fast');
        assert.equal(artifact.profile_selection_source, 'task_queue');
        assert.equal(artifact.active_profile, 'fast');
        assert.equal(artifact.profile_source, 'built_in');
        assert.equal(artifact.runtime_active_profile, 'balanced');
        assert.equal(artifact.runtime_profile_source, 'built_in');
        assert.equal(artifact.requested_depth_source, 'explicit');
        assert.equal(artifact.effective_depth_source, 'explicit');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand defaults missing depth from selected task profile', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');
        const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
        const configDir = path.join(bundleDir, 'live', 'config');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-100 | TODO | P1 | orchestration | Strict profile routing test | gpt-5.5 | 2026-06-17 | strict | fixture |',
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                },
                strict: {
                    description: 'Strict',
                    depth: 3,
                    review_policy: { code: true, db: true, security: true, refactor: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: false,
                        strip_code_blocks: false,
                        scoped_diffs: true,
                        compact_reviewer_output: false
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }), 'utf8');

        const result = runEnterTaskModeWithDefaultRouting({
            repoRoot: tmpDir,
            taskId: 'T-100',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            taskSummary: 'Strict profile routing test',
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(l => l.includes('TaskProfile: strict (task_queue)')));
        assert.ok(result.outputLines.some(l => l.includes('ActiveProfile: strict (built_in)')));

        const artifactPath = path.join(reviewsDir, 'T-100-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.requested_depth, 3);
        assert.equal(artifact.effective_depth, 3);
        assert.equal(artifact.requested_depth_source, 'profile_default');
        assert.equal(artifact.effective_depth_source, 'requested_depth');
        assert.equal(artifact.runtime_active_profile, 'balanced');
    } finally {
        cleanupDir(tmpDir);
    }
});

test('runEnterTaskModeCommand marks omitted depth-2 profile defaults as profile-derived', () => {
    const tmpDir = makeTempDir();
    try {
        const bundleDir = path.join(tmpDir, 'garda-agent-orchestrator');
        const reviewsDir = path.join(bundleDir, 'runtime', 'reviews');
        const eventsDir = path.join(bundleDir, 'runtime', 'task-events');
        const configDir = path.join(bundleDir, 'live', 'config');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-100 | TODO | P1 | orchestration | Balanced profile routing test | gpt-5.5 | 2026-06-17 | balanced | fixture |',
            ''
        ].join('\n'), 'utf8');
        fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }), 'utf8');

        const result = runEnterTaskModeWithDefaultRouting({
            repoRoot: tmpDir,
            taskId: 'T-100',
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            taskSummary: 'Balanced profile routing test',
            emitMetrics: false
        });
        assert.equal(result.exitCode, 0);

        const artifactPath = path.join(reviewsDir, 'T-100-task-mode.json');
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(artifact.requested_depth, 2);
        assert.equal(artifact.effective_depth, 2);
        assert.equal(artifact.requested_depth_source, 'profile_default');
        assert.equal(artifact.effective_depth_source, 'requested_depth');
    } finally {
        cleanupDir(tmpDir);
    }
});
