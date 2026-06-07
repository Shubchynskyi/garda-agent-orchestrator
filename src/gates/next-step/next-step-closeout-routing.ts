export interface CloseoutRoutingCommand {
    label: string;
    command: string;
}

export interface CloseoutRoutingRoute {
    status: 'BLOCKED' | 'READY' | 'DONE';
    nextGate: string | null;
    title: string;
    reason: string;
    commands: CloseoutRoutingCommand[];
    finalReport?: unknown | null;
}

export interface RequiredReviewsCheckCloseoutOptions {
    requiredReviewsGatePassed: boolean;
    zeroDiffNoReviewCloseout: boolean;
    command: CloseoutRoutingCommand;
}

export interface DocImpactCloseoutOptions {
    docImpactGatePassed: boolean;
    compatibilityHint: string;
    command: CloseoutRoutingCommand;
}

export interface FullSuiteCloseoutOptions {
    enabled: boolean;
    gatePassed: boolean;
    notRequiredForDocsOnly: boolean;
    placement: string;
    configPath: string;
    commandText: string;
    timeoutForecastLine: string | null;
    command: CloseoutRoutingCommand;
}

export interface ProjectMemoryCloseoutOptions {
    required: boolean;
    evidenceCurrent: boolean;
    visibleSummaryLine: string;
    affectedMemoryFiles: readonly string[];
    violations: readonly string[];
    command: CloseoutRoutingCommand;
}

export interface CompletionCloseoutOptions {
    completionGatePassed: boolean;
    command: CloseoutRoutingCommand;
}

export interface PostReviewCloseoutRoutingOptions {
    requiredReviews: RequiredReviewsCheckCloseoutOptions;
    docImpact: DocImpactCloseoutOptions;
    fullSuite: FullSuiteCloseoutOptions;
    projectMemory: ProjectMemoryCloseoutOptions;
    completion: CompletionCloseoutOptions;
}

export interface PostReviewCloseoutRouteState {
    requiredReviewsGatePassed: boolean;
    zeroDiffNoReviewCloseout: boolean;
    requiredReviewsCommand: string;
    docImpactGatePassed: boolean;
    docImpactCompatibilityHint: string;
    docImpactCommand: string;
    fullSuiteEnabled: boolean;
    fullSuiteGatePassed: boolean;
    fullSuiteNotRequiredForDocsOnly: boolean;
    fullSuitePlacement: string;
    fullSuiteConfigPath: string;
    fullSuiteCommandText: string;
    fullSuiteTimeoutForecastLine: string | null;
    fullSuiteCommand: string;
    projectMemoryRequired: boolean;
    projectMemoryEvidenceCurrent: boolean;
    projectMemoryVisibleSummaryLine: string;
    projectMemoryAffectedMemoryFiles: readonly string[];
    projectMemoryViolations: readonly string[];
    projectMemoryCommand: string;
    completionGatePassed: boolean;
    completionCommand: string;
}

function closeoutCommand(label: string, command: string): CloseoutRoutingCommand {
    return { label, command };
}

function docImpactCommandClaimsProjectMemoryEvidence(command: string): boolean {
    return /\s--project-memory-(updated|update-not-needed)\s+true(?:\s|$)/.test(` ${command} `);
}

function buildProjectMemoryImpactRoute(options: PostReviewCloseoutRoutingOptions): CloseoutRoutingRoute {
    const staleDetails = options.projectMemory.violations.length > 0
        ? ` Violations: ${options.projectMemory.violations.join('; ')}`
        : '';
    const affectedFiles = options.projectMemory.affectedMemoryFiles.length > 0
        ? ` Affected memory files: ${options.projectMemory.affectedMemoryFiles.join(', ')}.`
        : '';
    return {
        status: 'BLOCKED',
        nextGate: 'project-memory-impact',
        title: 'Record project memory impact.',
        reason:
            `Project memory maintenance is enabled before final closeout (${options.projectMemory.visibleSummaryLine}). ` +
            `Record current project-memory impact evidence after upstream validation and before completion.${affectedFiles}${staleDetails}`,
        commands: [options.projectMemory.command]
    };
}

