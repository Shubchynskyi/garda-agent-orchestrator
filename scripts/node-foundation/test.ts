import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { buildNodeFoundation, buildPublishRuntime, getRepoRoot, BuildResult } from './build';

const NODE_FOUNDATION_TEST_SHARDS_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARDS';
const NODE_FOUNDATION_TEST_SHARD_LOG_DIR_ENV = 'GARDA_NODE_FOUNDATION_TEST_SHARD_LOG_DIR';
const NODE_FOUNDATION_TEST_DURATION_FILE_ENV = 'GARDA_NODE_FOUNDATION_TEST_DURATION_FILE';
const NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME_ENV = 'GARDA_NODE_FOUNDATION_REUSE_PUBLISH_RUNTIME';
const NODE_FOUNDATION_AUTO_SHARD_ARG_CHAR_LIMIT = 24_000;
const NODE_FOUNDATION_TEST_SLOWEST_REPORT_COUNT = 10;
const GARDA_SHARDS_OPTION = '--garda-shards';
const GARDA_SHARD_LOG_DIR_OPTION = '--garda-shard-log-dir';
const GARDA_DURATION_FILE_OPTION = '--garda-duration-file';

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
    requestedDurationFile: string | null;
} {
    const optionArgs: string[] = [];
    const fileTargets: string[] = [];
    let requestedShardCount: number | null = null;
    let requestedShardLogDir: string | null = null;
    let requestedDurationFile: string | null = null;
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

        if (arg === GARDA_DURATION_FILE_OPTION || arg.startsWith(`${GARDA_DURATION_FILE_OPTION}=`)) {
            const { value, consumedNext } = readOptionValue(forwardedArgs, index, GARDA_DURATION_FILE_OPTION);
            requestedDurationFile = value;
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

    return { optionArgs, fileTargets, requestedShardCount, requestedShardLogDir, requestedDurationFile };
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

interface TestDurationTelemetryEntry {
    file: string;
    duration_ms: number;
    samples: number;
    updated_at_utc: string;
}

interface TestDurationTelemetry {
    schema_version: 1;
    updated_at_utc: string;
    entries: Record<string, TestDurationTelemetryEntry>;
}

interface TestFileWeight {
    file: string;
    key: string;
    weight: number;
    durationMs: number | null;
    fallbackSize: number;
}

interface NodeTestShardResult {
    exitCode: number;
    durationMs: number;
    shardFiles: string[];
}

function resolveNodeFoundationRuntimeDir(repoRoot: string): string {
    const nestedRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
        return path.join(nestedRoot, 'runtime');
    }
    return path.join(repoRoot, 'runtime');
}

function resolveDurationTelemetryPath(repoRoot: string, requestedDurationFile: string | null): string {
    const configured = requestedDurationFile || String(process.env[NODE_FOUNDATION_TEST_DURATION_FILE_ENV] || '').trim();
    if (configured) {
        return path.resolve(repoRoot, configured);
    }
    return path.join(resolveNodeFoundationRuntimeDir(repoRoot), 'metrics', 'node-foundation-test-duration-telemetry.json');
}

function isTestDurationTelemetryEntry(value: unknown): value is TestDurationTelemetryEntry {
    return !!value
        && typeof value === 'object'
        && !Array.isArray(value)
        && typeof (value as TestDurationTelemetryEntry).file === 'string'
        && typeof (value as TestDurationTelemetryEntry).duration_ms === 'number'
        && Number.isFinite((value as TestDurationTelemetryEntry).duration_ms)
        && (value as TestDurationTelemetryEntry).duration_ms > 0
        && typeof (value as TestDurationTelemetryEntry).samples === 'number'
        && Number.isFinite((value as TestDurationTelemetryEntry).samples)
        && (value as TestDurationTelemetryEntry).samples > 0
        && typeof (value as TestDurationTelemetryEntry).updated_at_utc === 'string';
}

function readTestDurationTelemetry(telemetryPath: string): TestDurationTelemetry {
    const empty: TestDurationTelemetry = {
        schema_version: 1,
        updated_at_utc: new Date(0).toISOString(),
        entries: {}
    };
    if (!fs.existsSync(telemetryPath)) {
        return empty;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(telemetryPath, 'utf8')) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_IGNORED malformed ${telemetryPath}`);
            return empty;
        }
        const rawEntries = (parsed as { entries?: unknown }).entries;
        if (!rawEntries || typeof rawEntries !== 'object' || Array.isArray(rawEntries)) {
            console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_IGNORED malformed ${telemetryPath}`);
            return empty;
        }
        const entries: Record<string, TestDurationTelemetryEntry> = {};
        for (const [key, value] of Object.entries(rawEntries)) {
            if (!isTestDurationTelemetryEntry(value)) {
                continue;
            }
            entries[key] = {
                file: key,
                duration_ms: value.duration_ms,
                samples: Math.max(1, Math.trunc(value.samples)),
                updated_at_utc: value.updated_at_utc
            };
        }
        return {
            schema_version: 1,
            updated_at_utc: typeof (parsed as { updated_at_utc?: unknown }).updated_at_utc === 'string'
                ? String((parsed as { updated_at_utc?: unknown }).updated_at_utc)
                : new Date(0).toISOString(),
            entries
        };
    } catch {
        console.warn(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_IGNORED unreadable ${telemetryPath}`);
        return empty;
    }
}

function compiledTestFileToTelemetryKey(buildResult: BuildResult, file: string): string {
    const relativeToBuildRoot = normalizeCliPath(path.relative(buildResult.buildRoot, file));
    if (!relativeToBuildRoot.startsWith('../') && !relativeToBuildRoot.startsWith('..\\')) {
        return relativeToBuildRoot.replace(/\.js$/i, '.ts');
    }
    return normalizeCliPath(path.relative(buildResult.repoRoot, file)).replace(/\.js$/i, '.ts');
}

function buildTestFileWeights(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    telemetry: TestDurationTelemetry
): TestFileWeight[] {
    return selectedTestFiles.map((file) => {
        const key = compiledTestFileToTelemetryKey(buildResult, file);
        const entry = telemetry.entries[key];
        let fallbackSize = 1;
        try {
            fallbackSize = Math.max(1, fs.statSync(file).size);
        } catch {
            fallbackSize = 1;
        }
        const durationMs = entry && Number.isFinite(entry.duration_ms) && entry.duration_ms > 0
            ? entry.duration_ms
            : null;
        return {
            file,
            key,
            weight: durationMs ?? fallbackSize,
            durationMs,
            fallbackSize
        };
    });
}

function printSlowestKnownTests(fileWeights: TestFileWeight[]): void {
    const slowest = fileWeights
        .filter((item) => item.durationMs !== null)
        .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0) || a.key.localeCompare(b.key))
        .slice(0, NODE_FOUNDATION_TEST_SLOWEST_REPORT_COUNT);
    if (slowest.length === 0) {
        console.log('NODE_FOUNDATION_TEST_SLOWEST none');
        return;
    }
    for (const item of slowest) {
        console.log(`NODE_FOUNDATION_TEST_SLOWEST ${item.key} duration_ms=${Math.trunc(item.durationMs ?? 0)}`);
    }
}

function buildNodeFoundationTestShards(
    buildResult: BuildResult,
    selectedTestFiles: string[],
    shardCount: number,
    telemetry: TestDurationTelemetry
): string[][] {
    const fileWeights = buildTestFileWeights(buildResult, selectedTestFiles, telemetry);
    const knownDurationCount = fileWeights.filter((item) => item.durationMs !== null).length;

    fileWeights.sort((a, b) => b.weight - a.weight || a.key.localeCompare(b.key));

    const shards = Array.from({ length: shardCount }, () => ({
        files: [] as string[],
        totalWeight: 0
    }));

    for (const item of fileWeights) {
        let minShardIndex = 0;
        let minWeight = shards[0].totalWeight;
        for (let i = 1; i < shardCount; i++) {
            if (shards[i].totalWeight < minWeight) {
                minWeight = shards[i].totalWeight;
                minShardIndex = i;
            }
        }
        shards[minShardIndex].files.push(item.file);
        shards[minShardIndex].totalWeight += item.weight;
    }

    const source = knownDurationCount === 0
        ? 'size_fallback'
        : knownDurationCount === fileWeights.length
            ? 'duration'
            : 'duration_with_size_fallback';
    console.log(`NODE_FOUNDATION_TEST_SHARD_PLAN source=${source} duration_known=${knownDurationCount}/${fileWeights.length}`);
    printSlowestKnownTests(fileWeights);

    return shards.map((s) => s.files).filter((files) => files.length > 0);
}

function recordTestDurationTelemetry(
    telemetryPath: string,
    telemetry: TestDurationTelemetry,
    buildResult: BuildResult,
    results: NodeTestShardResult[]
): void {
    const measurableResults = results.filter((result) => result.exitCode === 0 && result.shardFiles.length === 1);
    if (measurableResults.length === 0) {
        return;
    }
    const updatedAt = new Date().toISOString();
    const nextEntries = { ...telemetry.entries };
    for (const result of measurableResults) {
        const key = compiledTestFileToTelemetryKey(buildResult, result.shardFiles[0]);
        const previous = nextEntries[key];
        const previousSamples = previous ? Math.max(1, Math.trunc(previous.samples)) : 0;
        const nextSamples = Math.min(previousSamples + 1, 20);
        const previousWeight = Math.min(previousSamples, 19);
        const durationMs = Math.max(1, Math.trunc(result.durationMs));
        const averagedDuration = previous
            ? Math.round(((previous.duration_ms * previousWeight) + durationMs) / (previousWeight + 1))
            : durationMs;
        nextEntries[key] = {
            file: key,
            duration_ms: averagedDuration,
            samples: nextSamples,
            updated_at_utc: updatedAt
        };
    }
    const nextTelemetry: TestDurationTelemetry = {
        schema_version: 1,
        updated_at_utc: updatedAt,
        entries: Object.fromEntries(Object.entries(nextEntries).sort(([a], [b]) => a.localeCompare(b)))
    };
    fs.mkdirSync(path.dirname(telemetryPath), { recursive: true });
    fs.writeFileSync(telemetryPath, `${JSON.stringify(nextTelemetry, null, 2)}\n`, 'utf8');
    console.log(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY_UPDATED ${telemetryPath} entries=${Object.keys(nextTelemetry.entries).length}`);
}

