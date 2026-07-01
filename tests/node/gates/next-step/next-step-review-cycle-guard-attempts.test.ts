import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-cycle-fixtures';

const {
    ALL_REVIEW_FLAGS,
    appendEvent,
    buildReviewContextScopeFixture,
    eventsRoot,
    resolveNextStep,
    formatNextStepText,
    EXPECTED_LOOP_LINE,
    fileSha256,
    fs,
    getLoadedRuleFileBasenames,
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasSplitRequiredClearedEvidence,
    launchInputEvidenceFixture,
    makeTempRepo,
    markReviewEvidenceAsStrictReuse,
    materializeFinalCloseout,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    normalizeForTimeline,
    os,
    path,
    PROVIDER_ENV_KEYS,
    readReviewContextTreeStateSha256,
    readSplitRequiredLatchEvidence,
    requireFromTest,
    resolveReviewCycleContinuationArtifactPath,
    resolveSplitRequiredArtifactPath,
    reviewsRoot,
    runRecordReviewCycleSplitDecisionCommand,
    seedCompilePass,
    seedCompletedReviewerLaunchAndInvocation,
    seedCompletedTaskWithIndependentCodeReview,
    seedCompletionPass,
    seedCustomStartedTask,
    seedDocImpactPass,
    seedFullSuiteValidation,
    seedGitAutoCompilePass,
    seedHandshake,
    seedPostPreflightRulePack,
    seedProjectMemory,
    seedProjectMemoryImpact,
    seedReviewGatePass,
    seedRulePack,
    seedShellSmoke,
    seedSourceCheckoutRuntime,
    seedSplitRequiredLatchEvidence,
    seedStartedTask,
    seedTaskModeOnly,
    sha256Text,
    TASK_ID,
    tempRoots,
    withProviderEnv,
    writeFreshReviewContextWithoutRouting,
    writeGitAutoPreflight,
    writeJson,
    writeJsonWithSha,
    writeNoOpEvidence,
    writePreflight,
    writeProjectMemoryWorkflowConfig,
    writeReviewContextOnly,
    writeReviewCycleContinuation,
    writeReviewEvidence,
    writeStrictDecompositionDecision,
    writeStrictIndependentCodeReviewEvidence
} = fx;
void [ALL_REVIEW_FLAGS, appendEvent, buildReviewContextScopeFixture, eventsRoot, resolveNextStep, formatNextStepText, EXPECTED_LOOP_LINE, fileSha256, fs, getLoadedRuleFileBasenames, hasCompletedDecomposedParentAfterSplitRequiredClear, hasSplitRequiredClearedEvidence, launchInputEvidenceFixture, makeTempRepo, markReviewEvidenceAsStrictReuse, materializeFinalCloseout, NEXT_STEP_FULL_SUITE_TEST_CONFIG, normalizeForTimeline, os, path, PROVIDER_ENV_KEYS, readReviewContextTreeStateSha256, readSplitRequiredLatchEvidence, requireFromTest, resolveReviewCycleContinuationArtifactPath, resolveSplitRequiredArtifactPath, reviewsRoot, runRecordReviewCycleSplitDecisionCommand, seedCompilePass, seedCompletedReviewerLaunchAndInvocation, seedCompletedTaskWithIndependentCodeReview, seedCompletionPass, seedCustomStartedTask, seedDocImpactPass, seedFullSuiteValidation, seedGitAutoCompilePass, seedHandshake, seedPostPreflightRulePack, seedProjectMemory, seedProjectMemoryImpact, seedReviewGatePass, seedRulePack, seedShellSmoke, seedSourceCheckoutRuntime, seedSplitRequiredLatchEvidence, seedStartedTask, seedTaskModeOnly, sha256Text, TASK_ID, tempRoots, withProviderEnv, writeFreshReviewContextWithoutRouting, writeGitAutoPreflight, writeJson, writeJsonWithSha, writeNoOpEvidence, writePreflight, writeProjectMemoryWorkflowConfig, writeReviewContextOnly, writeReviewCycleContinuation, writeReviewEvidence, writeStrictDecompositionDecision, writeStrictIndependentCodeReviewEvidence];

