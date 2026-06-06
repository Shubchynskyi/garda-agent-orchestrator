import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { assessDocImpact, VALID_DOC_IMPACT_DECISIONS } from '../../../../src/gates/doc-impact';

function createPreflight(tmpDir: string, overrides: Record<string, unknown> = {}): string {
    const preflight = {
        task_id: 'T-001',
        detection_source: 'git_auto',
        mode: 'FULL_PATH',
        metrics: { changed_lines_total: 50 },
        triggers: {},
        required_reviews: {
            code: true, db: false, security: false, refactor: false,
            api: false, test: false, performance: false, infra: false, dependency: false
        },
        changed_files: ['src/app.ts'],
        ...overrides
    };
    const filePath = path.join(tmpDir, 'T-001-preflight.json');
    fs.writeFileSync(filePath, JSON.stringify(preflight, null, 2), 'utf8');
    return filePath;
}

function writeInternalChangelogEvidence(repoRoot: string, taskId = 'T-001'): void {
    const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'changes', 'CHANGELOG.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# Internal Changelog\n\n- ${taskId}: internal runtime behavior documented.\n`, 'utf8');
}

function writeProjectMemoryEvidence(repoRoot: string, taskId = 'T-001'): void {
    const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'compact.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `# Compact Memory\n\n- ${taskId}: internal runtime behavior documented.\n`, 'utf8');
}

function writeProjectMemoryMapEvidence(repoRoot: string): void {
    const filePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory', 'compact.md');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '# Compact Memory\n\n- Internal runtime behavior contract documented as current project map state.\n', 'utf8');
}

