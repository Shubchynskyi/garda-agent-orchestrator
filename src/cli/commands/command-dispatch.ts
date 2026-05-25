import { PRIMARY_PACKAGE_NAME } from '../../core/constants';
import {
    detectSourceBundleParity,
    detectSourceCheckoutRuntimeStaleness
} from '../../validators/workspace-layout';
import { assertOfflinePolicy } from '../../policy/offline-mode';
import { EXIT_VALIDATION_FAILURE } from '../exit-codes';
import {
    buildCommandHelpText,
    buildHelpText,
    buildParityBlockedCommandText,
    buildParityWarningCommandText,
    isKnownCommandHelpName
} from './cli-format-output';
import { buildGateCommandOverviewText, buildGateHelpText } from './gate-command-help';
import { isFailedValidationResult } from './shared-command-utils';
import { PackageJsonLike, printHelp } from './cli-helpers';
import * as path from 'node:path';

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

type ParityPolicyMode = 'block' | 'warn' | 'skip';

interface CommandParityPolicy {
    mode: ParityPolicyMode;
    root: string;
    reason: string;
}

function readPathFlag(commandArgv: string[], flag: string): string | null {
    for (let index = 0; index < commandArgv.length; index++) {
        const arg = commandArgv[index];
        if (arg === flag) {
            return typeof commandArgv[index + 1] === 'string' ? commandArgv[index + 1] : null;
        }
        if (arg.startsWith(`${flag}=`)) {
            return arg.slice(flag.length + 1);
        }
    }
    return null;
}

function resolveTargetOrBundleParityRoot(commandArgv: string[]): string {
    const explicitBundleRoot = readPathFlag(commandArgv, '--bundle-root');
    if (explicitBundleRoot) {
        return path.dirname(path.resolve(explicitBundleRoot));
    }
    const explicitTargetRoot = readPathFlag(commandArgv, '--target-root');
    const explicitRepoRoot = readPathFlag(commandArgv, '--repo-root');
    return explicitTargetRoot ? path.resolve(explicitTargetRoot) : explicitRepoRoot ? path.resolve(explicitRepoRoot) : '.';
}

function hasFlag(commandArgv: string[], flag: string): boolean {
    return commandArgv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
}

function resolveRepoParityRoot(commandArgv: string[]): string {
    const explicitRepoRoot = readPathFlag(commandArgv, '--repo-root');
    return explicitRepoRoot ? path.resolve(explicitRepoRoot) : '.';
}

function resolveNavigatorParityRoot(commandArgv: string[]): string {
    const explicitRepoRoot = readPathFlag(commandArgv, '--repo-root') || readPathFlag(commandArgv, '--target-root');
    return explicitRepoRoot ? path.resolve(explicitRepoRoot) : '.';
}

function isUpdateGitCheckOnly(commandArgv: string[]): boolean {
    return String(commandArgv[0] || '').trim().toLowerCase() === 'git' && hasFlag(commandArgv, '--check-only');
}

function isRepairInspect(commandArgv: string[]): boolean {
    const firstArg = String(commandArgv[0] || '').trim().toLowerCase();
    return !firstArg || firstArg.startsWith('-') || firstArg === 'help' || firstArg === 'inspect';
}

function isGcDryRun(commandArgv: string[]): boolean {
    return !hasFlag(commandArgv, '--confirm') || hasFlag(commandArgv, '--dry-run');
}

function buildParityPolicy(mode: ParityPolicyMode, root: string, reason: string): CommandParityPolicy {
    return { mode, root, reason };
}

