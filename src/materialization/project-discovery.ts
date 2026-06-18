import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../core/filesystem';
import { normalizeRelativePath } from '../core/paths';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';
import {
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
    resolveBundleName
} from '../core/constants';

interface StackSignal {
    name: string;
    pattern: RegExp;
}

interface StackEvidence {
    name: string;
    matches: string[];
}

export interface ProjectDiscovery {
    source: string;
    fileCount: number;
    diagnostics: string[];
    detectedStacks: string[];
    stackEvidence: StackEvidence[];
    topLevelDirectories: string[];
    rootFiles: string[];
    runtimePathHints: string[];
    suggestedCommands: string[];
    suggestedCompileGateCommands: string[];
    suggestedFullSuiteValidationCommand: string | null;
    relativeFiles: string[];
    sampleFiles: string[];
}

const _BASE_EXCLUDED_PATH_FRAGMENTS = Object.freeze([
    '/.git/', '/node_modules/', '/.next/', '/dist/', '/build/',
    '/target/', '/bin/', '/obj/', '/runtime/'
]);

export function getExcludedPathFragments(): readonly string[] {
    return [..._BASE_EXCLUDED_PATH_FRAGMENTS, `/${resolveBundleName()}/`];
}

export const STACK_SIGNALS: readonly StackSignal[] = Object.freeze([
    { name: 'Node.js or JavaScript', pattern: /(^|\/)package\.json$/ },
    { name: 'TypeScript', pattern: /(^|\/)tsconfig(\.[^/]+)?\.json$/ },
    { name: 'Java or JVM', pattern: /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?)$/ },
    { name: 'Python', pattern: /(^|\/)(?:pyproject\.toml|requirements(?:\.txt|-dev\.txt)?)$/ },
    { name: 'Go', pattern: /(^|\/)go\.mod$/ },
    { name: 'Rust', pattern: /(^|\/)Cargo\.toml$/ },
    { name: '.NET', pattern: /\.(sln|csproj|fsproj)$/ },
    { name: 'PHP', pattern: /(^|\/)composer\.json$/ },
    { name: 'Ruby', pattern: /(^|\/)Gemfile$/ },
    { name: 'Containerization', pattern: /(^|\/)Dockerfile(\..+)?$|(^|\/)docker-compose(\.[^/]+)?\.ya?ml$/ }
]);

const _STATIC_EXCLUDED_TOP_LEVEL_DIRS = ['.git', 'node_modules', 'dist', 'build', 'target', 'bin', 'obj', 'runtime'];

const DEFAULT_FALLBACK_SCAN_MAX_FILES = 10000;
const DEFAULT_FALLBACK_SCAN_MAX_DIRECTORIES = 2000;
const DEFAULT_FALLBACK_SCAN_MAX_ELAPSED_MS = 5000;

export interface ProjectDiscoveryOptions {
    fallbackScanMaxFiles?: number;
    fallbackScanMaxDirectories?: number;
    fallbackScanMaxElapsedMs?: number;
}

interface FallbackScanResult {
    files: string[];
    diagnostics: string[];
}

export function getExcludedTopLevelDirs(): Set<string> {
    return new Set([resolveBundleName(), ..._STATIC_EXCLUDED_TOP_LEVEL_DIRS]);
}

function normalizePositiveInteger(value: number | undefined, fallback: number): number {
    return Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isExcludedDiscoveryRelativePath(relativePath: string): boolean {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized) {
        return false;
    }
    const wrapped = `/${normalized}/`;
    return getExcludedPathFragments().some((fragment) => wrapped.includes(fragment));
}

