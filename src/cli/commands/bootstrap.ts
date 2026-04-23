import * as path from 'node:path';
import { DEFAULT_BUNDLE_NAME, PRIMARY_CLI_ENTRYPOINT, resolveBundleName, SOURCE_OF_TRUTH_VALUES } from '../../core/constants';
import {
    acquireSourceRoot,
    deployFreshBundle,
    normalizePathValue,
    parseOptions,
    PackageJsonLike,
    printHelp
} from './cli-helpers';

export const BOOTSTRAP_DEFINITIONS = {
    '--destination': { key: 'destination', type: 'string' },
    '--target': { key: 'destination', type: 'string' },
    '--repo-url': { key: 'repoUrl', type: 'string' },
    '--branch': { key: 'branch', type: 'string' }
};

// Emits GARDA_BOOTSTRAP_OK contract output.
export function buildBootstrapSuccessOutput(packageJson: PackageJsonLike, bundleVersion: string, destinationPath: string): string {
    const targetRoot = path.dirname(destinationPath);
    const bundleRelativePath = path.relative(targetRoot, destinationPath) || path.basename(destinationPath);
    const initPromptPath = path.join(destinationPath, 'AGENT_INIT_PROMPT.md');
    const bundleCliPath = path.join(destinationPath, path.basename(PRIMARY_CLI_ENTRYPOINT));
    const initAnswersRelativePath = path.join(bundleRelativePath, 'runtime', 'init-answers.json');
    const sourceOfTruthOptions = SOURCE_OF_TRUTH_VALUES.join('|');

    const lines = [];
    lines.push('GARDA_BOOTSTRAP_OK');
    lines.push(`PackageVersion: ${packageJson.version}`);
    lines.push(`BundleVersion: ${bundleVersion}`);
    lines.push(`BundlePath: ${destinationPath}`);
    lines.push(`TargetRoot: ${targetRoot}`);
    lines.push(`InitPromptPath: ${initPromptPath}`);
    lines.push(`InitAnswersPath: ${initAnswersRelativePath}`);
    lines.push('NextSteps:');
    lines.push(`1. Give your agent "${initPromptPath}".`);
    lines.push(`2. Let the agent write "${path.join(targetRoot, initAnswersRelativePath)}".`);

    if (bundleRelativePath === DEFAULT_BUNDLE_NAME) {
        lines.push('3. After init answers exist, run the lifecycle CLI:');
        lines.push(`   npx ${packageJson.name} install --target-root "${targetRoot}" --init-answers-path "${initAnswersRelativePath}"`);
    } else {
        lines.push('3. Custom bundle paths should still use the Node CLI:');
        lines.push(`   node "${bundleCliPath}" install --target-root "${targetRoot}" --assistant-language "<language>" --assistant-brevity "<concise|detailed>" --source-of-truth "<${sourceOfTruthOptions}>" --init-answers-path "${initAnswersRelativePath}"`);
    }

    return lines.join('\n');
}

export function printBootstrapSuccess(packageJson: PackageJsonLike, bundleVersion: string, destinationPath: string): void {
    console.log(buildBootstrapSuccessOutput(packageJson, bundleVersion, destinationPath));
}

export async function handleBootstrap(commandArgv: string[], packageJson: PackageJsonLike, packageRoot: string): Promise<void> {
    const { options, positionals } = parseOptions(commandArgv, BOOTSTRAP_DEFINITIONS, {
        allowPositionals: true,
        maxPositionals: 1
    });

    if (options.help) { printHelp(packageJson); return; }
    if (options.version) { console.log(packageJson.version); return; }

    const destinationOption = typeof options.destination === 'string' ? options.destination : undefined;
    const repoUrl = typeof options.repoUrl === 'string' ? options.repoUrl : undefined;
    const branch = typeof options.branch === 'string' ? options.branch : undefined;

    const destinationPath = normalizePathValue(destinationOption || positionals[0] || resolveBundleName());
    const source = await acquireSourceRoot(repoUrl, branch, packageRoot);
    try {
        deployFreshBundle(source.sourceRoot, destinationPath);
        printBootstrapSuccess(packageJson, source.bundleVersion, destinationPath);
    } finally {
        source.cleanup();
    }
}
