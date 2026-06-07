import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initGitRepo } from '../git-fixtures';
import {
    buildDomainScopeFingerprints,
    formatNextStepText,
    getWorkspaceSnapshot,
    recordFullSuiteValidationDuration,
    resolveNextStep
} from './next-step-test-support';
import { assertGateChainDecision } from '../../cli/commands/gate-test-gatechain';
import {
    TASK_ID,
    EXPECTED_LOOP_LINE,
    requireFromTest,
    NEXT_STEP_FULL_SUITE_TEST_CONFIG,
    ALL_REVIEW_FLAGS,
    tempRoots,
    PROVIDER_ENV_KEYS,
    withProviderEnv,
    makeTempRepo,
    reviewsRoot,
    eventsRoot,
    writeJson,
    writeJsonWithSha,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    seedProjectMemoryImpact,
    sha256Text,
    fileSha256,
    writeNoOpEvidence,
    writeStrictDecompositionDecision,
    appendEvent,
    seedStartedTask,
    seedCustomStartedTask,
    seedTaskModeOnly,
    seedRulePack,
    seedHandshake,
    seedShellSmoke,
    seedPostPreflightRulePack,
    normalizeForTimeline,
    seedSplitRequiredLatchEvidence,
    getLoadedRuleFileBasenames,
    writePreflight,
    seedCompilePass,
    writeGitAutoPreflight,
    seedGitAutoCompilePass,
    stageFiles,
    writeStagedPreflight,
    seedStagedCompilePass,
    buildReviewContextScopeFixture,
    writeReviewEvidence,
    markReviewEvidenceAsStrictReuse,
    writeStrictIndependentCodeReviewEvidence,
    writeReviewContextOnly,
    launchInputEvidenceFixture,
    seedCompletedReviewerLaunchAndInvocation,
    readReviewContextTreeStateSha256,
    writeFreshReviewContextWithoutRouting,
    seedReviewGatePass,
    seedDocImpactPass,
    seedCompletionPass,
    seedFullSuiteValidation,
    materializeFinalCloseout,
    seedCompletedTaskWithIndependentCodeReview,
    seedSourceCheckoutRuntime
} from './next-step-doc-impact-fixtures';

