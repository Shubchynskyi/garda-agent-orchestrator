import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getRuntimeCandidates,
    inferBundleNameFromPackageRoot,
    loadCliMainModule,
    main,
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

test('global launcher delegates to custom-named deployed bundle without explicit bundle-name override', () => {
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

            assert.equal(delegatedCli, path.join(bundleRoot, 'bin', 'garda.js'));
        } finally {
            console.error = originalConsoleError;
        }
        assert.equal(diagnostics.length, 1);
        assert.match(diagnostics[0], /single detected fallback candidate 'custom-bundle'/);
        assert.match(diagnostics[0], /--bundle-name/);
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher fails closed when multiple fallback deployed bundle candidates exist', () => {
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

        assert.throws(
            () => withBundleName(undefined, () => resolveDelegatedLauncherTarget(
                ['status'],
                workspaceRoot,
                path.join(globalPackageRoot, 'bin', 'garda.js'),
                globalPackageRoot
            )),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Multiple Garda Agent Orchestrator deployed bundle candidates found/);
                assert.match(error.message, /alpha-bundle/);
                assert.match(error.message, /beta-bundle/);
                assert.match(error.message, /--bundle-name/);
                return true;
            }
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('global launcher uses explicit bundle name to resolve fallback ambiguity', () => {
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

test('global launcher rejects explicit missing bundle name instead of using single fallback', () => {
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

        assert.throws(
            () => resolveDelegatedLauncherTarget(
                ['status'],
                workspaceRoot,
                path.join(globalPackageRoot, 'bin', 'garda.js'),
                globalPackageRoot
            ),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /deployed bundle 'missing-bundle' was not found/);
                assert.match(error.message, /custom-bundle/);
                return true;
            }
        );
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
