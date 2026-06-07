import * as fs from 'node:fs';
import * as path from 'node:path';
import { withLifecycleOperationLockAsync } from '../../../lifecycle/common';
import { runInit } from '../../../materialization/init';
import { runInstall } from '../../../materialization/install';
import {
    acquireSourceRoot,
    getBundlePath,
    PackageJsonLike,
    parseOptions,
    readInitAnswersArtifact,
    syncBundleItems
} from '../cli-helpers';
import { formatKeyValueOutput, type ParsedOptionsRecord } from '../shared-command-utils';
import { hasMaterializedWorkflowConfigBaseline } from '../../../core/workflow-config';
import {
    handleStandardFlags,
    resolveInitAnswersPath,
    resolveTargetRoot,
    resolveWorkspaceContext
} from './workspace-helpers';

export async function handleInstall(commandArgv: string[], packageJson: PackageJsonLike, packageRoot: string): Promise<void> {
    const installDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--repo-url': { key: 'repoUrl', type: 'string' },
        '--branch': { key: 'branch', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, installDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const targetRoot = resolveTargetRoot(options.targetRoot);

    const source = await acquireSourceRoot(
        typeof options.repoUrl === 'string' ? options.repoUrl : undefined,
        typeof options.branch === 'string' ? options.branch : undefined,
        packageRoot
    );
    try {
        await withLifecycleOperationLockAsync(targetRoot, 'install', async () => {
            const bundlePath = getBundlePath(targetRoot);
            const bundleHadMaterializedLiveBeforeInstall = hasMaterializedWorkflowConfigBaseline(bundlePath);
            const sourceResolved = path.resolve(source.sourceRoot);
            const bundleResolved = path.resolve(bundlePath);
            if (sourceResolved.toLowerCase() !== bundleResolved.toLowerCase() && !options.dryRun) {
                syncBundleItems(source.sourceRoot, bundlePath);
            }

            const effectiveBundlePath = fs.existsSync(bundlePath) ? bundlePath : source.sourceRoot;
            const initAnswersPath = resolveInitAnswersPath(options.initAnswersPath, targetRoot, bundlePath);
            const answers = readInitAnswersArtifact(targetRoot, initAnswersPath, bundlePath, 'install');
            const installResult = runInstall({
                targetRoot,
                bundleRoot: effectiveBundlePath,
                assistantLanguage: answers.assistantLanguage,
                assistantBrevity: answers.assistantBrevity,
                sourceOfTruth: answers.sourceOfTruth,
                initAnswersPath: answers.resolvedPath,
                dryRun: options.dryRun === true,
                initRunner(initOptions) {
                    return runInit({
                        ...initOptions,
                        bundleRoot: effectiveBundlePath,
                        preserveLegacyReviewExecutionPolicyOmission: bundleHadMaterializedLiveBeforeInstall
                    });
                }
            }) as Record<string, unknown>;
            formatKeyValueOutput(installResult, [
                'targetRoot', 'sourceOfTruth', 'canonicalEntrypoint',
                'assistantLanguage', 'assistantBrevity',
                'filesDeployed', 'initInvoked', 'liveVersionWritten',
                'workflowConfigMergeStatus',
                'dryRun'
            ]);
        });
    } finally {
        source.cleanup();
    }
}

export function handleInit(commandArgv: string[], packageJson: PackageJsonLike): void {
    const initDefinitions = {
        '--target-root': { key: 'targetRoot', type: 'string' },
        '--init-answers-path': { key: 'initAnswersPath', type: 'string' },
        '--dry-run': { key: 'dryRun', type: 'boolean' }
    };
    const { options: rawOptions } = parseOptions(commandArgv, initDefinitions);
    const options = rawOptions as ParsedOptionsRecord;

    if (handleStandardFlags(options, packageJson)) return;

    const { targetRoot, bundlePath, answers } = resolveWorkspaceContext(options.targetRoot, options.initAnswersPath, 'init');

    const initResult = runInit({
        targetRoot,
        bundleRoot: bundlePath,
        assistantLanguage: answers.assistantLanguage,
        assistantBrevity: answers.assistantBrevity,
        sourceOfTruth: answers.sourceOfTruth,
        enforceNoAutoCommit: answers.enforceNoAutoCommit,
        claudeOrchestratorFullAccess: answers.claudeOrchestratorFullAccess,
        tokenEconomyEnabled: answers.tokenEconomyEnabled,
        providerMinimalism: answers.providerMinimalism,
        activeAgentFilesSeed: answers.activeAgentFiles,
        preserveLegacyReviewExecutionPolicyOmission: hasMaterializedWorkflowConfigBaseline(bundlePath),
        dryRun: options.dryRun === true
    }) as Record<string, unknown>;
    console.log('Init: PASSED');
    formatKeyValueOutput(initResult, [
        'targetRoot', 'sourceOfTruth', 'assistantLanguage',
        'ruleFilesMaterialized', 'projectDiscoveryPath', 'usagePath'
    ]);
}
