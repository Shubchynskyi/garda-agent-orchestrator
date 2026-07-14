import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import {
    buildReviewCoverageContract,
    getReviewCoverageContractViolations,
    resolveReviewCoverageEvidenceSnapshotCommit,
    validateReviewCoverageLedger
} from '../../../../src/gates/review/review-coverage-ledger';

function ledgerLine(
    id: string,
    location: string,
    observation: string,
    findingIds: string[] = []
): string {
    return `- ${JSON.stringify({
        id,
        evidence: [{ location, observation }],
        result: findingIds.length > 0 ? 'finding' : 'no-finding',
        finding_ids: findingIds
    })}`;
}

function buildReviewOutput(lines: string[], findings: string[] = []): string {
    return [
        '# Code Review',
        '',
        '## Validation Notes',
        'Reviewed concrete runtime and test paths using the generated coverage ledger.',
        '',
        '## Coverage Ledger',
        ...lines,
        '',
        '## Findings by Severity',
        ...(findings.length > 0 ? findings : ['None']),
        '',
        '## Deferred Findings',
        'None',
        '',
        '## Residual Risks',
        'None',
        '',
        '## Verdict',
        findings.length > 0 ? 'REVIEW FAILED' : 'REVIEW PASSED'
    ].join('\n');
}

test('buildReviewCoverageContract creates deterministic file, boundary, and category obligations', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: [
            'tests/node/example.test.ts',
            'src/example.ts'
        ]
    });

    assert.equal(contract.required, true);
    assert.equal(contract.obligations.filter((entry) => entry.kind === 'file').length, 2);
    assert.ok(contract.obligations.some((entry) => entry.id === 'BOUNDARY-RUNTIME-BEHAVIOR'));
    assert.ok(contract.obligations.some((entry) => entry.id === 'BOUNDARY-TEST-BEHAVIOR'));
    assert.ok(contract.obligations.some((entry) => entry.id === 'CATEGORY-CORRECTNESS-EDGE-CASES'));
    assert.match(contract.contract_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(
        contract,
        buildReviewCoverageContract({
            reviewType: 'code',
            changedFiles: ['src/example.ts', 'tests/node/example.test.ts']
        })
    );
});

test('validateReviewCoverageLedger accepts complete evidence and preserves multiple findings', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: ['correctness-edge-cases']
    });
    const lines = contract.obligations.map((obligation, index) => ledgerLine(
        obligation.id,
        'src/example.ts:' + (index + 10),
        `parseExample branch ${index + 1} was inspected against malformed and valid inputs`,
        index === 0 ? ['F-001', 'F-002'] : []
    ));
    const output = buildReviewOutput(lines, [
        '- High: [F-001] src/example.ts:10 drops malformed input diagnostics; remediation: preserve the error.',
        '- Medium: [F-002] src/example.ts:11 accepts an empty identifier; remediation: reject empty values.'
    ]);

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'PASS');
    assert.equal(result.completed_obligation_count, contract.obligations.length);
    assert.deepEqual(result.finding_ids, ['F-001', 'F-002']);
    assert.deepEqual(result.violations, []);
});

test('validateReviewCoverageLedger rejects missing, duplicate, generic, and unknown entries', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: ['correctness-edge-cases']
    });
    const first = contract.obligations[0];
    const output = buildReviewOutput([
        ledgerLine(first.id, 'src/example.ts:1', 'Reviewed the whole file and found no issues anywhere'),
        ledgerLine(first.id, 'src/example.ts:2', 'parseExample was inspected against malformed identifier handling'),
        ledgerLine('CATEGORY-UNKNOWN', 'src/example.ts:3', 'parseExample was inspected against unknown category behavior')
    ]);

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'FAIL');
    assert.ok(result.duplicate_obligation_ids.includes(first.id));
    assert.ok(result.unknown_obligation_ids.includes('CATEGORY-UNKNOWN'));
    assert.ok(result.omitted_obligation_ids.length > 0);
    assert.ok(result.violations.some((entry) => entry.includes('generic evidence')));
});

test('validateReviewCoverageLedger rejects mixed valid and malformed evidence members', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: []
    });
    const lines = contract.obligations.map((obligation) => ledgerLine(
        obligation.id,
        'src/example.ts:1',
        `Concrete ${obligation.kind} evidence covers malformed-member validation`
    ));
    const output = buildReviewOutput(lines).replace(
        '"evidence":[{',
        '"evidence":[null,42,[],{"location":1,"observation":"invalid"},{'
    );

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'FAIL');
    assert.ok(result.violations.some((entry) => entry.includes('malformed evidence member')));
});

