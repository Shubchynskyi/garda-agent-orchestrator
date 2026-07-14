import {
    createChangedFileLineCountResolver,
    formatReviewEvidenceLineCountSource,
    parseReviewEvidenceLocation
} from './review-coverage-ledger';

export const REVIEW_FINDINGS_SCHEMA_VERSION = 1 as const;

export const REVIEW_FINDINGS_ID_PATTERN = /^F-\d{3}$/u;
export const REVIEW_RESIDUAL_RISK_ID_PATTERN = /^R-\d{3}$/u;
export const REVIEW_VALIDATION_NOTE_ID_PATTERN = /^N-\d{3}$/u;

const REVIEW_FINDINGS_FORBIDDEN_DECISION_KEYS = new Set([
    'action',
    'decision',
    'fail',
    'failed',
    'fix_now',
    'ignore',
    'outcome',
    'pass',
    'passed',
    'policy',
    'remediation',
    'result',
    'status',
    'verdict'
]);

const REPORT_KEYS = new Set([
    'schema_version',
    'task_id',
    'review_type',
    'review_context_sha256',
    'tree_state_sha256',
    'validation_notes',
    'coverage_ledger',
    'findings',
    'residual_risks',
    'reviewer_notes'
]);
const VALIDATION_NOTE_KEYS = new Set(['id', 'topic', 'note', 'evidence']);
const COVERAGE_LEDGER_KEYS = new Set(['coverage_contract_sha256', 'entries']);
const COVERAGE_ENTRY_KEYS = new Set(['obligation_id', 'evidence', 'finding_ids']);
const FINDINGS_KEYS = new Set(['critical', 'high', 'medium', 'low']);
const FINDING_KEYS = new Set(['id', 'title', 'description', 'evidence', 'coverage_obligation_ids']);
const RESIDUAL_RISK_KEYS = new Set(['id', 'description', 'evidence']);
const EVIDENCE_KEYS = new Set(['location', 'observation']);

export type ReviewFindingsSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface ReviewFindingsEvidence {
    location: string;
    observation: string;
}

export interface ReviewFindingsValidationNote {
    id: string;
    topic: string;
    note: string;
    evidence: ReviewFindingsEvidence[];
}

export interface ReviewFindingsCoverageLedgerEntry {
    obligation_id: string;
    evidence: ReviewFindingsEvidence[];
    finding_ids: string[];
}

export interface ReviewFindingsCoverageLedger {
    coverage_contract_sha256: string;
    entries: ReviewFindingsCoverageLedgerEntry[];
}

export interface ReviewFinding {
    id: string;
    title: string;
    description: string;
    evidence: ReviewFindingsEvidence[];
    coverage_obligation_ids: string[];
}

export interface ReviewFindingsBySeverity {
    critical: ReviewFinding[];
    high: ReviewFinding[];
    medium: ReviewFinding[];
    low: ReviewFinding[];
}

export interface ReviewResidualRisk {
    id: string;
    description: string;
    evidence: ReviewFindingsEvidence[];
}

export interface ReviewFindingsReport {
    schema_version: typeof REVIEW_FINDINGS_SCHEMA_VERSION;
    task_id: string;
    review_type: string;
    review_context_sha256: string;
    tree_state_sha256: string;
    validation_notes: ReviewFindingsValidationNote[];
    coverage_ledger: ReviewFindingsCoverageLedger;
    findings: ReviewFindingsBySeverity;
    residual_risks: ReviewResidualRisk[];
    reviewer_notes: string[];
}

export interface ReviewFindingsValidationOptions {
    expectedTaskId: string;
    expectedReviewType: string;
    expectedCoverageObligationIds?: readonly string[];
    expectedChangedFilePaths?: readonly string[];
    expectedReviewContextSha256?: string;
    expectedTreeStateSha256?: string;
    repoRoot?: string;
    evidenceSnapshotCommit?: string;
}