function runSingleNodeTestProcess(
    repoRoot: string,
    buildResult: BuildResult,
    optionArgs: string[],
    selectedTestFiles: string[],
    telemetryPath: string,
    telemetry: TestDurationTelemetry
): number {
    const startedAt = Date.now();
    const result = childProcess.spawnSync(process.execPath, ['--test', ...optionArgs, ...selectedTestFiles], {
        cwd: repoRoot,
        stdio: 'inherit',
        windowsHide: true
    });
    const exitCode = result.status == null ? 1 : result.status;
    recordTestDurationTelemetry(telemetryPath, telemetry, buildResult, [{
        exitCode,
        durationMs: Math.max(1, Date.now() - startedAt),
        shardFiles: selectedTestFiles
    }]);
    return exitCode;
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
): Promise<NodeTestShardResult> {
    return new Promise((resolve, reject) => {
        fs.mkdirSync(shardLogDir, { recursive: true });
        const logPath = path.join(shardLogDir, `shard-${String(shardIndex + 1).padStart(2, '0')}-of-${String(shardCount).padStart(2, '0')}.log`);
        const logStream = fs.createWriteStream(logPath, { flags: 'w' });
        const startedAt = Date.now();
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
            const durationMs = Math.max(1, Date.now() - startedAt);
            console.log(`NODE_FOUNDATION_TEST_SHARD_DONE ${shardIndex + 1}/${shardCount} exit=${exitCode} duration_ms=${durationMs}`);
            logStream.end(() => resolve({ exitCode, durationMs, shardFiles }));
        });
    });
}

