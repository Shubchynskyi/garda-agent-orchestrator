export type GateFlowPreflightPipelineValue<T> = T | Promise<T>;

export const GATE_FLOW_PREFLIGHT_PIPELINE_STAGES = [
    'parse',
    'task-mode-evidence',
    'preflight',
    'timeline-readiness',
    'emit'
] as const;

export type GateFlowPreflightPipelineStage = typeof GATE_FLOW_PREFLIGHT_PIPELINE_STAGES[number];

export const GATE_FLOW_PREFLIGHT_PIPELINE_MIGRATION_CHECKLIST = {
    compile: 'pilot-migrated',
    review: 'migrated',
    'full-suite': 'migrated',
    recovery: 'migrated'
} as const;

export interface GateFlowParsedContext<TInput, TParsed> {
    readonly input: TInput;
    readonly parsed: TParsed;
}

export interface GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence>
    extends GateFlowParsedContext<TInput, TParsed> {
    readonly taskModeEvidence: TTaskModeEvidence;
}

export interface GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight>
    extends GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence> {
    readonly preflight: TPreflight;
}

export interface GateFlowTimelineContext<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness
> extends GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight> {
    readonly timelineReadiness: TTimelineReadiness;
}

export interface GateFlowPreflightPipelineExtension<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness
> {
    afterParse?(
        context: GateFlowParsedContext<TInput, TParsed>
    ): GateFlowPreflightPipelineValue<void>;
    afterTaskModeEvidence?(
        context: GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence>
    ): GateFlowPreflightPipelineValue<void>;
    afterPreflight?(
        context: GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight>
    ): GateFlowPreflightPipelineValue<void>;
    afterTimelineReadiness?(
        context: GateFlowTimelineContext<TInput, TParsed, TTaskModeEvidence, TPreflight, TTimelineReadiness>
    ): GateFlowPreflightPipelineValue<void>;
    beforeEmit?(
        context: GateFlowTimelineContext<TInput, TParsed, TTaskModeEvidence, TPreflight, TTimelineReadiness>
    ): GateFlowPreflightPipelineValue<void>;
}

export interface GateFlowPreflightPipeline<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness,
    TOutput
> {
    parse(input: TInput): GateFlowPreflightPipelineValue<TParsed>;
    loadTaskModeEvidence(
        context: GateFlowParsedContext<TInput, TParsed>
    ): GateFlowPreflightPipelineValue<TTaskModeEvidence>;
    loadPreflight(
        context: GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence>
    ): GateFlowPreflightPipelineValue<TPreflight>;
    evaluateTimelineReadiness(
        context: GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight>
    ): GateFlowPreflightPipelineValue<TTimelineReadiness>;
    emit(
        context: GateFlowTimelineContext<TInput, TParsed, TTaskModeEvidence, TPreflight, TTimelineReadiness>
    ): GateFlowPreflightPipelineValue<TOutput>;
    extensions?: ReadonlyArray<GateFlowPreflightPipelineExtension<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    >>;
}

export interface GateFlowSynchronousPreflightPipelineExtension<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness
> {
    afterParse?(context: GateFlowParsedContext<TInput, TParsed>): void | undefined;
    afterTaskModeEvidence?(
        context: GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence>
    ): void | undefined;
    afterPreflight?(
        context: GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight>
    ): void | undefined;
    afterTimelineReadiness?(
        context: GateFlowTimelineContext<TInput, TParsed, TTaskModeEvidence, TPreflight, TTimelineReadiness>
    ): void | undefined;
    beforeEmit?(
        context: GateFlowTimelineContext<TInput, TParsed, TTaskModeEvidence, TPreflight, TTimelineReadiness>
    ): void | undefined;
}

export interface GateFlowSynchronousPreflightPipeline<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness,
    TOutput,
    TExtensions extends ReadonlyArray<GateFlowSynchronousPreflightPipelineExtension<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    >> = ReadonlyArray<GateFlowSynchronousPreflightPipelineExtension<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    >>
> {
    parse(input: TInput): TParsed;
    loadTaskModeEvidence(
        context: GateFlowParsedContext<TInput, TParsed>
    ): TTaskModeEvidence;
    loadPreflight(
        context: GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence>
    ): TPreflight;
    evaluateTimelineReadiness(
        context: GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight>
    ): TTimelineReadiness;
    emit(
        context: GateFlowTimelineContext<TInput, TParsed, TTaskModeEvidence, TPreflight, TTimelineReadiness>
    ): TOutput;
    extensions?: TExtensions;
}

async function runExtensionHooks<TExtension, TContext>(
    extensions: ReadonlyArray<TExtension>,
    context: TContext,
    invokeHook: (extension: TExtension, context: TContext) => GateFlowPreflightPipelineValue<void>
): Promise<void> {
    for (const extension of extensions) {
        await invokeHook(extension, context);
    }
}

type GateFlowSynchronousPromiseGuard<
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness,
    TOutput,
    TExtensionCallbackResult
> = [
    Extract<
        | TParsed
        | TTaskModeEvidence
        | TPreflight
        | TTimelineReadiness
        | TOutput
        | TExtensionCallbackResult,
        PromiseLike<unknown>
    >
] extends [never]
    ? []
    : [synchronousCallbacksMustNotReturnPromises: never];

type GateFlowSynchronousExtensionHookName =
    | 'afterParse'
    | 'afterTaskModeEvidence'
    | 'afterPreflight'
    | 'afterTimelineReadiness'
    | 'beforeEmit';

type GateFlowSynchronousExtensionHookResult<
    TExtension,
    THookName extends GateFlowSynchronousExtensionHookName
