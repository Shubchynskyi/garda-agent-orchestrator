import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getReviewExecutionDependencies,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import { assertValidTaskId } from '../gate-runtime/task-events';
import {
    buildTaskAuditSummary,
    type TaskAuditSummaryResult
} from './task-audit-summary';
import {
    type GateOutcome,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from './task-audit-summary-collectors';
import {
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from './full-suite-validation';
import {
    buildReviewTrustSummary,
    type ReviewTrustSummary
} from './review-trust-summary';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from './helpers';
import {
    resolveBundleNameForTarget
} from '../core/constants';
import {
    REVIEW_CONTRACTS
} from './required-reviews-check';
import {
    getWorkspaceSnapshotCached
} from './workspace-snapshot-cache';

const REVIEW_PREPARATION_ORDER = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
]);

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));

export type NextStepStatus = 'BLOCKED' | 'READY' | 'DONE';

export interface NextStepCommand {
    label: string;
    command: string;
}

export interface NextStepArtifactState {
    key: string;
    path: string;
    exists: boolean;
}

export interface NextStepFullSuiteSummary {
    enabled: boolean;
    command: string;
    config_path: string;
    config_source: 'effective_workflow_config';
    note: string;
}

export interface NextStepReviewSummary {
    required_reviews: string[];
    review_execution_policy_mode: EffectiveReviewExecutionPolicyMode;
    review_execution_policy_source: 'preflight' | 'workflow_config_fallback';
    next_review_type: string | null;
    blocked_review_dependencies: string[];
    trust: ReviewTrustSummary | null;
    trust_note: string | null;
}

export interface NextStepResult {
    schema_version: 1;
    task_id: string;
    generated_utc: string;
    navigator_command: string;
    status: NextStepStatus;
    next_gate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missing_artifacts: NextStepArtifactState[];
    present_artifacts: NextStepArtifactState[];
    full_suite_validation: NextStepFullSuiteSummary;
    review: NextStepReviewSummary;
    audit_status: TaskAuditSummaryResult['status'];
}

interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

interface ArtifactSpec {
    key: string;
    path: string;
}

interface ReviewArtifactState {
    reviewType: string;
    contextPath: string;
    artifactPath: string;
    receiptPath: string;
    contextExists: boolean;
    artifactExists: boolean;
    receiptExists: boolean;
    passToken: string;
    ready: boolean;
    violations: string[];
    reviewerIdentity: string | null;
    contextReviewerIdentity: string | null;
    reviewerProvenance: {
        task_sequence: number | null;
        prev_event_sha256: string | null;
        event_sha256: string | null;
    } | null;
}

interface CompileReadiness {
    ready: boolean;
    reason: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function toRepoDisplayPath(repoRoot: string, filePath: string): string {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(filePath));
    return normalizePath(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : filePath);
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
}

function buildBundleRelativePath(repoRoot: string, relativePath: string): string {
    return normalizePath(path.join(resolveBundleNameForTarget(repoRoot), relativePath));
}

function artifactState(repoRoot: string, specs: ArtifactSpec[]): {
    present: NextStepArtifactState[];
    missing: NextStepArtifactState[];
} {
    const states = specs.map((spec) => ({
        key: spec.key,
        path: toRepoDisplayPath(repoRoot, spec.path),
        exists: fileExists(spec.path)
    }));
    return {
        present: states.filter((state) => state.exists),
        missing: states.filter((state) => !state.exists)
    };
}

function getGateStatus(summary: TaskAuditSummaryResult, gateName: string): GateOutcome['status'] | null {
    return summary.gates.find((gate) => gate.gate === gateName)?.status || null;
}

function isGatePassed(summary: TaskAuditSummaryResult, gateName: string): boolean {
    return getGateStatus(summary, gateName) === 'PASS';
}

function getRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => requiredReviews[reviewType] === true);
}

