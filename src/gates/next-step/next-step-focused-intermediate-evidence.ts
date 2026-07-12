import * as fs from 'node:fs';
import * as path from 'node:path';

import { splitCommandLine } from '../../cli/commands/gates/gates-subprocess';
import { isPlainRecord } from '../../core/records';
import { inspectTaskEventFile } from '../../gate-runtime/task-events';
import {
    readOrderedTaskEvents,
    type TaskAuditEvent
} from '../task-audit/task-audit-summary-lifecycle';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import { isFocusedIntermediateCommand } from '../shared/focused-intermediate-command-grammar';
import { findReviewFindingTestPaths } from './next-step-review-artifact-failure-detection';

const INTERMEDIATE_COMMAND_SOURCES = new Set(['node-test', 'targeted-test', 'typecheck', 'validation']);

export interface FocusedIntermediateReviewEvidence {
    available: boolean;
    reason: string | null;
}

interface BoundIntermediateCommandEvidence {
    artifactPath: string;
    command: string;
    commandSource: string;
}

export function isPassedIntermediateCommandEvent(event: TaskAuditEvent): boolean {
    const details = isPlainRecord(event.details) ? event.details : {};
    const commandSource = String(details.command_source || '').trim();
    if (!INTERMEDIATE_COMMAND_SOURCES.has(commandSource)) {
        return false;
    }
    const outcome = String(event.outcome || '').trim().toUpperCase();
    const status = String(details.status || '').trim().toUpperCase();
    const exitCode = details.exit_code;
    if (typeof exitCode === 'number' && Number.isInteger(exitCode)) {
        return exitCode === 0;
    }
    return outcome === 'PASS' || outcome === 'PASSED' || status === 'PASS' || status === 'PASSED';
}

function isFocusedReviewTestPath(filePath: string): boolean {
    const normalizedPath = normalizePath(filePath).replace(/^\.\/?/u, '');
    return /(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/iu.test(normalizedPath)
        || /\.(?:test|spec)\.[cm]?[jt]sx?$/iu.test(normalizedPath);
}

function isVerifiedFocusedTestCommand(command: string, commandSource: string): boolean {
    return isFocusedIntermediateCommand(commandSource, splitCommandLine(command));
}

function focusedTestPathsFromCommand(command: string): Set<string> {
    return new Set(
        splitCommandLine(command)
            .map((token) => normalizePath(token).replace(/^\.\/?/u, ''))
            .filter(isFocusedReviewTestPath)
    );
}

function parseUtcTimestamp(value: string | null): number | null {
    const parsed = Date.parse(String(value || '').trim());
    return Number.isFinite(parsed) ? parsed : null;
}

function outputArtifactIntegrityMatches(
    outputArtifactPath: string,
    reviewsRoot: string,
    expectedSha256: string,
    expectedSizeBytes: number
): boolean {
    try {
        return isPathRealpathInsideRoot(outputArtifactPath, reviewsRoot)
            && fs.statSync(outputArtifactPath).size === expectedSizeBytes
            && fileSha256(outputArtifactPath) === expectedSha256;
    } catch {
        return false;
    }
}

function readFocusedTestRequiredByReview(options: {
    reviewArtifactPath: string;
    changedFiles: readonly string[];
}): string | null {
    const changedTestFiles = options.changedFiles
        .map((filePath) => normalizePath(filePath))
        .filter((filePath) => filePath && isFocusedReviewTestPath(filePath));
    if (changedTestFiles.length === 0 || !fs.existsSync(options.reviewArtifactPath)) {
        return null;
    }
    try {
        const reviewContent = fs.readFileSync(options.reviewArtifactPath, 'utf8');
        const findingTestPaths = findReviewFindingTestPaths(reviewContent, changedTestFiles);
        return findingTestPaths.length === 1 ? findingTestPaths[0] : null;
    } catch {
        return null;
    }
}

function eventOccursAfterFailedReview(
    event: TaskAuditEvent,
    reviewResultTimestamp: number,
    reviewerProvenanceTaskSequence: number
): boolean {
    const eventTimestamp = parseUtcTimestamp(String(event.timestamp_utc || '').trim());
    const eventIntegrity = isPlainRecord(event.integrity) ? event.integrity : {};
    const eventSequence = eventIntegrity.task_sequence;
    return eventTimestamp != null
        && eventTimestamp > reviewResultTimestamp
        && typeof eventSequence === 'number'
        && Number.isInteger(eventSequence)
        && eventSequence > reviewerProvenanceTaskSequence;
}

function readBoundIntermediateCommandEvidence(options: {
    event: TaskAuditEvent;
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
}): BoundIntermediateCommandEvidence | null {
    const details = isPlainRecord(options.event.details) ? options.event.details : {};
    const commandSource = String(details.command_source || '').trim();
    const command = String(details.command || '').trim();
    const artifactPathText = String(details.artifact_path || '').trim();
    const artifactSha256 = String(details.artifact_sha256 || '').trim();
    const eventOutputArtifactSha256 = String(details.output_artifact_sha256 || '').trim();
    const eventOutputArtifactSizeBytes = details.output_artifact_size_bytes;
    if (
        !command
        || !artifactPathText
        || !/^[0-9a-f]{64}$/u.test(artifactSha256)
        || String(options.event.outcome || '').trim().toUpperCase() !== 'PASSED'
        || details.exit_code !== 0
    ) {
        return null;
    }
    let artifactPath: string | null;
    try {
        artifactPath = resolvePathInsideRepo(artifactPathText, options.repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
    } catch {
        return null;
    }
    if (
        !artifactPath
        || !isPathRealpathInsideRoot(artifactPath, options.reviewsRoot)
        || fileSha256(artifactPath) !== artifactSha256
    ) {
        return null;
    }
    let record: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return null;
        }
        record = parsed;
    } catch {
        return null;
    }
    const recordOutputArtifact = String(record.output_artifact || '').trim();
    const recordOutputArtifactSha256 = String(record.output_artifact_sha256 || '').trim();
    const recordOutputArtifactSizeBytes = record.output_artifact_size_bytes;
    let outputArtifactPath: string | null;
    try {
        outputArtifactPath = resolvePathInsideRepo(recordOutputArtifact, options.repoRoot, {
            allowMissing: false,
            enforceInside: true
        });
    } catch {
        return null;
    }
    if (
        record.schema_version !== 1
        || String(record.task_id || '').trim() !== options.taskId
        || String(record.command_source || '').trim() !== commandSource
        || String(record.command || '').trim() !== command
        || String(record.status || '').trim().toUpperCase() !== 'PASSED'
        || record.exit_code !== 0
        || !outputArtifactPath
        || !/^[0-9a-f]{64}$/u.test(recordOutputArtifactSha256)
        || typeof recordOutputArtifactSizeBytes !== 'number'
        || !Number.isSafeInteger(recordOutputArtifactSizeBytes)
        || recordOutputArtifactSizeBytes < 0
        || eventOutputArtifactSha256 !== recordOutputArtifactSha256
        || eventOutputArtifactSizeBytes !== recordOutputArtifactSizeBytes
        || !outputArtifactIntegrityMatches(
            outputArtifactPath,
            options.reviewsRoot,
            recordOutputArtifactSha256,
            recordOutputArtifactSizeBytes
        )
    ) {
        return null;
    }
    return { artifactPath, command, commandSource };
}

