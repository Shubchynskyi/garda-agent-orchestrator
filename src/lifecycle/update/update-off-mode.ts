import { readSwitchModeState } from '../../materialization/switch-mode';

interface AssertUpdateApplyAllowedInSwitchModeOptions {
    targetRoot: string;
    bundleRoot: string;
    applyRequested: boolean;
    dryRun?: boolean;
    commandName: string;
}

export function assertUpdateApplyAllowedInSwitchMode(options: AssertUpdateApplyAllowedInSwitchModeOptions): void {
    if (!options.applyRequested || options.dryRun === true) {
        return;
    }

    const mode = readSwitchModeState(options.targetRoot, options.bundleRoot);
    if (mode !== 'off') {
        return;
    }

    throw new Error(
        `GARDA_UPDATE_OFF_MODE_BLOCKED: ${options.commandName} cannot apply while Garda is off. ` +
        'Run `garda on` first, then rerun the update. ' +
        'Read-only update checks remain available with --check-only or --dry-run.'
    );
}
