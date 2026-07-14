import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getScopedDiffMetadataReadiness,
    readReviewArtifactState,
    readReviewTrust,
    reviewReceiptDomainScopeMatchesCurrentPreflight,
    scopedDiffExpectedForReview
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import { buildReviewReceipt } from '../../../../src/gate-runtime/review-context';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import { validateReviewFindingsContract } from '../../../../src/gates/review/review-findings-artifact-verdict';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse';
import type { ReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';

const TREE_STATE_SHA256 = 'b'.repeat(64);
const COVERAGE_CONTRACT_SHA256 = 'c'.repeat(64);
const SCOPE_SHA256 = 'd'.repeat(64);
const CHANGED_FILE = 'src/gates/next-step/next-step-review-artifact-readers.ts';

function tempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Json(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value, null, 2) + '\n').digest('hex');
}

function findingsPreflightPayload(): Record<string, unknown> {
    return {
        detection_source: 'git_auto',
        include_untracked: true,
        changed_files: [CHANGED_FILE],
        metrics: {
            scope_sha256: SCOPE_SHA256,
            changed_files_sha256: SCOPE_SHA256
        }
    };
}

function writeFindingsReviewPackage(options: {
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    report: Record<string, unknown>;
}): void {
    const contextPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-review-context.json`);
    const artifactPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const coverageContract: ReviewCoverageContract = {
        schema_version: 1,
        required: true,
        review_type: options.reviewType,
        obligations: [{ id: 'FILE-001', kind: 'file', target: CHANGED_FILE }],
        obligation_count: 1,
        contract_sha256: COVERAGE_CONTRACT_SHA256
    };
    const preflightPayload = findingsPreflightPayload();
    const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflightPayload, process.cwd()).review_scope_sha256;
    const codeScopeSha256 = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflightPayload,
        process.cwd()
    ).code_scope_sha256;
    writeJson(contextPath, {
        schema_version: 3,
        task_id: options.taskId,
        review_type: options.reviewType,
        preflight_path: options.preflightPath,
        preflight_sha256: null,
        tree_state: {
            tree_state_sha256: TREE_STATE_SHA256
        },
        coverage_contract: coverageContract
    });
    const contextSha256 = sha256File(contextPath);
    const report = {
        ...options.report,
        review_context_sha256: contextSha256,
        tree_state_sha256: TREE_STATE_SHA256,
        coverage_ledger: {
            coverage_contract_sha256: COVERAGE_CONTRACT_SHA256,
            ...(options.report.coverage_ledger as Record<string, unknown>)
        }
    };
    fs.writeFileSync(artifactPath, JSON.stringify(report, null, 2) + '\n');
    const artifactSha256 = sha256File(artifactPath);
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(artifactPath, 'utf8'),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    assert.equal(validation.valid, true, validation.violations.join(' '));
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath: contextPath,
        reviewContextSha256: contextSha256,
        preflightPath: options.preflightPath,
        preflightSha256: null,
        scopeSha256: SCOPE_SHA256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = sha256File(validationArtifactPath);
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: null,
        scopeSha256: SCOPE_SHA256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: TREE_STATE_SHA256,
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: `agent:${options.taskId}-${options.reviewType}`,
        trustLevel: 'INDEPENDENT_AUDITED'
    }) as unknown as Record<string, unknown>;
    receipt.review_output_sha256 = artifactSha256;
    receipt.review_coverage = validation.coverage_validation;
    receipt.review_findings_validation = {
        artifact_path: validationArtifactPath.replace(/\\/g, '/'),
        artifact_sha256: validationArtifactSha256,
        snapshot_path: null,
        snapshot_sha256: null,
        status: validationArtifact.validation_result.status,
        accepted: validationArtifact.validation_result.accepted,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        violation_count: validationArtifact.validation_result.violations.length
    };
    receipt.review_output_contract = {
        schema_version: 1,
        format: 'findings_json',
        report_sha256: sha256Json(validation.report),
        validation_artifact_sha256: validationArtifactSha256,
        validation_result_sha256: validationArtifact.validation_result_sha256,
        raw_output_sha256: artifactSha256,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: TREE_STATE_SHA256,
        coverage_contract_sha256: COVERAGE_CONTRACT_SHA256,
        reviewer_identity: `agent:${options.taskId}-${options.reviewType}`,
        reviewer_provenance_event_sha256: null
    };
    writeJson(path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`), receipt);
}

