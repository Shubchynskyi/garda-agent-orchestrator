import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

function readPackageJson(): Record<string, unknown> {
    const packageJsonPath = path.join(getRepoRoot(), 'package.json');
    return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
}

function getScripts(): Record<string, string> {
    const pkg = readPackageJson();
    assert.equal(typeof pkg.scripts, 'object');
    assert.notEqual(pkg.scripts, null);
    return pkg.scripts as Record<string, string>;
}

function getDevDependencies(): Record<string, string> {
    const pkg = readPackageJson();
    assert.equal(typeof pkg.devDependencies, 'object');
    assert.notEqual(pkg.devDependencies, null);
    return pkg.devDependencies as Record<string, string>;
}

function readTextRepoFile(relativePath: string): string {
    return fs.readFileSync(path.join(getRepoRoot(), relativePath), 'utf8');
}

test('package quality scripts expose lint, coverage, audit, and composed release validation', () => {
    const scripts = getScripts();

    assert.match(scripts.lint, /^eslint /);
    assert.match(scripts.lint, /"src\/\*\*\/\*\.ts"/);
    assert.match(scripts.lint, /"tests\/node\/\*\*\/\*\.ts"/);
    assert.match(scripts.lint, /"scripts\/node-foundation\/\*\*\/\*\.ts"/);

    assert.match(scripts.coverage, /^c8 /);
    assert.match(scripts.coverage, /npm test/);
    assert.doesNotMatch(scripts.coverage, /--check-coverage/);

    assert.equal(scripts['audit:prod'], 'npm audit --omit=dev');
    assert.equal(scripts['audit:all'], 'npm audit');
    assert.equal(scripts.quality, 'npm run typecheck && npm run lint && npm run coverage && npm run audit:prod');
    assert.equal(scripts['validate:clean-worktree'], 'node scripts/node-foundation/build-scripts.cjs validate-release.js clean-worktree');
    assert.equal(scripts['validate:embedded-bundle-parity'], 'node scripts/node-foundation/build-scripts.cjs validate-release.js embedded-bundle-parity');
    assert.equal(
        scripts['validate:release'],
        'npm run validate:clean-worktree && npm run validate:version-parity && npm run build && npm run validate:embedded-bundle-parity && npm run quality && node --test .node-build/tests/node/packaging/pack-smoke.test.js && npm run validate:clean-worktree'
    );
    assert.equal(scripts['release:preflight'], 'npm run validate:release');
    assert.match(scripts.prepack, /^npm run validate:clean-worktree && npm run build:publish-runtime/);
    assert.match(scripts.prepack, /&& npm run validate:clean-worktree && node scripts\/package-legacy-entrypoint-compat\.cjs create$/);
});

test('quality script dependencies and eslint config are present', () => {
    const devDependencies = getDevDependencies();

    for (const packageName of ['@eslint/js', 'eslint', 'typescript-eslint', 'c8']) {
        assert.equal(typeof devDependencies[packageName], 'string', `${packageName} must be a devDependency`);
    }

    const eslintConfigPath = path.join(getRepoRoot(), 'eslint.config.mjs');
    assert.equal(fs.existsSync(eslintConfigPath), true);
});

test('release validation CI covers Windows quality script execution', () => {
    const ciWorkflow = readTextRepoFile('.github/workflows/ci.yml');

    assert.match(ciWorkflow, /validate-release:\s+name: Release Validation \/ \$\{\{ matrix\.os \}\}/);
    assert.match(ciWorkflow, /runs-on: \$\{\{ matrix\.os \}\}/);
    assert.match(ciWorkflow, /os:\s+- ubuntu-latest\s+- windows-latest/);
    assert.match(ciWorkflow, /run: npm run validate:release/);
});
