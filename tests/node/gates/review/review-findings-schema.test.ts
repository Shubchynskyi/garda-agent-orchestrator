import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import test from 'node:test';

import {
    REVIEW_FINDINGS_SCHEMA_VERSION,
    reviewFindingsReportJsonSchema,
    validateReviewFindingsReport
} from '../../../../src/gates/review/review-findings-schema';
import {
    buildReviewCoverageContract
} from '../../../../src/gates/review/review-coverage-ledger';
import {
    validateReviewFindingsContract
} from '../../../../src/gates/review/review-findings-artifact-verdict';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const CONTRACT_HASH = 'c'.repeat(64);

function evidence(location = 'src/example.ts:10', observation = 'Concrete parser branch was checked against malformed input'): object {
    return { location, observation };
}

function validReport(): Record<string, unknown> {
    return {
        schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
        task_id: 'T-979-1',
        review_type: 'code',
        review_context_sha256: HASH_A,
        tree_state_sha256: HASH_B,
        validation_notes: [{
            id: 'N-001',
            topic: 'schema-shape',
            note: 'The reviewer inspected all required schema fields and coverage obligations.',
            evidence: [evidence()]
        }],
        coverage_ledger: {
            coverage_contract_sha256: CONTRACT_HASH,
            entries: [
                {
                    obligation_id: 'FILE-001',
                    evidence: [evidence()],
                    finding_ids: []
                },
                {
                    obligation_id: 'CATEGORY-SCHEMA',
                    evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
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
        reviewer_notes: ['No reviewer-owned remediation or verdict was supplied.']
    };
}

const validationOptions = {
    expectedTaskId: 'T-979-1',
    expectedReviewType: 'code',
    expectedCoverageObligationIds: ['FILE-001', 'CATEGORY-SCHEMA'],
    expectedChangedFilePaths: ['src/example.ts'],
    expectedReviewContextSha256: HASH_A,
    expectedTreeStateSha256: HASH_B
};

type JsonObject = Record<string, unknown>;

function cloneReport(report: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(JSON.stringify(report)) as Record<string, unknown>;
}

function isJsonObject(value: unknown): value is JsonObject {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveSchemaRef(root: JsonObject, ref: string): JsonObject {
    const parts = ref.replace(/^#\//u, '').split('/');
    let current: unknown = root;
    for (const part of parts) {
        assert.ok(isJsonObject(current), `schema ref ${ref} resolved through a non-object segment`);
        current = current[part];
    }
    assert.ok(isJsonObject(current), `schema ref ${ref} did not resolve to an object`);
    return current;
}

function schemaViolations(value: unknown, schema: JsonObject, root = schema, path = '$'): string[] {
    const ref = typeof schema.$ref === 'string' ? schema.$ref : null;
    if (ref) {
        return schemaViolations(value, resolveSchemaRef(root, ref), root, path);
    }

    const violations: string[] = [];
    if ('const' in schema && value !== schema.const) {
        violations.push(`${path} must equal schema const`);
    }

    if (schema.type === 'object') {
        if (!isJsonObject(value)) {
            return [`${path} must be an object`];
        }
        const required = Array.isArray(schema.required) ? schema.required.filter((entry): entry is string => typeof entry === 'string') : [];
        required
            .filter((key) => !(key in value))
            .forEach((key) => violations.push(`${path}.${key} is required`));
        const properties = isJsonObject(schema.properties) ? schema.properties : {};
        if (schema.additionalProperties === false) {
            Object.keys(value)
                .filter((key) => !(key in properties))
                .forEach((key) => violations.push(`${path}.${key} is not allowed`));
        }
        for (const [key, propertySchema] of Object.entries(properties)) {
            if (key in value) {
                assert.ok(isJsonObject(propertySchema), `${path}.${key} schema must be an object`);
                violations.push(...schemaViolations(value[key], propertySchema, root, `${path}.${key}`));
            }
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(value)) {
            return [`${path} must be an array`];
        }
        if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
            violations.push(`${path} must contain at least ${schema.minItems} item(s)`);
        }
        if (isJsonObject(schema.items)) {
            value.forEach((entry, index) => {
                violations.push(...schemaViolations(entry, schema.items as JsonObject, root, `${path}[${index}]`));
            });
        }
    } else if (schema.type === 'string') {
        if (typeof value !== 'string') {
            return [`${path} must be a string`];
        }
        if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
            violations.push(`${path} must have length at least ${schema.minLength}`);
        }
        if (typeof schema.pattern === 'string' && !(new RegExp(schema.pattern, 'u')).test(value)) {
            violations.push(`${path} must match ${schema.pattern}`);
        }
    }

    return violations;
}

function jsonSchemaViolations(report: Record<string, unknown>): string[] {
    return schemaViolations(report, reviewFindingsReportJsonSchema as JsonObject);
}

test('review findings schema exposes a strict versioned JSON object contract', () => {
    assert.equal(reviewFindingsReportJsonSchema.$id, 'garda-agent-orchestrator/review-findings-report.schema.json');
    assert.equal(reviewFindingsReportJsonSchema.$schema, 'http://json-schema.org/draft-07/schema#');
    assert.equal(reviewFindingsReportJsonSchema.additionalProperties, false);
    assert.equal(reviewFindingsReportJsonSchema.properties.schema_version.const, REVIEW_FINDINGS_SCHEMA_VERSION);
    assert.ok(reviewFindingsReportJsonSchema.required.includes('coverage_ledger'));
    assert.ok(reviewFindingsReportJsonSchema.required.includes('findings'));
});

test('review findings JSON schema models nested sections for machine validation', () => {
    const report = validReport();

    assert.deepEqual(jsonSchemaViolations(report), []);

    const malformed = cloneReport(report);
    const validationNote = (malformed.validation_notes as Array<Record<string, unknown>>)[0];
    delete (validationNote.evidence as Array<Record<string, unknown>>)[0].observation;
    ((malformed.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0].unexpected = true;
    (malformed.findings as Record<string, unknown>).medium = [{
        id: 'M-001',
        title: 'Malformed finding id',
        description: 'The exported JSON schema must reject this nested finding shape.',
        evidence: [],
        coverage_obligation_ids: []
    }];
    malformed.residual_risks = [{
        id: 'RISK-001',
        description: 'Malformed residual risk id.',
        evidence: [evidence()]
    }];

    const violations = jsonSchemaViolations(malformed);

    assert.ok(violations.some((entry) => entry.includes('$.validation_notes[0].evidence[0].observation is required')));
    assert.ok(violations.some((entry) => entry.includes('$.coverage_ledger.entries[0].unexpected is not allowed')));
    assert.ok(violations.some((entry) => entry.includes('$.findings.medium[0].id must match')));
    assert.ok(violations.some((entry) => entry.includes('$.findings.medium[0].evidence must contain at least 1 item')));
    assert.ok(violations.some((entry) => entry.includes('$.findings.medium[0].coverage_obligation_ids must contain at least 1 item')));
    assert.ok(violations.some((entry) => entry.includes('$.residual_risks[0].id must match')));
});

test('validateReviewFindingsReport accepts empty findings only with complete coverage evidence', () => {
    const result = validateReviewFindingsReport(validReport(), validationOptions);

    assert.equal(result.valid, true);
    assert.equal(result.report?.task_id, 'T-979-1');
    assert.deepEqual(result.report?.findings.high, []);
    assert.deepEqual(result.violations, []);
});

test('validateReviewFindingsReport rejects empty validation notes', () => {
    const report = validReport();
    report.validation_notes = [];

    const schemaViolations = jsonSchemaViolations(report);
    const result = validateReviewFindingsReport(report, validationOptions);

    assert.ok(schemaViolations.some((entry) => entry.includes('$.validation_notes must contain at least 1 item')));
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('validation_notes must contain at least one validation note')));
});

test('validateReviewFindingsReport rejects empty findings when expected coverage obligations are omitted', () => {
    const result = validateReviewFindingsReport(validReport(), {
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedChangedFilePaths: ['src/example.ts'],
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B
    });

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('Empty findings require expected coverage obligation ids')));
});

