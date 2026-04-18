import { PRIMARY_PACKAGE_NAME } from '../../core/constants';
import { detectSourceBundleParity } from '../../validators/workspace-layout';
import { assertOfflinePolicy } from '../../policy/offline-mode';
import { EXIT_VALIDATION_FAILURE } from '../exit-codes';
import { isFailedValidationResult } from './shared-command-utils';
import { PackageJsonLike, printHelp } from './cli-helpers';

export interface DispatchCliCommandOptions {
    commandName: string;
    commandArgv: string[];
    packageJson: PackageJsonLike;
    packageRoot: string;
    globalFlags: {
        offline: boolean;
        forceNetwork: boolean;
    };
}

export async function dispatchCliCommand(options: DispatchCliCommandOptions): Promise<void> {
    const { commandName, commandArgv, packageJson, packageRoot, globalFlags } = options;

    if (commandName === 'help') {
        printHelp(packageJson);
        return;
    }

    if (['gate', 'agent-init', 'skills', 'profile'].includes(commandName)) {
        const parityResult = detectSourceBundleParity('.');
        if (parityResult.isStale) {
            throw new Error(
                'Source Parity Violation: The deployed bundle is stale compared to the source checkout.\n'
                + (parityResult.violations.length > 0 ? parityResult.violations.join('\n') + '\n' : '')
                + (parityResult.remediation ? `Fix: ${parityResult.remediation}` : `Run "npm run build" then "npx ${PRIMARY_PACKAGE_NAME} setup".`)
            );
        }
    }

    const isIntrospection = commandArgv.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v');
    if (!isIntrospection) {
        assertOfflinePolicy({
            offlineFlag: globalFlags.offline,
            offlineEnv: process.env.GARDA_OFFLINE,
            forceNetwork: globalFlags.forceNetwork,
            commandName
        });
    }

    switch (commandName) {
        case 'setup': {
            const { handleSetup } = await import('./setup');
            await handleSetup(commandArgv, packageJson, packageRoot);
            return;
        }
        case 'agent-init': {
            const { handleAgentInit } = await import('./agent-init');
            const result = handleAgentInit(commandArgv, packageJson);
            if (result && result.readyForTasks === false) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'status': {
            const { handleStatus } = await import('./status-command');
            handleStatus(commandArgv, packageJson);
            return;
        }
        case 'doctor': {
            const { handleDoctor } = await import('./status-command');
            handleDoctor(commandArgv, packageJson);
            return;
        }
        case 'debug': {
            const { handleDebug } = await import('./debug-command');
            handleDebug(commandArgv, packageJson);
            return;
        }
        case 'stats': {
            const { handleStats } = await import('./debug-command');
            handleStats(commandArgv, packageJson);
            return;
        }
        case 'bootstrap': {
            const { handleBootstrap } = await import('./bootstrap');
            await handleBootstrap(commandArgv, packageJson, packageRoot);
            return;
        }
        case 'install': {
            const { handleInstall } = await import('./workspace-command');
            await handleInstall(commandArgv, packageJson, packageRoot);
            return;
        }
        case 'init': {
            const { handleInit } = await import('./workspace-command');
            handleInit(commandArgv, packageJson);
            return;
        }
        case 'reinit': {
            const { handleReinit } = await import('./workspace-maintenance-command');
            await handleReinit(commandArgv, packageJson);
            return;
        }
        case 'update': {
            const { handleUpdate } = await import('./update-command');
            await handleUpdate(commandArgv, packageJson);
            return;
        }
        case 'rollback': {
            const { handleRollback } = await import('./update-command');
            await handleRollback(commandArgv, packageJson);
            return;
        }
        case 'uninstall': {
            const { handleUninstall } = await import('./workspace-maintenance-command');
            handleUninstall(commandArgv, packageJson);
            return;
        }
        case 'cleanup': {
            const { handleCleanup } = await import('./workspace-maintenance-command');
            await Promise.resolve(handleCleanup(commandArgv, packageJson));
            return;
        }
        case 'gc':
        case 'clean': {
            const { handleGc } = await import('./workspace-maintenance-command');
            handleGc(commandArgv, packageJson);
            return;
        }
        case 'verify': {
            const { handleVerify } = await import('./validate-command');
            handleVerify(commandArgv, packageJson);
            return;
        }
        case 'check-update': {
            const { handleCheckUpdate } = await import('./update-command');
            await handleCheckUpdate(commandArgv, packageJson);
            return;
        }
        case 'skills': {
            const { handleSkills } = await import('./skills');
            const result = handleSkills(commandArgv, packageJson);
            if (isFailedValidationResult(result)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'profile': {
            const { handleProfile } = await import('./profile');
            const profileResult = await Promise.resolve(handleProfile(commandArgv, packageJson));
            if (isFailedValidationResult(profileResult)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'diff-managed': {
            const { handleDiffManaged } = await import('./debug-command');
            handleDiffManaged(commandArgv, packageJson);
            return;
        }
        case 'gate': {
            const { handleGate } = await import('./gate-command');
            await handleGate(commandArgv);
            return;
        }
        default:
            throw new Error(`Unsupported command: ${commandName}`);
    }
}
