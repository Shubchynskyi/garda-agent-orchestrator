import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    detectZeroDiffFromPreflight,
    checkRequiredReviews,
    parseSkipReviews,
    resolveExpectedReviewVerdicts,
    REVIEW_CONTRACTS,
    testExpectedVerdict,
    validateZeroDiffForReviewGate
} from '../../../../src/gates/required-reviews/required-reviews-check';
import {
    testReviewArtifacts
} from '../../../../src/cli/commands/gate-flows/review/review-flow-support';
import { runRequiredReviewsCheckCommand } from '../../../../src/cli/commands/gates';
import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { normalizeReviewCatalog } from '../../../../src/core/review-catalog';
import { compileReviewDependencyGraph } from '../../../../src/core/review-dependency-graph';
import type { ReviewCapabilitiesConfigMap } from '../../../../src/core/review-capabilities';
import { buildEffectiveReviewSnapshot } from '../../../../src/policy/effective-review-snapshot';
import { resolveProfileReviewCatalogPolicy } from '../../../../src/policy/profile-review-catalog-policy';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath
} from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    validateReviewFindingsContract
} from '../../../../src/gates/review/review-findings-artifact-verdict';

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256File(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, value: unknown): void {
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeAcceptedFindingsValidationReceipt(options: {
    artifactPath: string;
    contextPath: string;
    taskId: string;
    reviewType: string;
    treeStateSha256: string;
    coverageContract: Record<string, unknown>;
}): void {
    const artifactSha256 = sha256File(options.artifactPath);
    const contextSha256 = sha256File(options.contextPath);
    const validation = validateReviewFindingsContract({
        content: fs.readFileSync(options.artifactPath, 'utf8'),
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: contextSha256,
        expectedTreeStateSha256: options.treeStateSha256,
        coverageContract: options.coverageContract as never
    });
    assert.equal(validation.valid, true, validation.violations.join(' '));
    const validationArtifactPath = getReviewFindingsValidationArtifactPath(options.artifactPath);
    const validationArtifact = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation,
        reviewOutputSha256: artifactSha256,
        reviewArtifactPath: options.artifactPath,
        reviewArtifactSha256: artifactSha256,
        reviewContextPath: options.contextPath,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: options.treeStateSha256,
        coverageContract: options.coverageContract as never
    });
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = sha256File(validationArtifactPath);
    writeJson(options.artifactPath.replace(/\.md$/u, '-receipt.json'), {
        task_id: options.taskId,
        review_type: options.reviewType,
        review_output_sha256: artifactSha256,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: options.treeStateSha256,
        review_findings_validation: {
            artifact_path: validationArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: validationArtifactSha256,
            snapshot_path: null,
            snapshot_sha256: null,
            status: validationArtifact.validation_result.status,
            accepted: validationArtifact.validation_result.accepted,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            violation_count: validationArtifact.validation_result.violations.length
        }
    });
}

function buildMissingFocusedValidationReport(options: {
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    treeStateSha256: string;
    coverageContract: Record<string, unknown>;
}): Record<string, unknown> {
    const obligations = Array.isArray(options.coverageContract.obligations)
        ? options.coverageContract.obligations as Array<Record<string, unknown>>
        : [];
    const obligationIds = obligations
        .map((obligation) => String(obligation.id || '').trim())
        .filter(Boolean);
    const marker = '[garda:evidence-only:missing-focused-validation] test=tests/node/focused-validation.test.ts; action=run-and-record-focused-test';
    return {
        schema_version: 1,
        task_id: options.taskId,
        review_type: options.reviewType,
        review_context_sha256: options.reviewContextSha256,
        tree_state_sha256: options.treeStateSha256,
        validation_notes: [
            {
                id: 'N-001',
                topic: 'missing-focused-validation',
                note: 'Reviewed the in-scope changed file and found the canonical missing focused-validation evidence marker.',
                evidence: [
                    {
                        location: 'src/example.ts:1',
                        observation: 'Scoped changed file evidence for the missing focused-validation marker.'
                    }
                ]
            },
            {
                id: 'N-002',
                topic: 'focused-self-validation',
                note: 'The reviewer attempted the smallest relevant focused test before reporting missing validation evidence.',
                command: 'node --test tests/node/focused-validation.test.ts',
                command_outcome: 'unavailable',
                diagnostics: 'The focused test target is unavailable in this isolated fixture, so the command could not execute.',
                evidence: [
                    {
                        location: 'src/example.ts:1',
                        observation: 'The changed example path is the behavior targeted by tests/node/focused-validation.test.ts, which motivated the unavailable focused test.'
                    }
                ]
            }
        ],
        coverage_ledger: {
            coverage_contract_sha256: options.coverageContract.contract_sha256,
            entries: obligationIds.map((obligationId) => ({
                obligation_id: obligationId,
                evidence: [
                    {
                        location: 'src/example.ts:1',
                        observation: `Obligation ${obligationId} is blocked by missing focused-validation evidence.`
                    }
                ],
                finding_ids: ['F-000']
            }))
        },
        findings: {
            critical: [],
            high: [],
            medium: [
                {
                    id: 'F-000',
                    title: marker,
                    description: 'Focused validation evidence is missing for the assigned current review scope.',
                    evidence: [
                        {
                            location: 'src/example.ts:1',
                            observation: 'No focused-validation evidence was available for this scoped change.'
                        }
                    ],
                    coverage_obligation_ids: obligationIds
                }
            ],
            low: []
        },
        residual_risks: [],
        reviewer_notes: ['This is the canonical evidence-only missing focused-validation marker.']
    };
}

