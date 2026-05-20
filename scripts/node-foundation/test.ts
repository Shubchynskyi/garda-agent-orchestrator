import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildNodeFoundation, buildPublishRuntime, getRepoRoot, BuildResult } from './build';

const NODE_FOUNDATION_TEST_SHARDS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARDS';
const NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME_ENV = 'GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME';

const NODE_TEST_OPTIONS_WITH_VALUE = new Set<string>([
    '--test-name-pattern',
    '--test-skip-pattern',
    '--test-reporter',
    '--test-reporter-destination',
    '--test-concurrency',
    '--test-timeout',
    '--test-shard',
    '--watch-path'
]);

function normalizeCliPath(value: string): string {
    return value.replace(/\\/g, '/');
}

function collectCompiledNodeFoundationTestFiles(buildResult: BuildResult): string[] {
    return buildResult.copiedFiles
        .filter((relativePath: string) => relativePath.startsWith('tests/node/') && relativePath.endsWith('.test.js'))
        .map((relativePath: string) => path.join(buildResult.buildRoot, ...relativePath.split('/')));
}

function splitForwardedTestArgs(forwardedArgs: string[]): { optionArgs: string[]; fileTargets: string[]; } {
    const optionArgs: string[] = [];
    const fileTargets: string[] = [];
    let expectsOptionValue = false;
    let positionalOnly = false;

    for (const arg of forwardedArgs) {
        if (expectsOptionValue) {
            optionArgs.push(arg);
            expectsOptionValue = false;
            continue;
        }

        if (positionalOnly) {
            fileTargets.push(arg);
            continue;
        }

        if (arg === '--') {
            optionArgs.push(arg);
            positionalOnly = true;
            continue;
        }

        if (arg.startsWith('--')) {
            optionArgs.push(arg);
            if (!arg.includes('=') && NODE_TEST_OPTIONS_WITH_VALUE.has(arg)) {
                expectsOptionValue = true;
            }
            continue;
        }

        if (arg.startsWith('-') && arg !== '-') {
            optionArgs.push(arg);
            continue;
        }

        fileTargets.push(arg);
    }

    if (expectsOptionValue) {
        throw new Error(`Missing value for Node test option '${optionArgs[optionArgs.length - 1]}'.`);
    }

    return { optionArgs, fileTargets };
}

