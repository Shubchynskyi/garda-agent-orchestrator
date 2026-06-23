import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getRuntimeCandidates,
    inferBundleNameFromPackageRoot,
    loadCliMainModule,
    main,
    resolveDelegatedLauncherTrustEvidence,
    resolveDelegatedLauncherTarget
} from '../../../src/bin/garda';

function writeFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createGardaPackageRoot(
    rootPath: string,
    version = '2.4.0',
    options?: { sourceCheckout?: boolean; deployedBundle?: boolean }
): void {
    writeFile(path.join(rootPath, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version
    }, null, 2));
    writeFile(path.join(rootPath, 'VERSION'), `${version}\n`);
    writeFile(path.join(rootPath, 'bin', 'garda.js'), '#!/usr/bin/env node\n');
    if (options?.sourceCheckout) {
        writeFile(path.join(rootPath, 'src', 'bin', 'garda.ts'), 'export {};\n');
        writeFile(path.join(rootPath, 'scripts', 'node-foundation', 'build-scripts.cjs'), 'module.exports = {};\n');
        writeFile(path.join(rootPath, 'tests', 'node', 'placeholder.test.ts'), '');
    }
    if (options?.deployedBundle) {
        writeFile(path.join(rootPath, 'MANIFEST.md'), '- bin/garda.js\n');
        writeFile(path.join(rootPath, 'live', 'version.json'), `{"version":${JSON.stringify(version)}}\n`);
        writeFile(path.join(rootPath, 'live', 'docs', 'agent-rules', '00-core.md'), '# Core Rules\n');
        writeFile(path.join(rootPath, 'live', 'config', 'profiles.json'), '{}\n');
        writeFile(path.join(rootPath, 'live', 'config', 'review-capabilities.json'), '{}\n');
    }
}

function withBundleName<T>(bundleName: string | undefined, action: () => T): T {
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    if (bundleName === undefined) {
        delete process.env.GARDA_BUNDLE_NAME;
    } else {
        process.env.GARDA_BUNDLE_NAME = bundleName;
    }
    try {
        return action();
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
    }
}

function waitForChildExit(child: childProcess.ChildProcess): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        if (child.exitCode === 0) {
            return Promise.resolve();
        }
        const status = child.signalCode ? `signal ${child.signalCode}` : `code ${child.exitCode}`;
        return Promise.reject(new Error(`child exited with ${status}`));
    }

    return new Promise((resolve, reject) => {
        let stderr = '';
        child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) {
                resolve();
                return;
            }
            const status = signal ? `signal ${signal}` : `code ${code}`;
            reject(new Error(stderr || `child exited with ${status}`));
        });
    });
}

