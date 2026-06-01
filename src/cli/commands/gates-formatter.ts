import * as os from 'node:os';
import * as gateHelpers from '../../gates/shared/helpers';
import { redactSecretText } from '../../core/redaction';

export interface OutputTelemetrySummary extends Record<string, unknown> {
    filter_mode: string;
    fallback_mode: string;
    parser_mode: string;
    parser_name: string | null;
    parser_strategy: string | null;
}

export function toOutputTelemetrySummary<T extends object>(telemetry: T): T & OutputTelemetrySummary {
    const record = telemetry as T & Partial<OutputTelemetrySummary>;
    return {
        ...telemetry,
        filter_mode: typeof record.filter_mode === 'string' ? record.filter_mode : 'passthrough',
        fallback_mode: typeof record.fallback_mode === 'string' ? record.fallback_mode : 'none',
        parser_mode: typeof record.parser_mode === 'string' ? record.parser_mode : 'NONE',
        parser_name: typeof record.parser_name === 'string' ? record.parser_name : null,
        parser_strategy: typeof record.parser_strategy === 'string' ? record.parser_strategy : null
    };
}

export function toReviewCompactionAuditSummary<T extends object>(audit: T & { warning_count?: unknown; warnings?: unknown }): T & { warning_count: number; warnings: string[] } {
    return {
        ...audit,
        warning_count: typeof audit.warning_count === 'number' ? audit.warning_count : 0,
        warnings: gateHelpers.toStringArray(audit.warnings)
    };
}

export function toCommandPolicyAuditSummary<T extends object>(audit: T & { warning_count?: unknown; warnings?: unknown }): T & { warning_count: number; warnings: string[] } {
    return {
        ...audit,
        warning_count: typeof audit.warning_count === 'number' ? audit.warning_count : 0,
        warnings: gateHelpers.toStringArray(audit.warnings)
    };
}

export function formatCompileOutputEntry(
    commandIndex: number,
    totalCommands: number,
    command: string,
    outputLines: string[]
): string {
    const lines = [
        `==== COMMAND ${commandIndex}/${totalCommands} ====`,
        `COMMAND: ${redactSecretText(command)}`,
        `TIMESTAMP_UTC: ${new Date().toISOString()}`,
        '---- OUTPUT START ----',
        ...outputLines,
        '---- OUTPUT END ----',
        ''
    ];
    return `${lines.join(os.EOL)}${os.EOL}`;
}
