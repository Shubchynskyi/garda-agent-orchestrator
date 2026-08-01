import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { readJsonFile } from './shared';
import {
    PACKAGE_SURFACE_LIFECYCLE_SCRIPTS,
    PACKAGE_SURFACE_RISK_SIGNALS,
    PACKAGE_SURFACE_SCHEMA_VERSION,
    type NpmPackFile,
    type NpmPackReport,
    type PackageSurfaceArtifact,
    type PackageSurfaceRiskSignals
} from './package-surface-types';

const EXECUTABLE_SOURCE_EXTENSIONS = new Set(['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts']);
const NPM_PACK_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const RISK_SIGNAL_PATTERNS: Readonly<Record<keyof PackageSurfaceRiskSignals, RegExp>> = Object.freeze({
    child_process: /child_process/gu,
    exec: /\bexec(?:File)?(?:Sync)?\b/gu,
    fetch: /\bfetch\b/gu,
    fs: /node:fs|\brequire\s*\(\s*['"]fs(?:\/promises)?['"]\s*\)|\bfrom\s*['"]fs(?:\/promises)?['"]|\bimport\s*(?:\(\s*)?['"]fs(?:\/promises)?['"]\s*\)?|\bfs\s*\./gu,
    readFile: /\breadFile(?:Sync)?\b/gu,
    writeFile: /\bwriteFile(?:Sync)?\b/gu
});

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, label: string): string {
    const value = record[key];
    if (typeof value !== 'string' || !value.trim()) {
        throw new Error(`${label}.${key} must be a non-empty string.`);
    }
    return value;
}

function requireNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number {
    const value = record[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`${label}.${key} must be a non-negative safe integer.`);
    }
    return Number(value);
}

function emptyRiskSignals(): PackageSurfaceRiskSignals {
    return {
        child_process: 0,
        exec: 0,
        fetch: 0,
        fs: 0,
        readFile: 0,
        writeFile: 0
    };
}

function normalizePackPath(relativePath: string): string {
    const normalized = relativePath.replace(/\\/gu, '/');
    const segments = normalized.split('/');
    const unsafe = normalized !== relativePath
        || path.posix.isAbsolute(normalized)
        || segments.some((segment) => !segment || segment === '.' || segment === '..');
    if (unsafe) {
        throw new Error(`npm pack reported unsafe packed file path: ${relativePath}`);
    }
    return normalized;
}

function resolvePackedFile(repoRoot: string, relativePath: string): string {
    const normalizedPath = normalizePackPath(relativePath);
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedFile = path.resolve(resolvedRoot, ...normalizedPath.split('/'));
    const relativeToRoot = path.relative(resolvedRoot, resolvedFile);
    if (!relativeToRoot || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
        throw new Error(`npm pack reported unsafe packed file path: ${relativePath}`);
    }
    if (!fs.existsSync(resolvedFile)) {
        return resolvedFile;
    }
    const canonicalRoot = fs.realpathSync.native(resolvedRoot);
    const canonicalFile = fs.realpathSync.native(resolvedFile);
    const canonicalRelative = path.relative(canonicalRoot, canonicalFile);
    const escapedCanonicalRoot = canonicalRelative === '..'
        || canonicalRelative.startsWith(`..${path.sep}`)
        || path.isAbsolute(canonicalRelative);
    if (escapedCanonicalRoot) {
        throw new Error(`Packed file resolves outside the repository through a linked path: ${relativePath}`);
    }
    return canonicalFile;
}

function parsePackFile(value: unknown, index: number): NpmPackFile {
    if (!isRecord(value)) {
        throw new Error(`npm pack report.files[${index}] must be an object.`);
    }
    return {
        path: requireString(value, 'path', `npm pack report.files[${index}]`),
        size: requireNonNegativeInteger(value, 'size', `npm pack report.files[${index}]`)
    };
}

function parsePackReportValue(value: unknown): NpmPackReport {
    if (!isRecord(value)) {
        throw new Error('npm pack report must be an object.');
    }
    if (!Array.isArray(value.files)) {
        throw new Error('npm pack report.files must be an array.');
    }
    return {
        name: requireString(value, 'name', 'npm pack report'),
        version: requireString(value, 'version', 'npm pack report'),
        filename: requireString(value, 'filename', 'npm pack report'),
        entryCount: requireNonNegativeInteger(value, 'entryCount', 'npm pack report'),
        unpackedSize: requireNonNegativeInteger(value, 'unpackedSize', 'npm pack report'),
        files: value.files.map(parsePackFile)
    };
}

