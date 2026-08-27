import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../core/operator-confirmation';
import { parseOptions, type PackageJsonLike } from '../cli-helpers';
import type { ParsedOptionsRecord } from '../profile/profile-types';
import {
    buildReviewCatalogInspectionLaneSummaries,
    buildReviewCatalogLaneExplanation,
    requireInspectionLane
} from './review-catalog-inspection';
import { buildReviewCatalogManagementPlan } from './review-catalog-plan';
import {
    readReviewCatalogManagedState,
    resolveReviewCatalogRoots
} from './review-catalog-state';
import {
    buildMutationCommandResult,
    formatReviewCatalogResult
} from './review-catalog-rendering';
import {
    commitReviewCatalogManagementPlan,
    issueReviewCatalogConfirmationReceipt
} from './review-catalog-transaction';
import type {
    ReviewCatalogMutationOperation,
    ReviewCatalogMutationRequest,
    ReviewCatalogProfileState
} from './review-catalog-types';

const SHARED_OPTIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

const INSPECTION_OPTIONS = {
    ...SHARED_OPTIONS,
    '--profile': { key: 'profileName', type: 'string' }
};

const MUTATION_OPTIONS = {
    ...SHARED_OPTIONS,
    '--display-label': { key: 'displayLabel', type: 'string' },
    '--skill-id': { key: 'skillId', type: 'string' },
    '--trigger-mode': { key: 'triggerMode', type: 'string' },
    '--signal-id': { key: 'signalIds', type: 'string[]' },
    '--coverage-category': { key: 'coverageCategoryIds', type: 'string[]' },
    '--role-id': { key: 'roleId', type: 'string' },
    '--focus-tag': { key: 'focusTags', type: 'string[]' },
    '--profile': { key: 'profileName', type: 'string' },
    '--state': { key: 'profileState', type: 'string' },
    '--depends-on': { key: 'dependencyIds', type: 'string[]' },
    '--clear-dependencies': { key: 'clearDependencies', type: 'boolean' },
    '--confirm': { key: 'confirm', type: 'boolean' },
    '--apply': { key: 'apply', type: 'boolean' },
    '--expected-state-sha256': { key: 'expectedStateSha256', type: 'string' },
    '--expected-plan-sha256': { key: 'expectedPlanSha256', type: 'string' },
    '--confirmation-receipt-sha256': { key: 'confirmationReceiptSha256', type: 'string' },
    '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
    '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' }
};

const MUTATION_OPERATIONS = new Set<ReviewCatalogMutationOperation>([
    'create',
    'update',
    'enable',
    'disable',
    'profile-bind',
    'dependency'
]);

function normalizeTriggerMode(value: unknown): 'manual' | 'signals' | undefined {
    if (value === undefined) return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (normalized !== 'manual' && normalized !== 'signals') {
        throw new Error('--trigger-mode must be manual or signals.');
    }
    return normalized;
}

function normalizeProfileState(value: unknown): ReviewCatalogProfileState | undefined {
    if (value === undefined) return undefined;
    const normalized = String(value).trim().toLowerCase();
    if (normalized !== 'disabled' && normalized !== 'auto' && normalized !== 'required') {
        throw new Error('--state must be disabled, auto, or required.');
    }
    return normalized;
}

function stringOption(options: ParsedOptionsRecord, key: string): string | undefined {
    const value = options[key];
    return typeof value === 'string' ? value.trim() : undefined;
}

function stringArrayOption(options: ParsedOptionsRecord, key: string): string[] | undefined {
    const value = options[key];
    return Array.isArray(value) ? value.map((entry) => entry.trim()) : undefined;
}

function requestFromOptions(
    operation: ReviewCatalogMutationOperation,
    reviewId: string,
    options: ParsedOptionsRecord
): ReviewCatalogMutationRequest {
    return {
        operation,
        reviewId,
        displayLabel: stringOption(options, 'displayLabel'),
        skillId: stringOption(options, 'skillId'),
        triggerMode: normalizeTriggerMode(options.triggerMode),
        signalIds: stringArrayOption(options, 'signalIds'),
        coverageCategoryIds: stringArrayOption(options, 'coverageCategoryIds'),
        roleId: stringOption(options, 'roleId'),
        focusTags: stringArrayOption(options, 'focusTags'),
        profileName: stringOption(options, 'profileName'),
        profileState: normalizeProfileState(options.profileState),
        dependencyIds: stringArrayOption(options, 'dependencyIds'),
        clearDependencies: options.clearDependencies === true
    };
}

