import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { buildUpdateLifecycleRunner } from '../../../src/cli/commands/shared-command-utils';
import {
    cleanupOldUpdateTempRoots,
    getUpdateTempRoot,
    resolveNpmUpdateSourceSpec,
    runCheckUpdate
} from '../../../src/lifecycle/check-update';
import {
    BUNDLE_SYNC_ITEMS,
    removePathRecursive,
    getUpdateSentinelPath,
    readSyncBackupMetadata,
    readUpdateSentinel,
    withLifecycleOperationLockAsync
} from '../../../src/lifecycle/common';
const FIRST_NPM_RELEASE_PACKAGE_SPEC = process.env.GARDA_FIRST_NPM_RELEASE_PACKAGE_SPEC || 'garda-agent-orchestrator@1.0.0';
const NEXT_RELEASE_TEST_VERSION = process.env.GARDA_NEXT_RELEASE_TEST_VERSION || '1.0.1';

function findRepoRoot() {
    let dir = __dirname;
    while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, 'VERSION')) && fs.existsSync(path.join(dir, 'template'))) {
            return dir;
        }
        dir = path.dirname(dir);
    }
    throw new Error('Cannot find repo root');
}

function copyPathRecursive(sourcePath: string, destinationPath: string) {
    const stats = fs.lstatSync(sourcePath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    if (stats.isDirectory()) {
        fs.mkdirSync(destinationPath, { recursive: true });
        for (const entry of fs.readdirSync(sourcePath)) {
            copyPathRecursive(path.join(sourcePath, entry), path.join(destinationPath, entry));
        }
        return;
    }
    fs.copyFileSync(sourcePath, destinationPath);
}

function seedBundleSyncSurface(sourceRoot: string, bundleRoot: string) {
    for (const item of BUNDLE_SYNC_ITEMS) {
        const sourceItemPath = path.join(sourceRoot, item);
        if (!fs.existsSync(sourceItemPath)) {
            continue;
        }
        copyPathRecursive(sourceItemPath, path.join(bundleRoot, item));
    }
}

function quoteWindowsArgument(argument: string): string {
    const text = String(argument || '');
    if (!text || !/[ \t"]/u.test(text)) {
        return text;
    }

    let escaped = '"';
    let backslashCount = 0;
    for (const character of text) {
        if (character === '\\') {
            backslashCount += 1;
            continue;
        }
        if (character === '"') {
            escaped += '\\'.repeat(backslashCount * 2 + 1);
            escaped += '"';
            backslashCount = 0;
            continue;
        }
        if (backslashCount > 0) {
            escaped += '\\'.repeat(backslashCount);
            backslashCount = 0;
        }
        escaped += character;
    }
    if (backslashCount > 0) {
        escaped += '\\'.repeat(backslashCount * 2);
    }
    escaped += '"';
    return escaped;
}

function spawnNpm(args: string[], cwd: string) {
    if (process.platform === 'win32') {
        const commandLine = ['npm.cmd', ...args].map(quoteWindowsArgument).join(' ');
        return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', commandLine], {
            cwd,
            encoding: 'utf8',
            timeout: 120_000,
            windowsHide: true
        });
    }

    return spawnSync('npm', args, {
        cwd,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });
}

function getTypescriptCliPath(repoRoot: string): string {
    return path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
}

function syncGeneratedCliEntrypoint(repoRoot: string): void {
    const compiledCliPath = path.join(repoRoot, 'dist', 'src', 'bin', 'garda.js');
    if (!fs.existsSync(compiledCliPath)) {
        throw new Error(`compiled CLI launcher not found: ${compiledCliPath}`);
    }

    const repoCliPath = path.join(repoRoot, 'bin', 'garda.js');
    fs.mkdirSync(path.dirname(repoCliPath), { recursive: true });
    fs.copyFileSync(compiledCliPath, repoCliPath);
}

function loadPackFixtureItems(repoRoot: string): string[] {
    const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const items = new Set<string>(pkgJson.files || []);
    items.delete('dist');
    items.delete('bin');
    items.add('package.json');
    items.add('scripts/package-legacy-entrypoint-compat.cjs');
    items.add('scripts/node-foundation');
    items.add('tsconfig.build.json');
    items.add('tsconfig.scripts.json');
    return Array.from(items).sort();
}

