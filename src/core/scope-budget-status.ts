import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { pathExists, readTextFile } from './filesystem';
import { getWorkflowConfigPath } from './workflow-config';
import {
    DEFAULT_SCOPE_BUDGET_GUARD_CONFIG,
    evaluateScopeBudgetGuard,
    normalizeScopeBudgetGuardConfig,
    readScopeBudgetChangedFilesCount,
    readScopeBudgetChangedLinesTotal,
    type ScopeBudgetGuardEvaluation
} from './scope-budget-guard';

export interface ScopeBudgetStatusSnapshot {
    status: ScopeBudgetGuardEvaluation['status'] | 'unavailable';
    summary_line: string;
    profile_name: string | null;
    preflight_path: string | null;
    preflight_sha256: string | null;
    changed_files_count: number | null;
    changed_lines_total: number | null;
    required_review_count: number | null;
    total_estimated_review_tokens: number | null;
    violations: ScopeBudgetGuardEvaluation['violations'];
    continuation_allowed: boolean | null;
    unavailable_reason: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function sha256File(filePath: string): string | null {
    try {
        return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    } catch {
        return null;
    }
}

function findLatestPreflightPath(bundleRoot: string): string | null {
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');
    if (!pathExists(reviewsRoot) || !fs.statSync(reviewsRoot).isDirectory()) {
        return null;
    }
    let latest: { filePath: string; mtimeMs: number } | null = null;
    for (const entry of fs.readdirSync(reviewsRoot)) {
        if (!/-preflight\.json$/u.test(entry)) {
            continue;
        }
        const filePath = path.join(reviewsRoot, entry);
        try {
            const stat = fs.statSync(filePath);
            if (!stat.isFile()) {
                continue;
            }
            if (!latest || stat.mtimeMs > latest.mtimeMs) {
                latest = { filePath, mtimeMs: stat.mtimeMs };
            }
        } catch {
            // Ignore concurrently deleted runtime artifacts.
        }
    }
    return latest?.filePath ?? null;
}

function isPathInside(parentPath: string, childPath: string): boolean {
    const relative = path.relative(parentPath, childPath);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolvePreflightPath(options: {
    targetRoot: string;
    bundleRoot: string;
    preflightPath?: string | null;
}): { preflightPath: string | null; unavailableReason: string | null } {
    const rawPreflightPath = typeof options.preflightPath === 'string' ? options.preflightPath.trim() : '';
    if (!rawPreflightPath) {
        return {
            preflightPath: findLatestPreflightPath(options.bundleRoot),
            unavailableReason: 'latest preflight artifact missing'
        };
    }

    const targetRoot = path.resolve(options.targetRoot);
    const reviewsRoot = path.join(options.bundleRoot, 'runtime', 'reviews');
    const preflightPath = path.resolve(
        path.isAbsolute(rawPreflightPath)
            ? rawPreflightPath
            : path.join(targetRoot, rawPreflightPath)
    );
    if (!isPathInside(reviewsRoot, preflightPath) || !/-preflight\.json$/u.test(path.basename(preflightPath))) {
        return {
            preflightPath: null,
            unavailableReason: 'current preflight artifact path is outside runtime reviews'
        };
    }
    if (!pathExists(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            preflightPath: null,
            unavailableReason: 'current preflight artifact missing'
        };
    }
    return { preflightPath, unavailableReason: null };
}

function countRequiredReviews(preflight: Record<string, unknown>, budgetForecast: Record<string, unknown>): number {
    if (Array.isArray(budgetForecast.required_reviews)) {
        return budgetForecast.required_reviews
            .map((entry) => String(entry || '').trim())
            .filter(Boolean)
            .length;
    }
    const requiredReviews = isRecord(preflight.required_reviews) ? preflight.required_reviews : {};
    return Object.values(requiredReviews).filter((value) => value === true).length;
}

function readProfileName(preflight: Record<string, unknown>): string | null {
    const profileSelection = isRecord(preflight.profile_selection) ? preflight.profile_selection : {};
    return typeof profileSelection.effective_profile === 'string' && profileSelection.effective_profile.trim()
        ? profileSelection.effective_profile.trim()
        : typeof profileSelection.task_profile === 'string' && profileSelection.task_profile.trim()
            ? profileSelection.task_profile.trim()
            : null;
}

function unavailable(reason: string): ScopeBudgetStatusSnapshot {
    return {
        status: 'unavailable',
        summary_line: `Scope budget guard: unavailable (${reason})`,
        profile_name: null,
        preflight_path: null,
        preflight_sha256: null,
        changed_files_count: null,
        changed_lines_total: null,
        required_review_count: null,
        total_estimated_review_tokens: null,
        violations: [],
        continuation_allowed: null,
        unavailable_reason: reason
    };
}

export function readLatestScopeBudgetStatus(options: {
    targetRoot: string;
    bundleRoot: string;
    preflightPath?: string | null;
    workflowConfigPath?: string | null;
}): ScopeBudgetStatusSnapshot {
    const bundleRoot = path.resolve(options.bundleRoot);
    const { preflightPath, unavailableReason } = resolvePreflightPath({
        targetRoot: options.targetRoot,
        bundleRoot,
        preflightPath: options.preflightPath
    });
    if (!preflightPath) {
        return unavailable(unavailableReason || 'latest preflight artifact missing');
    }
    let preflight: Record<string, unknown>;
    try {
        const parsed = JSON.parse(readTextFile(preflightPath));
        if (!isRecord(parsed)) {
            return unavailable('latest preflight artifact is not an object');
        }
        preflight = parsed;
    } catch {
        return unavailable('latest preflight artifact is invalid JSON');
    }

    const workflowConfigPath = options.workflowConfigPath
        ? path.resolve(options.workflowConfigPath)
        : getWorkflowConfigPath(bundleRoot);
    let rawScopeBudgetGuard: unknown = DEFAULT_SCOPE_BUDGET_GUARD_CONFIG;
    if (pathExists(workflowConfigPath)) {
        try {
            const workflowConfig = JSON.parse(readTextFile(workflowConfigPath));
            rawScopeBudgetGuard = isRecord(workflowConfig) && workflowConfig.scope_budget_guard !== undefined
                ? workflowConfig.scope_budget_guard
                : DEFAULT_SCOPE_BUDGET_GUARD_CONFIG;
        } catch {
            return unavailable('workflow config is invalid JSON');
        }
    }

    const budgetForecast = isRecord(preflight.budget_forecast) ? preflight.budget_forecast : {};
    const changedFilesCount = readScopeBudgetChangedFilesCount(preflight);
    const changedLinesTotal = readScopeBudgetChangedLinesTotal(preflight);
    const requiredReviewCount = countRequiredReviews(preflight, budgetForecast);
    const totalEstimatedReviewTokens = toNumber(budgetForecast.total_estimated_review_tokens) ?? 0;
    const evaluation = evaluateScopeBudgetGuard(normalizeScopeBudgetGuardConfig(rawScopeBudgetGuard), {
        profileName: readProfileName(preflight),
        changedFilesCount,
        changedLinesTotal,
        requiredReviewCount,
        totalEstimatedReviewTokens
    });
    return {
        status: evaluation.status,
        summary_line: evaluation.summary_line,
        profile_name: evaluation.profile_name,
        preflight_path: preflightPath,
        preflight_sha256: sha256File(preflightPath),
        changed_files_count: changedFilesCount,
        changed_lines_total: changedLinesTotal,
        required_review_count: requiredReviewCount,
        total_estimated_review_tokens: totalEstimatedReviewTokens,
        violations: evaluation.violations,
        continuation_allowed: evaluation.continuation_allowed,
        unavailable_reason: null
    };
}
