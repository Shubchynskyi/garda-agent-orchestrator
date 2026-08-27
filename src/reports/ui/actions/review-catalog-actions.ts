import type * as http from 'node:http';

import { buildReviewCatalogManagementPlan } from '../../../cli/commands/review-catalog/review-catalog-plan';
import { buildMutationCommandResult } from '../../../cli/commands/review-catalog/review-catalog-rendering';
import {
    readReviewCatalogManagedState,
    resolveReviewCatalogRoots
} from '../../../cli/commands/review-catalog/review-catalog-state';
import {
    commitReviewCatalogManagementPlan,
    issueReviewCatalogConfirmationReceipt
} from '../../../cli/commands/review-catalog/review-catalog-transaction';
import type {
    ReviewCatalogMutationOperation,
    ReviewCatalogMutationRequest,
    ReviewCatalogProfileState
} from '../../../cli/commands/review-catalog/review-catalog-types';
import type { ParsedOptionsRecord } from '../../../cli/commands/profile/profile-types';
import { buildReviewCatalogTab } from '../../report-data-contract';
import { resolveBundleRoot } from './action-common';
import {
    isValidActionRequestBoundary,
    readJsonBody,
    sendApiError,
    sendJson,
    type LocalUiServerRuntimeOptions
} from './http/action-http-common';

const REVIEW_CATALOG_CONFIRMATION_PHRASE = 'APPLY REVIEW CATALOG CHANGE';
const MUTATION_OPERATIONS = new Set<ReviewCatalogMutationOperation>([
    'create',
    'update',
    'enable',
    'disable',
    'profile-bind',
    'dependency'
]);
const REQUEST_KEYS = new Set([
    'operation',
    'review_id',
    'mode',
    'confirmation',
    'expected_state_sha256',
    'expected_plan_sha256',
    'display_label',
    'skill_id',
    'trigger_mode',
    'signal_ids',
    'coverage_category_ids',
    'role_id',
    'focus_tags',
    'profile_name',
    'profile_state',
    'dependency_ids',
    'clear_dependencies'
]);

interface UiReviewCatalogRequest {
    operation: ReviewCatalogMutationOperation;
    reviewId: string;
    mode: 'preview' | 'execute';
    confirmation?: string;
    expectedStateSha256?: string;
    expectedPlanSha256?: string;
    mutation: ReviewCatalogMutationRequest;
}

function requirePlainObject(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('Review catalog request must be a JSON object.');
    }
    return value as Record<string, unknown>;
}