test('validateReviewCoverageLedger rejects malformed finding_ids containers and members', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: []
    });
    const lines = contract.obligations.map((obligation) => ledgerLine(
        obligation.id,
        'src/example.ts:1',
        `Concrete ${obligation.kind} evidence covers malformed finding identifier validation`
    ));
    const nonArray = buildReviewOutput(lines).replace('"finding_ids":[]', '"finding_ids":"F-001"');
    const malformedMembers = buildReviewOutput(lines).replace('"finding_ids":[]', '"finding_ids":[null,"",42]');

    const nonArrayResult = validateReviewCoverageLedger(nonArray, contract);
    const malformedMembersResult = validateReviewCoverageLedger(malformedMembers, contract);

    assert.equal(nonArrayResult.status, 'FAIL');
    assert.ok(nonArrayResult.violations.some((entry) => entry.includes('must use a finding_ids array')));
    assert.equal(malformedMembersResult.status, 'FAIL');
    assert.ok(malformedMembersResult.violations.some((entry) => entry.includes('malformed finding_ids member')));
});

test('controlled multi-defect fixture cannot pass after only the first finding', () => {
    const base = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: ['correctness-edge-cases']
    });
    const contract = {
        ...base,
        obligations: base.obligations.map((entry, index) => index === 0
            ? { ...entry, expected_finding_ids: ['F-001', 'F-002'] }
            : entry)
    };
    const lines = contract.obligations.map((obligation, index) => ledgerLine(
        obligation.id,
        'src/example.ts:' + (index + 20),
        `parseExample seeded branch ${index + 1} was inspected with concrete fixture evidence`,
        index === 0 ? ['F-001'] : []
    ));
    const output = buildReviewOutput(lines, [
        '- High: [F-001] src/example.ts:20 exposes the first seeded defect; remediation: fix the branch.'
    ]);

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'FAIL');
    assert.ok(result.violations.some((entry) => entry.includes('F-002')));
});

test('review coverage context validation rejects forged or stale obligations', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts']
    });
    const forged = {
        ...contract,
        obligations: contract.obligations.filter((entry) => entry.kind !== 'file')
    };

    const violations = getReviewCoverageContractViolations(forged, {
        reviewType: 'code',
        changedFiles: ['src/example.ts']
    });

    assert.ok(violations.some((entry) => entry.includes('does not match the deterministic current-scope contract')));
});