export interface ReviewFindingsValidationResult {
    valid: boolean;
    report: ReviewFindingsReport | null;
    violations: string[];
}

export const reviewFindingsReportJsonSchema = {
    $id: 'garda-agent-orchestrator/review-findings-report.schema.json',
    $schema: 'http://json-schema.org/draft-07/schema#',
    type: 'object',
    additionalProperties: false,
    required: [
        'schema_version',
        'task_id',
        'review_type',
        'review_context_sha256',
        'tree_state_sha256',
        'validation_notes',
        'coverage_ledger',
        'findings',
        'residual_risks',
        'reviewer_notes'
    ],
    properties: {
        schema_version: { const: REVIEW_FINDINGS_SCHEMA_VERSION },
        task_id: { type: 'string', minLength: 1 },
        review_type: { type: 'string', minLength: 1 },
        review_context_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        tree_state_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
        validation_notes: {
            type: 'array',
            minItems: 1,
            items: { $ref: '#/definitions/validation_note' }
        },
        coverage_ledger: { $ref: '#/definitions/coverage_ledger' },
        findings: { $ref: '#/definitions/findings_by_severity' },
        residual_risks: {
            type: 'array',
            items: { $ref: '#/definitions/residual_risk' }
        },
        reviewer_notes: { type: 'array', items: { type: 'string' } }
    },
    definitions: {
        evidence: {
            type: 'object',
            additionalProperties: false,
            required: ['location', 'observation'],
            properties: {
                location: { type: 'string', minLength: 1 },
                observation: { type: 'string', minLength: 1 }
            }
        },
        validation_note: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'topic', 'note', 'evidence'],
            properties: {
                id: { type: 'string', pattern: '^N-\\d{3}$' },
                topic: { type: 'string', minLength: 1 },
                note: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                }
            }
        },
        coverage_ledger: {
            type: 'object',
            additionalProperties: false,
            required: ['coverage_contract_sha256', 'entries'],
            properties: {
                coverage_contract_sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
                entries: {
                    type: 'array',
                    items: { $ref: '#/definitions/coverage_entry' }
                }
            }
        },
        coverage_entry: {
            type: 'object',
            additionalProperties: false,
            required: ['obligation_id', 'evidence', 'finding_ids'],
            properties: {
                obligation_id: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                },
                finding_ids: {
                    type: 'array',
                    items: { type: 'string', pattern: '^F-\\d{3}$' }
                }
            }
        },
        findings_by_severity: {
            type: 'object',
            additionalProperties: false,
            required: ['critical', 'high', 'medium', 'low'],
            properties: {
                critical: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                },
                high: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                },
                medium: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                },
                low: {
                    type: 'array',
                    items: { $ref: '#/definitions/finding' }
                }
            }
        },
        finding: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'title', 'description', 'evidence', 'coverage_obligation_ids'],
            properties: {
                id: { type: 'string', pattern: '^F-\\d{3}$' },
                title: { type: 'string', minLength: 1 },
                description: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                },
                coverage_obligation_ids: {
                    type: 'array',
                    minItems: 1,
                    items: { type: 'string', minLength: 1 }
                }
            }
        },
        residual_risk: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'description', 'evidence'],
            properties: {
                id: { type: 'string', pattern: '^R-\\d{3}$' },
                description: { type: 'string', minLength: 1 },
                evidence: {
                    type: 'array',
                    minItems: 1,
                    items: { $ref: '#/definitions/evidence' }
                }
            }
        }
    }
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSha256(value: unknown): string | null {
    const normalized = normalizeString(value);
    return normalized && /^[a-f0-9]{64}$/u.test(normalized) ? normalized : null;
}

function pushUnknownKeyViolations(
    subject: string,
    input: Record<string, unknown>,
    allowedKeys: ReadonlySet<string>,
    violations: string[]
): void {
    for (const key of Object.keys(input)) {
        if (!allowedKeys.has(key)) {
            violations.push(`${subject} contains unknown field '${key}'.`);
        }
    }
}

