import { stringSha256 } from './hash';
import { DEFAULT_TOKEN_ESTIMATOR, estimateTokenCount, LEGACY_TOKEN_ESTIMATOR } from './token-telemetry';
import { compactMarkdownContent, type CompactMarkdownOptions } from './review-context-compaction';

/**
 * Build a rule context artifact, matching Python build_rule_context_artifact.
 * Returns metadata without writing files (caller handles IO for testability).
 */
export interface ReviewContextSourceFile {
    path: string;
    original_line_count: number;
    output_line_count: number;
    original_char_count: number;
    output_char_count: number;
    removed_code_blocks: number;
    retained_structural_code_blocks: number;
    removed_example_sections: number;
    removed_example_labels: number;
    removed_example_content_lines: number;
    content_sha256: string | null;
}

export interface ReviewContextSectionsResult {
    artifact_text: string;
    artifact_sha256: string | null;
    source_file_count: number;
    source_files: ReviewContextSourceFile[];
    summary: Record<string, unknown>;
}

export function buildReviewContextSections(selectedRulePaths: string[], readFileCallback: (path: string) => string, options: CompactMarkdownOptions = {}): ReviewContextSectionsResult {
    const stripExamples = options.stripExamples || false;
    const stripCodeBlocks = options.stripCodeBlocks || false;

    const outputSections = [
        '# Reviewer Rule Context',
        '',
        `- strip_examples: ${String(!!stripExamples).toLowerCase()}`,
        `- strip_code_blocks: ${String(!!stripCodeBlocks).toLowerCase()}`,
        ''
    ];

    const fileEntries = [];
    let originalLineTotal = 0;
    let outputLineTotal = 0;
    let originalCharTotal = 0;
    let outputCharTotal = 0;
    let originalTokenTotal = 0;
    let outputTokenTotal = 0;
    let legacyOriginalTokenTotal = 0;
    let legacyOutputTokenTotal = 0;

    for (const selectedRulePath of selectedRulePaths) {
        const rawContent = readFileCallback(selectedRulePath);
        const compacted = compactMarkdownContent(rawContent, { stripExamples, stripCodeBlocks });
        let artifactContent = compacted.content;
        if (!artifactContent || !artifactContent.trim()) {
            artifactContent = '_No remaining content after token-economy compaction._\n';
        } else if (!artifactContent.endsWith('\n')) {
            artifactContent += '\n';
        }

        outputSections.push(
            `## Source: ${selectedRulePath}`,
            '',
            artifactContent.replace(/\n+$/, ''),
            '',
            '---',
            ''
        );

        originalLineTotal += compacted.original_line_count;
        outputLineTotal += compacted.output_line_count;
        originalCharTotal += compacted.original_char_count;
        outputCharTotal += compacted.output_char_count;
        originalTokenTotal += estimateTokenCount(rawContent, { estimator: DEFAULT_TOKEN_ESTIMATOR });
        outputTokenTotal += estimateTokenCount(compacted.content, { estimator: DEFAULT_TOKEN_ESTIMATOR });
        legacyOriginalTokenTotal += estimateTokenCount(rawContent, { estimator: LEGACY_TOKEN_ESTIMATOR });
        legacyOutputTokenTotal += estimateTokenCount(compacted.content, { estimator: LEGACY_TOKEN_ESTIMATOR });

        fileEntries.push({
            path: selectedRulePath,
            original_line_count: compacted.original_line_count,
            output_line_count: compacted.output_line_count,
            original_char_count: compacted.original_char_count,
            output_char_count: compacted.output_char_count,
            removed_code_blocks: compacted.removed_code_blocks,
            retained_structural_code_blocks: compacted.retained_structural_code_blocks,
            removed_example_sections: compacted.removed_example_sections,
            removed_example_labels: compacted.removed_example_labels,
            removed_example_content_lines: compacted.removed_example_content_lines,
            content_sha256: stringSha256(compacted.content || '')
        });
    }

    const artifactText = outputSections.join('\n').replace(/\s+$/, '') + '\n';

    return {
        artifact_text: artifactText,
        artifact_sha256: stringSha256(artifactText),
        source_file_count: fileEntries.length,
        source_files: fileEntries,
        summary: {
            original_line_count: originalLineTotal,
            output_line_count: outputLineTotal,
            original_char_count: originalCharTotal,
            output_char_count: outputCharTotal,
            original_token_count_estimate: originalTokenTotal,
            output_token_count_estimate: outputTokenTotal,
            estimated_saved_chars: Math.max(originalCharTotal - outputCharTotal, 0),
            estimated_saved_tokens: Math.max(originalTokenTotal - outputTokenTotal, 0),
            estimated_saved_tokens_chars_per_4: Math.max(legacyOriginalTokenTotal - legacyOutputTokenTotal, 0),
            token_estimator: DEFAULT_TOKEN_ESTIMATOR,
            legacy_token_estimator: LEGACY_TOKEN_ESTIMATOR
        }
    };
}
