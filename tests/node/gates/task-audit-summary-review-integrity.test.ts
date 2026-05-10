import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    spawn,
    createHash,
    execFileSync,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    ensureSkillsHeadlinesCurrent,
    getWorkspaceSnapshot,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    NODE_BACKEND_SKILL_SOURCE,
    computeFileSha256,
    computeTaskTextSha256,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    appendIntegrityEvent,
    buildReviewRecordedTelemetryDetails,
    writePassedLifecycleWithReviewRecorded,
    writeWorkflowConfig,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    writeProjectMemoryImpactArtifact,
    writePathsConfig,
    writePassedLifecycle,
    makeIndependentReviewGateCheck,
    makeReviewerInvocationProvenance,
    makeDelegatedRouting,
    writeRequiredCodeScenario,
    buildCurrentTaskAuditSummary,
    assertReviewIntegrity,
    assertReviewIntegrityBlocksFinalCloseout,
    writeCurrentIndependentReviewFixture,
    initGitRepo,
    writeActiveCompletionLock,
    makeTempDir,
    type TaskAuditSummaryResult
} from './task-audit-summary-fixtures';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('buildTaskAuditSummary', () => {
        it('keeps the legacy trust summary visible when preflight review metadata is missing but historical review artifacts remain', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_provenance: {
                    schema_version: 1,
                    attestation_type: 'controller_event_integrity',
                    controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
                    task_sequence: 1,
                    prev_event_sha256: null,
                    event_sha256: 'a'.repeat(64)
                },
                trust_level: 'LOCAL_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_trust?.status, 'LEGACY_LOCAL_AUDITED_CLAIM');
            assert.match(result.final_closeout.review_trust?.visible_summary_line || '', /legacy LOCAL_AUDITED claim/i);
            assert.match(formatTaskAuditSummaryText(result), /Review trust: legacy LOCAL_AUDITED claim/i);
        });

        it('keeps an unavailable trust summary visible when only a partial compatibility review artifact remains', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.review_trust?.status, 'UNAVAILABLE');
            assert.match(result.final_closeout.review_trust?.visible_summary_line || '', /incomplete or invalid/i);
            assert.match(formatTaskAuditSummaryText(result), /Review trust: unavailable/i);
        });

        it('reads independent delegated trust from a current passed review gate', () => {
            const preflightSha256 = 'a'.repeat(64);
            const reviewGate = {
                task_id: TASK_ID,
                status: 'PASSED',
                outcome: 'PASS',
                preflight_hash_sha256: preflightSha256,
                required_reviews: { code: true },
                review_checks: {
                    code: makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:code-reviewer')
                }
            };

            const summary = readReviewTrustSummaryFromReviewGate(
                reviewGate,
                { code: true },
                TASK_ID,
                'code',
                preflightSha256
            );
            const staleSummary = readReviewTrustSummaryFromReviewGate(
                reviewGate,
                { code: true },
                TASK_ID,
                'code',
                'b'.repeat(64)
            );
            const missingRoutingPolicySummary = readReviewTrustSummaryFromReviewGate(
                {
                    ...reviewGate,
                    review_checks: {
                        code: {
                            ...makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:code-reviewer'),
                            reviewer_routing_policy: undefined
                        }
                    }
                },
                { code: true },
                TASK_ID,
                'code',
                preflightSha256
            );

            assert.equal(summary?.status, 'INDEPENDENT_AUDITED');
            assert.equal(summary?.completion_policy, 'INDEPENDENT_REVIEW_ATTESTED');
            assert.equal(staleSummary, null);
            assert.equal(missingRoutingPolicySummary, null);
        });

        describe('final closeout review integrity enforced output', () => {
            describe('positive closeout states', () => {
                it('marks final closeout ready when current mandatory reviews are independently attested', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePreflight(reviewsDir, TASK_ID, { mode: 'FULL_PATH', changed_files: ['src/gates/task-audit-summary.ts'], metrics: { changed_lines_total: 18 }, required_reviews: { code: true } });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    const reviewerIdentity = 'agent:code-reviewer';
                    const fixture = writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256, reviewerIdentity, provenance: null });
                    writeIntegrityEventSequence(eventsDir, TASK_ID, ['TASK_MODE_ENTERED', 'RULE_PACK_LOADED', 'HANDSHAKE_DIAGNOSTICS_RECORDED', 'SHELL_SMOKE_PREFLIGHT_RECORDED', 'PREFLIGHT_CLASSIFIED', 'COMPILE_GATE_PASSED', 'REVIEW_PHASE_STARTED'].map((event_type) => ({ event_type })));
                    const invocationEvent = appendIntegrityEvent(eventsDir, TASK_ID, {
                        event_type: 'REVIEWER_INVOCATION_ATTESTED',
                        details: { task_id: TASK_ID, review_type: 'code', reviewer_execution_mode: 'delegated_subagent', reviewer_identity: reviewerIdentity, review_context_sha256: fixture.reviewContextSha256, routing_event_sha256: 'd'.repeat(64) }
                    });
                    const receiptPath = path.join(reviewsDir, `${TASK_ID}-code-receipt.json`);
                    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
                    const integrity = invocationEvent.integrity as Record<string, unknown>;
                    receipt.reviewer_provenance = { schema_version: 1, attestation_type: 'reviewer_invocation_attestation', controller_event_type: 'REVIEWER_INVOCATION_ATTESTED', task_sequence: integrity.task_sequence, prev_event_sha256: integrity.prev_event_sha256, event_sha256: integrity.event_sha256, task_id: TASK_ID, review_type: 'code', reviewer_execution_mode: 'delegated_subagent', reviewer_identity: reviewerIdentity, review_context_sha256: fixture.reviewContextSha256, routing_event_sha256: 'd'.repeat(64) };
                    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', receipt);
                    appendIntegrityEvent(eventsDir, TASK_ID, { event_type: 'REVIEW_RECORDED', details: buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code') });
                    ['REVIEW_GATE_PASSED', 'DOC_IMPACT_ASSESSED', 'COMPLETION_GATE_PASSED'].forEach((event_type) => appendIntegrityEvent(eventsDir, TASK_ID, { event_type }));

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    assert.equal(result.final_closeout.status, 'READY');
                    assert.equal(result.final_report_contract.status, 'READY');
                    const attestation = assertReviewIntegrity(result, 'INDEPENDENT_REVIEW_ATTESTED', {
                        completionReviewAttested: true,
                        enforcementMode: 'BLOCKING'
                    });
                    assert.deepEqual(attestation.observed_issues, []);
                });

                it('marks docs-only no-review closeout as allowed but not review-attested', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePassedLifecycle(eventsDir, TASK_ID);
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FAST_PATH',
                        scope_category: 'docs-only',
                        changed_files: ['docs/usage.md'],
                        metrics: { changed_lines_total: 6 },
                        required_reviews: {}
                    });

                    const result = buildTaskAuditSummary({
                        taskId: TASK_ID,
                        repoRoot: tmpDir,
                        eventsRoot: eventsDir,
                        reviewsRoot: reviewsDir
                    });

                    assert.equal(result.final_closeout.status, 'READY');
                    assertReviewIntegrity(result, 'NO_REVIEW_REQUIRED', {
                        completionReviewAttested: false,
                        completionReviewAttestationNotRequired: true
                    });
                });
            });

            describe('degraded and fallback enforcement states', () => {
                const degradedCases = [
                    {
                        name: 'fabricated',
                        writeFixture: (sha: string) => writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256: sha, reviewContent: '# Code Review\nReview artifact: placeholder\nREVIEW PASSED' }),
                        issue: 'fabricated-looking review artifact content observed'
                    },
                    {
                        name: 'missing-invocation',
                        writeFixture: (sha: string) => writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256: sha }),
                        issue: 'missing matching REVIEWER_INVOCATION_ATTESTED telemetry'
                    },
                    {
                        name: 'missing-receipt',
                        writeFixture: (sha: string) => {
                            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED');
                            writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', { task_id: TASK_ID, status: 'PASSED', outcome: 'PASS', preflight_hash_sha256: sha, required_reviews: { code: true }, review_checks: { code: makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:code-reviewer') } });
                        },
                        issue: 'missing or invalid review receipt'
                    },
                    {
                        name: 'mismatched-hash',
                        writeFixture: (sha: string) => {
                            writeCurrentIndependentReviewFixture({ reviewsDir, taskId: TASK_ID, preflightSha256: sha });
                            writeArtifact(reviewsDir, TASK_ID, '-code.md', '# Code Review\nREVIEW PASSED\nmodified after receipt');
                        },
                        issue: 'review artifact hash does not match receipt'
                    }
                ] as const;

                for (const degradedCase of degradedCases) {
                    it(`blocks ${degradedCase.name} review evidence from final closeout`, () => {
                        writeWorkflowConfig(tmpDir, false);
                        writePreflight(reviewsDir, TASK_ID, { mode: 'FULL_PATH', changed_files: [`src/${degradedCase.name}.ts`], metrics: { changed_lines_total: 18 }, required_reviews: { code: true } });
                        degradedCase.writeFixture(computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)));
                        const details = fs.existsSync(path.join(reviewsDir, `${TASK_ID}-code-receipt.json`))
                            ? buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code')
                            : {};
                        writePassedLifecycleWithReviewRecorded(eventsDir, TASK_ID, details);

                        const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                        assertReviewIntegrityBlocksFinalCloseout(result, degradedCase.issue);
                    });
                }

                it('blocks reused review evidence without strict bindings from final closeout', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePassedLifecycle(eventsDir, TASK_ID);
                    writeArtifact(reviewsDir, TASK_ID, '-task-mode.json', {
                        requested_depth: 2,
                        effective_depth: 2,
                        active_profile: 'balanced'
                    });
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: ['tests/node/cli/commands/gates-review-reuse.test.ts'],
                        metrics: { changed_lines_total: 32 },
                        required_reviews: { code: true, test: true }
                    });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    const codeReviewContent = '# Code Review\nREVIEW PASSED';
                    const testReviewContent = '# Test Review\nTEST REVIEW PASSED';
                    writeArtifact(reviewsDir, TASK_ID, '-code.md', codeReviewContent);
                    writeArtifact(reviewsDir, TASK_ID, '-test.md', testReviewContent);
                    writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                        schema_version: 2,
                        task_id: TASK_ID,
                        review_type: 'code',
                        preflight_sha256: preflightSha256,
                        review_context_sha256: '1'.repeat(64),
                        review_artifact_sha256: createHash('sha256').update(codeReviewContent, 'utf8').digest('hex'),
                        reused_existing_review: true,
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:historical-code-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    });
                    writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                        schema_version: 2,
                        task_id: TASK_ID,
                        review_type: 'test',
                        preflight_sha256: preflightSha256,
                        review_context_sha256: '2'.repeat(64),
                        review_artifact_sha256: createHash('sha256').update(testReviewContent, 'utf8').digest('hex'),
                        reviewer_execution_mode: 'delegated_subagent',
                        reviewer_identity: 'agent:fresh-test-reviewer',
                        reviewer_fallback_reason: null,
                        trust_level: 'INDEPENDENT_AUDITED'
                    });
                    writeArtifact(reviewsDir, TASK_ID, '-review-gate.json', {
                        task_id: TASK_ID,
                        status: 'PASSED',
                        outcome: 'PASS',
                        preflight_hash_sha256: preflightSha256,
                        required_reviews: { code: true, test: true },
                        verdicts: {
                            code: 'REVIEW PASSED',
                            test: 'TEST REVIEW PASSED'
                        },
                        review_checks: {
                            code: makeIndependentReviewGateCheck('REVIEW PASSED', 'agent:historical-code-reviewer'),
                            test: makeIndependentReviewGateCheck('TEST REVIEW PASSED', 'agent:fresh-test-reviewer')
                        }
                    });

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    assertReviewIntegrityBlocksFinalCloseout(result, 'strict reused review evidence is invalid');
                });

                it('blocks stale telemetry closeout through review integrity enforcement', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: ['src/gates/task-audit-summary.ts'],
                        metrics: { changed_lines_total: 18 },
                        required_reviews: { code: true }
                    });
                    const preflightSha256 = computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`));
                    writeCurrentIndependentReviewFixture({
                        reviewsDir,
                        taskId: TASK_ID,
                        preflightSha256
                    });
                    const reviewRecordedDetails = buildReviewRecordedTelemetryDetails(reviewsDir, TASK_ID, 'code');
                    writePassedLifecycleWithReviewRecorded(eventsDir, TASK_ID, reviewRecordedDetails, 'after-review-gate');

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    assert.equal(result.status, 'BLOCKED');
                    assertReviewIntegrityBlocksFinalCloseout(result, 'review recorded after current required-reviews gate');
                    assert.ok(result.blockers.some((blocker) =>
                        blocker.gate === 'required-reviews-check'
                        && blocker.reason.includes('Required review evidence changed after REVIEW_GATE_PASSED')
                    ));
                });
            });

            describe('unsafe review type enforcement reporting', () => {
                it('allowlists required review types before review artifact path construction', () => {
                    writeWorkflowConfig(tmpDir, false);
                    writePassedLifecycle(eventsDir, TASK_ID);
                    writePreflight(reviewsDir, TASK_ID, {
                        mode: 'FULL_PATH',
                        changed_files: ['src/gates/task-audit-summary.ts'],
                        metrics: { changed_lines_total: 18 },
                        required_reviews: { '../../../outside': true }
                    });

                    const result = buildCurrentTaskAuditSummary(TASK_ID, tmpDir, eventsDir, reviewsDir);

                    const attestation = assertReviewIntegrityBlocksFinalCloseout(
                        result,
                        'unsafe or unknown required review type ignored'
                    );
                    assert.deepEqual(attestation.required_review_types, []);
                });
            });
        });

        it('does not promote asserted-local review gate checks to independent trust', () => {
            const summary = readReviewTrustSummaryFromReviewGate(
                {
                    task_id: TASK_ID,
                    status: 'PASSED',
                    outcome: 'PASS',
                    preflight_hash_sha256: 'a'.repeat(64),
                    required_reviews: { code: true },
                    review_checks: {
                        code: {
                            required: true,
                            skipped_by_override: false,
                            receipt_valid: true,
                            reviewer_execution_mode: 'same_agent_fallback',
                            reviewer_identity: `self:${TASK_ID}`,
                            reviewer_fallback_reason: 'provider limitation',
                            trust_level: 'LOCAL_ASSERTED'
                        }
                    }
                },
                { code: true },
                TASK_ID,
                'code',
                'a'.repeat(64)
            );

            assert.equal(summary, null);
        });

        it('degrades review trust summary when required review trust evidence is incomplete or invalid', () => {
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                reviewer_provenance: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });
            writeArtifact(reviewsDir, TASK_ID, '-test-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'test',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:test-reviewer',
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'INDEPENDENT_AUDITED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true, test: true },
                reviewsDir,
                TASK_ID,
                'code'
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.equal(summary?.independent_review_attested, false);
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the current review artifact no longer matches the receipt hash', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                review_artifact_sha256: crypto.createHash('sha256').update('# Code Review\nREVIEW PASSED - stale', 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code'
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps current-cycle trust unavailable when a required review receipt omits review_artifact_sha256', () => {
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: null,
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the receipt preflight hash no longer matches the current preflight', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/task-audit-summary.ts'],
                metrics: { changed_lines_total: 12 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: 'stale-preflight-hash',
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback receipt omits reviewer_fallback_reason', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code'
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when delegated_subagent receipt uses a self-scoped reviewer identity', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code'
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps trust unavailable when REVIEW_RECORDED telemetry points to a deprecated same_agent_fallback context at a noncanonical path', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            const customReviewContextPath = path.join(reviewsDir, 'custom-code-review-context.json');
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            fs.writeFileSync(customReviewContextPath, JSON.stringify({
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            }, null, 2) + '\n', 'utf8');
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(customReviewContextPath),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when the current review context routing diverges from the receipt', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: null
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback routing conflicts with a delegation-required policy', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: 'provider limitation',
                    capability_level: 'delegation_required',
                    delegation_required: true,
                    expected_execution_mode: 'delegated_subagent',
                    fallback_allowed: false,
                    fallback_reason_required: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when delegated_subagent routing conflicts with a same-agent-only policy', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: null,
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: true
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: null,
                reviewer_provenance: {
                    attestation_type: 'provider_artifact'
                },
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback uses a non-self-scoped routing identity', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: 'agent:code-reviewer',
                    fallback_reason: 'provider limitation'
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: 'agent:code-reviewer',
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('degrades review trust summary when same_agent_fallback review-context omits fallback_reason', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: null
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: 'provider limitation',
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });

        it('keeps same_agent_fallback review-context unavailable even when legacy policy marked fallback_reason optional', () => {
            const crypto = require('node:crypto');
            const reviewContent = '# Code Review\nREVIEW PASSED';
            writeArtifact(reviewsDir, TASK_ID, '-code.md', reviewContent);
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/gates/completion.ts'],
                metrics: { changed_lines_total: 24 },
                required_reviews: { code: true }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-review-context.json', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_routing: {
                    actual_execution_mode: 'same_agent_fallback',
                    reviewer_session_id: `self:${TASK_ID}`,
                    fallback_reason: null,
                    capability_level: 'single_agent_only',
                    delegation_required: false,
                    expected_execution_mode: 'same_agent_fallback',
                    fallback_allowed: true,
                    fallback_reason_required: false
                }
            });
            writeArtifact(reviewsDir, TASK_ID, '-code-receipt.json', {
                schema_version: 2,
                task_id: TASK_ID,
                review_type: 'code',
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                review_context_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-code-review-context.json`)),
                review_artifact_sha256: crypto.createHash('sha256').update(reviewContent, 'utf8').digest('hex'),
                reviewer_execution_mode: 'same_agent_fallback',
                reviewer_identity: `self:${TASK_ID}`,
                reviewer_fallback_reason: null,
                trust_level: 'LOCAL_ASSERTED',
                recorded_at_utc: new Date().toISOString()
            });

            const summary = readReviewTrustSummary(
                { code: true },
                reviewsDir,
                TASK_ID,
                'code',
                computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`))
            );

            assert.equal(summary?.status, 'UNAVAILABLE');
            assert.ok(summary?.visible_summary_line?.includes('incomplete or invalid'));
        });
    });
});
