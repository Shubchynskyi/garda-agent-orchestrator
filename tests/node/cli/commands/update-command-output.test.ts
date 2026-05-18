import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import type { PackageJsonLike } from '../../../../src/cli/commands/cli-types';
import { PROJECT_MEMORY_INIT_REFRESH_PROMPT } from '../../../../src/core/project-memory-rollout';

type UpdateCommandModule = typeof import('../../../../src/cli/commands/update-command');

const WORKFLOW_CONFIG_MERGE_STATUS = 'live_config_missing_template_applied path=garda-agent-orchestrator/live/config/workflow-config.json full_suite_validation.enabled=false project_memory_maintenance.enabled=true project_memory_maintenance.mode=update review_cycle_guard.max_failed_non_test_reviews=15 review_cycle_guard.max_total_non_test_reviews=30 review_cycle_guard.limit_status=template_default_applied';

function makeCacheModule(resolvedPath: string, exportsValue: Record<string, unknown>): NodeJS.Module {
    return {
        id: resolvedPath,
        filename: resolvedPath,
        loaded: true,
        path: path.dirname(resolvedPath),
        exports: exportsValue,
        parent: null,
        children: [],
        paths: [],
        isPreloading: false
    } as unknown as NodeJS.Module;
}

function restoreCachedModule(resolvedPath: string, originalModule: NodeJS.Module | undefined): void {
    if (originalModule) {
        require.cache[resolvedPath] = originalModule;
        return;
    }
    delete require.cache[resolvedPath];
}

function loadFreshUpdateCommandWithStubs(stubs: Record<string, Record<string, unknown>>): {
    module: UpdateCommandModule;
    restore(): void;
} {
    const updateCommandPath = require.resolve('../../../../src/cli/commands/update-command');
    const moduleSnapshots = new Map<string, NodeJS.Module | undefined>();

    moduleSnapshots.set(updateCommandPath, require.cache[updateCommandPath]);
    for (const [resolvedPath, exportsValue] of Object.entries(stubs)) {
        moduleSnapshots.set(resolvedPath, require.cache[resolvedPath]);
        require.cache[resolvedPath] = makeCacheModule(resolvedPath, exportsValue);
    }
    delete require.cache[updateCommandPath];

    return {
        module: require(updateCommandPath) as UpdateCommandModule,
        restore() {
            for (const [resolvedPath, originalModule] of moduleSnapshots.entries()) {
                restoreCachedModule(resolvedPath, originalModule);
            }
        }
    };
}

function makeTempBundleFixture(): { workspaceRoot: string; bundleUpdateModulePath: string; cleanup(): void } {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-command-output-'));
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const bundleUpdateModulePath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'update.js');
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src', 'lifecycle'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        bundleUpdateModulePath,
        [
            'module.exports.runUpdate = function runUpdate() {',
            '    return {',
            "        previousVersion: '1.0.0',",
            "        updatedVersion: '1.1.0',",
            `        workflowConfigMergeStatus: ${JSON.stringify(WORKFLOW_CONFIG_MERGE_STATUS)},`,
            "        projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true',",
            `        projectMemoryRefreshHandoffPrompt: ${JSON.stringify(PROJECT_MEMORY_INIT_REFRESH_PROMPT)},`,
            "        rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-1',",
            "        rollbackStatus: 'NOT_TRIGGERED',",
            "        updateReportPath: 'garda-agent-orchestrator/runtime/update-reports/update-1.md'",
            '    };',
            '};'
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'config', 'update-messages.json'),
        JSON.stringify({
            messages: [
                {
                    version: '1.1.0',
                    title: 'Major registry note',
                    body: ['Re-check new workflow affordances.']
                }
            ]
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(bundleRoot, 'CHANGELOG.md'),
        [
            '# Changelog',
            '',
            '## Unreleased',
            '- pending',
            '',
            '## 1.1.0',
            '- added versioned notes',
            '',
            '## 1.0.0',
            '- initial release'
        ].join('\n'),
        'utf8'
    );
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.1.0\n', 'utf8');
    fs.writeFileSync(
        path.join(bundleRoot, 'live', 'version.json'),
        JSON.stringify({ Version: '1.1.0', UpdatedAt: '2026-05-18T00:00:00.000Z' }, null, 2),
        'utf8'
    );

    return {
        workspaceRoot,
        bundleUpdateModulePath,
        cleanup() {
            fs.rmSync(workspaceRoot, { recursive: true, force: true });
        }
    };
}

