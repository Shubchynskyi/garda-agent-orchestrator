import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildNodeFoundation, buildPublishRuntime, getRepoRoot, BuildResult } from './build';

const NODE_FOUNDATION_TEST_SHARDS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARDS';
const NODE_FOUNDATION_TEST_SHARD_LOG_DIR_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_LOG_DIR';
const NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME_ENV = 'GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME';
const NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT = 24_000;
const GARDA_SHARDS_OPTION = '--garda-shards';
const GARDA_SHARD_LOG_DIR_OPTION = '--garda-shard-log-dir';

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

function readOptionValue(args: string[], index: number, optionName: string): { value: string; consumedNext: boolean; } {
    const arg = args[index];
    if (arg.startsWith(`${optionName}=`)) {
        return { value: arg.slice(optionName.length + 1), consumedNext: false };
    }
    const value = args[index + 1];
    if (!value) {
        throw new Error(`Missing value for ${optionName}.`);
    }
    return { value, consumedNext: true };
}

function parsePositiveInteger(value: string, label: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
        throw new Error(`${label} must be a positive integer.`);
    }
    return parsed;
}

function splitForwardedTestArgs(forwardedArgs: string[]): {
    optionArgs: string[];
    fileTargets: string[];
    requestedShardCount: number | null;
    requestedShardLogDir: string | null;
} {
    const optionArgs: string[] = [];
    const fileTargets: string[] = [];
    let requestedShardCount: number | null = null;
    let requestedShardLogDir: string | null = null;
    let expectsOptionValue = false;
    let positionalOnly = false;

    for (let index = 0; index < forwardedArgs.length; index += 1) {
        const arg = forwardedArgs[index];
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

        if (arg === GARDA_SHARDS_OPTION || arg.startsWith(`${GARDA_SHARDS_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_SHARDS_OPTION);
            requestedShardCount = parsePositiveInteger(value, GARDA_SHARDS_OPTION);
            if (consumedNext) {
                index += 1;
            }
            continue;
        }

        if (arg === GARDA_SHARD_LOG_DIR_OPTION || arg.startsWith(`${GARDA_SHARD_LOG_DIR_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_SHARD_LOG_DIR_OPTION);
            requestedShardLogDir = value;
            if (consumedNext) {
                index += 1;
            }
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

    return { optionArgs, fileTargets, requestedShardCount, requestedShardLogDir };
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

function collectTestFilesUnderDir(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) {
        return [];
    }
    const stat = fs.statSync(dirPath);
    if (!stat.isDirectory()) {
        return [];
    }
    const results: string[] = [];
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const entryPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectTestFilesUnderDir(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            results.push(entryPath);
        }
    }
    return results.sort();
}

function resolveCompiledTestDirectoryTargets(
    buildResult: BuildResult,
    target: string
): string[] {
    const normalizedTarget = normalizeCliPath(target).replace(/^\.\//,  '');
    const repoRelativeTarget = normalizeCliPath(path.relative(buildResult.repoRoot, path.resolve(buildResult.repoRoot, target)));

    const dirCandidates = [normalizedTarget, repoRelativeTarget];
    for (const candidate of dirCandidates) {
        const strippedCandidate = candidate.replace(/^\.\//,  '');
        let compiledDirPath: string | null = null;
        if (strippedCandidate.startsWith('tests/node/')) {
            compiledDirPath = path.join(buildResult.buildRoot, ...strippedCandidate.split('/'));
        } else if (strippedCandidate.startsWith('.node-build/tests/node/')) {
            compiledDirPath = path.join(buildResult.repoRoot, ...strippedCandidate.split('/'));
        }
        if (compiledDirPath !== null) {
            const files = collectTestFilesUnderDir(compiledDirPath);
            if (files.length > 0) {
                return files;
            }
        }
    }
    return [];
}

function resolveCompiledTestTarget(
    buildResult: BuildResult,
    compiledTestLookup: Map<string, string>,
    target: string
): string | null {
    const normalizedTarget = normalizeCliPath(target).replace(/^\.\//,  '');
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
        const normalizedCandidate = candidate.replace(/^\.\//,  '');
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
        // First, try to expand as a directory target.
        const dirFiles = resolveCompiledTestDirectoryTargets(buildResult, fileTarget);
        if (dirFiles.length > 0) {
            for (const dirFile of dirFiles) {
                if (!seen.has(dirFile)) {
                    seen.add(dirFile);
                    selectedTestFiles.push(dirFile);
                }
            }
            continue;
        }

        // Fall back to single file resolution.
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

function estimateNodeTestArgChars(optionArgs: string[], selectedTestFiles: string[]): number {
    const args = [process.execPath, '--test', ...optionArgs, ...selectedTestFiles];
    return args.reduce((total, arg) => total + arg.length + 3, 0);
}

function resolveAutoShardCount(selectedTestFiles: string[], optionArgs: string[]): number {
    if (selectedTestFiles.length <= 1) {
        return 1;
    }
    const estimatedArgChars = estimateNodeTestArgChars(optionArgs, selectedTestFiles);
    if (estimatedArgChars <= NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT) {
        return 1;
    }
    return Math.max(2, Math.min(
        selectedTestFiles.length,
        Math.ceil(estimatedArgChars / NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT)
    ));
}

function resolveNodeFoundationShardCount(
    selectedTestFiles: string[],
    optionArgs: string[],
    _fileTargets: string[],
    requestedShardCount: number | null
): number {
    // Disable sharding only when an explicit --test-shard option is provided (manual shard selection).
    // Directory fileTargets expand to multiple files and should still benefit from GARDA_NODE_FOUNDATION_TEST_SHARDS.
    // Single-file targets still get shardCount=1 naturally since min(parsed, 1)=1.
    if (hasExplicitTestShardOption(optionArgs)) {
        return 1;
    }

    if (requestedShardCount !== null) {
        return Math.max(1, Math.min(requestedShardCount, selectedTestFiles.length));
    }

    const rawValue = String(process.env[NODE_FOUNDATION_TEST_SHARDS_ENV] || '').trim();
    if (!rawValue) {
        return resolveAutoShardCount(selectedTestFiles, optionArgs);
    }

    const parsed = parsePositiveInteger(rawValue, NODE_FOUNDATION_TEST_SHARDS_ENV);

    return Math.max(1, Math.min(parsed, selectedTestFiles.length));
}

function buildNodeFoundationTestShards(selectedTestFiles: string[], shardCount: number): string[][] {
    const fileWithSizes = selectedTestFiles.map((file) => {
        try {
            return { file, size: fs.statSync(file).size };
        } catch {
            return { file, size: 0 };
        }
    });

    // Sort files by size from heaviest to lightest
    fileWithSizes.sort((a, b) => b.size - a.size);

    const shards = Array.from({ length: shardCount }, () => ({
        files: [] as string[],
        totalSize: 0
    }));

    for (const item of fileWithSizes) {
        let minShardIndex = 0;
        let minSize = shards[0].totalSize;
        for (let i = 1; i < shardCount; i++) {
            if (shards[i].totalSize < minSize) {
                minSize = shards[i].totalSize;
                minShardIndex = i;
            }
        }
        shards[minShardIndex].files.push(item.file);
        shards[minShardIndex].totalSize += item.size;
    }

    return shards.map((s) => s.files).filter((files) => files.length > 0);
}

function runSingleNodeTestProcess(repoRoot: string, optionArgs: string[], selectedTestFiles: string[]): number {
    const result = childProcess.spawnSync(process.execPath, ['--test', ...optionArgs, ...selectedTestFiles], {
        cwd: repoRoot,
        stdio: 'inherit',
        windowsHide: true
    });
    return result.status == null ? 1 : result.status;
}

function resolveShardLogDir(repoRoot: string, buildRoot: string, requestedShardLogDir: string | null): string {
    const configuredLogDir = requestedShardLogDir || String(process.env[NODE_FOUNDATION_TEST_SHARD_LOG_DIR_ENV] || '').trim();
    if (configuredLogDir) {
        return path.resolve(repoRoot, configuredLogDir);
    }
    return path.join(buildRoot, 'test-shard-logs', `run-${process.pid}`);
}

function writeShardOutput(
    stream: NodeJS.ReadableStream | null | undefined,
    logStream: fs.WriteStream,
    consoleStream: NodeJS.WritableStream
): void {
    if (!stream) {
        return;
    }
    stream.on('data', (chunk: Buffer | string) => {
        logStream.write(chunk);
        consoleStream.write(chunk);
    });
}

function runNodeTestShard(
    repoRoot: string,
    optionArgs: string[],
    shardFiles: string[],
    shardIndex: number,
    shardCount: number,
    shardLogDir: string
): Promise<number> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(shardLogDir, { recursive: true });
        const logPath = path.join(shardLogDir, `shard-${String(shardIndex + 1).padStart(2, '0')}-of-${String(shardCount).padStart(2, '0')}.log`);
        const logStream = fs.createWriteStream(logPath, { flags: 'w' });
        console.log(`NODE_FOUNDATION_TEST_SHARD_START ${shardIndex + 1}/${shardCount} files=${shardFiles.length}`);
        console.log(`NODE_FOUNDATION_TEST_SHARD_LOG ${shardIndex + 1}/${shardCount} ${logPath}`);
        const child = childProcess.spawn(process.execPath, ['--test', ...optionArgs, ...shardFiles], {
            cwd: repoRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
        let exitCode = 1;
        writeShardOutput(child.stdout, logStream, process.stdout);
        writeShardOutput(child.stderr, logStream, process.stderr);
        child.once('error', (error) => {
            logStream.destroy();
            reject(error);
        });
        child.once('exit', (code) => {
            exitCode = code == null ? 1 : code;
        });
        child.once('close', () => {
            console.log(`NODE_FOUNDATION_TEST_SHARD_DONE ${shardIndex + 1}/${shardCount} exit=${exitCode}`);
            logStream.end(() => resolve(exitCode));
        });
    });
}

async function runShardedNodeTestProcesses(
    repoRoot: string,
    buildRoot: string,
    optionArgs: string[],
    selectedTestFiles: string[],
    shardCount: number,
    requestedShardLogDir: string | null
): Promise<number> {
    const shards = buildNodeFoundationTestShards(selectedTestFiles, shardCount);
    const shardLogDir = resolveShardLogDir(repoRoot, buildRoot, requestedShardLogDir);
    console.log(`NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${shardLogDir}`);
    const exitCodes = await Promise.all(shards.map((shardFiles, index) =>
        runNodeTestShard(repoRoot, optionArgs, shardFiles, index, shards.length, shardLogDir)
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
    const { optionArgs, fileTargets, requestedShardCount, requestedShardLogDir } = splitForwardedTestArgs(forwardedArgs);
    const selectedTestFiles = resolveSelectedTestFiles(buildResult, compiledTestFiles, fileTargets);

    if (compiledTestFiles.length === 0) {
        throw new Error('No Node foundation tests were found under .node-build/tests/node.');
    }

    const shardCount = resolveNodeFoundationShardCount(selectedTestFiles, optionArgs, fileTargets, requestedShardCount);
    const exitCode = shardCount === 1
        ? runSingleNodeTestProcess(repoRoot, optionArgs, selectedTestFiles)
        : await runShardedNodeTestProcesses(repoRoot, buildResult.buildRoot, optionArgs, selectedTestFiles, shardCount, requestedShardLogDir);

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
