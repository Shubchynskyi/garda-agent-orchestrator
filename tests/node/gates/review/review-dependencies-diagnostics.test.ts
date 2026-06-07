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
    const launchCompletedAtUtc = '2026-05-19T10:00:16.000Z';
    const invocationAttestedAtUtc = '2026-05-19T10:00:20.000Z';
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
            delegation_started_at_utc: launchedAtUtc,
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
                delegation_started_at_utc: launchedAtUtc,
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