function collectForbiddenDecisionKeys(value: unknown, path: string, violations: string[]): void {
    if (Array.isArray(value)) {
        value.forEach((entry, index) => collectForbiddenDecisionKeys(entry, `${path}[${index}]`, violations));
        return;
    }
    if (!isRecord(value)) {
        return;
    }
    for (const [key, nestedValue] of Object.entries(value)) {
        if (REVIEW_FINDINGS_FORBIDDEN_DECISION_KEYS.has(key.toLowerCase())) {
            violations.push(`${path}.${key} is a reviewer-owned verdict/remediation decision field and is forbidden.`);
        }
        collectForbiddenDecisionKeys(nestedValue, `${path}.${key}`, violations);
    }
}

function parseEvidenceArray(value: unknown, subject: string, violations: string[]): ReviewFindingsEvidence[] {
    if (!Array.isArray(value)) {
        violations.push(`${subject}.evidence must be an array.`);
        return [];
    }
    const evidence: ReviewFindingsEvidence[] = [];
    value.forEach((entry, index) => {
        const entrySubject = `${subject}.evidence[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${entrySubject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(entrySubject, entry, EVIDENCE_KEYS, violations);
        const location = normalizeString(entry.location);
        const observation = normalizeString(entry.observation);
        if (!location) {
            violations.push(`${entrySubject}.location is required.`);
        }
        if (!observation) {
            violations.push(`${entrySubject}.observation is required.`);
        }
        if (location && observation) {
            evidence.push({ location, observation });
        }
    });
    if (evidence.length === 0) {
        violations.push(`${subject}.evidence must contain at least one concrete evidence item.`);
    }
    return evidence;
}

function parseStringArray(value: unknown, subject: string, violations: string[]): string[] {
    if (!Array.isArray(value)) {
        violations.push(`${subject} must be an array.`);
        return [];
    }
    const entries: string[] = [];
    value.forEach((entry, index) => {
        const normalized = normalizeString(entry);
        if (!normalized) {
            violations.push(`${subject}[${index}] must be a non-empty string.`);
            return;
        }
        entries.push(normalized);
    });
    return entries;
}

function parseValidationNotes(value: unknown, violations: string[]): ReviewFindingsValidationNote[] {
    if (!Array.isArray(value)) {
        violations.push('validation_notes must be an array.');
        return [];
    }
    const notes: ReviewFindingsValidationNote[] = [];
    const ids: string[] = [];
    value.forEach((entry, index) => {
        const subject = `validation_notes[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${subject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(subject, entry, VALIDATION_NOTE_KEYS, violations);
        const id = normalizeString(entry.id);
        const topic = normalizeString(entry.topic);
        const note = normalizeString(entry.note);
        const evidence = parseEvidenceArray(entry.evidence, subject, violations);
        if (!id || !REVIEW_VALIDATION_NOTE_ID_PATTERN.test(id)) {
            violations.push(`${subject}.id must match N-###.`);
        }
        if (!topic) {
            violations.push(`${subject}.topic is required.`);
        }
        if (!note) {
            violations.push(`${subject}.note is required.`);
        }
        if (id && REVIEW_VALIDATION_NOTE_ID_PATTERN.test(id)) {
            ids.push(id);
        }
        if (id && topic && note && evidence.length > 0) {
            notes.push({ id, topic, note, evidence });
        }
    });
    pushDuplicateViolations('validation note', ids, violations);
    if (notes.length === 0) {
        violations.push('validation_notes must contain at least one validation note.');
    }
    return notes;
}

function parseCoverageLedger(value: unknown, violations: string[]): ReviewFindingsCoverageLedger | null {
    if (!isRecord(value)) {
        violations.push('coverage_ledger must be an object.');
        return null;
    }
    pushUnknownKeyViolations('coverage_ledger', value, COVERAGE_LEDGER_KEYS, violations);
    const coverageContractSha256 = normalizeSha256(value.coverage_contract_sha256);
    if (!coverageContractSha256) {
        violations.push('coverage_ledger.coverage_contract_sha256 must be a SHA-256 hex string.');
    }
    if (!Array.isArray(value.entries)) {
        violations.push('coverage_ledger.entries must be an array.');
        return coverageContractSha256 ? { coverage_contract_sha256: coverageContractSha256, entries: [] } : null;
    }
    const entries: ReviewFindingsCoverageLedgerEntry[] = [];
    const obligationIds: string[] = [];
    value.entries.forEach((entry, index) => {
        const subject = `coverage_ledger.entries[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${subject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(subject, entry, COVERAGE_ENTRY_KEYS, violations);
        const obligationId = normalizeString(entry.obligation_id);
        if (!obligationId) {
            violations.push(`${subject}.obligation_id is required.`);
        }
        const evidence = parseEvidenceArray(entry.evidence, subject, violations);
        const findingIds = parseStringArray(entry.finding_ids, `${subject}.finding_ids`, violations);
        findingIds
            .filter((findingId) => !REVIEW_FINDINGS_ID_PATTERN.test(findingId))
            .forEach((findingId) => violations.push(`${subject}.finding_ids contains invalid finding id '${findingId}'.`));
        if (obligationId) {
            obligationIds.push(obligationId);
        }
        if (obligationId && evidence.length > 0) {
            entries.push({
                obligation_id: obligationId,
                evidence,
                finding_ids: findingIds
            });
        }
    });
    pushDuplicateViolations('coverage obligation', obligationIds, violations);
    return coverageContractSha256 ? { coverage_contract_sha256: coverageContractSha256, entries } : null;
}

function validateEvidenceLocations(
    evidenceItems: readonly ReviewFindingsEvidence[],
    subject: string,
    changedFiles: ReadonlySet<string>,
    getChangedFileLineCount: ((filePath: string) => { count: number; source: 'current' | 'head' | 'bound-snapshot' } | null) | null,
    violations: string[]
): void {
    for (const [evidenceIndex, evidence] of evidenceItems.entries()) {
        const evidenceSubject = `${subject}.evidence[${evidenceIndex}]`;
        const location = parseReviewEvidenceLocation(evidence.location);
        if (!location || !changedFiles.has(location.filePath)) {
            violations.push(
                `${evidenceSubject}.location '${evidence.location}' must be a current changed-file path:line.`
            );
            continue;
        }
        if (getChangedFileLineCount) {
            const lineEvidence = getChangedFileLineCount(location.filePath);
            if (lineEvidence == null) {
                violations.push(
                    `${evidenceSubject}.location '${evidence.location}' references a changed file that is unreadable in both the current repository and HEAD snapshot.`
                );
            } else if (location.line > lineEvidence.count) {
                violations.push(
                    `${evidenceSubject}.location '${evidence.location}' exceeds ` +
                    `${formatReviewEvidenceLineCountSource(lineEvidence.source)} line count ${lineEvidence.count}.`
                );
            }
        }
    }
}

function validateConcreteReviewEvidenceLocations(
    reportParts: {
        validationNotes: readonly ReviewFindingsValidationNote[];
        coverageLedger: ReviewFindingsCoverageLedger | null;
        findings: ReviewFindingsBySeverity | null;
        residualRisks: readonly ReviewResidualRisk[];
    },
    expectedChangedFilePaths: readonly string[] | undefined,
    lineValidationOptions: { repoRoot?: string; evidenceSnapshotCommit?: string },
    violations: string[]
): void {
    if (!expectedChangedFilePaths) {
        return;
    }
    const changedFiles = new Set(
        expectedChangedFilePaths
            .map((entry) => entry.trim().replace(/\\/g, '/'))
            .filter(Boolean)
    );
    if (changedFiles.size === 0) {
        return;
    }
    const getChangedFileLineCount = lineValidationOptions.repoRoot
        ? createChangedFileLineCountResolver(lineValidationOptions)
        : null;

    for (const [noteIndex, note] of reportParts.validationNotes.entries()) {
        validateEvidenceLocations(note.evidence, `validation_notes[${noteIndex}]`, changedFiles, getChangedFileLineCount, violations);
    }
    if (reportParts.coverageLedger) {
        for (const [entryIndex, entry] of reportParts.coverageLedger.entries.entries()) {
            validateEvidenceLocations(
                entry.evidence,
                `coverage_ledger.entries[${entryIndex}]`,
                changedFiles,
                getChangedFileLineCount,
                violations
            );
        }
    }
    if (reportParts.findings) {
        for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
            for (const [findingIndex, finding] of reportParts.findings[severity].entries()) {
                validateEvidenceLocations(
                    finding.evidence,
                    `findings.${severity}[${findingIndex}]`,
                    changedFiles,
                    getChangedFileLineCount,
                    violations
                );
            }
        }
    }
    for (const [riskIndex, risk] of reportParts.residualRisks.entries()) {
        validateEvidenceLocations(risk.evidence, `residual_risks[${riskIndex}]`, changedFiles, getChangedFileLineCount, violations);
    }
}

function parseFindings(value: unknown, violations: string[]): ReviewFindingsBySeverity | null {
    if (!isRecord(value)) {
        violations.push('findings must be an object.');
        return null;
    }
    pushUnknownKeyViolations('findings', value, FINDINGS_KEYS, violations);
    const result: ReviewFindingsBySeverity = { critical: [], high: [], medium: [], low: [] };
    const ids: string[] = [];
    for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
        if (!Array.isArray(value[severity])) {
            violations.push(`findings.${severity} must be an array.`);
            continue;
        }
        (value[severity] as unknown[]).forEach((entry, index) => {
            const subject = `findings.${severity}[${index}]`;
            if (!isRecord(entry)) {
                violations.push(`${subject} must be an object.`);
                return;
            }
            pushUnknownKeyViolations(subject, entry, FINDING_KEYS, violations);
            const id = normalizeString(entry.id);
            const title = normalizeString(entry.title);
            const description = normalizeString(entry.description);
            const evidence = parseEvidenceArray(entry.evidence, subject, violations);
            const coverageObligationIds = parseStringArray(
                entry.coverage_obligation_ids,
                `${subject}.coverage_obligation_ids`,
                violations
            );
            if (!id || !REVIEW_FINDINGS_ID_PATTERN.test(id)) {
                violations.push(`${subject}.id must match F-###.`);
            }
            if (!title) {
                violations.push(`${subject}.title is required.`);
            }
            if (!description) {
                violations.push(`${subject}.description is required.`);
            }
            if (coverageObligationIds.length === 0) {
                violations.push(`${subject}.coverage_obligation_ids must contain at least one obligation id.`);
            }
            if (id && REVIEW_FINDINGS_ID_PATTERN.test(id)) {
                ids.push(id);
            }
            if (id && title && description && evidence.length > 0 && coverageObligationIds.length > 0) {
                result[severity].push({ id, title, description, evidence, coverage_obligation_ids: coverageObligationIds });
            }
        });
    }
    pushDuplicateViolations('finding', ids, violations);
    return result;
}

