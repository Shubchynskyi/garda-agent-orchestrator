import {
    buildCommandHelpText,
    normalizePathValue,
    parseOptions,
    type PackageJsonLike
} from './cli-helpers';
import type { ParsedOptionsRecord } from './shared-command-utils';
import {
    formatLocalUiServerOutput,
    startLocalUiServer
} from '../../reports/local-ui-server';

const UI_COMMAND_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--repo-root': { key: 'targetRoot', type: 'string' },
    '--port': { key: 'port', type: 'string' },
    '--read-only': { key: 'readOnly', type: 'boolean' },
    '--actions': { key: 'actions', type: 'boolean' }
};

function shouldPrintUiHelp(commandArgv: string[]): boolean {
    return commandArgv[0] === 'help'
        || commandArgv.some((argument) => argument === '--help' || argument === '-h');
}

function parsePort(value: unknown): number | null {
    if (typeof value !== 'string' || value.trim() === '') {
        return null;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error('--port must be an integer from 1 to 65535.');
    }
    return parsed;
}

export async function handleUi(commandArgv: string[], _packageJson: PackageJsonLike): Promise<void> {
    if (shouldPrintUiHelp(commandArgv)) {
        console.log(buildCommandHelpText('ui'));
        return;
    }

    const { options } = parseOptions(commandArgv, UI_COMMAND_DEFINITIONS);
    const parsed = options as ParsedOptionsRecord;
    const targetRoot = typeof parsed.targetRoot === 'string'
        ? normalizePathValue(parsed.targetRoot)
        : normalizePathValue('.');
    const port = parsePort(parsed.port);
    if (parsed.readOnly === true && parsed.actions === true) {
        throw new Error('--actions cannot be combined with --read-only.');
    }
    const server = await startLocalUiServer({
        repoRoot: targetRoot,
        port,
        actionsEnabled: parsed.actions === true
    });
    console.log(formatLocalUiServerOutput(server));
    await new Promise<void>((resolve) => {
        server.server.once('close', resolve);
    });
}
