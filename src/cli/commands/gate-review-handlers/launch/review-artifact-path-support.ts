import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizePath } from '../../../../gates/shared/helpers';
import { resolveCanonicalReviewContextPath } from '../../../../gates/review-context/review-context-paths';
import {
    resolveDefaultReviewScratchPath
} from '../../../../gates/review/review-scratch-paths';
import {
    isTaskOwnedReviewTempPath
} from '../../gates-artifacts';

export interface ResolvedCanonicalReviewPaths {
    preflightPath: string;
    reviewsRoot: string;
    artifactPath: string;
    contextPath: string;
}

function assertArtifactPathRealpathInsideRepo(repoRoot: string, artifactPath: string, label: string): void {
    if (!gateHelpers.isPathRealpathInsideRoot(artifactPath, repoRoot)) {
        throw new Error(
            `${label} must resolve inside repo root without symlink or junction escape: ` +
            `${normalizePath(artifactPath)}.`
        );
    }
}

export function resolveCanonicalReviewPaths(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    preflightPathValue: unknown,
    reviewContextPathValue: unknown
): ResolvedCanonicalReviewPaths {
    const canonicalPreflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    assertArtifactPathRealpathInsideRepo(repoRoot, canonicalPreflightPath, 'PreflightPath');
    const resolvedPreflightPath = gateHelpers.resolvePathInsideRepo(String(preflightPathValue || ''), repoRoot, { allowMissing: true });
    if (!resolvedPreflightPath) {
        throw new Error('PreflightPath is required.');
    }
    assertArtifactPathRealpathInsideRepo(repoRoot, resolvedPreflightPath, 'PreflightPath');
    if (resolvedPreflightPath !== canonicalPreflightPath) {
        throw new Error(
            `PreflightPath must point to the canonical preflight artifact for '${taskId}': ` +
            `${normalizePath(canonicalPreflightPath)}.`
        );
    }
    const preflightPath = resolvedPreflightPath;
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }

    const reviewsRoot = path.dirname(preflightPath);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: reviewContextPathValue ? String(reviewContextPathValue) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    return {
        preflightPath,
        reviewsRoot,
        artifactPath,
        contextPath
    };
}

export function resolveCanonicalPreflightArtifactPath(repoRoot: string, taskId: string): string {
    const preflightPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
    assertArtifactPathRealpathInsideRepo(repoRoot, preflightPath, 'PreflightPath');
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${normalizePath(preflightPath)}.`);
    }
    return preflightPath;
}

export function readJsonFile(pathValue: string, label: string): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            throw new Error(`${label} must contain valid JSON: ${error.message}`);
        }
        throw error;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${label} must contain a JSON object.`);
    }
    return parsed as Record<string, unknown>;
}

export function readJsonObjectIfPresent(pathValue: string): Record<string, unknown> | null {
    if (!fs.existsSync(pathValue) || !fs.statSync(pathValue).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(pathValue, 'utf8')) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed as Record<string, unknown>
            : null;
    } catch {
        return null;
    }
}

function resolveDefaultReviewerLaunchArtifactPath(repoRoot: string, taskId: string, reviewType: string): string {
    return resolveDefaultReviewScratchPath(repoRoot, taskId, reviewType, 'reviewer-launch.json');
}

export function resolveReviewerLaunchArtifactPathForWrite(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPathValue: unknown;
}): string {
    const rawArtifactPath = String(options.artifactPathValue || '').trim()
        || resolveDefaultReviewerLaunchArtifactPath(options.repoRoot, options.taskId, options.reviewType);
    const artifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
    if (!artifactPath) {
        throw new Error('ReviewerLaunchArtifactPath could not be resolved.');
    }
    if (!isTaskOwnedReviewTempPath(options.repoRoot, options.taskId, artifactPath)) {
        throw new Error(
            `ReviewerLaunchArtifactPath must be task-owned under reviewer scratch storage for '${options.taskId}'. ` +
            `Got ${normalizePath(artifactPath)}.`
        );
    }
    return artifactPath;
}
