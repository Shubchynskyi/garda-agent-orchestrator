import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

import { resolveNextStep } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';

const TASK_ID = 'T-NEXT-1';

const ALL_REVIEW_FLAGS = Object.freeze({
    code: false,
    db: false,
    security: false,
    refactor: false,
    api: false,
    test: false,
    performance: false,
    infra: false,
    dependency: false
});

let tempRoots: string[] = [];


function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'template', 'docs', 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
        ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });
    for (const ruleFile of [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]) {
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', ruleFile),
            `# ${ruleFile}\n`,
            'utf8'
        );
    }
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
    fs.writeFileSync(
        path.join(repoRoot, 'template', 'docs', 'prompts', 'review-cycle-auto-split.md'),
        [
            '# Review Cycle Auto-Split Prompt for {{TASK_ID}}',
            '',
            'GuardReason: {{GUARD_REASON}}',
            'Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}',
            'LatestFailedReview: {{LATEST_FAILED_REVIEW}}',
            'SuggestedChildTaskIds: {{SUGGESTED_CHILD_TASK_IDS}}',
            'SuggestedReviewerFollowUpTaskId: {{SUGGESTED_FOLLOWUP_TASK_ID}}',
            '',
            '## Instructions',
            '1. Treat the parent as SPLIT_REQUIRED, create linked parent-derived suffix task IDs, then rerun next-step so the gate moves it to DECOMPOSED.',
            '2. Allocate child ids from {{SUGGESTED_CHILD_TASK_IDS}}.',
            '',
            '## Constraints',
            '- Do not mark the parent DONE merely because child tasks were created.',
            '- Do not hand-edit the parent status to bypass SPLIT_REQUIRED.',
            '- Reviewer follow-ups use {{SUGGESTED_FOLLOWUP_TASK_ID}} style ids.',
            ''
        ].join('\n'),
        'utf8'
    );
    return repoRoot;
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}





function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}



function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome = 'PASS',
    details: Record<string, unknown> = {},
    timestampUtc?: string
): { task_sequence: number; prev_event_sha256: string | null; event_sha256: string } {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingLines = fs.existsSync(timelinePath)
        ? fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim())
        : [];
    const taskSequence = existingLines.length + 1;
    const previousEvent = taskSequence > 1
        ? JSON.parse(existingLines[existingLines.length - 1]) as Record<string, unknown>
        : null;
    const previousIntegrity = previousEvent?.integrity && typeof previousEvent.integrity === 'object'
        ? previousEvent.integrity as Record<string, unknown>
        : null;
    const previousEventSha256 = typeof previousIntegrity?.event_sha256 === 'string'
        ? previousIntegrity.event_sha256
        : null;
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'gate',
        message: eventType,
        timestamp_utc: timestampUtc || new Date().toISOString(),
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousEventSha256,
            event_sha256: null
        }
    };
    const integrity = line.integrity as Record<string, unknown>;
    integrity.event_sha256 = buildEventIntegrityHash(line);
    const eventSha256 = String(integrity.event_sha256 || '');
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
    return {
        task_sequence: taskSequence,
        prev_event_sha256: previousEventSha256,
        event_sha256: eventSha256
    };
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY');
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}


function seedTaskModeOnly(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
}

function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT', taskModePath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage,
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function seedHandshake(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
}

function seedShellSmoke(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}

function seedPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string, taskModePath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '30-code-style.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage: 'POST_PREFLIGHT',
        preflight_path: normalizeForTimeline(preflightPath),
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}