function buildCompiledTestLookup(buildResult: BuildResult, compiledTestFiles: string[]): Map<string, string> {
    const lookup = new Map<string, string>();

    const addCandidate = (candidate: string, compiledPath: string): void => {
        const normalized = normalizeCliPath(candidate).replace(/^\.\//, '');
        if (!normalized || lookup.has(normalized)) {
            return;
        }
        lookup.set(normalized, compiledPath);
    };

    for (const compiledPath of compiledTestFiles) {
        const compiledRelative = normalizeCliPath(path.relative(buildResult.buildRoot, compiledPath));
        const compiledRepoRelative = normalizeCliPath(path.relative(buildResult.repoRoot, compiledPath));
        const sourceRelativeTs = compiledRelative.replace(/\.js$/i, '.ts');

        addCandidate(compiledRelative, compiledPath);
        addCandidate(`./${compiledRelative}`, compiledPath);
        addCandidate(compiledRepoRelative, compiledPath);
        addCandidate(`./${compiledRepoRelative}`, compiledPath);
        addCandidate(sourceRelativeTs, compiledPath);
        addCandidate(`./${sourceRelativeTs}`, compiledPath);
    }

    return lookup;
}

function resolveCompiledTestTarget(
    buildResult: BuildResult,
    compiledTestLookup: Map<string, string>,
    target: string
): string | null {
    const normalizedTarget = normalizeCliPath(target).replace(/^\.\//, '');
    const repoRelativeTarget = normalizeCliPath(path.relative(buildResult.repoRoot, path.resolve(buildResult.repoRoot, target)));
    const candidates = new Set<string>([normalizedTarget, repoRelativeTarget]);

    if (path.isAbsolute(target)) {
        const absoluteTarget = path.resolve(target);
        const relativeToBuildRoot = normalizeCliPath(path.relative(buildResult.buildRoot, absoluteTarget));
        if (!relativeToBuildRoot.startsWith('../') && !relativeToBuildRoot.startsWith('..\\')) {
            return absoluteTarget;
        }
    }

    for (const candidate of Array.from(candidates)) {
        if (candidate.endsWith('.ts')) {
            candidates.add(candidate.replace(/\.ts$/i, '.js'));
        }
    }

    for (const candidate of candidates) {
        const compiledPath = compiledTestLookup.get(candidate);
        if (compiledPath) {
            return compiledPath;
        }
    }

    for (const candidate of candidates) {
        const normalizedCandidate = candidate.replace(/^\.\//, '');
        if (normalizedCandidate.startsWith('tests/node/')) {
            const compiledPath = path.join(buildResult.buildRoot, ...normalizedCandidate.replace(/\.ts$/i, '.js').split('/'));
            if (fs.existsSync(compiledPath)) {
                return compiledPath;
            }
        }
        if (normalizedCandidate.startsWith('.node-build/tests/node/')) {
            const compiledPath = path.join(buildResult.repoRoot, ...normalizedCandidate.split('/'));
            if (fs.existsSync(compiledPath)) {
                return compiledPath;
            }
        }
    }

    return null;
}

function resolveSelectedTestFiles(buildResult: BuildResult, compiledTestFiles: string[], fileTargets: string[]): string[] {
    if (fileTargets.length === 0) {
        return compiledTestFiles;
    }

    const compiledTestLookup = buildCompiledTestLookup(buildResult, compiledTestFiles);
    const selectedTestFiles: string[] = [];
    const seen = new Set<string>();

    for (const fileTarget of fileTargets) {
        const compiledPath = resolveCompiledTestTarget(buildResult, compiledTestLookup, fileTarget);
        if (!compiledPath) {
            throw new Error(`Unable to resolve targeted Node foundation test path: ${fileTarget}`);
        }
        if (seen.has(compiledPath)) {
            continue;
        }
        seen.add(compiledPath);
        selectedTestFiles.push(compiledPath);
    }

    if (selectedTestFiles.length === 0) {
        throw new Error('No targeted Node foundation tests matched the requested file filters.');
    }

    return selectedTestFiles;
}

function hasExplicitTestShardOption(optionArgs: string[]): boolean {
    return optionArgs.some((arg) => arg === '--test-shard' || arg.startsWith('--test-shard='));
}

function resolveNodeFoundationShardCount(selectedTestFiles: string[], optionArgs: string[], fileTargets: string[]): number {
    if (fileTargets.length > 0 || hasExplicitTestShardOption(optionArgs)) {
        return 1;
    }

    const rawValue = String(process.env[NODE_FOUNDATION_TEST_SHARDS_ENV] || '1').trim();
    if (!rawValue) {
        return 1;
    }

    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${NODE_FOUNDATION_TEST_SHARDS_ENV} must be a positive integer.`);
    }

    return Math.max(1, Math.min(parsed, selectedTestFiles.length));
}

function buildNodeFoundationTestShards(selectedTestFiles: string[], shardCount: number): string[][] {
    const shards = Array.from({ length: shardCount }, () => [] as string[]);
    selectedTestFiles.forEach((testFile, index) => {
        shards[index % shardCount].push(testFile);
    });
    return shards.filter((shard) => shard.length > 0);
}

function runSingleNodeTestProcess(repoRoot: string, optionArgs: string[], selectedTestFiles: string[]): number {
    const result = childProcess.spawnSync(process.execPath, ['--test', ...optionArgs, ...selectedTestFiles], {
        cwd: repoRoot,
        stdio: 'inherit',
        windowsHide: true
    });
    return result.status == null ? 1 : result.status;
}

function runNodeTestShard(repoRoot: string, optionArgs: string[], shardFiles: string[], shardIndex: number, shardCount: number): Promise<number> {
    return new Promise((resolve, reject) => {
        console.log(`NODE_FOUNDATION_TEST_SHARD_START ${shardIndex + 1}/${shardCount} files=${shardFiles.length}`);
        const child = childProcess.spawn(process.execPath, ['--test', ...optionArgs, ...shardFiles], {
            cwd: repoRoot,
            stdio: 'inherit',
            windowsHide: true
        });
        child.once('error', reject);
        child.once('exit', (code) => {
            const exitCode = code == null ? 1 : code;
            console.log(`NODE_FOUNDATION_TEST_SHARD_DONE ${shardIndex + 1}/${shardCount} exit=${exitCode}`);
            resolve(exitCode);
        });
    });
}

async function runShardedNodeTestProcesses(repoRoot: string, optionArgs: string[], selectedTestFiles: string[], shardCount: number): Promise<number> {
    const shards = buildNodeFoundationTestShards(selectedTestFiles, shardCount);
    const exitCodes = await Promise.all(shards.map((shardFiles, index) =>
        runNodeTestShard(repoRoot, optionArgs, shardFiles, index, shards.length)
    ));
    return exitCodes.find((exitCode) => exitCode !== 0) || 0;
}

function ensureReusablePublishRuntime(repoRoot: string): void {
    const manifestPath = path.join(repoRoot, 'dist', 'publish-runtime-manifest.json');
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        throw new Error(
            `${NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME_ENV}=1 requires prebuilt publish runtime artifact: ${manifestPath}`
        );
    }
}

export async function runNodeFoundationTests(): Promise<number> {
    const repoRoot: string = getRepoRoot();
    // Some lifecycle/update tests seed sync-surface fixtures from the current
    // publish-runtime bundle, so refresh dist before compiling .node-build.
    if (process.env[NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME_ENV] === '1') {
        ensureReusablePublishRuntime(repoRoot);
    } else {
        buildPublishRuntime();
    }
    const buildResult: BuildResult = buildNodeFoundation();
    const compiledTestFiles: string[] = collectCompiledNodeFoundationTestFiles(buildResult);
    const forwardedArgs = process.argv.slice(2);
    const { optionArgs, fileTargets } = splitForwardedTestArgs(forwardedArgs);
    const selectedTestFiles = resolveSelectedTestFiles(buildResult, compiledTestFiles, fileTargets);

    if (compiledTestFiles.length === 0) {
        throw new Error('No Node foundation tests were found under .node-build/tests/node.');
    }

    const shardCount = resolveNodeFoundationShardCount(selectedTestFiles, optionArgs, fileTargets);
    const exitCode = shardCount === 1
        ? runSingleNodeTestProcess(repoRoot, optionArgs, selectedTestFiles)
        : await runShardedNodeTestProcesses(repoRoot, optionArgs, selectedTestFiles, shardCount);

    if (exitCode !== 0) {
        return exitCode;
    }
    console.log('NODE_FOUNDATION_TEST_OK');
    return 0;
}

// CLI entry point when run directly
if (require.main === module) {
    runNodeFoundationTests()
        .then((exitCode) => {
            if (exitCode !== 0) {
                process.exit(exitCode);
            }
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error);
            console.error(message);
            process.exit(1);
        });
}