describe('gates/doc-impact', () => {
    describe('assessDocImpact', () => {
        it('passes with valid DOCS_UPDATED decision', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'DOCS_UPDATED',
                behaviorChanged: true,
                changelogUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: ['README.md'],
                rationale: 'Updated README with new API docs for the user endpoint.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.violations.length, 0);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes with NO_DOC_UPDATES when no sensitive triggers', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Only internal refactor, no public API changes.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when rationale too short', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'short',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('Rationale')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when DOCS_UPDATED has empty docs list', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'DOCS_UPDATED',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Updated some documentation files.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('non-empty docs_updated')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes internal-only behavior change with internal changelog evidence and no docs_updated', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            writeInternalChangelogEvidence(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                internalChangelogUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal runtime behavior is documented in the internal changelog.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.deepEqual(result.docs_updated, []);
            assert.equal(result.behavior_changed, true);
            assert.equal(result.changelog_updated, false);
            assert.equal(result.internal_changelog_updated, true);
            assert.deepEqual(result.violations, []);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes internal-only behavior change with project memory evidence and no docs_updated', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            writeProjectMemoryMapEvidence(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                projectMemoryUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal runtime behavior is documented in durable project memory.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.deepEqual(result.docs_updated, []);
            assert.equal(result.behavior_changed, true);
            assert.equal(result.changelog_updated, false);
            assert.equal(result.project_memory_updated, true);
            assert.deepEqual(result.violations, []);
            assert.deepEqual(result.internal_closeout_evidence.project_memory_files, []);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes internal-only behavior change with explicit project memory no-update-needed claim', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                projectMemoryUpdateNotNeeded: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal runtime behavior was checked against project memory and no update was needed.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.project_memory_updated, false);
            assert.equal(result.project_memory_update_not_needed, true);
            assert.deepEqual(result.violations, []);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects conflicting project memory update claims', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                projectMemoryUpdated: true,
                projectMemoryUpdateNotNeeded: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal runtime behavior claims conflicting project memory states.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('ProjectMemoryUpdated=true is incompatible')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('defers project-memory-updated proof to project-memory-impact but still requires changelog evidence when requested', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                internalChangelogUpdated: true,
                projectMemoryUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal runtime behavior claims evidence without durable task files.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('InternalChangelogUpdated=true requires task-scoped durable evidence')));
            assert.ok(!result.violations.some(v => v.includes('ProjectMemoryUpdated=true requires task-scoped durable evidence')));
            assert.ok(!result.violations.some(v => v.includes('BehaviorChanged=true requires Decision=DOCS_UPDATED or internal closeout evidence.')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails internal-only behavior change when durable evidence belongs to a different task', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            writeInternalChangelogEvidence(tmpDir, 'T-999');
            writeProjectMemoryEvidence(tmpDir, 'T-999');
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                internalChangelogUpdated: true,
                projectMemoryUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal runtime behavior claims stale evidence from another task.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes("InternalChangelogUpdated=true requires task-scoped durable evidence")));
            assert.ok(!result.violations.some(v => v.includes("ProjectMemoryUpdated=true requires task-scoped durable evidence")));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('still fails DOCS_UPDATED without user-facing docs even when internal evidence exists', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            writeInternalChangelogEvidence(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'DOCS_UPDATED',
                behaviorChanged: true,
                changelogUpdated: false,
                internalChangelogUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Internal changelog exists but DOCS_UPDATED still needs user-facing docs.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('Decision DOCS_UPDATED requires non-empty docs_updated list.')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('still fails user-facing behavior docs without changelog even when internal evidence exists', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            writeInternalChangelogEvidence(tmpDir);
            writeProjectMemoryEvidence(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'DOCS_UPDATED',
                behaviorChanged: true,
                changelogUpdated: false,
                internalChangelogUpdated: true,
                projectMemoryUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: ['README.md'],
                rationale: 'User-facing behavior docs still require user-facing changelog evidence.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('BehaviorChanged=true requires ChangelogUpdated=true or internal closeout evidence.')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when behavior changed but no changelog', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'DOCS_UPDATED',
                behaviorChanged: true,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: ['README.md'],
                rationale: 'Updated README with new behavior docs.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('ChangelogUpdated')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when sensitive triggers and NO_DOC_UPDATES without reviewed flag', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir, {
                triggers: { security: true, api: true }
            });
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'No public API changes detected in this update.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('Sensitive scope triggers')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes when sensitive triggers with reviewed flag', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir, {
                triggers: { security: true }
            });
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: true,
                docsUpdated: [],
                rationale: 'Security fix is internal-only, no doc change needed.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('exports VALID_DOC_IMPACT_DECISIONS constant', () => {
            assert.ok(Array.isArray(VALID_DOC_IMPACT_DECISIONS));
            assert.ok(VALID_DOC_IMPACT_DECISIONS.includes('DOCS_UPDATED'));
            assert.ok(VALID_DOC_IMPACT_DECISIONS.includes('NO_DOC_UPDATES'));
            assert.equal(VALID_DOC_IMPACT_DECISIONS.length, 2);
        });

        it('fails when decision is an unknown string', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'MAYBE_LATER',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'This decision value is not in the allowed set.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes("Unknown decision 'MAYBE_LATER'")));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when decision is empty (normalizes to NO_DOC_UPDATES via default, not unknown)', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: '',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Empty decision falls back to NO_DOC_UPDATES default.',
                repoRoot: tmpDir
            });
            assert.equal(result.decision, 'NO_DOC_UPDATES');
            assert.equal(result.status, 'PASSED');
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when NO_DOC_UPDATES paired with non-empty docs_updated', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: ['README.md'],
                rationale: 'Contradictory: claiming no doc updates but listing docs.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('NO_DOC_UPDATES is incompatible with a non-empty docs_updated')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when NO_DOC_UPDATES paired with changelogUpdated=true', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: false,
                changelogUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Contradictory: claiming no doc updates but changelog was updated.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('NO_DOC_UPDATES is incompatible with ChangelogUpdated=true')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('fails when NO_DOC_UPDATES paired with behaviorChanged=true', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: [],
                rationale: 'Contradictory: claiming no doc updates but behavior changed.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('NO_DOC_UPDATES is incompatible with BehaviorChanged=true')));
            assert.ok(result.violations.some(v => v.includes('BehaviorChanged=true requires Decision=DOCS_UPDATED or internal closeout evidence')));
            assert.ok(result.violations.some(v => v.includes('BehaviorChanged=true requires ChangelogUpdated=true or internal closeout evidence')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('reports multiple violations for NO_DOC_UPDATES with all incompatible flags', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'NO_DOC_UPDATES',
                behaviorChanged: true,
                changelogUpdated: true,
                sensitiveReviewed: false,
                docsUpdated: ['README.md'],
                rationale: 'Everything contradicts NO_DOC_UPDATES here.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'FAILED');
            assert.ok(result.violations.some(v => v.includes('incompatible with a non-empty docs_updated')));
            assert.ok(result.violations.some(v => v.includes('incompatible with ChangelogUpdated=true')));
            assert.ok(result.violations.some(v => v.includes('incompatible with BehaviorChanged=true')));
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('passes docs-only update with DOCS_UPDATED, behaviorChanged=false, changelogUpdated=false', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'DOCS_UPDATED',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: ['docs/guide.md'],
                rationale: 'Updated the user guide with clarifications.',
                repoRoot: tmpDir
            });
            assert.equal(result.status, 'PASSED');
            assert.equal(result.violations.length, 0);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('normalizes decision to uppercase before validation', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-impact-'));
            const preflightPath = createPreflight(tmpDir);
            const result = assessDocImpact({
                preflightPath,
                taskId: 'T-001',
                decision: 'docs_updated',
                behaviorChanged: false,
                changelogUpdated: false,
                sensitiveReviewed: false,
                docsUpdated: ['README.md'],
                rationale: 'Lowercase decision should be normalized and accepted.',
                repoRoot: tmpDir
            });
            assert.equal(result.decision, 'DOCS_UPDATED');
            assert.equal(result.status, 'PASSED');
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });
});