function readRootPackageJsonSafe(targetRoot: string): Record<string, unknown> | null {
    const packageJsonPath = path.join(targetRoot, 'package.json');
    if (!pathExists(packageJsonPath)) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function detectNodePackageManager(targetRoot: string, packageJson: Record<string, unknown> | null): 'npm' | 'pnpm' | 'yarn' | 'bun' {
    const packageManagerField = String(packageJson?.packageManager || '').trim().toLowerCase();
    if (packageManagerField.startsWith('pnpm@')) return 'pnpm';
    if (packageManagerField.startsWith('yarn@')) return 'yarn';
    if (packageManagerField.startsWith('bun@')) return 'bun';
    if (packageManagerField.startsWith('npm@')) return 'npm';

    if (pathExists(path.join(targetRoot, 'pnpm-lock.yaml')) || pathExists(path.join(targetRoot, 'pnpm-workspace.yaml'))) {
        return 'pnpm';
    }
    if (pathExists(path.join(targetRoot, 'yarn.lock'))) {
        return 'yarn';
    }
    if (pathExists(path.join(targetRoot, 'bun.lock')) || pathExists(path.join(targetRoot, 'bun.lockb'))) {
        return 'bun';
    }
    if (pathExists(path.join(targetRoot, 'package-lock.json')) || pathExists(path.join(targetRoot, 'npm-shrinkwrap.json'))) {
        return 'npm';
    }

    return 'npm';
}

function getPackageJsonScripts(packageJson: Record<string, unknown> | null): Record<string, unknown> {
    if (!packageJson || typeof packageJson.scripts !== 'object' || Array.isArray(packageJson.scripts) || packageJson.scripts === null) {
        return {};
    }
    return packageJson.scripts as Record<string, unknown>;
}

function resolveNodeCompileGateCommands(targetRoot: string): string[] {
    if (!pathExists(path.join(targetRoot, 'package.json'))) {
        return [];
    }

    const packageJson = readRootPackageJsonSafe(targetRoot);
    const runner = detectNodePackageManager(targetRoot, packageJson);
    const scripts = getPackageJsonScripts(packageJson);
    const preferredScripts = ['build', 'compile', 'typecheck', 'type-check'];
    const commands = preferredScripts
        .filter((scriptName) => typeof scripts[scriptName] === 'string')
        .map((scriptName) => `${runner} run ${scriptName}`);
    return commands;
}

function resolveNodeFullSuiteValidationCommand(targetRoot: string): string | null {
    if (!pathExists(path.join(targetRoot, 'package.json'))) {
        return null;
    }

    const packageJson = readRootPackageJsonSafe(targetRoot);
    const runner = detectNodePackageManager(targetRoot, packageJson);
    return `${runner} test`;
}

function hasAnyRootFile(targetRoot: string, candidates: readonly string[]): boolean {
    return candidates.some((candidate) => pathExists(path.join(targetRoot, candidate)));
}

function hasAnyRootFileByExtension(targetRoot: string, extensions: readonly string[]): boolean {
    try {
        const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
        return entries.some((entry) => (
            entry.isFile()
            && extensions.some((extension) => entry.name.toLowerCase().endsWith(extension))
        ));
    } catch {
        return false;
    }
}

function resolveJvmWrapperCommand(options: {
    targetRoot: string;
    wrapperName: string;
    windowsWrapperName: string;
    fallbackCommand: string;
    runtimePlatform: NodeJS.Platform;
    taskName: string;
}): string {
    const { targetRoot, wrapperName, windowsWrapperName, fallbackCommand, runtimePlatform, taskName } = options;
    const posixWrapperExists = pathExists(path.join(targetRoot, wrapperName));
    const windowsWrapperExists = pathExists(path.join(targetRoot, windowsWrapperName));

    if (runtimePlatform === 'win32') {
        if (windowsWrapperExists) {
            return `.\\${windowsWrapperName} ${taskName}`;
        }
        if (posixWrapperExists) {
            return `./${wrapperName} ${taskName}`;
        }
        return fallbackCommand;
    }

    if (posixWrapperExists) {
        return `./${wrapperName} ${taskName}`;
    }

    return fallbackCommand;
}

function resolveJvmWrapperTestCommand(options: {
    targetRoot: string;
    wrapperName: string;
    windowsWrapperName: string;
    fallbackCommand: string;
    runtimePlatform: NodeJS.Platform;
}): string {
    return resolveJvmWrapperCommand({ ...options, taskName: 'test' });
}

export function resolveSuggestedCompileGateCommands(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform = process.platform
): string[] {
    const normalizedTargetRoot = path.resolve(targetRoot);
    const commands: string[] = [];

    commands.push(...resolveNodeCompileGateCommands(normalizedTargetRoot));

    if (hasAnyRootFile(normalizedTargetRoot, ['tsconfig.json'])) {
        commands.push('npx tsc --noEmit');
    }

    if (hasAnyRootFile(normalizedTargetRoot, ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])) {
        commands.push('python -m compileall .');
    }

    if (pathExists(path.join(normalizedTargetRoot, 'pom.xml'))) {
        commands.push(resolveJvmWrapperCommand({
            targetRoot: normalizedTargetRoot,
            wrapperName: 'mvnw',
            windowsWrapperName: 'mvnw.cmd',
            fallbackCommand: 'mvn compile',
            runtimePlatform,
            taskName: 'compile'
        }));
    }

    if (hasAnyRootFile(normalizedTargetRoot, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
        commands.push(resolveJvmWrapperCommand({
            targetRoot: normalizedTargetRoot,
            wrapperName: 'gradlew',
            windowsWrapperName: 'gradlew.bat',
            fallbackCommand: 'gradle assemble',
            runtimePlatform,
            taskName: 'assemble'
        }));
    }

    if (pathExists(path.join(normalizedTargetRoot, 'go.mod'))) {
        commands.push('go build ./...');
    }

    if (pathExists(path.join(normalizedTargetRoot, 'Cargo.toml'))) {
        commands.push('cargo check');
    }

    if (hasAnyRootFileByExtension(normalizedTargetRoot, ['.sln', '.csproj', '.fsproj'])) {
        commands.push('dotnet build');
    }

    return [...new Set(commands)].sort();
}

export function resolveSuggestedFullSuiteValidationCommand(
    targetRoot: string,
    runtimePlatform: NodeJS.Platform = process.platform
): string | null {
    const normalizedTargetRoot = path.resolve(targetRoot);

    const nodeCommand = resolveNodeFullSuiteValidationCommand(normalizedTargetRoot);
    if (nodeCommand) {
        return nodeCommand;
    }

    if (hasAnyRootFile(normalizedTargetRoot, ['pyproject.toml', 'requirements.txt', 'requirements-dev.txt'])) {
        return 'pytest';
    }

    if (pathExists(path.join(normalizedTargetRoot, 'pom.xml'))) {
        if (hasAnyRootFile(normalizedTargetRoot, ['mvnw', 'mvnw.cmd'])) {
            return resolveJvmWrapperTestCommand({
                targetRoot: normalizedTargetRoot,
                wrapperName: 'mvnw',
                windowsWrapperName: 'mvnw.cmd',
                fallbackCommand: 'mvn test',
                runtimePlatform
            });
        }
        return 'mvn test';
    }

    if (hasAnyRootFile(normalizedTargetRoot, ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'])) {
        if (hasAnyRootFile(normalizedTargetRoot, ['gradlew', 'gradlew.bat'])) {
            return resolveJvmWrapperTestCommand({
                targetRoot: normalizedTargetRoot,
                wrapperName: 'gradlew',
                windowsWrapperName: 'gradlew.bat',
                fallbackCommand: 'gradle test',
                runtimePlatform
            });
        }
        return 'gradle test';
    }

    if (pathExists(path.join(normalizedTargetRoot, 'go.mod'))) {
        return 'go test ./...';
    }

    if (pathExists(path.join(normalizedTargetRoot, 'Cargo.toml'))) {
        return 'cargo test';
    }

    if (hasAnyRootFileByExtension(normalizedTargetRoot, ['.sln', '.csproj', '.fsproj'])) {
        return 'dotnet test';
    }

    return null;
}

export function getProjectDiscovery(targetRoot: string, options: ProjectDiscoveryOptions = {}): ProjectDiscovery {
    let relativeFiles: string[] = [];
    let discoverySource = 'filesystem_scan';
    const diagnostics: string[] = [];

    try {
        const gitDir = path.join(targetRoot, '.git');
        if (pathExists(gitDir)) {
            const tracked = spawnSyncWithTimeout('git', ['ls-files'], {
                cwd: targetRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
                timeoutMs: DEFAULT_GIT_TIMEOUT_MS
            });
            const untracked = spawnSyncWithTimeout('git', ['ls-files', '--others', '--exclude-standard'], {
                cwd: targetRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
                timeoutMs: DEFAULT_GIT_TIMEOUT_MS
            });

            if (tracked.status === 0 && untracked.status === 0) {
                const trackedFiles = (tracked.stdout || '').split('\n').filter((l: string) => l.trim());
                const untrackedFiles = (untracked.stdout || '').split('\n').filter((l: string) => l.trim());
                relativeFiles = [...new Set([...trackedFiles, ...untrackedFiles])].sort();
                discoverySource = 'git_index_and_worktree';
            } else {
                diagnostics.push('Git discovery failed; using bounded filesystem fallback scan.');
            }
        }
    } catch {
        diagnostics.push('Git discovery failed; using bounded filesystem fallback scan.');
    }

    if (relativeFiles.length === 0) {
        const scanResult = collectFilesRecursive(targetRoot, targetRoot, options);
        relativeFiles = scanResult.files;
        diagnostics.push(...scanResult.diagnostics);
    }

    const filteredFiles: string[] = relativeFiles
        .map((f: string) => normalizeRelativePath(f))
        .filter((f: string) => f && !isExcludedDiscoveryRelativePath(f));
    const uniqueFiles: string[] = [...new Set(filteredFiles)].sort();

    const detectedStacks: string[] = [];
    const stackEvidence: StackEvidence[] = [];
    for (const signal of STACK_SIGNALS) {
        const matches = uniqueFiles.filter((f: string) => signal.pattern.test(f)).slice(0, 8);
        if (matches.length > 0) {
            detectedStacks.push(signal.name);
            stackEvidence.push({
                name: signal.name,
                matches
            });
        }
    }

    let topLevelDirectories: string[] = [];
    try {
        const entries = fs.readdirSync(targetRoot, { withFileTypes: true });
        topLevelDirectories = entries
            .filter((e) => e.isDirectory() && !getExcludedTopLevelDirs().has(e.name))
            .map((e) => e.name)
            .sort();
    } catch {
        // Ignore
    }

    const suggestedCommands: string[] = [];
    if (detectedStacks.includes('Node.js or JavaScript')) {
        suggestedCommands.push('npm run test', 'npm run lint', 'npm run build');
    }
    if (detectedStacks.includes('Python')) {
        suggestedCommands.push('pytest', 'ruff check .');
    }
    if (detectedStacks.includes('Java or JVM')) {
        suggestedCommands.push('./mvnw test', './gradlew test');
    }
    if (detectedStacks.includes('Go')) {
        suggestedCommands.push('go test ./...');
    }
    if (detectedStacks.includes('Rust')) {
        suggestedCommands.push('cargo test');
    }
    if (detectedStacks.includes('.NET')) {
        suggestedCommands.push('dotnet test');
    }

    const rootFiles = uniqueFiles.filter((filePath: string) => !filePath.includes('/')).slice(0, 20);
    const runtimePathHints = collectRuntimePathHints(uniqueFiles);
    const suggestedCompileGateCommands = resolveSuggestedCompileGateCommands(targetRoot);
    const suggestedFullSuiteValidationCommand = resolveSuggestedFullSuiteValidationCommand(targetRoot);

    return {
        source: discoverySource,
        fileCount: uniqueFiles.length,
        diagnostics: [...new Set(diagnostics)].sort(),
        detectedStacks: [...new Set(detectedStacks)].sort(),
        stackEvidence,
        topLevelDirectories: [...new Set(topLevelDirectories)].sort(),
        rootFiles,
        runtimePathHints,
        suggestedCommands: [...new Set(suggestedCommands)].sort(),
        suggestedCompileGateCommands,
        suggestedFullSuiteValidationCommand,
        relativeFiles: uniqueFiles,
        sampleFiles: uniqueFiles.slice(0, 40)
    };
}

export function collectRuntimePathHints(relativeFiles: string[]): string[] {
    const runtimeRootTokens = new Set(['src', 'app', 'apps', 'backend', 'frontend', 'web', 'api', 'services', 'packages']);
    const hints: string[] = [];
    const seen = new Set<string>();

    for (const filePath of relativeFiles) {
        const segments = String(filePath || '').split('/').filter(Boolean);
        if (segments.length < 2) {
            continue;
        }

        let hint = null;
        const first = segments[0].toLowerCase();
        const second = segments[1].toLowerCase();

        if (runtimeRootTokens.has(first)) {
            hint = `${segments[0]}/`;
        } else if (runtimeRootTokens.has(second)) {
            hint = `${segments[0]}/${segments[1]}/`;
        }

        if (hint && !seen.has(hint)) {
            seen.add(hint);
            hints.push(hint);
        }

        if (hints.length >= 20) {
            break;
        }
    }

    return hints;
}

function collectFilesRecursive(
    rootPath: string,
    basePath: string,
    options: ProjectDiscoveryOptions = {}
): FallbackScanResult {
    const results: string[] = [];
    const diagnostics: string[] = [];
    const stack: string[] = [rootPath];
    const maxFiles = normalizePositiveInteger(options.fallbackScanMaxFiles, DEFAULT_FALLBACK_SCAN_MAX_FILES);
    const maxDirectories = normalizePositiveInteger(options.fallbackScanMaxDirectories, DEFAULT_FALLBACK_SCAN_MAX_DIRECTORIES);
    const maxElapsedMs = normalizePositiveInteger(options.fallbackScanMaxElapsedMs, DEFAULT_FALLBACK_SCAN_MAX_ELAPSED_MS);
    const startedAt = Date.now();
    let scannedDirectories = 0;
    let stoppedReason: string | null = null;

    while (stack.length > 0) {
        if (results.length >= maxFiles) {
            stoppedReason = `file budget reached (${maxFiles})`;
            break;
        }
        if (scannedDirectories >= maxDirectories) {
            stoppedReason = `directory budget reached (${maxDirectories})`;
            break;
        }
        if (Date.now() - startedAt > maxElapsedMs) {
            stoppedReason = `elapsed budget reached (${maxElapsedMs} ms)`;
            break;
        }

        const current = stack.pop()!;
        const currentRelative = path.relative(basePath, current).replace(/\\/g, '/');
        if (currentRelative && isExcludedDiscoveryRelativePath(currentRelative)) {
            continue;
        }
        scannedDirectories += 1;

        try {
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    const relativeDir = path.relative(basePath, fullPath).replace(/\\/g, '/');
                    if (isExcludedDiscoveryRelativePath(relativeDir)) {
                        continue;
                    }
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    results.push(path.relative(basePath, fullPath).replace(/\\/g, '/'));
                    if (results.length >= maxFiles) {
                        stoppedReason = `file budget reached (${maxFiles})`;
                        break;
                    }
                }
            }
        } catch {
            // Ignore unreadable dirs
        }
    }

    if (stoppedReason) {
        diagnostics.push(
            `Filesystem fallback scan stopped early: ${stoppedReason}; partial project discovery results were used.`
        );
    }
    return { files: results, diagnostics };
}