test('validateReviewCoverageLedger rejects invalid result tokens and out-of-range evidence lines', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-lines-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'example.ts'), 'export const example = 1;\n', 'utf8');
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: []
    });
    const validLines = contract.obligations.map((obligation) => ledgerLine(
        obligation.id,
        'src/example.ts:1',
        `Concrete ${obligation.kind} evidence covers the current example declaration`
    ));
    const invalidResultOutput = buildReviewOutput(validLines).replace('"result":"no-finding"', '"result":"maybe"');
    const invalidResult = validateReviewCoverageLedger(invalidResultOutput, contract, { repoRoot });
    assert.equal(invalidResult.status, 'FAIL');
    assert.ok(invalidResult.violations.some((entry) => entry.includes("must use result 'finding' or 'no-finding'")));

    const overflowOutput = buildReviewOutput(validLines.map((line) => line.replace('src/example.ts:1', 'src/example.ts:999')));
    const overflow = validateReviewCoverageLedger(overflowOutput, contract, { repoRoot });
    assert.equal(overflow.status, 'FAIL');
    assert.ok(overflow.violations.some((entry) => entry.includes('exceeds current file line count 1')));

    const valid = validateReviewCoverageLedger(buildReviewOutput(validLines), contract, { repoRoot });
    assert.equal(valid.status, 'PASS');
    fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('validateReviewCoverageLedger accepts deleted-file evidence from the bound HEAD snapshot', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-deleted-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'deleted.ts'), 'export const first = 1;\nexport const second = 2;\n', 'utf8');
    execFileSync('git', ['init', '--quiet'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'review-test@example.invalid'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: repoRoot });
    execFileSync('git', ['add', 'src/deleted.ts'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repoRoot });
    fs.rmSync(path.join(repoRoot, 'src', 'deleted.ts'));

    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/deleted.ts'],
        categoryIds: []
    });
    const lines = contract.obligations.map((obligation) => ledgerLine(
        obligation.id,
        'src/deleted.ts:2',
        `Deleted ${obligation.kind} evidence checks the second declaration in the HEAD snapshot`
    ));

    const result = validateReviewCoverageLedger(buildReviewOutput(lines), contract, { repoRoot });

    assert.equal(result.status, 'PASS');
    fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('validateReviewCoverageLedger accepts evidence from a committed deletion parent snapshot', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-coverage-committed-deletion-'));
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'deleted.ts'), 'export const first = 1;\nexport const second = 2;\n', 'utf8');
    execFileSync('git', ['init', '--quiet', '--object-format=sha256'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'review-test@example.invalid'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Review Test'], { cwd: repoRoot });
    execFileSync('git', ['add', 'src/deleted.ts'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], { cwd: repoRoot });
    const evidenceSnapshotCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8'
    }).trim();
    assert.equal(evidenceSnapshotCommit.length, 64);
    fs.rmSync(path.join(repoRoot, 'src', 'deleted.ts'));
    execFileSync('git', ['add', '-u'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'delete fixture'], { cwd: repoRoot });
    fs.writeFileSync(
        path.join(repoRoot, 'src', 'deleted.ts'),
        'export const replacement = 1;\nexport const replacementSecond = 2;\nexport const staleThird = 3;\n',
        'utf8'
    );
    execFileSync('git', ['add', 'src/deleted.ts'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--quiet', '-m', 'recreate fixture'], { cwd: repoRoot });
    fs.rmSync(path.join(repoRoot, 'src', 'deleted.ts'));
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/deleted.ts'],
        categoryIds: []
    });
    const lines = contract.obligations.map((obligation) => ledgerLine(
        obligation.id,
        'src/deleted.ts:2',
        `Committed deletion ${obligation.kind} evidence checks the bound parent snapshot`
    ));

    const staleLines = lines.map((line) => line.replace('src/deleted.ts:2', 'src/deleted.ts:3'));
    const unboundResult = validateReviewCoverageLedger(buildReviewOutput(staleLines), contract, { repoRoot });
    const boundStaleResult = validateReviewCoverageLedger(buildReviewOutput(staleLines), contract, {
        repoRoot,
        evidenceSnapshotCommit
    });
    const result = validateReviewCoverageLedger(buildReviewOutput(lines), contract, {
        repoRoot,
        evidenceSnapshotCommit
    });

    assert.equal(unboundResult.status, 'PASS');
    assert.equal(boundStaleResult.status, 'FAIL');
    assert.ok(boundStaleResult.violations.some((entry) => entry.includes('authenticated pre-change snapshot line count 2')));
    assert.equal(result.status, 'PASS');
    fs.rmSync(repoRoot, { recursive: true, force: true });
});

