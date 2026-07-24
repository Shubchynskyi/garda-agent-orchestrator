import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
    DOMAIN_SCOPE_NAMES as coreDomainScopeNames
} from '../../../src/core/domain-scope-contracts';
import {
    fileSha256 as coreFileSha256,
    stringSha256 as coreStringSha256
} from '../../../src/core/file-hashing';
import {
    loadFullSuiteValidationConfig as loadCoreFullSuiteValidationConfig
} from '../../../src/core/full-suite-validation-config';
import {
    detectCodeChanged as detectCoreCodeChanged
} from '../../../src/core/preflight-code-change';
import {
    normalizePath as coreNormalizePath
} from '../../../src/core/orchestrator-paths';
import {
    computeProtectedSnapshotDigest as computeCoreProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath as resolveCoreProtectedManifestPath
} from '../../../src/core/protected-control-plane-contracts';
import {
    loadFullSuiteValidationConfig as loadLegacyFullSuiteValidationConfig
} from '../../../src/gates/full-suite/full-suite-validation-config';
import {
    detectCodeChanged as detectLegacyCodeChanged
} from '../../../src/gates/preflight/preflight-code-change';
import {
    computeProtectedSnapshotDigest as computeLegacyProtectedSnapshotDigest,
    resolveProtectedControlPlaneManifestPath as resolveLegacyProtectedManifestPath
} from '../../../src/gates/protected-control-plane/protected-control-plane';
import {
    DOMAIN_SCOPE_NAMES as legacyDomainScopeNames
} from '../../../src/gates/scope/domain-scope-fingerprints';
import {
    fileSha256 as legacyFileSha256,
    normalizePath as legacyNormalizePath,
    stringSha256 as legacyStringSha256
} from '../../../src/gates/shared/helpers';

describe('dependency-safe core contracts', () => {
    it('keeps legacy path, hashing, protected-manifest, and scope exports compatible', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-contracts-'));
        try {
            const fixturePath = path.join(tempDir, 'fixture.txt');
            fs.writeFileSync(fixturePath, 'stable fixture', 'utf8');
            const snapshot = {
                'src\\core\\a.ts': 'ABCDEF',
                'src/core/b.ts': '123456'
            };

            assert.equal(legacyNormalizePath('.\\src\\core\\a.ts'), coreNormalizePath('.\\src\\core\\a.ts'));
            assert.equal(legacyStringSha256('value'), coreStringSha256('value'));
            assert.equal(legacyFileSha256(fixturePath), coreFileSha256(fixturePath));
            assert.equal(
                computeLegacyProtectedSnapshotDigest(snapshot),
                computeCoreProtectedSnapshotDigest(snapshot)
            );
            assert.equal(
                resolveLegacyProtectedManifestPath(tempDir),
                resolveCoreProtectedManifestPath(tempDir)
            );
            assert.deepEqual(legacyDomainScopeNames, coreDomainScopeNames);
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('detects a replaced protected snapshot digest after content changes', () => {
        const baselineDigest = computeCoreProtectedSnapshotDigest({
            'src/core/protected-control-plane-contracts.ts': 'a'.repeat(64)
        });
        const changedDigest = computeCoreProtectedSnapshotDigest({
            'src/core/protected-control-plane-contracts.ts': 'b'.repeat(64)
        });

        assert.notEqual(changedDigest, baselineDigest);
    });

    it('keeps the legacy full-suite config facade bound to the core loader', () => {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'core-full-suite-config-'));
        try {
            const configPath = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: {
                    enabled: true,
                    command: 'npm test',
                    timeout_ms: 123_000,
                    placement: 'before_completion'
                }
            }), 'utf8');

            assert.deepEqual(
                loadLegacyFullSuiteValidationConfig(tempDir),
                loadCoreFullSuiteValidationConfig(tempDir)
            );
        } finally {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it('keeps legacy preflight classification aligned across core and gate facades', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'core-preflight-parity-'));
        try {
            const configPath = path.join(
                repoRoot,
                'garda-agent-orchestrator',
                'live',
                'config',
                'paths.json'
            );
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                code_like_regexes: ['\\.ts$'],
                runtime_roots: ['src/'],
                ordinary_doc_paths: ['docs/**'],
                protected_control_plane_roots: ['custom/control/'],
                sql_or_migration_regexes: ['(^|/)database(/|$)'],
                triggers: {
                    db: ['(^|/)database(/|$)'],
                    security: ['(^|/)auth(/|\\.|$)'],
                    api: [],
                    dependency: []
                }
            }), 'utf8');

            for (const changedFile of [
                'src/main.ts',
                'config/auth/settings.json',
                'custom/control/policy.bin',
                'docs/auth/runbook.md',
                'docs/database/runbook.md',
                'docs/ordinary.md',
                'assets/unknown.bin'
            ]) {
                const preflight = {
                    changed_files: [changedFile],
                    metrics: { changed_lines_total: 1 }
                };
                assert.equal(
                    detectCoreCodeChanged(preflight, repoRoot),
                    detectLegacyCodeChanged(preflight, repoRoot),
                    changedFile
                );
            }
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
