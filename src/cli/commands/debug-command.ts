import { collectDebugEnvSnapshot, formatDebugEnvText, formatDebugEnvJson } from './debug-env';
import { collectManagedDiff, formatDiffManagedText, formatDiffManagedJson } from './diff-managed';
import {
    buildTaskStats,
    buildAggregateStats,
    formatTaskStatsText,
    formatTaskStatsJson,
    formatAggregateStatsText,
    formatAggregateStatsJson
} from './stats';
import {
    ensureDirectoryExists,
    normalizePathValue,
    PackageJsonLike,
    parseOptions,
    printHelp,
    buildCommandHelpText
} from './cli-helpers';
import { PRIMARY_CLI_NAME } from '../../core/constants';
import { ParsedOptionsRecord } from './shared-command-utils';

export function handleDebug(commandArgv: string[], packageJson: PackageJsonLike): void {
    const subcommand = commandArgv.length > 0 ? commandArgv[0].toLowerCase() : '';
    const subcommandHelp = commandArgv.length > 1 ? commandArgv[1].toLowerCase() === 'help' : false;
    if (subcommand === 'help' || subcommandHelp || commandArgv.some((argument) => argument === '--help' || argument === '-h')) {
        console.log(buildCommandHelpText('debug'));
        return;
    }
    if (subcommand !== 'env') {
        console.log(`Usage: ${PRIMARY_CLI_NAME} debug env [--target-root PATH] [--json]`);
        console.log('');
        console.log('Subcommands:');
        console.log('  env    Show environment and runtime triage snapshot');
        return;
    }

    const debugDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv.slice(1), debugDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    const snapshot = collectDebugEnvSnapshot(targetRoot, packageJson.version);

    if (options.json === true) {
        console.log(formatDebugEnvJson(snapshot));
    } else {
        console.log(formatDebugEnvText(snapshot));
    }
}

export function handleStats(commandArgv: string[], _packageJson: PackageJsonLike): void {
    if (commandArgv[0] === 'help' || commandArgv.some((argument) => argument === '--help' || argument === '-h')) {
        console.log(buildCommandHelpText('stats'));
        return;
    }
    const statsDefinitions = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--events-root': { key: 'eventsRoot', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, statsDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const eventsRoot = options.eventsRoot ? String(options.eventsRoot) : null;
    const reviewsRoot = options.reviewsRoot ? String(options.reviewsRoot) : null;

    if (options.taskId) {
        const stats = buildTaskStats(
            String(options.taskId),
            targetRoot,
            eventsRoot,
            reviewsRoot
        );
        if (options.json === true) {
            console.log(formatTaskStatsJson(stats));
        } else {
            console.log(formatTaskStatsText(stats));
        }
    } else {
        const stats = buildAggregateStats(targetRoot, eventsRoot, reviewsRoot);
        if (options.json === true) {
            console.log(formatAggregateStatsJson(stats));
        } else {
            console.log(formatAggregateStatsText(stats));
        }
    }
}

export function handleDiffManaged(commandArgv: string[], packageJson: PackageJsonLike): void {
    const diffDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, diffDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.help) {
        printHelp(packageJson);
        return;
    }
    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    const result = collectManagedDiff(targetRoot);

    if (options.json === true) {
        console.log(formatDiffManagedJson(result));
    } else {
        console.log(formatDiffManagedText(result));
    }
}
