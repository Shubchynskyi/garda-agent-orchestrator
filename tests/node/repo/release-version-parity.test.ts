import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    formatReleaseVersionParityResult,
    validateReleaseVersionParity
} from '../../../scripts/node-foundation/validate-release';
import { getRepoRoot } from '../../../scripts/node-foundation/build';

function createRepoFixture(version: string): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-version-'));

    fs.writeFileSync(path.join(repoRoot, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(
        path.join(repoRoot, 'package.json'),
        JSON.stringify({
            name: 'garda-agent-orchestrator',
            version
        }, null, 2) + '\n',
        'utf8'
    );
    fs.writeFileSync(
        path.join(repoRoot, 'package-lock.json'),
        JSON.stringify({
            name: 'garda-agent-orchestrator',
            version,
            lockfileVersion: 3,
            requires: true,
            packages: {
                '': {
                    name: 'garda-agent-orchestrator',
                    version
                }
            }
        }, null, 2) + '\n',
        'utf8'
    );

    return repoRoot;
}

test('validateReleaseVersionParity passes for the real repository', () => {
    const result = validateReleaseVersionParity(getRepoRoot());
    assert.equal(result.passed, true, formatReleaseVersionParityResult(result));
    assert.equal(result.versionFileValue, result.packageJsonVersion);
    assert.equal(result.packageJsonVersion, result.packageLockVersion);
    assert.equal(result.packageLockVersion, result.packageLockRootPackageVersion);
    if (result.deployedLiveVersion !== null) {
        assert.equal(result.packageLockRootPackageVersion, result.deployedLiveVersion);
    }
});

test('validateReleaseVersionParity catches VERSION mismatch', () => {
    const repoRoot = createRepoFixture('2.3.3');
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), '2.3.4\n', 'utf8');

    try {
        const result = validateReleaseVersionParity(repoRoot);
        assert.equal(result.passed, false);
        assert.equal(result.versionFileValue, '2.3.4');
        assert.ok(result.violations.some((line) => line.includes('must match')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReleaseVersionParity catches package-lock top-level mismatch', () => {
    const repoRoot = createRepoFixture('2.3.3');
    const lockPath = path.join(repoRoot, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as Record<string, unknown>;
    lock.version = '2.3.4';
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');

    try {
        const result = validateReleaseVersionParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((line) => line.includes('package-lock.json')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReleaseVersionParity catches package-lock root package mismatch', () => {
    const repoRoot = createRepoFixture('2.3.3');
    const lockPath = path.join(repoRoot, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
        packages: { '': { version: string } };
    };
    lock.packages[''].version = '2.3.4';
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');

    try {
        const result = validateReleaseVersionParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((line) => line.includes('packages[""]')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReleaseVersionParity catches missing root package metadata', () => {
    const repoRoot = createRepoFixture('2.3.3');
    const lockPath = path.join(repoRoot, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { packages?: Record<string, unknown> };
    delete lock.packages;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');

    try {
        const result = validateReleaseVersionParity(repoRoot);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some((line) => line.includes('packages metadata')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateReleaseVersionParity catches deployed live/version.json mismatch when present', () => {
    const repoRoot = createRepoFixture('2.3.3');
    const liveDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.writeFileSync(
        path.join(liveDir, 'version.json'),
        JSON.stringify({ Version: '2.3.4' }, null, 2) + '\n',
        'utf8'
    );

    try {
        const result = validateReleaseVersionParity(repoRoot);
        assert.equal(result.passed, false);
        assert.equal(result.deployedLiveVersion, '2.3.4');
        assert.ok(result.violations.some((line) => line.includes('garda-agent-orchestrator/live/version.json')));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
