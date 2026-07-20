import * as fs from 'node:fs';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import {
    buildReviewReceipt,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt
} from '../../gate-runtime/review-context';
import {
    assertReviewArtifactFileSha256,
    writeReviewArtifactsWithRollback
} from '../../gate-runtime/review-artifacts';
import {
    emitReviewRecordedEventAsync
} from '../../gate-runtime/lifecycle-events';
import { taskEventAppendHasBlockingFailure } from '../../gate-runtime/task-events';
import * as gateHelpers from '../shared/helpers';
import {
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint
} from './review-reuse';
import {
    buildDomainScopeFingerprints,
    normalizeDomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import type { HistoricalReviewReuseCandidate } from './review-reuse-validation';
import {
    getReviewCoverageContractViolations,
    getReviewCoverageValidationSummaryContractViolations,
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import { resolveReviewCoverageChangedFiles } from '../review-context/review-coverage-scope';
import {
    type JsonReviewFindingsArtifactValidation
} from '../review/review-findings-artifact-verdict';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath,
    reviewFindingsValidationArtifactContainsMissingFocusedValidation,
    validateReviewFindingsValidationArtifactForReceipt,
    type ReviewFindingsValidationArtifact
} from '../review/review-findings-validation-artifact';
import {
    buildReviewFindingsDispositionArtifact,
    getReviewFindingsDispositionArtifactPath,
    getReviewFindingsDispositionArtifactSnapshotPath,
    type ReviewFindingsDispositionArtifact
} from '../review/review-findings-disposition-artifact';
import type { ReviewFindingsReport } from '../review/review-findings-schema';
import {
    type LockedReviewFindingPolicyResolution,
    resolveLockedReviewFindingPolicyFromReceiptDisposition,
    reviewFindingsValidationArtifactHasBlockingFindings
} from '../review/review-finding-disposition';

export interface MaterializeReusedReviewEvidenceOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath?: string | null;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    artifactPath: string;
    receiptPath: string;
    nonTestReviewScope: boolean;
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>;
    reviewScopeFingerprint: ReturnType<typeof computeReviewRelevantScopeFingerprint>;
    currentPreflightHash: string | null;
    currentReviewContextSha256: string | null;
    currentReviewTreeStateSha256: string | null;
    currentContextReuseSha256: string | null;
    candidate: HistoricalReviewReuseCandidate;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    receipt: ReviewReceipt;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    historicalReviewerProvenance: NonNullable<ReturnType<typeof normalizeReviewReceiptReviewerProvenance>>;
    expectedContextSha256: string | null;
    expectedContextReuseSha256: string | null;
    expectedReviewTreeStateSha256: string | null;
    expectedReviewScopeSha256: string | null;
    expectedCodeScopeSha256: string | null;
    historicalReviewArtifactSha256: string;
    artifactText: string;
}

interface ReusedReviewFindingsValidationEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsValidationArtifact;
    validation: JsonReviewFindingsArtifactValidation;
    rawOutputSha256: string | null;
    policyResolution: LockedReviewFindingPolicyResolution;
    dispositionEvidence: ReusedReviewFindingsDispositionEvidence;
}

interface ReusedReviewFindingsDispositionEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsDispositionArtifact;
}

function normalizeSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getReceiptRecordString(receipt: ReviewReceipt, key: string): string | null {
    const value = (receipt as unknown as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getReceiptOutputContract(receipt: ReviewReceipt): Record<string, unknown> | null {
    const contract = (receipt as unknown as Record<string, unknown>).review_output_contract;
    return contract && typeof contract === 'object' && !Array.isArray(contract)
        ? contract as Record<string, unknown>
        : null;
}

function getReceiptOutputContractString(receipt: ReviewReceipt, key: string): string | null {
    const value = getReceiptOutputContract(receipt)?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function summarizeReviewFindingsReport(report: ReviewFindingsReport): Record<string, unknown> {
    return {
        finding_counts: {
            critical: report.findings.critical.length,
            high: report.findings.high.length,
            medium: report.findings.medium.length,
            low: report.findings.low.length
        },
        residual_risk_count: report.residual_risks.length,
        coverage_entry_count: report.coverage_ledger.entries.length
    };
}

function summarizeReviewFindingsValidationEvidence(
    evidence: ReusedReviewFindingsValidationEvidence
): Record<string, unknown> {
    return {
        artifact_path: gateHelpers.normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: gateHelpers.normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        status: evidence.payload.validation_result.status,
        accepted: evidence.payload.validation_result.accepted,
        validation_result_sha256: evidence.payload.validation_result_sha256,
        violation_count: evidence.payload.validation_result.violations.length
    };
}

function summarizeReviewFindingsDispositionEvidence(
    evidence: ReusedReviewFindingsDispositionEvidence
): Record<string, unknown> {
    return {
        artifact_path: gateHelpers.normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: gateHelpers.normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        disposition_result_sha256: evidence.payload.disposition_result_sha256,
        policy_id: evidence.payload.policy.policy_id,
        policy_source: evidence.payload.policy.policy_source,
        item_count: evidence.payload.summary.item_count,
        fix_now_count: evidence.payload.summary.fix_now_count,
        follow_up_pending_count: evidence.payload.summary.follow_up_pending_count,
        ignored_count: evidence.payload.summary.ignored_count,
        blocking_count: evidence.payload.summary.blocking_count
    };
}

function getReviewEvidenceLocationFilePath(location: string): string | null {
    const normalized = gateHelpers.normalizePath(String(location || '').trim());
    const match = normalized.match(/^(.+?):\d+(?::\d+)?$/u);
    return match?.[1] ? gateHelpers.normalizePath(match[1]) : null;
}

function buildHistoricalCoverageContractFromReport(
    report: ReviewFindingsReport,
    reviewType: string
): ReviewCoverageContract | null {
    const contractSha256 = normalizeSha256(report.coverage_ledger.coverage_contract_sha256);
    if (!contractSha256) {
        return null;
    }
    const obligations = report.coverage_ledger.entries.map((entry) => {
        const target = entry.evidence
            .map((evidence) => getReviewEvidenceLocationFilePath(evidence.location))
            .find((filePath): filePath is string => !!filePath)
            || `review-evidence/${entry.obligation_id}.txt`;
        return {
            id: entry.obligation_id,
            kind: 'file' as const,
            target
        };
    });
    return {
        schema_version: 1,
        required: obligations.length > 0,
        review_type: reviewType,
        obligations,
        obligation_count: obligations.length,
        contract_sha256: contractSha256
    };
}

function getReceiptBoundFindingsReviewArtifactPath(receipt: ReviewReceipt | null | undefined): string | null {
    if (!receipt) {
        return null;
    }
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    const reference = receiptRecord.review_findings_validation
        && typeof receiptRecord.review_findings_validation === 'object'
        && !Array.isArray(receiptRecord.review_findings_validation)
        ? receiptRecord.review_findings_validation as Record<string, unknown>
        : null;
    const artifactPath = typeof reference?.artifact_path === 'string'
        ? gateHelpers.normalizePath(reference.artifact_path)
        : null;
    if (!artifactPath?.endsWith('-findings-validation.json')) {
        return null;
    }
    return artifactPath.replace(/-findings-validation\.json$/u, '.md');
}

export async function materializeReusedReviewEvidence(
    options: MaterializeReusedReviewEvidenceOptions
): Promise<{ materialized: boolean; reason: string | null }> {
    const currentReviewContext = JSON.parse(
        fs.readFileSync(options.reviewContextPath, 'utf8')
    ) as Record<string, unknown>;
    const currentReviewContextSchemaVersion = Number(currentReviewContext.schema_version);
    if (!Number.isInteger(currentReviewContextSchemaVersion) || currentReviewContextSchemaVersion < 3) {
        return {
            materialized: false,
            reason: 'reused review current context must use schema_version 3 or newer; legacy contexts cannot be rematerialized'
        };
    }
    if (currentReviewContextSchemaVersion >= 3) {
        const authoritativeCoverageChangedFiles = resolveReviewCoverageChangedFiles({
            reviewType: options.reviewType,
            preflight: options.preflightPayload,
            repoRoot: options.repoRoot
        });
        const coverageContractViolations = getReviewCoverageContractViolations(
            currentReviewContext.coverage_contract,
            {
                reviewType: options.reviewType,
                changedFiles: authoritativeCoverageChangedFiles
            }
        );
        if (coverageContractViolations.length > 0) {
            return {
                materialized: false,
                reason: `reused review coverage contract validation failed: ${coverageContractViolations.join(' ')}`
            };
        }
        const findingsValidationEvidence = buildReusedReviewFindingsValidationEvidence(options);
        if ('reason' in findingsValidationEvidence) {
            return {
                materialized: false,
                reason: findingsValidationEvidence.reason
            };
        }
        const reviewCoverage = findingsValidationEvidence.evidence.validation.coverage_validation;
        if (!reviewCoverage || reviewCoverage.status !== 'PASS') {
            return {
                materialized: false,
                reason: `reused review coverage validation failed: ${reviewCoverage?.violations.join(' ') || 'coverage ledger validation is missing'}`
            };
        }
        const coverageCompatibilityViolations = getReviewCoverageValidationSummaryContractViolations(
            reviewCoverage,
            currentReviewContext.coverage_contract as ReviewCoverageContract
        );
        if (coverageCompatibilityViolations.length > 0) {
            return {
                materialized: false,
                reason: `reused review coverage contract does not match the current review context: ${coverageCompatibilityViolations.join('; ')}`
            };
        }
        const refreshedReceipt = buildReusedReviewReceipt(options);
        (refreshedReceipt as unknown as Record<string, unknown>).review_coverage = reviewCoverage;
        attachReusedReviewFindingsReceiptEvidence(refreshedReceipt, findingsValidationEvidence.evidence);
        return persistReusedReviewEvidence(options, refreshedReceipt, findingsValidationEvidence.evidence);
    }
    return persistReusedReviewEvidence(options, buildReusedReviewReceipt(options));
}

async function persistReusedReviewEvidence(
    options: MaterializeReusedReviewEvidenceOptions,
    refreshedReceipt: ReviewReceipt,
    findingsValidationEvidence: ReusedReviewFindingsValidationEvidence | null = null
): Promise<{ materialized: boolean; reason: string | null }> {
    const receiptPayloadSha256 = sha256RedactedJsonPayload(refreshedReceipt);
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(
        /\.md$/,
        `-artifact-${options.historicalReviewArtifactSha256}.md`
    );
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');

    try {
        await writeReviewArtifactsWithRollback([
            {
                artifactPath: options.artifactPath,
                contentType: 'text',
                content: options.artifactText
            },
            {
                artifactPath: artifactSnapshotPath,
                contentType: 'text',
                content: options.artifactText
            },
            {
                artifactPath: options.receiptPath,
                contentType: 'json',
                payload: refreshedReceipt
            },
            {
                artifactPath: receiptSnapshotPath,
                contentType: 'json',
                payload: refreshedReceipt
            },
            ...(findingsValidationEvidence
                ? [
                    {
                        artifactPath: findingsValidationEvidence.artifactPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.payload
                    },
                    {
                        artifactPath: findingsValidationEvidence.snapshotPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.payload
                    },
                    {
                        artifactPath: findingsValidationEvidence.dispositionEvidence.artifactPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.dispositionEvidence.payload
                    },
                    {
                        artifactPath: findingsValidationEvidence.dispositionEvidence.snapshotPath,
                        contentType: 'json' as const,
                        payload: findingsValidationEvidence.dispositionEvidence.payload
                    }
                ]
                : [])
        ], async () => {
            assertReviewArtifactFileSha256(
                options.artifactPath,
                options.historicalReviewArtifactSha256,
                'Reused review artifact'
            );
            assertReviewArtifactFileSha256(
                artifactSnapshotPath,
                options.historicalReviewArtifactSha256,
                'Reused review artifact snapshot'
            );
            assertReviewArtifactFileSha256(options.receiptPath, receiptPayloadSha256, 'Reused review receipt');
            assertReviewArtifactFileSha256(receiptSnapshotPath, receiptPayloadSha256, 'Reused review receipt snapshot');
            if (findingsValidationEvidence) {
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.artifactPath,
                    findingsValidationEvidence.artifactSha256,
                    'Reused review findings validation artifact'
                );
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.snapshotPath,
                    findingsValidationEvidence.artifactSha256,
                    'Reused review findings validation snapshot'
                );
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.dispositionEvidence.artifactPath,
                    findingsValidationEvidence.dispositionEvidence.artifactSha256,
                    'Reused review findings disposition artifact'
                );
                assertReviewArtifactFileSha256(
                    findingsValidationEvidence.dispositionEvidence.snapshotPath,
                    findingsValidationEvidence.dispositionEvidence.artifactSha256,
                    'Reused review findings disposition snapshot'
                );
            }
            const recordedEvent = await emitReviewRecordedEventAsync(
                orchestratorRoot,
                options.taskId,
                options.reviewType,
                buildReuseRecordedEventDetails({
                    options,
                    refreshedReceipt,
                    receiptPayloadSha256,
                    receiptSnapshotPath,
                    artifactSnapshotPath
                })
            );
            if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
                throw new Error('REVIEW_RECORDED telemetry could not be persisted for review reuse.');
            }
        });
        return { materialized: true, reason: null };
    } catch {
        return {
            materialized: false,
            reason: 'current-cycle REVIEW_RECORDED reuse telemetry could not be persisted'
        };
    }
}

