import * as fs from 'node:fs';

import { assertValidTaskId } from '../../../../gate-runtime/timeline/task-events-helpers';
import { validatePreflightForReview } from '../../../../gates/required-reviews/required-reviews-check';
import { getRulePackEvidence } from '../../../../gates/rule-pack/rule-pack';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { getTaskModeEvidence } from '../../../../gates/task-mode/task-mode';
import { requireResolvedPath } from '../../shared-command-utils';
import { isPlainObject } from '../compile/gate-flow-helpers';
import {
    runGateFlowPreflightPipelineSync
} from '../support/gate-flow-preflight-pipeline';
import {
    evaluateGateFlowTimelineReadiness,
    resolveGateFlowTimelinePath
} from '../support/gate-flow-runtime';

type TaskModeEvidence = ReturnType<typeof getTaskModeEvidence>;
type RulePackEvidence = ReturnType<typeof getRulePackEvidence>;
type TimelineReadiness = ReturnType<typeof evaluateGateFlowTimelineReadiness>;
type ValidatedPreflightBase = ReturnType<typeof validatePreflightForReview>;

export interface ReviewFlowPreflightPipelineInput {
    readonly repoRoot: string;
    readonly orchestratorRoot: string;
    readonly taskId: string;
    readonly preflightPath?: string;
    readonly taskModePath?: string;
    readonly rulePackPath?: string;
}

interface ReviewFlowValidatedPreflight extends ValidatedPreflightBase {
    readonly mode: string;
    readonly changed_files_count: number;
    readonly changed_lines_total: number;
}

interface ReviewFlowParsedPreflight {
    readonly resolvedPreflightPath: string;
    readonly resolvedTaskId: string | null;
    readonly timelinePath: string | null;
}

interface ReviewFlowLoadedPreflight {
    readonly preflight: Record<string, unknown>;
    readonly validatedPreflight: ReviewFlowValidatedPreflight;
}

interface ReviewFlowTimelineEvidence {
    readonly rulePackEvidence: RulePackEvidence;
    readonly timelineReadiness: TimelineReadiness | null;
}

export interface ReviewFlowPreflightPipelineOutput
    extends ReviewFlowParsedPreflight, ReviewFlowLoadedPreflight {
    readonly rulePackEvidence: RulePackEvidence;
    readonly taskModeEvidence: TaskModeEvidence;
    readonly timelineReadiness: TimelineReadiness | null;
}

export class ReviewFlowPreflightPathEscapeError extends Error {
    constructor(readonly resolvedPreflightPath: string) {
        super('Review preflight path escapes the repository root.');
        this.name = 'ReviewFlowPreflightPathEscapeError';
    }
}

function buildValidatedPreflight(validatedBase: ValidatedPreflightBase): {
    preflight: Record<string, unknown>;
    validatedPreflight: ReviewFlowValidatedPreflight;
} {
    const preflight = isPlainObject(validatedBase.preflight) ? validatedBase.preflight : {};
    const preflightMetrics = isPlainObject(preflight.metrics) ? preflight.metrics : null;
    return {
        preflight,
        validatedPreflight: {
            ...validatedBase,
            mode: String(preflight.mode || 'FULL_PATH').trim() || 'FULL_PATH',
            changed_files_count: Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0,
            changed_lines_total: preflightMetrics && typeof preflightMetrics.changed_lines_total === 'number'
                ? preflightMetrics.changed_lines_total
                : 0
        }
    };
}

function tryResolveTaskId(value: unknown): string | null {
    const candidate = String(value || '').trim();
    if (!candidate) return null;
    try {
        return assertValidTaskId(candidate);
    } catch {
        return null;
    }
}

function resolveTaskIdForTaskMode(preflightPath: string, explicitTaskId: string): string | null {
    const explicitResolvedTaskId = tryResolveTaskId(explicitTaskId);
    if (explicitResolvedTaskId) return explicitResolvedTaskId;
    try {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as unknown;
        return isPlainObject(preflight) ? tryResolveTaskId(preflight.task_id) : null;
    } catch {
        return null;
    }
}