function copyPackFixture(repoRoot: string, fixtureRoot: string): void {
    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of loadPackFixtureItems(repoRoot)) {
        const sourcePath = path.join(repoRoot, relativePath);
        if (!fs.existsSync(sourcePath)) {
            continue;
        }
        fs.cpSync(sourcePath, path.join(fixtureRoot, relativePath), { recursive: true });
    }

    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }
}

function buildPublishRuntimeInRepo(repoRoot: string): void {
    const result = spawnSync(process.execPath, [getTypescriptCliPath(repoRoot), '-p', 'tsconfig.build.json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        timeout: 120_000,
        windowsHide: true
    });

    if (result.status !== 0) {
        throw new Error(`publish runtime build failed:\n${result.stderr || result.stdout}`);
    }

    syncGeneratedCliEntrypoint(repoRoot);
}

function rewriteFixtureReleaseVersion(fixtureRoot: string, version: string): void {
    const packageJsonPath = path.join(fixtureRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
    packageJson.version = version;
    fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(fixtureRoot, 'VERSION'), `${version}\n`, 'utf8');
}

function createCandidateTarball(repoRoot: string) {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-candidate-pack-'));
    const fixtureRoot = path.join(tempRoot, 'pack-repo');
    copyPackFixture(repoRoot, fixtureRoot);
    rewriteFixtureReleaseVersion(fixtureRoot, NEXT_RELEASE_TEST_VERSION);
    buildPublishRuntimeInRepo(fixtureRoot);
    const legacyCompatResult = spawnSync(process.execPath, [
        'scripts/package-legacy-entrypoint-compat.cjs',
        'create'
    ], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true
    });
    if (legacyCompatResult.status !== 0) {
        throw new Error(`legacy compatibility template generation failed:\n${legacyCompatResult.stderr || legacyCompatResult.stdout}`);
    }

    const packResult = spawnNpm(['pack', '--ignore-scripts', '--pack-destination', fixtureRoot], fixtureRoot);
    if (packResult.status !== 0) {
        throw new Error(`npm pack failed:\n${packResult.stderr || packResult.stdout}`);
    }

    const lines = String(packResult.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    const tarballFilename = lines[lines.length - 1]?.trim();
    if (!tarballFilename) {
        throw new Error('npm pack did not produce a tarball filename.');
    }

    return {
        tempRoot,
        tarballPath: path.join(fixtureRoot, tarballFilename)
    };
}

function installPackageSpec(packageSpec: string, installRoot: string): string {
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(
        path.join(installRoot, 'package.json'),
        JSON.stringify({ name: 'gao-checkupdate-release-seed', version: '0.0.0', private: true }, null, 2),
        'utf8'
    );

    const installResult = spawnNpm([
        'install',
        '--prefer-offline',
        '--no-save',
        '--ignore-scripts',
        '--package-lock=false',
        '--fund=false',
        '--audit=false',
        '--no-progress',
        packageSpec
    ], installRoot);
    if (installResult.status !== 0) {
        throw new Error(`npm install failed for '${packageSpec}':\n${installResult.stderr || installResult.stdout}`);
    }

    const installedPackageRoot = path.join(installRoot, 'node_modules', 'garda-agent-orchestrator');
    if (!fs.existsSync(installedPackageRoot)) {
        throw new Error(`Installed package root not found after npm install: ${installedPackageRoot}`);
    }
    return installedPackageRoot;
}

