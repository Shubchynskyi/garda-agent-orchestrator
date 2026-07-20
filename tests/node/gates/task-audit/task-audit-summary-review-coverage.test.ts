import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { buildReviewCoverageAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-coverage';
import { buildReviewCoverageContract } from '../../../../src/gates/review/review-coverage-ledger';

test('review coverage audit exposes complete and omitted obligation diagnostics', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-audit-'));
    const taskId = 'T-976-audit';
    const contract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: ['src/example.ts'] });
    const omittedId = contract.obligations[1].id;
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['src/example.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), JSON.stringify({
        review_coverage: {
            status: 'FAIL',
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count - 1,
            omitted_obligation_ids: [omittedId],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: ['F-001']
        }
    }), 'utf8');

    const incomplete = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(incomplete.status, 'INCOMPLETE');
    assert.deepEqual(incomplete.omitted_obligation_ids, [`code:${omittedId}`]);
    assert.match(incomplete.visible_summary_line, new RegExp(`obligations=${contract.obligation_count - 1}\\/${contract.obligation_count}`));
    assert.match(incomplete.visible_summary_line, new RegExp(`omitted=code:${omittedId}`));
    assert.ok(incomplete.entries[0]?.violations.includes('receipt coverage status is not PASS'));

    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: ['F-001', 'F-002']
        }
    }), 'utf8');
    const complete = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(complete.status, 'COMPLETE');
    assert.match(complete.visible_summary_line, new RegExp(`obligations=${contract.obligation_count}\\/${contract.obligation_count}`));

    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: 'forged',
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');
    const mismatched = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(mismatched.status, 'INCOMPLETE');
    assert.ok(mismatched.entries[0]?.violations.includes('receipt coverage contract hash mismatch'));

    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit accepts a current contract whose ledger is not required', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-not-required-'));
    const taskId = 'T-979-coverage-not-required';
    const contract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['tests/example.test.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), JSON.stringify({
        review_coverage: {
            status: 'PASS',
            required: false,
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: [],
            finding_ids: []
        }
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'COMPLETE');
    assert.deepEqual(summary.omitted_obligation_ids, []);
    assert.deepEqual(summary.entries[0]?.violations, []);
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit preserves legacy context compatibility', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-legacy-'));
    const taskId = 'T-976-legacy';
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    const preflightText = JSON.stringify({ changed_files: ['src/example.ts'] });
    const contextText = JSON.stringify({
        schema_version: 2
    });
    fs.writeFileSync(preflightPath, preflightText, 'utf8');
    fs.writeFileSync(contextPath, contextText, 'utf8');
    const preflightSha256 = createHash('sha256').update(preflightText).digest('hex');
    const contextSha256 = createHash('sha256').update(contextText).digest('hex');
    fs.writeFileSync(receiptPath, JSON.stringify({
        preflight_sha256: preflightSha256,
        review_context_sha256: contextSha256
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true },
        orderedEvents: [{
            event_type: 'REVIEW_RECORDED',
            details: {
                review_type: 'code',
                preflight_sha256: preflightSha256,
                review_context_sha256: contextSha256
            }
        }]
    });
    assert.equal(summary.status, 'COMPLETE');
    assert.equal(summary.entries[0]?.status, 'LEGACY_NOT_REQUIRED');

    fs.writeFileSync(contextPath, JSON.stringify({ schema_version: 1 }), 'utf8');
    const downgraded = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true },
        orderedEvents: []
    });
    assert.equal(downgraded.status, 'INCOMPLETE');
    assert.ok(downgraded.entries[0]?.violations.some((entry) => entry.includes('legacy review coverage exemption')));
    assert.ok(downgraded.omitted_obligation_ids.includes('code:FILE-001'));

    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit rejects missing or invalid context instead of treating it as legacy', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-invalid-context-'));
    const taskId = 'T-976-invalid-context';
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: null
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'INCOMPLETE');
    assert.ok(summary.entries[0]?.violations.some((entry) => entry.includes('invalid schema version')));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit lists every contract obligation when the receipt is missing', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-missing-receipt-'));
    const taskId = 'T-976-missing-receipt';
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts']
    });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['src/example.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'INCOMPLETE');
    const expectedOmitted = contract.obligations.map((entry) => `code:${entry.id}`).sort();
    assert.deepEqual(summary.omitted_obligation_ids, expectedOmitted);
    assert.ok(expectedOmitted.every((entry) => summary.visible_summary_line.includes(entry)));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit rejects a forged context and receipt that omit authoritative scope', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-forged-scope-'));
    const taskId = 'T-976-forged-scope';
    const forgedContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: ['src/example.ts']
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-review-context.json`), JSON.stringify({
        schema_version: 3,
        coverage_contract: forgedContract
    }), 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: forgedContract.contract_sha256,
            obligation_count: 0,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');

    const summary = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });

    assert.equal(summary.status, 'INCOMPLETE');
    assert.ok(summary.entries[0]?.violations.some((entry) => entry.includes('does not match')));
    assert.ok(summary.omitted_obligation_ids.includes('code:FILE-001'));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});

test('review coverage audit preserves deleted-file obligations in authoritative scope', () => {
    const reviewsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-deleted-file-'));
    const taskId = 'T-976-deleted-file';
    const deletedPath = 'src/deleted-example.ts';
    const contract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [deletedPath] });
    const contextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-preflight.json`), JSON.stringify({
        changed_files: [deletedPath]
    }), 'utf8');
    fs.writeFileSync(contextPath, JSON.stringify({
        schema_version: 3,
        coverage_contract: contract
    }), 'utf8');
    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: contract.contract_sha256,
            obligation_count: contract.obligation_count,
            completed_obligation_count: contract.obligation_count,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');

    const complete = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(complete.status, 'COMPLETE');
    assert.match(complete.visible_summary_line, new RegExp(`obligations=${contract.obligation_count}\\/${contract.obligation_count}`));

    const forgedContract = buildReviewCoverageContract({ reviewType: 'code', changedFiles: [] });
    fs.writeFileSync(contextPath, JSON.stringify({
        schema_version: 3,
        coverage_contract: forgedContract
    }), 'utf8');
    fs.writeFileSync(receiptPath, JSON.stringify({
        review_coverage: {
            status: 'PASS',
            contract_sha256: forgedContract.contract_sha256,
            obligation_count: 0,
            completed_obligation_count: 0,
            omitted_obligation_ids: [],
            duplicate_obligation_ids: [],
            unknown_obligation_ids: []
        }
    }), 'utf8');

    const forged = buildReviewCoverageAuditSummary({
        reviewsRoot,
        taskId,
        requiredReviews: { code: true }
    });
    assert.equal(forged.status, 'INCOMPLETE');
    assert.ok(forged.entries[0]?.violations.some((entry) => entry.includes('does not match')));
    assert.ok(forged.omitted_obligation_ids.includes('code:FILE-001'));
    fs.rmSync(reviewsRoot, { recursive: true, force: true });
});