function findJsonArrayEnd(value: string, start: number): number | null {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < value.length; index += 1) {
        const character = value[index];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (character === '\\') {
                escaped = true;
            } else if (character === '"') {
                inString = false;
            }
            continue;
        }
        if (character === '"') {
            inString = true;
        } else if (character === '[') {
            depth += 1;
        } else if (character === ']') {
            depth -= 1;
            if (depth === 0) {
                return index + 1;
            }
        }
    }
    return null;
}

function findJsonArrayCandidates(value: string): unknown[][] {
    const candidates: unknown[][] = [];
    for (let index = 0; index < value.length; index += 1) {
        if (value[index] !== '[' || (index > 0 && value[index - 1] !== '\n' && value[index - 1] !== '\r')) {
            continue;
        }
        const end = findJsonArrayEnd(value, index);
        if (end === null) {
            continue;
        }
        try {
            const parsed: unknown = JSON.parse(value.slice(index, end));
            if (Array.isArray(parsed)) {
                candidates.push(parsed);
            }
        } catch {
            // Non-JSON lifecycle output is ignored; the final report remains mandatory.
        }
    }
    return candidates;
}

export function parseNpmPackReport(stdout: string): NpmPackReport {
    const candidates = findJsonArrayCandidates(String(stdout || ''));
    if (candidates.length === 0) {
        throw new Error('npm pack output did not contain a valid npm pack JSON array.');
    }
    if (candidates.length !== 1 || candidates[0].length !== 1) {
        throw new Error('npm pack output must contain exactly one final package report.');
    }
    return parsePackReportValue(candidates[0][0]);
}

function validatePackReportConsistency(report: NpmPackReport): void {
    if (report.entryCount !== report.files.length) {
        throw new Error(`npm pack entryCount=${report.entryCount} does not match files.length=${report.files.length}.`);
    }
    const totalSize = report.files.reduce((sum, file) => sum + file.size, 0);
    if (report.unpackedSize !== totalSize) {
        throw new Error(`npm pack unpackedSize=${report.unpackedSize} does not match summed file size=${totalSize}.`);
    }
    const paths = report.files.map((file) => normalizePackPath(file.path));
    if (new Set(paths).size !== paths.length) {
        throw new Error('npm pack report contains duplicate file paths.');
    }
}

function readPackageIdentityAndScripts(repoRoot: string): {
    name: string;
    version: string;
    scripts: Record<string, string>;
} {
    const payload = readJsonFile(path.join(repoRoot, 'package.json'));
    if (!isRecord(payload)) {
        throw new Error('package.json must contain an object.');
    }
    const scripts: Record<string, string> = {};
    if (isRecord(payload.scripts)) {
        for (const [name, command] of Object.entries(payload.scripts)) {
            if (typeof command === 'string') {
                scripts[name] = command;
            }
        }
    }
    return {
        name: requireString(payload, 'name', 'package.json'),
        version: requireString(payload, 'version', 'package.json'),
        scripts
    };
}

function collectLifecycleScripts(scripts: Record<string, string>): Record<string, string> {
    const lifecycleScripts: Record<string, string> = {};
    for (const name of [...PACKAGE_SURFACE_LIFECYCLE_SCRIPTS].sort()) {
        if (Object.hasOwn(scripts, name)) {
            lifecycleScripts[name] = scripts[name];
        }
    }
    return lifecycleScripts;
}

function collectRiskSignals(repoRoot: string, files: NpmPackFile[]): PackageSurfaceRiskSignals {
    const counts = emptyRiskSignals();
    for (const file of files) {
        const filePath = resolvePackedFile(repoRoot, file.path);
        if (!EXECUTABLE_SOURCE_EXTENSIONS.has(path.extname(file.path).toLowerCase())) {
            continue;
        }
        if (!fs.existsSync(filePath)) {
            throw new Error(`Packed executable file is unavailable for lexical scanning: ${file.path}`);
        }
        const fileStat = fs.lstatSync(filePath);
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
            throw new Error(`Packed executable file must be a regular non-symlink for lexical scanning: ${file.path}`);
        }
        const content = fs.readFileSync(filePath, 'utf8');
        for (const signal of PACKAGE_SURFACE_RISK_SIGNALS) {
            counts[signal] += [...content.matchAll(RISK_SIGNAL_PATTERNS[signal])].length;
        }
    }
    return counts;
}