function buildReusedReviewFindingsDispositionEvidence(options: {
    taskId: string;
    reviewType: string;
    reviewArtifactPath: string;
    validationArtifact: ReviewFindingsValidationArtifact;
    validationArtifactPath: string;
    validationArtifactSha256: string;
    policyResolution: LockedReviewFindingPolicyResolution;
}): ReusedReviewFindingsDispositionEvidence {
    const artifactPath = getReviewFindingsDispositionArtifactPath(options.reviewArtifactPath);
    const payload = buildReviewFindingsDispositionArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validationArtifact: options.validationArtifact,
        validationArtifactPath: options.validationArtifactPath,
        validationArtifactSha256: options.validationArtifactSha256,
        policyResolution: options.policyResolution
    });
    const artifactSha256 = sha256RedactedJsonPayload(payload);
    return {
        artifactPath,
        snapshotPath: getReviewFindingsDispositionArtifactSnapshotPath(artifactPath, artifactSha256),
        artifactSha256,
        payload
    };
}

function buildReusedReviewFindingsValidationEvidence(
    options: MaterializeReusedReviewEvidenceOptions
): { evidence: ReusedReviewFindingsValidationEvidence } | { reason: string } {
    if (!options.receipt) {
        return { reason: 'reused review findings validation failed: source receipt is missing.' };
    }
    const sourceReviewArtifactPath = getReceiptBoundFindingsReviewArtifactPath(options.receipt)
        || options.candidate.sourceArtifactPath
        || options.artifactPath;
    const sourceValidation = validateReviewFindingsValidationArtifactForReceipt({
        receipt: options.receipt as unknown as Record<string, unknown>,
        reviewArtifactPath: sourceReviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: getReceiptRecordString(options.receipt, 'review_output_sha256')
            || getReceiptOutputContractString(options.receipt, 'raw_output_sha256'),
        expectedReviewArtifactSha256: options.historicalReviewArtifactSha256,
        expectedReviewContextSha256: options.expectedContextSha256,
        expectedPreflightSha256: getReceiptRecordString(options.receipt, 'preflight_sha256'),
        expectedScopeSha256: getReceiptRecordString(options.receipt, 'scope_sha256'),
        expectedReviewScopeSha256: options.expectedReviewScopeSha256,
        expectedCodeScopeSha256: options.expectedCodeScopeSha256,
        expectedReviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        expectedCoverageContractSha256: getReceiptOutputContractString(options.receipt, 'coverage_contract_sha256'),
        requireAccepted: true,
        preferSnapshot: true
    });
    if (!sourceValidation.valid || !sourceValidation.artifact) {
        return { reason: `reused review findings validation failed: ${sourceValidation.violations.join(' ')}` };
    }
    const policyResolution = resolveLockedReviewFindingPolicyFromReceiptDisposition(
        options.receipt as unknown as Record<string, unknown>
    );
    if (reviewFindingsValidationArtifactContainsMissingFocusedValidation(sourceValidation.artifact)) {
        return { reason: 'reused review findings validation contains missing focused validation evidence' };
    }
    if (reviewFindingsValidationArtifactHasBlockingFindings(sourceValidation.artifact, policyResolution)) {
        return { reason: 'reused review findings validation contains policy-blocking active findings or residual risks' };
    }
    const receiptRecord = options.receipt as unknown as Record<string, unknown>;
    const sourceReport = receiptRecord.review_findings_report
        && typeof receiptRecord.review_findings_report === 'object'
        && !Array.isArray(receiptRecord.review_findings_report)
        ? receiptRecord.review_findings_report as ReviewFindingsReport
        : null;
    if (!sourceReport) {
        return { reason: 'reused review findings validation failed: source receipt is missing review_findings_report.' };
    }
    const sourceCoverageContractSha256 = getReceiptOutputContractString(options.receipt, 'coverage_contract_sha256')
        || sourceValidation.artifact.validation_result.bindings.coverage_contract_sha256
        || sourceReport.coverage_ledger.coverage_contract_sha256;
    const sourceCoverageContract = buildHistoricalCoverageContractFromReport(sourceReport, options.reviewType)
        || (sourceCoverageContractSha256
            ? {
                schema_version: 1,
                required: false,
                review_type: options.reviewType,
                obligations: [],
                obligation_count: 0,
                contract_sha256: sourceCoverageContractSha256
            } as ReviewCoverageContract
            : null);
    const validation: JsonReviewFindingsArtifactValidation = {
        detected: true,
        valid: true,
        report: sourceReport,
        violations: [],
        coverage_validation: sourceValidation.artifact.validation_result.coverage_status
    };
    const rawOutputSha256 = normalizeSha256(getReceiptRecordString(options.receipt, 'review_output_sha256'))
        || normalizeSha256(getReceiptOutputContractString(options.receipt, 'raw_output_sha256'))
        || normalizeSha256(options.historicalReviewArtifactSha256);
    const artifactPath = getReviewFindingsValidationArtifactPath(options.artifactPath);
    const payload = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation,
        reviewOutputSha256: rawOutputSha256,
        reviewArtifactPath: options.artifactPath,
        reviewArtifactSha256: options.historicalReviewArtifactSha256,
        reviewContextPath: null,
        reviewContextSha256: options.expectedContextSha256,
        preflightPath: null,
        preflightSha256: null,
        scopeSha256: null,
        reviewScopeSha256: options.expectedReviewScopeSha256,
        codeScopeSha256: options.expectedCodeScopeSha256,
        reviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        coverageContract: sourceCoverageContract
    });
    const artifactSha256 = sha256RedactedJsonPayload(payload);
    const dispositionEvidence = buildReusedReviewFindingsDispositionEvidence({
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewArtifactPath: options.artifactPath,
        validationArtifact: payload,
        validationArtifactPath: artifactPath,
        validationArtifactSha256: artifactSha256,
        policyResolution
    });
    return {
        evidence: {
            artifactPath,
            snapshotPath: getReviewFindingsValidationArtifactSnapshotPath(artifactPath, artifactSha256),
            artifactSha256,
            payload,
            validation,
            rawOutputSha256,
            policyResolution,
            dispositionEvidence
        }
    };
}

