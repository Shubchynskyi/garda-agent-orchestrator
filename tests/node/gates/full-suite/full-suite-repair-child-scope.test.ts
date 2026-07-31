import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    parseRepairChildScopeEvidence,
    readRepairChildScopeFromNotes,
    validateIndependentRepairChildScopes,
    validateRepairChildChangedFiles,
    validateRepairChildScopeIsolation
} from '../../../../src/gates/full-suite/full-suite-repair-child-scope';

const REPO_ROOT = path.resolve('repair-child-scope-fixture');

describe('full-suite repair child scope', () => {
    it('parses a canonical exact-path declaration from repair child Notes', () => {
        const parsed = readRepairChildScopeFromNotes(
            REPO_ROOT,
            'T-REPAIR-F1',
            'Child of `T-REPAIR`. Repair scope paths: `src/diagnostics.ts`, `tests/diagnostics.test.ts`; bounded repair.'
        );

        assert.deepEqual(parsed, {
            scope: {
                task_id: 'T-REPAIR-F1',
                paths: ['src/diagnostics.ts', 'tests/diagnostics.test.ts']
            },
            violations: []
        });
    });

    it('rejects missing terminators, traversal, glob syntax, and duplicate paths', () => {
        const missingTerminator = readRepairChildScopeFromNotes(
            REPO_ROOT,
            'T-REPAIR-F1',
            'Repair scope paths: `src/diagnostics.ts`'
        );
        const invalidPaths = readRepairChildScopeFromNotes(
            REPO_ROOT,
            'T-REPAIR-F1',
            'Repair scope paths: `../escape.ts`, `src/*.ts`, `src/repeated.ts`, `src/repeated.ts`;'
        );

        assert.match(missingTerminator.violations.join('\n'), /must end with a semicolon/);
        assert.match(invalidPaths.violations.join('\n'), /exact canonical repository-relative file path/);
        assert.match(invalidPaths.violations.join('\n'), /without glob syntax/);
        assert.match(invalidPaths.violations.join('\n'), /must be unique/);
    });

    it('rejects noncanonical dot-segment and empty-segment aliases', () => {
        const parsed = readRepairChildScopeFromNotes(
            REPO_ROOT,
            'T-REPAIR-F1',
            'Repair scope paths: `src/dir/../parent-wip.ts`, `src/./child.ts`, `src//empty.ts`;'
        );

        assert.equal(parsed.scope, null);
        assert.equal(
            parsed.violations.filter((violation) => violation.includes('exact canonical')).length,
            3
        );
    });

    it('rejects a repair child scope that escapes through a symbolic-link or junction', (t) => {
        const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-repair-child-scope-'));
        t.after(() => {
            fs.rmSync(fixtureRoot, {
                recursive: true,
                force: true,
                maxRetries: 5,
                retryDelay: 50
            });
        });
        const repoRoot = path.join(fixtureRoot, 'repo');
        const externalRoot = path.join(fixtureRoot, 'external');
        fs.mkdirSync(repoRoot);
        fs.mkdirSync(externalRoot);
        fs.symlinkSync(
            externalRoot,
            path.join(repoRoot, 'linked'),
            process.platform === 'win32' ? 'junction' : 'dir'
        );

        const parsed = readRepairChildScopeFromNotes(
            repoRoot,
            'T-REPAIR-F1',
            'Repair scope paths: `linked/external.ts`;'
        );

        assert.equal(parsed.scope, null);
        assert.match(
            parsed.violations.join('\n'),
            /physically escapes repository root through a symbolic-link or junction/
        );
    });

    it('requires non-empty pairwise-disjoint scopes that are proper subsets of their union', () => {
        const violations = validateIndependentRepairChildScopes([
            { task_id: 'T-REPAIR-F1', paths: ['src/shared.ts'] },
            { task_id: 'T-REPAIR-F2', paths: ['src/shared.ts'] }
        ]);

        assert.match(violations.join('\n'), /overlap at src\/shared\.ts/);
        assert.match(violations.join('\n'), /not strictly smaller than the combined repair scope/);
    });

    it('binds serialized scopes to ordered child ids and rejects unknown fields', () => {
        const parsed = parseRepairChildScopeEvidence(
            REPO_ROOT,
            [
                { task_id: 'T-REPAIR-F2', paths: ['src/two.ts'] },
                { task_id: 'T-REPAIR-F1', paths: ['src/one.ts'], forged: true }
            ],
            ['T-REPAIR-F1', 'T-REPAIR-F2'],
            'child_scopes'
        );

        assert.equal(parsed.scopes, null);
        assert.match(parsed.violations.join('\n'), /must contain only task_id and paths/);
        assert.match(parsed.violations.join('\n'), /must exactly match the ordered repair child_task_ids/);
    });

    it('rejects child scope overlap with suspended parent WIP', () => {
        const violations = validateRepairChildScopeIsolation(
            [
                { task_id: 'T-REPAIR-F1', paths: ['src/diagnostics.ts'] },
                { task_id: 'T-REPAIR-F2', paths: ['src/repair.ts'] }
            ],
            ['src/parent.ts', 'src/repair.ts']
        );

        assert.deepEqual(violations, [
            'repair child T-REPAIR-F2 scope overlaps suspended parent WIP: src/repair.ts.'
        ]);
    });

    it('rejects classified child changes outside the immutable handoff scope', () => {
        const violations = validateRepairChildChangedFiles(
            [
                { task_id: 'T-REPAIR-F1', paths: ['src/diagnostics.ts'] },
                { task_id: 'T-REPAIR-F2', paths: ['src/repair.ts'] }
            ],
            'T-REPAIR-F1',
            ['src/diagnostics.ts', 'src/outside.ts']
        );

        assert.match(violations.join('\n'), /outside its immutable scoped handoff: src\/outside\.ts/);
        assert.match(violations.join('\n'), /allowed: src\/diagnostics\.ts/);
    });
});
