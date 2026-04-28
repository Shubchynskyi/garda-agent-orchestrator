import { getAllShimmedGateNames } from '../../compat/shim-registry';
import {
    buildGateCommandOverviewText,
    buildGateHelpText,
    buildTaskIdSyntaxRemediationMessage,
    hasStandaloneGateHelpFlag
} from './gate-command-help';
import { handleValidateManifest, handleValidateConfig } from './gate-validate-handlers';
import {
    handleClassifyChange,
    handleCompileGate,
    handleBuildScopedDiff,
    handleBuildReviewContext,
    handleActivateOptionalSkill
} from './gate-build-handlers';
import {
    handleRequiredReviewsCheck,
    handleDocImpactGate,
    handleRecordReviewResult,
    handleRecordReviewRouting,
    handlePrepareReviewerLaunch,
    handleRecordReviewInvocation,
    handleRecordReviewReceipt
} from './gate-review-handlers';
import {
    handleEnterTaskMode,
    handleLoadRulePack,
    handleRestartCoherentCycle,
    handleRestartReviewCycle,
    handleRecordNoOp,
    handleHandshakeDiagnostics,
    handleShellSmokePreflight,
    handleCommandTimeoutDiagnostics,
    handleLogTaskEvent,
    handleTaskEventsSummary,
    handleTaskAuditSummary,
    handleNextStep,
    handleFullSuiteValidation,
    handleCompletionGate,
    handleHumanCommit,
    handleTaskReset
} from './gate-task-handlers';
import { handleValidateIsolation, handlePrepareIsolation } from './gate-isolation-handlers';

export async function handleGate(commandArgv: string[]): Promise<void> {
    if (commandArgv.length === 0 || commandArgv[0] === '-h' || commandArgv[0] === '--help') {
        console.log(buildGateCommandOverviewText());
        console.log('');
        console.log('Available gates:');
        for (const name of getAllShimmedGateNames()) {
            console.log(`  ${name}`);
        }
        return;
    }

    const gateName = commandArgv[0];
    const gateArgv = commandArgv.slice(1);
    if (hasStandaloneGateHelpFlag(gateArgv)) {
        console.log(buildGateHelpText(gateName));
        return;
    }
    const taskIdRemediationMessage = buildTaskIdSyntaxRemediationMessage(gateName, gateArgv);
    if (taskIdRemediationMessage) {
        throw new Error(taskIdRemediationMessage);
    }

    switch (gateName) {
        case 'validate-manifest':
            return handleValidateManifest(gateArgv);
        case 'validate-config':
            return handleValidateConfig(gateArgv);
        case 'classify-change':
            return handleClassifyChange(gateArgv);
        case 'enter-task-mode':
            return handleEnterTaskMode(gateArgv);
        case 'restart-coherent-cycle':
            return handleRestartCoherentCycle(gateArgv);
        case 'restart-review-cycle':
            return handleRestartReviewCycle(gateArgv);
        case 'load-rule-pack':
            return handleLoadRulePack(gateArgv);
        case 'record-no-op':
            return handleRecordNoOp(gateArgv);
        case 'handshake-diagnostics':
            return handleHandshakeDiagnostics(gateArgv);
        case 'shell-smoke-preflight':
            return handleShellSmokePreflight(gateArgv);
        case 'command-timeout-diagnostics':
            return handleCommandTimeoutDiagnostics(gateArgv);
        case 'compile-gate':
            return handleCompileGate(gateArgv);
        case 'build-scoped-diff':
            return handleBuildScopedDiff(gateArgv);
        case 'build-review-context':
            return handleBuildReviewContext(gateArgv);
        case 'activate-optional-skill':
            return handleActivateOptionalSkill(gateArgv);
        case 'task-events-summary':
            return handleTaskEventsSummary(gateArgv);
        case 'task-audit-summary':
            return handleTaskAuditSummary(gateArgv);
        case 'next-step':
            return handleNextStep(gateArgv);
        case 'log-task-event':
            return handleLogTaskEvent(gateArgv);
        case 'required-reviews-check':
            return handleRequiredReviewsCheck(gateArgv);
        case 'doc-impact-gate':
            return handleDocImpactGate(gateArgv);
        case 'full-suite-validation':
            return handleFullSuiteValidation(gateArgv);
        case 'record-review-result':
            return handleRecordReviewResult(gateArgv);
        case 'completion-gate':
            return handleCompletionGate(gateArgv);
        case 'record-review-routing':
            return handleRecordReviewRouting(gateArgv);
        case 'prepare-reviewer-launch':
            return handlePrepareReviewerLaunch(gateArgv);
        case 'record-review-invocation':
            return handleRecordReviewInvocation(gateArgv);
        case 'record-review-receipt':
            return handleRecordReviewReceipt(gateArgv);
        case 'human-commit':
            return handleHumanCommit(gateArgv);
        case 'validate-isolation':
            return handleValidateIsolation(gateArgv);
        case 'prepare-isolation':
            return handlePrepareIsolation(gateArgv);
        case 'task-reset':
            return handleTaskReset(gateArgv);
        default:
            throw new Error(`Unknown gate: ${gateName}`);
    }
}
