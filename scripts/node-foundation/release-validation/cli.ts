import {
    RELEASE_VALIDATION_COMMANDS,
    type ReleaseValidationCommand
} from './types';
import { runCleanWorktreePreflight } from './clean-worktree';
import { runEmbeddedBundleParityValidation } from './embedded-bundle-parity';
import { runReleaseReadinessValidation } from './readiness';
import { runReleaseVersionParityValidation } from './version-parity';

export function resolveReleaseValidationCommand(value: string | undefined): ReleaseValidationCommand | null {
    const command = String(value || 'version-parity').trim();
    for (const allowedCommand of RELEASE_VALIDATION_COMMANDS) {
        if (command === allowedCommand) {
            return allowedCommand;
        }
    }
    return null;
}

export const RELEASE_VALIDATION_COMMAND_HANDLERS: Readonly<Record<ReleaseValidationCommand, () => void>> = Object.freeze({
    'version-parity': () => { runReleaseVersionParityValidation(); },
    'clean-worktree': () => { runCleanWorktreePreflight(); },
    'embedded-bundle-parity': () => { runEmbeddedBundleParityValidation(); },
    'release-readiness': () => { runReleaseReadinessValidation(); }
});

export function runReleaseValidationCli(rawCommand: string | undefined): void {
    const command = resolveReleaseValidationCommand(rawCommand);
    if (command === null) {
        console.error(`Unknown validate-release command: ${String(rawCommand || '').trim()}`);
        console.error(`Usage: validate-release.js [${RELEASE_VALIDATION_COMMANDS.join('|')}]`);
        process.exit(1);
    }

    RELEASE_VALIDATION_COMMAND_HANDLERS[command]();
}