test('validateReviewFindingsReport rejects non-concrete JSON coverage evidence locations when current changed files are known', () => {
    const report = validReport();
    ((report.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0].evidence = [
        evidence('<changed-file>:<line>', 'Placeholder evidence should not satisfy coverage.')
    ];
    ((report.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[1].evidence = [
        evidence('tests/example.test.ts:20', 'A non-changed file should not satisfy current coverage.')
    ];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "coverage_ledger.entries[0].evidence[0].location '<changed-file>:<line>' must be a current changed-file path:line"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "coverage_ledger.entries[1].evidence[0].location 'tests/example.test.ts:20' must be a current changed-file path:line"
    )));
});

test('validateReviewFindingsReport rejects non-concrete evidence locations outside the coverage ledger', () => {
    const report = validReport();
    (report.validation_notes as Array<Record<string, unknown>>)[0].evidence = [
        evidence('<changed-file>:<line>', 'Placeholder validation note evidence should not pass.')
    ];
    (report.findings as Record<string, unknown>).medium = [{
        id: 'F-001',
        title: 'Concrete evidence validation gap',
        description: 'Finding evidence must be bound to a current changed file.',
        evidence: [evidence('tests/example.test.ts:20', 'A non-changed finding evidence location should not pass.')],
        coverage_obligation_ids: ['FILE-001']
    }];
    report.residual_risks = [{
        id: 'R-001',
        description: 'Residual risk evidence must be bound to a current changed file.',
        evidence: [evidence('src/other.ts:10', 'A non-changed residual risk evidence location should not pass.')]
    }];
    ((report.coverage_ledger as Record<string, unknown>).entries as Array<Record<string, unknown>>)[0].finding_ids = ['F-001'];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "validation_notes[0].evidence[0].location '<changed-file>:<line>' must be a current changed-file path:line"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "findings.medium[0].evidence[0].location 'tests/example.test.ts:20' must be a current changed-file path:line"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "residual_risks[0].evidence[0].location 'src/other.ts:10' must be a current changed-file path:line"
    )));
});