export function resolvePostReviewCloseoutRouteFromState(
    state: PostReviewCloseoutRouteState
): CloseoutRoutingRoute {
    return resolvePostReviewCloseoutRoute({
        requiredReviews: {
            requiredReviewsGatePassed: state.requiredReviewsGatePassed,
            zeroDiffNoReviewCloseout: state.zeroDiffNoReviewCloseout,
            command: closeoutCommand('Run required reviews check', state.requiredReviewsCommand)
        },
        docImpact: {
            docImpactGatePassed: state.docImpactGatePassed,
            compatibilityHint: state.docImpactCompatibilityHint,
            command: closeoutCommand('Run doc impact gate', state.docImpactCommand)
        },
        fullSuite: {
            enabled: state.fullSuiteEnabled,
            gatePassed: state.fullSuiteGatePassed,
            notRequiredForDocsOnly: state.fullSuiteNotRequiredForDocsOnly,
            placement: state.fullSuitePlacement,
            configPath: state.fullSuiteConfigPath,
            commandText: state.fullSuiteCommandText,
            timeoutForecastLine: state.fullSuiteTimeoutForecastLine,
            command: closeoutCommand(
                state.fullSuiteNotRequiredForDocsOnly ? 'Record full-suite not required' : 'Run full-suite validation',
                state.fullSuiteCommand
            )
        },
        projectMemory: {
            required: state.projectMemoryRequired,
            evidenceCurrent: state.projectMemoryEvidenceCurrent,
            visibleSummaryLine: state.projectMemoryVisibleSummaryLine,
            affectedMemoryFiles: state.projectMemoryAffectedMemoryFiles,
            violations: state.projectMemoryViolations,
            command: closeoutCommand('Run project memory impact gate', state.projectMemoryCommand)
        },
        completion: {
            completionGatePassed: state.completionGatePassed,
            command: closeoutCommand('Run completion gate', state.completionCommand)
        }
    });
}

export function resolvePostReviewCloseoutRoute(
    options: PostReviewCloseoutRoutingOptions
): CloseoutRoutingRoute {
    if (!options.requiredReviews.requiredReviewsGatePassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'required-reviews-check',
            title: options.requiredReviews.zeroDiffNoReviewCloseout
                ? 'Validate zero-diff no-review closeout.'
                : 'Run required reviews check.',
            reason: options.requiredReviews.zeroDiffNoReviewCloseout
                ? 'Profile-forced reviews were suppressed because the current preflight is BASELINE_ONLY with no reviewable diff; required-reviews-check must validate audited no-op evidence before closeout.'
                : 'All required review artifacts appear present, but the review gate has not validated them.',
            commands: [options.requiredReviews.command]
        };
    }

    if (options.fullSuite.enabled && !options.fullSuite.gatePassed) {
        if (options.fullSuite.notRequiredForDocsOnly) {
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Record full-suite validation as not required.',
                reason:
                    `Effective workflow config enables full-suite validation at ${options.fullSuite.configPath}, ` +
                    'but the current scope is docs-only. Record a SKIPPED/NOT_REQUIRED artifact instead of running the configured full-suite command.',
                commands: [options.fullSuite.command]
            };
        }
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: options.fullSuite.placement === 'before_completion'
                ? 'Run full-suite validation before completion.'
                : 'Run full-suite validation.',
            reason:
                `Effective workflow config enables full-suite validation at ${options.fullSuite.configPath} with placement '${options.fullSuite.placement}'. ` +
                `Command: ${options.fullSuite.commandText}. ${options.fullSuite.timeoutForecastLine || ''}`.trim(),
            commands: [options.fullSuite.command]
        };
    }

    if (
        options.projectMemory.required
        && !options.projectMemory.evidenceCurrent
        && !options.docImpact.docImpactGatePassed
        && docImpactCommandClaimsProjectMemoryEvidence(options.docImpact.command.command)
    ) {
        return buildProjectMemoryImpactRoute(options);
    }

    if (!options.docImpact.docImpactGatePassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'doc-impact-gate',
            title: 'Record documentation impact.',
            reason: `Completion requires an explicit docs decision. ${options.docImpact.compatibilityHint}`,
            commands: [options.docImpact.command]
        };
    }

    if (options.projectMemory.required && !options.projectMemory.evidenceCurrent) {
        return buildProjectMemoryImpactRoute(options);
    }

    if (!options.completion.completionGatePassed) {
        return {
            status: 'BLOCKED',
            nextGate: 'completion-gate',
            title: 'Run completion gate.',
            reason: 'All upstream gates appear ready; completion has not finalized the task.',
            commands: [options.completion.command]
        };
    }

    return {
        status: 'BLOCKED',
        nextGate: 'completion-gate',
        title: 'Rerun completion gate for the current task cycle.',
        reason: 'A previous completion gate pass exists, but it is older than the latest task-mode entry. Continue the restarted task cycle before treating the task as DONE.',
        commands: [options.completion.command]
    };
}

