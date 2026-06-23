import {
    buildCommandHelpText,
    buildHelpText,
    isKnownCommandHelpName
} from '../cli-format-output';
import { PackageJsonLike, printHelp } from '../cli-helpers';
import { buildGateCommandOverviewText, buildGateHelpText } from '../gate-command-help';

function isHelpFlag(argument: string): boolean {
    return argument === '--help' || argument === '-h';
}

function isHelpSubcommand(commandArgv: string[]): boolean {
    return String(commandArgv[0] || '').trim().toLowerCase() === 'help';
}

function hasHelpFlag(commandArgv: string[]): boolean {
    return commandArgv.some((argument) => isHelpFlag(argument));
}

export function isHelpOnlyRequest(commandArgv: string[]): boolean {
    return isHelpSubcommand(commandArgv) || hasHelpFlag(commandArgv);
}

function isMissingBundleDirectoryViolation(violation: string): boolean {
    return /^Bundle invariant violation: Bundle directory '[^']+' is missing\.$/.test(violation);
}

function isMissingBundleContentViolation(violation: string): boolean {
    return /^Bundle invariant violation: Required bundle (?:file|inventory) '[^']+' is missing\.$/.test(violation);
}

export function isMissingDeployedBundleOnlyParityBlock(violations: readonly string[]): boolean {
    return violations.length > 0
        && violations.every((violation) => violation.startsWith('Bundle invariant violation: '))
        && (
            violations.some(isMissingBundleDirectoryViolation)
            || violations.every(isMissingBundleContentViolation)
        );
}

export function printHelpCommand(commandArgv: string[], packageJson: PackageJsonLike): boolean {
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

export function printCommandHelpIfRequested(commandName: string, commandArgv: string[]): boolean {
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

export function buildParityHelpText(commandName: string, commandArgv: string[], packageJson: PackageJsonLike, parityRoot: string): string {
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
