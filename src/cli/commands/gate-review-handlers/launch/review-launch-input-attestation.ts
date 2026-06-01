import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { fileSha256 } from '../../../../gate-runtime/hash';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizePath } from '../../../../gates/shared/helpers';

export type ReviewerLaunchInputMode = 'copy_paste_prompt' | 'launch_artifact_path';

export interface ReviewerLaunchInputAttestation {
    mode: ReviewerLaunchInputMode;
    sha256: string;
    copyPasteReviewerLaunchPromptSha256: string;
    artifactPath: string | null;
    artifactSha256: string | null;
}

const REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT: ReviewerLaunchInputMode = 'copy_paste_prompt';
const REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH: ReviewerLaunchInputMode = 'launch_artifact_path';
const REVIEWER_LAUNCH_INPUT_MODES = new Set<ReviewerLaunchInputMode>([
    REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT,
    REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH
]);

export const REVIEWER_LAUNCH_INPUT_ARTIFACT_FILE_NAME = 'reviewer-launch-input.json';

export function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildReviewerLaunchBindingSha256(options: {
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
}): string {
    return stringSha256([
        `task_id=${options.taskId}`,
        `review_type=${options.reviewType}`,
        `reviewer_execution_mode=${options.reviewerExecutionMode}`,
        `reviewer_identity=${options.reviewerIdentity}`,
        `review_context_sha256=${options.reviewContextSha256}`,
        `routing_event_sha256=${options.routingEventSha256}`,
        `reviewer_prompt_sha256=${options.reviewerPromptSha256 || ''}`
    ].join('\n'));
}

export function resolveReviewerLaunchInputArtifactPath(reviewerLaunchArtifactPath: string): string {
    return path.join(path.dirname(reviewerLaunchArtifactPath), REVIEWER_LAUNCH_INPUT_ARTIFACT_FILE_NAME);
}

