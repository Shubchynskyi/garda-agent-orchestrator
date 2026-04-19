import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UpdatePipelineStageResult } from './update-execution';
import type { ResolvedUpdateSources } from './update-source';

interface UpdateTrustContext {
    policy: string;
    overrideUsed: boolean;
    overrideSource: string;
    sourceType: string;
    sourceReference: string;
}

export interface UpdateReportData {
    normalizedTarget: string;
    initAnswersResolvedPath: string;
    rollbackSnapshotRelativePath: string;
    rollbackRecordsRelativePath: string;
    rollbackRecordCount: number;
    rollbackStatus: string;
    trustContext: UpdateTrustContext;
    previousVersion: string;
    previousVersionSource: string;
    bundleVersion: string;
    stageResult: UpdatePipelineStageResult & { rollbackStatus: string };
}

/**
 * Builds the markdown lines for an update report.
 * Pure function — no I/O.
 */
export function buildUpdateReportLines(data: UpdateReportData): string[] {
    const { trustContext, stageResult } = data;

    return [
        '# Update Report',
        '',
        `GeneratedAt: ${new Date().toISOString()}`,
        `TargetRoot: ${data.normalizedTarget}`,
        `InitAnswersPath: ${data.initAnswersResolvedPath}`,
        `RollbackSnapshotPath: ${data.rollbackSnapshotRelativePath}`,
        `RollbackRecordsPath: ${data.rollbackRecordsRelativePath}`,
        `RollbackSnapshotRecordCount: ${data.rollbackRecordCount}`,
        `RollbackStatus: ${stageResult.rollbackStatus}`,
        '',
        '## Trust',
        `SourceType: ${trustContext.sourceType}`,
        `SourceReference: ${trustContext.sourceReference}`,
        `TrustPolicy: ${trustContext.policy}`,
        `TrustOverrideUsed: ${trustContext.overrideUsed ? 'yes' : 'no'}`,
        `TrustOverrideSource: ${trustContext.overrideSource}`,
        '',
        '## Version',
        `PreviousVersion: ${data.previousVersion}`,
        `PreviousVersionSource: ${data.previousVersionSource}`,
        `BundleVersion: ${data.bundleVersion}`,
        `UpdatedVersion: ${stageResult.updatedVersion}`,
        '',
        '## CommandStatus',
        `Install: ${stageResult.installStatus}`,
        `Materialization: ${stageResult.materializationStatus}`,
        `ContractMigrations: ${stageResult.contractMigrationStatus}`,
        `Verify: ${stageResult.verifyStatus}`,
        `ManifestValidation: ${stageResult.manifestStatus}`,
        `InvariantCheck: ${stageResult.invariantStatus}`,
        '',
        '## ContractMigrations',
        `AppliedCount: ${stageResult.contractMigrationCount}`,
        stageResult.contractMigrationFiles.length > 0
            ? `AppliedFiles: ${stageResult.contractMigrationFiles.join(', ')}`
            : 'AppliedFiles: none'
    ];
}

/**
 * Writes the update report markdown file to disk.
 */
export function writeUpdateReport(updateReportPath: string, data: UpdateReportData): void {
    fs.mkdirSync(path.dirname(updateReportPath), { recursive: true });
    const reportLines = buildUpdateReportLines(data);
    fs.writeFileSync(updateReportPath, reportLines.join('\r\n'), 'utf8');
}

export interface UpdateResultInput {
    normalizedTarget: string;
    sources: ResolvedUpdateSources;
    trustContext: UpdateTrustContext;
    rollbackSnapshotRelativePath: string;
    rollbackRecordsRelativePath: string;
    rollbackSnapshotCreated: boolean;
    rollbackRecordCount: number;
    stageResult: UpdatePipelineStageResult & { rollbackStatus: string };
    dryRun: boolean;
    updateReportRelativePath: string;
}

/**
 * Maps internal update state into the public return shape.
 * Pure function — no I/O.
 */
export function buildUpdateResult(input: UpdateResultInput) {
    const { sources, trustContext, stageResult } = input;

    return {
        targetRoot: input.normalizedTarget,
        initAnswersPath: sources.initAnswersResolvedPath,
        rollbackSnapshotPath: input.rollbackSnapshotRelativePath,
        rollbackRecordsPath: input.dryRun ? 'not-generated-in-dry-run' : input.rollbackRecordsRelativePath,
        rollbackSnapshotCreated: input.rollbackSnapshotCreated,
        rollbackRecordCount: input.rollbackRecordCount,
        rollbackStatus: stageResult.rollbackStatus,
        assistantLanguage: sources.assistantLanguage,
        assistantBrevity: sources.assistantBrevity,
        sourceOfTruth: sources.sourceOfTruth,
        trustPolicy: trustContext.policy,
        trustOverrideUsed: trustContext.overrideUsed,
        trustOverrideSource: trustContext.overrideSource,
        previousVersion: sources.previousVersion,
        previousVersionSource: sources.previousVersionSource,
        bundleVersion: sources.bundleVersion,
        updatedVersion: stageResult.updatedVersion,
        installStatus: stageResult.installStatus,
        materializationStatus: stageResult.materializationStatus,
        contractMigrationStatus: stageResult.contractMigrationStatus,
        contractMigrationCount: stageResult.contractMigrationCount,
        contractMigrationFiles: stageResult.contractMigrationFiles,
        verifyStatus: stageResult.verifyStatus,
        manifestValidationStatus: stageResult.manifestStatus,
        updateReportPath: input.dryRun ? 'not-generated-in-dry-run' : input.updateReportRelativePath
    };
}