test('readReviewArtifactState reports missing review artifacts without route decisions', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        null
    );

    assert.equal(state.reviewType, 'code');
    assert.equal(state.ready, false);
    assert.equal(state.contextExists, false);
    assert.equal(state.artifactExists, false);
    assert.equal(state.receiptExists, false);
    assert.deepEqual(state.violations, [
        'review context artifact is missing',
        'review artifact is missing',
        'review receipt is missing'
    ]);
});

test('readReviewArtifactState derives pass state from findings JSON artifacts without legacy pass token', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'code',
        preflightPath,
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'code',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON artifact reader branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reader branch was covered.'
                    }],
                    finding_ids: []
                }]
            },
            findings: { critical: [], high: [], medium: [], low: [] },
            residual_risks: [],
            reviewer_notes: []
        }
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.verdictToken, 'REVIEW PASSED');
    assert.equal(state.failed, false);
    assert.ok(!state.violations.some((violation) => violation.includes('accepted pass token')));
});

test('readReviewArtifactState rejects legacy verdict tokens for current findings-only contexts', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-legacy-token-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    const contextPath = path.join(reviewsRoot, 'T-100-code-review-context.json');
    writeJson(contextPath, {
        schema_version: 3,
        task_id: 'T-100',
        review_type: 'code',
        tree_state: {
            tree_state_sha256: TREE_STATE_SHA256
        },
        coverage_contract: {
            schema_version: 1,
            required: true,
            review_type: 'code',
            obligations: [{ id: 'FILE-001', kind: 'file', target: 'src/gates/next-step/next-step-review-artifact-readers.ts' }],
            obligation_count: 1,
            contract_sha256: COVERAGE_CONTRACT_SHA256
        }
    });
    fs.writeFileSync(path.join(reviewsRoot, 'T-100-code.md'), [
        '# Review',
        '',
        'This current generated review context must not accept legacy verdict-token evidence.',
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        'REVIEW PASSED'
    ].join('\n'));

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.verdictToken, null);
    assert.ok(state.violations.some((violation) =>
        violation.includes('must be verdict-free findings JSON')
        && violation.includes('legacy PASS/FAIL verdict-token artifacts')
    ));
});

test('readReviewArtifactState treats active findings JSON artifacts as failed even without legacy fail token', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-failed-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    writeFindingsReviewPackage({
        reviewsRoot,
        taskId: 'T-100',
        reviewType: 'code',
        preflightPath,
        report: {
            schema_version: 1,
            task_id: 'T-100',
            review_type: 'code',
            validation_notes: [{
                id: 'N-001',
                topic: 'scope',
                note: 'Reviewed the JSON artifact reader failed-state path.',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The findings JSON active finding branch was inspected.'
                }]
            }],
            coverage_ledger: {
                entries: [{
                    obligation_id: 'FILE-001',
                    evidence: [{
                        location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                        observation: 'The reader branch was covered.'
                    }],
                    finding_ids: ['F-001']
                }]
            },
            findings: {
                critical: [],
                high: [
                    {
                        id: 'F-001',
                        title: 'Downstream reader failure',
                        description: 'The downstream reader must surface this active finding.',
                        evidence: [
                            {
                                location: 'src/gates/next-step/next-step-review-artifact-readers.ts:140',
                                observation: 'JSON active findings are mapped to failed review state.'
                            }
                        ],
                        coverage_obligation_ids: ['FILE-001']
                    }
                ],
                medium: [],
                low: []
            },
            residual_risks: [],
            reviewer_notes: []
        }
    });

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        null
    );

    assert.equal(state.verdictToken, 'CODE REVIEW FAILED');
    assert.equal(state.failed, true);
    assert.ok(state.violations.some((violation) => violation.includes('validation artifact contains active findings')));
});