function assertPreviewOnlyOptionsAbsent(options: ParsedOptionsRecord): void {
    const applyOnly = [
        ['expectedStateSha256', '--expected-state-sha256'],
        ['expectedPlanSha256', '--expected-plan-sha256'],
        ['confirmationReceiptSha256', '--confirmation-receipt-sha256'],
        ['operatorConfirmed', '--operator-confirmed'],
        ['operatorConfirmedAtUtc', '--operator-confirmed-at-utc']
    ] as const;
    const present = applyOnly.filter(([key]) => options[key] !== undefined).map(([, flag]) => flag);
    if (present.length > 0) {
        throw new Error(`${present.join(', ')} may be used only with a separate --confirm or --apply step after inspecting a preview.`);
    }
}

function requireApplyConfirmation(options: ParsedOptionsRecord): void {
    const confirmed = options.operatorConfirmed === undefined
        ? false
        : parseOperatorConfirmationYes(options.operatorConfirmed);
    validateFreshOperatorConfirmation({
        actionLabel: 'review-catalog apply',
        confirmed,
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction:
            'Obtain explicit operator confirmation after showing the dry-run diff, then rerun with fresh preview hashes. ' +
            'Agents must not approve protected review-catalog mutations for themselves.'
    });
}

function requireReviewId(positionals: string[], action: string): string {
    const reviewId = String(positionals[0] || '').trim().toLowerCase();
    if (!reviewId) throw new Error(`Review id is required for 'review-catalog ${action}'.`);
    return reviewId;
}

function printResult(result: Record<string, unknown>, options: ParsedOptionsRecord): Record<string, unknown> {
    console.log(formatReviewCatalogResult(result, options.json === true));
    return result;
}

function handleInspection(
    action: 'list' | 'show' | 'explain' | 'validate',
    positionals: string[],
    options: ParsedOptionsRecord
): Record<string, unknown> {
    const roots = resolveReviewCatalogRoots(options);
    if (action === 'validate') {
        try {
            const state = readReviewCatalogManagedState(roots);
            return printResult({
                action,
                status: 'PASS',
                issues: [],
                catalog_exists: state.catalogExists,
                catalog_sha256: state.catalog.catalog_sha256,
                state_sha256: state.stateSha256
            }, options);
        } catch (error: unknown) {
            return printResult({
                action,
                status: 'FAIL',
                issues: [error instanceof Error ? error.message : String(error)]
            }, options);
        }
    }
    const state = readReviewCatalogManagedState(roots);
    if (action === 'list') {
        return printResult({
            action,
            catalog_exists: state.catalogExists,
            catalog_sha256: state.catalog.catalog_sha256,
            state_sha256: state.stateSha256,
            lanes: buildReviewCatalogInspectionLaneSummaries(state)
        }, options);
    }
    const reviewId = requireReviewId(positionals, action);
    if (action === 'show') {
        return printResult({
            action,
            catalog_exists: state.catalogExists,
            catalog_sha256: state.catalog.catalog_sha256,
            state_sha256: state.stateSha256,
            lane: requireInspectionLane(state, reviewId)
        }, options);
    }
    const profileName = stringOption(options, 'profileName') || state.profiles.active_profile;
    return printResult({
        action,
        review_id: reviewId,
        profile: profileName,
        explanation: buildReviewCatalogLaneExplanation(state, reviewId, profileName)
    }, options);
}