function hashPackedFileManifest(files: NpmPackFile[]): string {
    const hash = crypto.createHash('sha256');
    const sortedFiles = [...files].sort((left, right) => compareText(left.path, right.path));
    for (const file of sortedFiles) {
        hash.update(normalizePackPath(file.path));
        hash.update('\0');
        hash.update(String(file.size));
        hash.update('\n');
    }
    return hash.digest('hex');
}

export function buildPackageSurfaceArtifact(repoRoot: string, report: NpmPackReport): PackageSurfaceArtifact {
    const normalizedRoot = path.resolve(repoRoot);
    validatePackReportConsistency(report);
    const packageJson = readPackageIdentityAndScripts(normalizedRoot);
    if (packageJson.name !== report.name || packageJson.version !== report.version) {
        throw new Error(
            `npm pack identity ${report.name}@${report.version} does not match package.json ${packageJson.name}@${packageJson.version}.`
        );
    }
    return {
        schemaVersion: PACKAGE_SURFACE_SCHEMA_VERSION,
        package: { name: report.name, version: report.version },
        packedFileManifestSha256: hashPackedFileManifest(report.files),
        metrics: {
            fileCount: report.entryCount,
            unpackedSizeBytes: report.unpackedSize,
            lifecycleScripts: collectLifecycleScripts(packageJson.scripts),
            riskSignals: collectRiskSignals(normalizedRoot, report.files)
        }
    };
}

function formatProcessFailure(label: string, result: childProcess.SpawnSyncReturns<string>): Error {
    const details = [result.error?.message, String(result.stderr || '').trim(), String(result.stdout || '').trim()]
        .filter(Boolean)
        .join('\n');
    return new Error(`${label} failed${details ? `:\n${details}` : '.'}`);
}

function runRequiredProcess(repoRoot: string, label: string, command: string, args: string[]): string {
    const result = childProcess.spawnSync(command, args, {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: NPM_PACK_MAX_BUFFER_BYTES,
        windowsHide: true
    });
    if (result.status !== 0 || result.error) {
        throw formatProcessFailure(label, result);
    }
    return String(result.stdout || '');
}

function preparePackageSurface(repoRoot: string): void {
    runRequiredProcess(
        repoRoot,
        'publish-runtime build for package-surface measurement',
        process.execPath,
        [path.join('.scripts-build', 'scripts', 'node-foundation', 'build.js'), 'publish-runtime']
    );
    runRequiredProcess(
        repoRoot,
        'legacy package compatibility materialization',
        process.execPath,
        ['scripts/package-legacy-entrypoint-compat.cjs', 'create']
    );
}

function removePackageSurfaceCompatibilityFile(repoRoot: string): void {
    runRequiredProcess(
        repoRoot,
        'legacy package compatibility cleanup',
        process.execPath,
        ['scripts/package-legacy-entrypoint-compat.cjs', 'remove']
    );
}

function resolveNpmInvocation(): { command: string; argsPrefix: string[] } {
    const npmExecPath = String(process.env.npm_execpath || '').trim();
    const bundledNpmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    const npmCliPath = npmExecPath && fs.existsSync(npmExecPath) ? npmExecPath : bundledNpmCli;
    if (fs.existsSync(npmCliPath)) {
        return { command: process.execPath, argsPrefix: [npmCliPath] };
    }
    return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', argsPrefix: [] };
}

function runNpmPack(repoRoot: string): NpmPackReport {
    const npmInvocation = resolveNpmInvocation();
    preparePackageSurface(repoRoot);
    let report: NpmPackReport | null = null;
    let packError: unknown = null;
    try {
        const stdout = runRequiredProcess(
            repoRoot,
            'npm pack --dry-run',
            npmInvocation.command,
            [...npmInvocation.argsPrefix, 'pack', '--dry-run', '--json', '--silent', '--ignore-scripts']
        );
        report = parseNpmPackReport(stdout);
    } catch (error: unknown) {
        packError = error;
    }
    try {
        removePackageSurfaceCompatibilityFile(repoRoot);
    } catch (cleanupError: unknown) {
        if (packError instanceof Error) {
            throw new Error(`${packError.message}\n${String(cleanupError)}`);
        }
        throw cleanupError;
    }
    if (packError !== null) {
        throw packError;
    }
    if (report === null) {
        throw new Error('npm pack --dry-run completed without a package report.');
    }
    return report;
}

export function collectCurrentPackageSurface(repoRoot: string): PackageSurfaceArtifact {
    const normalizedRoot = path.resolve(repoRoot);
    return buildPackageSurfaceArtifact(normalizedRoot, runNpmPack(normalizedRoot));
}
