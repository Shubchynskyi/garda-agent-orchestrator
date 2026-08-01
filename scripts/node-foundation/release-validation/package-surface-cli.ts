import type { PackageSurfaceCliOptions } from './package-surface-types';

type PackageSurfaceCliMode = 'baseline-update' | 'validation';

const VALUE_OPTIONS = Object.freeze([
    '--baseline',
    '--output',
    '--prior-artifact',
    '--rationale'
] as const);

function assignValueOption(options: PackageSurfaceCliOptions, name: string, value: string): void {
    if (name === '--baseline') {
        options.baselinePath = value;
    } else if (name === '--output') {
        options.outputPath = value;
    } else if (name === '--prior-artifact') {
        options.priorArtifactPath = value;
    } else {
        options.rationale = value;
    }
}

function assertNoDuplicate(seen: Set<string>, option: string): void {
    if (seen.has(option)) {
        throw new Error(`Duplicate package-surface option: ${option}`);
    }
    seen.add(option);
}

export function parsePackageSurfaceCliOptions(
    args: readonly string[],
    mode: PackageSurfaceCliMode = 'validation'
): PackageSurfaceCliOptions {
    const options: PackageSurfaceCliOptions = {
        baselinePath: null,
        outputPath: null,
        priorArtifactPath: null,
        confirmBaselineUpdate: false,
        rationale: null
    };
    const seen = new Set<string>();
    for (let index = 0; index < args.length; index += 1) {
        const option = args[index];
        assertNoDuplicate(seen, option);
        if (option === '--confirm-baseline-update') {
            options.confirmBaselineUpdate = true;
            continue;
        }
        if (!VALUE_OPTIONS.includes(option as typeof VALUE_OPTIONS[number])) {
            throw new Error(`Unknown package-surface option: ${option}`);
        }
        const value = args[index + 1];
        if (value === undefined || !value.trim() || value.startsWith('--')) {
            throw new Error(`Package-surface option requires a value: ${option}`);
        }
        assignValueOption(options, option, value.trim());
        index += 1;
    }
    if (options.baselinePath && options.priorArtifactPath) {
        throw new Error('--baseline and --prior-artifact cannot be used together.');
    }
    if (mode === 'validation' && (options.confirmBaselineUpdate || options.rationale)) {
        throw new Error('--confirm-baseline-update and --rationale are only valid for package-surface-baseline.');
    }
    if (mode === 'baseline-update' && options.priorArtifactPath) {
        throw new Error('--prior-artifact is not valid for package-surface-baseline.');
    }
    if (mode === 'baseline-update' && options.baselinePath) {
        throw new Error('--baseline is read-only and is not valid for package-surface-baseline.');
    }
    return options;
}
