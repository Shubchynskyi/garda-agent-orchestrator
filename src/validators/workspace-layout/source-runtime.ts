import * as fs from 'node:fs';
import * as path from 'node:path';
import { CLI_ENTRYPOINT_CANDIDATES } from '../../core/constants';
import { pathExists } from '../../core/filesystem';

export interface SourceCheckoutRuntimeStalenessResult {
    isSourceCheckout: boolean;
    runtimeRoot: string | null;
    isStale: boolean;
    violations: string[];
    remediation: string | null;
}

function pathExistsAny(root: string, relativePaths: readonly string[]): boolean {
    return relativePaths.some((relativePath) => pathExists(path.join(root, relativePath)));
}

export function isSourceCheckoutRoot(targetRoot: string): boolean {
    return pathExists(path.join(targetRoot, 'src', 'index.ts')) &&
        pathExistsAny(targetRoot, CLI_ENTRYPOINT_CANDIDATES) &&
        pathExists(path.join(targetRoot, 'package.json'));
}

function listTypeScriptSourceFiles(rootPath: string): string[] {
    if (!pathExists(rootPath)) {
        return [];
    }
    const result: string[] = [];
    const stack = [rootPath];
    while (stack.length > 0) {
        const current = stack.pop() as string;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(fullPath);
                continue;
            }
            if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) {
                continue;
            }
            result.push(fullPath);
        }
    }
    return result.sort();
}

function resolveGeneratedRuntimePath(targetRoot: string, runtimeRoot: string, sourcePath: string): string | null {
    const relativeSourcePath = path.relative(path.join(targetRoot, 'src'), sourcePath);
    if (!relativeSourcePath || relativeSourcePath.startsWith('..')) {
        return null;
    }
    const parsed = path.parse(relativeSourcePath);
    if (parsed.ext !== '.ts') {
        return null;
    }
    return path.join(runtimeRoot, parsed.dir, `${parsed.name}.js`);
}

export function buildForcedSourceCheckoutRuntimeBuildCommand(platform: NodeJS.Platform = process.platform): string {
    return platform === 'win32'
        ? "$env:GARDA_BUILD_SCRIPTS_FORCE_REBUILD='1'; $env:GARDA_PUBLISH_RUNTIME_FORCE_REBUILD='1'; npm run build"
        : 'GARDA_BUILD_SCRIPTS_FORCE_REBUILD=1 GARDA_PUBLISH_RUNTIME_FORCE_REBUILD=1 npm run build';
}

function buildSourceCheckoutRuntimeRemediation(): string {
    return `Run "${buildForcedSourceCheckoutRuntimeBuildCommand()}" before continuing gate execution from this source checkout. ` +
        'This disables build-script and publish-runtime reuse so stale generated runtime evidence is refreshed.';
}

export function detectSourceCheckoutRuntimeStaleness(targetRoot: string): SourceCheckoutRuntimeStalenessResult {
    const resolvedRoot = path.resolve(targetRoot);
    const isSourceCheckout = isSourceCheckoutRoot(resolvedRoot);
    const result: SourceCheckoutRuntimeStalenessResult = {
        isSourceCheckout,
        runtimeRoot: null,
        isStale: false,
        violations: [],
        remediation: null
    };
    if (!isSourceCheckout) {
        return result;
    }

    const runtimeCandidates = [
        path.join(resolvedRoot, 'dist', 'src'),
        path.join(resolvedRoot, '.node-build', 'src')
    ];
    const runtimeRoot = runtimeCandidates.find((candidate) => pathExists(path.join(candidate, 'index.js'))) || null;
    result.runtimeRoot = runtimeRoot;
    if (!runtimeRoot) {
        result.isStale = true;
        result.violations.push('Generated source-checkout runtime output is missing: dist/src/index.js or .node-build/src/index.js.');
        result.remediation = buildSourceCheckoutRuntimeRemediation();
        return result;
    }

    const stalePairs: string[] = [];
    const missingGenerated: string[] = [];
    for (const sourcePath of listTypeScriptSourceFiles(path.join(resolvedRoot, 'src'))) {
        const normalizedSourceRelative = path.relative(resolvedRoot, sourcePath).replace(/\\/g, '/');
        if (normalizedSourceRelative === 'src/bin/garda.ts') {
            continue;
        }
        const generatedPath = resolveGeneratedRuntimePath(resolvedRoot, runtimeRoot, sourcePath);
        if (!generatedPath) {
            continue;
        }
        const generatedRelative = path.relative(resolvedRoot, generatedPath).replace(/\\/g, '/');
        if (!pathExists(generatedPath)) {
            missingGenerated.push(`${normalizedSourceRelative} -> ${generatedRelative}`);
            continue;
        }
        const sourceStat = fs.statSync(sourcePath);
        const generatedStat = fs.statSync(generatedPath);
        if (sourceStat.mtimeMs > generatedStat.mtimeMs + 1000) {
            stalePairs.push(`${normalizedSourceRelative} newer than ${generatedRelative}`);
        }
    }

    const visibleMissing = missingGenerated.slice(0, 8);
    const visibleStale = stalePairs.slice(0, 8);
    for (const entry of visibleMissing) {
        result.violations.push(`Generated runtime file is missing for source: ${entry}.`);
    }
    if (missingGenerated.length > visibleMissing.length) {
        result.violations.push(`Generated runtime files are missing for ${missingGenerated.length - visibleMissing.length} additional source file(s).`);
    }
    for (const entry of visibleStale) {
        result.violations.push(`Generated runtime file is older than source: ${entry}.`);
    }
    if (stalePairs.length > visibleStale.length) {
        result.violations.push(`Generated runtime files are older for ${stalePairs.length - visibleStale.length} additional source file(s).`);
    }
    result.isStale = result.violations.length > 0;
    if (result.isStale) {
        result.remediation = buildSourceCheckoutRuntimeRemediation();
    }
    return result;
}