function optionalString(value: unknown, label: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string.`);
    return value.trim();
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw new Error(`${label} must be a string array.`);
    }
    return value.map((entry) => entry.trim());
}

function optionalSha256(value: unknown, label: string): string | undefined {
    const normalized = optionalString(value, label)?.toLowerCase();
    if (normalized !== undefined && !/^[a-f0-9]{64}$/u.test(normalized)) {
        throw new Error(`${label} must be a SHA-256 hex string from the current preview.`);
    }
    return normalized;
}

function normalizeRequest(payload: unknown): UiReviewCatalogRequest {
    const raw = requirePlainObject(payload);
    for (const key of Object.keys(raw)) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey.includes('prompt') || normalizedKey.includes('secret') || normalizedKey.includes('token')) {
            throw new Error(`Review catalog request rejects unsafe field '${key}'.`);
        }
        if (!REQUEST_KEYS.has(key)) throw new Error(`Review catalog request does not support field '${key}'.`);
    }
    const operation = optionalString(raw.operation, 'operation') as ReviewCatalogMutationOperation | undefined;
    if (!operation || !MUTATION_OPERATIONS.has(operation)) {
        throw new Error('operation must be create, update, enable, disable, profile-bind, or dependency.');
    }
    const mode = raw.mode === undefined ? 'preview' : optionalString(raw.mode, 'mode');
    if (mode !== 'preview' && mode !== 'execute') throw new Error('mode must be preview or execute.');
    const reviewId = optionalString(raw.review_id, 'review_id');
    if (!reviewId) throw new Error('review_id is required.');
    const triggerMode = optionalString(raw.trigger_mode, 'trigger_mode');
    if (triggerMode !== undefined && triggerMode !== 'manual' && triggerMode !== 'signals') {
        throw new Error('trigger_mode must be manual or signals.');
    }
    const profileState = optionalString(raw.profile_state, 'profile_state');
    if (
        profileState !== undefined
        && profileState !== 'disabled'
        && profileState !== 'auto'
        && profileState !== 'required'
    ) {
        throw new Error('profile_state must be disabled, auto, or required.');
    }
    if (raw.clear_dependencies !== undefined && typeof raw.clear_dependencies !== 'boolean') {
        throw new Error('clear_dependencies must be boolean.');
    }
    return {
        operation,
        reviewId,
        mode,
        confirmation: optionalString(raw.confirmation, 'confirmation'),
        expectedStateSha256: optionalSha256(raw.expected_state_sha256, 'expected_state_sha256'),
        expectedPlanSha256: optionalSha256(raw.expected_plan_sha256, 'expected_plan_sha256'),
        mutation: {
            operation,
            reviewId,
            displayLabel: optionalString(raw.display_label, 'display_label'),
            skillId: optionalString(raw.skill_id, 'skill_id'),
            triggerMode: triggerMode as 'manual' | 'signals' | undefined,
            signalIds: optionalStringArray(raw.signal_ids, 'signal_ids'),
            coverageCategoryIds: optionalStringArray(raw.coverage_category_ids, 'coverage_category_ids'),
            roleId: optionalString(raw.role_id, 'role_id'),
            focusTags: optionalStringArray(raw.focus_tags, 'focus_tags'),
            profileName: optionalString(raw.profile_name, 'profile_name'),
            profileState: profileState as ReviewCatalogProfileState | undefined,
            dependencyIds: optionalStringArray(raw.dependency_ids, 'dependency_ids'),
            clearDependencies: raw.clear_dependencies as boolean | undefined
        }
    };
}

function commandRoots(repoRoot: string): ParsedOptionsRecord {
    return {
        targetRoot: repoRoot,
        bundleRoot: resolveBundleRoot(repoRoot)
    };
}

function responsePayload(
    request: UiReviewCatalogRequest,
    planResult: Record<string, unknown>,
    status: string,
    extras: Record<string, unknown> = {}
): Record<string, unknown> {
    return {
        ...planResult,
        mode: request.mode,
        status,
        requires_confirmation: true,
        confirmation_phrase: REVIEW_CATALOG_CONFIRMATION_PHRASE,
        ...extras
    };
}

export function buildUiReviewCatalogPayload(
    repoRoot: string,
    actionsEnabled: boolean,
    profileName?: string | null
): Record<string, unknown> {
    return {
        enabled: actionsEnabled,
        ...buildReviewCatalogTab(repoRoot, profileName)
    };
}

export async function handleUiReviewCatalogRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    repoRoot: string,
    options: LocalUiServerRuntimeOptions
): Promise<void> {
    if (!options.actionsEnabled) {
        sendApiError(
            response,
            403,
            'Review catalog actions are disabled. Restart with --actions to enable guarded changes.',
            'review_catalog_actions_disabled'
        );
        return;
    }
    if (!isValidActionRequestBoundary(request, options)) {
        sendApiError(
            response,
            403,
            'Review catalog request failed origin, token, or content-type validation.',
            'action_boundary_rejected'
        );
        return;
    }

    let normalized: UiReviewCatalogRequest;
    try {
        normalized = normalizeRequest(await readJsonBody(request, 32 * 1024));
    } catch (error: unknown) {
        sendApiError(response, 400, error instanceof Error ? error.message : String(error), 'invalid_review_catalog_request');
        return;
    }

    try {
        const roots = resolveReviewCatalogRoots(commandRoots(repoRoot));
        const state = readReviewCatalogManagedState(roots);
        const plan = buildReviewCatalogManagementPlan(state, normalized.mutation);
        const previewResult = buildMutationCommandResult(plan, null);
        if (normalized.mode === 'preview') {
            sendJson(response, 200, responsePayload(normalized, previewResult, 'previewed'));
            return;
        }
        if (normalized.confirmation !== REVIEW_CATALOG_CONFIRMATION_PHRASE) {
            sendJson(response, 409, responsePayload(normalized, previewResult, 'confirmation_required'));
            return;
        }
        if (!normalized.expectedStateSha256 || !normalized.expectedPlanSha256) {
            sendApiError(
                response,
                400,
                'execute requires expected_state_sha256 and expected_plan_sha256 from the inspected preview.',
                'invalid_review_catalog_request'
            );
            return;
        }
        const confirmation = issueReviewCatalogConfirmationReceipt({
            repoRoot: roots.repoRoot,
            bundleRoot: roots.bundleRoot,
            plan,
            expectedStateSha256: normalized.expectedStateSha256,
            expectedPlanSha256: normalized.expectedPlanSha256,
            operatorConfirmedAtUtc: new Date().toISOString(),
            readCurrentStateSha256: () => readReviewCatalogManagedState(roots).stateSha256
        });
        const transaction = commitReviewCatalogManagementPlan({
            repoRoot: roots.repoRoot,
            bundleRoot: roots.bundleRoot,
            plan,
            expectedStateSha256: normalized.expectedStateSha256,
            expectedPlanSha256: normalized.expectedPlanSha256,
            confirmationReceiptSha256: confirmation.confirmation_receipt_sha256,
            readCurrentStateSha256: () => readReviewCatalogManagedState(roots).stateSha256
        });
        const appliedResult = buildMutationCommandResult(plan, transaction);
        sendJson(response, 200, responsePayload(normalized, appliedResult, 'executed', {
            transaction_status: transaction.status
        }));
    } catch (error: unknown) {
        sendApiError(
            response,
            409,
            error instanceof Error ? error.message : String(error),
            'review_catalog_guard_rejected'
        );
    }
}