export function buildProjectDiscoveryLines(discovery: ProjectDiscovery, timestampIso: string): string[] {
    const tick = '`';
    const lines = [
        '# Project Discovery', '',
        `Generated at: ${timestampIso}`,
        `Source: ${discovery.source}`,
        `Files considered: ${discovery.fileCount}`,
        '', '## Detected Stack Signals'
    ];

    if (discovery.detectedStacks.length === 0) {
        lines.push('- No strong stack markers detected. Fill context rules manually.');
    } else {
        for (const stack of discovery.detectedStacks) {
            lines.push(`- ${stack}`);
        }
    }

    lines.push('', '## Top-Level Directories');
    if (discovery.topLevelDirectories.length === 0) {
        lines.push('- No top-level runtime directories detected.');
    } else {
        for (const dir of discovery.topLevelDirectories) {
            lines.push(`- ${tick}${dir}/${tick}`);
        }
    }

    if (Array.isArray(discovery.diagnostics) && discovery.diagnostics.length > 0) {
        lines.push('', '## Discovery Diagnostics');
        for (const diagnostic of discovery.diagnostics) {
            lines.push(`- ${diagnostic}`);
        }
    }

    lines.push('', '## Stack Evidence');
    if (!Array.isArray(discovery.stackEvidence) || discovery.stackEvidence.length === 0) {
        lines.push('- No stack evidence captured.');
    } else {
        for (const evidence of discovery.stackEvidence) {
            const matches = Array.isArray(evidence.matches) && evidence.matches.length > 0
                ? evidence.matches.map((item) => `${tick}${item}${tick}`).join(', ')
                : 'none';
            lines.push(`- ${evidence.name}: ${matches}`);
        }
    }

    lines.push('', '## Root Files');
    if (!Array.isArray(discovery.rootFiles) || discovery.rootFiles.length === 0) {
        lines.push('- No root files captured.');
    } else {
        for (const filePath of discovery.rootFiles) {
            lines.push(`- ${tick}${filePath}${tick}`);
        }
    }

    lines.push('', '## Runtime Path Hints');
    if (!Array.isArray(discovery.runtimePathHints) || discovery.runtimePathHints.length === 0) {
        lines.push('- No runtime path hints detected.');
    } else {
        for (const hint of discovery.runtimePathHints) {
            lines.push(`- ${tick}${hint}${tick}`);
        }
    }

    lines.push('', '## Suggested Compile Gate Commands (Heuristic)');
    if (!Array.isArray(discovery.suggestedCompileGateCommands) || discovery.suggestedCompileGateCommands.length === 0) {
        lines.push(`- No deterministic compile-gate command detected. Keep workflow config at \`${UNCONFIGURED_COMPILE_GATE_COMMAND}\` until an operator or agent-init records a project-specific compile/build/type-check command.`);
    } else {
        lines.push('- Use these only for `workflow-config.compile_gate.command`; `40-commands.md` is human guidance. Full test suites belong in full-suite validation.');
        for (const cmd of discovery.suggestedCompileGateCommands) {
            lines.push(`- ${tick}${cmd}${tick}`);
        }
    }

    lines.push('', '## Suggested Local Commands (Heuristic)');
    if (discovery.suggestedCommands.length === 0) {
        lines.push('- No command suggestions from discovery. Populate `40-commands.md` manually.');
    } else {
        for (const cmd of discovery.suggestedCommands) {
            lines.push(`- ${tick}${cmd}${tick}`);
        }
    }

    lines.push('', '## Suggested Full-Suite Validation Command');
    if (!discovery.suggestedFullSuiteValidationCommand || discovery.suggestedFullSuiteValidationCommand === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        lines.push('- No deterministic full-suite command detected yet. `agent-init` should keep the workflow-config command unconfigured until an operator or later CLI command sets it.');
    } else {
        lines.push(`- ${tick}${discovery.suggestedFullSuiteValidationCommand}${tick}`);
    }

    lines.push('', '## Sample Files Used For Detection');
    if (discovery.sampleFiles.length === 0) {
        lines.push('- No sample files captured.');
    } else {
        for (const sample of discovery.sampleFiles) {
            lines.push(`- ${tick}${sample}${tick}`);
        }
    }

    return lines;
}

