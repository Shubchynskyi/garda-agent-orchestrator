import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assertRequiredUpstreamReviewDependencies,
    assessUpstreamReviewDependencyStatus,
    getRequiredUpstreamReviewsFromRecord,
    type ReviewDependencyTimelineEvent
} from '../../../src/gates/review-dependencies';
import { getReviewExecutionPreparationBatches } from '../../../src/core/review-execution-policy';
import { resolveRuntimeReviewerIdentity } from '../../../src/gates/reviewer-routing';

const PRE_START_BANNER_TASK_MODE_TIMESTAMP = '2026-04-17T11:29:00.000Z';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

test('getRequiredUpstreamReviewsFromRecord keeps all reviews independent in parallel_all mode', () => {
    const requiredReviews = {
        code: true,
        api: true,
        test: true
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'parallel_all'), []);
    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'parallel_all'), []);
});

test('getRequiredUpstreamReviewsFromRecord applies code_first_optional dependencies', () => {
    const requiredReviews = {
        code: true,
        db: false,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'code_first_optional'), ['code']);
    assert.deepEqual(
        getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'code_first_optional'),
        ['code', 'security', 'api', 'performance']
    );
});

test('getRequiredUpstreamReviewsFromRecord narrows test_after_code to code only and serializes strict_sequential', () => {
    const requiredReviews = {
        code: true,
        db: true,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: false,
        infra: false,
        dependency: false
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'test_after_code'), ['code']);
    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'strict_sequential'), ['code', 'db', 'security']);
    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'strict_sequential'), ['code', 'db', 'security', 'api']);
});

test('getRequiredUpstreamReviewsFromRecord keeps legacy compatibility with only test downstream of all required upstream reviews', () => {
    const requiredReviews = {
        code: true,
        db: true,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'legacy_test_downstream'), []);
    assert.deepEqual(
        getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'legacy_test_downstream'),
        ['code', 'db', 'security', 'api', 'performance']
    );
});

test('getReviewExecutionPreparationBatches groups independent reviews together for parallel_all and test_after_code', () => {
    const requiredReviews = {
        code: true,
        db: false,
        security: false,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'parallel_all'),
        [['code', 'api', 'performance', 'test']]
    );
    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'test_after_code'),
        [['code', 'api', 'performance'], ['test']]
    );
});

test('getReviewExecutionPreparationBatches keeps code-gated and legacy downstream reviews in later batches', () => {
    const requiredReviews = {
        code: true,
        db: false,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'code_first_optional'),
        [['code', 'security'], ['api', 'performance'], ['test']]
    );
    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'legacy_test_downstream'),
        [['code', 'security', 'api', 'performance'], ['test']]
    );
});

test('getReviewExecutionPreparationBatches keeps strict_sequential fully serialized', () => {
    const requiredReviews = {
        code: true,
        db: true,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: false,
        infra: false,
        dependency: false
    };

    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'strict_sequential'),
        [['code'], ['db'], ['security'], ['api'], ['test']]
    );
});

