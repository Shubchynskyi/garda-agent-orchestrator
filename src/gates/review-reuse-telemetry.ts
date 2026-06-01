// Extracted from review-reuse-telemetry.ts; keep behavior changes covered by facade tests.
export * from './review-reuse-telemetry-types';
export {
    getReviewReuseTelemetryDetails
} from './review-reuse-telemetry-normalization';
export {
    findMatchingHistoricalReviewRecordedTelemetryEvent,
    findMatchingReviewReuseRecordedTelemetryEvent,
    validateHistoricalReviewRecordedTelemetryEventMatch,
    validateReviewReuseRecordedEventMatch
} from './review-reuse-telemetry-events';
export {
    validateHistoricalReviewRecordedReceiptSnapshot,
    validateHistoricalReviewRecordedReviewArtifactPath,
    validateHistoricalReviewRecordedRuntimeReviewPath
} from './review-reuse-telemetry-diagnostics';
export {
    validateStrictReusedReviewEvidence
} from './review-reuse-telemetry-strict';
