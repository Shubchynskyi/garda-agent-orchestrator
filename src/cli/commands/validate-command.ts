import { runVerify, formatVerifyResult, formatVerifyResultCompact } from '../../validators/verify';
import {
    ensureDirectoryExists,
    normalizePathValue,
    normalizeSourceOfTruth,
    PackageJsonLike,
    parseOptions,
    printHelp,
    readInitAnswersArtifact
} from './cli-helpers';
import {
    ensureBundleExists,
    getDefaultInitAnswersPath,
    ParsedOptionsRecord,
    ValidationFailureError
} from './shared-command-utils';

export function handleVerify(commandArgv: string[], packageJson: PackageJsonLike): void {
    const verifyDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--source-of-truth': { key: 'sourceOfTruth', type: 'string' },
        '--compact': { key: 'compact', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, verifyDefinitions);
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
    ensureDirectoryExists(targetRoot, 'Target root');
    const bundlePath = ensureBundleExists(targetRoot, 'verify');
    const initAnswersPath = typeof options.initAnswersPath === 'string'
        ? options.initAnswersPath
        : getDefaultInitAnswersPath(targetRoot, bundlePath);
    const answers = readInitAnswersArtifact(targetRoot, initAnswersPath, bundlePath, 'verify');
    const sourceOfTruth = options.sourceOfTruth !== undefined
        ? normalizeSourceOfTruth(options.sourceOfTruth)
        : answers.sourceOfTruth;

    const result = runVerify({
        targetRoot,
        sourceOfTruth,
        initAnswersPath: answers.resolvedPath
    });
    console.log(options.compact === true ? formatVerifyResultCompact(result) : formatVerifyResult(result));
    if (result.totalViolationCount > 0) {
        throw new ValidationFailureError(`Workspace verification failed with ${result.totalViolationCount} violation(s).`);
    }
}
