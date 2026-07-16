import * as fs from 'node:fs';
import * as path from 'node:path';

import { PRODUCT_NAME } from './launcher-constants';
import { looksLikeSourceCheckout } from './root-discovery';

export interface CliMainModule {
    runCliMainWithHandling: (argv?: string[], packageRoot?: string) => Promise<void>;
}

export interface RuntimeCandidateAssessment {
    readonly runtimeRoot: string;
    readonly ready: boolean;
    readonly reason: string;
    readonly diagnostics: readonly string[];
}

const RUNTIME_LOAD_LOCK_TIMEOUT_ENV = 'GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS';
const RUNTIME_LOAD_LOCK_POLL_MS = 50;
const RUNTIME_LOAD_RETRY_DELAY_MS = 50;
const RUNTIME_LOAD_MAX_ATTEMPTS = 3;
const RUNTIME_LANGUAGE_PACK_PATTERN = /^garda-ui-(.+)\.json$/u;
const SOURCE_CHECKOUT_RUNTIME_REQUIRED_FILES = Object.freeze([
    'index.js',
    path.join('cli', 'main.js'),
    path.join('cli', 'runtime-main.js'),
    path.join('cli', 'commands', 'command-dispatch.js'),
    path.join('cli', 'commands', 'cli-help-output.js'),
    path.join('reports', 'ui', 'ui-i18n.js'),
    path.join('reports', 'ui', 'ui-language-pack-loader.js')
]);

function hasRuntimeRoot(runtimeRoot: string): boolean {
    return fs.existsSync(path.join(runtimeRoot, 'index.js'));
}

function isFile(filePath: string): boolean {
    try {
        return fs.statSync(filePath).isFile();
    } catch {
        return false;
    }
}

function isDirectory(directoryPath: string): boolean {
    try {
        return fs.statSync(directoryPath).isDirectory();
    } catch {
        return false;
    }
}