> = TExtension extends unknown
    ? THookName extends keyof TExtension
        ? NonNullable<TExtension[THookName]> extends (...args: never[]) => infer TResult
            ? TResult
            : never
        : never
    : never;

type GateFlowSynchronousExtensionCallbackResult<
    TExtensions extends ReadonlyArray<unknown>
> = GateFlowSynchronousExtensionHookResult<
    TExtensions[number],
    GateFlowSynchronousExtensionHookName
>;

function assertSynchronousCallbackResult(value: unknown, callbackKind: string): void {
    if (
        value !== null
        && (typeof value === 'object' || typeof value === 'function')
        && typeof (value as { then?: unknown }).then === 'function'
    ) {
        void Promise.resolve(value).catch(() => undefined);
        throw new TypeError(
            `Synchronous gate-flow preflight ${callbackKind} returned a Promise-like value.`
        );
    }
}

function runSynchronousExtensionHooks<TExtension, TContext>(
    extensions: ReadonlyArray<TExtension>,
    context: TContext,
    invokeHook: (extension: TExtension, context: TContext) => unknown
): void {
    for (const extension of extensions) {
        const result = invokeHook(extension, context);
        assertSynchronousCallbackResult(result, 'extension hook');
    }
}

export function runGateFlowPreflightPipelineSync<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness,
    TOutput,
    const TExtensions extends ReadonlyArray<GateFlowSynchronousPreflightPipelineExtension<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    >> = ReadonlyArray<GateFlowSynchronousPreflightPipelineExtension<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    >>
>(
    input: TInput,
    pipeline: GateFlowSynchronousPreflightPipeline<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness,
        TOutput,
        TExtensions
    >,
    ...promiseGuard: GateFlowSynchronousPromiseGuard<
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness,
        TOutput,
        GateFlowSynchronousExtensionCallbackResult<TExtensions>
    >
): TOutput {
    void promiseGuard;
    const extensions = pipeline.extensions || [];
    const parsed = pipeline.parse(input);
    assertSynchronousCallbackResult(parsed, 'parse callback');
    const parsedContext: GateFlowParsedContext<TInput, TParsed> = { input, parsed };
    runSynchronousExtensionHooks(
        extensions,
        parsedContext,
        (extension, context) => extension.afterParse?.(context)
    );

    const taskModeEvidence = pipeline.loadTaskModeEvidence(parsedContext);
    assertSynchronousCallbackResult(taskModeEvidence, 'task-mode callback');
    const taskModeContext: GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence> = {
        ...parsedContext,
        taskModeEvidence
    };
    runSynchronousExtensionHooks(
        extensions,
        taskModeContext,
        (extension, context) => extension.afterTaskModeEvidence?.(context)
    );

    const preflight = pipeline.loadPreflight(taskModeContext);
    assertSynchronousCallbackResult(preflight, 'preflight callback');
    const preflightContext: GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight> = {
        ...taskModeContext,
        preflight
    };
    runSynchronousExtensionHooks(
        extensions,
        preflightContext,
        (extension, context) => extension.afterPreflight?.(context)
    );

    const timelineReadiness = pipeline.evaluateTimelineReadiness(preflightContext);
    assertSynchronousCallbackResult(timelineReadiness, 'timeline-readiness callback');
    const timelineContext: GateFlowTimelineContext<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    > = {
        ...preflightContext,
        timelineReadiness
    };
    runSynchronousExtensionHooks(
        extensions,
        timelineContext,
        (extension, context) => extension.afterTimelineReadiness?.(context)
    );
    runSynchronousExtensionHooks(
        extensions,
        timelineContext,
        (extension, context) => extension.beforeEmit?.(context)
    );

    const output = pipeline.emit(timelineContext);
    assertSynchronousCallbackResult(output, 'emit callback');
    return output;
}

export async function runGateFlowPreflightPipeline<
    TInput,
    TParsed,
    TTaskModeEvidence,
    TPreflight,
    TTimelineReadiness,
    TOutput
>(
    input: TInput,
    pipeline: GateFlowPreflightPipeline<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness,
        TOutput
    >
): Promise<TOutput> {
    const extensions = pipeline.extensions || [];
    const parsed = await pipeline.parse(input);
    const parsedContext: GateFlowParsedContext<TInput, TParsed> = { input, parsed };
    await runExtensionHooks(
        extensions,
        parsedContext,
        (extension, context) => extension.afterParse?.(context)
    );

    const taskModeEvidence = await pipeline.loadTaskModeEvidence(parsedContext);
    const taskModeContext: GateFlowTaskModeContext<TInput, TParsed, TTaskModeEvidence> = {
        ...parsedContext,
        taskModeEvidence
    };
    await runExtensionHooks(
        extensions,
        taskModeContext,
        (extension, context) => extension.afterTaskModeEvidence?.(context)
    );

    const preflight = await pipeline.loadPreflight(taskModeContext);
    const preflightContext: GateFlowPreflightContext<TInput, TParsed, TTaskModeEvidence, TPreflight> = {
        ...taskModeContext,
        preflight
    };
    await runExtensionHooks(
        extensions,
        preflightContext,
        (extension, context) => extension.afterPreflight?.(context)
    );

    const timelineReadiness = await pipeline.evaluateTimelineReadiness(preflightContext);
    const timelineContext: GateFlowTimelineContext<
        TInput,
        TParsed,
        TTaskModeEvidence,
        TPreflight,
        TTimelineReadiness
    > = {
        ...preflightContext,
        timelineReadiness
    };
    await runExtensionHooks(
        extensions,
        timelineContext,
        (extension, context) => extension.afterTimelineReadiness?.(context)
    );
    await runExtensionHooks(
        extensions,
        timelineContext,
        (extension, context) => extension.beforeEmit?.(context)
    );

    return pipeline.emit(timelineContext);
}
