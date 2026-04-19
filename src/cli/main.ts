import { PRIMARY_CLI_NAME } from '../core/constants';

async function loadCliRuntimeEntry() {
    return await import('./runtime-main');
}

export async function runCliMain(argv: string[] = process.argv.slice(2), packageRoot?: string): Promise<void> {
    const runtimeEntry = await loadCliRuntimeEntry();
    await runtimeEntry.runCliRuntimeMain(argv, packageRoot);
}

export async function runCliMainWithHandling(
    argv: string[] = process.argv.slice(2),
    packageRoot?: string
): Promise<void> {
    const runtimeEntry = await loadCliRuntimeEntry();
    await runtimeEntry.runCliRuntimeMainWithHandling(argv, packageRoot);
}

if (require.main === module) {
    runCliMainWithHandling().catch((error) => {
        console.error(`${PRIMARY_CLI_NAME}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
        process.exitCode = 1;
    });
}