function isRecoverableLoadError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'MODULE_NOT_FOUND' || code === 'ENOENT';
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepSync(milliseconds: number): void {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function getRuntimeBuildLockPath(runtimeRoot: string): string {
    return `${path.dirname(runtimeRoot)}.lock`;
}

function computeDeadline(timeoutMs: number): number {
    return Date.now() + timeoutMs;
}

function getRemainingMilliseconds(deadline: number): number {
    return Math.max(0, deadline - Date.now());
}

function waitForRuntimeBuildLock(runtimeRoot: string, deadline: number): boolean {
    const lockPath = getRuntimeBuildLockPath(runtimeRoot);
    if (!fs.existsSync(lockPath)) {
        return false;
    }

    while (fs.existsSync(lockPath)) {
        const remainingMs = getRemainingMilliseconds(deadline);
        if (remainingMs <= 0) {
            throw new Error(
                `Timed out waiting for ${PRODUCT_NAME} runtime build lock to clear: ${lockPath}`
            );
        }
        sleepSync(Math.min(RUNTIME_LOAD_LOCK_POLL_MS, remainingMs));
    }

    return true;
}

function clearRuntimeRequireCache(runtimeRoot: string): void {
    const normalizedRoot = path.resolve(runtimeRoot) + path.sep;
    for (const cachedPath of Object.keys(require.cache)) {
        if (path.resolve(cachedPath).startsWith(normalizedRoot)) {
            delete require.cache[cachedPath];
        }
    }
}

function getRuntimeManifestPath(runtimeRoot: string): string {
    const buildRoot = path.dirname(runtimeRoot);
    const buildRootName = path.basename(buildRoot);
    return path.join(
        buildRoot,
        buildRootName === '.node-build' ? 'node-foundation-manifest.json' : 'publish-runtime-manifest.json'
    );
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function assessRuntimeManifest(runtimeRoot: string): string[] {
    const manifestPath = getRuntimeManifestPath(runtimeRoot);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }

    const manifest = readJsonObject(manifestPath);
    if (!manifest || !Array.isArray(manifest.files)) {
        return [`Runtime manifest is malformed: ${manifestPath}`];
    }

    const buildRoot = path.dirname(runtimeRoot);
    const missingFiles = manifest.files
        .filter((relativePath): relativePath is string => typeof relativePath === 'string')
        .filter((relativePath) => !isFile(path.join(buildRoot, ...relativePath.split('/'))));

    return missingFiles.slice(0, 8).map((relativePath) => (
        `Runtime manifest lists missing file: ${relativePath}`
    ));
}

function readLanguagePack(filePath: string): { languageId: string; textKeys: string[] } | string {
    const parsed = readJsonObject(filePath);
    if (!parsed) {
        return `UI language pack is malformed JSON/object: ${filePath}`;
    }

    const language = parsed.language;
    if (language == null || typeof language !== 'object' || Array.isArray(language)) {
        return `UI language pack is missing language metadata: ${filePath}`;
    }

    const languageId = (language as Record<string, unknown>).id;
    if (typeof languageId !== 'string' || languageId.trim() === '') {
        return `UI language pack is missing language.id: ${filePath}`;
    }

    const localText = parsed.LOCAL_UI_TEXT;
    if (localText == null || typeof localText !== 'object' || Array.isArray(localText)) {
        return `UI language pack is missing LOCAL_UI_TEXT: ${filePath}`;
    }

    return {
        languageId,
        textKeys: Object.keys(localText).sort()
    };
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assessRuntimeLanguagePacks(runtimeRoot: string): string[] {
    const directory = path.join(runtimeRoot, 'reports', 'ui', 'lang-packs');
    if (!isDirectory(directory)) {
        return [`UI language packs directory is missing: ${directory}`];
    }

    const packFiles = fs.readdirSync(directory)
        .filter((fileName) => RUNTIME_LANGUAGE_PACK_PATTERN.test(fileName))
        .sort();
    if (packFiles.length === 0) {
        return [`UI language packs directory has no garda-ui-*.json files: ${directory}`];
    }

    const diagnostics: string[] = [];
    let referenceTextKeys: string[] | null = null;

    for (const fileName of packFiles) {
        const filePath = path.join(directory, fileName);
        const match = RUNTIME_LANGUAGE_PACK_PATTERN.exec(fileName);
        const languageId = match ? match[1] : '';
        const pack = readLanguagePack(filePath);
        if (typeof pack === 'string') {
            diagnostics.push(pack);
            continue;
        }
        if (pack.languageId !== languageId) {
            diagnostics.push(
                `UI language pack id mismatch in ${filePath}: filename=${languageId}, language.id=${pack.languageId}`
            );
        }
        if (referenceTextKeys === null) {
            referenceTextKeys = pack.textKeys;
        } else if (!sameStringList(referenceTextKeys, pack.textKeys)) {
            diagnostics.push(`UI language pack text keys differ from sibling packs: ${filePath}`);
        }
    }

    return diagnostics;
}

export function assessRuntimeCandidate(runtimeRoot: string): RuntimeCandidateAssessment {
    const missingRequiredFiles = SOURCE_CHECKOUT_RUNTIME_REQUIRED_FILES
        .filter((relativePath) => !isFile(path.join(runtimeRoot, relativePath)))
        .map((relativePath) => `Runtime required file is missing: ${relativePath}`);
    const diagnostics = [
        ...missingRequiredFiles,
        ...assessRuntimeManifest(runtimeRoot),
        ...assessRuntimeLanguagePacks(runtimeRoot)
    ];

    return {
        runtimeRoot,
        ready: diagnostics.length === 0,
        reason: diagnostics.length === 0 ? 'ready' : 'incomplete_source_checkout_runtime',
        diagnostics
    };
}

function buildLoadErrorAssessment(runtimeRoot: string, error: unknown): RuntimeCandidateAssessment {
    return {
        runtimeRoot,
        ready: false,
        reason: 'recoverable_runtime_load_error',
        diagnostics: [
            error instanceof Error ? error.message : String(error)
        ]
    };
}

function describeRuntimeCandidate(packageRoot: string, assessment: RuntimeCandidateAssessment): string {
    const relativeRoot = path.relative(packageRoot, assessment.runtimeRoot).split(path.sep).join('/') || '.';
    const diagnostics = assessment.diagnostics.slice(0, 3).join('; ');
    return `- ${relativeRoot}: ${assessment.reason}${diagnostics ? ` (${diagnostics})` : ''}`;
}

export function buildRuntimeBootstrapRemediationText(
    packageRoot: string,
    assessments: readonly RuntimeCandidateAssessment[]
): string {
    const uniqueByRoot = new Map<string, RuntimeCandidateAssessment>();
    for (const assessment of assessments) {
        uniqueByRoot.set(assessment.runtimeRoot, assessment);
    }
    const diagnosticLines = Array.from(uniqueByRoot.values())
        .slice(0, 6)
        .map((assessment) => describeRuntimeCandidate(packageRoot, assessment));

    return [
        `${PRODUCT_NAME} runtime bootstrap failed.`,
        `No usable generated runtime candidate was found for source checkout: ${packageRoot}`,
        ...(diagnosticLines.length > 0 ? ['Candidate diagnostics:', ...diagnosticLines] : []),
        'Remediation: run "npm run build" from the source checkout, then retry the command.',
        'If a build is already running, wait for dist.lock or .node-build.lock to clear and retry.'
    ].join('\n');
}

function exitWithRuntimeBootstrapRemediation(
    packageRoot: string,
    assessments: readonly RuntimeCandidateAssessment[]
): never {
    console.error(buildRuntimeBootstrapRemediationText(packageRoot, assessments));
    process.exit(1);
}

export function getRuntimeCandidates(packageRoot: string): string[] {
    const devBuildRuntimeRoot = path.join(packageRoot, '.node-build', 'src');
    const publishRuntimeRoot = path.join(packageRoot, 'dist', 'src');
    const candidates: string[] = [];

    if (hasRuntimeRoot(publishRuntimeRoot)) {
        candidates.push(publishRuntimeRoot);
    }

    if (looksLikeSourceCheckout(packageRoot) && hasRuntimeRoot(devBuildRuntimeRoot)) {
        candidates.push(devBuildRuntimeRoot);
    }

    return candidates;
}

export function loadCliMainModule(packageRoot: string): CliMainModule {
    const sourceCheckout = looksLikeSourceCheckout(packageRoot);
    const runtimeCandidates = getRuntimeCandidates(packageRoot);
    if (runtimeCandidates.length === 0) {
        if (sourceCheckout) {
            exitWithRuntimeBootstrapRemediation(packageRoot, []);
        }
        console.error(
            `${PRODUCT_NAME} runtime build output not found.\n`
            + 'Run "npm run build" to compile TypeScript sources before execution.'
        );
        process.exit(1);
    }

    let lastError: unknown = null;
    const sourceCheckoutAssessments: RuntimeCandidateAssessment[] = [];

    for (let index = 0; index < runtimeCandidates.length; index += 1) {
        const runtimeRoot = runtimeCandidates[index];
        const runtimeLoadDeadline = computeDeadline(
            parsePositiveInteger(process.env[RUNTIME_LOAD_LOCK_TIMEOUT_ENV], 120_000)
        );
        for (let attempt = 0; attempt < RUNTIME_LOAD_MAX_ATTEMPTS; attempt += 1) {
            waitForRuntimeBuildLock(runtimeRoot, runtimeLoadDeadline);
            if (sourceCheckout) {
                const assessment = assessRuntimeCandidate(runtimeRoot);
                if (!assessment.ready) {
                    sourceCheckoutAssessments.push(assessment);
                    clearRuntimeRequireCache(runtimeRoot);
                    if (attempt < RUNTIME_LOAD_MAX_ATTEMPTS - 1) {
                        const remainingMs = getRemainingMilliseconds(runtimeLoadDeadline);
                        if (remainingMs <= 0) {
                            break;
                        }
                        sleepSync(Math.min(RUNTIME_LOAD_RETRY_DELAY_MS, remainingMs));
                        continue;
                    }
                    break;
                }
            }
            try {
                return require(path.join(runtimeRoot, 'cli', 'main.js')) as CliMainModule;
            } catch (error: unknown) {
                lastError = error;
                const recoverable = isRecoverableLoadError(error);
                const hasFallback = index < runtimeCandidates.length - 1;
                if (!recoverable) {
                    throw error;
                }
                if (sourceCheckout) {
                    sourceCheckoutAssessments.push(buildLoadErrorAssessment(runtimeRoot, error));
                }
                clearRuntimeRequireCache(runtimeRoot);
                if (attempt < RUNTIME_LOAD_MAX_ATTEMPTS - 1) {
                    waitForRuntimeBuildLock(runtimeRoot, runtimeLoadDeadline);
                    const remainingMs = getRemainingMilliseconds(runtimeLoadDeadline);
                    if (remainingMs <= 0) {
                        if (hasFallback) {
                            break;
                        }
                        throw error;
                    }
                    sleepSync(Math.min(RUNTIME_LOAD_RETRY_DELAY_MS, remainingMs));
                    continue;
                }
                if (!hasFallback) {
                    if (sourceCheckout) {
                        exitWithRuntimeBootstrapRemediation(packageRoot, sourceCheckoutAssessments);
                    }
                    throw error;
                }
                break;
            }
        }
    }

    if (sourceCheckout) {
        exitWithRuntimeBootstrapRemediation(packageRoot, sourceCheckoutAssessments);
    }
    throw lastError;
}
