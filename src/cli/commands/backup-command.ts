import * as path from 'node:path';
import { createBackupSnapshot } from '../../lifecycle/backups';
import { withLifecycleOperationLock } from '../../lifecycle/common';
import {
    ensureDirectoryExists,
    normalizePathValue,
    PackageJsonLike,
    parseOptions,
    printHelp
} from './cli-helpers';
import {
    ensureBundleExists,
    formatKeyValueOutput,
    getDefaultInitAnswersPath,
    ParsedOptionsRecord
} from './shared-command-utils';

function toRelativeTargetPath(targetRoot: string, absolutePath: string): string {
    return path.relative(targetRoot, absolutePath).replace(/\\/g, '/');
}

function buildBackupHelpText(): string {
    return [
        'GARDA_COMMAND_HELP',
        'Command: backup',
        '',
        'Usage:',
        '  garda backup create --confirm [--target-root PATH] [--init-answers-path PATH] [--json]',
        '  garda backup create --dry-run [--target-root PATH] [--json]',
        '',
        'Description:',
        '  Creates a manual rollback backup snapshot in the backup inventory.',
        '',
        'Notes:',
        '  Mutating backup create runs require --confirm. Dry-run prints the planned target without creating files.'
    ].join('\n');
}

export async function handleBackup(commandArgv: string[], packageJson: PackageJsonLike): Promise<void> {
    const subcommand = String(commandArgv[0] || '').trim().toLowerCase();
    if (!subcommand || subcommand === 'help' || commandArgv.includes('--help') || commandArgv.includes('-h')) {
        console.log(buildBackupHelpText());
        return;
    }
    if (subcommand !== 'create') {
        printHelp(packageJson);
        throw new Error(`Unsupported backup subcommand: ${subcommand}`);
    }

    const definitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--confirm': { key: 'confirm', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv.slice(1), definitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (options.version) {
        console.log(packageJson.version);
        return;
    }

    const targetRoot = normalizePathValue(options.targetRoot || '.');
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'backup create');
    const initAnswersPath = typeof options.initAnswersPath === 'string'
        ? options.initAnswersPath
        : getDefaultInitAnswersPath(targetRoot, bundlePath);

    if (options.dryRun === true) {
        const result = {
            targetRoot,
            backupMode: 'manual',
            dryRun: true,
            status: 'SKIPPED_DRY_RUN',
            snapshotPath: 'not-created-in-dry-run',
            initAnswersPath
        };
        if (options.json === true) {
            console.log(JSON.stringify(result, null, 2));
        } else {
            formatKeyValueOutput(result, ['targetRoot', 'backupMode', 'dryRun', 'status', 'snapshotPath', 'initAnswersPath']);
        }
        return;
    }

    if (options.confirm !== true) {
        throw new Error('backup create mutates the workspace and requires --confirm. Use --dry-run for a read-only preview.');
    }

    const backup = withLifecycleOperationLock(targetRoot, 'backup', () => createBackupSnapshot({
        targetRoot,
        bundleRoot: bundlePath,
        reason: 'manual',
        initAnswersPath
    }));
    const result = {
        targetRoot,
        backupMode: 'manual',
        dryRun: false,
        status: backup.health === 'AVAILABLE' ? 'SUCCESS' : 'CREATED_WITH_HEALTH_WARNING',
        backupId: backup.id,
        createdAt: backup.createdAt,
        snapshotPath: backup.relativeSnapshotPath,
        rollbackRecordsPath: toRelativeTargetPath(path.resolve(targetRoot), backup.rollbackRecordsPath),
        rollbackRecordCount: backup.recordCount,
        sizeBytes: backup.sizeBytes,
        health: backup.health,
        healthMessage: backup.healthMessage
    };

    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
    }
    formatKeyValueOutput(result, [
        'targetRoot',
        'backupMode',
        'dryRun',
        'status',
        'backupId',
        'createdAt',
        'snapshotPath',
        'rollbackRecordsPath',
        'rollbackRecordCount',
        'sizeBytes',
        'health',
        'healthMessage'
    ]);
}
