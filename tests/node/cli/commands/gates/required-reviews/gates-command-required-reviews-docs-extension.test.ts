import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    getCompileGateEvidence
} from '../../../../../../src/cli/commands/gate-flows/review/review-flow-support';
import {
    buildDomainScopeFingerprints
} from '../../../../../../src/gates/scope/domain-scope-fingerprints';
import {
    stringSha256
} from '../../../../../../src/gates/shared/helpers';

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function seedCompileEvidenceFixture(addedFile: string): {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    currentPreflightHash: string;
    compileEvidencePath: string;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-docs-extension-'));
    const taskId = 'T-DOCS-EXTENSION';
    const compileFiles = ['src/app.ts', 'tests/app.test.ts'];
    const currentFiles = [...compileFiles, addedFile].sort();
    const detectionSource = 'explicit_changed_files';
    const includeUntracked = true;
    const preflightPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-preflight.json`);
    const compileEvidencePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-compile-gate.json`);

    writeFile(repoRoot, 'src/app.ts', 'export const value = 1;\n');
    writeFile(repoRoot, 'tests/app.test.ts', 'import "../../src/app";\n');
    writeFile(repoRoot, addedFile, 'updated\n');

    const oldPreflight = {
        task_id: taskId,
        mode: 'FULL_PATH',
        detection_source: detectionSource,
        include_untracked: includeUntracked,
        changed_files: compileFiles,
        metrics: {
            changed_files_count: compileFiles.length,
            changed_lines_total: 2,
            domain_scope_fingerprints: buildDomainScopeFingerprints({
                repoRoot,
                detectionSource,
                includeUntracked,
                changedFiles: compileFiles
            })
        }
    };
    writeJson(preflightPath, oldPreflight);
    const oldPreflightHash = fileSha256(preflightPath);

    const currentPreflight = {
        ...oldPreflight,
        changed_files: currentFiles,
        metrics: {
            changed_files_count: currentFiles.length,
            changed_lines_total: 3,
            domain_scope_fingerprints: buildDomainScopeFingerprints({
                repoRoot,
                detectionSource,
                includeUntracked,
                changedFiles: currentFiles
            })
        }
    };
    writeJson(preflightPath, currentPreflight);

    const compileDomainFingerprints = buildDomainScopeFingerprints({
        repoRoot,
        detectionSource,
        includeUntracked,
        changedFiles: compileFiles
    });
    writeJson(compileEvidencePath, {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        event_source: 'compile-gate',
        preflight_path: preflightPath,
        preflight_hash_sha256: oldPreflightHash,
        scope_detection_source: detectionSource,
        scope_include_untracked: includeUntracked,
        scope_changed_files: compileFiles,
        scope_changed_files_count: compileFiles.length,
        scope_changed_lines_total: 2,
        scope_changed_files_sha256: stringSha256(compileFiles.join('\n')),
        scope_content_sha256: compileDomainFingerprints.domains.implementation.scope_content_sha256,
        scope_sha256: stringSha256('compile-scope'),
        domain_scope_fingerprints: compileDomainFingerprints
    });

    return {
        repoRoot,
        taskId,
        preflightPath,
        currentPreflightHash: fileSha256(preflightPath),
        compileEvidencePath
    };
}

describe('required reviews compile evidence docs-only extension', () => {
    it('accepts compile evidence when only ordinary docs were added after compile', () => {
        const fixture = seedCompileEvidenceFixture('docs/source-layout-refactor-safety-map.md');
        try {
            const result = getCompileGateEvidence(
                fixture.repoRoot,
                fixture.taskId,
                fixture.preflightPath,
                fixture.currentPreflightHash,
                fixture.compileEvidencePath
            );

            assert.equal(result.status, 'PASS');
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps failing stale compile evidence when implementation files were added after compile', () => {
        const fixture = seedCompileEvidenceFixture('src/extra.ts');
        try {
            const result = getCompileGateEvidence(
                fixture.repoRoot,
                fixture.taskId,
                fixture.preflightPath,
                fixture.currentPreflightHash,
                fixture.compileEvidencePath
            );

            assert.equal(result.status, 'EVIDENCE_PREFLIGHT_HASH_MISMATCH');
        } finally {
            fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
        }
    });
});
