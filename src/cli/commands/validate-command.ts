import { runVerify, formatVerifyResult, formatVerifyResultCompact } from '../../validators/verify';
import {
    normalizeSourceOfTruth,
    PackageJsonLike,
    parseOptions
} from './cli-helpers';
import {
    ParsedOptionsRecord,
    ValidationFailureError
} from './shared-command-utils';
import {
    handleStandardFlags,
    resolveWorkspaceContext
} from './workspace-helpers';

export function handleVerify(commandArgv: string[], packageJson: PackageJsonLike): void {
    const verifyDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--source-of-truth': { key: 'sourceOfTruth', type: 'string' },
        '--compact': { key: 'compact', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, verifyDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const { targetRoot, answers } = resolveWorkspaceContext(options.targetRoot, options.initAnswersPath, 'verify');
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
