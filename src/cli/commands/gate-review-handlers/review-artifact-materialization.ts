export type ReviewMaterializationFidelity = 'exact' | 'normalized_lossless';

interface ReviewMaterializationAnalysis<TFindingsEvidence> {
    violations: string[];
    findingsEvidence: TFindingsEvidence;
}

interface MaterializeReviewContentOptions<TFindingsEvidence> {
    artifactPath: string;
    reviewType: string;
    reviewContent: string;
    verdictToken: string;
    expectedPassVerdict: string;
    requirePassValidationNotes: boolean;
    analyze: (options: {
        artifactPath: string;
        reviewContent: string;
        verdictToken: string;
        expectedPassVerdict: string;
        requirePassValidationNotes: boolean;
    }) => ReviewMaterializationAnalysis<TFindingsEvidence>;
    normalizeHeadings: (reviewContent: string) => {
        changed: boolean;
        content: string;
    };
    buildLosslessPassReviewNormalization: (options: {
        reviewType: string;
        reviewContent: string;
        expectedPassVerdict: string;
        findingsEvidence: TFindingsEvidence;
    }) => string | null;
    isLosslessPassNormalizationEligibleViolation: (violation: string) => boolean;
    buildPassReviewTemplateHintMessage: (options: {
        reviewType: string;
        verdictToken: string;
        expectedPassVerdict: string;
        reviewContent: string;
        findingsEvidence: TFindingsEvidence;
    }) => string | null;
}

export function materializeReviewContent<TFindingsEvidence>(
    options: MaterializeReviewContentOptions<TFindingsEvidence>
): {
    reviewContent: string;
    reviewMaterializationFidelity: ReviewMaterializationFidelity;
} {
    let reviewContent = options.reviewContent;
    let reviewMaterializationFidelity: ReviewMaterializationFidelity = 'exact';
    const materializationAnalysis = options.analyze({
        artifactPath: options.artifactPath,
        reviewContent,
        verdictToken: options.verdictToken,
        expectedPassVerdict: options.expectedPassVerdict,
        requirePassValidationNotes: options.requirePassValidationNotes
    });
    const normalizedHeadings = options.normalizeHeadings(reviewContent);
    if (normalizedHeadings.changed) {
        const normalizedHeadingAnalysis = options.analyze({
            artifactPath: options.artifactPath,
            reviewContent: normalizedHeadings.content,
            verdictToken: options.verdictToken,
            expectedPassVerdict: options.expectedPassVerdict,
            requirePassValidationNotes: options.requirePassValidationNotes
        });
        if (normalizedHeadingAnalysis.violations.length <= materializationAnalysis.violations.length) {
            reviewContent = normalizedHeadings.content;
            reviewMaterializationFidelity = 'normalized_lossless';
            materializationAnalysis.violations = normalizedHeadingAnalysis.violations;
            materializationAnalysis.findingsEvidence = normalizedHeadingAnalysis.findingsEvidence;
        }
    }
    if (options.verdictToken === options.expectedPassVerdict) {
        const normalizedPassReviewContent = options.buildLosslessPassReviewNormalization({
            reviewType: options.reviewType,
            reviewContent,
            expectedPassVerdict: options.expectedPassVerdict,
            findingsEvidence: materializationAnalysis.findingsEvidence
        });
        if (normalizedPassReviewContent) {
            const normalizedAnalysis = options.analyze({
                artifactPath: options.artifactPath,
                reviewContent: normalizedPassReviewContent,
                verdictToken: options.verdictToken,
                expectedPassVerdict: options.expectedPassVerdict,
                requirePassValidationNotes: options.requirePassValidationNotes
            });
            const preservedBlockingViolations = materializationAnalysis.violations.filter(
                (violation) => !options.isLosslessPassNormalizationEligibleViolation(violation)
            );
            if (normalizedAnalysis.violations.length === 0) {
                reviewContent = normalizedPassReviewContent;
                reviewMaterializationFidelity = 'normalized_lossless';
                materializationAnalysis.violations = preservedBlockingViolations;
                materializationAnalysis.findingsEvidence = normalizedAnalysis.findingsEvidence;
            }
        }
    }
    if (materializationAnalysis.violations.length > 0) {
        const passTemplateHint = options.buildPassReviewTemplateHintMessage({
            reviewType: options.reviewType,
            verdictToken: options.verdictToken,
            expectedPassVerdict: options.expectedPassVerdict,
            reviewContent,
            findingsEvidence: materializationAnalysis.findingsEvidence
        });
        throw new Error(
            `Review output is not eligible for '${options.reviewType}' materialization:\n` +
            materializationAnalysis.violations.map((violation) => `- ${violation}`).join('\n') +
            (passTemplateHint ? `\n\n${passTemplateHint}` : '')
        );
    }
    return {
        reviewContent,
        reviewMaterializationFidelity
    };
}