test('authenticated snapshot binding is propagated through result, trust, and reuse consumers', () => {
    const baseCommit = '1'.repeat(40);
    const checkpointCommit = '2'.repeat(40);
    assert.equal(resolveReviewCoverageEvidenceSnapshotCommit({
        detection_source: `git_split_checkpoint:${baseCommit}:${checkpointCommit}`
    }), baseCommit);

    const consumers = [
        {
            path: 'src/cli/commands/gate-review-handlers/result/review-result-handlers.ts',
            preflight: 'preflight',
            validator: 'contract',
            validatesSnapshotCommit: true,
            buildsValidationArtifact: false
        },
        {
            path: 'src/gates/required-reviews/required-reviews-check-trust.ts',
            preflight: 'preflightPayload',
            validator: 'validation_artifact',
            validatesSnapshotCommit: false,
            buildsValidationArtifact: false
        },
        {
            path: 'src/gates/review-reuse/review-reuse-materialization.ts',
            preflight: 'options.preflightPayload',
            validator: 'validation_artifact',
            validatesSnapshotCommit: false,
            buildsValidationArtifact: true
        }
    ] as const;
    for (const consumer of consumers) {
        const source = fs.readFileSync(path.resolve(consumer.path), 'utf8');
        assert.match(
            source,
            consumer.validator === 'contract'
                ? /validate(?:Json)?ReviewFindings(?:Contract|Artifact|ValidationArtifact(?:ForReceipt)?)\(/u
                : consumer.validator === 'validation_artifact'
                    ? /validateReviewFindingsValidationArtifactForReceipt\(/u
                : /validateReviewCoverageLedger\(/u
        );
        if (consumer.validatesSnapshotCommit) {
            assert.match(source, /evidenceSnapshotCommit:\s*resolveReviewCoverageEvidenceSnapshotCommit\(/u);
            assert.ok(
                source.includes(`resolveReviewCoverageEvidenceSnapshotCommit(${consumer.preflight})`),
                `${consumer.path} must bind coverage validation to its authoritative preflight payload`
            );
        } else {
            assert.match(source, /expectedPreflightSha256:/u);
            assert.match(source, /expectedScopeSha256:/u);
            if (consumer.buildsValidationArtifact) {
                assert.match(source, /buildReviewFindingsValidationArtifact\(/u);
            }
        }
    }
});

test('canonical evidence-only finding uses reserved ledger id without changing marker syntax', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: []
    });
    const lines = contract.obligations.map((obligation, index) => ledgerLine(
        obligation.id,
        'src/example.ts:1',
        `Concrete evidence-only review obligation ${index + 1} covers focused validation routing`,
        index === 0 ? ['F-000'] : []
    ));
    const output = buildReviewOutput(lines, [
        '- High: [garda:evidence-only:missing-focused-validation] test=tests/node/example.test.ts; action=run-and-record-focused-test'
    ]);

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.finding_ids, ['F-000']);
});

test('JSON coverage ledger accepts critical findings and canonical evidence-only reserved id', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: ['correctness-edge-cases']
    });
    const output = JSON.stringify({
        schema_version: 1,
        task_id: 'T-979-2',
        review_type: 'code',
        review_context_sha256: 'a'.repeat(64),
        tree_state_sha256: 'b'.repeat(64),
        validation_notes: [],
        coverage_ledger: {
            coverage_contract_sha256: contract.contract_sha256,
            entries: contract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [{
                    location: 'src/example.ts:1',
                    observation: `Concrete JSON coverage obligation ${index + 1} covers ${obligation.target}`
                }],
                finding_ids: index === 0 ? ['F-001', 'F-000'] : []
            }))
        },
        findings: {
            critical: [{
                id: 'F-001',
                title: 'Critical JSON finding',
                description: 'Critical severity must be represented by verdict-free JSON review artifacts.',
                evidence: [{
                    location: 'src/example.ts:1',
                    observation: 'Concrete critical finding evidence was inspected.'
                }],
                coverage_obligation_ids: [contract.obligations[0].id]
            }],
            high: [{
                id: 'F-000',
                title: '[garda:evidence-only:missing-focused-validation] test=tests/node/example.test.ts; action=run-and-record-focused-test',
                description: 'Canonical evidence-only focused validation marker.',
                evidence: [{
                    location: 'src/example.ts:1',
                    observation: 'Concrete evidence-only marker path was inspected.'
                }],
                coverage_obligation_ids: [contract.obligations[0].id]
            }],
            medium: [],
            low: []
        },
        residual_risks: [],
        reviewer_notes: []
    });

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'PASS');
    assert.deepEqual(result.finding_ids, ['F-000', 'F-001']);
});

test('JSON coverage ledger rejects reserved evidence-only id for ordinary structured findings', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: []
    });
    const output = JSON.stringify({
        schema_version: 1,
        task_id: 'T-979-2',
        review_type: 'code',
        review_context_sha256: 'a'.repeat(64),
        tree_state_sha256: 'b'.repeat(64),
        validation_notes: [],
        coverage_ledger: {
            coverage_contract_sha256: contract.contract_sha256,
            entries: contract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [{
                    location: 'src/example.ts:1',
                    observation: `Concrete JSON coverage obligation ${index + 1} covers ${obligation.target}`
                }],
                finding_ids: index === 0 ? ['F-000'] : []
            }))
        },
        findings: {
            critical: [],
            high: [{
                id: 'F-000',
                title: 'Ordinary implementation defect',
                description: 'This is not the canonical evidence-only marker.',
                evidence: [{
                    location: 'src/example.ts:1',
                    observation: 'Concrete ordinary finding evidence was inspected.'
                }],
                coverage_obligation_ids: [contract.obligations[0].id]
            }],
            medium: [],
            low: []
        },
        residual_risks: [],
        reviewer_notes: []
    });

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'FAIL');
    assert.ok(result.violations.some((entry) => entry.includes("'F-000' is reserved")));
});

test('reserved evidence-only ledger id is rejected for ordinary findings', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: []
    });
    const lines = contract.obligations.map((obligation, index) => ledgerLine(
        obligation.id,
        'src/example.ts:1',
        `Concrete ordinary finding obligation ${index + 1} covers reserved identifier behavior`,
        index === 0 ? ['F-000'] : []
    ));
    const output = buildReviewOutput(lines, [
        '- Medium: [F-000] src/example.ts:1 ordinary implementation defect; remediation: fix it.'
    ]);

    const result = validateReviewCoverageLedger(output, contract);

    assert.equal(result.status, 'FAIL');
    assert.ok(result.violations.some((entry) => entry.includes("'F-000' is reserved")));
});