describe('gates/required-reviews-check core helpers', () => {
    it('rejects a forged tiny-change override when a custom review lane is required', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'required-review-custom-override-'));
        try {
            const taskId = 'T-custom-review-override';
            const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
            const configDir = path.join(orchestratorRoot, 'live', 'config');
            const reviewsDir = path.join(orchestratorRoot, 'runtime', 'reviews');
            fs.mkdirSync(configDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const catalogConfig = {
                version: 1,
                custom_review_types: [{
                    id: 'architecture-boundary',
                    display_label: 'Architecture boundary review',
                    enabled_by_default: false,
                    skill_id: 'code-review',
                    trigger: { mode: 'manual' },
                    coverage_category_ids: ['maintainability'],
                    reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['boundaries'] }
                }]
            };
            fs.writeFileSync(
                path.join(configDir, 'review-catalog.json'),
                `${JSON.stringify(catalogConfig, null, 2)}\n`,
                'utf8'
            );

            const catalog = normalizeReviewCatalog(catalogConfig);
            const capabilities = Object.fromEntries(
                catalog.review_types.map(({ id }) => [id, true])
            ) as ReviewCapabilitiesConfigMap;
            const profilePolicy = resolveProfileReviewCatalogPolicy(
                'balanced',
                { code: true, 'architecture-boundary': true },
                capabilities,
                catalog
            );
            const profileSnapshotSha256 = 'a'.repeat(64);
            const snapshot = buildEffectiveReviewSnapshot({
                catalog,
                profilePolicy,
                profileSnapshotSha256,
                legacyRequiredReviews: Object.fromEntries(
                    catalog.review_types.map(({ id }) => [id, id === 'code'])
                ),
                scopeCategory: 'code',
                taskIntent: 'Exercise the custom review override guard',
                changedFiles: ['src/app.ts'],
                taskTriggers: {}
            });
            const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
            writeJson(preflightPath, {
                task_id: taskId,
                mode: 'FULL_PATH',
                metrics: { changed_lines_total: 1 },
                changed_files: ['src/app.ts'],
                required_reviews: snapshot.required_reviews,
                profile_policy_snapshot: { snapshot_hash: profileSnapshotSha256 },
                effective_review_snapshot: snapshot
            });

            const result = runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath,
                skipReviews: 'code',
                skipReason: 'Regression coverage for a required custom review lane.',
                emitMetrics: false
            });

            assert.equal(result.exitCode, EXIT_GATE_FAILURE);
            assert.ok(result.outputLines.some((line) => line.includes(
                'Code review override is not allowed for this change scope.'
            )), result.outputLines.join('\n'));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    describe('parseSkipReviews', () => {
        it('parses comma-separated list', () => {
            assert.deepEqual(parseSkipReviews('code,db,security'), ['code', 'db', 'security']);
        });
        it('parses semicolon-separated list', () => {
            assert.deepEqual(parseSkipReviews('code;db'), ['code', 'db']);
        });
        it('returns empty for empty input', () => {
            assert.deepEqual(parseSkipReviews(''), []);
            assert.deepEqual(parseSkipReviews(null), []);
        });
        it('deduplicates and sorts', () => {
            assert.deepEqual(parseSkipReviews('db,db,api'), ['api', 'db']);
        });
        it('lowercases', () => {
            assert.deepEqual(parseSkipReviews('CODE,DB'), ['code', 'db']);
        });
    });

    describe('resolveExpectedReviewVerdicts', () => {
        it('normalizes explicit verdict aliases to canonical review tokens', () => {
            const verdicts = resolveExpectedReviewVerdicts(
                {
                    code: true,
                    db: true
                },
                {
                    code: 'CODE REVIEW PASSED',
                    db: 'DB REVIEW FAILED'
                }
            );

            assert.equal(verdicts.code, 'REVIEW PASSED');
            assert.equal(verdicts.db, 'DB REVIEW FAILED');
        });

        it('does not normalize generic verdict aliases for typed review contracts', () => {
            const verdicts = resolveExpectedReviewVerdicts(
                {
                    security: true
                },
                {
                    security: 'REVIEW PASSED'
                }
            );

            assert.equal(verdicts.security, 'REVIEW PASSED');
        });
    });

    describe('testExpectedVerdict', () => {
        it('adds error when required review not passed', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, false, 'NOT_REQUIRED', 'REVIEW PASSED');
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes("is required"));
        });

        it('accepts pass when required', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, false, 'REVIEW PASSED', 'REVIEW PASSED');
            assert.equal(errors.length, 0);
        });

        it('accepts NOT_REQUIRED when not required', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'api'", false, false, 'NOT_REQUIRED', 'API REVIEW PASSED');
            assert.equal(errors.length, 0);
        });

        it('accepts SKIPPED_BY_OVERRIDE when overridden', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, true, 'SKIPPED_BY_OVERRIDE', 'REVIEW PASSED');
            assert.equal(errors.length, 0);
        });

        it('rejects unexpected verdict when overridden', () => {
            const errors: string[] = [];
            testExpectedVerdict(errors, "Review 'code'", true, true, 'FAILED', 'REVIEW PASSED');
            assert.equal(errors.length, 1);
            assert.ok(errors[0].includes('override'));
        });
    });

    describe('REVIEW_CONTRACTS', () => {
        it('has 9 review types', () => {
            assert.equal(REVIEW_CONTRACTS.length, 9);
        });
        it('includes code, db, security, refactor, api, test, performance, infra, dependency', () => {
            const types = REVIEW_CONTRACTS.map(([key]) => key);
            assert.ok(types.includes('code'));
            assert.ok(types.includes('db'));
            assert.ok(types.includes('security'));
            assert.ok(types.includes('refactor'));
            assert.ok(types.includes('api'));
            assert.ok(types.includes('test'));
            assert.ok(types.includes('performance'));
            assert.ok(types.includes('infra'));
            assert.ok(types.includes('dependency'));
        });
        it('has matching pass tokens per review', () => {
            const codeContract = REVIEW_CONTRACTS.find(([k]) => k === 'code');
            assert.equal(codeContract![1], 'REVIEW PASSED');
            const dbContract = REVIEW_CONTRACTS.find(([k]) => k === 'db');
            assert.equal(dbContract![1], 'DB REVIEW PASSED');
        });
    });

    describe('testReviewArtifacts', () => {
        it('accepts verdict-free findings JSON pass artifacts without a legacy pass token', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-reviews-json-'));
            const reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
            fs.mkdirSync(reviewsRoot, { recursive: true });

            const taskId = 'T-979';
            const reviewType = 'code';
            const treeStateSha256 = sha256Text('tree-state');
            const coverageContractSha256 = sha256Text('coverage-contract');
            const coverageContract = {
                schema_version: 1,
                required: true,
                review_type: reviewType,
                obligations: [
                    {
                        id: 'FILE-001',
                        kind: 'file',
                        target: 'src/example.ts'
                    }
                ],
                obligation_count: 1,
                contract_sha256: coverageContractSha256
            };
            const reviewContext = {
                schema_version: 3,
                task_id: taskId,
                review_type: reviewType,
                tree_state: {
                    tree_state_sha256: treeStateSha256
                },
                coverage_contract: coverageContract
            };
            const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
            writeJson(reviewContextPath, reviewContext);
            const reviewContextSha256 = sha256File(reviewContextPath);

            const report = {
                schema_version: 1,
                task_id: taskId,
                review_type: reviewType,
                review_context_sha256: reviewContextSha256,
                tree_state_sha256: treeStateSha256,
                validation_notes: [
                    {
                        id: 'N-001',
                        topic: 'scope',
                        note: 'Reviewed src/example.ts and the JSON review artifact gate path.',
                        evidence: [
                            {
                                location: 'src/example.ts:1',
                                observation: 'Scoped changed file was reviewed.'
                            }
                        ]
                    }
                ],
                coverage_ledger: {
                    coverage_contract_sha256: coverageContractSha256,
                    entries: [
                        {
                            obligation_id: 'FILE-001',
                            evidence: [
                                {
                                    location: 'src/example.ts:1',
                                    observation: 'No defect found for this obligation.'
                                }
                            ],
                            finding_ids: []
                        }
                    ]
                },
                findings: {
                    critical: [],
                    high: [],
                    medium: [],
                    low: []
                },
                residual_risks: [],
                reviewer_notes: ['No active findings.']
            };
            const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
            writeJson(artifactPath, report);
            writeAcceptedFindingsValidationReceipt({
                artifactPath,
                contextPath: reviewContextPath,
                taskId,
                reviewType,
                treeStateSha256,
                coverageContract
            });

            const result = testReviewArtifacts(
                repoRoot,
                taskId,
                { code: true },
                { code: 'REVIEW PASSED' },
                [],
                'runtime/reviews'
            );

            assert.deepEqual(result.violations, []);
            assert.equal(result.checked[0]?.token_found, true);
        });

        it('accepts evidence-only missing-focused-validation when there are no real findings', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-reviews-missing-focused-'));
            try {
                const reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
                fs.mkdirSync(reviewsRoot, { recursive: true });

                const taskId = 'T-979-missing-focused';
                const reviewType = 'code';
                const treeStateSha256 = sha256Text('tree-state');
                const coverageContractSha256 = sha256Text('coverage-contract');
                const coverageContract = {
                    schema_version: 1,
                    required: true,
                    review_type: reviewType,
                    obligations: [
                        {
                            id: 'FILE-001',
                            kind: 'file',
                            target: 'src/example.ts'
                        }
                    ],
                    obligation_count: 1,
                    contract_sha256: coverageContractSha256
                };
                const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
                writeJson(preflightPath, {
                    task_id: taskId,
                    profile_policy_snapshot: {
                        review_finding_policy: {
                            schema_version: 1,
                            policy_id: 'balanced',
                            findings: {
                                critical: 'fix_now',
                                high: 'fix_now',
                                medium: 'create_follow_up',
                                low: 'create_follow_up'
                            },
                            residual_risk: 'create_follow_up'
                        }
                    }
                });
                const reviewContext = {
                    schema_version: 3,
                    task_id: taskId,
                    review_type: reviewType,
                    preflight_path: preflightPath,
                    tree_state: {
                        tree_state_sha256: treeStateSha256
                    },
                    coverage_contract: coverageContract
                };
                const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
                writeJson(reviewContextPath, reviewContext);
                const reviewContextSha256 = sha256File(reviewContextPath);
                const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
                writeJson(artifactPath, buildMissingFocusedValidationReport({
                    taskId,
                    reviewType,
                    reviewContextSha256,
                    treeStateSha256,
                    coverageContract
                }));
                writeAcceptedFindingsValidationReceipt({
                    artifactPath,
                    contextPath: reviewContextPath,
                    taskId,
                    reviewType,
                    treeStateSha256,
                    coverageContract
                });

                const result = testReviewArtifacts(
                    repoRoot,
                    taskId,
                    { code: true },
                    { code: 'REVIEW PASSED' },
                    [],
                    'runtime/reviews'
                );

                assert.equal(result.checked[0]?.token_found, true, result.violations.join('\n'));
                assert.deepEqual(result.violations, []);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });

        it('rejects legacy pass-token artifacts for current findings-only review contexts', () => {
            const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-reviews-legacy-token-'));
            try {
                const reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
                fs.mkdirSync(reviewsRoot, { recursive: true });

                const taskId = 'T-979-5';
                const reviewType = 'code';
                const treeStateSha256 = sha256Text('tree-state');
                const coverageContractSha256 = sha256Text('coverage-contract');
                fs.writeFileSync(path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`), `${JSON.stringify({
                    schema_version: 3,
                    task_id: taskId,
                    review_type: reviewType,
                    tree_state: {
                        tree_state_sha256: treeStateSha256
                    },
                    coverage_contract: {
                        schema_version: 1,
                        required: true,
                        review_type: reviewType,
                        obligations: [
                            {
                                id: 'FILE-001',
                                kind: 'file',
                                target: 'src/example.ts'
                            }
                        ],
                        obligation_count: 1,
                        contract_sha256: coverageContractSha256
                    }
                }, null, 2)}\n`, 'utf8');
                fs.writeFileSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`), [
                    '# Review',
                    '',
                    'This artifact is bound to a current review context but still uses legacy verdict-token evidence.',
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

                const result = testReviewArtifacts(
                    repoRoot,
                    taskId,
                    { code: true },
                    { code: 'REVIEW PASSED' },
                    [],
                    'runtime/reviews'
                );

                assert.equal(result.checked[0]?.token_found, false);
                assert.ok(result.violations.some((violation) =>
                    violation.includes('must be verdict-free findings JSON')
                    && violation.includes('legacy PASS/FAIL verdict-token artifacts')
                ), result.violations.join('\n'));
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    });

    describe('detectZeroDiffFromPreflight', () => {
        it('returns true for zero-diff preflight with guard block', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0, changed_files_count: 0 },
                zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), true);
        });

        it('returns true for zero-diff preflight without guard block', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), true);
        });

        it('returns false when changed files exist', () => {
            const preflight = {
                changed_files: ['src/index.ts'],
                metrics: { changed_lines_total: 10 },
                zero_diff_guard: { zero_diff_detected: false, status: 'DIFF_PRESENT' }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), false);
        });

        it('returns false when guard explicitly says false even with zero metrics', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                zero_diff_guard: { zero_diff_detected: false, status: 'DIFF_PRESENT' }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), false);
        });

        it('returns false for null preflight', () => {
            assert.equal(detectZeroDiffFromPreflight(null), false);
        });

        it('returns false when only changed_lines_total is non-zero', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 5 }
            };
            assert.equal(detectZeroDiffFromPreflight(preflight), false);
        });
    });

    it('fails the review gate when a custom downstream lane started before its frozen graph dependency passed', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-review-graph-order-'));
        const reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
        const eventsRoot = path.join(repoRoot, 'runtime', 'task-events');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(eventsRoot, { recursive: true });
        const taskId = 'T-729-5C-required-order';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewDependencyGraph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary', 'test'],
            activeLaneIds: ['code', 'architecture-boundary', 'test'],
            requiredReviewIds: ['code', 'architecture-boundary', 'test'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary', 'test'],
                dependencies: {
                    'architecture-boundary': ['code'],
                    test: ['architecture-boundary']
                }
            }
        });
        const preflightPayload = {
            task_id: taskId,
            required_reviews: { code: true, 'architecture-boundary': true, test: true },
            review_execution_policy: {
                mode: 'parallel_all',
                dependency_graph: reviewDependencyGraph
            },
            effective_review_snapshot: {
                review_dependency_graph: reviewDependencyGraph
            }
        };
        writeJson(preflightPath, preflightPayload);
        fs.writeFileSync(path.join(eventsRoot, `${taskId}.jsonl`), [
            { event_type: 'COMPILE_GATE_PASSED', details: {} },
            { event_type: 'REVIEW_PHASE_STARTED', details: { review_type: 'architecture-boundary' } },
            { event_type: 'REVIEW_RECORDED', details: { review_type: 'code' } },
            { event_type: 'REVIEW_PHASE_STARTED', details: { review_type: 'test' } },
            { event_type: 'REVIEW_RECORDED', details: { review_type: 'architecture-boundary' } }
        ].map((event) => JSON.stringify(event)).join('\n'), 'utf8');

        const result = checkRequiredReviews({
            validatedPreflight: {
                errors: [],
                resolved_task_id: taskId,
                required_reviews: preflightPayload.required_reviews,
                review_contracts: [
                    ['code', 'CODE REVIEW PASSED'],
                    ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED'],
                    ['test', 'TEST REVIEW PASSED']
                ],
                preflight_path: preflightPath,
                preflight_hash: sha256File(preflightPath)
            },
            verdicts: {
                code: 'CODE REVIEW PASSED',
                'architecture-boundary': 'ARCHITECTURE BOUNDARY REVIEW PASSED',
                test: 'TEST REVIEW PASSED'
            },
            preflightPayload
        });

        assert.equal(result.status, 'FAILED');
        assert.equal(result.review_dependency_graph_sha256, reviewDependencyGraph.graph_sha256);
        assert.ok(result.violations.some((violation) => (
            violation.includes("Required review 'architecture-boundary' started before upstream review 'code' completed")
        )));
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses task sequence instead of JSONL line order for custom dependency enforcement', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-required-review-task-sequence-'));
        const reviewsRoot = path.join(repoRoot, 'runtime', 'reviews');
        const eventsRoot = path.join(repoRoot, 'runtime', 'task-events');
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(eventsRoot, { recursive: true });
        const taskId = 'T-729-5C-required-sequence';
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const reviewDependencyGraph = compileReviewDependencyGraph({
            catalogLaneIds: ['code', 'architecture-boundary'],
            activeLaneIds: ['code', 'architecture-boundary'],
            requiredReviewIds: ['code', 'architecture-boundary'],
            mode: 'parallel_all',
            declaration: {
                preparation_order: ['code', 'architecture-boundary'],
                dependencies: { 'architecture-boundary': ['code'] }
            }
        });
        const preflightPayload = {
            task_id: taskId,
            required_reviews: { code: true, 'architecture-boundary': true },
            review_execution_policy: {
                mode: 'parallel_all',
                dependency_graph: reviewDependencyGraph
            },
            effective_review_snapshot: {
                review_dependency_graph: reviewDependencyGraph
            }
        };
        writeJson(preflightPath, preflightPayload);
        fs.writeFileSync(path.join(eventsRoot, `${taskId}.jsonl`), [
            {
                event_type: 'COMPILE_GATE_PASSED',
                details: {},
                integrity: {
                    schema_version: 1,
                    task_sequence: 1,
                    prev_event_sha256: null,
                    event_sha256: 'a'.repeat(64)
                }
            },
            {
                event_type: 'REVIEW_RECORDED',
                details: { review_type: 'code' },
                integrity: {
                    schema_version: 1,
                    task_sequence: 4,
                    prev_event_sha256: 'a'.repeat(64),
                    event_sha256: 'b'.repeat(64)
                }
            },
            {
                event_type: 'REVIEW_PHASE_STARTED',
                details: { review_type: 'architecture-boundary' },
                integrity: {
                    schema_version: 1,
                    task_sequence: 3,
                    prev_event_sha256: 'b'.repeat(64),
                    event_sha256: 'c'.repeat(64)
                }
            }
        ].map((event) => JSON.stringify(event)).join('\n'), 'utf8');

        const result = checkRequiredReviews({
            validatedPreflight: {
                errors: [],
                resolved_task_id: taskId,
                required_reviews: preflightPayload.required_reviews,
                review_contracts: [
                    ['code', 'CODE REVIEW PASSED'],
                    ['architecture-boundary', 'ARCHITECTURE BOUNDARY REVIEW PASSED']
                ],
                preflight_path: preflightPath,
                preflight_hash: sha256File(preflightPath)
            },
            verdicts: {
                code: 'CODE REVIEW PASSED',
                'architecture-boundary': 'ARCHITECTURE BOUNDARY REVIEW PASSED'
            },
            preflightPayload
        });

        assert.equal(result.status, 'FAILED');
        assert.ok(result.violations.some((violation) => (
            violation.includes("Required review 'architecture-boundary' started before upstream review 'code' completed")
        )));
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    describe('validateZeroDiffForReviewGate', () => {
        it('returns NOT_APPLICABLE when diff is present', () => {
            const preflight = {
                changed_files: ['src/index.ts'],
                metrics: { changed_lines_total: 10 }
            };
            const result = validateZeroDiffForReviewGate(preflight, 'T-902', '/nonexistent-repo');
            assert.equal(result.zero_diff_detected, false);
            assert.equal(result.status, 'NOT_APPLICABLE');
            assert.equal(result.violations.length, 0);
        });

        it('returns REQUIRES_DIFF_OR_NO_OP when zero-diff without no-op artifact', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 },
                zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            };
            const result = validateZeroDiffForReviewGate(preflight, 'T-902', '/nonexistent-repo');
            assert.equal(result.zero_diff_detected, true);
            assert.equal(result.status, 'REQUIRES_DIFF_OR_NO_OP');
            assert.equal(result.violations.length, 1);
            assert.ok(result.violations[0].includes('zero-diff'));
            assert.ok(result.violations[0].includes('T-902'));
        });

        it('violation message includes remediation options', () => {
            const preflight = {
                changed_files: [],
                metrics: { changed_lines_total: 0 }
            };
            const result = validateZeroDiffForReviewGate(preflight, 'T-099', '/nonexistent-repo');
            assert.ok(result.violations[0].includes('record-no-op'));
            assert.ok(result.violations[0].includes('BLOCKED'));
        });
    });
});
