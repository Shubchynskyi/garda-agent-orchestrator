import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildReportUiTabMetadata,
    defineReportUiTabContract,
    getReportUiTabActionHook,
    type ReportUiTabActionHooks
} from '../../../src/reports/report-data-contract';

interface BackupsTabFixture {
    workflow_config_path: string;
    snapshots_root: string;
    snapshots_root_exists: boolean;
}

interface ActionContext {
    calls: string[];
}

type BackupsTabStatus = 'present' | 'missing';

test('report UI tab contract resolves shared label status and path metadata', () => {
    const contract = defineReportUiTabContract({
        id: 'backups',
        label: {
            key: 'backupsTab',
            fallback: 'Backups'
        },
        status: (tab: BackupsTabFixture): BackupsTabStatus => (
            tab.snapshots_root_exists ? 'present' : 'missing'
        ),
        paths: [
            {
                id: 'workflow-config',
                label: 'Workflow config',
                kind: 'config',
                path: (tab) => tab.workflow_config_path,
                status: () => 'present'
            },
            {
                id: 'snapshots-root',
                label: 'Snapshots root',
                kind: 'directory',
                path: (tab) => tab.snapshots_root,
                status: (tab) => tab.snapshots_root_exists ? 'present' : 'missing'
            }
        ]
    });

    const metadata = buildReportUiTabMetadata(contract, {
        workflow_config_path: 'garda-agent-orchestrator/live/config/workflow-config.json',
        snapshots_root: 'garda-agent-orchestrator/runtime/backups',
        snapshots_root_exists: false
    });
    const snapshotsStatus: BackupsTabStatus | null = metadata.paths[1]?.status || null;

    assert.deepEqual(metadata, {
        id: 'backups',
        label: {
            key: 'backupsTab',
            fallback: 'Backups'
        },
        status: 'missing',
        paths: [
            {
                id: 'workflow-config',
                label: 'Workflow config',
                kind: 'config',
                path: 'garda-agent-orchestrator/live/config/workflow-config.json',
                status: 'present'
            },
            {
                id: 'snapshots-root',
                label: 'Snapshots root',
                kind: 'directory',
                path: 'garda-agent-orchestrator/runtime/backups',
                status: 'missing'
            }
        ]
    });
    assert.equal(Object.isFrozen(contract), true);
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(Object.isFrozen(metadata.paths), true);
    assert.equal(snapshotsStatus, 'missing');
});

test('report UI tab contract keeps optional action hooks explicit', async () => {
    const actions = {
        refresh: async (_tab: BackupsTabFixture, context: ActionContext) => {
            context.calls.push('refresh');
        }
    } satisfies ReportUiTabActionHooks<BackupsTabFixture, ActionContext>;
    const contract = defineReportUiTabContract({
        id: 'backups',
        label: { key: 'backupsTab', fallback: 'Backups' },
        status: (_tab: BackupsTabFixture) => 'present',
        actions
    });
    const action = getReportUiTabActionHook(contract, 'refresh');
    const context: ActionContext = { calls: [] };

    assert.ok(action);
    await action({
        workflow_config_path: '',
        snapshots_root: '',
        snapshots_root_exists: true
    }, context);
    assert.deepEqual(context.calls, ['refresh']);
    assert.equal(Object.isFrozen(contract.actions), true);

    const broadContract = defineReportUiTabContract({
        id: 'backups',
        label: { key: 'backupsTab', fallback: 'Backups' },
        status: (_tab: BackupsTabFixture) => 'present',
        actions: actions as ReportUiTabActionHooks<BackupsTabFixture, ActionContext>
    });
    assert.equal(getReportUiTabActionHook(broadContract, 'toString'), null);
});

test('report UI tab contract works without paths or action hooks', () => {
    const contract = defineReportUiTabContract({
        id: 'instructions',
        label: { key: 'instructionsTab', fallback: 'Instructions' },
        status: () => 'present'
    });

    assert.deepEqual(buildReportUiTabMetadata(contract, {}), {
        id: 'instructions',
        label: { key: 'instructionsTab', fallback: 'Instructions' },
        status: 'present',
        paths: []
    });
    assert.equal(contract.actions, undefined);
});

test('report UI tab metadata preserves an explicit empty path status', () => {
    const contract = defineReportUiTabContract({
        id: 'instructions',
        label: { key: 'instructionsTab', fallback: 'Instructions' },
        status: () => '',
        paths: [
            {
                id: 'source',
                label: 'Source',
                kind: 'source',
                path: () => 'TASK.md',
                status: () => ''
            }
        ]
    });

    assert.equal(buildReportUiTabMetadata(contract, {}).paths[0]?.status, '');
});

test('report UI tab metadata normalizes nullable and blank paths to null', () => {
    const contract = defineReportUiTabContract({
        id: 'instructions',
        label: { key: 'instructionsTab', fallback: 'Instructions' },
        status: () => 'present',
        paths: [
            {
                id: 'null-source',
                label: 'Null source',
                kind: 'source',
                path: () => null
            },
            {
                id: 'undefined-config',
                label: 'Undefined config',
                kind: 'config',
                path: () => undefined
            },
            {
                id: 'blank-artifact',
                label: 'Blank artifact',
                kind: 'artifact',
                path: () => '   '
            }
        ]
    });

    assert.deepEqual(
        buildReportUiTabMetadata(contract, {}).paths.map(({ id, path }) => ({ id, path })),
        [
            { id: 'null-source', path: null },
            { id: 'undefined-config', path: null },
            { id: 'blank-artifact', path: null }
        ]
    );
});

test('report UI tab contract rejects ambiguous empty and duplicate metadata', () => {
    assert.throws(
        () => defineReportUiTabContract({
            id: ' ',
            label: { key: 'backupsTab', fallback: 'Backups' },
            status: () => 'present'
        }),
        /id must be a non-empty string/u
    );
    assert.throws(
        () => defineReportUiTabContract({
            id: 'backups',
            label: { key: 'backupsTab', fallback: 'Backups' },
            status: () => 'present',
            paths: [
                { id: 'config', label: 'First', kind: 'config', path: () => 'one.json' },
                { id: 'config', label: 'Second', kind: 'config', path: () => 'two.json' }
            ]
        }),
        /duplicate path id 'config'/u
    );
    assert.throws(
        () => defineReportUiTabContract({
            id: 'backups',
            label: { key: 'backupsTab', fallback: 'Backups' },
            status: () => 'present',
            paths: [
                {
                    id: 'config',
                    label: 'Config',
                    kind: 'unsupported' as never,
                    path: () => 'workflow-config.json'
                }
            ]
        }),
        /unsupported kind 'unsupported'/u
    );
});