function handleMutation(
    operation: ReviewCatalogMutationOperation,
    positionals: string[],
    options: ParsedOptionsRecord
): Record<string, unknown> {
    const roots = resolveReviewCatalogRoots(options);
    const state = readReviewCatalogManagedState(roots);
    const reviewId = requireReviewId(positionals, operation);
    const request = requestFromOptions(operation, reviewId, options);
    const plan = buildReviewCatalogManagementPlan(state, request);
    const confirm = options.confirm === true;
    const apply = options.apply === true;
    if (confirm && apply) {
        throw new Error('--confirm and --apply are separate review-catalog phases and cannot be combined.');
    }
    if (!confirm && !apply) {
        assertPreviewOnlyOptionsAbsent(options);
        return printResult(buildMutationCommandResult(plan, null), options);
    }
    if (confirm) {
        if (options.confirmationReceiptSha256 !== undefined) {
            throw new Error('--confirmation-receipt-sha256 is produced by --confirm and cannot be supplied to it.');
        }
        requireApplyConfirmation(options);
        const confirmation = issueReviewCatalogConfirmationReceipt({
            repoRoot: roots.repoRoot,
            bundleRoot: roots.bundleRoot,
            plan,
            expectedStateSha256: stringOption(options, 'expectedStateSha256') || '',
            expectedPlanSha256: stringOption(options, 'expectedPlanSha256') || '',
            operatorConfirmedAtUtc: stringOption(options, 'operatorConfirmedAtUtc') || '',
            readCurrentStateSha256: () => readReviewCatalogManagedState(roots).stateSha256
        });
        return printResult({
            ...buildMutationCommandResult(plan, null),
            mode: 'confirmation',
            status: confirmation.status,
            confirmation_receipt_sha256: confirmation.confirmation_receipt_sha256,
            confirmation_receipt_path: confirmation.confirmation_receipt_path,
            confirmed_at_utc: confirmation.confirmed_at_utc
        }, options);
    }
    const selfConfirmationFlags = [
        options.operatorConfirmed === undefined ? null : '--operator-confirmed',
        options.operatorConfirmedAtUtc === undefined ? null : '--operator-confirmed-at-utc'
    ].filter((flag): flag is string => flag !== null);
    if (selfConfirmationFlags.length > 0) {
        throw new Error(
            `Self-confirmation is rejected: ${selfConfirmationFlags.join(', ')} cannot be supplied to --apply. ` +
            'Run a separate operator-approved --confirm step and pass its one-time --confirmation-receipt-sha256.'
        );
    }
    const transaction = commitReviewCatalogManagementPlan({
        repoRoot: roots.repoRoot,
        bundleRoot: roots.bundleRoot,
        plan,
        expectedStateSha256: stringOption(options, 'expectedStateSha256') || '',
        expectedPlanSha256: stringOption(options, 'expectedPlanSha256') || '',
        confirmationReceiptSha256: stringOption(options, 'confirmationReceiptSha256') || '',
        readCurrentStateSha256: () => readReviewCatalogManagedState(roots).stateSha256
    });
    return printResult(buildMutationCommandResult(plan, transaction), options);
}

export function handleReviewCatalog(
    commandArgv: string[],
    packageJson: PackageJsonLike
): Record<string, unknown> | null {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitAction = firstArg.length > 0 && !firstArg.startsWith('-');
    const action = hasExplicitAction ? firstArg : 'list';
    const actionArgv = hasExplicitAction ? commandArgv.slice(1) : commandArgv;
    const mutation = MUTATION_OPERATIONS.has(action as ReviewCatalogMutationOperation);
    const { options, positionals } = parseOptions(
        actionArgv,
        mutation ? MUTATION_OPTIONS : INSPECTION_OPTIONS,
        { allowPositionals: action === 'show' || action === 'explain' || mutation, maxPositionals: 1 }
    );
    if (options.help) {
        console.log('review-catalog: list, show, explain, validate, create, update, enable, disable, profile-bind, dependency');
        return null;
    }
    if (options.version) {
        console.log(packageJson.version);
        return null;
    }
    if (action === 'list' || action === 'show' || action === 'explain' || action === 'validate') {
        return handleInspection(action, positionals, options as ParsedOptionsRecord);
    }
    if (mutation) {
        return handleMutation(action as ReviewCatalogMutationOperation, positionals, options as ParsedOptionsRecord);
    }
    throw new Error(
        `Unknown review-catalog action: ${action}. Allowed values: list, show, explain, validate, create, update, enable, disable, profile-bind, dependency.`
    );
}
