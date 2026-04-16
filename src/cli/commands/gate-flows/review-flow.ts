import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    EXIT_GATE_FAILURE
} from '../../exit-codes';
import { buildOutputTelemetry, formatVisibleSavingsLine } from '../../../gate-runtime/token-telemetry';
import { applyOutputFilterProfile } from '../../../gate-runtime/output-filters';
import {
    emitMandatoryReviewPhaseStartedEvent,
    emitStatusChangedEvent
} from '../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEvent,
    assertValidTaskId
} from '../../../gate-runtime/task-events';
import { assessDocImpact } from '../../../gates/doc-impact';
import {
    checkRequiredReviews,
    parseSkipReviews,
    resolveExpectedReviewVerdicts,
    validatePreflightForReview,
    validateZeroDiffForReviewGate
} from '../../../gates/required-reviews-check';
import { readRuntimeReviewerProvider } from '../../../gates/reviewer-routing';
import {
    detectProtectedDirtyWorkspaceDrift,
    getProtectedDirtyWorkspaceScopeFromPreflight
} from '../../../gates/dirty-worktree-protection';
import {
    getRulePackEvidence,
    getRulePackEvidenceViolations
} from '../../../gates/rule-pack';
import {
    collectTaskTimelineEventTypes,
    getTaskModeEvidence,
    getTaskModeEvidenceViolations
} from '../../../gates/task-mode';
import { getReviewLifecycleGuard } from '../../../gates/review-lifecycle-guard';
import * as gateHelpers from '../../../gates/helpers';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolveDefaultReviewsPath,
    resolvePathForWrite,
    writeJsonArtifact,
    writeReviewEvidence
} from '../gates-artifacts';
import {
    expandValueList,
    parseBooleanOption
} from '../gates-parser';
import { requireResolvedPath } from '../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    readTaskQueueStatus,
    isPlainObject,
    appendMetricsIfEnabled,
    resolveBudgetTokensFromForecast,
    resolveOutputFiltersPath,
    syncTaskQueueStatus
} from './gate-flow-helpers';
import {
    getCompileGateEvidence,
    testCompileScopeDrift,
    testReviewArtifacts,
    type CompileGateEvidenceResult,
    type CompileScopeDriftResult,
    type ReviewArtifactsAuditResult
} from './review-flow-support';

type OutputTelemetry = ReturnType<typeof buildOutputTelemetry>;

