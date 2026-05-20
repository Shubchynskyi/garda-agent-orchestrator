import test from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runSwitchMode } from '../../../src/materialization/switch-mode';
import { runInstall } from '../../../src/materialization/install';
import { MANAGED_END, MANAGED_START } from '../../../src/materialization/content-builders';

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'VERSION')) && fs.existsSync(path.join(current, 'template'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error(`Cannot find repo root from ${startDir}`);
}

function copyDirRecursive(sourcePath: string, targetPath: string): void {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath, { withFileTypes: true })) {
        const sourceEntryPath = path.join(sourcePath, entry.name);
        const targetEntryPath = path.join(targetPath, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(sourceEntryPath, targetEntryPath);
        } else {
            fs.copyFileSync(sourceEntryPath, targetEntryPath);
        }
    }
}

function createWorkspace(): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-switch-mode-'));
    const runtimeRoot = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeRoot, { recursive: true });
    fs.writeFileSync(path.join(workspaceRoot, 'TASK.md'), '# tasks\n', 'utf8');
    fs.writeFileSync(path.join(runtimeRoot, 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        ProviderMinimalism: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
    return workspaceRoot;
}

function createInstallWorkspace(): string {
    const repoRoot = findRepoRoot(__dirname);
    const workspaceRoot = createWorkspace();
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    fs.copyFileSync(path.join(repoRoot, 'VERSION'), path.join(bundleRoot, 'VERSION'));
    copyDirRecursive(path.join(repoRoot, 'template'), path.join(bundleRoot, 'template'));
    return workspaceRoot;
}

function managedFile(title: string): string {
    return `${MANAGED_START}\n# ${title}\n${MANAGED_END}\n`;
}

function switchAgentIgnoreBlock(bundleName = 'garda-agent-orchestrator'): string {
    return `${MANAGED_START}\n# Garda off-mode agent ignore\n${bundleName}/\n${MANAGED_END}\n`;
}

function sha256(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
}

function writeSwitchState(
    workspaceRoot: string,
    mode: 'on' | 'off',
    options: { off?: Record<string, string>; on?: Record<string, string> }
): void {
    const statePath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const entries = (files: Record<string, string> | undefined) => Object.entries(files || {}).map(([relativePath, content]) => ({
        relative_path: relativePath,
        sha256: sha256(content)
    }));
    fs.writeFileSync(statePath, JSON.stringify({
        schema_version: 1,
        mode,
        candidates: ['AGENTS.md'],
        root_files: [],
        off_storage_files: entries(options.off),
        on_storage_files: entries(options.on)
    }, null, 2), 'utf8');
}

test('runSwitchMode off hides managed root instructions and restores user alternatives', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
    const storedUserPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md');
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.writeFileSync(claudePath, managedFile('Claude rules'), 'utf8');
    fs.mkdirSync(path.dirname(storedUserPath), { recursive: true });
    fs.writeFileSync(storedUserPath, '# user rules\n', 'utf8');
    writeSwitchState(workspaceRoot, 'on', { on: { 'AGENTS.md': '# user rules\n' } });

    const result = runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' });

    assert.equal(result.status, 'UPDATED');
    assert.equal(result.movedToInactive, 2);
    assert.equal(result.movedToRoot, 1);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), '# user rules\n');
    assert.ok(!fs.existsSync(claudePath));
    assert.equal(
        fs.readFileSync(path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md'), 'utf8'),
        managedFile('Garda rules')
    );
    assert.equal(
        fs.readFileSync(path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'CLAUDE.md'), 'utf8'),
        managedFile('Claude rules')
    );
    assert.ok(fs.existsSync(path.join(workspaceRoot, 'TASK.md')));
    assert.match(fs.readFileSync(path.join(workspaceRoot, '.agentignore'), 'utf8'), /garda-agent-orchestrator\//);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode dry-run reports planned changes without moving files', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedUserPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md');
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.mkdirSync(path.dirname(storedUserPath), { recursive: true });
    fs.writeFileSync(storedUserPath, '# user rules\n', 'utf8');
    writeSwitchState(workspaceRoot, 'on', { on: { 'AGENTS.md': '# user rules\n' } });
    const statePath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'state.json');
    const stateBefore = fs.readFileSync(statePath, 'utf8');

    const result = runSwitchMode({ targetRoot: workspaceRoot, mode: 'off', dryRun: true });

    assert.equal(result.status, 'UPDATED');
    assert.equal(result.dryRun, true);
    assert.equal(result.movedToInactive, 1);
    assert.equal(result.movedToRoot, 1);
    assert.equal(result.agentIgnoreUpdated, true);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), managedFile('Garda rules'));
    assert.equal(fs.readFileSync(storedUserPath, 'utf8'), '# user rules\n');
    assert.ok(!fs.existsSync(path.join(workspaceRoot, '.agentignore')));
    assert.equal(fs.readFileSync(statePath, 'utf8'), stateBefore);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode on restores managed instructions and stores user alternatives', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const claudePath = path.join(workspaceRoot, 'CLAUDE.md');
    const storedManagedPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md');
    const storedClaudePath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'CLAUDE.md');
    fs.writeFileSync(agentsPath, '# user rules\n', 'utf8');
    fs.mkdirSync(path.dirname(storedManagedPath), { recursive: true });
    fs.writeFileSync(storedManagedPath, managedFile('Garda rules'), 'utf8');
    fs.writeFileSync(storedClaudePath, managedFile('Claude rules'), 'utf8');
    writeSwitchState(workspaceRoot, 'off', {
        off: {
            'AGENTS.md': managedFile('Garda rules'),
            'CLAUDE.md': managedFile('Claude rules')
        }
    });
    fs.writeFileSync(path.join(workspaceRoot, '.agentignore'), `custom\n${switchAgentIgnoreBlock()}`, 'utf8');

    const result = runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' });

    assert.equal(result.status, 'UPDATED');
    assert.equal(result.movedToInactive, 1);
    assert.equal(result.movedToRoot, 2);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), managedFile('Garda rules'));
    assert.equal(fs.readFileSync(claudePath, 'utf8'), managedFile('Claude rules'));
    assert.equal(
        fs.readFileSync(path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md'), 'utf8'),
        '# user rules\n'
    );
    assert.equal(fs.readFileSync(path.join(workspaceRoot, '.agentignore'), 'utf8'), 'custom\n');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode off appends switch agentignore block without replacing unrelated managed content', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const agentIgnorePath = path.join(workspaceRoot, '.agentignore');
    const unrelatedManagedBlock = `${MANAGED_START}\n# Other managed ignore\ncoverage/\n${MANAGED_END}\n`;
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.writeFileSync(agentIgnorePath, `custom\n${unrelatedManagedBlock}`, 'utf8');

    const result = runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' });

    assert.equal(result.status, 'UPDATED');
    assert.equal(
        fs.readFileSync(agentIgnorePath, 'utf8'),
        `custom\n${unrelatedManagedBlock}${switchAgentIgnoreBlock()}`
    );

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode on/off transitions preserve active agentignore block and only toggle off-mode full ignore', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedManagedPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md');
    const agentIgnorePath = path.join(workspaceRoot, '.agentignore');
    const activeBlock = `${MANAGED_START}\n# Garda active-mode agent ignore\ngarda-agent-orchestrator/dist/\n${MANAGED_END}\n`;
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.writeFileSync(agentIgnorePath, `custom\n${activeBlock}`, 'utf8');

    const offResult = runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' });
    assert.equal(offResult.status, 'UPDATED');
    assert.equal(
        fs.readFileSync(agentIgnorePath, 'utf8'),
        `custom\n${activeBlock}${switchAgentIgnoreBlock()}`
    );

    fs.mkdirSync(path.dirname(storedManagedPath), { recursive: true });
    writeSwitchState(workspaceRoot, 'off', { off: { 'AGENTS.md': managedFile('Garda rules') } });
    const onResult = runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' });
    assert.equal(onResult.status, 'UPDATED');
    assert.equal(fs.readFileSync(agentIgnorePath, 'utf8'), `custom\n${activeBlock}`);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode on removes only the switch agentignore block', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedManagedPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md');
    const agentIgnorePath = path.join(workspaceRoot, '.agentignore');
    const unrelatedManagedBlock = `${MANAGED_START}\n# Other managed ignore\ncoverage/\n${MANAGED_END}\n`;
    fs.writeFileSync(agentsPath, '# user rules\n', 'utf8');
    fs.mkdirSync(path.dirname(storedManagedPath), { recursive: true });
    fs.writeFileSync(storedManagedPath, managedFile('Garda rules'), 'utf8');
    writeSwitchState(workspaceRoot, 'off', { off: { 'AGENTS.md': managedFile('Garda rules') } });
    fs.writeFileSync(agentIgnorePath, `custom\n${unrelatedManagedBlock}${switchAgentIgnoreBlock()}`, 'utf8');

    const result = runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' });

    assert.equal(result.status, 'UPDATED');
    assert.equal(fs.readFileSync(agentIgnorePath, 'utf8'), `custom\n${unrelatedManagedBlock}`);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode on does not move user root alternatives when managed storage is missing', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# user rules\n', 'utf8');

    const result = runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' });

    assert.equal(result.status, 'NO_CHANGE');
    assert.equal(result.movedToInactive, 0);
    assert.equal(result.movedToRoot, 0);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), '# user rules\n');
    assert.ok(!fs.existsSync(path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md')));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode repeated same-mode transitions are idempotent no-change operations', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedUserPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md');
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.mkdirSync(path.dirname(storedUserPath), { recursive: true });
    fs.writeFileSync(storedUserPath, '# user rules\n', 'utf8');
    writeSwitchState(workspaceRoot, 'on', { on: { 'AGENTS.md': '# user rules\n' } });

    const firstOff = runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' });
    const secondOff = runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' });
    const firstOn = runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' });
    const secondOn = runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' });

    assert.equal(firstOff.status, 'UPDATED');
    assert.equal(secondOff.status, 'NO_CHANGE');
    assert.equal(secondOff.movedToInactive, 0);
    assert.equal(secondOff.movedToRoot, 0);
    assert.equal(secondOff.agentIgnoreUpdated, false);
    assert.equal(firstOn.status, 'UPDATED');
    assert.equal(secondOn.status, 'NO_CHANGE');
    assert.equal(secondOn.movedToInactive, 0);
    assert.equal(secondOn.movedToRoot, 0);
    assert.equal(secondOn.agentIgnoreUpdated, false);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), managedFile('Garda rules'));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode blocks conflicting user alternative storage without changing root files', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedUserPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md');
    const storedManagedPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# current user rules\n', 'utf8');
    fs.mkdirSync(path.dirname(storedUserPath), { recursive: true });
    fs.mkdirSync(path.dirname(storedManagedPath), { recursive: true });
    fs.writeFileSync(storedUserPath, '# stored user rules\n', 'utf8');
    fs.writeFileSync(storedManagedPath, managedFile('Garda rules'), 'utf8');
    writeSwitchState(workspaceRoot, 'off', { off: { 'AGENTS.md': managedFile('Garda rules') } });

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' }),
        /GARDA_SWITCH_BLOCKED/
    );
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), '# current user rules\n');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode blocks tampered storage before restoring it to root', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedManagedPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md');
    fs.writeFileSync(agentsPath, '# user rules\n', 'utf8');
    fs.mkdirSync(path.dirname(storedManagedPath), { recursive: true });
    fs.writeFileSync(storedManagedPath, managedFile('Garda rules'), 'utf8');
    writeSwitchState(workspaceRoot, 'off', { off: { 'AGENTS.md': managedFile('Garda rules') } });
    fs.writeFileSync(storedManagedPath, managedFile('Tampered rules'), 'utf8');

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' }),
        /AGENTS\.md: off storage file hash does not match switch-state integrity manifest/
    );
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), '# user rules\n');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode blocks stored alternatives that lack switch-state manifest ownership', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedUserPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'on', 'AGENTS.md');
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.mkdirSync(path.dirname(storedUserPath), { recursive: true });
    fs.writeFileSync(storedUserPath, '# user rules\n', 'utf8');

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' }),
        /AGENTS\.md: on storage file has no switch-state integrity manifest entry/
    );
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), managedFile('Garda rules'));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode blocks symlinked switch candidates without reading or moving them', (t) => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const outsidePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'garda-switch-outside-')), 'outside.md');
    fs.writeFileSync(outsidePath, managedFile('Outside rules'), 'utf8');
    try {
        fs.symlinkSync(outsidePath, agentsPath, 'file');
    } catch {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(path.dirname(outsidePath), { recursive: true, force: true });
        t.skip('file symlink creation is unavailable in this environment');
        return;
    }

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' }),
        /AGENTS\.md: root file contains symbolic link/
    );
    assert.equal(fs.readlinkSync(agentsPath), outsidePath);
    assert.ok(!fs.existsSync(path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md')));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(path.dirname(outsidePath), { recursive: true, force: true });
});

