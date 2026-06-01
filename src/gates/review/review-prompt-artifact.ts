import * as fs from 'node:fs';

import { fileSha256, isPathInsideRoot, normalizePath, resolvePathInsideRepo, toPlainRecord } from '../shared/helpers';

function getStringField(record: Record<string, unknown> | null, ...keys: string[]): string {
    if (!record) {
        return '';
    }
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

export interface ReviewPromptArtifactBinding {
    promptPath: string;
    reviewerPromptSha256: string;
    expectedPromptSha256: string | null;
}

export interface ReviewHandoffArtifactBinding {
    artifactPath: string;
    artifactSha256: string;
    expectedArtifactSha256: string;
}

export function getReviewContextRuleContext(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    return toPlainRecord(reviewContext.rule_context);
}

function resolveReviewerPromptPath(options: {
    repoRoot: string;
    contextPath: string;
    ruleContext: Record<string, unknown> | null;
    gateName: string;
}): { promptPath: string } {
    if (!options.ruleContext) {
        throw new Error(
            `${options.gateName} requires review context rule_context for '${normalizePath(options.contextPath)}' ` +
            'because reviewer prompt artifact binding is mandatory.'
        );
    }

    const preferredPromptPath = getStringField(options.ruleContext, 'preferred_prompt_artifact');
    const artifactPath = getStringField(options.ruleContext, 'artifact_path');
    const reviewerPromptPath = preferredPromptPath || artifactPath;
    if (!reviewerPromptPath) {
        throw new Error(
            `${options.gateName} requires review context rule_context.preferred_prompt_artifact or ` +
            `rule_context.artifact_path for '${normalizePath(options.contextPath)}' because reviewer prompt artifact binding is mandatory.`
        );
    }

    const resolvedPromptPath = resolvePathInsideRepo(reviewerPromptPath, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    if (!resolvedPromptPath || !fs.existsSync(resolvedPromptPath) || !fs.statSync(resolvedPromptPath).isFile()) {
        throw new Error(
            `${options.gateName} requires a readable reviewer prompt artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved prompt path '${normalizePath(resolvedPromptPath || reviewerPromptPath)}' could not be read.`
        );
    }
    assertReviewerPromptRealpathInsideRepo({
        repoRoot: options.repoRoot,
        promptPath: resolvedPromptPath,
        gateName: options.gateName,
        contextPath: options.contextPath
    });
    assertPromptPathFieldsConsistent({
        repoRoot: options.repoRoot,
        preferredPromptPath,
        artifactPath,
        gateName: options.gateName,
        contextPath: options.contextPath
    });
    return {
        promptPath: resolvedPromptPath
    };
}

function assertPromptPathFieldsConsistent(options: {
    repoRoot: string;
    preferredPromptPath: string;
    artifactPath: string;
    gateName: string;
    contextPath: string;
}): void {
    if (!options.preferredPromptPath || !options.artifactPath) {
        return;
    }
    const preferredResolved = resolvePathInsideRepo(options.preferredPromptPath, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    const artifactResolved = resolvePathInsideRepo(options.artifactPath, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    if (!preferredResolved || !artifactResolved || preferredResolved !== artifactResolved) {
        throw new Error(
            `${options.gateName} requires review context rule_context.preferred_prompt_artifact and ` +
            `rule_context.artifact_path to resolve to the same reviewer prompt artifact for '${normalizePath(options.contextPath)}'.`
        );
    }
}

function assertReviewerPromptRealpathInsideRepo(options: {
    repoRoot: string;
    promptPath: string;
    gateName: string;
    contextPath: string;
}): void {
    const repoRealPath = fs.realpathSync(options.repoRoot);
    const promptRealPath = fs.realpathSync(options.promptPath);
    if (!isPathInsideRoot(promptRealPath, repoRealPath)) {
        throw new Error(
            `${options.gateName} requires reviewer prompt artifact to stay inside repo root for ` +
            `'${normalizePath(options.contextPath)}'. Resolved prompt realpath '${normalizePath(promptRealPath)}' escapes ` +
            `repo root '${normalizePath(repoRealPath)}'.`
        );
    }
}

function assertReviewerHandoffRealpathInsideRepo(options: {
    repoRoot: string;
    artifactPath: string;
    gateName: string;
    contextPath: string;
    artifactLabel: string;
}): void {
    const repoRealPath = fs.realpathSync(options.repoRoot);
    const artifactRealPath = fs.realpathSync(options.artifactPath);
    if (!isPathInsideRoot(artifactRealPath, repoRealPath)) {
        throw new Error(
            `${options.gateName} requires ${options.artifactLabel} artifact to stay inside repo root for ` +
            `'${normalizePath(options.contextPath)}'. Resolved artifact realpath '${normalizePath(artifactRealPath)}' escapes ` +
            `repo root '${normalizePath(repoRealPath)}'.`
        );
    }
}

function getExpectedReviewerPromptSha256(options: {
    reviewContext: Record<string, unknown>;
    ruleContext: Record<string, unknown> | null;
    gateName: string;
    contextPath: string;
}): string {
    const expectedPromptSha256 = getStringField(options.ruleContext, 'artifact_sha256', 'artifactSha256').toLowerCase();
    if (!expectedPromptSha256) {
        throw new Error(
            `${options.gateName} requires review context rule_context.artifact_sha256 for '${normalizePath(options.contextPath)}' ` +
            'because reviewer prompt artifact binding is mandatory.'
        );
    }
    if (!/^[0-9a-f]{64}$/.test(expectedPromptSha256)) {
        throw new Error(
            `${options.gateName} requires review context rule_context.artifact_sha256 to be a lowercase sha256 hex digest. ` +
            `Got '${expectedPromptSha256}' for '${normalizePath(options.contextPath)}'.`
        );
    }
    return expectedPromptSha256;
}

export function resolveReviewerPromptArtifactBinding(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
}): ReviewPromptArtifactBinding {
    const ruleContext = getReviewContextRuleContext(options.reviewContext);
    const promptResolution = resolveReviewerPromptPath({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        ruleContext,
        gateName: options.gateName
    });
    const reviewerPromptSha256 = fileSha256(promptResolution.promptPath);
    if (!reviewerPromptSha256) {
        throw new Error(
            `${options.gateName} requires a hashable reviewer prompt artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved prompt path '${normalizePath(promptResolution.promptPath)}' could not be read.`
        );
    }
    const expectedPromptSha256 = getExpectedReviewerPromptSha256({
        reviewContext: options.reviewContext,
        ruleContext,
        gateName: options.gateName,
        contextPath: options.contextPath
    });
    if (reviewerPromptSha256 !== expectedPromptSha256) {
        throw new Error(
            `${options.gateName} cannot continue because reviewer prompt artifact is stale for '${normalizePath(options.contextPath)}'. ` +
            `Expected reviewer_prompt_sha256=${expectedPromptSha256} from review_context.rule_context.artifact_sha256; ` +
            `current reviewer_prompt_sha256=${reviewerPromptSha256} at '${normalizePath(promptResolution.promptPath)}'. ` +
            'Rebuild review context before launching or attesting a reviewer.'
        );
    }
    return {
        promptPath: promptResolution.promptPath,
        reviewerPromptSha256,
        expectedPromptSha256
    };
}

export function resolveReviewerHandoffArtifactBinding(options: {
    repoRoot: string;
    contextPath: string;
    reviewContext: Record<string, unknown>;
    gateName: string;
    handoffKey: string;
    artifactLabel: string;
}): ReviewHandoffArtifactBinding {
    const handoff = toPlainRecord(options.reviewContext.reviewer_handoff);
    const artifact = toPlainRecord(handoff?.[options.handoffKey]);
    const artifactPathValue = getStringField(artifact, 'artifact_path', 'artifactPath');
    const expectedArtifactSha256 = getStringField(artifact, 'artifact_sha256', 'artifactSha256').toLowerCase();
    if (!artifactPathValue) {
        throw new Error(
            `${options.gateName} requires review context reviewer_handoff.${options.handoffKey}.artifact_path ` +
            `for '${normalizePath(options.contextPath)}' because ${options.artifactLabel} handoff is mandatory.`
        );
    }
    if (!expectedArtifactSha256) {
        throw new Error(
            `${options.gateName} requires review context reviewer_handoff.${options.handoffKey}.artifact_sha256 ` +
            `for '${normalizePath(options.contextPath)}' because ${options.artifactLabel} handoff is mandatory.`
        );
    }
    if (!/^[0-9a-f]{64}$/.test(expectedArtifactSha256)) {
        throw new Error(
            `${options.gateName} requires review context reviewer_handoff.${options.handoffKey}.artifact_sha256 ` +
            `to be a lowercase sha256 hex digest for '${normalizePath(options.contextPath)}'.`
        );
    }
    const resolvedArtifactPath = resolvePathInsideRepo(artifactPathValue, options.repoRoot, {
        allowMissing: true,
        enforceInside: true
    });
    if (!resolvedArtifactPath || !fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
        throw new Error(
            `${options.gateName} requires a readable ${options.artifactLabel} artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved path '${normalizePath(resolvedArtifactPath || artifactPathValue)}' could not be read.`
        );
    }
    assertReviewerHandoffRealpathInsideRepo({
        repoRoot: options.repoRoot,
        artifactPath: resolvedArtifactPath,
        gateName: options.gateName,
        contextPath: options.contextPath,
        artifactLabel: options.artifactLabel
    });
    const artifactSha256 = fileSha256(resolvedArtifactPath);
    if (!artifactSha256) {
        throw new Error(
            `${options.gateName} requires a hashable ${options.artifactLabel} artifact for '${normalizePath(options.contextPath)}'. ` +
            `Resolved path '${normalizePath(resolvedArtifactPath)}' could not be read.`
        );
    }
    if (artifactSha256 !== expectedArtifactSha256) {
        throw new Error(
            `${options.gateName} cannot continue because ${options.artifactLabel} artifact is stale for '${normalizePath(options.contextPath)}'. ` +
            `Expected ${options.handoffKey}_sha256=${expectedArtifactSha256}; current sha256=${artifactSha256} at ` +
            `'${normalizePath(resolvedArtifactPath)}'. Rebuild review context before launching or attesting a reviewer.`
        );
    }
    return {
        artifactPath: resolvedArtifactPath,
        artifactSha256,
        expectedArtifactSha256
    };
}