export interface DocImpactGateCommandOptions {
    repoRoot?: string;
    preflightPath?: string;
    docsUpdated?: unknown;
    taskId?: unknown;
    decision?: string;
    behaviorChanged?: unknown;
    changelogUpdated?: unknown;
    sensitiveScopeReviewed?: unknown;
    sensitiveReviewed?: unknown;
    rationale?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface RequiredReviewsCheckCommandOptions {
    repoRoot?: string;
    preflightPath?: string;
    taskId?: unknown;
    taskModePath?: string;
    rulePackPath?: string;
    metricsPath?: string;
    outputFiltersPath?: string;
    skipReviews?: unknown;
    codeReviewVerdict?: string;
    dbReviewVerdict?: string;
    securityReviewVerdict?: string;
    refactorReviewVerdict?: string;
    apiReviewVerdict?: string;
    testReviewVerdict?: string;
    performanceReviewVerdict?: string;
    infraReviewVerdict?: string;
    dependencyReviewVerdict?: string;
    compileEvidencePath?: string;
    skipReason?: unknown;
    reviewsRoot?: string;
    reviewEvidencePath?: string;
    overrideArtifactPath?: string;
    noOpArtifactPath?: string;
    emitMetrics?: unknown;
}

interface ReviewEvidenceContext extends Record<string, unknown> {
    preflight_path: string;
    preflight_hash_sha256: string | null;
    mode: string;
    task_mode: unknown;
    compile_evidence_path: string | null;
    compile_evidence_hash_sha256: string | null;
    output_filters_path: string | null;
    scope_drift: CompileScopeDriftResult | null;
    required_reviews: Record<string, boolean>;
    verdicts: Record<string, string>;
    review_checks: Record<string, unknown>;
    skip_reviews: string[];
    skip_reason: string;
    override_artifact: string | null;
    artifact_evidence: ReviewArtifactsAuditResult;
    zero_diff_guard?: unknown;
    selected_budget_tier?: string | null;
    output_telemetry?: OutputTelemetry;
}

export function runDocImpactGateCommand(options: DocImpactGateCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedPreflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot),
        'PreflightPath'
    );
    const docsUpdated = expandValueList(options.docsUpdated, { splitDelimiters: false });
    const docImpactOptions = {
        preflightPath: resolvedPreflightPath,
        taskId: String(options.taskId || ''),
        decision: options.decision || 'NO_DOC_UPDATES',
        behaviorChanged: parseBooleanOption(options.behaviorChanged, false),
        changelogUpdated: parseBooleanOption(options.changelogUpdated, false),
        sensitiveReviewed: parseBooleanOption(options.sensitiveScopeReviewed != null ? options.sensitiveScopeReviewed : options.sensitiveReviewed, false),
        docsUpdated,
        rationale: String(options.rationale || ''),
        repoRoot
    };
    const artifact = assessDocImpact(docImpactOptions);

    const resolvedTaskId = artifact.task_id || null;
    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : (resolvedTaskId ? resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-doc-impact.json`) : null);
    if (artifactPath) {
        writeJsonArtifact(artifactPath, artifact);
    }

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: new Date().toISOString(),
        event_type: 'doc_impact_gate_check',
        status: artifact.status,
        task_id: resolvedTaskId,
        artifact_path: normalizeOptionalPath(artifactPath),
        artifact
    }, parseBooleanOption(options.emitMetrics, true));

    if (resolvedTaskId) {
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                resolvedTaskId,
                artifact.violations.length > 0 ? 'DOC_IMPACT_ASSESSMENT_FAILED' : 'DOC_IMPACT_ASSESSED',
                artifact.outcome,
                artifact.violations.length > 0 ? 'Doc impact gate failed.' : 'Doc impact gate passed.',
                artifact
            );
        } catch (error: unknown) {
            removeArtifactIfExists(artifactPath);
            throw new Error(
                `doc-impact-gate failed because mandatory lifecycle event '${artifact.violations.length > 0 ? 'DOC_IMPACT_ASSESSMENT_FAILED' : 'DOC_IMPACT_ASSESSED'}' could not be appended. ${getErrorMessage(error)}`
            );
        }
    }

    if (artifact.violations.length > 0) {
        return {
            outputLines: [
                'DOC_IMPACT_GATE_FAILED',
                'Violations:',
                ...artifact.violations.map(function (item: string) { return `- ${item}`; })
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }

    const outputLines = ['DOC_IMPACT_GATE_PASSED'];
    if (artifactPath) {
        outputLines.push(`DocImpactArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);
    }
    return { outputLines, exitCode: 0 };
}