test('validateReviewFindingsContract authenticates non-ledger evidence line numbers', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-findings-lines-'));
    try {
        fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'example.ts'), 'export const example = 1;\n', 'utf8');
        const contract = buildReviewCoverageContract({
            reviewType: 'code',
            changedFiles: ['src/example.ts'],
            categoryIds: ['schema']
        });
        const report = validReport();
        report.coverage_ledger = {
            coverage_contract_sha256: contract.contract_sha256,
            entries: contract.obligations.map((obligation, index) => ({
                obligation_id: obligation.id,
                evidence: [
                    evidence(
                        'src/example.ts:1',
                        `Concrete current-file evidence covers ${obligation.kind} obligation ${index + 1}.`
                    )
                ],
                finding_ids: index === 0 ? ['F-001'] : []
            }))
        };
        (report.validation_notes as Array<Record<string, unknown>>)[0].evidence = [
            evidence('src/example.ts:999', 'Validation-note evidence points beyond the current file.')
        ];
        (report.findings as Record<string, unknown>).medium = [{
            id: 'F-001',
            title: 'Out-of-range non-ledger evidence',
            description: 'Finding evidence must be authenticated against current changed-file line counts.',
            evidence: [evidence('src/example.ts:999', 'Finding evidence points beyond the current file.')],
            coverage_obligation_ids: [contract.obligations[0].id]
        }];
        report.residual_risks = [{
            id: 'R-001',
            description: 'Residual risk evidence must be authenticated against current changed-file line counts.',
            evidence: [evidence('src/example.ts:999', 'Residual-risk evidence points beyond the current file.')]
        }];

        const result = validateReviewFindingsContract({
            content: JSON.stringify(report),
            expectedTaskId: 'T-979-1',
            expectedReviewType: 'code',
            expectedReviewContextSha256: HASH_A,
            expectedTreeStateSha256: HASH_B,
            coverageContract: contract,
            repoRoot
        });

        assert.equal(result.detected, true);
        assert.equal(result.valid, false);
        assert.ok(result.violations.some((entry) => entry.includes(
            "validation_notes[0].evidence[0].location 'src/example.ts:999' exceeds current file line count 1"
        )));
        assert.ok(result.violations.some((entry) => entry.includes(
            "findings.medium[0].evidence[0].location 'src/example.ts:999' exceeds current file line count 1"
        )));
        assert.ok(result.violations.some((entry) => entry.includes(
            "residual_risks[0].evidence[0].location 'src/example.ts:999' exceeds current file line count 1"
        )));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReviewFindingsReport rejects empty findings when expected coverage is incomplete', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [{
            obligation_id: 'FILE-001',
            evidence: [evidence()],
            finding_ids: []
        }]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Expected coverage obligation 'CATEGORY-SCHEMA'")));
});