async function runShardedNodeTestProcesses(
    repoRoot: string,
    buildResult: BuildResult,
    buildRoot: string,
    optionArgs: string[],
    selectedTestFiles: string[],
    shardCount: number,
    requestedShardLogDir: string | null,
    telemetryPath: string,
    telemetry: TestDurationTelemetry
): Promise<number> {
    const shards = buildNodeFoundationTestShards(buildResult, selectedTestFiles, shardCount, telemetry);
    const shardLogDir = resolveShardLogDir(repoRoot, buildRoot, requestedShardLogDir);
    console.log(`NODE_FOUNDATION_TEST_SHARD_LOG_DIR ${shardLogDir}`);
    console.log(`NODE_FOUNDATION_TEST_DURATION_TELEMETRY ${telemetryPath}`);
    const results = await Promise.all(shards.map((shardFiles, index) =>
        runNodeTestShard(repoRoot, optionArgs, shardFiles, index, shards.length, shardLogDir)
    ));
    recordTestDurationTelemetry(telemetryPath, telemetry, buildResult, results);
    return results.find((result) => result.exitCode !== 0)?.exitCode || 0;
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
    const {
        optionArgs,
        fileTargets,
        requestedShardCount,
        requestedShardLogDir,
        requestedDurationFile
    } = splitForwardedTestArgs(forwardedArgs);
    const selectedTestFiles = resolveSelectedTestFiles(buildResult, compiledTestFiles, fileTargets);
    const telemetryPath = resolveDurationTelemetryPath(buildResult.repoRoot, requestedDurationFile);
    const telemetry = readTestDurationTelemetry(telemetryPath);

    if (compiledTestFiles.length === 0) {
        throw new Error('No Node foundation tests were found under .node-build/tests/node.');
    }

    const shardCount = resolveNodeFoundationShardCount(selectedTestFiles, optionArgs, fileTargets, requestedShardCount);
    const exitCode = shardCount === 1
        ? runSingleNodeTestProcess(repoRoot, buildResult, optionArgs, selectedTestFiles, telemetryPath, telemetry)
        : await runShardedNodeTestProcesses(
            repoRoot,
            buildResult,
            buildResult.buildRoot,
            optionArgs,
            selectedTestFiles,
            shardCount,
            requestedShardLogDir,
            telemetryPath,
            telemetry
        );

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
