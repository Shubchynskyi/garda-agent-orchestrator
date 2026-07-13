import assert from 'node:assert/strict';
import test from 'node:test';

import {
    REVIEW_FINDINGS_SCHEMA_VERSION,
    reviewFindingsReportJsonSchema,
    validateReviewFindingsReport
} from '../../../../src/gates/review/review-findings-schema';

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

test('validateReviewFindingsReport rejects empty findings when expected coverage obligations are omitted', () => {
    const result = validateReviewFindingsReport(validReport(), {
        expectedTaskId: 'T-979-1',
        expectedReviewType: 'code',
        expectedReviewContextSha256: HASH_A,
        expectedTreeStateSha256: HASH_B
    });

    assert.equal(result.valid, false);
    assert.ok(result.violations.some((entry) => entry.includes('Empty findings require expected coverage obligation ids')));
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

test('validateReviewFindingsReport accepts high, medium, and low findings bound to coverage evidence', () => {
    const report = validReport();
    report.coverage_ledger = {
        coverage_contract_sha256: CONTRACT_HASH,
        entries: [
            {
                obligation_id: 'FILE-001',
                evidence: [evidence()],
                finding_ids: ['F-001', 'F-002']
            },
            {
                obligation_id: 'CATEGORY-SCHEMA',
                evidence: [evidence('src/example.ts:20', 'Concrete schema category validation was inspected')],
                finding_ids: ['F-003']
            }
        ]
    };
    report.findings = {
        high: [{
            id: 'F-001',
            title: 'Missing task binding',
            description: 'The schema accepts a foreign task identifier.',
            evidence: [evidence()],
            coverage_obligation_ids: ['FILE-001']
        }],
        medium: [{
            id: 'F-002',
            title: 'Missing review binding',
            description: 'The schema accepts a foreign review type.',
            evidence: [evidence('src/example.ts:11', 'Concrete review-type branch was inspected')],
            coverage_obligation_ids: ['FILE-001']
        }],
        low: [{
            id: 'F-003',
            title: 'Weak reviewer note validation',
            description: 'The schema accepts empty reviewer notes.',
            evidence: [evidence('src/example.ts:20', 'Concrete note validation branch was inspected')],
            coverage_obligation_ids: ['CATEGORY-SCHEMA']
        }]
    };

    const result = validateReviewFindingsReport(report, validationOptions);

    assert.equal(result.valid, true);
    assert.deepEqual(result.report?.findings.high.map((entry) => entry.id), ['F-001']);
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