test('global launcher delegates to source checkout in current workspace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });
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
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
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

test('global launcher ignores default-named deployed bundles outside the workspace boundary', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-boundary-'));
    try {
        const projectsRoot = path.join(tempRoot, 'Projects');
        const workspaceRoot = path.join(projectsRoot, 'Startpage for site');
        const externalGardaRoot = path.join(projectsRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        createGardaPackageRoot(externalGardaRoot, '9.9.9', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '1.0.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );
        assert.equal(evidence.current_runtime.package_version, '1.0.0');
        assert.equal(evidence.delegated_runtime, null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher ignores default-named source checkouts outside the workspace boundary', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-boundary-source-'));
    try {
        const projectsRoot = path.join(tempRoot, 'Projects');
        const workspaceRoot = path.join(projectsRoot, 'Startpage for site');
        const externalSourceRoot = path.join(projectsRoot, 'garda-agent-orchestrator');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        createGardaPackageRoot(externalSourceRoot, '9.9.9', { sourceCheckout: true });
        createGardaPackageRoot(globalPackageRoot, '1.0.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);

        const evidence = resolveDelegatedLauncherTrustEvidence(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );
        assert.equal(evidence.current_runtime.package_version, '1.0.0');
        assert.equal(evidence.delegated_runtime, null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher delegates to preferred deployed bundle when fallback candidates also exist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-preferred-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const preferredBundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
        const fallbackBundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(preferredBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(fallbackBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(preferredBundleRoot, 'bin', 'garda.js'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher does not infer custom-named deployed bundles without explicit bundle-name override', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-custom-bundle-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');
        const diagnostics: string[] = [];
        const originalConsoleError = console.error;
        console.error = (message?: unknown, ...optionalParams: unknown[]): void => {
            diagnostics.push([message, ...optionalParams].map(String).join(' '));
        };

        try {
            const delegatedCli = withBundleName(undefined, () => resolveDelegatedLauncherTarget(
                ['status'],
                workspaceRoot,
                path.join(globalPackageRoot, 'bin', 'garda.js'),
                globalPackageRoot
            ));

            assert.equal(delegatedCli, null);
        } finally {
            console.error = originalConsoleError;
        }
        assert.deepEqual(diagnostics, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher ignores ambiguous custom deployed bundle candidates without explicit bundle-name override', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-ambiguous-'));
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const alphaBundleRoot = path.join(workspaceRoot, 'alpha-bundle');
        const betaBundleRoot = path.join(workspaceRoot, 'beta-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(alphaBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(betaBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        const delegatedCli = withBundleName(undefined, () => resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        ));

        assert.equal(delegatedCli, null);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher uses explicit bundle name to select a custom deployed bundle', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-explicit-'));
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const customBundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const otherBundleRoot = path.join(workspaceRoot, 'other-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(customBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(otherBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');
        process.env.GARDA_BUNDLE_NAME = 'custom-bundle';

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, path.join(customBundleRoot, 'bin', 'garda.js'));
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher does not use fallback candidates for explicit missing bundle name', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-explicit-missing-'));
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const fallbackBundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(fallbackBundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');
        process.env.GARDA_BUNDLE_NAME = 'missing-bundle';

        const delegatedCli = resolveDelegatedLauncherTarget(
            ['status'],
            workspaceRoot,
            path.join(globalPackageRoot, 'bin', 'garda.js'),
            globalPackageRoot
        );

        assert.equal(delegatedCli, null);
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher rejects bundle-name values that are paths', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-bundle-name-path-'));
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    try {
        const workspaceRoot = path.join(tempRoot, 'workspace');
        const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
        const globalPackageRoot = path.join(tempRoot, 'global', 'node_modules', 'garda-agent-orchestrator');
        fs.mkdirSync(workspaceRoot, { recursive: true });
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
        createGardaPackageRoot(globalPackageRoot, '2.3.0');

        for (const invalidBundleName of ['', ' custom-bundle', 'custom-bundle ', '.', '..', '-custom-bundle', '../custom-bundle', 'nested/custom-bundle', 'nested\\custom-bundle']) {
            process.env.GARDA_BUNDLE_NAME = invalidBundleName;

            assert.throws(
                () => resolveDelegatedLauncherTarget(
                    ['status'],
                    workspaceRoot,
                    path.join(globalPackageRoot, 'bin', 'garda.js'),
                    globalPackageRoot
                ),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, /GARDA_BUNDLE_NAME must be a deployed bundle directory name/);
                    assert.match(error.message, /not a path/);
                    return true;
                }
            );
        }
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher rejects path-like --bundle-name arguments before discovery', async () => {
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    try {
        await assert.rejects(
            () => main(['status', '--bundle-name=../custom-bundle'], process.cwd()),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /--bundle-name must be a deployed bundle directory name/);
                assert.match(error.message, /not a path/);
                return true;
            }
        );
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
    }
});

