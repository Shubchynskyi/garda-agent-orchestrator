import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    setLocalUiTaskResetEnabled,
    writeLocalUiRepoFixture,
    writeLocalUiTaskQueue
} from './local-ui-test-helpers';

test('local UI cleanup removes temp repo while preserving server close failures', async () => {
    const repoRoot = makeLocalUiTempRepo();
    fs.writeFileSync(path.join(repoRoot, 'marker.txt'), 'cleanup');

    await assert.rejects(
        () => cleanupLocalUiTestResources({
            repoRoot,
            server: {
                close: async () => {
                    throw new Error('close failed');
                }
            }
        }),
        /close failed/u
    );
    assert.equal(fs.existsSync(repoRoot), false);
});

test('local UI fixture helpers seed repo config and task queue consistently', () => {
    const repoRoot = makeLocalUiTempRepo();

    writeLocalUiRepoFixture(repoRoot);
    setLocalUiTaskResetEnabled(repoRoot, true);
    writeLocalUiTaskQueue(repoRoot, 'T-101', 'Updated UI');

    const taskQueue = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
    assert.match(taskQueue, /\| T-101 \| TODO \| P2 \| ui\/report \| Updated UI \|/u);
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { task_reset: { enabled: boolean } };
    assert.equal(config.task_reset.enabled, true);
    assert.equal(fs.existsSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'agent-init-state.json')), true);
    assert.equal(fs.existsSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'compact.md')), true);
});