test('runSwitchMode blocks symlinked storage parent directories before moving root files', (t) => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const switchRoot = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch');
    const offRoot = path.join(switchRoot, 'off');
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-switch-storage-'));
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.mkdirSync(switchRoot, { recursive: true });
    try {
        fs.symlinkSync(outsideRoot, offRoot, 'dir');
    } catch {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
        t.skip('directory symlink creation is unavailable in this environment');
        return;
    }

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' }),
        /AGENTS\.md: off storage file contains symbolic link/
    );
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), managedFile('Garda rules'));
    assert.ok(!fs.existsSync(path.join(outsideRoot, 'AGENTS.md')));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
    fs.rmSync(outsideRoot, { recursive: true, force: true });
});

test('runSwitchMode blocks malformed managed agentignore markers without rewriting user content', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const storedManagedPath = path.join(workspaceRoot, 'garda-agent-orchestrator', 'runtime', 'switch', 'off', 'AGENTS.md');
    const agentIgnorePath = path.join(workspaceRoot, '.agentignore');
    fs.writeFileSync(agentsPath, '# user rules\n', 'utf8');
    fs.mkdirSync(path.dirname(storedManagedPath), { recursive: true });
    fs.writeFileSync(storedManagedPath, managedFile('Garda rules'), 'utf8');
    fs.writeFileSync(agentIgnorePath, `custom\n${MANAGED_START}\ngarda-agent-orchestrator/\n`, 'utf8');

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'on' }),
        /\.agentignore: managed block markers are incomplete/
    );
    assert.equal(fs.readFileSync(agentIgnorePath, 'utf8'), `custom\n${MANAGED_START}\ngarda-agent-orchestrator/\n`);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), '# user rules\n');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runSwitchMode off blocks malformed managed agentignore markers without appending managed content', () => {
    const workspaceRoot = createWorkspace();
    const agentsPath = path.join(workspaceRoot, 'AGENTS.md');
    const agentIgnorePath = path.join(workspaceRoot, '.agentignore');
    fs.writeFileSync(agentsPath, managedFile('Garda rules'), 'utf8');
    fs.writeFileSync(agentIgnorePath, `custom\n${MANAGED_START}\ngarda-agent-orchestrator/\n`, 'utf8');

    assert.throws(
        () => runSwitchMode({ targetRoot: workspaceRoot, mode: 'off' }),
        /\.agentignore: managed block markers are incomplete/
    );
    assert.equal(fs.readFileSync(agentIgnorePath, 'utf8'), `custom\n${MANAGED_START}\ngarda-agent-orchestrator/\n`);
    assert.equal(fs.readFileSync(agentsPath, 'utf8'), managedFile('Garda rules'));

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test('runInstall reapplies off mode after materializing managed root instructions', () => {
    const workspaceRoot = createInstallWorkspace();
    const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const storedUserPath = path.join(bundleRoot, 'runtime', 'switch', 'on', 'AGENTS.md');
    fs.mkdirSync(path.dirname(storedUserPath), { recursive: true });
    fs.writeFileSync(storedUserPath, '# user rules\n', 'utf8');
    writeSwitchState(workspaceRoot, 'off', { on: { 'AGENTS.md': '# user rules\n' } });

    runInstall({
        targetRoot: workspaceRoot,
        bundleRoot,
        assistantLanguage: 'English',
        assistantBrevity: 'concise',
        sourceOfTruth: 'Codex',
        initAnswersPath: 'garda-agent-orchestrator/runtime/init-answers.json',
        runInit: false
    });

    assert.equal(fs.readFileSync(path.join(workspaceRoot, 'AGENTS.md'), 'utf8'), '# user rules\n');
    assert.ok(fs.existsSync(path.join(bundleRoot, 'runtime', 'switch', 'off', 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(workspaceRoot, 'TASK.md')));
    assert.match(fs.readFileSync(path.join(workspaceRoot, '.agentignore'), 'utf8'), /garda-agent-orchestrator\//);

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
});
