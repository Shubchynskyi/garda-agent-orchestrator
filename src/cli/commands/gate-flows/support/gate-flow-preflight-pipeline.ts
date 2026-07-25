export type GateFlowPreflightPipelineValue<T> = T | Promise<T>;

export const GATE_FLOW_PREFLIGHT_PIPELINE_STAGES = [
    'parse',
    'task-mode-evidence',
    'preflight',
    'timeline-readiness',
    'emit'
] as const;

export type GateFlowPreflightPipelineStage = typeof GATE_FLOW_PREFLIGHT_PIPELINE_STAGES[number];

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

async function runExtensionHooks<TExtension, TContext>(
    extensions: ReadonlyArray<TExtension>,
    context: TContext,
    invokeHook: (extension: TExtension, context: TContext) => GateFlowPreflightPipelineValue<void>
): Promise<void> {
    for (const extension of extensions) {
        await invokeHook(extension, context);
    }
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