function parseResidualRisks(value: unknown, violations: string[]): ReviewResidualRisk[] {
    if (!Array.isArray(value)) {
        violations.push('residual_risks must be an array.');
        return [];
    }
    const risks: ReviewResidualRisk[] = [];
    const ids: string[] = [];
    value.forEach((entry, index) => {
        const subject = `residual_risks[${index}]`;
        if (!isRecord(entry)) {
            violations.push(`${subject} must be an object.`);
            return;
        }
        pushUnknownKeyViolations(subject, entry, RESIDUAL_RISK_KEYS, violations);
        const id = normalizeString(entry.id);
        const description = normalizeString(entry.description);
        const evidence = parseEvidenceArray(entry.evidence, subject, violations);
        if (!id || !REVIEW_RESIDUAL_RISK_ID_PATTERN.test(id)) {
            violations.push(`${subject}.id must match R-###.`);
        }
        if (!description) {
            violations.push(`${subject}.description is required.`);
        }
        if (id && REVIEW_RESIDUAL_RISK_ID_PATTERN.test(id)) {
            ids.push(id);
        }
        if (id && description && evidence.length > 0) {
            risks.push({ id, description, evidence });
        }
    });
    pushDuplicateViolations('residual risk', ids, violations);
    return risks;
}

function parseReviewerNotes(value: unknown, violations: string[]): string[] {
    return parseStringArray(value, 'reviewer_notes', violations);
}