function resolveCommandParityPolicy(commandName: string, commandArgv: string[]): CommandParityPolicy {
    if (commandName === 'gate') {
        return buildParityPolicy('block', resolveRepoParityRoot(commandArgv), 'gate commands mutate lifecycle evidence and must use a fresh deployed bundle.');
    }
    if (commandName === 'next-step') {
        return buildParityPolicy('block', resolveNavigatorParityRoot(commandArgv), 'next-step is the lifecycle navigator and must not route from stale source or bundle code.');
    }
    if (['setup', 'bootstrap', 'install', 'init', 'reinit', 'update', 'rollback', 'uninstall'].includes(commandName)) {
        if (commandName === 'update' && isUpdateGitCheckOnly(commandArgv)) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'update git --check-only is read-only, so stale source parity is surfaced without blocking.');
        }
        return buildParityPolicy('block', resolveTargetOrBundleParityRoot(commandArgv), 'mutating lifecycle commands must not run against a stale source checkout or deployed bundle.');
    }
    if (commandName === 'check-update') {
        const mode: ParityPolicyMode = hasFlag(commandArgv, '--apply') ? 'block' : 'warn';
        const reason = mode === 'block'
            ? 'check-update --apply mutates the workspace and must not run with stale source parity.'
            : 'check-update is read-only without --apply, so stale source parity is surfaced without blocking.';
        return buildParityPolicy(mode, resolveTargetOrBundleParityRoot(commandArgv), reason);
    }
    if (commandName === 'cleanup') {
        const mode: ParityPolicyMode = hasFlag(commandArgv, '--dry-run') ? 'warn' : 'block';
        const reason = mode === 'block'
            ? 'cleanup removes runtime artifacts unless --dry-run is passed and must not run with stale source parity.'
            : 'cleanup --dry-run is read-only, so stale source parity is surfaced without blocking.';
        return buildParityPolicy(mode, resolveTargetOrBundleParityRoot(commandArgv), reason);
    }
    if (commandName === 'gc' || commandName === 'clean') {
        const mode: ParityPolicyMode = isGcDryRun(commandArgv) ? 'warn' : 'block';
        const reason = mode === 'block'
            ? `${commandName} --confirm removes runtime artifacts and must not run with stale source parity.`
            : `${commandName} is dry-run by default, so stale source parity is surfaced without blocking.`;
        return buildParityPolicy(mode, resolveTargetOrBundleParityRoot(commandArgv), reason);
    }
    if (commandName === 'repair') {
        if (isRepairInspect(commandArgv)) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'repair inspect is read-only, so stale source parity is surfaced without blocking.');
        }
        if (!hasFlag(commandArgv, '--confirm')) {
            return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'repair mutation subcommands are dry-run by default, so stale source parity is surfaced without blocking unless --confirm is passed.');
        }
        return buildParityPolicy('block', resolveTargetOrBundleParityRoot(commandArgv), 'confirmed repair mutation paths must not run with stale source parity.');
    }
    if (['agent-init', 'skills', 'review-capabilities', 'templates', 'profile', 'workflow', 'html', 'ui', 'on', 'off'].includes(commandName)) {
        return buildParityPolicy('block', resolveTargetOrBundleParityRoot(commandArgv), 'workspace configuration and workspace-selection commands require source/bundle parity before execution.');
    }
    if (['status', 'doctor', 'debug', 'stats', 'task', 'preprompt', 'verify', 'diff-managed'].includes(commandName)) {
        return buildParityPolicy('warn', resolveTargetOrBundleParityRoot(commandArgv), 'read-only workspace inspection commands surface stale source parity without blocking.');
    }
    return buildParityPolicy('skip', '.', 'command has no workspace source/bundle parity policy.');
}

function isHelpFlag(argument: string): boolean {
    return argument === '--help' || argument === '-h';
}

function isHelpSubcommand(commandArgv: string[]): boolean {
    return String(commandArgv[0] || '').trim().toLowerCase() === 'help';
}

function hasHelpFlag(commandArgv: string[]): boolean {
    return commandArgv.some((argument) => isHelpFlag(argument));
}

function isHelpOnlyRequest(commandArgv: string[]): boolean {
    return isHelpSubcommand(commandArgv) || hasHelpFlag(commandArgv);
}

function isMissingDeployedBundleOnlyParityBlock(violations: readonly string[]): boolean {
    return violations.length > 0
        && violations.every((violation) => violation.startsWith('Bundle invariant violation: '))
        && violations.some((violation) => /^Bundle invariant violation: Bundle directory '[^']+' is missing\.$/.test(violation));
}

function printHelpCommand(commandArgv: string[], packageJson: PackageJsonLike): boolean {
    const commandHelpName = String(commandArgv[0] || '').trim();
    if (!commandHelpName) {
        printHelp(packageJson);
        return true;
    }
    if (commandHelpName === 'gate') {
        const gateName = String(commandArgv[1] || '').trim();
        console.log(gateName ? buildGateHelpText(gateName) : buildGateCommandOverviewText());
        return true;
    }
    if (isKnownCommandHelpName(commandHelpName)) {
        console.log(buildCommandHelpText(commandHelpName));
        return true;
    }
    return false;
}

function printCommandHelpIfRequested(commandName: string, commandArgv: string[]): boolean {
    if (commandName === 'gate' && isHelpSubcommand(commandArgv)) {
        const gateName = String(commandArgv[1] || '').trim();
        console.log(gateName ? buildGateHelpText(gateName) : buildGateCommandOverviewText());
        return true;
    }
    if (isKnownCommandHelpName(commandName) && (isHelpSubcommand(commandArgv) || hasHelpFlag(commandArgv))) {
        console.log(buildCommandHelpText(commandName));
        return true;
    }
    return false;
}

function buildParityHelpText(commandName: string, commandArgv: string[], packageJson: PackageJsonLike, parityRoot: string): string {
    if (commandName === 'gate' || commandName === 'next-step') {
        const gateName = commandName === 'next-step'
            ? 'next-step'
            : String(commandArgv[0] || '').trim();
        if (!gateName || gateName.startsWith('-')) {
            return buildGateCommandOverviewText(parityRoot);
        }
        try {
            return buildGateHelpText(gateName, parityRoot);
        } catch {
            return buildGateCommandOverviewText(parityRoot);
        }
    }
    if (isKnownCommandHelpName(commandName)) {
        return buildCommandHelpText(commandName);
    }
    return buildHelpText(packageJson);
}

