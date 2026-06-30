import {
    isTaskQueueDecomposedStatus,
    isTaskQueueDoneStatus,
    isTaskQueueSplitRequiredStatus
} from '../../core/active-task-state';
import {
    extractExplicitLinkedChildTaskIds,
    hasLinkedChildTasks,
    isDecomposedParentTask,
    resolveDecomposedParentCompletionState,
    resolveNextUnfinishedChildRoute,
    type TaskQueueEntry
} from './next-step-task-queue';
import {
    buildCommand,
    toRepoDisplayPath
} from './next-step-command-formatters';
import {
    restoreSplitRequiredParentFromPermanentLatch,
    transitionDecomposedParentsToDone,
    transitionSplitRequiredParentToDecomposed
} from './next-step-task-queue-transitions';
import {
    resolveDecomposedParentTerminalRoute,
    resolveDoneTaskQueueTerminalRoute,
    resolvePermanentSplitRequiredLatchRoute,
    resolveSplitRequiredTaskQueueRoute
} from './next-step-terminal-status-routing';
import {
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasGateOwnedDecomposedParentCompletionEvidence,
    hasSplitRequiredClearedEvidence,
    readSplitRequiredLatchEvidence
} from './next-step-split-required-latch';
import {
    readFullSuiteRepairTaskMaterializationEvidence
} from '../full-suite/full-suite-repair-task';
import {
    resolveNextStepFullSuiteValidationRoute,
    type NextStepFullSuiteValidationRoutingOptions
} from './next-step-full-suite-routing';
import {
    resolveDelegatedReviewReadinessRoute,
    type DelegatedReviewReadinessRouteOptions
} from './next-step-review-readiness-routing';
import type {
    NextStepArtifactState,
    NextStepCommand,
    NextStepFinalReportSummary,
    NextStepStatus
} from './next-step';

export interface NextStepDecisionRoutePayload {
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts?: NextStepArtifactState[];
    presentArtifacts?: NextStepArtifactState[];
    finalReport?: NextStepFinalReportSummary | null;
}

export function resolveFullSuiteDecisionRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepDecisionRoutePayload | null {
    const route = resolveNextStepFullSuiteValidationRoute(options);
    return route
        ? {
            status: route.status,
            nextGate: route.nextGate,
            title: route.title,
            reason: route.reason,
            commands: route.commands
        }
        : null;
}

export function resolveDelegatedReviewDecisionRoute(
    options: DelegatedReviewReadinessRouteOptions
): NextStepDecisionRoutePayload | null {
    const route = resolveDelegatedReviewReadinessRoute(options);
    return route
        ? {
            status: route.status,
            nextGate: route.nextGate,
            title: route.title,
            reason: route.reason,
            commands: route.commands
        }
        : null;
}