export interface CompletedCloseoutRoutingOptions {
    postDoneDrift: {
        blocked: boolean;
        reason: string;
    };
    finalReportContractReady: boolean;
    finalReportContractBlocker: string;
    finalReport: unknown | null;
    taskAuditCommand: CloseoutRoutingCommand;
}

export interface CompletedCloseoutRouteState {
    postDoneDriftBlocked: boolean;
    postDoneDriftReason: string;
    finalReportContractReady: boolean;
    finalReportContractBlocker: string;
    finalReport: unknown | null;
    taskAuditCommand: string;
}

export function resolveCompletedCloseoutRouteFromState(
    state: CompletedCloseoutRouteState
): CloseoutRoutingRoute {
    return resolveCompletedCloseoutRoute({
        postDoneDrift: {
            blocked: state.postDoneDriftBlocked,
            reason: state.postDoneDriftReason
        },
        finalReportContractReady: state.finalReportContractReady,
        finalReportContractBlocker: state.finalReportContractBlocker,
        finalReport: state.finalReport,
        taskAuditCommand: closeoutCommand('Build final audit summary', state.taskAuditCommand)
    });
}

export function resolveCompletedCloseoutRoute(
    options: CompletedCloseoutRoutingOptions
): CloseoutRoutingRoute {
    if (options.postDoneDrift.blocked) {
        return {
            status: 'BLOCKED',
            nextGate: 'post-done-drift',
            title: 'Resolve tracked post-DONE workspace drift.',
            reason: options.postDoneDrift.reason,
            commands: [],
            finalReport: null
        };
    }

    if (!options.finalReportContractReady) {
        return {
            status: 'BLOCKED',
            nextGate: 'task-audit-summary',
            title: 'Final report integrity attestation is not ready.',
            reason:
                `${options.finalReportContractBlocker || 'Final report contract is not ready.'} ` +
                'Do not deliver a task-complete final report until review integrity is independently attested or the scope requires no review.',
            commands: [],
            finalReport: null
        };
    }

    if (options.finalReport) {
        return {
            status: 'DONE',
            nextGate: null,
            title: 'Task gate flow is complete.',
            reason: 'Completion gate passed and the canonical final closeout is materialized. Deliver the final report in the required order below; do not auto-commit without explicit user approval.',
            commands: [],
            finalReport: options.finalReport
        };
    }

    return {
        status: 'READY',
        nextGate: 'task-audit-summary',
        title: 'Materialize final closeout before stopping.',
        reason: 'Completion gate passed, but the canonical final closeout artifacts are not materialized yet. Run task-audit-summary to materialize the final report order and commit guidance before stopping.',
        commands: [options.taskAuditCommand],
        finalReport: null
    };
}