function setupPublishedReleaseSeededCheckUpdateWorkspace(releasePackageSpec: string) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-release-seeded-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    const installRoot = path.join(tmpDir, 'legacy-release-install');
    fs.mkdirSync(bundle, { recursive: true });
    copyPathRecursive(installPackageSpec(releasePackageSpec, installRoot), bundle);
    removePathRecursive(installRoot);

    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function loadLegacyUpdateCaller(bundleRoot: string) {
    const legacyCheckUpdatePath = path.join(bundleRoot, 'dist', 'src', 'lifecycle', 'check-update.js');
    const legacySharedUtilsPath = path.join(bundleRoot, 'dist', 'src', 'cli', 'commands', 'shared-command-utils.js');

    for (const modulePath of [legacyCheckUpdatePath, legacySharedUtilsPath]) {
        try {
            delete require.cache[require.resolve(modulePath)];
        } catch {
            // ignore cache miss
        }
    }

    const legacyCheckUpdateModule = require(legacyCheckUpdatePath) as { runCheckUpdate?: typeof runCheckUpdate };
    const legacySharedUtilsModule = require(legacySharedUtilsPath) as {
        buildUpdateLifecycleRunner?: typeof buildUpdateLifecycleRunner;
    };

    if (typeof legacyCheckUpdateModule.runCheckUpdate !== 'function') {
        throw new Error(`Legacy runCheckUpdate export not found: ${legacyCheckUpdatePath}`);
    }
    if (typeof legacySharedUtilsModule.buildUpdateLifecycleRunner !== 'function') {
        throw new Error(`Legacy buildUpdateLifecycleRunner export not found: ${legacySharedUtilsPath}`);
    }

    return {
        runLegacyCheckUpdate: legacyCheckUpdateModule.runCheckUpdate,
        buildLegacyUpdateLifecycleRunner: legacySharedUtilsModule.buildUpdateLifecycleRunner
    };
}

function createSourcePathFixture(repoRoot: string): string {
    const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-source-'));
    seedBundleSyncSurface(repoRoot, sourceRoot);
    return sourceRoot;
}

function setupUpToDateSourceWorkspace(repoRoot: string) {
    const currentVersion = fs.readFileSync(path.join(repoRoot, 'VERSION'), 'utf8').trim();
    const sourceRoot = createSourcePathFixture(repoRoot);
    const { projectRoot, bundleRoot } = setupCheckUpdateWorkspace(repoRoot, currentVersion, {
        syncSurfaceFrom: sourceRoot
    });

    return {
        currentVersion,
        sourceRoot,
        projectRoot,
        bundleRoot
    };
}

function setupCheckUpdateWorkspace(
    repoRoot: string,
    deployedVersion: string,
    options: { syncSurfaceFrom?: string | null } = {}
) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-checkupdate-'));
    const bundle = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(bundle, { recursive: true });

    if (options.syncSurfaceFrom) {
        seedBundleSyncSurface(options.syncSurfaceFrom, bundle);
    }

    // Write a specific VERSION
    fs.writeFileSync(path.join(bundle, 'VERSION'), `${deployedVersion || '1.0.0'}\n`, 'utf8');

    // Create runtime dir
    fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'runtime', 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Codex',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'CLI_NONINTERACTIVE'
    }, null, 2), 'utf8');
    fs.mkdirSync(path.join(tmpDir, '.git', 'hooks'), { recursive: true });

    return { projectRoot: tmpDir, bundleRoot: bundle };
}

function seedActiveReviewIndexLock(bundleRoot: string) {
    const lockPath = path.join(bundleRoot, 'runtime', '.reviews-index.lock');
    const now = new Date().toISOString();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: now,
        heartbeat_at_utc: now,
        command: 'reviews-index'
    }), 'utf8');
}

