import { PRIMARY_CLI_NAME } from '../../core/constants';
import { getCanonicalEntrypoint } from '../../validators/workspace-layout';
import { explainFailure, formatExplainResult, listExplainIds } from '../../validators/explain';
import { runDoctor, formatDoctorResult, formatDoctorResultCompact, formatDoctorResultJson } from '../../validators/doctor';
import { getStatusSnapshot, formatStatusSnapshotCompact, formatStatusSnapshotJson } from '../../validators/status';
import { getWhyBlocked, formatWhyBlockedResult } from '../../validators/why-blocked';
import {
    getInitAnswerValue,
    PackageJsonLike,
    parseOptions,
    printBanner,
    printStatus,
    readInitAnswersArtifact,
    resolveWorkspaceDisplayVersion
} from './cli-helpers';
import {
    ensureBundleExists,
    ParsedOptionsRecord
} from './shared-command-utils';
import { EXIT_VALIDATION_FAILURE } from '../exit-codes';
import {
    handleStandardFlags,
    resolveInitAnswersPath,
    resolveTargetRoot
} from './workspace-helpers';

export function handleStatus(commandArgv: string[], packageJson: PackageJsonLike): void {
    if (commandArgv.length > 0 && commandArgv[0].toLowerCase() === 'why-blocked') {
        handleStatusWhyBlocked(commandArgv.slice(1));
        return;
    }

    const statusDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--compact': { key: 'compact', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, statusDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const targetRoot = resolveTargetRoot(options.targetRoot);
    const snapshot = getStatusSnapshot(
        targetRoot,
        typeof options.initAnswersPath === 'string' ? options.initAnswersPath : undefined
    );
    if (options.json === true) {
        console.log(formatStatusSnapshotJson(snapshot));
    } else if (options.compact === true) {
        console.log(formatStatusSnapshotCompact(snapshot));
    } else {
        printBanner(packageJson, 'Workspace status', targetRoot, {
            versionOverride: resolveWorkspaceDisplayVersion(targetRoot, packageJson.version)
        });
        printStatus(snapshot);
    }
}

export function handleStatusWhyBlocked(commandArgv: string[]): void {
    const definitions = {
        '--target-root': { key: 'targetRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, definitions);
    const options = rawOptions as ParsedOptionsRecord;

    const targetRoot = resolveTargetRoot(options.targetRoot);

    const result = getWhyBlocked(targetRoot);
    console.log(formatWhyBlockedResult(result));

    if (result.has_blocked_tasks) {
        process.exitCode = EXIT_VALIDATION_FAILURE;
    }
}

export function handleDoctor(commandArgv: string[], packageJson: PackageJsonLike): void {
    if (commandArgv.length > 0 && commandArgv[0].toLowerCase() === 'explain') {
        handleDoctorExplain(commandArgv.slice(1));
        return;
    }

    const doctorDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--cleanup-stale-locks': { key: 'cleanupStaleLocks', type: 'boolean' },
        '--dry-run': { key: 'dryRun', type: 'boolean' },
        '--compact': { key: 'compact', type: 'boolean' },
        '--json': { key: 'json', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, doctorDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const targetRoot = resolveTargetRoot(options.targetRoot);
    if (options.compact !== true && options.json !== true) {
        printBanner(packageJson, 'Workspace doctor', targetRoot, {
            versionOverride: resolveWorkspaceDisplayVersion(targetRoot, packageJson.version)
        });
    }

    const bundlePath = ensureBundleExists(targetRoot, 'doctor');
    const initAnswersPath = resolveInitAnswersPath(options.initAnswersPath, targetRoot, bundlePath);
    const answers = readInitAnswersArtifact(targetRoot, initAnswersPath, bundlePath, 'doctor');
    let activeAgentFilesList = answers.activeAgentFiles
        ? answers.activeAgentFiles.split(/[,;]+/).map((value: string) => value.trim()).filter(Boolean)
        : [];
    if (activeAgentFilesList.length === 0) {
        const inferred = getCanonicalEntrypoint(answers.sourceOfTruth);
        if (inferred) {
            activeAgentFilesList = [inferred];
        }
    }

    const result = runDoctor({
        targetRoot,
        sourceOfTruth: answers.sourceOfTruth,
        initAnswersPath: answers.resolvedPath,
        cleanupStaleLocks: options.cleanupStaleLocks === true,
        dryRun: options.dryRun === true,
        activeAgentFiles: activeAgentFilesList
    });
    if (options.json === true) {
        console.log(formatDoctorResultJson(result));
    } else {
        console.log(options.compact === true ? formatDoctorResultCompact(result) : formatDoctorResult(result));
    }
    if (!result.passed) {
        throw new Error('Workspace doctor detected validation failures.');
    }
}

export function handleDoctorExplain(commandArgv: string[]): void {
    const definitions = {
        '--failure-id': { key: 'failureId', type: 'string' },
        '--list': { key: 'list', type: 'boolean' }
    };
    const { options: rawOptions, positionals } = parseOptions(commandArgv, definitions, {
        allowPositionals: true,
        maxPositionals: 1
    });
    const options = rawOptions as ParsedOptionsRecord;

    if (options.list) {
        console.log('Available failure IDs:');
        for (const id of listExplainIds()) {
            console.log(`  ${id}`);
        }
        return;
    }

    const rawId = (typeof options.failureId === 'string' && options.failureId)
        ? options.failureId
        : (positionals[0] || '');

    if (!rawId) {
        console.log(`Usage: ${PRIMARY_CLI_NAME} doctor explain <failure-id>`);
        console.log(`       ${PRIMARY_CLI_NAME} doctor explain --list`);
        console.log('');
        console.log('Available failure IDs:');
        for (const id of listExplainIds()) {
            console.log(`  ${id}`);
        }
        return;
    }

    const result = explainFailure(rawId);
    console.log(formatExplainResult(result));

    if (!result.found) {
        process.exitCode = EXIT_VALIDATION_FAILURE;
    }
}
