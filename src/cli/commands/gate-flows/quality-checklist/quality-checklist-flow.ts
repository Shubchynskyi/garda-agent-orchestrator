import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import { appendMandatoryTaskEvent } from '../../../../gate-runtime/task-events';
import {
    buildQualityChecklistArtifact,
    formatQualityChecklistResult,
    resolveDefaultQualityChecklistArtifactPath
} from '../../../../gates/quality-checklist';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    resolveDefaultMetricsPath,
    writeJsonArtifact
} from '../../gates/gates-artifacts';
import { parseBooleanOption } from '../../gates/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    appendMetricsIfEnabled,
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';

export interface QualityChecklistCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    preflightPath?: unknown;
    answersJson?: unknown;
    actionTaken?: unknown;
    actionsTaken?: unknown;
    actionRequired?: unknown;
    actionsRequired?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function parseAnswersJson(value: unknown): unknown {
    const raw = String(value || '').trim();
    if (!raw) {
        return [];
    }
    try {
        return JSON.parse(raw);
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`AnswersJson must be valid JSON: ${message}`);
    }
}

function toArray(value: unknown): unknown[] {
    if (Array.isArray(value)) {
        return value;
    }
    return value == null ? [] : [value];
}

function resolveQualityChecklistOutputPath(pathValue: string, repoRoot: string, label: string): string {
    return requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true, enforceInside: true }),
        label
    );
}

export function runQualityChecklistCommand(options: QualityChecklistCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const answers = parseAnswersJson(options.answersJson);
    const artifact = buildQualityChecklistArtifact({
        repoRoot,
        taskId: String(options.taskId || '').trim(),
        preflightPath: options.preflightPath,
        answers,
        actionsTaken: [
            ...toArray(options.actionTaken),
            ...toArray(options.actionsTaken)
        ],
        actionsRequired: [
            ...toArray(options.actionRequired),
            ...toArray(options.actionsRequired)
        ]
    });

    const artifactPath = options.artifactPath
        ? resolveQualityChecklistOutputPath(options.artifactPath, repoRoot, 'ArtifactPath')
        : resolveDefaultQualityChecklistArtifactPath(repoRoot, artifact.task_id);
    const metricsPath = options.metricsPath
        ? resolveQualityChecklistOutputPath(options.metricsPath, repoRoot, 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    writeJsonArtifact(artifactPath, artifact);

    const artifactHash = gateHelpers.fileSha256(artifactPath);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'quality_checklist_recorded',
        task_id: artifact.task_id,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_hash: artifactHash,
        status: artifact.status,
        outcome: artifact.outcome,
        checklist_id: artifact.checklist_id,
        enabled_rule_count: artifact.rules.filter((rule) => rule.enabled).length,
        answer_count: artifact.answers.length,
        action_required_count: artifact.actions_required.length
    }, parseBooleanOption(options.emitMetrics, true));

    appendMandatoryTaskEvent(
        orchestratorRoot,
        artifact.task_id,
        'QUALITY_CHECKLIST_RECORDED',
        artifact.outcome,
        `Quality checklist recorded: ${artifact.status}.`,
        {
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            status: artifact.status,
            outcome: artifact.outcome,
            checklist_id: artifact.checklist_id,
            preflight_path: artifact.preflight_path,
            preflight_sha256: artifact.preflight_sha256,
            workflow_config_path: artifact.workflow_config_path,
            workflow_config_sha256: artifact.workflow_config_sha256,
            changed_files_sha256: artifact.changed_file_evidence.changed_files_sha256,
            scope_sha256: artifact.changed_file_evidence.scope_sha256,
            scope_content_sha256: artifact.changed_file_evidence.scope_content_sha256,
            enabled_rule_count: artifact.rules.filter((rule) => rule.enabled).length,
            answer_count: artifact.answers.length,
            action_required_count: artifact.actions_required.length,
            violations: artifact.violations
        }
    );

    const outputLines = formatQualityChecklistResult(artifact);
    outputLines.push(`QualityChecklistArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);
    outputLines.push(`QualityChecklistArtifactSha256: ${artifactHash}`);

    return {
        outputLines,
        exitCode: artifact.status === 'ACTION_REQUIRED' || artifact.status === 'CONFIG_ERROR'
            ? EXIT_GATE_FAILURE
            : 0
    };
}
