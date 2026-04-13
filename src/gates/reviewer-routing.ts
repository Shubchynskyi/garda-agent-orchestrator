import * as fs from 'node:fs';
import * as path from 'node:path';
import { SOURCE_OF_TRUTH_VALUES, resolveBundleName } from '../core/constants';
import { getTaskModeEvidence } from './task-mode';

export type ReviewerExecutionMode = 'delegated_subagent' | 'same_agent_fallback';
export type ReviewerCapabilityLevel = 'delegation_required' | 'delegation_conditional' | 'single_agent_only' | 'unknown';

export interface ReviewerRoutingPolicy {
    source_of_truth: string | null;
    capability_level: ReviewerCapabilityLevel;
    delegation_required: boolean;
    fallback_allowed: boolean;
    fallback_reason_required: boolean;
    expected_execution_mode: ReviewerExecutionMode;
    note: string;
}

export function normalizeSourceOfTruthValue(value: unknown): string | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const match = SOURCE_OF_TRUTH_VALUES.find((candidate) => candidate.toLowerCase() === text.toLowerCase());
    return match || null;
}

export function resolveReviewerRoutingPolicy(sourceOfTruth: unknown): ReviewerRoutingPolicy {
    const normalized = normalizeSourceOfTruthValue(sourceOfTruth);
    switch (normalized) {
        case 'Codex':
        case 'Claude':
        case 'GitHubCopilot':
            return {
                source_of_truth: normalized,
                capability_level: 'delegation_required',
                delegation_required: true,
                fallback_allowed: false,
                fallback_reason_required: false,
                expected_execution_mode: 'delegated_subagent',
                note: `${normalized} is treated as delegation-capable. Same-agent fallback is invalid for required reviews.`
            };
        case 'Windsurf':
        case 'Junie':
        case 'Antigravity':
            return {
                source_of_truth: normalized,
                capability_level: 'delegation_conditional',
                delegation_required: false,
                fallback_allowed: true,
                fallback_reason_required: true,
                expected_execution_mode: 'delegated_subagent',
                note: `${normalized} should delegate when provider sub-agent support is available; fallback requires an explicit reason.`
            };
        case 'Gemini':
        case 'Qwen':
            return {
                source_of_truth: normalized,
                capability_level: 'single_agent_only',
                delegation_required: false,
                fallback_allowed: true,
                fallback_reason_required: true,
                expected_execution_mode: 'same_agent_fallback',
                note: `${normalized} is treated as single-agent for review routing. Fallback receipts must still include reviewer_fallback_reason.`
            };
        default:
            return {
                source_of_truth: normalized,
                capability_level: 'unknown',
                delegation_required: false,
                fallback_allowed: true,
                fallback_reason_required: true,
                expected_execution_mode: 'same_agent_fallback',
                note: 'Provider delegation capability is unknown. Fallback is allowed only with an explicit reason.'
            };
    }
}

export function readSourceOfTruthFromInitAnswers(repoRoot: string): string | null {
    const initAnswersPath = path.join(path.resolve(repoRoot), resolveBundleName(), 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return null;
    }
    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        return normalizeSourceOfTruthValue(payload.SourceOfTruth);
    } catch {
        return null;
    }
}

export function readRuntimeReviewerProvider(repoRoot: string, taskId?: string | null): string | null {
    const normalizedTaskId = String(taskId || '').trim();
    if (normalizedTaskId) {
        const taskMode = getTaskModeEvidence(repoRoot, normalizedTaskId);
        const providerFromTaskMode = normalizeSourceOfTruthValue(taskMode.provider);
        if (providerFromTaskMode) {
            return providerFromTaskMode;
        }
    }

    const providerFromInitAnswers = readSourceOfTruthFromInitAnswers(repoRoot);
    if (providerFromInitAnswers) {
        return providerFromInitAnswers;
    }

    return null;
}