function getStringField(record: Record<string, unknown>, ...fieldNames: string[]): string {
    for (const fieldName of fieldNames) {
        const value = record[fieldName];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

function getPreparedReviewerLaunchInputArtifactPath(
    repoRoot: string,
    preparedArtifact: Record<string, unknown>
): string | null {
    const rawPath = getStringField(
        preparedArtifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    if (!rawPath) {
        return null;
    }
    return gateHelpers.resolvePathInsideRepo(rawPath, repoRoot, { allowMissing: true });
}

function normalizeReviewerLaunchInputMode(value: unknown): ReviewerLaunchInputMode | null {
    const normalized = String(value || '').trim().toLowerCase();
    return REVIEWER_LAUNCH_INPUT_MODES.has(normalized as ReviewerLaunchInputMode)
        ? normalized as ReviewerLaunchInputMode
        : null;
}

function normalizeSha256Hex(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function resolveCopyPasteReviewerLaunchPromptSha256(
    artifact: Record<string, unknown>,
    violations: string[]
): string {
    const copyPastePrompt = getStringField(
        artifact,
        'copy_paste_reviewer_launch_prompt',
        'copyPasteReviewerLaunchPrompt'
    );
    const copyPastePromptSha256 = normalizeSha256Hex(
        getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        )
    );
    if (!copyPastePrompt) {
        violations.push('copy_paste_reviewer_launch_prompt is required for launch input fidelity');
        return copyPastePromptSha256;
    }
    const expectedCopyPastePromptSha256 = stringSha256(copyPastePrompt);
    if (!copyPastePromptSha256) {
        violations.push('copy_paste_reviewer_launch_prompt_sha256 is required');
        return expectedCopyPastePromptSha256;
    }
    if (!/^[0-9a-f]{64}$/.test(copyPastePromptSha256)) {
        violations.push('copy_paste_reviewer_launch_prompt_sha256 must be a lowercase sha256 hex digest');
        return copyPastePromptSha256;
    }
    if (copyPastePromptSha256 !== expectedCopyPastePromptSha256) {
        violations.push('copy_paste_reviewer_launch_prompt_sha256 must match copy_paste_reviewer_launch_prompt');
    }
    return copyPastePromptSha256;
}

export function resolveReviewerLaunchInputAttestation(options: {
    repoRoot: string;
    launchArtifactPath: string;
    preparedArtifact: Record<string, unknown>;
    preparedLaunchArtifactSha256: string;
    rawMode: unknown;
    rawSha256: unknown;
    rawArtifactPath: unknown;
}): ReviewerLaunchInputAttestation {
    const violations: string[] = [];
    const copyPasteReviewerLaunchPromptSha256 = resolveCopyPasteReviewerLaunchPromptSha256(
        options.preparedArtifact,
        violations
    );
    const mode = normalizeReviewerLaunchInputMode(options.rawMode);
    if (!mode) {
        violations.push(
            `launch_input_mode is required and must be '${REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT}' ` +
            `or '${REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH}'`
        );
    }
    const launchInputSha256 = normalizeSha256Hex(options.rawSha256);
    if (!launchInputSha256) {
        violations.push('launch_input_sha256 is required');
    } else if (!/^[0-9a-f]{64}$/.test(launchInputSha256)) {
        violations.push('launch_input_sha256 must be a lowercase sha256 hex digest');
    }

    let launchInputArtifactPath: string | null = null;
    let launchInputArtifactSha256: string | null = null;
    if (mode === REVIEWER_LAUNCH_INPUT_MODE_COPY_PASTE_PROMPT) {
        if (launchInputSha256 && copyPasteReviewerLaunchPromptSha256 && launchInputSha256 !== copyPasteReviewerLaunchPromptSha256) {
            violations.push('launch_input_sha256 must match copy_paste_reviewer_launch_prompt_sha256 for copy_paste_prompt mode');
        }
    } else if (mode === REVIEWER_LAUNCH_INPUT_MODE_LAUNCH_ARTIFACT_PATH) {
        const rawArtifactPath = String(options.rawArtifactPath || '').trim();
        if (!rawArtifactPath) {
            violations.push('launch_input_artifact_path is required for launch_artifact_path mode');
        } else {
            const resolvedArtifactPath = gateHelpers.resolvePathInsideRepo(rawArtifactPath, options.repoRoot, { allowMissing: true });
            if (!resolvedArtifactPath) {
                violations.push('launch_input_artifact_path could not be resolved inside the repository');
            } else {
                const preparedInputArtifactPath = getPreparedReviewerLaunchInputArtifactPath(
                    options.repoRoot,
                    options.preparedArtifact
                );
                const normalizedResolvedArtifactPath = normalizePath(resolvedArtifactPath).toLowerCase();
                const normalizedLaunchArtifactPath = normalizePath(options.launchArtifactPath).toLowerCase();
                const normalizedPreparedInputArtifactPath = preparedInputArtifactPath
                    ? normalizePath(preparedInputArtifactPath).toLowerCase()
                    : '';
                if (
                    normalizedResolvedArtifactPath !== normalizedLaunchArtifactPath
                    && normalizedResolvedArtifactPath !== normalizedPreparedInputArtifactPath
                ) {
                    violations.push('launch_input_artifact_path must match ReviewerLaunchInputArtifactPath or ReviewerLaunchArtifactPath');
                } else {
                    launchInputArtifactPath = resolvedArtifactPath;
                }
            }
        }
        if (!options.preparedLaunchArtifactSha256) {
            violations.push('prepared reviewer launch artifact could not be hashed before completion');
        } else if (launchInputArtifactPath) {
            const resolvedInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
            if (!resolvedInputArtifactSha256) {
                violations.push('launch_input_artifact_path must point to a hashable reviewer launch input artifact');
            } else {
                launchInputArtifactSha256 = resolvedInputArtifactSha256;
                if (resolvedInputArtifactSha256 !== options.preparedLaunchArtifactSha256) {
                    violations.push('launch_input_artifact_sha256 must match the current prepared reviewer launch artifact sha256');
                }
                if (launchInputSha256 && launchInputSha256 !== resolvedInputArtifactSha256) {
                    violations.push('launch_input_sha256 must match the current prepared reviewer launch input artifact sha256');
                }
            }
        }
    }

    if (violations.length > 0) {
        throw new Error(
            'Reviewer launch input attestation failed validation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n') +
            '\n\n' +
            'Pass the exact CopyPasteReviewerLaunchPrompt or generated ReviewerLaunchInputArtifactPath to the reviewer; ' +
            'do not reconstruct reviewer launch prompts from memory.'
        );
    }

    return {
        mode: mode!,
        sha256: launchInputSha256,
        copyPasteReviewerLaunchPromptSha256,
        artifactPath: launchInputArtifactPath,
        artifactSha256: launchInputArtifactSha256
    };
}