function getLoadedRuleFileBasenames(command: string): string[] {
    return [...command.matchAll(/--loaded-rule-file "([^"]+)"/g)]
        .map((match) => path.basename(match[1]))
        .sort();
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>,
    options: {
        seedPostPreflight?: boolean;
        reviewPolicyMode?: string;
        changedFiles?: string[];
        includeDomainScopeFingerprints?: boolean;
    } = {}
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const changedFiles = options.changedFiles || ['src/app.ts'];
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
    const domainScopeFingerprints = options.includeDomainScopeFingerprints
        ? buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: snapshot.detection_source,
            includeUntracked: snapshot.include_untracked,
            changedFiles
        })
        : null;
    const reviewPolicyMode = options.reviewPolicyMode || 'code_first_optional';
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256,
            ...(domainScopeFingerprints ? { domain_scope_fingerprints: domainScopeFingerprints } : {})
        },
        required_reviews: requiredReviews,
        changed_files: changedFiles,
        review_execution_policy: {
            mode: reviewPolicyMode,
            visible_summary_line: `Review execution policy: ${reviewPolicyMode}`
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    if (options.seedPostPreflight !== false) {
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    }
    return preflightPath;
}




















afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step preflight routing', () => {
    it('routes to classify-change before preflight and POST_PREFLIGHT rules after preflight', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const missingPreflight = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingPreflight.next_gate, 'classify-change');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { seedPostPreflight: false });
        const missingPostPreflight = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingPostPreflight.next_gate, 'load-rule-pack');
        assert.ok(missingPostPreflight.commands[0].command.includes('--stage "POST_PREFLIGHT"'));
        assert.ok(!missingPostPreflight.commands[0].command.includes('<task-specific-rule-file>'));
        assert.deepEqual(getLoadedRuleFileBasenames(missingPostPreflight.commands[0].command), [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]);
    });

    it('uses task-mode planned scope when building the initial classify-change command', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Polish next-step planned scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [
                'src/gates/next-step.ts',
                'docs/cli-reference.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--task-intent "Polish next-step planned scope"'));
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'));
        assert.ok(command.includes('--changed-file "src/gates/next-step.ts"'));
        assert.ok(!command.includes('<path>'));
        assert.ok(!command.includes('<task summary>'));
    });

    it('adds changed dependency lockfile siblings to planned manifest classify-change commands', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Update dependency manifest',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package.json']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'sibling-drift.ts'), 'export const siblingDrift = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(!command.includes('src/sibling-drift.ts'));
    });

    it('adds changed dependency manifest siblings to planned lockfile classify-change commands', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Close lockfile split child after manifest remediation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package-lock.json']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(!command.includes('CHANGELOG.md'));
    });

    it('blocks planned-scope preflight until the planned files have a materialized diff', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create planned docs after classification',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('planned --changed-file hints [src/app.ts]'));
        assert.ok(result.reason.includes('no materialized diff'));
        assert.ok(result.reason.includes('rerun next-step'));
    });

    it('keeps unrelated sibling drift out of planned-scope materialization recovery', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create planned source after classification',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- unrelated note\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'materialize-planned-scope');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('planned --changed-file hints [src/app.ts]'));
        assert.ok(!result.reason.includes('CHANGELOG.md'));
    });

    it('refreshes planned-scope preflight through classify-change after the planned files are materialized', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Create planned docs after classification',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedMaterialized = true;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('Refresh classify-change for the current scope first'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('CHANGELOG.md'));
        assert.ok(!command.includes('<path>'));
    });

    it('refreshes planned dependency manifest scope with changed lockfile siblings', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh package manifest and lockfile',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package.json']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['package.json'] });
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /missing from preflight: \[package-lock\.json\]/);
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(!command.includes('CHANGELOG.md'));
    });

    it('refreshes planned dependency lockfile scope with changed manifest siblings', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": {} }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'package-lock.json'), '{ "lockfileVersion": 3 }\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh lockfile split child after manifest remediation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['package-lock.json']
        }));
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['package-lock.json'] });
        fs.writeFileSync(path.join(repoRoot, 'package.json'), '{ "dependencies": { "left-pad": "1.3.0" } }\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /missing from preflight: \[package\.json\]/);
        assert.ok(command.includes('--changed-file "package-lock.json"'));
        assert.ok(command.includes('--changed-file "package.json"'));
        assert.ok(!command.includes('CHANGELOG.md'));
    });

    it('includes related test changes when refreshing planned source scope', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'),
            'export const nextStep = true;\n',
            'utf8'
        );
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(
            path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'),
            'import assert from "node:assert/strict";\n',
            'utf8'
        );
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned source and related tests',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/gates/next-step/next-step.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/gates/next-step/next-step.ts'] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'), 'export const plannedNextStep = true;\n', 'utf8');
        fs.appendFileSync(
            path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'),
            'assert.ok(true);\n',
            'utf8'
        );

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/gates/next-step/next-step.ts"'));
        assert.ok(command.includes('--changed-file "tests/node/gates/next-step/next-step-preflight-routing.test.ts"'));
    });

    it('accepts refreshed planned source scope with related tests and no-diff planned hints', () => {
        const repoRoot = makeTempRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'), 'export const nextStep = true;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step-helper.ts'), 'export const helper = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'), 'export const testCase = true;\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Accept planned source and related test scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [
                'src/gates/next-step/next-step.ts',
                'src/gates/next-step/next-step-helper.ts'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'gates', 'next-step', 'next-step.ts'), 'export const plannedNextStep = true;\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'tests', 'node', 'gates', 'next-step', 'next-step-preflight-routing.test.ts'), 'export const relatedTest = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: [
                'src/gates/next-step/next-step.ts',
                'src/gates/next-step/next-step-helper.ts',
                'tests/node/gates/next-step/next-step-preflight-routing.test.ts'
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'classify-change', result.reason);
        assert.ok(!result.reason.includes('no longer current: [src/gates/next-step/next-step-helper.ts]'), result.reason);
    });

    it('uses staged scope for first classify-change when unstaged sibling drift is present', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Classify staged task change',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const stagedTaskChange = true;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- unrelated unstaged note\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--use-staged'));
        assert.ok(!command.includes('CHANGELOG.md'));
    });

    it('uses staged scope for split child classify-change when sibling drift is present', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-PARENT | DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-06-25 | strict | Child tasks: `T-NEXT-1` and `T-NEXT-2`. |',
            `| ${TASK_ID} | TODO | P1 | workflow/split-child | First split child | gpt-5.5 | 2026-06-25 | strict | Child of T-PARENT; isolate staged child scope from sibling drift. |`,
            '| T-NEXT-2 | TODO | P1 | workflow/split-child | Sibling split child | gpt-5.5 | 2026-06-25 | strict | Sibling child. |',
            ''
        ].join('\n'), 'utf8');
        initGitRepo(repoRoot);
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'First split child staged implementation',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const splitChildChange = true;\n', 'utf8');
        runGitFixtureCommand(repoRoot, ['add', 'src/app.ts']);
        fs.writeFileSync(path.join(repoRoot, 'src', 'sibling-drift.ts'), 'export const siblingDrift = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--use-staged'));
        assert.ok(!command.includes('src/sibling-drift.ts'));
    });

    it('refreshes workflow-config preflight when dirty-baseline source files are outside scope', () => {
        const repoRoot = makeTempRepo();
        const workflowConfigPath = 'template/config/workflow-config.json';
        fs.mkdirSync(path.join(repoRoot, 'template', 'config'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, workflowConfigPath), '{\n  "version": 1\n}\n', 'utf8');
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const hiddenDirtyBaseline = true;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, workflowConfigPath), '{\n  "version": 2\n}\n', 'utf8');

        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: !!baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: Object.fromEntries(
                baselineSnapshot.changed_files.map((changedFile) => [
                    changedFile,
                    fileSha256(path.join(repoRoot, changedFile))
                ])
            )
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected workflow config scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            workflowConfigWork: true,
            plannedChangedFiles: [workflowConfigPath],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: [workflowConfigPath]
        });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.triggers = {
            changed_workflow_config_files: [workflowConfigPath],
            dirty_workspace_baseline_changed_files: baselineSnapshot.changed_files,
            dirty_workspace_baseline_changed_files_sha256: baselineSnapshot.changed_files_sha256,
            dirty_workspace_protected_files: ['src/app.ts'],
            dirty_workspace_protected_files_sha256: sha256Text('src/app.ts'),
            dirty_workspace_protected_file_hashes: {
                'src/app.ts': fileSha256(path.join(repoRoot, 'src', 'app.ts'))
            },
            dirty_workspace_protection_status: 'PASS',
            dirty_workspace_protection_changed_files: []
        };
        writeJson(preflightPath, preflight);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.reason, /workflow-config preflight is underscoped/);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "template/config/workflow-config.json"'));
    });

    it('preserves custom task-mode path when building classify-change commands', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-custom-task-mode.json`);
        writeJson(customTaskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Classify custom task-mode scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            artifact_path: normalizeForTimeline(customTaskModePath)
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', customTaskModePath);
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--task-intent "Classify custom task-mode scope"'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes(`--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`));
    });

    it('preserves planned changed files when refreshing a stale scoped preflight', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh a scoped next-step preflight',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: [
                'src/app.ts',
                'docs/cli-reference.md'
            ]
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('<path>'));
    });

    it('keeps planned refresh explicit when current workspace has no planned-file intersection', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'unrelated dirty file\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: Object.fromEntries(
                baselineSnapshot.changed_files.map((changedFile) => [
                    changedFile,
                    fileSha256(path.join(repoRoot, changedFile))
                ])
            )
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh a no-intersection planned preflight',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            dirtyWorkspaceBaseline,
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('docs/older-task.md'));
    });

    it('does not widen planned refresh through stale explicit preflight files', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'unrelated dirty file\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: Object.fromEntries(
                baselineSnapshot.changed_files.map((changedFile) => [
                    changedFile,
                    fileSha256(path.join(repoRoot, changedFile))
                ])
            )
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh stale explicit preflight without widening planned scope',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            dirtyWorkspaceBaseline,
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, {
            changedFiles: ['src/app.ts', 'docs/older-task.md']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('docs/older-task.md'));
    });

    it('accepts refreshed planned-scope preflight when unrelated dirty files remain outside the task scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'older-task.md'), 'unrelated dirty file\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: Object.fromEntries(
                baselineSnapshot.changed_files.map((changedFile) => [
                    changedFile,
                    fileSha256(path.join(repoRoot, changedFile))
                ])
            )
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Use refreshed planned preflight in a dirty workspace',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts'],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRefresh = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate', result.reason);
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(!result.commands[0].command.includes('gate classify-change'));
    });

    it('refreshes planned-scope preflight when a new unplanned file appears after planned files are materialized', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'extra'), { recursive: true });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned preflight with new unplanned current edits',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRefresh = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra', 'unplanned.ts'), 'export const unplanned = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [src/extra/unplanned.ts]'), result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "src/extra/unplanned.ts"'));
    });

    it('refreshes planned-scope preflight when a new unplanned file appears before planned files are materialized', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'extra'), { recursive: true });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned preflight with early unplanned current edits',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            plannedChangedFiles: ['src/app.ts']
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.writeFileSync(path.join(repoRoot, 'src', 'extra', 'unplanned.ts'), 'export const unplanned = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [src/extra/unplanned.ts]'), result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "src/extra/unplanned.ts"'));
    });

    it('keeps ignored task-owned TASK.md metadata in stale preflight refresh commands', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot, {
            gitignoreContent: 'TASK.md\ngarda-agent-orchestrator/runtime/\n'
        });
        const taskMdPath = path.join(repoRoot, 'TASK.md');
        const taskMdBaselineHash = fileSha256(taskMdPath);
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['TASK.md'],
            changed_files_sha256: sha256Text('TASK.md'),
            scope_sha256: null,
            file_hashes: {
                'TASK.md': taskMdBaselineHash
            }
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh planned source after task queue metadata changes',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: ['src/app.ts'],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const plannedRefresh = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: ['src/app.ts'] });
        fs.appendFileSync(taskMdPath, '\nOperator note after preflight.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('missing from preflight: [TASK.md]'), result.reason);
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(command.includes('--changed-file "TASK.md"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('uses current git-auto workspace files when refreshing stale unscoped preflight', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const currentWorkspaceRefresh = true;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('uses orchestrator-work dirty workspace baseline when refreshing stale protected preflight', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const protectedRefresh = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'cli-reference.md'), '# CLI\n\nprotected refresh\n', 'utf8');
        const baselineSnapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
        const dirtyWorkspaceBaseline = {
            detection_source: baselineSnapshot.detection_source,
            include_untracked: !!baselineSnapshot.include_untracked,
            changed_files: baselineSnapshot.changed_files,
            changed_files_sha256: baselineSnapshot.changed_files_sha256,
            scope_sha256: baselineSnapshot.scope_sha256,
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from dirty baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "docs/cli-reference.md"'));
        assert.ok(command.includes('--changed-file "src/app.ts"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('expands dirty-baseline directory placeholders before printing classify-change refresh scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.mkdirSync(path.join(repoRoot, 'src', 'generated'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'generated', 'new-feature.ts'), 'export const generatedFeature = true;\n', 'utf8');
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['src/generated'],
            changed_files_sha256: sha256Text('src/generated'),
            scope_sha256: sha256Text('src/generated'),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from dirty directory baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/generated/new-feature.ts"'));
        assert.ok(!command.includes('--changed-file "src/generated"'));
        assert.ok(!command.includes('--changed-file "<path>"'));
    });

    it('preserves deleted tracked file path when replaced by an untracked directory', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'src', 'generated'), 'export const oldGenerated = true;\n', 'utf8');
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.rmSync(path.join(repoRoot, 'src', 'generated'));
        fs.mkdirSync(path.join(repoRoot, 'src', 'generated'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'generated', 'new-feature.ts'), 'export const generatedFeature = true;\n', 'utf8');
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['src/generated'],
            changed_files_sha256: sha256Text('src/generated'),
            scope_sha256: sha256Text('src/generated'),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from file-to-directory replacement',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/generated"'));
        assert.ok(command.includes('--changed-file "src/generated/new-feature.ts"'));
    });

    it('preserves unsafe directory placeholders in classify-change refresh scope', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.mkdirSync(path.join(repoRoot, 'src', 'generated'), { recursive: true });
        const absoluteDirectory = normalizeForTimeline(path.join(repoRoot, 'src', 'generated'));
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: [
                '../outside-generated',
                absoluteDirectory
            ],
            changed_files_sha256: sha256Text(`../outside-generated\n${absoluteDirectory}`),
            scope_sha256: sha256Text(`../outside-generated\n${absoluteDirectory}`),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from unsafe directory baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "../outside-generated"'));
        assert.ok(command.includes(`--changed-file "${absoluteDirectory}"`));
    });

    it('preserves symlink directory placeholders in classify-change refresh scope', { skip: process.platform === 'win32' }, () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { changedFiles: [] });
        fs.mkdirSync(path.join(repoRoot, 'outside-generated'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'outside-generated', 'hidden.ts'), 'export const hidden = true;\n', 'utf8');
        fs.symlinkSync(path.join(repoRoot, 'outside-generated'), path.join(repoRoot, 'src', 'linked-generated'), 'dir');
        const dirtyWorkspaceBaseline = {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: ['src/linked-generated'],
            changed_files_sha256: sha256Text('src/linked-generated'),
            scope_sha256: sha256Text('src/linked-generated'),
            file_hashes: {}
        };
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-task-mode.json`), buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Refresh protected preflight from symlink directory baseline',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved',
            orchestratorWork: true,
            plannedChangedFiles: [],
            dirtyWorkspaceBaseline
        }));
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED');
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0].command;

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(command.includes('--changed-file "src/linked-generated"'));
    });
});
