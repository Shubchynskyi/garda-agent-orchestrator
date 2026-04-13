/**
 * gates.ts — Thin facade that re-exports all gate flow commands.
 *
 * Implementation lives in the `gate-flows/` directory:
 *   - task-mode-flow.ts   (enter-task-mode, load-rule-pack, record-no-op, diagnostics)
 *   - compile-flow.ts     (classify-change, compile-gate)
 *   - review-flow.ts      (required-reviews-check, doc-impact-gate)
 *   - completion-flow.ts  (log-task-event, human-commit)
 *
 * This file preserves the public API so existing consumers (handler modules,
 * tests) continue to import from './gates' without changes.
 */

// ── Re-exports from gate-flows ──────────────────────────────────────────────

export {
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runHandshakeDiagnosticsCommand,
    runShellSmokePreflightCommand,
    runCommandTimeoutDiagnosticsCommand
} from './gate-flows/task-mode-flow';

export {
    runClassifyChangeCommand,
    runCompileGateCommand
} from './gate-flows/compile-flow';

export {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from './gate-flows/review-flow';

export {
    runLogTaskEventCommand,
    runHumanCommitCommand
} from './gate-flows/completion-flow';

// ── Re-exports from gates-subprocess (unchanged) ───────────────────────────

export {
    executeCommand,
    executeCommandAsync,
    resolveExecutablePath,
    splitCommandLine
} from './gates-subprocess';