function pushDuplicateViolations(subject: string, ids: readonly string[], violations: string[]): void {
    const duplicates = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))].sort();
    duplicates.forEach((id) => violations.push(`Duplicate ${subject} id '${id}'.`));
}

function getAllFindings(findings: ReviewFindingsBySeverity | null): ReviewFinding[] {
    if (!findings) {
        return [];
    }
    return [...findings.critical, ...findings.high, ...findings.medium, ...findings.low];
}

function validateCrossReferences(
    report: Pick<ReviewFindingsReport, 'coverage_ledger' | 'findings'>,
    expectedCoverageObligationIds: readonly string[] | undefined,
    violations: string[]
): void {
    const coverageIds = report.coverage_ledger.entries.map((entry) => entry.obligation_id);
    if (expectedCoverageObligationIds) {
        const expected = [...new Set(expectedCoverageObligationIds)].sort();
        const actual = [...new Set(coverageIds)].sort();
        expected
            .filter((id) => !actual.includes(id))
            .forEach((id) => violations.push(`Expected coverage obligation '${id}' is missing from coverage_ledger.entries.`));
        actual
            .filter((id) => !expected.includes(id))
            .forEach((id) => violations.push(`Coverage obligation '${id}' is not part of the expected coverage contract.`));
    }

    const findings = getAllFindings(report.findings);
    const findingIds = findings.map((finding) => finding.id);
    const findingIdsReferencedByCoverage = new Set(report.coverage_ledger.entries.flatMap((entry) => entry.finding_ids));
    const coverageIdsSet = new Set(coverageIds);
    const coverageEntriesById = new Map(report.coverage_ledger.entries.map((entry) => [entry.obligation_id, entry]));
    const findingsById = new Map(findings.map((finding) => [finding.id, finding]));
    if (findings.length === 0 && !expectedCoverageObligationIds) {
        violations.push('Empty findings require expected coverage obligation ids to prove complete coverage.');
    }
    for (const finding of findings) {
        for (const obligationId of finding.coverage_obligation_ids) {
            const coverageEntry = coverageEntriesById.get(obligationId);
            if (!coverageIdsSet.has(obligationId) || !coverageEntry) {
                violations.push(`Finding '${finding.id}' references unknown coverage obligation '${obligationId}'.`);
                continue;
            }
            if (!coverageEntry.finding_ids.includes(finding.id)) {
                violations.push(`Finding '${finding.id}' references coverage obligation '${obligationId}' but that coverage ledger entry does not reference the finding.`);
            }
        }
        if (!findingIdsReferencedByCoverage.has(finding.id)) {
            violations.push(`Finding '${finding.id}' is not referenced by any coverage ledger entry.`);
        }
    }
    for (const findingId of findingIdsReferencedByCoverage) {
        if (!findingIds.includes(findingId)) {
            violations.push(`Coverage ledger references unknown finding '${findingId}'.`);
        }
    }
    for (const entry of report.coverage_ledger.entries) {
        for (const findingId of entry.finding_ids) {
            const finding = findingsById.get(findingId);
            if (finding && !finding.coverage_obligation_ids.includes(entry.obligation_id)) {
                violations.push(`Coverage ledger entry '${entry.obligation_id}' references finding '${findingId}' but that finding does not reference the coverage obligation.`);
            }
        }
    }
    if (findings.length === 0 && report.coverage_ledger.entries.length === 0) {
        violations.push('Empty findings are valid only with complete coverage ledger evidence.');
    }
}