export function buildDiscoveryOverlaySection(discovery: ProjectDiscovery): string {
    const stacksText = discovery.detectedStacks.length > 0
        ? discovery.detectedStacks.join(', ')
        : 'none detected';
    const dirsText = discovery.topLevelDirectories.length > 0
        ? discovery.topLevelDirectories.slice(0, 10).join(', ')
        : 'none detected';
    const fullSuiteCommandText = discovery.suggestedFullSuiteValidationCommand
        && discovery.suggestedFullSuiteValidationCommand !== UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
        ? `\`${discovery.suggestedFullSuiteValidationCommand}\``
        : 'none detected; keep workflow-config unconfigured until an operator sets a project-specific command';
    const compileGateCommandText = Array.isArray(discovery.suggestedCompileGateCommands)
        && discovery.suggestedCompileGateCommands.length > 0
        ? `\`${discovery.suggestedCompileGateCommands[0]}\``
        : 'none detected; choose a compile/build/type-check command manually and do not use the full test suite';

    return [
        '## Project Discovery Snapshot',
        `- Discovery source: ${discovery.source}`,
        `- Files considered: ${discovery.fileCount}`,
        `- Detected stacks: ${stacksText}`,
        `- Top-level directories: ${dirsText}`,
        `- Suggested compile-gate command: ${compileGateCommandText}`,
        `- Suggested full-suite validation command: ${fullSuiteCommandText}`,
        `- Full report: \`${resolveBundleName()}/live/project-discovery.md\``
    ].join('\r\n');
}