test('readReviewArtifactState rejects malformed findings JSON instead of deriving a clean pass', () => {
    const reviewsRoot = tempRoot('garda-next-step-review-json-invalid-readers-');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');
    const contextPath = path.join(reviewsRoot, 'T-100-code-review-context.json');
    const artifactPath = path.join(reviewsRoot, 'T-100-code.md');
    const coverageContract: ReviewCoverageContract = {
        schema_version: 1,
        required: true,
        review_type: 'code',
        obligations: [{ id: 'FILE-001', kind: 'file', target: 'src/gates/next-step/next-step-review-artifact-readers.ts' }],
        obligation_count: 1,
        contract_sha256: COVERAGE_CONTRACT_SHA256
    };
    writeJson(contextPath, {
        schema_version: 3,
        task_id: 'T-100',
        review_type: 'code',
        preflight_path: preflightPath,
        preflight_sha256: null,
        tree_state: {
            tree_state_sha256: TREE_STATE_SHA256
        },
        coverage_contract: coverageContract
    });
    const contextSha256 = sha256File(contextPath);
    fs.writeFileSync(artifactPath, JSON.stringify({
        schema_version: 1,
        task_id: 'T-100',
        review_type: 'code',
        review_context_sha256: contextSha256,
        tree_state_sha256: TREE_STATE_SHA256,
        validation_notes: [],
        coverage_ledger: {
            coverage_contract_sha256: COVERAGE_CONTRACT_SHA256,
            entries: [{
                obligation_id: 'FILE-001',
                evidence: [{
                    location: 'src/gates/next-step/next-step-review-artifact-readers.ts:250',
                    observation: 'The invalid findings JSON branch was inspected.'
                }],
                finding_ids: []
            }]
        },
        findings: { critical: [], high: [], medium: [], low: [] },
        residual_risks: [],
        reviewer_notes: []
    }, null, 2) + '\n');
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(artifactPath, 'utf8'),
        expectedTaskId: 'T-100',
        expectedReviewType: 'code',
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    assert.equal(validation.valid, false);
    const rejectedValidationArtifact = buildReviewFindingsValidationArtifact({
        taskId: 'T-100',
        reviewType: 'code',
        validation,
        reviewOutputSha256: sha256File(artifactPath),
        reviewArtifactPath: artifactPath,
        reviewArtifactSha256: null,
        reviewContextPath: contextPath,
        reviewContextSha256: contextSha256,
        preflightPath,
        preflightSha256: null,
        scopeSha256: SCOPE_SHA256,
        reviewScopeSha256: null,
        codeScopeSha256: null,
        reviewTreeStateSha256: TREE_STATE_SHA256,
        coverageContract
    });
    writeJson(getReviewFindingsValidationArtifactPath(artifactPath), rejectedValidationArtifact);

    const state = readReviewArtifactState(
        reviewsRoot,
        'T-100',
        'code',
        preflightPath,
        null,
        findingsPreflightPayload()
    );

    assert.equal(state.verdictToken, null);
    assert.ok(state.violations.some((violation) => violation.includes('review findings validation artifact is rejected')));
});

test('getScopedDiffMetadataReadiness rejects missing and empty scoped diff metadata', () => {
    const reviewsRoot = tempRoot('garda-next-step-scoped-readers-');
    const metadataPath = path.join(reviewsRoot, 'T-100-code-scoped.json');
    const preflightPath = path.join(reviewsRoot, 'T-100-preflight.json');

    const missing = getScopedDiffMetadataReadiness({
        metadataPath,
        preflight: null,
        preflightPath,
        preflightSha256: null,
        reviewType: 'code'
    });
    assert.equal(missing.ready, false);
    assert.match(missing.reason, /Scoped diff metadata is missing/);

    fs.writeFileSync(metadataPath, JSON.stringify({ output_diff_line_count: 0 }));
    const empty = getScopedDiffMetadataReadiness({
        metadataPath,
        preflight: null,
        preflightPath,
        preflightSha256: null,
        reviewType: 'code'
    });
    assert.equal(empty.ready, false);
    assert.match(empty.reason, /has no output diff lines/);
});

test('review receipt domain matching fails closed for mismatched review type or missing scope', () => {
    assert.equal(reviewReceiptDomainScopeMatchesCurrentPreflight(
        { review_type: 'code' },
        { review_type: 'test' },
        { metrics: {} }
    ), false);
    assert.equal(reviewReceiptDomainScopeMatchesCurrentPreflight(
        { review_type: 'code' },
        null,
        { metrics: {} }
    ), false);
});

test('reader helpers expose scoped diff expectation and trust summary surfaces', () => {
    const reviewsRoot = tempRoot('garda-next-step-trust-readers-');
    assert.equal(scopedDiffExpectedForReview({ preflight: null, reviewType: 'code' }), false);

    const summary = readReviewTrust(reviewsRoot, 'T-100', ['code'], 'mixed');
    assert.ok(summary);
    assert.equal(summary.status, 'UNAVAILABLE');
});