export function validateReviewFindingsReport(
    value: unknown,
    options: ReviewFindingsValidationOptions
): ReviewFindingsValidationResult {
    const violations: string[] = [];
    collectForbiddenDecisionKeys(value, '$', violations);
    if (!isRecord(value)) {
        return {
            valid: false,
            report: null,
            violations: ['review findings report must be a JSON object.', ...violations]
        };
    }
    pushUnknownKeyViolations('report', value, REPORT_KEYS, violations);
    if (value.schema_version !== REVIEW_FINDINGS_SCHEMA_VERSION) {
        violations.push(`schema_version must be ${REVIEW_FINDINGS_SCHEMA_VERSION}.`);
    }
    const taskId = normalizeString(value.task_id);
    const reviewType = normalizeString(value.review_type)?.toLowerCase() || null;
    const reviewContextSha256 = normalizeSha256(value.review_context_sha256);
    const treeStateSha256 = normalizeSha256(value.tree_state_sha256);
    if (!taskId) {
        violations.push('task_id is required.');
    } else if (taskId !== options.expectedTaskId) {
        violations.push(`task_id '${taskId}' does not match expected task '${options.expectedTaskId}'.`);
    }
    const expectedReviewType = options.expectedReviewType.trim().toLowerCase();
    if (!reviewType) {
        violations.push('review_type is required.');
    } else if (reviewType !== expectedReviewType) {
        violations.push(`review_type '${reviewType}' does not match expected review '${expectedReviewType}'.`);
    }
    if (!reviewContextSha256) {
        violations.push('review_context_sha256 must be a SHA-256 hex string.');
    } else if (
        options.expectedReviewContextSha256
        && reviewContextSha256 !== options.expectedReviewContextSha256
    ) {
        violations.push('review_context_sha256 does not match the current review context.');
    }
    if (!treeStateSha256) {
        violations.push('tree_state_sha256 must be a SHA-256 hex string.');
    } else if (options.expectedTreeStateSha256 && treeStateSha256 !== options.expectedTreeStateSha256) {
        violations.push('tree_state_sha256 does not match the current review tree state.');
    }

    const validationNotes = parseValidationNotes(value.validation_notes, violations);
    const coverageLedger = parseCoverageLedger(value.coverage_ledger, violations);
    const findings = parseFindings(value.findings, violations);
    const residualRisks = parseResidualRisks(value.residual_risks, violations);
    const reviewerNotes = parseReviewerNotes(value.reviewer_notes, violations);
    validateConcreteReviewEvidenceLocations(
        { validationNotes, coverageLedger, findings, residualRisks },
        options.expectedChangedFilePaths,
        {
            repoRoot: options.repoRoot,
            evidenceSnapshotCommit: options.evidenceSnapshotCommit
        },
        violations
    );
    if (coverageLedger && findings) {
        validateCrossReferences({
            coverage_ledger: coverageLedger,
            findings
        }, options.expectedCoverageObligationIds, violations);
    }

    const report = taskId && reviewType && reviewContextSha256 && treeStateSha256 && coverageLedger && findings
        ? {
            schema_version: REVIEW_FINDINGS_SCHEMA_VERSION,
            task_id: taskId,
            review_type: reviewType,
            review_context_sha256: reviewContextSha256,
            tree_state_sha256: treeStateSha256,
            validation_notes: validationNotes,
            coverage_ledger: coverageLedger,
            findings,
            residual_risks: residualRisks,
            reviewer_notes: reviewerNotes
        }
        : null;

    return {
        valid: violations.length === 0,
        report: violations.length === 0 ? report : null,
        violations
    };
}