export function runRequiredReviewsCheckCommand(options: RequiredReviewsCheckCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const resolvedPreflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(String(options.preflightPath || '').trim(), repoRoot),
        'PreflightPath'
    );
    const validatedBase = validatePreflightForReview(resolvedPreflightPath, String(options.taskId || ''));
    const preflight = isPlainObject(validatedBase.preflight) ? validatedBase.preflight : {};
    const preflightMetrics = isPlainObject(preflight.metrics) ? preflight.metrics : null;
    const validatedPreflight = {
        ...validatedBase,
        mode: String(preflight.mode || 'FULL_PATH').trim() || 'FULL_PATH',
        changed_files_count: Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0,
        changed_lines_total: preflightMetrics && typeof preflightMetrics.changed_lines_total === 'number'
            ? preflightMetrics.changed_lines_total
            : 0
    };
    const reviewBudgetTokens = resolveBudgetTokensFromForecast(preflight.budget_forecast);

    const resolvedTaskId = validatedPreflight.resolved_task_id;
    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    const outputFiltersPath = resolveOutputFiltersPath(repoRoot, options.outputFiltersPath || '');
    const reviewLifecycleGuard = resolvedTaskId
        ? getReviewLifecycleGuard(repoRoot, resolvedTaskId, 'required-reviews-check', 'review_gate')
        : null;
    if (reviewLifecycleGuard?.status === 'BLOCK') {
        const failureOutputLines = [
            'REVIEW_GATE_FAILED',
            `Mode: ${validatedPreflight.mode}`,
            'Violations:',
            ...reviewLifecycleGuard.violations.map(function (item: string) { return `- ${item}`; })
        ];
        const filteredFailureOutput = applyOutputFilterProfile(failureOutputLines, outputFiltersPath, 'review_gate_failure_console', {
            budgetTokens: reviewBudgetTokens
        });
        const failureTelemetry = buildOutputTelemetry(failureOutputLines, filteredFailureOutput.lines, {
            filterMode: filteredFailureOutput.filter_mode,
            fallbackMode: filteredFailureOutput.fallback_mode,
            parserMode: filteredFailureOutput.parser_mode,
            parserName: filteredFailureOutput.parser_name ?? undefined,
            parserStrategy: filteredFailureOutput.parser_strategy ?? undefined
        });
        const failureVisibleSavingsLine = formatVisibleSavingsLine(failureTelemetry);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: new Date().toISOString(),
            event_type: 'review_gate_rerun_blocked',
            status: 'FAILED',
            task_id: resolvedTaskId,
            preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
            mode: validatedPreflight.mode,
            output_filters_path: normalizeOptionalPath(outputFiltersPath),
            violations: reviewLifecycleGuard.violations,
            ...failureTelemetry
        }, parseBooleanOption(options.emitMetrics, true));
        const outputLines = [...filteredFailureOutput.lines];
        if (failureVisibleSavingsLine) {
            outputLines.push(failureVisibleSavingsLine);
        }
        return { outputLines, exitCode: EXIT_GATE_FAILURE };
    }
    const skipReviewsList = parseSkipReviews(options.skipReviews || '');
    const providedVerdicts: Record<string, string> = {
        code: String(options.codeReviewVerdict || '').trim(),
        db: String(options.dbReviewVerdict || '').trim(),
        security: String(options.securityReviewVerdict || '').trim(),
        refactor: String(options.refactorReviewVerdict || '').trim(),
        api: String(options.apiReviewVerdict || '').trim(),
        test: String(options.testReviewVerdict || '').trim(),
        performance: String(options.performanceReviewVerdict || '').trim(),
        infra: String(options.infraReviewVerdict || '').trim(),
        dependency: String(options.dependencyReviewVerdict || '').trim()
    };

    const compileGateEvidence = getCompileGateEvidence(
        repoRoot,
        resolvedTaskId,
        validatedPreflight.preflight_path,
        validatedPreflight.preflight_hash,
        options.compileEvidencePath || ''
    );
    const taskModeEvidence = getTaskModeEvidence(repoRoot, resolvedTaskId, String(options.taskModePath || ''));
    const rulePackEvidence = getRulePackEvidence(repoRoot, resolvedTaskId, 'POST_PREFLIGHT', {
        artifactPath: String(options.rulePackPath || ''),
        preflightPath: validatedPreflight.preflight_path,
        taskModePath: String(options.taskModePath || '')
    });
    const scopeDrift = compileGateEvidence.status === 'PASS'
        ? testCompileScopeDrift(repoRoot, compileGateEvidence)
        : null;
    const dirtyWorkspaceProtectionDrift = detectProtectedDirtyWorkspaceDrift(
        repoRoot,
        getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
    );

    const errors = [...validatedPreflight.errors];
    for (const skipItem of skipReviewsList) {
        if (skipItem !== 'code') {
            errors.push(`Unsupported skip-review value '${skipItem}'. Allowed values: code.`);
        }
    }

    const skipReason = String(options.skipReason || '').trim();
    if (skipReviewsList.length > 0 && !skipReason) {
        errors.push('Skip-review override requires --skip-reason.');
    }
    if (skipReason && skipReason.length < 12) {
        errors.push('Skip-review reason is too short. Provide a concrete justification (>= 12 chars).');
    }

    errors.push(...getTaskModeEvidenceViolations(taskModeEvidence));
    errors.push(...getRulePackEvidenceViolations(rulePackEvidence));

    switch (compileGateEvidence.status) {
        case 'TASK_ID_MISSING':
            errors.push('Compile gate evidence cannot be verified: task id is missing.');
            break;
        case 'EVIDENCE_FILE_MISSING':
            errors.push(`Compile gate evidence missing: file not found at '${compileGateEvidence.evidence_path}'. Run compile-gate first.`);
            break;
        case 'EVIDENCE_INVALID_JSON':
            errors.push(`Compile gate evidence is invalid JSON at '${compileGateEvidence.evidence_path}'. Re-run compile-gate.`);
            break;
        case 'EVIDENCE_TASK_MISMATCH':
            errors.push(`Compile gate evidence task mismatch. Expected '${resolvedTaskId}', got '${compileGateEvidence.evidence_task_id}'.`);
            break;
        case 'EVIDENCE_SOURCE_INVALID':
            errors.push(`Compile gate evidence source is invalid. Expected 'compile-gate', got '${compileGateEvidence.evidence_source}'.`);
            break;
        case 'EVIDENCE_PREFLIGHT_HASH_MISMATCH':
            errors.push('Compile gate evidence preflight hash mismatch. Re-run compile-gate for the current preflight artifact.');
            break;
        case 'EVIDENCE_PREFLIGHT_PATH_MISMATCH':
            errors.push(`Compile gate evidence preflight path mismatch. Evidence path='${compileGateEvidence.evidence_preflight_path}'.`);
            break;
        case 'EVIDENCE_SCOPE_MISSING':
            errors.push('Compile gate evidence is missing scope snapshot fields. Re-run compile-gate.');
            break;
        case 'EVIDENCE_NOT_PASS':
            errors.push(`Compile gate did not pass. Evidence status='${compileGateEvidence.evidence_status}', outcome='${compileGateEvidence.evidence_outcome}'.`);
            break;
        default:
            break;
    }

    if (scopeDrift) {
        if (scopeDrift.status === 'EVIDENCE_SCOPE_MISSING') {
            errors.push(...scopeDrift.violations);
        } else if (scopeDrift.status === 'DRIFT_DETECTED') {
            errors.push('Workspace changed after compile gate; rerun compile-gate before review gate.');
            errors.push(...scopeDrift.violations);
        }
    }
    if (dirtyWorkspaceProtectionDrift.status === 'DRIFT_DETECTED') {
        errors.push(...dirtyWorkspaceProtectionDrift.violations);
    }

    const timelinePath = resolvedTaskId
        ? gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${resolvedTaskId}.jsonl`))
        : null;
    if (timelinePath) {
        const timelineErrors: string[] = [];
        const timelineEventTypes = collectTaskTimelineEventTypes(timelinePath, timelineErrors);
        errors.push(...timelineErrors);
        if (timelineErrors.length === 0 && !timelineEventTypes.has('TASK_MODE_ENTERED')) {
            errors.push(`Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing TASK_MODE_ENTERED. Run enter-task-mode before review gate.`);
        }
        if (timelineErrors.length === 0 && !timelineEventTypes.has('RULE_PACK_LOADED')) {
            errors.push(`Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing RULE_PACK_LOADED. Run load-rule-pack before review gate.`);
        }
        if (timelineErrors.length === 0 && !timelineEventTypes.has('HANDSHAKE_DIAGNOSTICS_RECORDED')) {
            errors.push(`Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing HANDSHAKE_DIAGNOSTICS_RECORDED. Run handshake-diagnostics before review gate.`);
        }
        if (timelineErrors.length === 0 && !timelineEventTypes.has('SHELL_SMOKE_PREFLIGHT_RECORDED')) {
            errors.push(`Task timeline '${gateHelpers.normalizePath(timelinePath)}' is missing SHELL_SMOKE_PREFLIGHT_RECORDED. Run shell-smoke-preflight before review gate.`);
        }
    }

    const zeroDiffGuard = validateZeroDiffForReviewGate(
        preflight,
        String(resolvedTaskId || ''),
        repoRoot,
        options.noOpArtifactPath || ''
    );
    errors.push(...zeroDiffGuard.violations);

    const required = validatedPreflight.required_reviews;
    const skipCode = skipReviewsList.includes('code');
    const verdicts = resolveExpectedReviewVerdicts(required, providedVerdicts, skipReviewsList);
    const canSkipCode = !!required.code
        && !required.db
        && !required.security
        && !required.refactor
        && !required.api
        && !required.test
        && !required.performance
        && !required.infra
        && !required.dependency
        && validatedPreflight.changed_files_count <= 1
        && validatedPreflight.changed_lines_total <= 8;

    if (skipCode && !canSkipCode) {
        errors.push('Code review override is not allowed for this change scope. Allowed only for tiny low-risk code changes (<=1 file and <=8 changed lines, with no specialized reviews).');
    }
    if (skipCode && !required.code) {
        errors.push('Code review override was requested but code review is not required by preflight.');
    }

    const artifactEvidence = testReviewArtifacts(
        repoRoot,
        resolvedTaskId,
        required,
        verdicts,
        skipReviewsList,
        options.reviewsRoot || ''
    );

    const reviewArtifactsMap: Record<string, {
        path: string;
        content: string;
        reviewContext?: Record<string, unknown>;
        reviewContextPath?: string | null;
        reviewContextSha256?: string | null;
    }> = {};
    for (const entry of artifactEvidence.checked) {
        if (entry.present && entry.path) {
            try {
                let reviewContext: Record<string, unknown> | undefined;
                let reviewContextPath: string | null = null;
                if (entry.review_context_present && entry.review_context_path) {
                    reviewContextPath = path.resolve(entry.review_context_path);
                    if (fs.existsSync(reviewContextPath) && fs.statSync(reviewContextPath).isFile()) {
                        const parsedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
                        if (isPlainObject(parsedReviewContext)) {
                            reviewContext = parsedReviewContext;
                        }
                    }
                }
                reviewArtifactsMap[entry.review] = {
                    path: entry.path,
                    content: fs.readFileSync(entry.path, 'utf8'),
                    reviewContext,
                    reviewContextPath,
                    reviewContextSha256: reviewContextPath && fs.existsSync(reviewContextPath)
                        ? gateHelpers.fileSha256(reviewContextPath)
                        : null
                };
            } catch (e) {
                // ignore
            }
        }
    }

    const baseResult = checkRequiredReviews({
        validatedPreflight: { ...validatedPreflight, errors },
        verdicts,
        skipReviews: skipReviewsList,
        compileGateEvidence: compileGateEvidence.status === 'PASS' ? { status: 'PASSED' } : null,
        reviewArtifacts: reviewArtifactsMap,
        sourceOfTruth: readRuntimeReviewerProvider(repoRoot, resolvedTaskId)
    });
    const allViolations = [...baseResult.violations, ...artifactEvidence.violations];
    const status = allViolations.length > 0 ? 'FAILED' : 'PASSED';
    const reviewEvidencePath = options.reviewEvidencePath
        ? requireResolvedPath(resolvePathForWrite(options.reviewEvidencePath, repoRoot), 'ReviewEvidencePath')
        : (resolvedTaskId ? resolveDefaultReviewsPath(repoRoot, `${resolvedTaskId}-review-gate.json`) : null);

    let overrideArtifactPath = options.overrideArtifactPath
        ? requireResolvedPath(resolvePathForWrite(options.overrideArtifactPath, repoRoot), 'OverrideArtifactPath')
        : '';

    if (status === 'PASSED' && skipCode && resolvedTaskId) {
        if (!overrideArtifactPath) {
            const preflightDir = path.dirname(validatedPreflight.preflight_path);
            const preflightName = path.basename(validatedPreflight.preflight_path, path.extname(validatedPreflight.preflight_path));
            const baseName = preflightName.replace(/-preflight$/i, '');
            overrideArtifactPath = path.join(preflightDir, `${baseName}-override.json`);
        }
        writeJsonArtifact(overrideArtifactPath, {
            timestamp_utc: new Date().toISOString(),
            preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
            mode: validatedPreflight.mode,
            skipped_reviews: ['code'],
            reason: skipReason,
            guardrails: {
                required_db: !!required.db,
                required_security: !!required.security,
                required_refactor: !!required.refactor,
                required_api: !!required.api,
                required_test: !!required.test,
                required_performance: !!required.performance,
                required_infra: !!required.infra,
                required_dependency: !!required.dependency,
                changed_files_count: validatedPreflight.changed_files_count,
                changed_lines_total: validatedPreflight.changed_lines_total
            }
        });
    }

    const reviewEvidenceContext: ReviewEvidenceContext = {
        preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
        preflight_hash_sha256: validatedPreflight.preflight_hash,
        mode: validatedPreflight.mode,
        task_mode: taskModeEvidence,
        rule_pack: rulePackEvidence,
        compile_evidence_path: compileGateEvidence.evidence_path,
        compile_evidence_hash_sha256: compileGateEvidence.evidence_hash,
        output_filters_path: normalizeOptionalPath(outputFiltersPath),
        scope_drift: scopeDrift,
        dirty_workspace_protection: dirtyWorkspaceProtectionDrift,
        required_reviews: baseResult.required_reviews,
        verdicts,
        review_checks: baseResult.review_checks,
        skip_reviews: skipReviewsList,
        skip_reason: skipReason,
        override_artifact: normalizeOptionalPath(overrideArtifactPath),
        artifact_evidence: artifactEvidence,
        zero_diff_guard: zeroDiffGuard,
        selected_budget_tier: null
    };

    const trustLevels = new Set<string>();
    if (baseResult.review_checks && typeof baseResult.review_checks === 'object') {
        for (const key of Object.keys(baseResult.review_checks)) {
            const check = (baseResult.review_checks as any)[key];
            if (check && check.trust_level) {
                trustLevels.add(check.trust_level);
            }
        }
    }
    const trustStatusLine = trustLevels.size > 0 ? `TrustStatus: ${Array.from(trustLevels).join(', ')}` : null;

    if (status === 'FAILED') {
        const failureOutputLines = [
            'REVIEW_GATE_FAILED',
            `Mode: ${validatedPreflight.mode}`,
            ...(trustStatusLine ? [trustStatusLine] : []),
            'Violations:',
            ...allViolations.map(function (item: string) { return `- ${item}`; })
        ];
        const filteredFailureOutput = applyOutputFilterProfile(failureOutputLines, outputFiltersPath, 'review_gate_failure_console', {
            budgetTokens: reviewBudgetTokens
        });
        const failureTelemetry = buildOutputTelemetry(failureOutputLines, filteredFailureOutput.lines, {
            filterMode: filteredFailureOutput.filter_mode,
            fallbackMode: filteredFailureOutput.fallback_mode,
            parserMode: filteredFailureOutput.parser_mode,
            parserName: filteredFailureOutput.parser_name ?? undefined,
            parserStrategy: filteredFailureOutput.parser_strategy ?? undefined
        });
        const failureVisibleSavingsLine = formatVisibleSavingsLine(failureTelemetry);
        reviewEvidenceContext.selected_budget_tier = filteredFailureOutput.budget_tier ?? null;
        reviewEvidenceContext.output_telemetry = failureTelemetry;
        writeReviewEvidence(reviewEvidencePath, resolvedTaskId, reviewEvidenceContext, 'FAILED', 'FAIL', allViolations);

        const failureEvent = {
            timestamp_utc: new Date().toISOString(),
            event_type: 'review_gate_check',
            status: 'FAILED',
            task_id: resolvedTaskId,
            review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
            preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
            mode: validatedPreflight.mode,
            skip_reviews: skipReviewsList,
            skip_reason: skipReason,
            output_filters_path: normalizeOptionalPath(outputFiltersPath),
            compile_gate: compileGateEvidence,
            artifact_evidence: artifactEvidence,
            violations: allViolations,
            ...failureTelemetry
        };
        appendMetricsIfEnabled(repoRoot, metricsPath, failureEvent, parseBooleanOption(options.emitMetrics, true));
        if (resolvedTaskId) {
            try {
                appendMandatoryTaskEvent(orchestratorRoot, resolvedTaskId, 'REVIEW_GATE_FAILED', 'FAIL', 'Required reviews gate failed.', {
                    review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
                    preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
                    mode: validatedPreflight.mode,
                    skip_reviews: skipReviewsList,
                    skip_reason: skipReason,
                    compile_gate: compileGateEvidence,
                    artifact_evidence: artifactEvidence,
                    violations: allViolations
                });
            } catch (error: unknown) {
                removeArtifactIfExists(reviewEvidencePath);
                throw new Error(
                    `required-reviews-check failed because mandatory lifecycle event 'REVIEW_GATE_FAILED' could not be appended. ${getErrorMessage(error)}`
                );
            }
        }

        const outputLines = [...filteredFailureOutput.lines];
        if (failureVisibleSavingsLine) {
            outputLines.push(failureVisibleSavingsLine);
        }
        return { outputLines, exitCode: EXIT_GATE_FAILURE };
    }

    const successOutputLines = skipCode
        ? [
            'REVIEW_GATE_PASSED_WITH_OVERRIDE',
            `Mode: ${validatedPreflight.mode}`,
            'SkippedReviews: code',
            ...(overrideArtifactPath ? [`OverrideArtifact: ${gateHelpers.normalizePath(overrideArtifactPath)}`] : []),
            ...(trustStatusLine ? [trustStatusLine] : [])
        ]
        : [
            'REVIEW_GATE_PASSED',
            `Mode: ${validatedPreflight.mode}`,
            ...(trustStatusLine ? [trustStatusLine] : [])
        ];
    if (artifactEvidence.compaction_warning_count > 0) {
        successOutputLines.push(`CompactionWarnings: ${artifactEvidence.compaction_warning_count}`);
    }
    const filteredSuccessOutput = applyOutputFilterProfile(successOutputLines, outputFiltersPath, 'review_gate_success_console', {
        budgetTokens: reviewBudgetTokens
    });
    const successTelemetry = buildOutputTelemetry(successOutputLines, filteredSuccessOutput.lines, {
        filterMode: filteredSuccessOutput.filter_mode,
        fallbackMode: filteredSuccessOutput.fallback_mode,
        parserMode: filteredSuccessOutput.parser_mode,
        parserName: filteredSuccessOutput.parser_name ?? undefined,
        parserStrategy: filteredSuccessOutput.parser_strategy ?? undefined
    });
    const successVisibleSavingsLine = formatVisibleSavingsLine(successTelemetry);
    reviewEvidenceContext.selected_budget_tier = filteredSuccessOutput.budget_tier ?? null;
    reviewEvidenceContext.output_telemetry = successTelemetry;
    writeReviewEvidence(reviewEvidencePath, resolvedTaskId, reviewEvidenceContext, 'PASSED', 'PASS', []);

    const successEvent = {
        timestamp_utc: new Date().toISOString(),
        event_type: 'review_gate_check',
        status: 'PASSED',
        task_id: resolvedTaskId,
        review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
        preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
        mode: validatedPreflight.mode,
        skip_reviews: skipReviewsList,
        skip_reason: skipReason,
        output_filters_path: normalizeOptionalPath(outputFiltersPath),
        compile_gate: compileGateEvidence,
        override_artifact: normalizeOptionalPath(overrideArtifactPath),
        artifact_evidence: artifactEvidence,
        ...successTelemetry
    };
    appendMetricsIfEnabled(repoRoot, metricsPath, successEvent, parseBooleanOption(options.emitMetrics, true));
    if (resolvedTaskId) {
        const hasRequiredReviews = Object.values(required).some((value) => value === true);
        if (!hasRequiredReviews) {
            emitMandatoryReviewPhaseStartedEvent(orchestratorRoot, resolvedTaskId, {
                review_type: 'none',
                reason: 'no_required_reviews',
                mode: validatedPreflight.mode,
                preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path)
            });
        }
        try {
            appendMandatoryTaskEvent(
                orchestratorRoot,
                resolvedTaskId,
                skipCode ? 'REVIEW_GATE_PASSED_WITH_OVERRIDE' : 'REVIEW_GATE_PASSED',
                'PASS',
                skipCode ? 'Required reviews gate passed with audited override.' : 'Required reviews gate passed.',
                {
                    review_evidence_path: normalizeOptionalPath(reviewEvidencePath),
                    preflight_path: gateHelpers.normalizePath(validatedPreflight.preflight_path),
                    mode: validatedPreflight.mode,
                    skip_reviews: skipReviewsList,
                    skip_reason: skipReason,
                    compile_gate: compileGateEvidence,
                    override_artifact: normalizeOptionalPath(overrideArtifactPath),
                    artifact_evidence: artifactEvidence
                }
            );
        } catch (error: unknown) {
            removeArtifactIfExists(reviewEvidencePath);
            removeArtifactIfExists(overrideArtifactPath);
            throw new Error(
                `required-reviews-check failed because mandatory lifecycle event '${skipCode ? 'REVIEW_GATE_PASSED_WITH_OVERRIDE' : 'REVIEW_GATE_PASSED'}' could not be appended. ${getErrorMessage(error)}`
            );
        }

        const previousStatus = readTaskQueueStatus(repoRoot, resolvedTaskId);
        if (previousStatus && previousStatus !== 'IN_REVIEW') {
            emitStatusChangedEvent(orchestratorRoot, resolvedTaskId, previousStatus, 'IN_REVIEW');
            syncTaskQueueStatus(repoRoot, resolvedTaskId, 'IN_REVIEW');
        }
    }

    const outputLines = [...filteredSuccessOutput.lines];
    if (successVisibleSavingsLine) {
        outputLines.push(successVisibleSavingsLine);
    }
    return { outputLines, exitCode: 0 };
}