function captureConsoleLogs(callback: () => Promise<void>): Promise<string[]> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
        lines.push(args.map((entry) => String(entry)).join(' '));
    };

    return callback()
        .then(() => lines)
        .finally(() => {
            console.log = originalLog;
        });
}

async function captureConsoleLogsWithForcedColor(callback: () => Promise<void>): Promise<string[]> {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.NO_COLOR;
    process.env.FORCE_COLOR = '1';
    try {
        return await captureConsoleLogs(callback);
    } finally {
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
    }
}

async function captureConsoleLogsWithNoColor(callback: () => Promise<void>): Promise<string[]> {
    const previousForceColor = process.env.FORCE_COLOR;
    const previousNoColor = process.env.NO_COLOR;
    delete process.env.FORCE_COLOR;
    process.env.NO_COLOR = '1';
    try {
        return await captureConsoleLogs(callback);
    } finally {
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
    }
}

test('handleUpdate surfaces update messages and release notes in plain text and json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    workflowConfigMergeStatus: WORKFLOW_CONFIG_MERGE_STATUS,
                    projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true',
                    projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_INIT_REFRESH_PROMPT,
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        options.updateRunner({
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'explicit',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture',
                            requestedPackageSpec: 'garda-agent-orchestrator@latest',
                            exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                            resolvedPackageVersion: '1.1.0',
                            resolvedPackageIntegrity: 'sha512-output'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        requestedPackageSpec: 'garda-agent-orchestrator@latest',
                        exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                        resolvedPackageVersion: '1.1.0',
                        resolvedPackageIntegrity: 'sha512-output',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mUpdated successfully\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mThe available update was applied to this workspace\.\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion applied\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[32m1\.1\.0\u001b\[0m/);
            assert.equal(plainTextLines.includes('PreviousVersion: 1.0.0'), true);
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('RequestedPackageSpec: garda-agent-orchestrator@latest'), true);
            assert.equal(plainTextLines.includes('ExactPackageSpec: garda-agent-orchestrator@1.1.0'), true);
            assert.equal(plainTextLines.includes('ResolvedPackageVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('ResolvedPackageIntegrity: sha512-output'), true);
            assert.equal(
                plainTextLines.includes(`WorkflowConfigMergeStatus: ${WORKFLOW_CONFIG_MERGE_STATUS}`),
                true
            );
            assert.equal(plainTextLines.includes('ProjectMemoryMaintenanceSummaryLine: Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true'), true);
            assert.equal(plainTextLines.includes(`ProjectMemoryRefreshHandoffPrompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`), true);
            assert.equal(plainTextLines.includes('UpdateMessages:'), true);
            assert.equal(plainTextLines.includes('- 1.1.0: Major registry note'), true);
            assert.equal(plainTextLines.includes('ReleaseNotes:'), true);
            assert.equal(plainTextLines.includes('  - added versioned notes'), true);
            assert.equal(require.cache[fixture.bundleUpdateModulePath], undefined);

            const noColorLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(/\u001b\[/.test(noColorLines.slice(0, 3).join('\n')), false);
            assert.equal(noColorLines[0], 'UPDATE STATUS');
            assert.equal(noColorLines[1], 'Updated successfully');
            assert.equal(noColorLines[2], 'The available update was applied to this workspace.');

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.previousVersion, '1.0.0');
            assert.equal(parsed.updatedVersion, '1.1.0');
            assert.equal(parsed.requestedPackageSpec, 'garda-agent-orchestrator@latest');
            assert.equal(parsed.exactPackageSpec, 'garda-agent-orchestrator@1.1.0');
            assert.equal(parsed.resolvedPackageVersion, '1.1.0');
            assert.equal(parsed.resolvedPackageIntegrity, 'sha512-output');
            assert.equal(
                parsed.workflowConfigMergeStatus,
                WORKFLOW_CONFIG_MERGE_STATUS
            );
            assert.equal(parsed.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
            assert.equal(parsed.projectMemoryRefreshHandoffPrompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
            assert.equal(parsed.updateMessages[0].title, 'Major registry note');
            assert.equal(parsed.releaseNotes[0].version, '1.1.0');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate --apply includes UpdateApplied in plain text and enriches announcements after apply', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    projectMemoryMaintenanceSummaryLine: 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true',
                    projectMemoryRefreshHandoffPrompt: PROJECT_MEMORY_INIT_REFRESH_PROMPT,
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        options.updateRunner({
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'explicit',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture',
                            requestedPackageSpec: 'garda-agent-orchestrator@latest',
                            exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                            resolvedPackageVersion: '1.1.0',
                            resolvedPackageIntegrity: 'sha512-check'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        requestedPackageSpec: 'garda-agent-orchestrator@latest',
                        exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                        resolvedPackageVersion: '1.1.0',
                        resolvedPackageIntegrity: 'sha512-check',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mUpdated successfully\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion applied\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[32m1\.1\.0\u001b\[0m/);
            assert.equal(plainTextLines.includes('UpdateApplied: True'), true);
            assert.equal(plainTextLines.includes('PreviousVersion: 1.0.0'), true);
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('RequestedPackageSpec: garda-agent-orchestrator@latest'), true);
            assert.equal(plainTextLines.includes('ExactPackageSpec: garda-agent-orchestrator@1.1.0'), true);
            assert.equal(plainTextLines.includes('ResolvedPackageVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('ResolvedPackageIntegrity: sha512-check'), true);
            assert.equal(
                plainTextLines.includes(`WorkflowConfigMergeStatus: ${WORKFLOW_CONFIG_MERGE_STATUS}`),
                true
            );
            assert.equal(plainTextLines.includes('ProjectMemoryMaintenanceSummaryLine: Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true'), true);
            assert.equal(plainTextLines.includes(`ProjectMemoryRefreshHandoffPrompt: ${PROJECT_MEMORY_INIT_REFRESH_PROMPT}`), true);
            assert.equal(plainTextLines.includes('UpdateMessages:'), true);
            assert.equal(plainTextLines.includes('ReleaseNotes:'), true);
            assert.equal(require.cache[fixture.bundleUpdateModulePath], undefined);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(
                parsed.workflowConfigMergeStatus,
                WORKFLOW_CONFIG_MERGE_STATUS
            );
            assert.equal(parsed.projectMemoryMaintenanceSummaryLine, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
            assert.equal(parsed.projectMemoryRefreshHandoffPrompt, PROJECT_MEMORY_INIT_REFRESH_PROMPT);
            assert.equal(parsed.requestedPackageSpec, 'garda-agent-orchestrator@latest');
            assert.equal(parsed.exactPackageSpec, 'garda-agent-orchestrator@1.1.0');
            assert.equal(parsed.resolvedPackageVersion, '1.1.0');
            assert.equal(parsed.resolvedPackageIntegrity, 'sha512-check');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate --apply corrects stale lifecycle UpdatedVersion after deferred version sync', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();
    const bundleRoot = path.join(fixture.workspaceRoot, 'garda-agent-orchestrator');
    const updateReportRelativePath = 'garda-agent-orchestrator/runtime/update-reports/update-stale.md';
    const updateReportPath = path.join(fixture.workspaceRoot, updateReportRelativePath);

    try {
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'version.json'),
            JSON.stringify({ Version: '1.0.0', UpdatedAt: '2026-05-18T00:00:00.000Z' }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            fixture.bundleUpdateModulePath,
            [
                'module.exports.runUpdate = function runUpdate() {',
                '    return {',
                "        previousVersion: '1.0.0',",
                "        updatedVersion: '1.0.0',",
                "        rollbackSnapshotPath: 'garda-agent-orchestrator/runtime/update-rollbacks/update-stale',",
                "        rollbackStatus: 'NOT_TRIGGERED',",
                `        updateReportPath: ${JSON.stringify(updateReportRelativePath)}`,
                '    };',
                '};'
            ].join('\n'),
            'utf8'
        );
        fs.mkdirSync(path.dirname(updateReportPath), { recursive: true });
        fs.writeFileSync(
            updateReportPath,
            [
                '# Update Report',
                '',
                'PreviousVersion: 1.0.0',
                'BundleVersion: 1.0.0',
                'UpdatedVersion: 1.0.0'
            ].join('\n'),
            'utf8'
        );

        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        options.updateRunner({
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'explicit',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'path',
                            sourceReference: 'fixture',
                            requestedPackageSpec: 'garda-agent-orchestrator@latest',
                            exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                            resolvedPackageVersion: '1.1.0',
                            resolvedPackageIntegrity: 'sha512-check'
                        });
                    }
                    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.1.0\n', 'utf8');
                    fs.writeFileSync(
                        path.join(bundleRoot, 'live', 'version.json'),
                        JSON.stringify({ Version: '1.1.0', UpdatedAt: '2026-05-18T01:00:00.000Z' }, null, 2),
                        'utf8'
                    );
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        requestedPackageSpec: 'garda-agent-orchestrator@latest',
                        exactPackageSpec: 'garda-agent-orchestrator@1.1.0',
                        resolvedPackageVersion: '1.1.0',
                        resolvedPackageIntegrity: 'sha512-check',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.1.0'), true);
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.0.0'), false);
            assert.match(fs.readFileSync(updateReportPath, 'utf8'), /^UpdatedVersion: 1\.1\.0$/m);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--apply',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.updatedVersion, '1.1.0');
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate surfaces a green up-to-date banner in plain text without changing json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate() {
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.1.0',
                        latestVersion: '1.1.0',
                        updateAvailable: false,
                        updateApplied: false,
                        checkUpdateResult: 'UP_TO_DATE',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mAlready up to date\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mNo update was needed for this workspace\.\u001b\[0m/);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'UP_TO_DATE');
            assert.equal(parsed.updateAvailable, false);
            assert.equal(parsed.updateApplied, false);
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate surfaces a yellow update-available banner in color mode and plain text in NO_COLOR mode', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate() {
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: false,
                        checkUpdateResult: 'UPDATE_AVAILABLE',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const colorLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.match(colorLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(colorLines[1], /\u001b\[33mUpdate available\u001b\[0m/);
            assert.match(colorLines[2], /\u001b\[2mA newer version is available for this workspace\.\u001b\[0m/);
            assert.match(colorLines[4], /\u001b\[1mVersion available\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[36m1\.1\.0\u001b\[0m/);

            const noColorLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(/\u001b\[/.test(noColorLines.slice(0, 3).join('\n')), false);
            assert.equal(noColorLines[0], 'UPDATE STATUS');
            assert.equal(noColorLines[1], 'Update available');
            assert.equal(noColorLines[2], 'A newer version is available for this workspace.');

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(parsed.updateAvailable, true);
            assert.equal(parsed.updateApplied, false);
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleCheckUpdate surfaces a yellow dry-run banner without changing json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const checkUpdateModulePath = require.resolve('../../../../src/lifecycle/check-update');
    const fixture = makeTempBundleFixture();

    try {
        const reloaded = loadFreshUpdateCommandWithStubs({
            [checkUpdateModulePath]: {
                async runCheckUpdate() {
                    return {
                        targetRoot: fixture.workspaceRoot,
                        sourceType: 'path',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: false,
                        checkUpdateResult: 'DRY_RUN_UPDATE_AVAILABLE',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--dry-run',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[33mDry run: update available\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mA newer version is available, but dry-run did not apply it\.\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion available\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[36m1\.1\.0\u001b\[0m/);

            const noColorLines = await captureConsoleLogsWithNoColor(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--dry-run',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });
            assert.equal(/\u001b\[/.test(noColorLines.slice(0, 3).join('\n')), false);
            assert.equal(noColorLines[0], 'UPDATE STATUS');
            assert.equal(noColorLines[1], 'Dry run: update available');
            assert.equal(noColorLines[2], 'A newer version is available, but dry-run did not apply it.');

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleCheckUpdate([
                    '--target-root', fixture.workspaceRoot,
                    '--dry-run',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'DRY_RUN_UPDATE_AVAILABLE');
            assert.equal(parsed.updateAvailable, true);
            assert.equal(parsed.updateApplied, false);
        } finally {
            reloaded.restore();
        }
    } finally {
        fixture.cleanup();
    }
});

test('handleUpdateGit surfaces the shared status banner in plain text without changing json output', async () => {
    const packageJson: PackageJsonLike = {
        name: 'garda-agent-orchestrator',
        version: '1.0.0'
    };
    const updateGitModulePath = require.resolve('../../../../src/lifecycle/update-git');
    const fixture = makeTempBundleFixture();

    try {
        const originalBundleModule = require.cache[fixture.bundleUpdateModulePath];
        require.cache[fixture.bundleUpdateModulePath] = makeCacheModule(fixture.bundleUpdateModulePath, {
            runUpdate() {
                return {
                    previousVersion: 'stale-version',
                    updatedVersion: '0.0.1',
                    rollbackSnapshotPath: 'stale-snapshot',
                    rollbackStatus: 'STALE',
                    updateReportPath: 'stale-report'
                };
            }
        });
        const reloaded = loadFreshUpdateCommandWithStubs({
            [updateGitModulePath]: {
                async runUpdateFromGit(options: { updateRunner?: (runnerOptions: Record<string, unknown>) => void }) {
                    if (typeof options.updateRunner === 'function') {
                        options.updateRunner({
                            targetRoot: fixture.workspaceRoot,
                            initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
                            skipVerify: false,
                            skipManifestValidation: false,
                            trustPolicy: 'explicit',
                            trustOverrideUsed: true,
                            trustOverrideSource: 'cli',
                            sourceType: 'git',
                            sourceReference: 'fixture'
                        });
                    }
                    return {
                        targetRoot: fixture.workspaceRoot,
                        repoUrl: 'https://example.test/repo.git',
                        branch: 'main',
                        sourceType: 'git',
                        sourceReference: 'fixture',
                        currentVersion: '1.0.0',
                        latestVersion: '1.1.0',
                        updateAvailable: true,
                        updateApplied: true,
                        checkUpdateResult: 'UPDATED',
                        trustPolicy: 'explicit',
                        trustOverrideUsed: true,
                        trustOverrideSource: 'cli'
                    };
                }
            }
        });

        try {
            const plainTextLines = await captureConsoleLogsWithForcedColor(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'main',
                    '--no-prompt',
                    '--trust-override'
                ], packageJson);
            });

            assert.match(plainTextLines[0], /\u001b\[1mUPDATE STATUS\u001b\[0m/);
            assert.match(plainTextLines[1], /\u001b\[32mUpdated successfully\u001b\[0m/);
            assert.match(plainTextLines[2], /\u001b\[2mThe available update was applied to this workspace\.\u001b\[0m/);
            assert.match(plainTextLines[4], /\u001b\[1mVersion applied\u001b\[0m \u001b\[33m1\.0\.0\u001b\[0m \u001b\[2m->\u001b\[0m \u001b\[32m1\.1\.0\u001b\[0m/);
            assert.equal(plainTextLines.includes('RepoUrl: https://example.test/repo.git'), true);
            assert.equal(plainTextLines.includes('PreviousVersion: 1.0.0'), true);
            assert.equal(plainTextLines.includes('UpdatedVersion: 1.1.0'), true);

            const jsonLines = await captureConsoleLogs(async () => {
                await reloaded.module.handleUpdateGit([
                    '--target-root', fixture.workspaceRoot,
                    '--repo-url', 'https://example.test/repo.git',
                    '--branch', 'main',
                    '--no-prompt',
                    '--trust-override',
                    '--json'
                ], packageJson);
            });
            const parsed = JSON.parse(jsonLines.join('\n'));
            assert.equal(parsed.checkUpdateResult, 'UPDATED');
            assert.equal(parsed.sourceType, 'git');
            assert.equal(parsed.repoUrl, 'https://example.test/repo.git');
            assert.equal(parsed.updatedVersion, '1.1.0');
        } finally {
            reloaded.restore();
            restoreCachedModule(fixture.bundleUpdateModulePath, originalBundleModule);
        }
    } finally {
        fixture.cleanup();
    }
});
