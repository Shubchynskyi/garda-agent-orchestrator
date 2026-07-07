import { createHash } from 'node:crypto';

import {
    redactSecretText
} from '../../../../core/redaction';
import {
    assertReviewTreeStateFresh
} from '../../../../gates/review/review-tree-state';
import {
    buildGateCommandPrefix,
    quotePowerShellCliValue
} from '../../gate-flows/task-mode/task-mode-command-format';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function sha256ReviewArtifactContent(content: string): string {
    return createHash('sha256')
        .update(redactSecretText(content))
        .digest('hex');
}

export function buildSafeReviewOutputRetryInstruction(taskId: string, reviewType: string): string {
    return [
        'Safe recovery:',
        `fix the reviewer output and rerun record-review-result for '${taskId}' '${reviewType}'.`,
        'The canonical raw review-output artifact is replaced only after validation and receipt recording succeed.'
    ].join(' ');
}

export function appendSafeReviewOutputRetryInstruction(error: unknown, taskId: string, reviewType: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const instruction = buildSafeReviewOutputRetryInstruction(taskId, reviewType);
    if (message.includes(instruction)) {
        return error instanceof Error ? error : new Error(message);
    }
    return new Error(`${message}\n\n${instruction}`);
}

function getReviewContextTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = isPlainRecord(reviewContext.tree_state)
        ? reviewContext.tree_state
        : null;
    const sha256 = String(treeState?.tree_state_sha256 ?? treeState?.treeStateSha256 ?? '').trim().toLowerCase();
    return sha256 || null;
}

export function isFailedReviewVerdictToken(verdictToken: string, expectedFailVerdict: string): boolean {
    const normalizedVerdict = verdictToken.trim().toUpperCase();
    const normalizedExpectedFail = expectedFailVerdict.trim().toUpperCase();
    return normalizedVerdict === normalizedExpectedFail || normalizedVerdict.endsWith(' REVIEW FAILED');
}

export function assertReviewTreeStateFreshOrHistoricalFailure(options: {
    repoRoot: string;
    reviewContext: Record<string, unknown>;
    contextPath: string;
    gateName: string;
    allowHistoricalFailedReviewResult: boolean;
}): string | null {
    try {
        assertReviewTreeStateFresh({
            repoRoot: options.repoRoot,
            reviewContext: options.reviewContext,
            contextPath: options.contextPath,
            gateName: options.gateName
        });
        return null;
    } catch (error: unknown) {
        if (!options.allowHistoricalFailedReviewResult) {
            throw error;
        }
        if (!getReviewContextTreeStateSha256(options.reviewContext)) {
            throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        return reason.trim() || 'review context tree-state became stale before failed review result materialization';
    }
}

function parseUtcTimestampMs(value: unknown): number | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

export function getDelegationStartedAtUtc(value: unknown): string | null {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const text = String(record?.delegation_started_at_utc ?? '').trim();
    return text || null;
}

export function assertReviewOutputNotOlderThanDelegation(options: {
    taskId: string;
    reviewType: string;
    preflightPath: string;
    repoRoot: string;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    reviewOutputSourcePath: string | null | undefined;
    reviewOutputSourceMtimeUtc: string | null | undefined;
    delegationStartedAtUtc: string | null | undefined;
}): void {
    const reviewOutputSourceMtimeMs = parseUtcTimestampMs(options.reviewOutputSourceMtimeUtc);
    const delegationStartedAtMs = parseUtcTimestampMs(options.delegationStartedAtUtc);
    if (reviewOutputSourceMtimeMs == null) {
        return;
    }
    const stdinGateCommand = [
        `${buildGateCommandPrefix(options.repoRoot)} gate record-review-result`,
        '--task-id', quotePowerShellCliValue(options.taskId),
        '--review-type', quotePowerShellCliValue(options.reviewType),
        '--preflight-path', quotePowerShellCliValue(options.preflightPath),
        '--review-output-stdin',
        '--repo-root', quotePowerShellCliValue(options.repoRoot),
        '--reviewer-execution-mode', quotePowerShellCliValue(options.reviewerExecutionMode),
        '--reviewer-identity', quotePowerShellCliValue(options.reviewerIdentity)
    ].join(' ');
    const stdinCommand = options.reviewOutputSourcePath
        ? `Get-Content -Raw -LiteralPath ${quotePowerShellCliValue(options.reviewOutputSourcePath)} | ${stdinGateCommand}`
        : stdinGateCommand;
    if (delegationStartedAtMs == null) {
        throw new Error(
            `Review output path-mode timing is ambiguous for '${options.reviewType}': ` +
            'delegation_started_at_utc is missing or invalid, so path metadata cannot prove post-delegation authorship. ' +
            'Receipt materialization remains blocked.\n\n' +
            'Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin after ' +
            `delegation evidence exists. PowerShell-safe command:\n${stdinCommand}\n` +
            'Do not backdate delegation evidence or edit file mtimes to bypass this check.'
        );
    }
    if (reviewOutputSourceMtimeMs >= delegationStartedAtMs) {
        return;
    }
    throw new Error(
        `Review output path-mode timing is impossible for '${options.reviewType}': ` +
        `review_output_source_mtime_utc (${options.reviewOutputSourceMtimeUtc}) is earlier than ` +
        `delegation_started_at_utc (${options.delegationStartedAtUtc}). ` +
        'This usually means the delegated reviewer wrote the output file before delegation-start evidence was recorded, ' +
        'so path metadata cannot prove post-delegation authorship. Receipt materialization remains blocked.\n\n' +
        'Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin after ' +
        `delegation evidence exists. PowerShell-safe command:\n${stdinCommand}\n` +
        'Do not backdate delegation evidence or edit file mtimes to bypass this check.'
    );
}