test('assessUpstreamReviewDependencyStatus accepts upstream PASS with split canonical/runtime identity', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        const taskEventsPath = path.join(runtimeRoot, 'task-events', `${taskId}.jsonl`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Validate split canonical and runtime identity for upstream review dependencies',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
        fs.writeFileSync(taskEventsPath, JSON.stringify({
            timestamp_utc: '2026-04-17T11:30:00.000Z',
            event_type: 'TASK_MODE_ENTERED',
            status: 'PASS',
            sequence: 1,
            task_id: taskId,
            details: {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                provider: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'provider_bridge',
                runtime_identity_status: 'resolved',
                routed_to: '.antigravity/agents/orchestrator.md'
            }
        }) + '\n', 'utf8');

        const reviewContent = [
            '# Review',
            'Validated split canonical/runtime routing across `src/gates/review-dependencies.ts`, `src/gates/reviewer-routing.ts`, and `src/gates/required-reviews-check.ts`, confirming that upstream PASS evidence remains bound to the audited Antigravity execution provider while canonical ownership stays Codex and delegated reviewer receipts still line up with the active runtime identity for downstream dependency checks.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Antigravity',
                execution_provider_source: 'provider_bridge',
                identity_status: 'resolved',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:antigravity-reviewer',
                fallback_reason: null
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:antigravity-reviewer',
            reviewer_fallback_reason: null,
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code',
            taskModePath
        });

        assert.equal(result.ready, true);
        assert.equal(result.reason, 'pass');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus reuses a precomputed runtime identity without rereading task-mode evidence', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-runtime-cache-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105-cache';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        const taskEventsPath = path.join(runtimeRoot, 'task-events', `${taskId}.jsonl`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reuse precomputed runtime identity for upstream review dependency checks',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
        fs.writeFileSync(taskEventsPath, JSON.stringify({
            timestamp_utc: '2026-04-17T11:30:00.000Z',
            event_type: 'TASK_MODE_ENTERED',
            status: 'PASS',
            sequence: 1,
            task_id: taskId,
            details: {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                provider: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'provider_bridge',
                runtime_identity_status: 'resolved',
                routed_to: '.antigravity/agents/orchestrator.md'
            }
        }) + '\n', 'utf8');

        const reviewContent = [
            '# Review',
            'Validated precomputed runtime identity reuse across `src/gates/review-dependencies.ts`, `src/gates/reviewer-routing.ts`, and `src/gates/required-reviews-check.ts`, confirming that downstream dependency checks still honor the attested Antigravity execution provider after the task-mode artifact itself is no longer available on disk.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Antigravity',
                execution_provider_source: 'provider_bridge',
                identity_status: 'resolved',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:antigravity-reviewer',
                fallback_reason: null
            }
        });

        const artifactHash = createHash('sha256').update(reviewContent).digest('hex');
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflightHash = createHash('sha256').update(preflightText).digest('hex');
        const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
        const reviewContextHash = createHash('sha256').update(reviewContextText).digest('hex');

        writeJson(receiptPath, {
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightHash,
            review_artifact_sha256: artifactHash,
            review_context_sha256: reviewContextHash,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:antigravity-reviewer'
        });

        const latestRecordedReviewByType = new Map<string, ReviewDependencyTimelineEvent>([
            ['code', {
                event_type: 'REVIEW_RECORDED',
                sequence: 3,
                details: {
                    review_type: 'code',
                    review_context_path: reviewContextPath.replace(/\\/g, '/')
                }
            }]
        ]);
        const runtimeReviewerIdentity = resolveRuntimeReviewerIdentity({
            repoRoot,
            taskId,
            taskModePath,
            allowLegacyFallback: true
        });
        fs.rmSync(taskModePath, { force: true });

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: JSON.parse(preflightText) as Record<string, unknown>,
            preflightHashSha256: preflightHash,
            latestRecordedReviewByType,
            upstreamReviewType: 'code',
            taskModePath,
            runtimeReviewerIdentity
        });

        assert.equal(result.ready, true, result.reason);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus accepts explicit custom task-mode paths when the default artifact drifts', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const defaultTaskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        const customTaskModePath = path.join(runtimeRoot, 'custom-artifacts', `${taskId}-task-mode.json`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(customTaskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume custom task-mode review dependencies safely',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        writeJson(defaultTaskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Drifted default task-mode artifact',
            provider: 'Codex',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'explicit_provider',
            runtime_identity_status: 'resolved',
            routed_to: 'AGENTS.md'
        });

        const reviewContent = [
            '# Review',
            'Validated explicit custom task-mode propagation through upstream dependency validation with concrete references to `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that a drifted default task-mode artifact must not block a valid provider-bridge task whose audited custom artifact still resolves to Antigravity.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Antigravity',
                execution_provider_source: 'provider_bridge',
                identity_status: 'resolved',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:T-105'
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:T-105',
            reviewer_fallback_reason: null,
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code',
            taskModePath: customTaskModePath
        });

        assert.equal(result.ready, true);
        assert.equal(result.reason, 'pass');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects delegated upstream PASS without attested provenance when timeline integrity is available', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        const taskEventsPath = path.join(runtimeRoot, 'task-events', `${taskId}.jsonl`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject delegated upstream review receipts that lack attested provenance',
            provider: 'Codex',
            canonical_source_of_truth: 'Codex',
            execution_provider: 'Codex',
            execution_provider_source: 'explicit_provider',
            runtime_identity_status: 'resolved'
        });
        fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
        fs.writeFileSync(taskEventsPath, JSON.stringify({
            timestamp_utc: '2026-04-17T11:30:00.000Z',
            event_type: 'TASK_MODE_ENTERED',
            status: 'PASS',
            sequence: 1,
            task_id: taskId,
            details: {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Codex',
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved'
            }
        }) + '\n', 'utf8');

        const reviewContent = [
            '# Review',
            'Validated delegated review dependency evidence across the upstream code artifact, receipt, and routing contract with concrete implementation detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Codex',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Codex',
                execution_provider_source: 'explicit_provider',
                identity_status: 'resolved',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer'
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:code-reviewer',
            reviewer_fallback_reason: null,
            trust_level: 'LOCAL_ASSERTED',
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };
        const timelineEvents: ReviewDependencyTimelineEvent[] = [{
            event_type: 'COMPILE_GATE_PASSED',
            sequence: 8,
            details: null,
            integrity: null
        }, {
            event_type: 'REVIEW_PHASE_STARTED',
            sequence: 9,
            details: { review_type: 'code' },
            integrity: null
        }, {
            event_type: 'REVIEWER_DELEGATION_ROUTED',
            sequence: 10,
            details: {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer'
            },
            integrity: {
                schema_version: 1,
                task_sequence: 11,
                prev_event_sha256: 'a'.repeat(64),
                event_sha256: 'b'.repeat(64)
            }
        }];

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code',
            timelineEvents,
            taskModePath
        });

        assert.equal(result.ready, false);
        assert.match(result.reason, /reviewer_provenance/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects upstream PASS when receipt preflight binding drifts', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject legacy-only routing metadata when upstream review dependencies require split identity',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });

        const reviewContent = [
            '# Review',
            'Validated split canonical/runtime routing with concrete file references.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Antigravity',
                execution_provider_source: 'provider_bridge',
                identity_status: 'resolved',
                actual_execution_mode: 'same_agent_fallback',
                reviewer_session_id: 'self:T-105',
                fallback_reason: 'single-agent provider'
            }
        });

        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: 'tampered-preflight-hash',
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_identity: 'self:T-105',
            reviewer_fallback_reason: 'single-agent provider',
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code'
        });

        assert.equal(result.ready, false);
        assert.match(result.reason, /current preflight artifact/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('review dependency checks reject upstream review artifacts whose verdict regresses to REVIEW FAILED', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject tampered receipt bindings before upstream review dependencies can pass',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });

        const reviewContent = [
            '# Review',
            'Detected a regression in runtime identity propagation.',
            '## Findings by Severity',
            '- High: upstream evidence drifted.',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW FAILED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Antigravity',
                execution_provider_source: 'provider_bridge',
                identity_status: 'resolved',
                actual_execution_mode: 'same_agent_fallback',
                reviewer_session_id: 'self:T-105',
                fallback_reason: 'single-agent provider'
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_identity: 'self:T-105',
            reviewer_fallback_reason: 'single-agent provider',
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code'
        });

        assert.equal(result.ready, false);
        assert.match(result.reason, /REVIEW FAILED/i);
        assert.match(result.reason, /fix implementation/i);
        assert.match(result.reason, /before launching dependent reviews/i);

        assert.throws(
            () => assertRequiredUpstreamReviewDependencies({
                taskId,
                preflightPath,
                preflightPayload: JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>,
                reviewType: 'test',
                timelineEvents: [
                    {
                        event_type: 'COMPILE_GATE_PASSED',
                        sequence: 10,
                        details: null
                    },
                    timelineEvent
                ],
                taskModePath
            }),
            /fix implementation.*before launching dependent reviews/i
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects upstream PASS when review-context runtime source contradicts task-mode', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject upstream review artifacts whose verdict regresses to REVIEW FAILED',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });

        const reviewContent = [
            '# Review',
            'Validated split canonical/runtime routing with concrete file references.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                canonical_source_of_truth: 'Codex',
                execution_provider: 'Antigravity',
                execution_provider_source: 'explicit_provider',
                identity_status: 'resolved',
                actual_execution_mode: 'same_agent_fallback',
                reviewer_session_id: 'self:T-105',
                fallback_reason: 'single-agent provider'
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_identity: 'self:T-105',
            reviewer_fallback_reason: 'single-agent provider',
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code'
        });

        assert.equal(result.ready, false);
        assert.match(result.reason, /execution_provider_source/i);
        assert.match(result.reason, /active runtime source/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects legacy-only routing metadata for upstream PASS', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        const taskEventsPath = path.join(runtimeRoot, 'task-events', `${taskId}.jsonl`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Reject upstream PASS when review-context runtime source contradicts task mode',
            provider: 'Antigravity',
            canonical_source_of_truth: 'Codex',
            execution_provider_source: 'provider_bridge',
            runtime_identity_status: 'resolved',
            routed_to: '.antigravity/agents/orchestrator.md'
        });

        const reviewContent = [
            '# Review',
            'Validated split canonical/runtime routing with concrete file references.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                actual_execution_mode: 'same_agent_fallback',
                reviewer_session_id: 'self:T-105',
                fallback_reason: 'legacy fixture'
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_identity: 'self:T-105',
            reviewer_fallback_reason: 'legacy fixture',
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code'
        });

        assert.equal(result.ready, false);
        assert.match(result.reason, /missing canonical_source_of_truth/i);
        assert.match(result.reason, /missing execution_provider/i);
        assert.match(result.reason, /missing identity_status/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus accepts legacy-only routing metadata when task-mode identity is safely backfilled', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependencies-'));
    try {
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');
        const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
        const runtimeRoot = path.join(bundleRoot, 'runtime');
        const taskId = 'T-105';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        const taskEventsPath = path.join(runtimeRoot, 'task-events', `${taskId}.jsonl`);

        writeJson(path.join(runtimeRoot, 'init-answers.json'), {
            AssistantLanguage: 'English',
            AssistantBrevity: 'concise',
            SourceOfTruth: 'Codex',
            EnforceNoAutoCommit: 'false',
            ClaudeOrchestratorFullAccess: 'false',
            TokenEconomyEnabled: 'true',
            CollectedVia: 'AGENT_INIT_PROMPT.md',
            ActiveAgentFiles: 'AGENTS.md'
        });

        writeJson(preflightPath, {
            schema_version: 1,
            task_id: taskId,
            required_reviews: {
                code: true,
                test: true
            }
        });

        writeJson(taskModePath, {
            timestamp_utc: PRE_START_BANNER_TASK_MODE_TIMESTAMP,
            schema_version: 1,
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            event_source: 'enter-task-mode',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume a legacy provider-bridge review dependency after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        fs.mkdirSync(path.dirname(taskEventsPath), { recursive: true });
        fs.writeFileSync(taskEventsPath, JSON.stringify({
            timestamp_utc: '2026-04-17T11:30:00.000Z',
            event_type: 'TASK_MODE_ENTERED',
            status: 'PASS',
            sequence: 1,
            task_id: taskId,
            details: {
                artifact_path: taskModePath.replace(/\\/g, '/'),
                provider: 'Codex',
                routed_to: '.antigravity/agents/orchestrator.md'
            }
        }) + '\n', 'utf8');

        const reviewContent = [
            '# Review',
            'Validated resumed legacy provider-bridge routing across `src/gates/review-context-routing.ts`, `src/gates/review-dependencies.ts`, and the backfilled task-mode path so the upstream PASS artifact remains concrete, implementation-aware, and clearly above the trivial-review threshold.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(reviewArtifactPath, reviewContent, 'utf8');

        writeJson(reviewContextPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '',
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:T-105'
            }
        });

        const preflightSha256 = createHash('sha256')
            .update(fs.readFileSync(preflightPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewContextSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex')
            .trim()
            .toLowerCase();
        const reviewArtifactSha256 = createHash('sha256')
            .update(fs.readFileSync(reviewArtifactPath))
            .digest('hex')
            .trim()
            .toLowerCase();

        writeJson(receiptPath, {
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_sha256: preflightSha256,
            scope_sha256: null,
            review_context_sha256: reviewContextSha256,
            review_artifact_sha256: reviewArtifactSha256,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: 'agent:T-105',
            reviewer_fallback_reason: null,
            recorded_at_utc: '2026-04-17T11:31:00.000Z'
        });

        const timelineEvent: ReviewDependencyTimelineEvent = {
            event_type: 'REVIEW_RECORDED',
            sequence: 12,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath.replace(/\\/g, '/')
            }
        };

        const result = assessUpstreamReviewDependencyStatus({
            taskId,
            preflightPath,
            preflightPayload: {},
            preflightHashSha256: preflightSha256,
            latestRecordedReviewByType: new Map([['code', timelineEvent]]),
            upstreamReviewType: 'code'
        });

        assert.equal(result.ready, true);
        assert.equal(result.reason, 'pass');
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