test('validateReviewFindingsReport accepts critical, high, medium, and low findings bound to coverage evidence', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-001', 'F-002', 'F-003']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: ['F-004']
            }
        ]
    };
    report.findings = {
        critical: [{
            id: 'F-001',
            title: 'Unrepresentable critical finding',
            description: 'The schema accepts critical severity findings.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        high: [{
            id: 'F-002',
            title: 'Missing task binding',
            description: 'The schema accepts a foreign task identifier.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        medium: [{
            id: 'F-003',
            title: 'Missing review binding',
            description: 'The schema accepts a foreign review type.',
            evidence: [evidence('src/example.ts:11', 'Concrete review-type branch was inspected')],
            coverage_obligation_ids: ['FILE-001']
        }],
        low: [{
            id: 'F-004',
            title: 'Weak reviewer note validation',
            description: 'The schema accepts empty reviewer notes.',
            evidence: [evidence('src/example.ts:20', 'Concrete note validation branch was inspected')],
            coverage_obligation_ids: ['CATEGORY-SCHEMA']
        }]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.report?.findings.critical.map((entry) => entry.id), ['F-001']);
    assert.deepEqual(result.report?.findings.high.map((entry) => entry.id), ['F-002']);
    assert.deepEqual(result.violations, []);
});

test('validateReviewFindingsReport rejects unknown and reviewer-owned verdict fields', () => {
    const report = validReport();
    report.verdict = 'REVIEW PASSED';
    (report.validation_notes as Array<Record<string, unknown>>)[0].passed = true;

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("unknown field 'verdict'")));
    assert.ok(result.violations.some((entry) => entry.includes('$.verdict is a reviewer-owned verdict')));
    assert.ok(result.violations.some((entry) => entry.includes('$.validation_notes[0].passed')));
});

test('validateReviewFindingsReport rejects duplicate ids and missing concrete evidence', () => {
    const report = validReport();
    report.findings = {
        critical: [],
        high: [
            {
                id: 'F-001',
                title: 'Duplicate finding',
                description: 'First duplicate instance.',
                evidence: [evidence()],
                coverage_obligation_ids: ['FILE-001']
            },
            {
                id: 'F-001',
                title: 'Duplicate finding again',
                description: 'Second duplicate instance.',
                evidence: [],
                coverage_obligation_ids: ['FILE-001']
            }
        ],
        medium: [],
        low: []
    };
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [],
                finding_ids: ['F-001']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: []
            }
        ]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate finding id 'F-001'")));
    assert.ok(result.violations.some((entry) => entry.includes('findings.high[1].evidence must contain')));
    assert.ok(result.violations.some((entry) => entry.includes('coverage_ledger.entries[0].evidence must contain')));
});

