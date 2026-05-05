import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildUpdateReportLines, buildUpdateResult } from '../../../src/lifecycle/update-reporting';

function makeStageResult(overrides: Record<string, unknown> = {}) {
    return {
        installStatus: 'PASS',
        materializationStatus: 'PASS',
        workflowConfigMergeStatus: 'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true',
        contractMigrationStatus: 'SKIPPED_NO_RUNNER',
        contractMigrationCount: 0,
        contractMigrationFiles: [] as string[],
        verifyStatus: 'PASS',
        manifestStatus: 'PASS',
        invariantStatus: 'PASS',
        updatedVersion: '2.0.0',
        rollbackStatus: 'NOT_TRIGGERED',
        projectMemoryDiagnostics: null,
        ...overrides
    };
}

function makeSources(overrides: Record<string, unknown> = {}) {
    return {
        initAnswersResolvedPath: '/project/garda-agent-orchestrator/runtime/init-answers.json',
        initAnswers: {},
        assistantLanguage: 'English',
        assistantBrevity: 'concise',
        sourceOfTruth: 'Claude',
        enforceNoAutoCommit: false,
        claudeOrchestratorFullAccess: false,
        tokenEconomyEnabled: true,
        providerMinimalism: true,
        activeAgentFilesSeed: null,
        previousVersion: '1.0.0',
        previousVersionSource: 'live/version.json',
        bundleVersion: '2.0.0',
        liveVersionPath: '/project/garda-agent-orchestrator/live/version.json',
        ...overrides
    };
}

function makeTrustContext(overrides: Record<string, unknown> = {}) {
    return {
        policy: 'overridden',
        overrideUsed: true,
        overrideSource: 'cli-flag',
        sourceType: 'path',
        sourceReference: '/local-source',
        requestedPackageSpec: null,
        exactPackageSpec: null,
        resolvedPackageVersion: null,
        resolvedPackageIntegrity: null,
        ...overrides
    };
}

describe('buildUpdateReportLines', () => {
    it('produces report with all expected sections', () => {
        const lines = buildUpdateReportLines({
            normalizedTarget: '/project',
            initAnswersResolvedPath: '/project/garda-agent-orchestrator/runtime/init-answers.json',
            rollbackSnapshotRelativePath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-20260418',
            rollbackRecordsRelativePath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-20260418/records.json',
            rollbackRecordCount: 5,
            rollbackStatus: 'NOT_TRIGGERED',
            trustContext: makeTrustContext(),
            previousVersion: '1.0.0',
            previousVersionSource: 'live/version.json',
            bundleVersion: '2.0.0',
            stageResult: makeStageResult()
        });

        const text = lines.join('\n');
        assert.ok(text.includes('# Update Report'));
        assert.ok(text.includes('TargetRoot: /project'));
        assert.ok(text.includes('RollbackSnapshotRecordCount: 5'));
        assert.ok(text.includes('TrustPolicy: overridden'));
        assert.ok(text.includes('RequestedPackageSpec: n/a'));
        assert.ok(text.includes('ExactPackageSpec: n/a'));
        assert.ok(text.includes('ResolvedPackageVersion: n/a'));
        assert.ok(text.includes('ResolvedPackageIntegrity: n/a'));
        assert.ok(text.includes('TrustOverrideUsed: yes'));
        assert.ok(text.includes('TrustOverrideSource: cli-flag'));
        assert.ok(text.includes('PreviousVersion: 1.0.0'));
        assert.ok(text.includes('BundleVersion: 2.0.0'));
        assert.ok(text.includes('Install: PASS'));
        assert.ok(text.includes('Materialization: PASS'));
        assert.ok(text.includes('WorkflowConfigMerge: existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true'));
        assert.ok(text.includes('## ProjectMemory'));
        assert.ok(text.includes('BootstrapReport: n/a'));
        assert.ok(text.includes('AppliedCount: 0'));
        assert.ok(text.includes('AppliedFiles: none'));
    });

    it('includes project-memory lifecycle diagnostics when materialization reports them', () => {
        const lines = buildUpdateReportLines({
            normalizedTarget: '/project',
            initAnswersResolvedPath: '/project/answers.json',
            rollbackSnapshotRelativePath: 'snapshot',
            rollbackRecordsRelativePath: 'snapshot/records.json',
            rollbackRecordCount: 0,
            rollbackStatus: 'NOT_TRIGGERED',
            trustContext: makeTrustContext(),
            previousVersion: '1.0.0',
            previousVersionSource: 'live/version.json',
            bundleVersion: '2.0.0',
            stageResult: makeStageResult({
                projectMemoryDiagnostics: {
                    copiedFiles: ['compact.md'],
                    preservedFiles: ['README.md', 'context.md'],
                    missingTemplateFiles: [],
                    templateUpdateNotices: [
                        'docs/project-memory/README.md preserved; template guidance available at docs/project-memory/README.md'
                    ],
                    bootstrapReportPath: '/project/garda-agent-orchestrator/runtime/project-memory/bootstrap-report.json'
                }
            })
        });

        const text = lines.join('\n');
        assert.ok(text.includes('CopiedMissingFiles: compact.md'));
        assert.ok(text.includes('PreservedUserOwnedFiles: 2'));
        assert.ok(text.includes('TemplateUpdateNotices: docs/project-memory/README.md preserved'));
    });

    it('includes applied migration files when present', () => {
        const lines = buildUpdateReportLines({
            normalizedTarget: '/project',
            initAnswersResolvedPath: '/project/answers.json',
            rollbackSnapshotRelativePath: 'snapshot',
            rollbackRecordsRelativePath: 'snapshot/records.json',
            rollbackRecordCount: 0,
            rollbackStatus: 'NOT_TRIGGERED',
            trustContext: makeTrustContext(),
            previousVersion: '1.0.0',
            previousVersionSource: 'live/version.json',
            bundleVersion: '2.0.0',
            stageResult: makeStageResult({
                contractMigrationStatus: 'PASS',
                contractMigrationCount: 2,
                contractMigrationFiles: ['migration-001.js', 'migration-002.js']
            })
        });

        const text = lines.join('\n');
        assert.ok(text.includes('AppliedCount: 2'));
        assert.ok(text.includes('AppliedFiles: migration-001.js, migration-002.js'));
    });

    it('formats trust override as no when not used', () => {
        const lines = buildUpdateReportLines({
            normalizedTarget: '/project',
            initAnswersResolvedPath: '/project/answers.json',
            rollbackSnapshotRelativePath: 'snapshot',
            rollbackRecordsRelativePath: 'snapshot/records.json',
            rollbackRecordCount: 0,
            rollbackStatus: 'NOT_TRIGGERED',
            trustContext: makeTrustContext({ overrideUsed: false }),
            previousVersion: '1.0.0',
            previousVersionSource: 'live/version.json',
            bundleVersion: '2.0.0',
            stageResult: makeStageResult()
        });

        const text = lines.join('\n');
        assert.ok(text.includes('TrustOverrideUsed: no'));
    });

    it('includes resolved npm update provenance when available', () => {
        const lines = buildUpdateReportLines({
            normalizedTarget: '/project',
            initAnswersResolvedPath: '/project/answers.json',
            rollbackSnapshotRelativePath: 'snapshot',
            rollbackRecordsRelativePath: 'snapshot/records.json',
            rollbackRecordCount: 0,
            rollbackStatus: 'NOT_TRIGGERED',
            trustContext: makeTrustContext({
                sourceType: 'npm',
                sourceReference: 'garda-agent-orchestrator@2.3.4',
                requestedPackageSpec: 'garda-agent-orchestrator@latest',
                exactPackageSpec: 'garda-agent-orchestrator@2.3.4',
                resolvedPackageVersion: '2.3.4',
                resolvedPackageIntegrity: 'sha512-resolved'
            }),
            previousVersion: '1.0.0',
            previousVersionSource: 'live/version.json',
            bundleVersion: '2.0.0',
            stageResult: makeStageResult()
        });

        const text = lines.join('\n');
        assert.ok(text.includes('RequestedPackageSpec: garda-agent-orchestrator@latest'));
        assert.ok(text.includes('ExactPackageSpec: garda-agent-orchestrator@2.3.4'));
        assert.ok(text.includes('ResolvedPackageVersion: 2.3.4'));
        assert.ok(text.includes('ResolvedPackageIntegrity: sha512-resolved'));
    });
});

