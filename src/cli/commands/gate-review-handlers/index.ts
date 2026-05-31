import {
    normalizeCanonicalReviewSectionHeadings
} from '../../../gates/completion';
import {
    createReviewInvocationHandlers
} from './review-invocation-handlers';
import {
    createReviewResultHandlers
} from './review-result-handlers';
import {
    createReviewRoutingLaunchHandlers
} from './review-routing-launch-handlers';
import {
    analyzeEarlyReviewMaterialization,
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildLosslessPassReviewNormalization,
    buildMinimalPassReviewTemplateHint,
    buildPassReviewTemplateHintMessage,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerInvocationAttestationEvent,
    findMatchingReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewerScopedDiffHandoffPaths,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getStringField,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    isLosslessPassNormalizationEligibleViolation,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveCanonicalReviewPaths,
    resolveProviderLaunchMetadata,
    resolveReviewerDraftOutputPath,
    resolveReviewerHandoffBindings,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    reviewContextRequiresPassValidationNotes,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath
} from './review-handler-public-support';

export { handleRequiredReviewsCheck, handleDocImpactGate } from './simple-handlers';
export {
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewerScopedDiffHandoffPaths,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getStringField,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveProviderLaunchMetadata,
    resolveReviewerDraftOutputPath,
    resolveReviewerHandoffBindings,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath,
    type SupersededReviewerLaunchArtifactSnapshot
} from './review-handler-public-support';

export let readReviewOutputFromStdin = async (): Promise<string> => {
    if (!process.stdin || process.stdin.isTTY) {
        throw new Error('ReviewOutputStdin requires piped stdin input.');
    }
    process.stdin.setEncoding('utf8');
    let content = '';
    for await (const chunk of process.stdin) {
        content += String(chunk);
    }
    return content;
};

const reviewInvocationHandlers = createReviewInvocationHandlers({
    assertExplicitReviewContextRuntimeIdentity,
    assertReviewContextContractOrThrow,
    assertRoutingCompatibility,
    buildReviewerLaunchBindingSha256,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchPreparedEvent,
    findMatchingRoutingEvent,
    getReviewTreeStateSha256,
    getStringField,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    readJsonFile,
    resolveCanonicalPreflightArtifactPath,
    resolveReviewerHandoffBindings,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    stringSha256
});

export const {
    handleRecordReviewInvocation,
    validateReviewerLaunchArtifact
} = reviewInvocationHandlers;

const reviewRoutingLaunchHandlers = createReviewRoutingLaunchHandlers({
    assertExplicitReviewContextRuntimeIdentity,
    assertNoCurrentCycleReviewRecordedBeforeRouting,
    assertPreparedReviewerLaunchArtifact,
    assertReviewContextContractOrThrow,
    assertRoutingCompatibility,
    buildCopyPasteReviewerLaunchPrompt,
    buildRecordReviewInvocationCommand,
    buildReviewerLaunchBindingSha256,
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingRoutingEvent,
    getCurrentPreparedReviewerLaunchMismatches,
    getReviewTreeStateLaunchSummary,
    getReviewTreeStateSha256,
    getReviewerScopedDiffHandoffPaths,
    getStringField,
    handleRecordReviewInvocation,
    isCurrentCompletedReviewerLaunchArtifact,
    isForbiddenReviewerLaunchAttestationSource,
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
    normalizeReviewerLaunchAttestationSource,
    parseReviewerIdentity,
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    printCopyPasteReviewerLaunchPrompt,
    readJsonFile,
    readJsonObjectIfPresent,
    resolveCanonicalPreflightArtifactPath,
    resolveProviderLaunchMetadata,
    resolveReviewerHandoffBindings,
    resolveReviewerDraftOutputPath,
    resolveReviewerLaunchArtifactPathForWrite,
    resolveReviewerLaunchInputArtifactPath,
    resolveReviewerLaunchInputAttestation,
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
    snapshotSupersededReviewerLaunchArtifact,
    stringSha256,
    toReviewerHandoffAbsolutePath
});

export const {
    handleRecordReviewRouting,
    handlePrepareReviewerLaunch,
    handleCompleteReviewerLaunch
} = reviewRoutingLaunchHandlers;

const reviewResultHandlers = createReviewResultHandlers({
    analyzeEarlyReviewMaterialization,
    assertExplicitReviewContextRuntimeIdentity,
    assertReviewContextContractOrThrow,
    assertReviewContextRuntimeIdentityMetadataPresent,
    assertRoutingCompatibility,
    buildLosslessPassReviewNormalization,
    buildMinimalPassReviewTemplateHint,
    buildPassReviewTemplateHintMessage,
    findMatchingReviewerInvocationAttestationEvent,
    findMatchingRoutingEvent,
    getReviewTreeStateSha256,
    isLosslessPassNormalizationEligibleViolation,
    normalizeReviewSectionHeadings: normalizeCanonicalReviewSectionHeadings,
    parseReviewerIdentity,
    readReviewOutputFromStdin: () => readReviewOutputFromStdin(),
    resolveCanonicalReviewPaths,
    reviewContextRequiresPassValidationNotes
});

export const {
    handleRecordReviewResult,
    handleRecordReviewReceipt
} = reviewResultHandlers;
