import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildDomainScopeFingerprints,
    getReviewLaneScopeSha256
} from '../../../../src/gates/scope/domain-scope-fingerprints';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint
} from '../../../../src/gates/review-reuse';

describe('gates/domain-scope-fingerprints', () => {
    it('preserves legacy closeout-aware review scope hashes', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-closeout-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, '.agents'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Task queue\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, '.agents', 'notes.md'), '# Notes\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                changed_files: ['src/app.ts', 'TASK.md', '.agents/notes.md']
            };

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: preflight.changed_files
            });

            assert.equal(
                fingerprints.legacy.review_scope_sha256,
                computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256
            );
            assert.equal(
                getReviewLaneScopeSha256('code', fingerprints),
                computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256
            );
            assert.equal(
                getReviewLaneScopeSha256('security', fingerprints),
                computeReviewReuseCodeScopeFingerprint('security', preflight, repoRoot).code_scope_sha256
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps code-like protected control-plane files in the implementation domain', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-protected-code-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src', 'gates'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
            fs.writeFileSync(
                path.join(repoRoot, 'src', 'gates', 'review-tree-state.ts'),
                'export const gate = "alpha";\n',
                'utf8'
            );
            fs.writeFileSync(
                path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
                '{\"enabled\":true}\n',
                'utf8'
            );

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: [
                    'src/gates/review-tree-state.ts',
                    'garda-agent-orchestrator/live/config/workflow-config.json'
                ]
            });

            assert.deepEqual(
                fingerprints.domains.implementation.changed_files,
                ['src/gates/review-tree-state.ts']
            );
            assert.deepEqual(
                fingerprints.domains.config.changed_files,
                ['garda-agent-orchestrator/live/config/workflow-config.json']
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps code-review lane narrower than performance-review lane for perf support files', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-domain-scope-perf-lanes-'));
        try {
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
            fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const app = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const perf = "alpha";\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');

            const preflight = {
                detection_source: 'explicit_changed_files',
                include_untracked: true,
                changed_files: ['src/app.ts', 'benchmark/reviewed.ts', 'apps/shop/perf/cache.ts']
            };

            const fingerprints = buildDomainScopeFingerprints({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: preflight.changed_files
            });
            const expectedCodeLane = computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256;
            const expectedPerformanceLane = computeReviewReuseCodeScopeFingerprint(
                'performance',
                preflight,
                repoRoot
            ).code_scope_sha256;

            assert.equal(getReviewLaneScopeSha256('code', fingerprints), expectedCodeLane);
            assert.equal(getReviewLaneScopeSha256('performance', fingerprints), expectedPerformanceLane);
            assert.notEqual(
                getReviewLaneScopeSha256('code', fingerprints),
                getReviewLaneScopeSha256('performance', fingerprints)
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
