/**
 * gates.ts — Thin facade that re-exports all gate flow commands.
 *
 * Implementation lives in the `gate-flows/` directory:
 *   - task-mode-flow.ts   (enter-task-mode, load-rule-pack, record-no-op, diagnostics)
 *   - compile-flow.ts     (classify-change, compile-gate)
 *   - recovery-flow.ts    (restart-coherent-cycle, restart-review-cycle)
 *   - review-flow.ts      (required-reviews-check, doc-impact-gate)
 *   - completion-flow.ts  (log-task-event, human-commit)
 *
 * This file preserves the public API so existing consumers (handler modules,
 * tests) continue to import from './gates' without changes.
 */

export {
    runEnterTaskModeCommand,
    runBindRulePackToPreflightCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runRecordStrictDecompositionDecisionCommand,
    runHandshakeDiagnosticsCommand,
    runShellSmokePreflightCommand,
    runCommandTimeoutDiagnosticsCommand
} from './gate-flows/task-mode-flow';

export {
    runIntermediateCommandCommand
} from './gate-flows/command-run-flow';

export {
    runClassifyChangeCommand,
    runCompileGateCommand
} from './gate-flows/compile-flow';

export {
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand
} from './gate-flows/recovery-flow';

export {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from './gate-flows/review-flow';

export {
    runLogTaskEventCommand,
    runHumanCommitCommand
} from './gate-flows/completion-flow';

export {
    runFullSuiteValidationCommand
} from './gate-flows/full-suite-validation-flow';

export {
    runBuildReviewContextCommand
} from './gate-flows/review-context-flow';

export {
    runTaskEventsSummaryCommand,
    runTaskAuditSummaryCommand
} from './gate-flows/task-summary-flow';

export {
    runTaskResetCommand
} from './gate-flows/task-reset-flow';

export {
    runProjectMemoryImpactCommand
} from './gate-flows/project-memory-flow';

export {
    executeCommand,
    executeCommandAsync,
    resolveExecutablePath,
    splitCommandLine
} from './gates-subprocess';
