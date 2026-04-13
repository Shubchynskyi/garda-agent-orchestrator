import * as childProcess from 'node:child_process';
import * as path from 'node:path';

import { buildNodeFoundation, getRepoRoot, BuildResult } from './build';

export function runNodeFoundationTests(): void {
    const repoRoot: string = getRepoRoot();
    const buildResult: BuildResult = buildNodeFoundation();
    const testFiles: string[] = buildResult.copiedFiles
        .filter((relativePath: string) => relativePath.startsWith('tests/node/') && relativePath.endsWith('.test.js'))
        .map((relativePath: string) => path.join(buildResult.buildRoot, ...relativePath.split('/')));

    if (testFiles.length === 0) {
        throw new Error('No Node foundation tests were found under .node-build/tests/node.');
    }

    const result = childProcess.spawnSync(process.execPath, ['--test', ...testFiles], {
        cwd: repoRoot,
        stdio: 'inherit'
    });

    if (result.status !== 0) {
        process.exit(result.status || 1);
    }

    console.log('NODE_FOUNDATION_TEST_OK');
}

// CLI entry point when run directly
if (require.main === module) {
    runNodeFoundationTests();
}
