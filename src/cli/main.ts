import {
    PRIMARY_CLI_NAME,
    PRIMARY_PACKAGE_NAME
} from '../core/constants';
import { dispatchCliCommand } from './commands/command-dispatch';
import {
    applyNoColorFlag,
    extractGlobalFlags,
    normalizePathValue,
    readPackageJson
} from './commands/cli-helpers';
import {
    getCommandName,
    getPackageRoot,
    ValidationFailureError
} from './commands/shared-command-utils';
import { installSignalHandlers } from './signal-handler';
import {
    classifyErrorExitCode,
    EXIT_VALIDATION_FAILURE
} from './exit-codes';

let resolvedCommand: string | null = null;

function getFailureMarker(command: string | null): string {
    if (!command || command === 'bootstrap') {
        return 'GARDA_BOOTSTRAP_FAILED';
    }
    return 'GARDA_CLI_FAILED';
}

export async function runCliMain(argv: string[] = process.argv.slice(2), packageRoot = getPackageRoot()): Promise<void> {
    installSignalHandlers();

    const globalFlags = extractGlobalFlags(argv);
    applyNoColorFlag(globalFlags.noColor);
    if (globalFlags.bundleName) {
        process.env.GARDA_BUNDLE_NAME = globalFlags.bundleName;
    }
    const effectiveArgv = globalFlags.rest;
    const packageJson = readPackageJson(packageRoot);

    if (effectiveArgv.length === 0) {
        const { handleOverview } = await import('./commands/overview');
        handleOverview(packageJson, normalizePathValue('.'));
        return;
    }

    const commandName = getCommandName(effectiveArgv);
    resolvedCommand = commandName;

    const commandArgv = commandName === 'bootstrap' && effectiveArgv[0] !== 'bootstrap'
        ? effectiveArgv
        : effectiveArgv.slice(1);

    await dispatchCliCommand({
        commandName,
        commandArgv,
        packageJson,
        packageRoot,
        globalFlags: {
            offline: globalFlags.offline,
            forceNetwork: globalFlags.forceNetwork
        }
    });
}

export async function runCliMainWithHandling(
    argv: string[] = process.argv.slice(2),
    packageRoot = getPackageRoot()
): Promise<void> {
    try {
        await runCliMain(argv, packageRoot);
    } catch (error: unknown) {
        if (error instanceof Error && error.name === 'ValidationFailureError') {
            console.error(getFailureMarker(resolvedCommand));
            console.error(error.message);
            process.exitCode = EXIT_VALIDATION_FAILURE;
            return;
        }

        console.error(getFailureMarker(resolvedCommand));
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = classifyErrorExitCode(error);
    }
}

if (require.main === module) {
    runCliMainWithHandling().catch((error) => {
        console.error(`${PRIMARY_CLI_NAME}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        process.exitCode = 1;
    });
}
