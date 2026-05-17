import { runSwitchMode, type SwitchMode } from '../../materialization/switch-mode';
import {
    PackageJsonLike,
    parseOptions
} from './cli-helpers';
import {
    formatKeyValueOutput,
    type ParsedOptionsRecord
} from './shared-command-utils';
import {
    handleStandardFlags,
    resolveTargetRoot
} from './workspace-helpers';

const SWITCH_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--dry-run': { key: 'dryRun', type: 'boolean' }
};

export function handleSwitchMode(
    mode: SwitchMode,
    commandArgv: string[],
    packageJson: PackageJsonLike
): void {
    const { options: rawOptions } = parseOptions(commandArgv, SWITCH_DEFINITIONS);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const result = runSwitchMode({
        mode,
        targetRoot: resolveTargetRoot(options.targetRoot),
        dryRun: options.dryRun === true
    });
    console.log(`GARDA_SWITCH_${mode.toUpperCase()}`);
    formatKeyValueOutput(result, [
        'status',
        'mode',
        'targetRoot',
        'bundleRoot',
        'storageRoot',
        'dryRun',
        'movedToInactive',
        'movedToRoot',
        'agentIgnoreUpdated',
        'conflicts'
    ]);
}
