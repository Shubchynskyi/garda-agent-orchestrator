import { parseOptions } from './cli-helpers';
import type { ParsedOptionsRecord } from './shared-command-utils';

export type GateOptionDefinitions = Record<string, {
    readonly key: string;
    readonly type: string;
}>;

interface GateExitCodeResult {
    readonly exitCode: number;
}

export interface GateOutputLinesResult extends GateExitCodeResult {
    readonly outputLines: readonly string[];
}

interface ParsedGateArguments {
    readonly argv: readonly string[];
    readonly options: ParsedOptionsRecord;
    readonly positionals: readonly string[];
}

interface GateCliHandlerConfig<TCommandOptions, TResult> {
    readonly parseConfig?: {
        readonly allowPositionals?: boolean;
        readonly maxPositionals?: number;
    };
    readonly skipParsing?: boolean;
    readonly mapOptions?: (parsed: ParsedGateArguments) => TCommandOptions;
    readonly resolveExitCode?: (result: TResult, parsed: ParsedGateArguments) => number;
    readonly onCommandError?: (error: unknown, parsed: ParsedGateArguments) => void;
}

interface StandardGateCliHandlerConfig<TCommandOptions, TResult extends GateOutputLinesResult>
    extends GateCliHandlerConfig<TCommandOptions, TResult> {
    readonly formatOutput?: (result: TResult, parsed: ParsedGateArguments) => string | undefined;
}

interface CustomGateCliHandlerConfig<TCommandOptions, TResult>
    extends GateCliHandlerConfig<TCommandOptions, TResult> {
    readonly formatOutput: (result: TResult, parsed: ParsedGateArguments) => string | undefined;
    readonly resolveExitCode: (result: TResult, parsed: ParsedGateArguments) => number;
}

interface InternalGateCliHandlerConfig<TCommandOptions, TResult>
    extends GateCliHandlerConfig<TCommandOptions, TResult> {
    readonly formatOutput?: (result: TResult, parsed: ParsedGateArguments) => string | undefined;
}

type MaybePromise<T> = T | Promise<T>;

export function runGateCliHandler<
    TCommandOptions,
    TResult extends GateOutputLinesResult
>(
    gateArgv: string[],
    definitions: GateOptionDefinitions,
    runCommand: (options: TCommandOptions) => MaybePromise<TResult>,
    config?: StandardGateCliHandlerConfig<TCommandOptions, TResult>
): Promise<void>;

export function runGateCliHandler<TCommandOptions, TResult>(
    gateArgv: string[],
    definitions: GateOptionDefinitions,
    runCommand: (options: TCommandOptions) => MaybePromise<TResult>,
    config: CustomGateCliHandlerConfig<TCommandOptions, TResult>
): Promise<void>;

export function runGateCliHandler<TCommandOptions, TResult>(
    gateArgv: string[],
    definitions: GateOptionDefinitions,
    runCommand: (options: TCommandOptions) => MaybePromise<TResult>,
    config: InternalGateCliHandlerConfig<TCommandOptions, TResult> = {}
): Promise<void> {
    let parsedResult: ReturnType<typeof parseOptions>;
    try {
        parsedResult = config.skipParsing === true
            ? { options: {}, positionals: [] }
            : parseOptions(gateArgv, definitions, config.parseConfig);
    } catch (error: unknown) {
        return Promise.reject(error);
    }
    const parsed: ParsedGateArguments = {
        argv: gateArgv,
        options: parsedResult.options,
        positionals: parsedResult.positionals
    };
    let commandOptions: TCommandOptions;
    try {
        commandOptions = config.mapOptions
            ? config.mapOptions(parsed)
            : parsed.options as TCommandOptions;
    } catch (error: unknown) {
        return Promise.reject(error);
    }

    let resultOrPromise: MaybePromise<TResult>;
    try {
        resultOrPromise = runCommand(commandOptions);
    } catch (error: unknown) {
        config.onCommandError?.(error, parsed);
        return Promise.reject(error);
    }

    if (isPromiseLike(resultOrPromise)) {
        return resultOrPromise.then(
            (result) => finalizeGateCliHandler(result, parsed, config),
            (error: unknown) => {
                config.onCommandError?.(error, parsed);
                throw error;
            }
        );
    }

    try {
        finalizeGateCliHandler(resultOrPromise, parsed, config);
        return Promise.resolve();
    } catch (error: unknown) {
        return Promise.reject(error);
    }
}

function finalizeGateCliHandler<TCommandOptions, TResult>(
    result: TResult,
    parsed: ParsedGateArguments,
    config: InternalGateCliHandlerConfig<TCommandOptions, TResult>
): void {
    const output = config.formatOutput
        ? config.formatOutput(result, parsed)
        : formatOutputLines(result as GateOutputLinesResult);
    if (output !== undefined) {
        process.stdout.write(output);
    }

    const exitCode = config.resolveExitCode
        ? config.resolveExitCode(result, parsed)
        : (result as GateExitCodeResult).exitCode;
    if (exitCode !== 0) {
        process.exitCode = exitCode;
    }
}

function formatOutputLines(result: GateOutputLinesResult): string {
    return `${result.outputLines.join('\n')}\n`;
}

function isPromiseLike<T>(value: MaybePromise<T>): value is Promise<T> {
    return typeof (value as Promise<T> | undefined)?.then === 'function';
}
