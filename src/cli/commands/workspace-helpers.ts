import {
    ensureDirectoryExists,
    normalizePathValue,
    PackageJsonLike,
    printHelp,
    readInitAnswersArtifact
} from './cli-helpers';
import {
    ensureBundleExists,
    getDefaultInitAnswersPath,
    type ParsedOptionsRecord,
    type ParsedOptionValue
} from './shared-command-utils';

export type InitAnswersResult = ReturnType<typeof readInitAnswersArtifact>;

export interface WorkspacePathContext {
    targetRoot: string;
    bundlePath: string;
}

export interface WorkspaceContext extends WorkspacePathContext {
    initAnswersPath: string;
    answers: InitAnswersResult;
}

export function resolveTargetRoot(rawValue?: ParsedOptionValue): string {
    const targetRoot = normalizePathValue(
        (typeof rawValue === 'string' ? rawValue : undefined) || '.'
    );
    ensureDirectoryExists(targetRoot, 'Target root');
    return targetRoot;
}

export function resolveWorkspacePaths(
    rawTargetRoot: ParsedOptionValue,
    commandName: string
): WorkspacePathContext {
    const targetRoot = resolveTargetRoot(rawTargetRoot);
    const bundlePath = ensureBundleExists(targetRoot, commandName);
    return { targetRoot, bundlePath };
}

export function resolveInitAnswersPath(
    rawInitAnswersPath: ParsedOptionValue,
    targetRoot: string,
    bundlePath: string
): string {
    return typeof rawInitAnswersPath === 'string'
        ? rawInitAnswersPath
        : getDefaultInitAnswersPath(targetRoot, bundlePath);
}

export function resolveWorkspaceContext(
    rawTargetRoot: ParsedOptionValue,
    rawInitAnswersPath: ParsedOptionValue,
    commandName: string
): WorkspaceContext {
    const { targetRoot, bundlePath } = resolveWorkspacePaths(rawTargetRoot, commandName);
    const initAnswersPath = resolveInitAnswersPath(rawInitAnswersPath, targetRoot, bundlePath);
    const answers = readInitAnswersArtifact(targetRoot, initAnswersPath, bundlePath, commandName);
    return { targetRoot, bundlePath, initAnswersPath, answers };
}

export function handleStandardFlags(
    options: ParsedOptionsRecord,
    packageJson: PackageJsonLike
): boolean {
    if (options.help) {
        printHelp(packageJson);
        return true;
    }
    if (options.version) {
        console.log(packageJson.version);
        return true;
    }
    return false;
}
