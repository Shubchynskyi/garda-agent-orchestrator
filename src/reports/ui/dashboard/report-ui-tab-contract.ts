export const REPORT_UI_TAB_PATH_KINDS = Object.freeze([
    'source',
    'config',
    'directory',
    'artifact'
] as const);

export type ReportUiTabPathKind = typeof REPORT_UI_TAB_PATH_KINDS[number];

export interface ReportUiTabLabel {
    /** Local UI text key when the renderer supports language packs. */
    key: string;
    /** Stable label for static HTML and language-pack fallback. */
    fallback: string;
}

export interface ReportUiTabPathMetadata<TStatus extends string = string> {
    id: string;
    label: string;
    kind: ReportUiTabPathKind;
    path: string | null;
    status: TStatus | null;
}

export interface ReportUiTabMetadata<TStatus extends string = string> {
    id: string;
    label: ReportUiTabLabel;
    status: TStatus;
    paths: readonly ReportUiTabPathMetadata<TStatus>[];
}

export interface ReportUiTabPathContract<TData, TStatus extends string = string> {
    id: string;
    label: string;
    kind: ReportUiTabPathKind;
    path: (data: TData) => string | null | undefined;
    status?: (data: TData) => TStatus | null | undefined;
}

export type ReportUiTabActionHook<TData, TContext = void, TResult = void> = (
    data: TData,
    context: TContext
) => TResult | Promise<TResult>;

export type ReportUiTabActionHooks<TData, TContext = void> = Readonly<
    Record<string, ReportUiTabActionHook<TData, TContext, unknown>>
>;

export interface ReportUiTabContract<
    TData,
    TStatus extends string = string,
    TActions extends ReportUiTabActionHooks<TData, never> = ReportUiTabActionHooks<TData, never>
> {
    id: string;
    label: ReportUiTabLabel;
    status: (data: TData) => TStatus;
    paths?: readonly ReportUiTabPathContract<TData, TStatus>[];
    actions?: TActions;
}

function requireNonEmpty(value: string, field: string): string {
    const normalized = String(value || '').trim();
    if (!normalized) {
        throw new Error(`Report UI tab ${field} must be a non-empty string.`);
    }
    return normalized;
}

function normalizePath(value: string | null | undefined): string | null {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function requirePathKind(value: ReportUiTabPathKind, pathId: string): ReportUiTabPathKind {
    if (!REPORT_UI_TAB_PATH_KINDS.includes(value)) {
        throw new Error(`Report UI tab path '${pathId}' has unsupported kind '${String(value)}'.`);
    }
    return value;
}

/**
 * Defines and validates a reusable reports UI tab contract without coupling it
 * to either the live dashboard or the static HTML renderer.
 */
export function defineReportUiTabContract<
    TData,
    TStatus extends string,
    TActions extends ReportUiTabActionHooks<TData, never>
>(
    contract: ReportUiTabContract<TData, TStatus, TActions>
): Readonly<ReportUiTabContract<TData, TStatus, TActions>> {
    const id = requireNonEmpty(contract.id, 'id');
    const label = Object.freeze({
        key: requireNonEmpty(contract.label.key, 'label key'),
        fallback: requireNonEmpty(contract.label.fallback, 'label fallback')
    });
    const seenPathIds = new Set<string>();
    const paths = Object.freeze((contract.paths || []).map((pathContract) => {
        const pathId = requireNonEmpty(pathContract.id, 'path id');
        if (seenPathIds.has(pathId)) {
            throw new Error(`Report UI tab '${id}' contains duplicate path id '${pathId}'.`);
        }
        seenPathIds.add(pathId);
        return Object.freeze({
            ...pathContract,
            id: pathId,
            label: requireNonEmpty(pathContract.label, `path '${pathId}' label`),
            kind: requirePathKind(pathContract.kind, pathId)
        });
    }));
    const actions = contract.actions ? Object.freeze({ ...contract.actions }) : undefined;

    return Object.freeze({
        ...contract,
        id,
        label,
        paths,
        ...(actions ? { actions } : {})
    });
}

/** Resolves the serializable metadata shared by reports UI renderers. */
export function buildReportUiTabMetadata<TData, TStatus extends string>(
    contract: ReportUiTabContract<TData, TStatus>,
    data: TData
): Readonly<ReportUiTabMetadata<TStatus>> {
    const paths = Object.freeze((contract.paths || []).map((pathContract) => Object.freeze({
        id: pathContract.id,
        label: pathContract.label,
        kind: pathContract.kind,
        path: normalizePath(pathContract.path(data)),
        status: pathContract.status?.(data) ?? null
    })));

    return Object.freeze({
        id: contract.id,
        label: contract.label,
        status: contract.status(data),
        paths
    });
}

/** Returns one optional action hook without requiring renderers to branch on actions. */
export function getReportUiTabActionHook<
    TData,
    TActions extends ReportUiTabActionHooks<TData, never>,
    TActionId extends keyof TActions
>(
    contract: ReportUiTabContract<TData, string, TActions>,
    actionId: TActionId
): TActions[TActionId] | null {
    if (!contract.actions || !Object.prototype.hasOwnProperty.call(contract.actions, actionId)) {
        return null;
    }
    return contract.actions[actionId] || null;
}
