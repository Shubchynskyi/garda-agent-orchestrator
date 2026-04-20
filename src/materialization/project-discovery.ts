import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { ensureDirectory, pathExists, readTextFile } from '../core/fs';
import { normalizeRelativePath } from '../core/paths';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';
import {
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
    detectedStacks: string[];
    stackEvidence: StackEvidence[];
    topLevelDirectories: string[];
    rootFiles: string[];
    runtimePathHints: string[];
    suggestedCommands: string[];
    suggestedFullSuiteValidationCommand: string | null;
    relativeFiles: string[];
    sampleFiles: string[];
}

const _BASE_EXCLUDED_PATH_FRAGMENTS = Object.freeze([
    '/.git/', '/node_modules/', '/.next/', '/dist/', '/build/',
    '/target/', '/bin/', '/obj/'
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

const _STATIC_EXCLUDED_TOP_LEVEL_DIRS = ['.git', 'node_modules', 'dist', 'build', 'target', 'bin', 'obj'];

export function getExcludedTopLevelDirs(): Set<string> {
    return new Set([resolveBundleName(), ..._STATIC_EXCLUDED_TOP_LEVEL_DIRS]);
}

/** @deprecated Use {@link getExcludedTopLevelDirs} which respects configured bundle name. */
export const EXCLUDED_TOP_LEVEL_DIRS = new Set([
    resolveBundleName(), ..._STATIC_EXCLUDED_TOP_LEVEL_DIRS
]);

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

function resolveJvmWrapperTestCommand(options: {
    targetRoot: string;
    wrapperName: string;
    windowsWrapperName: string;
    fallbackCommand: string;
    runtimePlatform: NodeJS.Platform;
}): string {
    const { targetRoot, wrapperName, windowsWrapperName, fallbackCommand, runtimePlatform } = options;
    const posixWrapperExists = pathExists(path.join(targetRoot, wrapperName));
    const windowsWrapperExists = pathExists(path.join(targetRoot, windowsWrapperName));

    if (runtimePlatform === 'win32') {
        if (windowsWrapperExists) {
            return `.\\${windowsWrapperName} test`;
        }
        if (posixWrapperExists) {
            return `./${wrapperName} test`;
        }
        return fallbackCommand;
    }

    if (posixWrapperExists) {
        return `./${wrapperName} test`;
    }

    return fallbackCommand;
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

/**
 * Scans the project for stack signals, file listings, and directory structure.
 */
export function getProjectDiscovery(targetRoot: string): ProjectDiscovery {
    let relativeFiles: string[] = [];
    let discoverySource = 'filesystem_scan';

    // Try git-based discovery first
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
            }
        }
    } catch {
        // Fall through to filesystem scan
    }

    // Filesystem fallback
    if (relativeFiles.length === 0) {
        relativeFiles = collectFilesRecursive(targetRoot, targetRoot);
    }

    // Filter excluded paths
    const filteredFiles: string[] = relativeFiles
        .map((f: string) => normalizeRelativePath(f))
        .filter((f: string) => {
            if (!f) return false;
            const wrapped = `/${f}/`;
            return !getExcludedPathFragments().some((frag) => wrapped.includes(frag));
        });
    const uniqueFiles: string[] = [...new Set(filteredFiles)].sort();

    // Detect stacks
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

    // Get top-level directories
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

    // Suggest commands
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
    const suggestedFullSuiteValidationCommand = resolveSuggestedFullSuiteValidationCommand(targetRoot);

    return {
        source: discoverySource,
        fileCount: uniqueFiles.length,
        detectedStacks: [...new Set(detectedStacks)].sort(),
        stackEvidence,
        topLevelDirectories: [...new Set(topLevelDirectories)].sort(),
        rootFiles,
        runtimePathHints,
        suggestedCommands: [...new Set(suggestedCommands)].sort(),
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

function collectFilesRecursive(rootPath: string, basePath: string): string[] {
    const results: string[] = [];
    const stack: string[] = [rootPath];
    while (stack.length > 0) {
        const current = stack.pop()!;
        try {
            const entries = fs.readdirSync(current, { withFileTypes: true });
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (entry.isFile()) {
                    results.push(path.relative(basePath, fullPath).replace(/\\/g, '/'));
                }
            }
        } catch {
            // Ignore unreadable dirs
        }
    }
    return results;
}

/**
 * Builds project discovery markdown lines.
 */
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

/**
 * Builds a brief discovery overlay section for context rules.
 */
export function buildDiscoveryOverlaySection(discovery: ProjectDiscovery): string {
    const stacksText = discovery.detectedStacks.length > 0
        ? discovery.detectedStacks.join(', ')
        : 'none detected';
    const dirsText = discovery.topLevelDirectories.length > 0
        ? discovery.topLevelDirectories.slice(0, 10).join(', ')
        : 'none detected';

    return [
        '## Project Discovery Snapshot',
        `- Discovery source: ${discovery.source}`,
        `- Files considered: ${discovery.fileCount}`,
        `- Detected stacks: ${stacksText}`,
        `- Top-level directories: ${dirsText}`,
        `- Full report: \`${resolveBundleName()}/live/project-discovery.md\``
    ].join('\r\n');
}
