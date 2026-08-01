import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../build';
import { readJsonFile } from './shared';
import { collectCurrentPackageSurface } from './package-surface-collect';
import {
    DEFAULT_PACKAGE_SURFACE_ALLOWED_GROWTH,
    comparePackageSurface,
    formatPackageSurfaceComparison,
    parsePackageSurfaceArtifact,
    parsePackageSurfaceBaseline,
    updatePackageSurfaceBaseline
} from './package-surface-baseline';
import {
    PACKAGE_SURFACE_ARTIFACT_PATH,
    PACKAGE_SURFACE_BASELINE_PATH,
    type PackageSurfaceArtifact,
    type PackageSurfaceBaseline,
    type PackageSurfaceComparisonResult
} from './package-surface-types';

function writeJsonFile(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function pathsEqual(left: string, right: string): boolean {
    return process.platform === 'win32'
        ? left.toLowerCase() === right.toLowerCase()
        : left === right;
}

function assertNoLinkedPathComponents(repoRoot: string, targetPath: string): void {
    const relativePath = path.relative(path.resolve(repoRoot), path.resolve(targetPath));
    const outsideRepo = relativePath === '..'
        || relativePath.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativePath);
    if (outsideRepo) {
        throw new Error(`Package-surface output must remain inside the repository: ${targetPath}`);
    }
    let currentPath = path.resolve(repoRoot);
    for (const segment of relativePath.split(path.sep).filter(Boolean)) {
        currentPath = path.join(currentPath, segment);
        if (fs.existsSync(currentPath) && fs.lstatSync(currentPath).isSymbolicLink()) {
            throw new Error(`Package-surface output path contains a linked component: ${currentPath}`);
        }
    }
}

function resolveArtifactOutputPath(repoRoot: string, outputPath: string | undefined): string {
    const outputRoot = path.resolve(repoRoot, 'garda-agent-orchestrator', 'runtime', 'release');
    const resolvedOutput = path.resolve(repoRoot, outputPath || PACKAGE_SURFACE_ARTIFACT_PATH);
    const relativeOutput = path.relative(outputRoot, resolvedOutput);
    const outsideOutputRoot = relativeOutput === '..'
        || relativeOutput.startsWith(`..${path.sep}`)
        || path.isAbsolute(relativeOutput);
    if (outsideOutputRoot || path.extname(resolvedOutput).toLowerCase() !== '.json') {
        throw new Error(`Package-surface --output must be a JSON file inside ${outputRoot}.`);
    }
    assertNoLinkedPathComponents(repoRoot, resolvedOutput);
    return resolvedOutput;
}

function resolveBaselineUpdatePath(repoRoot: string): string {
    const baselinePath = path.resolve(repoRoot, PACKAGE_SURFACE_BASELINE_PATH);
    assertNoLinkedPathComponents(repoRoot, baselinePath);
    return baselinePath;
}

export function validatePackageSurface(
    repoRoot: string,
    options: { baselinePath?: string; outputPath?: string; priorArtifactPath?: string } = {}
): PackageSurfaceComparisonResult {
    const normalizedRoot = path.resolve(repoRoot);
    const outputPath = resolveArtifactOutputPath(normalizedRoot, options.outputPath);
    if (options.priorArtifactPath) {
        const priorPath = path.resolve(normalizedRoot, options.priorArtifactPath);
        if (pathsEqual(priorPath, outputPath)) {
            throw new Error('Package-surface --output cannot overwrite the prior artifact.');
        }
        const prior = parsePackageSurfaceArtifact(readJsonFile(priorPath), priorPath);
        const current = collectCurrentPackageSurface(normalizedRoot);
        writeJsonFile(outputPath, current);
        return comparePackageSurface(current, prior, priorPath);
    }
    const baselinePath = path.resolve(normalizedRoot, options.baselinePath || PACKAGE_SURFACE_BASELINE_PATH);
    if (pathsEqual(baselinePath, outputPath)) {
        throw new Error('Package-surface --output cannot overwrite the baseline.');
    }
    const baseline = parsePackageSurfaceBaseline(readJsonFile(baselinePath), baselinePath);
    const current = collectCurrentPackageSurface(normalizedRoot);
    writeJsonFile(outputPath, current);
    return comparePackageSurface(current, baseline, baselinePath);
}

export function runPackageSurfaceValidation(
    options: { baselinePath?: string; outputPath?: string; priorArtifactPath?: string } = {}
): PackageSurfaceComparisonResult {
    const result = validatePackageSurface(getRepoRoot(), options);
    console.log(formatPackageSurfaceComparison(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}

function validateBaselineUpdateRequest(confirmed: boolean, rationale: string): void {
    if (!confirmed) {
        throw new Error('Refusing baseline update without --confirm-baseline-update.');
    }
    if (!String(rationale || '').trim()) {
        throw new Error('Package-surface baseline requires a non-empty --rationale audit note.');
    }
}

export function runPackageSurfaceBaselineUpdate(options: {
    outputPath?: string;
    confirmed: boolean;
    rationale: string;
}): PackageSurfaceBaseline {
    const repoRoot = getRepoRoot();
    validateBaselineUpdateRequest(options.confirmed, options.rationale);
    const outputPath = resolveArtifactOutputPath(repoRoot, options.outputPath);
    const baselinePath = resolveBaselineUpdatePath(repoRoot);
    if (pathsEqual(baselinePath, outputPath)) {
        throw new Error('Package-surface --output cannot overwrite the baseline.');
    }
    const artifact: PackageSurfaceArtifact = collectCurrentPackageSurface(repoRoot);
    writeJsonFile(outputPath, artifact);
    const baseline = updatePackageSurfaceBaseline(baselinePath, artifact, {
        confirmed: options.confirmed,
        rationale: options.rationale,
        allowedGrowth: DEFAULT_PACKAGE_SURFACE_ALLOWED_GROWTH
    });
    console.log(`PACKAGE_SURFACE_BASELINE_UPDATED ${baselinePath}`);
    console.log(`Rationale: ${baseline.rationale}`);
    return baseline;
}
