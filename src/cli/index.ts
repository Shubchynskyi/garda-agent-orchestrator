import {
    DEFAULT_BUNDLE_NAME,
    PRIMARY_CLI_ENTRYPOINT,
    resolveInitAnswersRelativePath,
    LIFECYCLE_COMMANDS,
    MANAGED_CONFIG_NAMES,
    NODE_BASELINE_LABEL,
    NODE_ENGINE_RANGE,
    resolveBundleName,
    SOURCE_OF_TRUTH_VALUES
} from '../core/constants';

export function describeFoundation() {
    return {
        activeCliEntrypoint: PRIMARY_CLI_ENTRYPOINT,
        defaultBundleName: DEFAULT_BUNDLE_NAME,
        effectiveBundleName: resolveBundleName(),
        defaultInitAnswersRelativePath: resolveInitAnswersRelativePath(),
        lifecycleCommands: [...LIFECYCLE_COMMANDS],
        managedConfigNames: [...MANAGED_CONFIG_NAMES],
        nodeBaseline: NODE_ENGINE_RANGE,
        nodeBaselineLabel: NODE_BASELINE_LABEL,
        runtimeMode: 'node-only-router',
        sourceOfTruthValues: [...SOURCE_OF_TRUTH_VALUES]
    };
}