function resolveReviewPolicy(preflight: Record<string, unknown> | null): {
    mode: EffectiveReviewExecutionPolicyMode;
    source: 'preflight' | 'workflow_config_fallback';
} {
    if (preflight && isPlainRecord(preflight.review_execution_policy)) {
        return {
            mode: resolveReviewExecutionPolicyModeFromPreflight(preflight),
            source: 'preflight'
        };
    }
    return {
        mode: resolveReviewExecutionPolicyModeFromPreflight(null),
        source: 'workflow_config_fallback'
    };
}

function readReviewArtifactState(reviewsRoot: string, taskId: string, reviewType: string): ReviewArtifactState {
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const violations: string[] = [];
    const contextExists = fileExists(contextPath);
    const artifactExists = fileExists(artifactPath);
    const receiptExists = fileExists(receiptPath);
    let context: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    let reviewerIdentity: string | null = null;
    let contextReviewerIdentity: string | null = null;
    let reviewerProvenance: ReviewArtifactState['reviewerProvenance'] = null;

    if (!contextExists) {
        violations.push('review context artifact is missing');
    } else {
        context = safeReadJson(contextPath);
        if (!context) {
            violations.push('review context artifact is invalid JSON');
        } else {
            const reviewerRouting = isPlainRecord(context.reviewer_routing)
                ? context.reviewer_routing
                : null;
            const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            contextReviewerIdentity = contextReviewerSessionId || null;
        }
    }

    if (!artifactExists) {
        violations.push('review artifact is missing');
    } else {
        const content = fs.readFileSync(artifactPath, 'utf8');
        if (!passToken || !content.includes(passToken)) {
            violations.push(`review artifact does not contain pass token '${passToken || '<unknown>'}'`);
        }
    }

    if (!receiptExists) {
        violations.push('review receipt is missing');
    } else {
        receipt = safeReadJson(receiptPath);
        if (!receipt) {
            violations.push('review receipt is invalid JSON');
        }
    }

    if (context && receipt && artifactExists) {
        const artifactHash = fileSha256(artifactPath);
        const contextHash = fileSha256(contextPath);
        const receiptArtifactHash = typeof receipt.review_artifact_sha256 === 'string'
            ? receipt.review_artifact_sha256.trim().toLowerCase()
            : '';
        const receiptContextHash = typeof receipt.review_context_sha256 === 'string'
            ? receipt.review_context_sha256.trim().toLowerCase()
            : '';
        const reviewerRouting = isPlainRecord(context.reviewer_routing)
            ? context.reviewer_routing
            : null;
        const contextExecutionMode = typeof reviewerRouting?.actual_execution_mode === 'string'
            ? reviewerRouting.actual_execution_mode.trim()
            : '';
        const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
            ? reviewerRouting.reviewer_session_id.trim()
            : '';
        const receiptExecutionMode = typeof receipt.reviewer_execution_mode === 'string'
            ? receipt.reviewer_execution_mode.trim()
            : '';
        const receiptReviewerIdentity = typeof receipt.reviewer_identity === 'string'
            ? receipt.reviewer_identity.trim()
            : '';
        reviewerIdentity = receiptReviewerIdentity || null;
        const rawProvenance = isPlainRecord(receipt.reviewer_provenance)
            ? receipt.reviewer_provenance
            : null;
        reviewerProvenance = rawProvenance
            ? {
                task_sequence: typeof rawProvenance.task_sequence === 'number'
                    ? rawProvenance.task_sequence
                    : Number(rawProvenance.task_sequence) || null,
                prev_event_sha256: rawProvenance.prev_event_sha256 == null
                    ? null
                    : String(rawProvenance.prev_event_sha256 || '').trim().toLowerCase() || null,
                event_sha256: String(rawProvenance.event_sha256 || '').trim().toLowerCase() || null
            }
            : null;
        if (receipt.task_id !== taskId) {
            violations.push(`review receipt belongs to task '${String(receipt.task_id || '')}'`);
        }
        if (receipt.review_type !== reviewType) {
            violations.push(`review receipt has review_type '${String(receipt.review_type || '')}'`);
        }
        if (!artifactHash || receiptArtifactHash !== artifactHash) {
            violations.push('review artifact hash does not match the receipt');
        }
        if (!contextHash || receiptContextHash !== contextHash) {
            violations.push('review context hash does not match the receipt');
        }
        if (receiptExecutionMode !== 'delegated_subagent') {
            violations.push("review receipt does not use reviewer_execution_mode 'delegated_subagent'");
        }
        if (!receiptReviewerIdentity.startsWith('agent:')) {
            violations.push("review receipt reviewer_identity must use 'agent:' scope");
        }
        if (contextExecutionMode !== 'delegated_subagent') {
            violations.push("review context is missing delegated_subagent routing metadata");
        }
        if (contextReviewerSessionId !== receiptReviewerIdentity) {
            violations.push('review context reviewer identity does not match the receipt');
        }
        if (receipt.reviewer_provenance == null) {
            violations.push('review receipt is missing reviewer_provenance');
        } else if (
            !reviewerProvenance?.task_sequence
            || !reviewerProvenance.event_sha256
            || !/^[0-9a-f]{64}$/.test(reviewerProvenance.event_sha256)
        ) {
            violations.push('review receipt reviewer_provenance is incomplete');
        }
    }

    return {
        reviewType,
        contextPath,
        artifactPath,
        receiptPath,
        contextExists,
        artifactExists,
        receiptExists,
        passToken,
        ready: violations.length === 0,
        violations,
        reviewerIdentity,
        contextReviewerIdentity,
        reviewerProvenance
    };
}