function attachReusedReviewFindingsReceiptEvidence(
    refreshedReceipt: ReviewReceipt,
    evidence: ReusedReviewFindingsValidationEvidence
): void {
    const report = evidence.validation.report;
    if (!report) {
        return;
    }
    const receiptRecord = refreshedReceipt as unknown as Record<string, unknown>;
    const reportSha256 = sha256RedactedJsonPayload(report);
    receiptRecord.review_output_sha256 = evidence.rawOutputSha256;
    receiptRecord.review_output_format = 'findings_json';
    receiptRecord.review_output_schema_version = report.schema_version;
    receiptRecord.review_findings_report_sha256 = reportSha256;
    receiptRecord.review_findings_report = report;
    receiptRecord.review_findings_summary = summarizeReviewFindingsReport(report);
    receiptRecord.review_findings_validation = summarizeReviewFindingsValidationEvidence(evidence);
    receiptRecord.review_findings_disposition = evidence.dispositionEvidence.payload.disposition_result;
    receiptRecord.review_findings_disposition_artifact =
        summarizeReviewFindingsDispositionEvidence(evidence.dispositionEvidence);
    receiptRecord.review_output_contract = {
        schema_version: 1,
        format: 'findings_json',
        report_sha256: reportSha256,
        validation_artifact_sha256: evidence.artifactSha256,
        validation_result_sha256: evidence.payload.validation_result_sha256,
        disposition_artifact_sha256: evidence.dispositionEvidence.artifactSha256,
        disposition_result_sha256: evidence.dispositionEvidence.payload.disposition_result_sha256,
        raw_output_sha256: evidence.rawOutputSha256,
        review_artifact_sha256: refreshedReceipt.review_artifact_sha256,
        review_context_sha256: refreshedReceipt.reused_from_review_context_sha256 ?? refreshedReceipt.review_context_sha256,
        review_tree_state_sha256: refreshedReceipt.reused_from_review_tree_state_sha256 ?? refreshedReceipt.review_tree_state_sha256 ?? null,
        coverage_contract_sha256: report.coverage_ledger.coverage_contract_sha256,
        reviewer_identity: refreshedReceipt.reviewer_identity,
        reviewer_provenance_event_sha256: refreshedReceipt.reviewer_provenance?.event_sha256 ?? null
    };
}