export async function dispatchCliCommand(options: DispatchCliCommandOptions): Promise<void> {
    const { commandName, commandArgv, packageJson, packageRoot, globalFlags } = options;
    const isIntrospection = commandArgv.some((arg) => arg === '--help' || arg === '-h' || arg === '--version' || arg === '-v');
    const isHelpOnly = isHelpOnlyRequest(commandArgv);
    const isNextStepNavigatorCommand = commandName === 'next-step'
        || (commandName === 'gate' && String(commandArgv[0] || '').trim() === 'next-step');

    if (commandName === 'help') {
        if (!printHelpCommand(commandArgv, packageJson)) {
            printHelp(packageJson);
        }
        return;
    }

    if (!isIntrospection) {
        assertOfflinePolicy({
            offlineFlag: globalFlags.offline,
            offlineEnv: process.env.GARDA_OFFLINE,
            forceNetwork: globalFlags.forceNetwork,
            commandName
        });
    }

    const parityPolicy = resolveCommandParityPolicy(commandName, commandArgv);
    if (parityPolicy.mode !== 'skip') {
        const parityRoot = parityPolicy.root;
        const parityResult = detectSourceBundleParity(parityRoot);
        if (parityResult.isStale && !(isHelpOnly && isMissingDeployedBundleOnlyParityBlock(parityResult.violations))) {
            if (parityPolicy.mode === 'block') {
                throw new Error(
                    buildParityBlockedCommandText({
                        commandName,
                        helpText: buildParityHelpText(commandName, commandArgv, packageJson, parityRoot),
                        violations: parityResult.violations,
                        remediation: parityResult.remediation || `Run "npm run build" then "npx ${PRIMARY_PACKAGE_NAME} setup".`,
                        parityRoot,
                        policyMode: parityPolicy.mode,
                        policyReason: parityPolicy.reason
                    })
                );
            }
            console.error(
                buildParityWarningCommandText({
                    commandName,
                    violations: parityResult.violations,
                    remediation: parityResult.remediation || `Run "npm run build" then "npx ${PRIMARY_PACKAGE_NAME} setup".`,
                    parityRoot,
                    policyMode: parityPolicy.mode,
                    policyReason: parityPolicy.reason
                })
            );
        }
        if (!isIntrospection && (commandName === 'gate' || commandName === 'next-step') && !isNextStepNavigatorCommand) {
            const runtimeStaleness = detectSourceCheckoutRuntimeStaleness(parityRoot);
            if (runtimeStaleness.isStale) {
                console.error(
                    [
                        'Source Runtime Warning: source checkout generated runtime may be stale.',
                        ...runtimeStaleness.violations.map((violation) => `- ${violation}`),
                        `Remediation: ${runtimeStaleness.remediation || 'Run "npm run build" before continuing gate execution.'}`
                    ].join('\n')
                );
            }
        }
    }

    if (printCommandHelpIfRequested(commandName, commandArgv)) {
        return;
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
        case 'preprompt': {
            const { handlePreprompt } = await import('./preprompt-command');
            handlePreprompt(commandArgv, packageJson);
            return;
        }
        case 'next-step': {
            const { handleGate } = await import('./gate-command');
            await handleGate(['next-step', ...commandArgv]);
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
        case 'task': {
            const { handleTask } = await import('./task-command');
            await handleTask(commandArgv, packageJson);
            return;
        }
        case 'html': {
            const { handleHtml } = await import('./html-command');
            handleHtml(commandArgv, packageJson);
            return;
        }
        case 'ui': {
            const { handleUi } = await import('./ui-command');
            await handleUi(commandArgv, packageJson);
            return;
        }
        case 'on':
        case 'off': {
            const { handleSwitchMode } = await import('./switch-command');
            handleSwitchMode(commandName, commandArgv, packageJson);
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
        case 'repair': {
            const { handleRepair } = await import('./repair-command');
            handleRepair(commandArgv, packageJson);
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
        case 'review-capabilities': {
            const { handleReviewCapabilities } = await import('./review-capabilities-command');
            const result = handleReviewCapabilities(commandArgv, packageJson);
            if (isFailedValidationResult(result)) {
                process.exitCode = EXIT_VALIDATION_FAILURE;
            }
            return;
        }
        case 'templates': {
            const { handleTemplates } = await import('./templates-command');
            const result = handleTemplates(commandArgv, packageJson);
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
        case 'workflow': {
            const { handleWorkflow } = await import('./workflow-command');
            const workflowResult = handleWorkflow(commandArgv, packageJson);
            if (isFailedValidationResult(workflowResult)) {
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