function getLatestTaskSequenceForEventTypes(eventsRoot: string, taskId: string, eventTypes: string[]): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const wanted = new Set(eventTypes);
    let latestSequence: number | null = null;
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (!wanted.has(String(event.event_type || '').trim())) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const sequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (Number.isInteger(sequence) && sequence > 0) {
                latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return latestSequence;
}

function timelineHasDelegatedReviewRoute(eventsRoot: string, taskId: string, state: ReviewArtifactState): boolean {
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null || state.reviewerProvenance.task_sequence <= latestCompileSequence) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            if (String(details.reviewer_session_id || '').trim() !== state.reviewerIdentity) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function readReviewTrust(
    reviewsRoot: string,
    taskId: string,
    requiredReviewTypes: string[],
    scopeCategory: string | null
): ReviewTrustSummary | null {
    const entries = requiredReviewTypes.flatMap((reviewType) => {
        const receipt = safeReadJson(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`));
        if (!receipt) {
            return [];
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode
                : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity
                : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason
                : null,
            reviewer_provenance: receipt.reviewer_provenance ?? null
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, requiredReviewTypes.length);
}

function getNextReviewType(
    requiredReviewTypes: string[],
    policyMode: EffectiveReviewExecutionPolicyMode,
    requiredReviews: Record<string, boolean>,
    reviewStates: ReviewArtifactState[],
    eventsRoot: string,
    taskId: string
): { reviewType: string | null; blockedDependencies: string[] } {
    const passedReviews = new Set(
        reviewStates
            .filter((state) => state.ready && timelineHasDelegatedReviewRoute(eventsRoot, taskId, state))
            .map((state) => state.reviewType)
    );
    for (const reviewType of requiredReviewTypes) {
        if (passedReviews.has(reviewType)) {
            continue;
        }
        const blockedDependencies = getReviewExecutionDependencies(reviewType, requiredReviews, policyMode)
            .filter((dependency) => !passedReviews.has(dependency));
        if (blockedDependencies.length > 0) {
            return {
                reviewType,
                blockedDependencies
            };
        }
        return {
            reviewType,
            blockedDependencies: []
        };
    }
    return {
        reviewType: null,
        blockedDependencies: []
    };
}

function readCompileReadiness(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string
): CompileReadiness {
    const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (!fileExists(compilePath)) {
        return {
            ready: false,
            reason: `Compile gate evidence missing: ${normalizePath(compilePath)}.`
        };
    }
    const evidence = safeReadJson(compilePath);
    if (!evidence) {
        return {
            ready: false,
            reason: 'Compile gate evidence is invalid JSON; rerun compile-gate.'
        };
    }
    const expectedPreflightHash = fileSha256(preflightPath);
    const evidenceStatus = String(evidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(evidence.outcome || '').trim().toUpperCase();
    if (evidence.task_id !== taskId) {
        return {
            ready: false,
            reason: `Compile gate evidence belongs to task '${String(evidence.task_id || '')}'.`
        };
    }
    if (String(evidence.event_source || '').trim() !== 'compile-gate') {
        return {
            ready: false,
            reason: 'Compile gate evidence source is invalid; rerun compile-gate.'
        };
    }
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        return {
            ready: false,
            reason: `Compile gate did not pass. Evidence status='${evidenceStatus || 'UNKNOWN'}', outcome='${evidenceOutcome || 'UNKNOWN'}'.`
        };
    }
    const evidencePreflightHash = String(evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightHash || evidencePreflightHash !== expectedPreflightHash) {
        return {
            ready: false,
            reason: 'Compile gate evidence preflight hash does not match the current preflight; rerun compile-gate.'
        };
    }
    const detectionSource = String(evidence.scope_detection_source || '').trim();
    const changedFiles = Array.isArray(evidence.scope_changed_files)
        ? evidence.scope_changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const scopeSha256 = String(evidence.scope_sha256 || '').trim();
    const changedFilesSha256 = String(evidence.scope_changed_files_sha256 || '').trim();
    const changedLinesTotal = Number.parseInt(String(evidence.scope_changed_lines_total || 0), 10) || 0;
    if (!detectionSource || !scopeSha256 || !changedFilesSha256) {
        return {
            ready: false,
            reason: 'Compile gate evidence is missing scope snapshot fields; rerun compile-gate.'
        };
    }
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked,
        changedFiles
    );
    if (
        currentScope.scope_sha256 !== scopeSha256
        || currentScope.changed_files_sha256 !== changedFilesSha256
        || currentScope.changed_lines_total !== changedLinesTotal
    ) {
        return {
            ready: false,
            reason: 'Workspace changed after compile gate; rerun compile-gate before review preparation.'
        };
    }
    return {
        ready: true,
        reason: 'Compile gate evidence is current.'
    };
}

function buildCommand(label: string, command: string): NextStepCommand {
    return { label, command };
}

function buildNavigatorCommand(cliPrefix: string, taskId: string): string {
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

function buildResult(params: {
    taskId: string;
    navigatorCommand: string;
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
}): NextStepResult {
    return {
        schema_version: 1,
        task_id: params.taskId,
        generated_utc: new Date().toISOString(),
        navigator_command: params.navigatorCommand,
        status: params.status,
        next_gate: params.nextGate,
        title: params.title,
        reason: params.reason,
        commands: params.commands,
        missing_artifacts: params.missingArtifacts,
        present_artifacts: params.presentArtifacts,
        full_suite_validation: params.fullSuite,
        review: params.review,
        audit_status: params.auditStatus
    };
}

function buildTaskEntryRulePackCommand(repoRoot: string, cliPrefix: string, taskId: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "TASK_ENTRY"',
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--repo-root "."'
    ].join(' ');
}

function buildPostPreflightRulePackCommand(repoRoot: string, cliPrefix: string, taskId: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--loaded-rule-file "<task-specific-rule-file>"',
        '--repo-root "."'
    ].join(' ');
}

function resolveRulePackStage(rulePack: Record<string, unknown> | null): string | null {
    const latestStage = typeof rulePack?.latest_stage === 'string'
        ? rulePack.latest_stage.trim()
        : '';
    if (latestStage) {
        return latestStage;
    }
    return typeof rulePack?.stage === 'string' ? rulePack.stage.trim() || null : null;
}

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const cliPrefix = buildCliPrefix(repoRoot);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`);
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const rulePackPath = path.join(reviewsRoot, `${taskId}-rule-pack.json`);
    const preflight = safeReadJson(preflightPath);
    const rulePack = safeReadJson(rulePackPath);
    const summary = buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
    const fullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
    const fullSuiteSummary: NextStepFullSuiteSummary = {
        enabled: fullSuiteConfig.enabled,
        command: fullSuiteConfig.command,
        config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
        config_source: 'effective_workflow_config',
        note: fullSuiteConfig.enabled
            ? 'Full-suite validation is mandatory because the effective workflow config enables it.'
            : 'Full-suite validation is disabled in the effective workflow config.'
    };
    const requiredReviewTypes = getRequiredReviewTypes(summary.required_reviews);
    const reviewPolicy = resolveReviewPolicy(preflight);
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(reviewsRoot, taskId, reviewType)
    ));
    const nextReview = getNextReviewType(
        requiredReviewTypes,
        reviewPolicy.mode,
        summary.required_reviews,
        reviewStates,
        eventsRoot,
        taskId
    );
    const reviewTrust = readReviewTrust(reviewsRoot, taskId, requiredReviewTypes, summary.scope_category);
    const reviewSummary: NextStepReviewSummary = {
        required_reviews: requiredReviewTypes,
        review_execution_policy_mode: reviewPolicy.mode,
        review_execution_policy_source: reviewPolicy.source,
        next_review_type: nextReview.reviewType,
        blocked_review_dependencies: nextReview.blockedDependencies,
        trust: reviewTrust,
        trust_note: reviewTrust?.visible_summary_line || (
            requiredReviewTypes.length > 0
                ? 'Review trust is unavailable until required review receipts exist.'
                : null
        )
    };
    const coreArtifacts = artifactState(repoRoot, [
        { key: 'task-mode', path: path.join(reviewsRoot, `${taskId}-task-mode.json`) },
        { key: 'rule-pack', path: rulePackPath },
        { key: 'handshake', path: path.join(reviewsRoot, `${taskId}-handshake.json`) },
        { key: 'shell-smoke', path: path.join(reviewsRoot, `${taskId}-shell-smoke.json`) },
        { key: 'preflight', path: preflightPath },
        { key: 'compile-gate', path: path.join(reviewsRoot, `${taskId}-compile-gate.json`) },
        { key: 'review-gate', path: path.join(reviewsRoot, `${taskId}-review-gate.json`) },
        { key: 'doc-impact', path: path.join(reviewsRoot, `${taskId}-doc-impact.json`) },
        { key: 'full-suite-validation', path: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`) },
        { key: 'completion-gate', path: path.join(reviewsRoot, `${taskId}-completion-gate.json`) }
    ]);

    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: coreArtifacts.missing,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        review: reviewSummary,
        auditStatus: summary.status
    };

    if (!isGatePassed(summary, 'enter-task-mode')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: 'No TASK_MODE_ENTERED event exists for this task.',
            commands: [
                buildCommand(
                    'Enter task mode',
                    `${cliPrefix} gate enter-task-mode --task-id "${taskId}" --entry-mode "EXPLICIT_TASK_EXECUTION" --requested-depth "<1|2|3>" --task-summary "<TASK.md summary>" --start-banner "<repo-owned-banner>" --provider "<provider>" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'load-rule-pack') || resolveRulePackStage(rulePack) !== 'TASK_ENTRY' && !preflight) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [buildCommand('Load TASK_ENTRY rules', buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId))]
        });
    }

    if (!isGatePassed(summary, 'handshake-diagnostics')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!isGatePassed(summary, 'shell-smoke-preflight')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!preflight || !isGatePassed(summary, 'classify-change')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Classify the task scope.',
            reason: 'No current preflight artifact exists, so required reviews and compile scope are unknown.',
            commands: [
                buildCommand(
                    'Classify changed files',
                    `${cliPrefix} gate classify-change --task-id "${taskId}" --task-intent "<task summary>" --changed-file "<path>" --output-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (resolveRulePackStage(rulePack) !== 'POST_PREFLIGHT') {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record POST_PREFLIGHT rule files.',
            reason: 'Preflight exists; downstream rule files and risk-specific packs must be recorded for the current scope.',
            commands: [buildCommand('Load POST_PREFLIGHT rules', buildPostPreflightRulePackCommand(repoRoot, cliPrefix, taskId))]
        });
    }

    const compileReadiness = preflight
        ? readCompileReadiness(repoRoot, reviewsRoot, taskId, preflightPath)
        : { ready: false, reason: 'No current preflight exists.' };
    if (!isGatePassed(summary, 'compile-gate') || !compileReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Run compile gate.',
            reason: compileReadiness.reason,
            commands: [
                buildCommand(
                    'Run compile gate',
                    `${cliPrefix} gate compile-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (nextReview.reviewType) {
        const reviewType = nextReview.reviewType;
        const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
        const dependencies = nextReview.blockedDependencies;
        if (dependencies.length > 0) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Review '${reviewType}' is waiting for upstream review evidence.`,
                reason: `Configured review policy '${reviewPolicy.mode}' requires: ${dependencies.join(', ')}.`,
                commands: [
                    buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    )
                ]
            });
        }
        if (!state || !state.contextExists) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Prepare '${reviewType}' review context.`,
                reason: `Required review '${reviewType}' has no canonical review-context artifact.`,
                commands: [
                    buildCommand(
                        'Build review context',
                        `${cliPrefix} gate build-review-context --review-type "${reviewType}" --depth "<1|2|3>" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
        if (!state.ready || !timelineHasDelegatedReviewRoute(eventsRoot, taskId, state)) {
            const stateViolations = state.violations.length > 0
                ? state.violations.join('; ')
                : 'matching REVIEWER_DELEGATION_ROUTED telemetry is missing';
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `Required review '${reviewType}' needs a valid delegated artifact and receipt (${stateViolations}). Expected PASS token: ${state.passToken || '<review-pass-token>'}.`,
                commands: [
                    buildCommand(
                        'Record delegated review output',
                        `${cliPrefix} gate record-review-result --task-id "${taskId}" --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --review-output-path ".review-temp/${taskId}/${reviewType}/review-output.md" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
    }

    if (!isGatePassed(summary, 'required-reviews-check')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'required-reviews-check',
            title: 'Run required reviews check.',
            reason: 'All required review artifacts appear present, but the review gate has not validated them.',
            commands: [
                buildCommand(
                    'Run required reviews check',
                    `${cliPrefix} gate required-reviews-check --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'doc-impact-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'doc-impact-gate',
            title: 'Record documentation impact.',
            reason: 'Completion requires an explicit docs decision.',
            commands: [
                buildCommand(
                    'Run doc impact gate',
                    `${cliPrefix} gate doc-impact-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --decision "<DOCS_UPDATED|NO_DOC_UPDATES>" --behavior-changed <true|false> --changelog-updated <true|false> --rationale "<why>" --repo-root "."`
                )
            ]
        });
    }

    if (fullSuiteConfig.enabled && !isGatePassed(summary, 'full-suite-validation')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run full-suite validation.',
            reason: `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path}. Command: ${fullSuiteConfig.command}.`,
            commands: [
                buildCommand(
                    'Run full-suite validation',
                    `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'completion-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'completion-gate',
            title: 'Run completion gate.',
            reason: 'All upstream gates appear ready; completion has not finalized the task.',
            commands: [
                buildCommand(
                    'Run completion gate',
                    `${cliPrefix} gate completion-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    return buildResult({
        ...resultBase,
        status: 'DONE',
        nextGate: null,
        title: 'Task gate flow is complete.',
        reason: 'Completion gate passed. Use task-audit-summary for final reporting and commit guidance.',
        commands: [
            buildCommand(
                'Build final audit summary',
                `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`
            )
        ]
    });
}

export function formatNextStepText(result: NextStepResult): string {
    const lines = [
        'GARDA_NEXT_STEP',
        `Task: ${result.task_id}`,
        `Navigator: ${result.navigator_command}`,
        `Status: ${result.status}`,
        `NextGate: ${result.next_gate || 'none'}`,
        `Title: ${result.title}`,
        `Reason: ${result.reason}`,
        `FullSuite: enabled=${result.full_suite_validation.enabled}; command="${result.full_suite_validation.command}"; config=${result.full_suite_validation.config_path}`,
        `ReviewPolicy: ${result.review.review_execution_policy_mode} (${result.review.review_execution_policy_source})`
    ];
    if (result.review.required_reviews.length > 0) {
        lines.push(`RequiredReviews: ${result.review.required_reviews.join(', ')}`);
    } else {
        lines.push('RequiredReviews: none');
    }
    if (result.review.next_review_type) {
        lines.push(`NextReview: ${result.review.next_review_type}`);
    }
    if (result.review.blocked_review_dependencies.length > 0) {
        lines.push(`ReviewBlockedBy: ${result.review.blocked_review_dependencies.join(', ')}`);
        lines.push(`BlockedReviewerLaunches: do not prepare or launch '${result.review.next_review_type}' until current-cycle ${result.review.blocked_review_dependencies.join(', ')} review artifacts and receipts pass.`);
    }
    if (result.review.trust_note) {
        lines.push(result.review.trust_note);
    }
    if (result.missing_artifacts.length > 0) {
        lines.push(`MissingArtifacts: ${result.missing_artifacts.map((artifact) => artifact.key).join(', ')}`);
    }
    lines.push('');
    lines.push('Commands:');
    for (const command of result.commands) {
        lines.push(`  ${command.label}: ${command.command}`);
    }
    if (result.status !== 'DONE') {
        lines.push(`AfterCommand: rerun ${result.navigator_command} after the command above completes.`);
    }
    return `${lines.join('\n')}\n`;
}

function parseTaskIdFromPreflightPath(preflightPath: string): string | null {
    const basename = path.basename(preflightPath).trim();
    const suffix = '-preflight.json';
    if (!basename.endsWith(suffix)) {
        return null;
    }
    return basename.slice(0, -suffix.length) || null;
}

function pickConsistentTaskId(candidates: Array<{ source: string; value: string | null }>): string {
    const normalized = candidates
        .map((candidate) => ({
            source: candidate.source,
            value: String(candidate.value || '').trim()
        }))
        .filter((candidate) => candidate.value);
    const uniqueValues = [...new Set(normalized.map((candidate) => candidate.value))];
    if (uniqueValues.length > 1) {
        throw new Error(`Conflicting task identifiers for next-step: ${normalized.map((candidate) => `${candidate.source}=${candidate.value}`).join(', ')}.`);
    }
    return uniqueValues[0] || '';
}

export function resolveNextStepFromCliOptions(options: {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    preflightPath?: unknown;
    positionals?: unknown;
}): NextStepResult {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const positionals = Array.isArray(options.positionals)
        ? options.positionals.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const preflightPathText = String(options.preflightPath || '').trim();
    const resolvedPreflightPath = preflightPathText
        ? resolvePathInsideRepo(preflightPathText, repoRoot, { allowMissing: true })
        : null;
    const taskId = pickConsistentTaskId([
        { source: '--task-id', value: String(options.taskId || '').trim() || null },
        { source: 'positional', value: positionals[0] || null },
        { source: '--preflight-path', value: resolvedPreflightPath ? parseTaskIdFromPreflightPath(resolvedPreflightPath) : null }
    ]);
    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(String(options.reviewsRoot), repoRoot, { allowMissing: true })
        : resolvedPreflightPath
            ? path.dirname(resolvedPreflightPath)
        : null;
    const eventsRoot = options.eventsRoot
        ? resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true })
        : null;
    return resolveNextStep({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
}
