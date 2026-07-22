import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    assessTrustBoundaryAnalysisApplicability,
    assessTrustBoundaryMatrix,
    TRUST_BOUNDARY_NEGATIVE_PATH_KINDS
} from '../../../src/core/trust-boundary-analysis';

function buildMatrix(kind: typeof TRUST_BOUNDARY_NEGATIVE_PATH_KINDS[number]) {
    const scenario = `${kind} reviewer evidence is presented`;
    return [{
        boundary_id: 'TB-001',
        boundary: 'Mutable review output to authenticated receipt',
        authority_source: 'Gate-owned reviewer launch and receipt bindings',
        mutable_inputs: ['provider reviewer output'],
        integrity_evidence: ['launch input sha256', 'review context sha256', 'tree state sha256'],
        canonical_reconstruction: 'Rebuild the receipt from the immutable launch input and normalized findings.',
        toctou_replay: 'Reject output that predates delegation start or belongs to an earlier review cycle.',
        negative_paths: [{
            kind,
            scenario,
            expected_behavior: 'Reject the evidence without creating accepted review state.',
            evidence_files: [`tests/${kind}-review-evidence.test.ts#${scenario}`]
        }]
    }];
}

describe('trust-boundary analysis contract', () => {
    it('accepts targeted forged, replaced, missing, foreign, and stale negative paths', () => {
        for (const kind of TRUST_BOUNDARY_NEGATIVE_PATH_KINDS.filter((entry) => entry !== 'other')) {
            const assessment = assessTrustBoundaryMatrix(buildMatrix(kind));
            assert.deepEqual(assessment.violations, [], `Expected '${kind}' matrix to be complete.`);
            assert.equal(assessment.matrix[0].negative_paths[0].kind, kind);
            assert.match(assessment.matrix_sha256, /^[a-f0-9]{64}$/u);
        }
    });

    it('rejects incomplete happy-path-only analysis', () => {
        const assessment = assessTrustBoundaryMatrix([{
            boundary_id: 'TB-001',
            boundary: 'Review output receipt',
            authority_source: 'Gate-owned launch',
            mutable_inputs: ['review output'],
            integrity_evidence: ['receipt hash'],
            canonical_reconstruction: 'Rebuild from launch input.',
            toctou_replay: 'Reject stale cycles.',
            negative_paths: []
        }]);

        assert.ok(assessment.violations.some((violation) => violation.includes('negative_paths')));

        const happyPathOnly = buildMatrix('other');
        happyPathOnly[0].negative_paths[0] = {
            kind: 'other',
            scenario: 'accepts valid reviewer evidence',
            expected_behavior: 'Accept the evidence and continue.',
            evidence_files: ['tests/other-review-evidence.test.ts#accepts valid reviewer evidence']
        };
        const happyPathAssessment = assessTrustBoundaryMatrix(happyPathOnly);
        assert.ok(happyPathAssessment.violations.some((violation) => (
            violation.includes("scenario for kind 'other'")
        )));
        assert.ok(happyPathAssessment.violations.some((violation) => (
            violation.includes('fail-closed or recovery action')
        )));
    });

    it('requires existing in-repository test evidence when a repository root is supplied', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-trust-boundary-evidence-'));
        try {
            const testPath = path.join(repoRoot, 'tests', 'negative-path.test.ts');
            fs.mkdirSync(path.dirname(testPath), { recursive: true });
            fs.writeFileSync(
                testPath,
                "test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n",
                'utf8'
            );
            const currentMatrix = buildMatrix('replaced');
            currentMatrix[0].negative_paths[0].evidence_files = [
                'tests/negative-path.test.ts#replaced reviewer evidence is presented'
            ];
            assert.deepEqual(assessTrustBoundaryMatrix(currentMatrix, { repoRoot }).violations, []);

            fs.writeFileSync(
                testPath,
                "describe('review evidence', () => {\n"
                    + "    test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n"
                    + "});\n",
                'utf8'
            );
            assert.deepEqual(assessTrustBoundaryMatrix(currentMatrix, { repoRoot }).violations, []);

            for (const evidenceFile of ['tests/missing.test.ts', 'src/app.ts', '../outside.test.ts']) {
                const invalidMatrix = buildMatrix('replaced');
                invalidMatrix[0].negative_paths[0].evidence_files = [
                    `${evidenceFile}#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(invalidMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('test file')
                    )),
                    evidenceFile
                );
            }

            for (const [fixtureName, noOpSource] of [
                ['empty', "test('replaced reviewer evidence is presented', () => {});\n"],
                [
                    'no-assertion',
                    "test('replaced reviewer evidence is presented', () => { const observed = 'replaced'; });\n"
                ],
                [
                    'inert-assertion',
                    "test('replaced reviewer evidence is presented', () => { /* assert.equal(1, 1); */ const note = 'expect(value)'; });\n"
                ],
                [
                    'unreachable-assertion',
                    "test('replaced reviewer evidence is presented', () => { if (false) { assert.equal(1, 1); } });\n"
                ],
                [
                    'short-circuited-assertion',
                    "test('replaced reviewer evidence is presented', () => { false && assert.equal(1, 1); });\n"
                ],
                [
                    'nested-assertion',
                    "test('replaced reviewer evidence is presented', () => { const neverCalled = () => { assert.equal(1, 1); }; });\n"
                ],
                [
                    'nested-callback-assertion',
                    "test('replaced reviewer evidence is presented', () => { [].forEach(() => { assert.equal(1, 1); }); });\n"
                ],
                [
                    'conditional-test-declaration',
                    "if (false) {\n    test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n}\n"
                ],
                [
                    'skipped-suite-test-declaration',
                    "describe.skip('review evidence', () => {\n"
                        + "    test('replaced reviewer evidence is presented', () => { assert.equal(1, 1); });\n"
                        + "});\n"
                ]
            ] as const) {
                const noOpTestPath = path.join(repoRoot, 'tests', `${fixtureName}.test.ts`);
                fs.writeFileSync(noOpTestPath, noOpSource, 'utf8');
                const noOpMatrix = buildMatrix('replaced');
                noOpMatrix[0].negative_paths[0].evidence_files = [
                    `tests/${fixtureName}.test.ts#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(noOpMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('direct assertion statement')
                    )),
                    fixtureName
                );
            }

            const unrelatedTestPath = path.join(repoRoot, 'tests', 'unrelated.test.ts');
            fs.writeFileSync(unrelatedTestPath, "test('covers unrelated behavior', () => {});\n", 'utf8');
            const unrelatedMatrix = buildMatrix('replaced');
            unrelatedMatrix[0].negative_paths[0].evidence_files = [
                'tests/unrelated.test.ts#replaced reviewer evidence is presented'
            ];
            assert.ok(assessTrustBoundaryMatrix(unrelatedMatrix, { repoRoot }).violations.some((violation) => (
                violation.includes('exact declared it/test case name')
            )));

            for (const modifier of ['skip', 'todo']) {
                const nonExecutingTestPath = path.join(repoRoot, 'tests', `${modifier}.test.ts`);
                fs.writeFileSync(
                    nonExecutingTestPath,
                    `test.${modifier}('replaced reviewer evidence is presented', () => {});\n`,
                    'utf8'
                );
                const nonExecutingMatrix = buildMatrix('replaced');
                nonExecutingMatrix[0].negative_paths[0].evidence_files = [
                    `tests/${modifier}.test.ts#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(nonExecutingMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('exact declared it/test case name')
                    )),
                    modifier
                );
            }

            for (const [fixtureName, inertSource] of [
                ['comment', "// test('replaced reviewer evidence is presented', () => {});\n"],
                ['string', "const inert = \"test('replaced reviewer evidence is presented', () => {})\";\n"],
                ['template', "const inert = `\ntest('replaced reviewer evidence is presented', () => {});\n`;\n"]
            ] as const) {
                const inertTestPath = path.join(repoRoot, 'tests', `${fixtureName}.test.ts`);
                fs.writeFileSync(inertTestPath, inertSource, 'utf8');
                const inertMatrix = buildMatrix('replaced');
                inertMatrix[0].negative_paths[0].evidence_files = [
                    `tests/${fixtureName}.test.ts#replaced reviewer evidence is presented`
                ];
                assert.ok(
                    assessTrustBoundaryMatrix(inertMatrix, { repoRoot }).violations.some((violation) => (
                        violation.includes('exact declared it/test case name')
                    )),
                    fixtureName
                );
            }
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('requires analysis for security triggers and sensitive control-plane paths only', () => {
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: { security: true },
            changed_files: ['src/app.ts']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['src/gates/review/review-findings-schema.ts']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['garda-agent-orchestrator/live/config/workflow-config.json']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['garda-agent-orchestrator/template/config/workflow-config.json']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['template/config/workflow-config.json']
        }).required, true);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['src/ui/review-panel.ts']
        }).required, false);
        assert.equal(assessTrustBoundaryAnalysisApplicability({
            triggers: {},
            changed_files: ['src/domain/catalog.ts']
        }).required, false);
    });
});
