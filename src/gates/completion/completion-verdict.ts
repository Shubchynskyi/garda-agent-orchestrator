// Thin orchestration layer — re-exports all focused verdict evaluators.
// Add new evaluator modules to the focused files below; keep this file as a stable public surface.

export {
    STAGE_SEQUENCE_ORDER,
    NO_REVIEW_RECORDED_STAGE_SEQUENCE_ORDER,
    NON_CODE_STAGE_SEQUENCE_ORDER,
    validateStageSequence
} from './completion-verdict-stage-sequence';
export type { StageSequenceEvidence } from './completion-verdict-stage-sequence';

export {
    validateZeroDiffCompletionEvidence
} from './completion-verdict-zero-diff';
export type { ZeroDiffCompletionEvidence } from './completion-verdict-zero-diff';

export {
    EMPTY_REVIEW_MARKERS,
    CANONICAL_REVIEW_SECTION_HEADINGS,
    countCanonicalReviewSectionHeadings,
    extractMarkdownSectionLines,
    formatAcceptedReviewSectionHeadingShapes,
    getCanonicalReviewSectionHeading,
    normalizeCanonicalReviewSectionHeadings,
    normalizeReviewListText,
    isMeaningfulReviewEntry,
    getMarkdownMeaningfulEntries,
    getFindingsBySeverity
} from './completion-verdict-markdown';

export {
    isTrivialReview,
    getReviewArtifactFindingsEvidence
} from './completion-verdict-findings';

export {
    REVIEW_CONTRACTS
} from './completion-review-skill-contracts';

export {
    validateReviewSkillEvidence
} from './completion-verdict-review-skill';

export {
    validatePreflightForCompletion
} from './completion-verdict-preflight';
