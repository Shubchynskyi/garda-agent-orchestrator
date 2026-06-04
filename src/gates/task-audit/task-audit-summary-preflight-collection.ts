import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256 } from '../shared/helpers';
import type { ProfileReviewDecisionSummary } from './task-audit-summary-collectors';
import { safeReadJson } from './task-audit-summary-collectors';

export interface PreflightSummary {
    path: string;
    sha256: string | null;
    raw: Record<string, unknown> | null;
    changedFiles: string[];
    changedFilesCount: number;
    changedLinesTotal: number;
    requiredReviews: Record<string, boolean>;
    scopeCategory: string | null;
    pathMode: string | null;
}

export function readPreflightSummary(reviewsRoot: string, taskId: string): PreflightSummary {
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflight = safeReadJson(preflightPath);
    const requiredReviews: Record<string, boolean> = {};

    if (preflight?.required_reviews && typeof preflight.required_reviews === 'object') {
        for (const [key, value] of Object.entries(preflight.required_reviews as Record<string, unknown>)) {
            requiredReviews[key] = value === true;
        }
    }

    const changedFiles = Array.isArray(preflight?.changed_files)
        ? preflight.changed_files.map((changedFile: unknown) => String(changedFile))
        : [];
    const metrics = preflight?.metrics && typeof preflight.metrics === 'object'
        ? preflight.metrics as Record<string, unknown>
        : null;

    return {
        path: preflightPath,
        sha256: fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null,
        raw: preflight,
        changedFiles,
        changedFilesCount: changedFiles.length,
        changedLinesTotal: metrics ? Number(metrics.changed_lines_total) || 0 : 0,
        requiredReviews,
        scopeCategory: typeof preflight?.scope_category === 'string' ? preflight.scope_category : null,
        pathMode: typeof preflight?.mode === 'string' && preflight.mode.trim() ? preflight.mode.trim() : null
    };
}

export function readProfileReviewDecisions(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null,
    scopeCategory: string | null
): ProfileReviewDecisionSummary | null {
    if (!taskMode || typeof taskMode.active_profile !== 'string' || !taskMode.active_profile) {
        return null;
    }

    const baseSummary = {
        profile_name: String(taskMode.active_profile || ''),
        scope_category: scopeCategory
    };
    const guardrails = preflight?.profile_guardrails && typeof preflight.profile_guardrails === 'object'
        ? preflight.profile_guardrails as Record<string, unknown>
        : null;

    if (!guardrails) {
        return {
            ...baseSummary,
            guardrails_active: false,
            lightening_eligible: false,
            safety_floors_applied: [],
            decisions: []
        };
    }

    const decisions = Array.isArray(guardrails.decisions)
        ? guardrails.decisions.flatMap((decision): Array<{ review_type: string; effective_value: boolean; decision: string }> => {
            if (!decision || typeof decision !== 'object') {
                return [];
            }
            const record = decision as Record<string, unknown>;
            return [{
                review_type: String(record.review_type || ''),
                effective_value: record.effective_value === true,
                decision: String(record.decision || '')
            }];
        })
        : [];
    const safetyFloorsApplied = Array.isArray(guardrails.safety_floors_applied)
        ? guardrails.safety_floors_applied.map((entry) => String(entry))
        : [];

    return {
        ...baseSummary,
        guardrails_active: guardrails.guardrails_active === true,
        lightening_eligible: guardrails.lightening_eligible === true,
        safety_floors_applied: safetyFloorsApplied,
        decisions
    };
}
