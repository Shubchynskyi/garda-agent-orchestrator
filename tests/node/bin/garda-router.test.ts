import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { inferBundleNameFromPackageRoot, resolveDelegatedLauncherTarget } from '../../../src/bin/garda';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createGardaPackageRoot(rootPath: string, version = '2.4.0'): void {
    writeFile(path.join(rootPath, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version
    }, null, 2));
    writeFile(path.join(rootPath, 'VERSION'), `${version}\n`);
    writeFile(path.join(rootPath, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    writeFile(path.join(rootPath, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
}

test('global launcher delegates to source checkout in current workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        createGardaPackageRoot(sourceRoot);
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            sourceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(sourceRoot, 'bin', 'garda.js'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher delegates to deployed bundle when workspace contains managed bundle', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        createGardaPackageRoot(bundleRoot, '2.4.0');
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(bundleRoot, 'bin', 'garda.js'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher delegates to custom-named deployed bundle without explicit bundle-name override', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-custom-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0');
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(bundleRoot, 'bin', 'garda.js'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher respects explicit --target-root when cwd is outside the workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-target-root-'));
    try {
        const callerRoot = path.join(tempRoot, 'caller');
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(callerRoot, { recursive: true });
        createGardaPackageRoot(bundleRoot, '2.4.0');
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status', '--target-root', workspaceRoot],
            callerRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(bundleRoot, 'bin', 'garda.js'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('local source launcher does not delegate to itself', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-local-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        createGardaPackageRoot(sourceRoot);

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            sourceRoot,
            path.join(sourceRoot, 'bin', 'garda.js'),
            sourceRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('local deployed bundle launcher does not redirect to source checkout', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-local-bundle-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        const bundleRoot = path.join(sourceRoot, 'garda-agent-orchestrator');
        createGardaPackageRoot(sourceRoot);
        createGardaPackageRoot(bundleRoot, '2.4.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            sourceRoot,
            path.join(bundleRoot, 'bin', 'garda.js'),
            bundleRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('inferBundleNameFromPackageRoot detects nested deployed bundle name', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-infer-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0');

        assert.equal(inferBundleNameFromPackageRoot(bundleRoot), 'custom-bundle');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('inferBundleNameFromPackageRoot returns null for source checkout roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-infer-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        createGardaPackageRoot(sourceRoot, '2.4.0');

        assert.equal(inferBundleNameFromPackageRoot(sourceRoot), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('inferBundleNameFromPackageRoot does not infer bundle name for source checkout nested under parent TASK.md', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-infer-source-parent-task-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const sourceRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(sourceRoot, '2.4.0');
        writeFile(path.join(sourceRoot, 'tests', 'node', 'placeholder.test.ts'), '');
        writeFile(path.join(sourceRoot, 'scripts', 'node-foundation', 'placeholder.ts'), '');

        assert.equal(inferBundleNameFromPackageRoot(sourceRoot), null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
