import {
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES
} from '../core/constants';

export type RuntimeWritesMode = 'normal' | 'low-noise';

export const GARDA_RUNTIME_WRITES_MODE_ENV = 'GARDA_RUNTIME_WRITES_MODE';
export const GARDA_LOW_NOISE_RUNTIME_WRITES_ENV = 'GARDA_LOW_NOISE_RUNTIME_WRITES';

export interface RuntimeWritesModeOptions {
    runtimeWritesMode?: unknown;
    lowNoiseRuntimeWrites?: unknown;
    env?: NodeJS.ProcessEnv;
}

function normalizeModeText(value: unknown): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[_\s]+/g, '-');
}

function parseRuntimeWritesMode(value: unknown): RuntimeWritesMode | null {
    if (value == null) {
        return null;
    }
    if (typeof value === 'boolean') {
        return value ? 'low-noise' : 'normal';
    }

    const normalized = normalizeModeText(value);
    if (!normalized) {
        return null;
    }
    if (normalized === 'low-noise' || normalized === 'quiet') {
        return 'low-noise';
    }
    if (normalized === 'normal' || normalized === 'default') {
        return 'normal';
    }
    if (BOOLEAN_TRUE_VALUES.includes(normalized)) {
        return 'low-noise';
    }
    if (BOOLEAN_FALSE_VALUES.includes(normalized)) {
        return 'normal';
    }
    return null;
}

export function resolveRuntimeWritesMode(options: RuntimeWritesModeOptions = {}): RuntimeWritesMode {
    const explicitMode = parseRuntimeWritesMode(options.runtimeWritesMode ?? options.lowNoiseRuntimeWrites);
    if (explicitMode) {
        return explicitMode;
    }

    const env = options.env ?? process.env;
    const envMode = parseRuntimeWritesMode(env[GARDA_RUNTIME_WRITES_MODE_ENV]);
    if (envMode) {
        return envMode;
    }

    const envFlag = parseRuntimeWritesMode(env[GARDA_LOW_NOISE_RUNTIME_WRITES_ENV]);
    return envFlag ?? 'normal';
}

export function isLowNoiseRuntimeWritesEnabled(options: RuntimeWritesModeOptions = {}): boolean {
    return resolveRuntimeWritesMode(options) === 'low-noise';
}