export function runReviewFlowPreflightPipeline(
    input: ReviewFlowPreflightPipelineInput
): ReviewFlowPreflightPipelineOutput {
    return runGateFlowPreflightPipelineSync(input, {
        parse(currentInput) {
            const resolvedPreflightPath = requireResolvedPath(
                gateHelpers.resolvePathInsideRepo(
                    String(currentInput.preflightPath || '').trim(),
                    currentInput.repoRoot
                ),
                'PreflightPath'
            );
            if (!gateHelpers.isPathRealpathInsideRoot(resolvedPreflightPath, currentInput.repoRoot)) {
                throw new ReviewFlowPreflightPathEscapeError(resolvedPreflightPath);
            }
            const resolvedTaskId = resolveTaskIdForTaskMode(
                resolvedPreflightPath,
                currentInput.taskId
            );
            return {
                resolvedPreflightPath,
                resolvedTaskId,
                timelinePath: resolvedTaskId
                    ? gateHelpers.normalizePath(resolveGateFlowTimelinePath(currentInput.repoRoot, resolvedTaskId))
                    : null
            };
        },
        loadTaskModeEvidence({ input: currentInput, parsed }) {
            return getTaskModeEvidence(
                currentInput.repoRoot,
                parsed.resolvedTaskId,
                String(currentInput.taskModePath || '')
            );
        },
        loadPreflight({ input: currentInput, parsed }) {
            return buildValidatedPreflight(
                validatePreflightForReview(
                    parsed.resolvedPreflightPath,
                    currentInput.taskId,
                    String(currentInput.taskModePath || '')
                )
            );
        },
        evaluateTimelineReadiness({ input: currentInput, parsed, preflight }) {
            const resolvedTaskId = preflight.validatedPreflight.resolved_task_id;
            const rulePackEvidence = getRulePackEvidence(
                currentInput.repoRoot,
                resolvedTaskId,
                'POST_PREFLIGHT',
                {
                    artifactPath: String(currentInput.rulePackPath || ''),
                    preflightPath: preflight.validatedPreflight.preflight_path,
                    taskModePath: String(currentInput.taskModePath || '')
                }
            );
            if (!parsed.timelinePath || !resolvedTaskId) {
                return { rulePackEvidence, timelineReadiness: null };
            }
            return {
                rulePackEvidence,
                timelineReadiness: evaluateGateFlowTimelineReadiness({
                    orchestratorRoot: currentInput.orchestratorRoot,
                    repoRoot: currentInput.repoRoot,
                    taskId: resolvedTaskId,
                    timelinePath: parsed.timelinePath,
                    requirements: [
                        { eventType: 'TASK_MODE_ENTERED', recoveryInstruction: 'Run enter-task-mode before review gate.' },
                        { eventType: 'RULE_PACK_LOADED', recoveryInstruction: 'Run load-rule-pack before review gate.' },
                        {
                            eventType: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                            recoveryInstruction: 'Run handshake-diagnostics before review gate.'
                        },
                        {
                            eventType: 'SHELL_SMOKE_PREFLIGHT_RECORDED',
                            recoveryInstruction: 'Run shell-smoke-preflight before review gate.'
                        }
                    ]
                })
            };
        },
        emit({ parsed, taskModeEvidence, preflight, timelineReadiness }: {
            parsed: ReviewFlowParsedPreflight;
            taskModeEvidence: TaskModeEvidence;
            preflight: ReviewFlowLoadedPreflight;
            timelineReadiness: ReviewFlowTimelineEvidence;
        }) {
            return {
                ...parsed,
                ...preflight,
                rulePackEvidence: timelineReadiness.rulePackEvidence,
                taskModeEvidence,
                timelineReadiness: timelineReadiness.timelineReadiness
            };
        }
    });
}