test('global launcher rejects missing or option-like --bundle-name arguments before discovery', async () => {
    const previousBundleName = process.env.GARDA_BUNDLE_NAME;
    try {
        for (const argv of [
            ['status', '--bundle-name'],
            ['status', '--bundle-name', '--target-root'],
            ['status', '--bundle-name', '-custom-bundle']
        ]) {
            await assert.rejects(
                () => main(argv, process.cwd()),
                (error: unknown) => {
                    assert.ok(error instanceof Error);
                    assert.match(error.message, /--bundle-name requires a deployed bundle directory name value/);
                    return true;
                }
            );
        }
    } finally {
        if (previousBundleName === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = previousBundleName;
        }
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
        writeFile(path.join(workspaceRoot, 'TASK.md'), '# Tasks\n');
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });
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
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });

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
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });

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
        createGardaPackageRoot(bundleRoot, '2.4.0', { deployedBundle: true });

        assert.equal(inferBundleNameFromPackageRoot(bundleRoot), 'custom-bundle');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('inferBundleNameFromPackageRoot returns null for source checkout roots', () => {
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-infer-source-'));
    try {
        const sourceRoot = path.join(tempRoot, 'repo');
        createGardaPackageRoot(sourceRoot, '2.4.0', { sourceCheckout: true });

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

test('getRuntimeCandidates prefers dist runtime over .node-build when both exist', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-order-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(tempRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, [
            path.join(tempRoot, 'dist', 'src'),
            path.join(tempRoot, '.node-build', 'src')
        ]);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('getRuntimeCandidates falls back to .node-build when dist runtime is absent', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-fallback-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, [
            path.join(tempRoot, '.node-build', 'src')
        ]);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('getRuntimeCandidates excludes .node-build for deployed bundle roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-deployed-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { deployedBundle: true });
        writeFile(path.join(tempRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, [
            path.join(tempRoot, 'dist', 'src')
        ]);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('getRuntimeCandidates does not use .node-build-only deployed bundle roots', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-deployed-node-build-only-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { deployedBundle: true });
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');

        const candidates = getRuntimeCandidates(tempRoot);
        assert.deepEqual(candidates, []);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('loadCliMainModule fails corrupt deployed dist instead of falling back to .node-build', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-corrupt-deployed-dist-'));
    try {
        createGardaPackageRoot(tempRoot, '2.4.0', { deployedBundle: true });
        writeFile(path.join(tempRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(
            path.join(tempRoot, 'dist', 'src', 'cli', 'main.js'),
            'require("./definitely-missing-runtime-module");\n'
        );
        writeFile(path.join(tempRoot, '.node-build', 'src', 'index.js'), 'module.exports = {};\n');
        writeFile(
            path.join(tempRoot, '.node-build', 'src', 'cli', 'main.js'),
            'exports.runCliMainWithHandling = async function () {};\n'
        );

        assert.throws(
            () => loadCliMainModule(tempRoot),
            /definitely-missing-runtime-module/
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('loadCliMainModule waits for source checkout dist build lock before loading runtime', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-dist-lock-'));
    const previousTimeout = process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
    const distSourceRoot = path.join(tempRoot, 'dist', 'src');
    const distLockPath = path.join(tempRoot, 'dist.lock');
    let child: childProcess.ChildProcess | null = null;

    try {
        process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = '5000';
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(distSourceRoot, 'index.js'), 'module.exports = {};\n');
        writeFile(path.join(distSourceRoot, 'cli', 'main.js'), 'module.exports = require("./late-module");\n');
        fs.mkdirSync(distLockPath, { recursive: true });

        const workerScript = [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            'const distSourceRoot = process.argv[1];',
            'const lockPath = process.argv[2];',
            'setTimeout(() => {',
            "  fs.mkdirSync(path.join(distSourceRoot, 'cli'), { recursive: true });",
            "  fs.writeFileSync(path.join(distSourceRoot, 'cli', 'late-module.js'), 'exports.runCliMainWithHandling = async function () {};\\n', 'utf8');",
            '  fs.rmSync(lockPath, { recursive: true, force: true });',
            '}, 150);'
        ].join('\n');
        child = childProcess.spawn(process.execPath, ['--eval', workerScript, distSourceRoot, distLockPath], {
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true
        });

        const module = loadCliMainModule(tempRoot);
        assert.equal(typeof module.runCliMainWithHandling, 'function');
        await waitForChildExit(child);
    } finally {
        if (previousTimeout === undefined) {
            delete process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
        } else {
            process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = previousTimeout;
        }
        if (child && child.exitCode === null) {
            child.kill();
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('loadCliMainModule enforces one runtime lock timeout budget per candidate', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-router-runtime-lock-timeout-'));
    const previousTimeout = process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
    const distSourceRoot = path.join(tempRoot, 'dist', 'src');
    const nodeBuildSourceRoot = path.join(tempRoot, '.node-build', 'src');
    const nodeBuildLockPath = path.join(tempRoot, '.node-build.lock');

    try {
        process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = '120';
        createGardaPackageRoot(tempRoot, '2.4.0', { sourceCheckout: true });
        writeFile(path.join(distSourceRoot, 'index.js'), 'module.exports = {};\n');
        writeFile(
            path.join(distSourceRoot, 'cli', 'main.js'),
            'require("./missing-during-refresh");\n'
        );
        writeFile(path.join(nodeBuildSourceRoot, 'index.js'), 'module.exports = {};\n');
        writeFile(
            path.join(nodeBuildSourceRoot, 'cli', 'main.js'),
            'exports.runCliMainWithHandling = async function () {};\n'
        );
        fs.mkdirSync(nodeBuildLockPath, { recursive: true });

        const startedAt = Date.now();
        assert.throws(
            () => loadCliMainModule(tempRoot),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out waiting for Garda Agent Orchestrator runtime build lock to clear/);
                assert.match(error.message, /\.node-build\.lock/);
                return true;
            }
        );
        const elapsedMs = Date.now() - startedAt;
        assert.ok(elapsedMs >= 180, `fallback candidate should receive its own timeout budget, got ${elapsedMs}ms`);
        assert.ok(elapsedMs < 1_000, `lock timeout should use bounded per-candidate budgets, got ${elapsedMs}ms`);
    } finally {
        if (previousTimeout === undefined) {
            delete process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS;
        } else {
            process.env.GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS = previousTimeout;
        }
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