function buildReusedReviewReceipt(options: MaterializeReusedReviewEvidenceOptions): ReviewReceipt {
    const currentDomainScopeFingerprints = buildDomainScopeFingerprints({
        repoRoot: options.repoRoot,
        detectionSource: String(options.preflightPayload.detection_source || 'git_auto'),
        includeUntracked: options.preflightPayload.include_untracked !== false,
        changedFiles: Array.isArray(options.preflightPayload.changed_files)
            ? options.preflightPayload.changed_files as string[]
            : []
    });
    return buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.currentPreflightHash,
        scopeSha256: String(
            (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.scope_sha256
            || (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
            || ''
        ).trim() || null,
        reviewScopeSha256: String(options.reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null,
        codeScopeSha256: options.nonTestReviewScope
            ? String(options.codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null
            : null,
        domainScopeFingerprints: currentDomainScopeFingerprints,
        reviewContextSha256: options.currentReviewContextSha256,
        reviewTreeStateSha256: options.currentReviewTreeStateSha256,
        reviewContextReuseSha256: options.currentContextReuseSha256,
        reviewArtifactSha256: options.historicalReviewArtifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.receipt.reviewer_fallback_reason ?? null,
        reviewerProvenance: options.historicalReviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED',
        reusedExistingReview: true,
        reusedFromReceiptPath: options.reusedFromReceiptPath,
        reusedFromReceiptSha256: options.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: options.expectedContextSha256,
        reusedFromReviewContextReuseSha256: options.expectedContextReuseSha256,
        reusedFromReviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        reusedFromReviewScopeSha256: options.expectedReviewScopeSha256,
        reusedFromCodeScopeSha256: options.expectedCodeScopeSha256,
        reusedFromDomainScopeFingerprints: normalizeDomainScopeFingerprints(options.receipt.domain_scope_fingerprints)
    });
}

function buildReuseRecordedEventDetails(input: {
    options: MaterializeReusedReviewEvidenceOptions;
    refreshedReceipt: ReviewReceipt;
    receiptPayloadSha256: string;
    receiptSnapshotPath: string;
    artifactSnapshotPath: string;
}): Record<string, unknown> {
    return {
        ...input.refreshedReceipt,
        reused_existing_review: true,
        reuse_event_type: 'REVIEW_EVIDENCE_REUSED',
        reused_from_receipt_path: input.options.reusedFromReceiptPath,
        reused_from_receipt_sha256: input.options.reusedFromReceiptSha256,
        reused_from_review_context_sha256: input.options.expectedContextSha256,
        reused_from_review_context_reuse_sha256: input.options.expectedContextReuseSha256,
        reused_from_review_tree_state_sha256: input.options.expectedReviewTreeStateSha256,
        reused_from_review_scope_sha256: input.options.expectedReviewScopeSha256,
        reused_from_code_scope_sha256: input.options.expectedCodeScopeSha256,
        receipt_path: gateHelpers.normalizePath(input.options.receiptPath),
        receipt_sha256: input.receiptPayloadSha256,
        receipt_snapshot_path: gateHelpers.normalizePath(input.receiptSnapshotPath),
        receipt_snapshot_sha256: input.receiptPayloadSha256,
        review_artifact_path: gateHelpers.normalizePath(input.options.artifactPath),
        review_artifact_snapshot_path: gateHelpers.normalizePath(input.artifactSnapshotPath),
        review_artifact_snapshot_sha256: input.options.historicalReviewArtifactSha256,
        review_context_path: gateHelpers.normalizePath(input.options.reviewContextPath),
        review_context_sha256: input.options.currentReviewContextSha256
    };
}