export function readPostReviewFocusedIntermediateEvidence(options: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewArtifactPath: string;
    reviewResultRecordedAtUtc: string | null;
    reviewerProvenanceTaskSequence: number | null;
    changedFiles: readonly string[];
}): FocusedIntermediateReviewEvidence {
    const reviewResultTimestamp = parseUtcTimestamp(options.reviewResultRecordedAtUtc);
    const requiredFocusedTest = readFocusedTestRequiredByReview({
        reviewArtifactPath: options.reviewArtifactPath,
        changedFiles: options.changedFiles
    });
    if (
        reviewResultTimestamp == null
        || options.reviewerProvenanceTaskSequence == null
        || !requiredFocusedTest
    ) {
        return { available: false, reason: null };
    }
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const timelineInspection = inspectTaskEventFile(timelinePath, options.taskId);
    if (timelineInspection.status !== 'PASS' && timelineInspection.status !== 'PASS_WITH_LEGACY_PREFIX') {
        return { available: false, reason: null };
    }
    const events = readOrderedTaskEvents(timelinePath).events;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
            String(event.task_id || '').trim() !== options.taskId
            || String(event.event_type || '').trim() !== 'INTERMEDIATE_COMMAND_RUN'
            || !isPassedIntermediateCommandEvent(event)
            || !eventOccursAfterFailedReview(event, reviewResultTimestamp, options.reviewerProvenanceTaskSequence)
        ) {
            continue;
        }
        const evidence = readBoundIntermediateCommandEvidence({
            event,
            repoRoot: options.repoRoot,
            reviewsRoot: options.reviewsRoot,
            taskId: options.taskId
        });
        if (
            !evidence
            || !isVerifiedFocusedTestCommand(evidence.command, evidence.commandSource)
            || !focusedTestPathsFromCommand(evidence.command).has(requiredFocusedTest)
        ) {
            continue;
        }
        return {
            available: true,
            reason:
                `Current task-owned focused validation evidence: ${normalizePath(evidence.artifactPath)}; ` +
                `command_source=${evidence.commandSource}; focused_test=${requiredFocusedTest}.`
        };
    }
    return { available: false, reason: null };
}
