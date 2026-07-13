import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    detectZeroDiffFromPreflight,
    parseSkipReviews,
    resolveExpectedReviewVerdicts,
    REVIEW_CONTRACTS,
    testExpectedVerdict,
    validateZeroDiffForReviewGate
} from '../../../../src/gates/required-reviews/required-reviews-check';
import {
    testReviewArtifacts
} from '../../../../src/cli/commands/gate-flows/review/review-flow-support';

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

describe('gates/required-reviews-check core helpers', () => {
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
            const reviewContext = {
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
            };
            const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
            fs.writeFileSync(reviewContextPath, `${JSON.stringify(reviewContext, null, 2)}\n`, 'utf8');
            const reviewContextSha256 = createHash('sha256').update(fs.readFileSync(reviewContextPath)).digest('hex');

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
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-${reviewType}.md`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');

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
