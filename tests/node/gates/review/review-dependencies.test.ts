import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assertRequiredUpstreamReviewDependencies,
    assessUpstreamReviewDependencyStatus,
    buildReviewDependencyDiagnostics,
    getRequiredUpstreamReviewsFromRecord,
    type ReviewDependencyTimelineEvent
} from '../../../../src/gates/review/review-dependencies';
import { getReviewExecutionPreparationBatches } from '../../../../src/core/review-execution-policy';
import { resolveRuntimeReviewerIdentity, type RuntimeReviewerIdentity } from '../../../../src/gates/review/reviewer-routing';
import { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';

const PRE_START_BANNER_TASK_MODE_TIMESTAMP = '2026-04-17T11:29:00.000Z';

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sha256Buffer(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
}

function domainScopeFingerprintsFixture(laneHash: string): Record<string, unknown> {
    return {
        schema_version: 1,
        detection_source: 'git_auto',
        include_untracked: true,
        use_staged: false,
        domains: {},
        legacy: {
            review_scope_sha256: laneHash,
            code_scope_sha256: laneHash,
            non_test_review_scope_sha256: laneHash,
            code_review_scope_sha256: laneHash
        }
    };
}

function codexRuntimeReviewerIdentityFixture(): RuntimeReviewerIdentity {
    return {
        canonical_source_of_truth: 'Codex',
        canonical_entrypoint: 'AGENTS.md',
        execution_entrypoint: 'AGENTS.md',
        execution_provider: 'Codex',
        execution_provider_source: 'explicit_provider',
        task_mode_identity_backfilled: false,
        routed_to: null,
        provider_bridge: null,
        identity_status: 'resolved',
        capability_level: 'delegation_required',
        delegation_required: true,
        fallback_allowed: false,
        fallback_reason_required: false,
        expected_execution_mode: 'delegated_subagent',
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: 'AGENTS.md',
        reviewer_subagent_launch_reason: 'Codex delegated reviewer launch is available.',
        reviewer_subagent_launch_remediation: null,
        note: '',
        violations: []
    };
}

function createHistoricalLaneDomainReviewDependencyFixture(options: {
    taskId: string;
    contextLaneHash: string;
    currentLaneHash: string;
}): {
    repoRoot: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    timelineEvents: ReviewDependencyTimelineEvent[];
    runtimeReviewerIdentity: RuntimeReviewerIdentity;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependency-lane-domain-'));
    execFileSync('git', ['init'], { cwd: repoRoot, stdio: 'ignore' });
    execFileSync('git', [
        '-c',
        'user.name=Garda Test',
        '-c',
        'user.email=garda-test@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'init'
    ], { cwd: repoRoot, stdio: 'ignore' });
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const taskId = options.taskId;
    const contextDomainScopeFingerprints = buildDomainScopeFingerprints({
        repoRoot,
        detectionSource: 'git_auto',
        includeUntracked: true,
        changedFiles: []
    });
    const currentDomainScopeFingerprints = options.contextLaneHash === options.currentLaneHash
        ? contextDomainScopeFingerprints
        : domainScopeFingerprintsFixture(options.currentLaneHash);
    const oldPreflightPath = path.join(reviewsRoot, `${taskId}-old-preflight.json`);
    writeJson(oldPreflightPath, {
        task_id: taskId,
        changed_files: ['src/feature.ts'],
        metrics: {
            domain_scope_fingerprints: contextDomainScopeFingerprints
        }
    });
    const oldPreflightSha256 = sha256Buffer(fs.readFileSync(oldPreflightPath));
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightPayload = {
        task_id: taskId,
        required_reviews: {
            code: true,
            test: true
        },
        review_execution_policy: {
            mode: 'test_after_code'
        },
        changed_files: ['tests/feature.test.ts'],
        metrics: {
            domain_scope_fingerprints: currentDomainScopeFingerprints
        }
    };
    writeJson(preflightPath, preflightPayload);

    const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const promptArtifactPath = path.join(reviewsRoot, `${taskId}-code-review-prompt.md`);
    fs.writeFileSync(promptArtifactPath, [
        '# Code review prompt',
        '',
        'Review src/gates/review-dependencies.ts, src/gates/required-reviews-check.ts, and the related lane-domain dependency evidence fixture.'
    ].join('\n'), 'utf8');
    const promptArtifactSha256 = sha256Buffer(fs.readFileSync(promptArtifactPath));
    const reviewTreeStateSha256 = 'b'.repeat(64);
    const routingEventSha256 = 'c'.repeat(64);
    const invocationEventSha256 = 'd'.repeat(64);
    const invocationPrevEventSha256 = routingEventSha256;
    const reviewerIdentity = 'agent:code-reviewer';
    const launchPreparedAtUtc = '2026-05-19T10:00:00.000Z';
    const launchedAtUtc = '2026-05-19T10:00:05.000Z';
    const launchCompletedAtUtc = '2026-05-19T10:00:10.000Z';
    const invocationAttestedAtUtc = '2026-05-19T10:00:15.000Z';
    const reviewRecordedAtUtc = '2026-05-19T10:03:00.000Z';
    const reviewOutputSourceMtimeUtc = '2026-05-19T10:02:30.000Z';
    fs.writeFileSync(reviewArtifactPath, [
        '# Code Review',
        '',
        'Reviewed src/gates/review-dependencies.ts, src/gates/required-reviews-check.ts, and src/gates/domain-scope-fingerprints.ts for lane-domain-current upstream dependency handling.',
        'Confirmed the historical code review stays bound to trusted review-context tree_state evidence, receipt hash evidence, delegated reviewer provenance, and strict downstream dependency semantics before test review launch.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'), 'utf8');
    writeJson(reviewContextPath, {
        schema_version: 2,
        task_id: taskId,
        review_type: 'code',
        preflight_path: oldPreflightPath.replace(/\\/g, '/'),
        preflight_sha256: oldPreflightSha256,
        tree_state: {
            schema_version: 1,
            detection_source: 'git_auto',
            use_staged: false,
            include_untracked: true,
            changed_files: [],
            changed_files_sha256: null,
            scope_content_sha256: null,
            scope_sha256: null,
            domain_scope_fingerprints: contextDomainScopeFingerprints,
            entries: [],
            stale_staged_snapshot_files: [],
            mixed_staged_worktree_files: [],
            tree_state_sha256: reviewTreeStateSha256
        },
        reviewer_routing: {
            source_of_truth: 'Codex',
            canonical_source_of_truth: 'Codex',
            execution_provider: 'Codex',
            execution_provider_source: 'explicit_provider',
            identity_status: 'resolved',
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            fallback_reason: null
        },
        rule_context: {
            artifact_path: promptArtifactPath.replace(/\\/g, '/'),
            preferred_prompt_artifact: promptArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: promptArtifactSha256
        }
    });
    const reviewContextSha256 = sha256Buffer(fs.readFileSync(reviewContextPath));
    const reviewArtifactSha256 = sha256Buffer(fs.readFileSync(reviewArtifactPath));
    writeJson(receiptPath, {
        schema_version: 2,
        task_id: taskId,
        review_type: 'code',
        preflight_sha256: oldPreflightSha256,
        scope_sha256: null,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        review_artifact_sha256: reviewArtifactSha256,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        reviewer_fallback_reason: null,
        trust_level: 'INDEPENDENT_AUDITED',
        reviewer_provenance: {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: 2,
            prev_event_sha256: invocationPrevEventSha256,
            event_sha256: invocationEventSha256,
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            review_tree_state_sha256: reviewTreeStateSha256,
            routing_event_sha256: routingEventSha256,
            launch_prepared_at_utc: launchPreparedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            invocation_attested_at_utc: invocationAttestedAtUtc
        },
        recorded_at_utc: reviewRecordedAtUtc,
        review_result_recorded_at_utc: reviewRecordedAtUtc,
        review_output_source_mtime_utc: reviewOutputSourceMtimeUtc
    });
    const timelineEvents: ReviewDependencyTimelineEvent[] = [
        {
            event_type: 'REVIEWER_DELEGATION_ROUTED',
            sequence: 1,
            details: {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: reviewerIdentity
            },
            integrity: {
                schema_version: 1,
                task_sequence: 1,
                prev_event_sha256: null,
                event_sha256: routingEventSha256
            }
        },
        {
            event_type: 'REVIEWER_INVOCATION_ATTESTED',
            sequence: 2,
            details: {
                task_id: taskId,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: reviewerIdentity,
                reviewer_session_id: reviewerIdentity,
                review_context_sha256: reviewContextSha256,
                review_tree_state_sha256: reviewTreeStateSha256,
                routing_event_sha256: routingEventSha256,
                provider_invocation_id: 'codex-review-invocation-123',
                reviewer_launch_attestation_source: 'provider_native',
                launch_prepared_at_utc: launchPreparedAtUtc,
                launched_at_utc: launchedAtUtc,
                launch_completed_at_utc: launchCompletedAtUtc,
                invocation_attested_at_utc: invocationAttestedAtUtc
            },
            integrity: {
                schema_version: 1,
                task_sequence: 2,
                prev_event_sha256: invocationPrevEventSha256,
                event_sha256: invocationEventSha256
            }
        },
        {
            event_type: 'REVIEW_RECORDED',
            sequence: 3,
            details: {
                review_type: 'code',
                review_context_path: reviewContextPath
            }
        },
        {
            event_type: 'COMPILE_GATE_PASSED',
            sequence: 10,
            details: {
                preflight_path: preflightPath
            }
        }
    ];
    return {
        repoRoot,
        preflightPath,
        preflightPayload,
        timelineEvents,
        runtimeReviewerIdentity: codexRuntimeReviewerIdentityFixture()
    };
}

function createReviewDependencyTaxonomyFixture(options: {
    taskId: string;
    receipt?: boolean;
    receiptPreflightSha256?: string;
    context?: boolean;
}): {
    repoRoot: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    timelineEvents: ReviewDependencyTimelineEvent[];
    latestRecordedReviewByType: Map<string, ReviewDependencyTimelineEvent>;
    reviewArtifactPath: string;
    reviewContextPath: string;
    receiptPath: string;
    preflightSha256: string;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-dependency-taxonomy-'));
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, `${options.taskId}-preflight.json`);
    const preflightPayload = {
        task_id: options.taskId,
        required_reviews: {
            code: true,
            test: true
        },
        review_execution_policy: {
            mode: 'test_after_code'
        }
    };
    writeJson(preflightPath, preflightPayload);
    const preflightSha256 = sha256Buffer(fs.readFileSync(preflightPath));
    const reviewArtifactPath = path.join(reviewsRoot, `${options.taskId}-code.md`);
    const reviewContextPath = path.join(reviewsRoot, `${options.taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${options.taskId}-code-receipt.json`);
    fs.writeFileSync(reviewArtifactPath, [
        '# Review',
        '',
        'Validated current-cycle upstream review dependency diagnostics.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'), 'utf8');
    if (options.context !== false) {
        writeJson(reviewContextPath, {
            task_id: options.taskId,
            review_type: 'code'
        });
    }
    if (options.receipt !== false) {
        writeJson(receiptPath, {
            task_id: options.taskId,
            review_type: 'code',
            preflight_sha256: options.receiptPreflightSha256 || preflightSha256,
            review_artifact_sha256: sha256Buffer(fs.readFileSync(reviewArtifactPath))
        });
    }
    const recordedEvent: ReviewDependencyTimelineEvent = {
        event_type: 'REVIEW_RECORDED',
        sequence: 2,
        details: {
            review_type: 'code',
            review_context_path: reviewContextPath
        }
    };
    return {
        repoRoot,
        preflightPath,
        preflightPayload,
        timelineEvents: [
            {
                event_type: 'COMPILE_GATE_PASSED',
                sequence: 1,
                details: {
                    preflight_path: preflightPath
                }
            },
            recordedEvent
        ],
        latestRecordedReviewByType: new Map([['code', recordedEvent]]),
        reviewArtifactPath,
        reviewContextPath,
        receiptPath,
        preflightSha256
    };
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

test('buildReviewDependencyDiagnostics reports no dependency edge for independent reviews', () => {
    const diagnostics = buildReviewDependencyDiagnostics({
        taskId: 'T-328',
        preflightPath: path.join('repo', 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-328-preflight.json'),
        preflightPayload: {
            task_id: 'T-328',
            required_reviews: {
                code: true,
                api: true,
                test: true
            },
            review_execution_policy: {
                mode: 'parallel_all'
            }
        },
        reviewType: 'test',
        timelineEvents: []
    });

    assert.equal(diagnostics.reviewExecutionPolicyMode, 'parallel_all');
    assert.deepEqual(diagnostics.requiredUpstreamReviews, []);
    assert.equal(diagnostics.statuses[0].ready, true);
    assert.equal(diagnostics.statuses[0].dependencyEdge, false);
    assert.equal(diagnostics.statuses[0].blockerCode, 'no_dependency_edge');
    assert.match(diagnostics.statuses[0].reason, /no dependency edge/);
});

test('review dependency diagnostics classify missing upstream pass blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-pass'
    });
    try {
        const diagnostics = buildReviewDependencyDiagnostics({
            taskId: 'T-328-missing-pass',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            reviewType: 'test',
            timelineEvents: [{
                event_type: 'COMPILE_GATE_PASSED',
                sequence: 1,
                details: {
                    preflight_path: fixture.preflightPath
                }
            }]
        });

        assert.equal(diagnostics.requiredUpstreamReviews[0], 'code');
        assert.equal(diagnostics.statuses[0].ready, false);
        assert.equal(diagnostics.statuses[0].blockerCode, 'missing_upstream_pass');
        assert.match(diagnostics.statuses[0].reason, /no REVIEW_RECORDED evidence/);
        assert.throws(() => assertRequiredUpstreamReviewDependencies({
            taskId: 'T-328-missing-pass',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            reviewType: 'test',
            timelineEvents: diagnostics.statuses.length > 0 ? [{
                event_type: 'COMPILE_GATE_PASSED',
                sequence: 1,
                details: {
                    preflight_path: fixture.preflightPath
                }
            }] : []
        }), /BlockerTaxonomy: missing_upstream_pass=code/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('review dependency diagnostics accept lane-domain-current upstream PASS recorded before latest compile', () => {
    const fixture = createHistoricalLaneDomainReviewDependencyFixture({
        taskId: 'T-592-lane-domain-current',
        contextLaneHash: 'a'.repeat(64),
        currentLaneHash: 'a'.repeat(64)
    });
    try {
        const diagnostics = buildReviewDependencyDiagnostics({
            taskId: 'T-592-lane-domain-current',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            reviewType: 'test',
            timelineEvents: fixture.timelineEvents,
            runtimeReviewerIdentity: fixture.runtimeReviewerIdentity
        });

        assert.equal(diagnostics.requiredUpstreamReviews[0], 'code');
        assert.ok(diagnostics.statuses[0].ready, JSON.stringify(diagnostics.statuses[0]));
        assert.equal(diagnostics.statuses[0].blockerCode, null);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('review dependency diagnostics reject historical upstream PASS when lane-domain fingerprint changed', () => {
    const fixture = createHistoricalLaneDomainReviewDependencyFixture({
        taskId: 'T-592-lane-domain-stale',
        contextLaneHash: 'a'.repeat(64),
        currentLaneHash: 'e'.repeat(64)
    });
    try {
        const diagnostics = buildReviewDependencyDiagnostics({
            taskId: 'T-592-lane-domain-stale',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            reviewType: 'test',
            timelineEvents: fixture.timelineEvents,
            runtimeReviewerIdentity: fixture.runtimeReviewerIdentity
        });

        assert.equal(diagnostics.requiredUpstreamReviews[0], 'code');
        assert.equal(diagnostics.statuses[0].ready, false);
        assert.equal(diagnostics.statuses[0].blockerCode, 'stale_freshness');
        assert.match(diagnostics.statuses[0].reason, /lane-domain evidence is not current/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies missing receipt blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-receipt',
        receipt: false
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-missing-receipt',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_receipt');
        assert.match(result.reason, /missing or invalid review receipt JSON/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies stale freshness blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-stale-freshness',
        receiptPreflightSha256: '0'.repeat(64)
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-stale-freshness',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'stale_freshness');
        assert.match(result.reason, /not bound to the current preflight/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus classifies missing context blockers', () => {
    const fixture = createReviewDependencyTaxonomyFixture({
        taskId: 'T-328-missing-context',
        context: false
    });
    try {
        const result = assessUpstreamReviewDependencyStatus({
            taskId: 'T-328-missing-context',
            preflightPath: fixture.preflightPath,
            preflightPayload: fixture.preflightPayload,
            preflightHashSha256: fixture.preflightSha256,
            latestRecordedReviewByType: fixture.latestRecordedReviewByType,
            upstreamReviewType: 'code',
            timelineEvents: fixture.timelineEvents
        });

        assert.equal(result.ready, false);
        assert.equal(result.blockerCode, 'missing_context');
        assert.match(result.reason, /missing or invalid review-context artifact/);
    } finally {
        fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects split-identity upstream PASS without independent launch attestation', () => {
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

        assert.equal(result.ready, false);
        assert.match(result.reason, /independent reviewer launch attestation/i);
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

        assert.equal(result.ready, false);
        assert.match(result.reason, /independent reviewer launch attestation/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('assessUpstreamReviewDependencyStatus rejects custom-path upstream PASS without independent launch attestation', () => {
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

        assert.equal(result.ready, false);
        assert.match(result.reason, /independent reviewer launch attestation/i);
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

test('assessUpstreamReviewDependencyStatus rejects legacy-only routing metadata without independent launch attestation', () => {
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

        assert.equal(result.ready, false);
        assert.match(result.reason, /independent reviewer launch attestation/i);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