function buildContinueChildCommand(
    cliPrefix: string,
    childRoute: { taskId: string } | null
): NextStepCommand | null {
    return childRoute
        ? buildCommand(
            'Continue child task',
            `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
        )
        : null;
}

function isSuccessfulStatusSync(summary: { outcome: string }): boolean {
    return summary.outcome === 'updated' || summary.outcome === 'already_synced';
}

function resolveCompletedFullSuiteRepairWipRestoreRoute(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    cliPrefix: string;
    taskEntries: Map<string, TaskQueueEntry>;
    taskEntry: TaskQueueEntry | null;
    fullSuiteArtifactPath?: string;
}): NextStepDecisionRoutePayload | null {
    if (!options.fullSuiteArtifactPath) {
        return null;
    }
    const childTaskIds = extractExplicitLinkedChildTaskIds(
        options.taskEntry?.notes || null,
        options.taskEntries.keys()
    ).filter((childTaskId) => childTaskId !== options.taskId);
    for (const childTaskId of childTaskIds) {
        const childEntry = options.taskEntries.get(childTaskId);
        if (!childEntry || !isTaskQueueDoneStatus(childEntry.status)) {
            continue;
        }
        const evidence = readFullSuiteRepairTaskMaterializationEvidence({
            repoRoot: options.repoRoot,
            reviewsRoot: options.reviewsRoot,
            taskId: options.taskId,
            fullSuiteArtifactPath: options.fullSuiteArtifactPath,
            childTaskId
        });
        if (!evidence.materialized || !evidence.wip_manifest_path) {
            continue;
        }
        const fullSuiteArtifactPath = toRepoDisplayPath(options.repoRoot, options.fullSuiteArtifactPath);
        const restoreBindingFlags =
            `--task-id "${options.taskId}" ` +
            `--full-suite-artifact-path "${fullSuiteArtifactPath}" ` +
            `--child-task-id "${childTaskId}"`;
        return {
            status: 'BLOCKED',
            nextGate: 'restore-full-suite-repair-wip',
            title: 'Restore suspended full-suite repair WIP before resuming parent.',
            reason:
                `Linked full-suite repair child ${childTaskId} is DONE and materialized repair evidence is current. ` +
                'Restore the suspended parent WIP before running parent classify, compile, review, full-suite, completion, or final closeout gates. ' +
                'The restore gate validates manifest paths, artifact hashes, stale base, tracked workspace cleanliness, and untracked target conflicts before applying the parent WIP.',
            commands: [
                buildCommand(
                    'Dry-run full-suite repair WIP restore',
                    `${options.cliPrefix} gate restore-full-suite-repair-wip ${restoreBindingFlags} --manifest-path "${evidence.wip_manifest_path}" --dry-run --repo-root "."`
                ),
                buildCommand(
                    'Restore full-suite repair WIP and resume parent',
                    `${options.cliPrefix} gate restore-full-suite-repair-wip ${restoreBindingFlags} --manifest-path "${evidence.wip_manifest_path}" --repo-root "."`
                )
            ],
            missingArtifacts: [],
            finalReport: null
        };
    }
    return null;
}

export function resolveTaskQueueTerminalDecisionRoute(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    cliPrefix: string;
    taskEntries: Map<string, TaskQueueEntry>;
    taskEntry: TaskQueueEntry | null;
    completionGatePassed: boolean;
    latestCompletionCurrent: boolean;
    finalReportContractReady: boolean;
    finalReportContractBlocker: string | null;
    summaryBlockers: readonly string[];
    filteredMissingArtifacts: NextStepArtifactState[];
    corePresentArtifacts: NextStepArtifactState[];
    fullSuiteArtifactPath?: string;
}): NextStepDecisionRoutePayload | null {
    const taskQueueStatus = options.taskEntry?.status || null;
    const splitRequiredStatusInTaskQueue = isTaskQueueSplitRequiredStatus(taskQueueStatus);
    const permanentSplitRequiredLatchEvidence = splitRequiredStatusInTaskQueue
        ? null
        : readSplitRequiredLatchEvidence({
            reviewsRoot: options.reviewsRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId
        });
    const decomposedStatusHasClearedLatchEvidence =
        isTaskQueueDecomposedStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasSplitRequiredClearedEvidence({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    const doneStatusHasCompletedClearedLatchEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    const doneStatusHasGateOwnedDecomposedParentCompletionEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && hasGateOwnedDecomposedParentCompletionEvidence({
            eventsRoot: options.eventsRoot,
            taskId: options.taskId
        });
    const doneStatusHasGateOwnedCompletionEvidence = doneStatusHasCompletedClearedLatchEvidence
        || doneStatusHasGateOwnedDecomposedParentCompletionEvidence;

    if (
        !splitRequiredStatusInTaskQueue
        && !decomposedStatusHasClearedLatchEvidence
        && !doneStatusHasGateOwnedCompletionEvidence
        && permanentSplitRequiredLatchEvidence?.valid
    ) {
        const restoreResult = restoreSplitRequiredParentFromPermanentLatch({
            repoRoot: options.repoRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });

        const childRoute = resolveNextUnfinishedChildRoute(
            options.taskEntries,
            options.taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(options.taskEntries, options.taskId);
        let syncResult: ReturnType<typeof transitionSplitRequiredParentToDecomposed> | null = null;
        if (hasChildren && isSuccessfulStatusSync(restoreResult)) {
            syncResult = transitionSplitRequiredParentToDecomposed({
                repoRoot: options.repoRoot,
                eventsRoot: options.eventsRoot,
                taskId: options.taskId
            });
        }

        const latchRoute = resolvePermanentSplitRequiredLatchRoute({
            taskId: options.taskId,
            restoreResult: {
                outcome: restoreResult.outcome,
                errorMessage: restoreResult.error_message
            },
            hasChildren,
            transitionResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                }
                : null,
            childRoute,
            continueChildCommand: buildContinueChildCommand(options.cliPrefix, childRoute)
        });
        return {
            status: latchRoute.status,
            nextGate: latchRoute.nextGate,
            title: latchRoute.title,
            reason: latchRoute.reason,
            commands: latchRoute.commands,
            missingArtifacts: [],
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    if (splitRequiredStatusInTaskQueue) {
        const latchEvidence = readSplitRequiredLatchEvidence({
            reviewsRoot: options.reviewsRoot,
            eventsRoot: options.eventsRoot,
            taskId: options.taskId
        });
        const childRoute = resolveNextUnfinishedChildRoute(
            options.taskEntries,
            options.taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(options.taskEntries, options.taskId);
        if (hasChildren && !childRoute) {
            const repairRestoreRoute = resolveCompletedFullSuiteRepairWipRestoreRoute({
                repoRoot: options.repoRoot,
                reviewsRoot: options.reviewsRoot,
                taskId: options.taskId,
                cliPrefix: options.cliPrefix,
                taskEntries: options.taskEntries,
                taskEntry: options.taskEntry,
                fullSuiteArtifactPath: options.fullSuiteArtifactPath
            });
            if (repairRestoreRoute) {
                return {
                    ...repairRestoreRoute,
                    presentArtifacts: options.corePresentArtifacts
                };
            }
        }
        const syncResult = latchEvidence.valid && hasChildren
            ? transitionSplitRequiredParentToDecomposed({
                repoRoot: options.repoRoot,
                eventsRoot: options.eventsRoot,
                taskId: options.taskId
            })
            : null;
        const splitRoute = resolveSplitRequiredTaskQueueRoute({
            taskId: options.taskId,
            latchValid: latchEvidence.valid,
            latchInvalidReason: latchEvidence.reason,
            hasChildren,
            transitionResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                }
                : null,
            childRoute,
            continueChildCommand: buildContinueChildCommand(options.cliPrefix, childRoute)
        });
        return {
            status: splitRoute.status,
            nextGate: splitRoute.nextGate,
            title: splitRoute.title,
            reason: splitRoute.reason,
            commands: splitRoute.commands,
            missingArtifacts: [],
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    if (
        isTaskQueueDoneStatus(taskQueueStatus)
        && options.completionGatePassed
        && options.latestCompletionCurrent
    ) {
        return null;
    }

    if (isTaskQueueDoneStatus(taskQueueStatus)) {
        const doneConflictBlockers = [...options.summaryBlockers];
        if (!options.completionGatePassed) {
            doneConflictBlockers.unshift('completion-gate: missing or not passed');
        } else if (!options.latestCompletionCurrent) {
            doneConflictBlockers.unshift('completion-gate: pass exists but is stale for the current task cycle');
        }
        if (!options.finalReportContractReady) {
            doneConflictBlockers.push(
                `final-closeout: ${options.finalReportContractBlocker || 'canonical final closeout is not ready'}`
            );
        }
        const doneRoute = resolveDoneTaskQueueTerminalRoute({
            taskId: options.taskId,
            conflictBlockers: doneConflictBlockers,
            allowCompletedClearedLatchEvidence: doneStatusHasGateOwnedCompletionEvidence,
            reopenPreviewCommand: buildCommand(
                'Preview explicit operator reopen',
                `${options.cliPrefix} gate task-reset --task-id "${options.taskId}" --reopen --dry-run --repo-root "."`
            )
        });
        return {
            status: doneRoute.status,
            nextGate: doneRoute.nextGate,
            title: doneRoute.title,
            reason: doneRoute.reason,
            commands: doneRoute.commands,
            missingArtifacts: doneRoute.status === 'DONE' ? [] : options.filteredMissingArtifacts,
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    if (!options.completionGatePassed && isDecomposedParentTask(options.taskEntry)) {
        const completionState = isTaskQueueDecomposedStatus(taskQueueStatus)
            ? resolveDecomposedParentCompletionState(
                options.taskEntries,
                options.taskId,
                new Set<string>(),
                extractExplicitLinkedChildTaskIds
            )
            : null;
        const childRoute = completionState?.unfinishedRoute || resolveNextUnfinishedChildRoute(
            options.taskEntries,
            options.taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const decomposedReason = isTaskQueueDecomposedStatus(taskQueueStatus)
            ? 'Task queue marks this parent as DECOMPOSED.'
            : 'Task queue marks this parent as a legacy BLOCKED split umbrella.';
        const tasksToComplete = completionState?.hasLinkedChildren && completionState.complete
            ? [...new Set([...completionState.completedDecomposedTaskIds, options.taskId])]
            : [];
        if (completionState?.hasLinkedChildren && completionState.complete) {
            const repairRestoreRoute = resolveCompletedFullSuiteRepairWipRestoreRoute({
                repoRoot: options.repoRoot,
                reviewsRoot: options.reviewsRoot,
                taskId: options.taskId,
                cliPrefix: options.cliPrefix,
                taskEntries: options.taskEntries,
                taskEntry: options.taskEntry,
                fullSuiteArtifactPath: options.fullSuiteArtifactPath
            });
            if (repairRestoreRoute) {
                return {
                    ...repairRestoreRoute,
                    presentArtifacts: options.corePresentArtifacts
                };
            }
        }
        const syncResult = tasksToComplete.length > 0
            ? transitionDecomposedParentsToDone({
                repoRoot: options.repoRoot,
                eventsRoot: options.eventsRoot,
                rootTaskId: options.taskId,
                taskIds: tasksToComplete
            })
            : null;
        const decomposedRoute = resolveDecomposedParentTerminalRoute({
            taskId: options.taskId,
            decomposedReason,
            childRoute,
            continueChildCommand: buildContinueChildCommand(options.cliPrefix, childRoute),
            hasLinkedChildren: completionState?.hasLinkedChildren || false,
            missingChildTaskIds: completionState?.missingChildTaskIds || [],
            complete: completionState?.complete || false,
            statusSyncResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message,
                    taskIds: syncResult.task_ids
                }
                : null
        });
        return {
            status: decomposedRoute.status,
            nextGate: decomposedRoute.nextGate,
            title: decomposedRoute.title,
            reason: decomposedRoute.reason,
            commands: decomposedRoute.commands,
            missingArtifacts: [],
            presentArtifacts: options.corePresentArtifacts,
            finalReport: null
        };
    }

    return null;
}