describe('gates/next-step review cycle guard attempts', () => {
    it('does not block closeout when successful non-test review attempts exceed the total limit', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 2,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-${index}`,
                review_context_sha256: sha256Text(`code-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
        assert.equal(text.includes('NextGate: review-cycle-attempt-guard'), false);
        assert.equal(
            fs.existsSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-cycle-auto-split-prompt.md`)),
            false
        );
    });

    it('still blocks malformed timeline evidence after successful PASS attempts exceed the total limit', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:pass-before-malformed-${index}`,
                review_context_sha256: sha256Text(`pass-before-malformed-context-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            reviewer_identity: 'agent:missing-review-type-after-pass-overflow',
            review_context_sha256: sha256Text('missing-review-type-after-pass-overflow')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('timeline_integrity=1>0'));
        assert.equal(result.reason.includes('total_non_test_review_count=2>1'), false);
        assert.equal(result.review_cycle_block?.total_non_test_review_count, 2);
    });

    it('blocks at the total review-cycle limit when the nearest non-test attempt fails', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 2,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:code-before-fail-${index}`,
                review_context_sha256: sha256Text(`code-before-fail-context-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'security',
            reviewer_identity: 'agent:security-total-boundary',
            review_context_sha256: sha256Text('security-total-boundary-context'),
            summary: 'security failed at total review-cycle boundary'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('total_non_test_review_count=3>2'));
        assert.ok(result.reason.includes('excluded_review_types="test"'));
        assert.equal(result.review_cycle_block?.latest_failed_review?.review_type, 'security');
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'security failed at total review-cycle boundary');
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 2,
            failed: 0,
            pending: 0
        });
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.security, {
            total: 1,
            passed: 0,
            failed: 1,
            pending: 0
        });
        assert.ok(text.includes('NextGate: review-cycle-attempt-guard'));
        assert.ok(text.includes('LatestFailedReview: review_type="security"'));
    });

    it('blocks when the latest same-key review record fails after a later unique PASS key was inserted', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const repeatedContextSha256 = sha256Text('repeat-latest-fail-context');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:repeat-latest-fail',
            review_context_sha256: repeatedContextSha256
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:other-pass-before-repeat-fail',
            review_context_sha256: sha256Text('other-pass-before-repeat-fail-context')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:repeat-latest-fail',
            review_context_sha256: repeatedContextSha256,
            summary: 'same reviewer/context failed after another pass key'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('total_non_test_review_count=2>1'));
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 1,
            failed: 1,
            pending: 0
        });
        assert.equal(
            result.review_cycle_block?.latest_failed_review?.summary,
            'same reviewer/context failed after another pass key'
        );
    });

    it('does not count pending reviewer invocation noise as completed review-cycle attempts', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
                review_type: 'code',
                reviewer_identity: `agent:pending-code-${index}`,
                review_context_sha256: sha256Text(`pending-code-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
    });

    it('blocks next-step when failed non-test review attempts exceed review cycle guard failed limit', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'security',
                reviewer_identity: `agent:security-${index}`,
                review_context_sha256: sha256Text(`security-context-${index}`),
                summary: `security finding ${index}`
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>1'));
        assert.equal(result.review_cycle_block?.latest_failed_review?.review_type, 'security');
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'security finding 1');
        assert.ok(text.includes('LatestFailedReview: review_type="security"'));
        assert.ok(text.includes('summary="security finding 1"'));
    });

    it('reports mixed PASS and FAIL review-cycle attempts by non-test review type and status', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 2,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, api: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:mixed-code-pass',
            review_context_sha256: sha256Text('mixed-code-pass')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'api',
            reviewer_identity: 'agent:mixed-api-pass',
            review_context_sha256: sha256Text('mixed-api-pass')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'test',
            reviewer_identity: 'agent:mixed-test-pass',
            review_context_sha256: sha256Text('mixed-test-pass')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'code',
            reviewer_identity: 'agent:mixed-code-fail',
            review_context_sha256: sha256Text('mixed-code-fail'),
            summary: 'code failed'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.api, {
            total: 1,
            passed: 1,
            failed: 0,
            pending: 0
        });
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 2,
            passed: 1,
            failed: 1,
            pending: 0
        });
        assert.equal(result.review_cycle_block?.counts_by_review_type.test, undefined);
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'code failed');
        assert.ok(text.includes('"api": total=1; passed=1; failed=0; pending=0'));
        assert.ok(text.includes('"code": total=2; passed=1; failed=1; pending=0'));
    });

    it('counts a normal invocation and recorded review pair as one review cycle attempt', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const reviewContextSha256 = sha256Text('normal-code-context');
        const sharedDetails = {
            review_type: 'code',
            reviewer_identity: 'agent:normal-code',
            review_context_sha256: reviewContextSha256
        };
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', sharedDetails);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', sharedDetails);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
    });

    it('keeps scanning review-cycle timeline after total limit to report the latest failed review', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:early-stop-${index}`,
                review_context_sha256: sha256Text(`early-stop-context-${index}`)
            });
        }
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            review_type: 'code',
            reviewer_identity: 'agent:latest-failed-after-total-block',
            review_context_sha256: sha256Text('latest-failed-after-total-block')
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
            review_type: 'security',
            reviewer_identity: 'agent:latest-security-fail',
            review_context_sha256: sha256Text('latest-security-fail'),
            summary: 'latest failure after total threshold'
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            reviewer_identity: 'agent:malformed-after-block',
            review_context_sha256: sha256Text('malformed-after-block')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('total_non_test_review_count=4>1'));
        assert.equal(result.reason.includes('timeline_integrity'), false);
        assert.equal(result.review_cycle_block?.max_total_non_test_reviews, 1);
        assert.equal(result.review_cycle_block?.max_failed_non_test_reviews, 15);
        assert.equal(result.review_cycle_block?.latest_failed_review?.review_type, 'security');
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'latest failure after total threshold');
        assert.ok(formatNextStepText(result).includes('ReviewCycleLimits: max_total_non_test_reviews=1; max_failed_non_test_reviews=15'));
    });

    it('counts failed review records by reading review artifact verdict when timeline outcome only confirms recording success', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-security.md`);
        fs.writeFileSync(artifactPath, '# security review\n\nSECURITY REVIEW FAILED\n', 'utf8');
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'security',
                reviewer_identity: `agent:legacy-security-${index}`,
                review_context_sha256: sha256Text(`legacy-security-context-${index}`),
                review_artifact_path: artifactPath
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>1'));
    });

    it('does not block successful repeated review attempts when context hash is missing', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: 'agent:repeat-code'
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.review_cycle_block, null);
    });

    it('does not collapse repeated failed review attempts when reviewer identity is missing', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 15,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'security',
                review_context_sha256: sha256Text('repeat-security-context')
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=2>1'));
    });

    it('surfaces WARN_ONLY review cycle violations without blocking the next gate', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'WARN_ONLY',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test']
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 2; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'code',
                reviewer_identity: `agent:warn-code-${index}`,
                review_context_sha256: sha256Text(`warn-code-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate');
        assert.equal(result.warnings.length, 1);
        assert.ok(result.warnings[0].includes('Review cycle guard: WARN_ONLY'));
        assert.ok(result.warnings[0].includes('total_non_test_review_count=2>1'));
        assert.ok(text.includes('Warnings:'));
        assert.ok(text.includes('Review cycle guard: WARN_ONLY'));
    });

    it('does not block next-step when only excluded test review attempts exceed review cycle limits', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 1,
                    max_total_non_test_reviews: 1,
                    excluded_review_types: ['test']
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, test: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
                review_type: 'test',
                reviewer_identity: `agent:test-${index}`,
                review_context_sha256: sha256Text(`test-context-${index}`)
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
    });

    it('blocks next-step when review cycle timeline history is malformed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'INFO', {
            reviewer_identity: 'agent:missing-review-type',
            review_context_sha256: sha256Text('missing-review-type')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('timeline_integrity=1>0'));
    });

    it('blocks cumulative review churn across changing scope hashes', () => {
        const repoRoot = makeTempRepo();
        writeJson(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
            {
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                review_execution_policy: {
                    mode: 'code_first_optional'
                },
                review_cycle_guard: {
                    enabled: true,
                    action: 'BLOCK_FOR_OPERATOR_DECISION',
                    max_failed_non_test_reviews: 15,
                    max_total_non_test_reviews: 30,
                    excluded_review_types: ['test'],
                    auto_split_enabled: false
                }
            }
        );
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { includeDomainScopeFingerprints: true });
        const preflight = JSON.parse(fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8'));
        const currentCodeScopeSha256 = preflight.metrics.domain_scope_fingerprints.legacy.code_review_scope_sha256;
        const currentReviewScopeSha256 = preflight.metrics.domain_scope_fingerprints.legacy.review_scope_sha256;
        for (let index = 0; index < 48; index += 1) {
            const scopeBucket = index % 20;
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'code',
                reviewer_identity: `agent:t0043-code-${index}`,
                review_context_sha256: sha256Text(`t0043-code-context-${index}`),
                code_scope_sha256: scopeBucket === 0 ? currentCodeScopeSha256 : sha256Text(`t0043-scope-${scopeBucket}`),
                reused_existing_review: [5, 17, 31].includes(index),
                summary: `T-004-3 failed code review attempt ${index}`
            });
        }
        for (let index = 0; index < 6; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'FAIL', {
                review_type: 'test',
                reviewer_identity: `agent:t0043-test-${index}`,
                review_context_sha256: sha256Text(`t0043-test-context-${index}`),
                review_scope_sha256: currentReviewScopeSha256,
                summary: `T-004-3 excluded test review attempt ${index}`
            });
        }

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(result.reason.includes('failed_non_test_review_count=48>15'));
        assert.ok(result.reason.includes('total_non_test_review_count=48>30'));
        assert.ok(result.reason.includes('cumulative_total_attempts=54'));
        assert.ok(result.reason.includes('cumulative_non_test_reviews=48'));
        assert.ok(result.reason.includes('current_scope_non_test_reviews=3'));
        assert.ok(result.reason.includes('fresh_non_test_reviews=45'));
        assert.ok(result.reason.includes('reused_non_test_reviews=3'));
        assert.ok(result.reason.includes('fresh_reused_by_type=code:fresh=45,reused=3|test:fresh=6,reused=0'));
        assert.ok(result.reason.includes('top_scope_hashes_by_type=code:unique=20'));
        assert.equal(result.review_cycle_block?.cumulative_total_non_test_review_count, 48);
        assert.equal(result.review_cycle_block?.current_scope_total_non_test_review_count, 3);
        assert.equal(result.review_cycle_block?.fresh_non_test_review_count, 45);
        assert.equal(result.review_cycle_block?.reused_non_test_review_count, 3);
        assert.equal(result.review_cycle_block?.scope_hash_count_by_review_type.code, 20);
        assert.deepEqual(result.review_cycle_block?.current_scope_counts_by_review_type.code, {
            total: 3,
            passed: 0,
            failed: 3,
            pending: 0
        });
        assert.deepEqual(result.review_cycle_block?.counts_by_review_type.code, {
            total: 48,
            passed: 0,
            failed: 48,
            pending: 0
        });
        assert.equal(result.review_cycle_block?.counts_by_review_type.test, undefined);
        assert.equal(result.review_cycle_block?.latest_failed_review?.summary, 'T-004-3 failed code review attempt 47');
        assert.ok(text.includes('ReviewCycleCumulativeCounts: total_non_test_reviews=48; failed_non_test_reviews=48; fresh_non_test_reviews=45; reused_non_test_reviews=3'));
        assert.ok(text.includes('ReviewCycleCurrentScopeCounts: total_non_test_reviews=3; failed_non_test_reviews=3'));
        assert.ok(text.includes('"code": unique=20'));
    });

});