test('validateReviewFindingsReport rejects duplicate ids in every id-bearing section', () => {
    const report = validReport();
    report.validation_notes = [
        {
            id: 'N-001',
            topic: 'schema-shape',
            note: 'First validation note.',
            evidence: [evidence()]
        },
        {
            id: 'N-001',
            topic: 'schema-shape-again',
            note: 'Second validation note with duplicate id.',
            evidence: [evidence('src/example.ts:11', 'Duplicate validation note id branch was inspected')]
        }
    ];
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: []
            },
            {
                obligation_id: 'FILE-001',
                evidence: [evidence('src/example.ts:20', 'Duplicate coverage obligation id branch was inspected')],
                finding_ids: []
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:30', 'Expected coverage obligation remains represented')],
                finding_ids: []
            }
        ]
    };
    report.residual_risks = [
        {
            id: 'R-001',
            description: 'First residual risk.',
            evidence: [evidence('src/example.ts:40', 'First residual risk id branch was inspected')]
        },
        {
            id: 'R-001',
            description: 'Second residual risk with duplicate id.',
            evidence: [evidence('src/example.ts:41', 'Duplicate residual risk id branch was inspected')]
        }
    ];

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate validation note id 'N-001'")));
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate coverage obligation id 'FILE-001'")));
    assert.ok(result.violations.some((entry) => entry.includes("Duplicate residual risk id 'R-001'")));
});

test('validateReviewFindingsReport rejects task, review, context, and tree-state mismatches', () => {
    const report = validReport();
    report.task_id = 'T-OTHER';
    report.review_type = 'security';
    report.review_context_sha256 = 'd'.repeat(64);
    report.tree_state_sha256 = 'e'.repeat(64);

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("task_id 'T-OTHER'")));
    assert.ok(result.violations.some((entry) => entry.includes("review_type 'security'")));
    assert.ok(result.violations.some((entry) => entry.includes('review_context_sha256 does not match')));
    assert.ok(result.violations.some((entry) => entry.includes('tree_state_sha256 does not match')));
});

test('validateReviewFindingsReport rejects coverage/finding cross-reference drift', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-999']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: []
            }
        ]
    };
    report.findings = {
        critical: [],
        high: [{
            id: 'F-001',
            title: 'Unlinked finding',
            description: 'The finding is not referenced by coverage.',
            evidence: [evidence()],
            coverage_obligation_ids: ['CATEGORY-UNKNOWN']
        }],
        medium: [],
        low: []
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes("Finding 'F-001' references unknown coverage obligation")));
    assert.ok(result.violations.some((entry) => entry.includes("Finding 'F-001' is not referenced")));
    assert.ok(result.violations.some((entry) => entry.includes("Coverage ledger references unknown finding 'F-999'")));
});

test('validateReviewFindingsReport rejects per-obligation coverage and finding reciprocity drift', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: []
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: ['F-001']
            }
        ]
    };
    report.findings = {
        critical: [],
        high: [{
            id: 'F-001',
            title: 'Partially linked finding',
            description: 'The finding and coverage ledger disagree about the exact obligations exposing the issue.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        medium: [],
        low: []
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes(
        "Finding 'F-001' references coverage obligation 'FILE-001' but that coverage ledger entry does not reference the finding"
    )));
    assert.ok(result.violations.some((entry) => entry.includes(
        "Coverage ledger entry 'CATEGORY-SCHEMA' references finding 'F-001' but that finding does not reference the coverage obligation"
    )));
});

