import * as path from 'node:path';
import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../../../../core/constants';
import * as gateHelpers from '../../../../gates/shared/helpers';

export function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

export function buildGateCommandPrefix(repoRoot: string): string {
    return gateHelpers.isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
}

export function buildGateCommandBase(repoRoot: string, taskId: string, gateName: string): string[] {
    return [
        `${buildGateCommandPrefix(repoRoot)} gate ${gateName}`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`
    ];
}
