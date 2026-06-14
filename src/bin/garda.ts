#!/usr/bin/env node

import {
    extractBundleNameArg,
    findPackageRoot,
    inferBundleNameFromPackageRoot,
    validateBundleName
} from './garda/root-discovery';
import { resolveDelegatedLauncherTarget } from './garda/delegation-policy';
import { delegateToLocalCli } from './garda/process-delegation';
import { loadCliMainModule } from './garda/runtime-loading';

export * from './garda/root-discovery';
export * from './garda/runtime-loading';
export * from './garda/delegation-policy';
export * from './garda/process-delegation';

export async function main(argv: string[] = process.argv.slice(2), cwd: string = process.cwd()): Promise<void> {
    const bundleNameArg = extractBundleNameArg(argv);
    if (bundleNameArg !== null) {
        process.env.GARDA_BUNDLE_NAME = validateBundleName(bundleNameArg, '--bundle-name');
    }
    const packageRoot = findPackageRoot(__dirname);
    if (process.env.GARDA_BUNDLE_NAME === undefined) {
        const inferredBundleName = inferBundleNameFromPackageRoot(packageRoot);
        if (inferredBundleName) {
            process.env.GARDA_BUNDLE_NAME = validateBundleName(inferredBundleName, 'inferred bundle name');
        }
    }
    const delegatedCli = resolveDelegatedLauncherTarget(argv, cwd, __filename, packageRoot);
    if (delegatedCli) {
        await delegateToLocalCli(delegatedCli, argv);
    }
    const { runCliMainWithHandling } = loadCliMainModule(packageRoot);
    await runCliMainWithHandling(argv, packageRoot);
}

if (require.main === module) {
    void main();
}