test('validateReviewFindingsContract returns one deterministic violation set for malformed findings and coverage', () => {
    const contract = buildReviewCoverageContract({
        reviewType: 'code',
        changedFiles: ['src/example.ts'],
        categoryIds: ['schema']
    });
    const fileObligation = contract.obligations.find((entry) => entry.kind === 'file');
    const categoryObligation = contract.obligations.find((entry) => entry.kind === 'category');
    assert.ok(fileObligation);
    assert.ok(categoryObligation);
    const report = {
        ...validReport(),
        task_id: 'T-OTHER',
        review_context_sha256: 'd'.repeat(64),
        tree_state_sha256: 'e'.repeat(64),
        verdict: 'REVIEW PASSED',
        coverage_ledger: {
            coverage_contract_sha256: 'f'.repeat(64),
            entries: [
                {
                    obligation_id: fileObligation.id,
                    evidence: [evidence('src/example.ts:10', 'Reviewed the whole file')],
                    finding_ids: ['F-999']
                },
                {
                    obligation_id: fileObligation.id,
                    evidence: [],
                    finding_ids: []
                },
                {
                    obligation_id: 'CATEGORY-UNKNOWN',
                    evidence: [evidence('tests/outside.test.ts:2', 'Concrete unknown category evidence was inspected')],
                    finding_ids: []
                }
            ]
        },
        findings: {
            critical: [],
            high: [
                {
                    id: 'F-001',
                    title: 'Unlinked category finding',
                    description: 'The finding references an omitted system-owned category obligation.',
                    evidence: [evidence('tests/outside.test.ts:2', 'Concrete outside-scope finding evidence was inspected')],
                    coverage_obligation_ids: [categoryObligation.id]
                },
                {
                    id: 'F-001',
                    title: 'Duplicate finding without evidence',
                    description: 'The duplicate finding is malformed and must not hide later coverage failures.',
                    evidence: [],
                    coverage_obligation_ids: [fileObligation.id]
                }
            ],
            medium: [],
            low: []
        },
        residual_risks: [{
            id: 'RISK-001',
            description: 'Malformed residual risk shape must be reported with the same result.',
            evidence: []
        }]
    };

    const first = validateReviewFindingsContract({
        content: JSON.stringify(report),
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B,
        coverageContract: contract
    });
    const second = validateReviewFindingsContract({
        content: JSON.stringify(report),
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B,
        coverageContract: contract
    });

    assert.equal(first.detected, true);
    assert.equal(first.valid, false);
    assert.equal(first.report, null);
    assert.equal(first.coverage_validation?.status, 'FAIL');
    assert.deepEqual(second.violations, first.violations);
    assert.ok(first.violations.some((entry) => entry.includes("unknown field 'verdict'")));
    assert.ok(first.violations.some((entry) => entry.includes('$.verdict is a reviewer-owned verdict')));
    assert.ok(first.violations.some((entry) => entry.includes("task_id 'T-OTHER'")));
    assert.ok(first.violations.some((entry) => entry.includes('review_context_sha256 does not match')));
    assert.ok(first.violations.some((entry) => entry.includes('tree_state_sha256 does not match')));
    assert.ok(first.violations.some((entry) => entry.includes('coverage_ledger.coverage_contract_sha256 does not match')));
    assert.ok(first.violations.some((entry) => entry.includes("Duplicate finding id 'F-001'")));
    assert.ok(first.violations.some((entry) => entry.includes('findings.high[1].evidence must contain')));
    assert.ok(first.violations.some((entry) => entry.includes('residual_risks[0].id must match R-###')));
    assert.ok(first.violations.some((entry) => entry.includes('residual_risks[0].evidence must contain')));
    assert.ok(first.violations.some((entry) => entry.includes(`Expected coverage obligation '${categoryObligation.id}'`)));
    assert.ok(first.violations.some((entry) => entry.includes(`Coverage obligation '${fileObligation.id}' is duplicated`)));
    assert.ok(first.violations.some((entry) => entry.includes("Coverage obligation 'CATEGORY-UNKNOWN' is not part of the current contract")));
    assert.ok(first.violations.some((entry) => entry.includes('generic evidence')));
    assert.ok(first.violations.some((entry) => entry.includes("Coverage ledger references unknown finding 'F-999'")));
    assert.ok(first.violations.some((entry) => entry.includes("Finding 'F-001' is not referenced by any coverage ledger entry")));
});