describe('buildUpdateResult', () => {
    it('maps internal state to public return shape', () => {
        const result = buildUpdateResult({
            normalizedTarget: '/project',
            sources: makeSources(),
            trustContext: makeTrustContext({
                requestedPackageSpec: 'garda-agent-orchestrator@latest',
                exactPackageSpec: 'garda-agent-orchestrator@2.0.0',
                resolvedPackageVersion: '2.0.0',
                resolvedPackageIntegrity: 'sha512-result'
            }),
            rollbackSnapshotRelativePath: 'snapshot-path',
            rollbackRecordsRelativePath: 'records-path',
            rollbackSnapshotCreated: true,
            rollbackRecordCount: 3,
            stageResult: makeStageResult(),
            dryRun: false,
            updateReportRelativePath: 'report-path'
        });

        assert.equal(result.targetRoot, '/project');
        assert.equal(result.rollbackSnapshotPath, 'snapshot-path');
        assert.equal(result.rollbackRecordsPath, 'records-path');
        assert.equal(result.rollbackSnapshotCreated, true);
        assert.equal(result.rollbackRecordCount, 3);
        assert.equal(result.rollbackStatus, 'NOT_TRIGGERED');
        assert.equal(result.assistantLanguage, 'English');
        assert.equal(result.trustPolicy, 'overridden');
        assert.equal(result.trustOverrideUsed, true);
        assert.equal(result.requestedPackageSpec, 'garda-agent-orchestrator@latest');
        assert.equal(result.exactPackageSpec, 'garda-agent-orchestrator@2.0.0');
        assert.equal(result.resolvedPackageVersion, '2.0.0');
        assert.equal(result.resolvedPackageIntegrity, 'sha512-result');
        assert.equal(result.installStatus, 'PASS');
        assert.equal(result.manifestValidationStatus, 'PASS');
        assert.equal(result.workflowConfigMergeStatus, 'existing_values_preserved_and_missing_keys_filled path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=true');
        assert.equal(result.updateReportPath, 'report-path');
    });

    it('returns dry-run placeholders in dry-run mode', () => {
        const result = buildUpdateResult({
            normalizedTarget: '/project',
            sources: makeSources(),
            trustContext: makeTrustContext(),
            rollbackSnapshotRelativePath: 'snapshot-path',
            rollbackRecordsRelativePath: 'records-path',
            rollbackSnapshotCreated: false,
            rollbackRecordCount: 0,
            stageResult: makeStageResult({ rollbackStatus: 'NOT_NEEDED' }),
            dryRun: true,
            updateReportRelativePath: 'report-path'
        });

        assert.equal(result.rollbackRecordsPath, 'not-generated-in-dry-run');
        assert.equal(result.updateReportPath, 'not-generated-in-dry-run');
        assert.equal(result.rollbackSnapshotCreated, false);
    });
});