describe('gates/next-step', () => {
    it('routes to completion when doc-impact accepted declared post-review docs and changelog updates', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n\nUpdated doc-impact flow.\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Document doc-impact follow-up scope.\n', 'utf8');
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), {
            task_id: TASK_ID,
            decision: 'DOCS_UPDATED',
            status: 'PASSED',
            outcome: 'PASS',
            preflight_path: preflightPath,
            docs_updated: ['docs/cli-reference.md', 'CHANGELOG.md'],
            behavior_changed: false,
            changelog_updated: true
        });
        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'completion-gate');
        assert.ok(result.commands[0].command.includes('gate completion-gate'));
    });

    it('routes to doc-impact without refreshing preflight when changelog is added after reviews', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented reviewed behavior.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));
        assert.ok(result.commands[0].command.includes('--docs-updated "CHANGELOG.md"'));
        assert.ok(result.reason.includes('Completion requires an explicit docs decision.'));
        assert.ok(result.reason.includes('Compatible doc-impact choices:'));
        assert.ok(result.reason.includes('no user-facing docs -> --decision "NO_DOC_UPDATES"'));
        assert.ok(result.reason.includes('docs only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated false'));
        assert.ok(result.reason.includes('changelog/docs maintenance only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated true'));
        assert.ok(result.reason.includes('changelog plus implementation scope -> next-step defaults to --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true'));
        assert.ok(result.reason.includes('user-facing behavior changed -> --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true'));
        assert.ok(result.reason.includes('internal-only runtime behavior changed -> --decision "NO_DOC_UPDATES" --behavior-changed true'));
        assert.ok(result.reason.includes('--internal-changelog-updated true, --project-memory-updated true, or --project-memory-update-not-needed true'));
        assert.ok(result.commands[0].command.includes('--behavior-changed true'));
    });

    it('routes to doc-impact without refreshing preflight when a staged changelog is added after reviews', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        stageFiles(repoRoot, 'src/app.ts');
        seedStartedTask(repoRoot, TASK_ID);
        writeStagedPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedStagedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented staged reviewed behavior.\n', 'utf8');
        stageFiles(repoRoot, 'CHANGELOG.md');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate', result.reason);
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
        assert.ok(!result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));
        assert.ok(result.commands[0].command.includes('--docs-updated "CHANGELOG.md"'));
    });

    it('routes to doc-impact without refreshing preflight when task closeout is added after reviews', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '\nCloseout note for reviewed implementation.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--decision "NO_DOC_UPDATES"'));
        assert.ok(!result.commands[0].command.includes('--docs-updated "TASK.md"'));
    });

    it('keeps project-memory closeout out of docs-updated while accepting the closeout delta', () => {
        const repoRoot = makeTempRepo();
        const projectMemoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
        fs.mkdirSync(projectMemoryRoot, { recursive: true });
        fs.writeFileSync(path.join(projectMemoryRoot, 'commands.md'), '# Commands\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(projectMemoryRoot, 'commands.md'), '\nRemember closeout-only delta handling.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--decision "NO_DOC_UPDATES"'));
        assert.ok(!result.commands[0].command.includes('--docs-updated "garda-agent-orchestrator/live/docs/project-memory/commands.md"'));
    });

    it('keeps changelog in docs domain while project-memory and task metadata stay closeout domain', () => {
        const repoRoot = makeTempRepo();
        const projectMemoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
        fs.mkdirSync(projectMemoryRoot, { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Runtime-facing release note.\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), '# Tasks\n\nCloseout metadata.\n', 'utf8');
        fs.writeFileSync(path.join(projectMemoryRoot, 'commands.md'), '# Commands\n\nCloseout memory note.\n', 'utf8');

        const fingerprints = buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: 'explicit_changed_files',
            includeUntracked: true,
            changedFiles: [
                'CHANGELOG.md',
                'TASK.md',
                'garda-agent-orchestrator/live/docs/project-memory/commands.md'
            ]
        });

        assert.deepEqual(fingerprints.domains.docs.changed_files, ['CHANGELOG.md']);
        assert.deepEqual(fingerprints.domains.closeout.changed_files, [
            'TASK.md',
            'garda-agent-orchestrator/live/docs/project-memory/commands.md'
        ]);
    });

    it('uses preflight domain fingerprints for legacy compile evidence without fingerprint fields', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(compileArtifact.domain_scope_fingerprints, undefined);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '\nCloseout note for reviewed implementation.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(result.commands[0].command.includes('--decision "NO_DOC_UPDATES"'));
    });

    it('keeps post-review docs and closeout deltas separated in doc-impact', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI reference\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '\nDocumented reviewed CLI behavior.\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '\nCloseout note for reviewed implementation.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));
        assert.ok(result.commands[0].command.includes('--docs-updated "docs/cli-reference.md"'));
        assert.ok(!result.commands[0].command.includes('--docs-updated "TASK.md"'));
    });

    it('routes back to preflight when closeout delta is combined with undeclared source drift', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const reviewed = 2;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeGitAutoPreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedGitAutoCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'TASK.md'), '\nCloseout note for reviewed implementation.\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra.ts'), 'export const extra = 3;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('src/extra.ts'));
        assert.ok(!result.commands[0].command.includes('gate doc-impact-gate'));
    });


    it('routes to doc-impact after required reviews pass', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(result.commands[0].command.includes('gate doc-impact-gate'));
        assert.ok(!result.commands[0].command.includes('<'));
        assert.ok(result.commands[0].command.includes('--decision "NO_DOC_UPDATES"'));
        assert.ok(result.commands[0].command.includes('--behavior-changed true'));
        assert.ok(result.commands[0].command.includes('--changelog-updated false'));
        assert.ok(result.commands[0].command.includes('--project-memory-update-not-needed true'));
        assert.ok(result.commands[0].command.includes('--rationale "Implementation files changed with no user-facing documentation paths; recording internal-only behavior evidence. Update task-scoped project memory before running if this command reports missing internal evidence."'));
    });

    it('does not default pure test-only maintenance to behavior-changing doc impact', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'split-maintenance.test.ts'), 'import "node:test";\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, test: true },
            { changedFiles: ['tests/node/split-maintenance.test.ts'], seedPostPreflight: false }
        );
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'test-only';
        preflight.scope_category_reasons = ['test_only_files=1'];
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(result.commands[0].command.includes('--decision "NO_DOC_UPDATES"'));
        assert.ok(result.commands[0].command.includes('--behavior-changed false'));
        assert.ok(!result.commands[0].command.includes('--project-memory-updated true'));
        assert.ok(!result.commands[0].command.includes('--project-memory-update-not-needed true'));
        assert.ok(!result.commands[0].command.includes('Implementation files changed'));
        assert.ok(result.commands[0].command.includes('No user-facing documentation impact detected by next-step'));
    });

    it('suggests DOCS_UPDATED when changelog changed in the current preflight', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Updated behavior notes.\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true },
            { seedPostPreflight: false }
        );
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts', 'CHANGELOG.md']);
        preflight.scope_category = 'mixed';
        preflight.changed_files = ['src/app.ts', 'CHANGELOG.md'];
        preflight.metrics = {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(!result.commands[0].command.includes('--decision "NO_DOC_UPDATES"'));
        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));
        assert.ok(result.commands[0].command.includes('--docs-updated "CHANGELOG.md"'));
        assert.ok(result.commands[0].command.includes('--behavior-changed true'));
        assert.ok(result.commands[0].command.includes('--changelog-updated true'));
    });

    it('keeps changelog-only documentation maintenance default non-behavior-changing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Maintenance note.\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS },
            { changedFiles: ['CHANGELOG.md'], seedPostPreflight: false }
        );
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.scope_category = 'docs';
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(result.commands[0].command.includes('--decision "DOCS_UPDATED"'));
        assert.ok(result.commands[0].command.includes('--docs-updated "CHANGELOG.md"'));
        assert.ok(result.commands[0].command.includes('--behavior-changed false'));
        assert.ok(result.commands[0].command.includes('--changelog-updated true'));
    });

    it('includes sensitive-scope acknowledgement in doc-impact command when required', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.triggers = {
            security: true
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate');
        assert.ok(!result.commands[0].command.includes('<'));
        assert.ok(result.commands[0].command.includes('--sensitive-scope-reviewed true'));
    });


});