describe('npm update source resolution', () => {
    it('resolves floating registry specs to exact package specs with integrity', () => {
        const result = resolveNpmUpdateSourceSpec('garda-agent-orchestrator@latest', {
            viewRunner(args) {
                assert.deepEqual(args, [
                    'view',
                    'garda-agent-orchestrator@latest',
                    'version',
                    'dist.integrity',
                    '--json'
                ]);
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        version: '2.3.4',
                        'dist.integrity': 'sha512-resolved'
                    })
                };
            }
        });

        assert.deepEqual(result, {
            requestedSpec: 'garda-agent-orchestrator@latest',
            exactSpec: 'garda-agent-orchestrator@2.3.4',
            packageName: 'garda-agent-orchestrator',
            version: '2.3.4',
            integrity: 'sha512-resolved',
            resolutionMode: 'resolved'
        });
    });

    it('keeps explicit exact package specs stable without latest resolution', () => {
        const result = resolveNpmUpdateSourceSpec('garda-agent-orchestrator@2.3.4', {
            viewRunner(args) {
                assert.deepEqual(args, [
                    'view',
                    'garda-agent-orchestrator@2.3.4',
                    'version',
                    'dist.integrity',
                    '--json'
                ]);
                return {
                    status: 0,
                    stdout: JSON.stringify({
                        version: '2.3.4',
                        'dist.integrity': 'sha512-exact'
                    })
                };
            }
        });

        assert.deepEqual(result, {
            requestedSpec: 'garda-agent-orchestrator@2.3.4',
            exactSpec: 'garda-agent-orchestrator@2.3.4',
            packageName: 'garda-agent-orchestrator',
            version: '2.3.4',
            integrity: 'sha512-exact',
            resolutionMode: 'explicit_exact'
        });
    });

    it('fails closed when registry resolution omits integrity', () => {
        assert.throws(
            () => resolveNpmUpdateSourceSpec('garda-agent-orchestrator@latest', {
                viewRunner() {
                    return {
                        status: 0,
                        stdout: JSON.stringify({ version: '2.3.4' })
                    };
                }
            }),
            /dist\.integrity/
        );
    });

    it('resolves range metadata arrays to the highest exact version with integrity', () => {
        const result = resolveNpmUpdateSourceSpec('garda-agent-orchestrator@^2.0.0', {
            viewRunner(args) {
                assert.deepEqual(args, [
                    'view',
                    'garda-agent-orchestrator@^2.0.0',
                    'version',
                    'dist.integrity',
                    '--json'
                ]);
                return {
                    status: 0,
                    stdout: JSON.stringify([
                        {
                            version: '2.0.1',
                            'dist.integrity': 'sha512-older'
                        },
                        {
                            version: '2.1.0',
                            'dist.integrity': 'sha512-newer'
                        }
                    ])
                };
            }
        });

        assert.deepEqual(result, {
            requestedSpec: 'garda-agent-orchestrator@^2.0.0',
            exactSpec: 'garda-agent-orchestrator@2.1.0',
            packageName: 'garda-agent-orchestrator',
            version: '2.1.0',
            integrity: 'sha512-newer',
            resolutionMode: 'resolved'
        });
    });

    it('fails closed when exact requested version differs from registry metadata', () => {
        assert.throws(
            () => resolveNpmUpdateSourceSpec('garda-agent-orchestrator@2.3.4', {
                viewRunner() {
                    return {
                        status: 0,
                        stdout: JSON.stringify({
                            version: '2.3.5',
                            'dist.integrity': 'sha512-other'
                        })
                    };
                }
            }),
            /did not match requested update package version/
        );
    });

    it('janitor removes only old Garda-owned npm update temp roots', () => {
        const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-temp-'));
        try {
            const updateTempRoot = getUpdateTempRoot(runtimeRoot);
            const oldNpmRoot = path.join(updateTempRoot, 'npm-old');
            const freshNpmRoot = path.join(updateTempRoot, 'npm-fresh');
            const foreignRoot = path.join(updateTempRoot, 'foreign-old');
            fs.mkdirSync(oldNpmRoot, { recursive: true });
            fs.mkdirSync(freshNpmRoot, { recursive: true });
            fs.mkdirSync(foreignRoot, { recursive: true });

            const now = Date.now();
            const oldDate = new Date(now - 10_000);
            fs.utimesSync(oldNpmRoot, oldDate, oldDate);
            fs.utimesSync(foreignRoot, oldDate, oldDate);

            const removed = cleanupOldUpdateTempRoots(runtimeRoot, 5_000, now);

            assert.deepEqual(removed, [oldNpmRoot]);
            assert.equal(fs.existsSync(oldNpmRoot), false);
            assert.equal(fs.existsSync(freshNpmRoot), true);
            assert.equal(fs.existsSync(foreignRoot), true);
        } finally {
            removePathRecursive(runtimeRoot);
        }
    });
});
