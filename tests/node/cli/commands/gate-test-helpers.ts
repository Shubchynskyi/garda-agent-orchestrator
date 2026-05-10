/**
 * Shared test helpers for CLI gate tests — barrel re-export.
 *
 * This file re-exports every helper from the focused modules so existing
 * consumers can keep their single `'./gate-test-helpers'` import unchanged.
 *
 * Focused modules:
 *   gate-test-repo-bootstrap  — temp repo creation, git helpers, path utils
 *   gate-test-seed-helpers     — rule/config/evidence seeding, artifact writers
 *   gate-test-cli-capture      — CLI output capture and error assertion
 */

export {
    getReviewsRoot,
    getOrchestratorRoot,
    seedRuleFiles,
    createTempRepo,
    createWindowsBatchNodeFixture,
    createDependentValidationFixture,
    writeNodeFoundationManifest,
    runGit,
    initializeGitRepo,
    ageFixturePath
} from './gate-test-repo-bootstrap';

export {
    PROVIDER_ENTRYPOINT_BY_SOURCE,
    PROVIDER_BRIDGE_BY_SOURCE,
    writeReviewCapabilitiesConfig,
    writeBudgetOutputFilters,
    seedTaskQueue,
    seedInitAnswers,
    withDefaultTaskModeRouting,
    runEnterTaskMode,
    createReviewerRoutingFixture,
    writePreflight,
    prepareReviewDiffFixture,
    appendPreflightClassifiedEvent,
    writeCompilePassEvidence,
    writeReceiptBackedReviewArtifact,
    writeCleanReviewArtifact,
    seedReusableReviewEvidence,
    writeHandshakeArtifact,
    writeShellSmokeArtifact,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    prepareCurrentReviewPhase,
    runExplicitPreflight,
    readTaskTimelineEvents,
    findLastTimelineEventIndex,
    readTaskQueueStatusFromTaskFile
} from './gate-test-seed-helpers';

export {
    captureExpectedAsyncError,
    runCliWithCapturedOutput
} from './gate-test-cli-capture';

export {
    assertGateChainDecision
} from './gate-test-gatechain';
