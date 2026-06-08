import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildEventIntegrityHash,
    buildRulePackArtifact,
    buildStrictDecompositionDecisionArtifact,
    buildTaskModeArtifact,
    formatNextStepText,
    resolveNextStep
} from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';

const TASK_ID = 'T-CONTRACT-1';
const TASK_TITLE = 'Pin next-step contract before refactor';

let tempRoots: string[] = [];

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    details: Record<string, unknown> = {},
    timestampUtc = new Date().toISOString()
): void {
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
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome: 'PASS',
        actor: 'gate',
        message: eventType,
        timestamp_utc: timestampUtc,
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: typeof previousIntegrity?.event_sha256 === 'string'
                ? previousIntegrity.event_sha256
                : null,
            event_sha256: null
        }
    };
    (line.integrity as Record<string, unknown>).event_sha256 = buildEventIntegrityHash(line);
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function makeContractRepo(extraTaskMdLines: string[] = []): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-contract-'));
    tempRoots.push(repoRoot);

    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });

    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
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
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | refactor/contract | ${TASK_TITLE} | gpt-5.3-codex | 2026-05-24 | strict | Contract fixture. |`,
        '',
        ...extraTaskMdLines
    ].join('\n'), 'utf8');

    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });

    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);

    return repoRoot;
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`);
    writeJson(taskModePath, buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: TASK_TITLE,
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED', {
        artifact_path: normalizeForTimeline(taskModePath)
    }, '2026-01-01T00:00:00.000Z');
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    writeJson(rulePackPath, buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]
    }));
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', {
        stage: 'TASK_ENTRY',
        artifact_path: normalizeForTimeline(rulePackPath)
    }, '2026-01-01T00:00:01.000Z');
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED', {}, '2026-01-01T00:00:02.000Z');
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED', {}, '2026-01-01T00:00:03.000Z');
}

function seedPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    writeJson(rulePackPath, buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        taskModePath: path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`),
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
    }));
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', {
        stage: 'POST_PREFLIGHT',
        preflight_path: normalizeForTimeline(preflightPath),
        artifact_path: normalizeForTimeline(rulePackPath)
    }, '2026-01-01T00:00:05.000Z');
}

function seedStrictDecompositionDecision(repoRoot: string, taskId: string): void {
    writeJson(
        path.join(reviewsRoot(repoRoot), `${taskId}-strict-decomposition-decision.json`),
        buildStrictDecompositionDecisionArtifact({
            taskId,
            decision: 'single-cycle',
            taskSummary: TASK_TITLE,
            reason: 'Optional-skill activation routing is one bounded navigator contract change.',
            scopeRisk: 'Strict profile requires an explicit single-cycle decision before lifecycle continuation.',
            expectedReviewTypes: ['none'],
            atomicityConstraints: ['Keep optional-skill activation routing and contract tests together.']
        })
    );
}

function seedOptionalSkillSelectionPreflight(
    repoRoot: string,
    taskId: string,
    options: { policyMode?: 'advisory' | 'required' | 'strict'; skillId?: string; skillPath?: string } = {}
): void {
    const policyMode = options.policyMode || 'advisory';
    const skillId = options.skillId || 'node-backend';
    const skillPath = options.skillPath || 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md';
    const reviewsDir = reviewsRoot(repoRoot);
    const optionalSkillArtifactPath = path.join(reviewsDir, `${taskId}-optional-skill-selection.json`);
    const preflightPath = path.join(reviewsDir, `${taskId}-preflight.json`);
    const optionalSkillArtifact = {
        schema_version: 1,
        event_source: 'optional-skill-selection',
        task_id: taskId,
        timestamp_utc: '2026-01-01T00:00:04.000Z',
        policy_mode: policyMode,
        decision: 'selected_installed_skills',
        selected_installed_skills: [
            {
                id: skillId,
                pack: skillId,
                source: 'installed_optional',
                allowed_skill_path: skillPath,
                reason_codes: ['task_signals'],
                matches: { task_signals: ['api endpoint'], changed_path_signals: [] }
            }
        ],
        recommended_missing_packs: [],
        as_is_reason: null,
        task_text_present: true,
        task_text_sha256: 'fixture-task-text',
        changed_paths: ['src/api/orders.ts'],
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: 'fixture-preflight',
        headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
        headlines_sha256: 'fixture-headlines',
        visible_summary_line: `Optional skills: ${skillId} (reason: task_text)`
    };
    writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
    writeJson(preflightPath, {
        task_id: taskId,
        scope_category: 'code',
        changed_files: ['src/api/orders.ts'],
        required_reviews: {
            code: false,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        optional_skill_selection: {
            artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
            policy_mode: policyMode,
            decision: 'selected_installed_skills',
            visible_summary_line: `Optional skills: ${skillId} (reason: task_text)`
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', {
        output_path: normalizeForTimeline(preflightPath)
    }, '2026-01-01T00:00:04.500Z');
    seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
}

afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

describe('next-step refactor contract baseline', () => {
    it('keeps the fresh-task JSON contract and enter-task-mode command shape stable', () => {
        const repoRoot = makeContractRepo();

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.schema_version, 1);
        assert.equal(result.task_id, TASK_ID);
        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.equal(result.title, 'Enter task mode first.');
        assert.deepEqual(result.review.required_reviews, []);
        assert.equal(result.full_suite_validation.enabled, false);
        assert.equal(result.task_queue_status_contract.agent_may_edit_non_status_task_content, true);
        assert.ok(result.missing_artifacts.some((artifact) => artifact.key === 'task-mode'));
        assert.ok(result.commands[0]);
        assert.equal(result.commands[0].label, 'Enter task mode');
        assert.match(result.commands[0].command, /gate enter-task-mode/u);
        assert.match(result.commands[0].command, new RegExp(`--task-id "${TASK_ID}"`, 'u'));
        assert.match(result.commands[0].command, new RegExp(`--task-summary "${TASK_TITLE}"`, 'u'));
    });

    it('keeps formatted next-step text sections and command loop guidance stable', () => {
        const repoRoot = makeContractRepo();

        const text = formatNextStepText(resolveNextStep({ taskId: TASK_ID, repoRoot }));

        assert.match(text, /^GARDA_NEXT_STEP$/mu);
        assert.match(text, new RegExp(`^Task: ${TASK_ID}$`, 'mu'));
        assert.match(text, /^Navigator: node bin\/garda\.js next-step "T-CONTRACT-1" --repo-root "\."$/mu);
        assert.match(text, /^Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints\.$/mu);
        assert.match(text, /^Commands:$/mu);
        assert.match(text, /^  Enter task mode: node bin\/garda\.js gate enter-task-mode /mu);
        assert.match(text, /^AfterCommand: rerun node bin\/garda\.js next-step "T-CONTRACT-1" --repo-root "\." after the command above completes\.$/mu);
        assert.doesNotMatch(text, /\[object Object\]/u);
    });

    it('keeps canonical nine-column TASK.md rows authoritative over short duplicate tables', () => {
        const repoRoot = makeContractRepo([
            '## User Summary',
            '| ID | Title |',
            '|---|---|',
            `| ${TASK_ID} | Wrong duplicate title from short table |`,
            ''
        ]);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.commands[0]?.label, 'Enter task mode');
        assert.match(result.commands[0]?.command ?? '', new RegExp(`--task-summary "${TASK_TITLE}"`, 'u'));
        assert.doesNotMatch(result.commands[0]?.command ?? '', /Wrong duplicate title/u);
    });

    it('surfaces optional-skill selection guidance from current preflight evidence', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            policy_mode: 'advisory',
            decision: 'selected_installed_skills',
            selected_installed_skills: [
                {
                    id: 'node-backend',
                    pack: 'node-backend',
                    source: 'installed_optional',
                    allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                    reason_codes: ['task_signals'],
                    matches: { task_signals: ['api endpoint'], changed_path_signals: [] }
                }
            ],
            recommended_missing_packs: [],
            as_is_reason: null,
            task_text_present: true,
            task_text_sha256: 'fixture-task-text',
            changed_paths: ['src/api/orders.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/api/orders.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'advisory',
                decision: 'selected_installed_skills',
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.optional_skill_selection?.decision, 'selected_installed_skills');
        assert.deepEqual(result.optional_skill_selection?.selected_skill_ids, ['node-backend']);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /Run the activation command/i);
        assert.match(text, /^OptionalSkillDecision: policy=advisory; decision=selected_installed_skills;/mu);
        assert.match(text, /^OptionalSkillSelected: node-backend$/mu);
        assert.match(text, /gate activate-optional-skill --task-id "T-CONTRACT-1" --skill-id "node-backend"/u);
    });

    it('routes selected optional-skill activation through the single Commands entry before compile', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.equal(result.commands.length, 1);
        assert.equal(result.commands[0]?.label, 'Activate optional skill node-backend');
        assert.match(result.commands[0]?.command || '', /gate activate-optional-skill --task-id "T-CONTRACT-1" --skill-id "node-backend"/u);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(text, /^Commands:$/mu);
        assert.match(text, /^  Activate optional skill node-backend: node bin\/garda\.js gate activate-optional-skill /mu);
        assert.match(text, /^OptionalSkillPendingActivation: node-backend$/mu);
    });

    it('shell-quotes selected optional-skill ids in the executable activation command', () => {
        const repoRoot = makeContractRepo();
        const unsafeSkillId = 'node" ; Write-Output injected #';
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, {
            policyMode: 'required',
            skillId: unsafeSkillId,
            skillPath: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
        });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const command = result.commands[0]?.command || '';

        assert.equal(result.next_gate, 'activate-optional-skill');
        assert.match(command, /--skill-id 'node" ; Write-Output injected #'/u);
        assert.doesNotMatch(command, /--skill-id "node" ; Write-Output injected #"/u);

        const argvProbePath = path.join(repoRoot, 'argv-probe.ps1');
        fs.writeFileSync(
            argvProbePath,
            '$args | ForEach-Object { "ARG=$_"}',
            'utf8'
        );
        const probeCommand = command.replace(/^node bin\/garda\.js/u, `powershell -NoProfile -ExecutionPolicy Bypass -File '${argvProbePath.replace(/'/g, "''")}'`);
        const probe = childProcess.spawnSync(
            'powershell',
            ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', probeCommand],
            { cwd: repoRoot, encoding: 'utf8' }
        );
        const probeOutput = `${probe.stdout || ''}\n${probe.stderr || ''}`;
        assert.equal(probe.status, 0, probeOutput);
        assert.match(probeOutput, /ARG=--skill-id/u);
        assert.match(probeOutput, /ARG=node.*Write-Output injected #/u);
        assert.doesNotMatch(probeOutput, /^injected$/mu);
    });

    it('keeps advisory selected optional-skill activation non-blocking', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'advisory' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'compile-gate');
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(text, /^OptionalSkillPendingActivation: node-backend$/mu);
        assert.match(text, /Selected advisory optional skill\(s\): node-backend/u);
        assert.match(result.commands[0]?.command || '', /gate compile-gate/u);
    });

    it('continues past optional-skill activation once current-cycle activation evidence exists', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection'
        }, '2026-01-01T00:00:06.000Z');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.next_gate, 'activate-optional-skill');
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, ['node-backend']);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, []);
    });

    it('does not trust optional-skill activation evidence from a malformed task timeline', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID);
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection'
        }, '2026-01-01T00:00:06.000Z');
        fs.appendFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), '{\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.equal(result.optional_skill_selection?.timeline_invalid_json, true);
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
    });

    it('blocks required optional-skill activation on malformed task timelines instead of looping activation', () => {
        const repoRoot = makeContractRepo();
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const route = true;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        seedOptionalSkillSelectionPreflight(repoRoot, TASK_ID, { policyMode: 'required' });
        seedStrictDecompositionDecision(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'SKILL_SELECTED', {
            skill_id: 'node-backend',
            trigger_reason: 'optional_skill_selection'
        }, '2026-01-01T00:00:06.000Z');
        fs.appendFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), '{\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'task-events-summary');
        assert.equal(result.optional_skill_selection?.timeline_invalid_json, true);
        assert.deepEqual(result.optional_skill_selection?.activated_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.pending_activation_skill_ids, ['node-backend']);
        assert.match(result.commands[0]?.command || '', /gate task-events-summary --task-id "T-CONTRACT-1" --as-json/u);
        assert.doesNotMatch(result.commands[0]?.command || '', /activate-optional-skill/u);
        assert.match(text, /^OptionalSkillTimelineInvalidJson: true$/mu);
        assert.match(text, /Repair malformed task timeline/u);
    });

    it('surfaces compact catalog guidance when optional-skill evidence recommends missing packs', () => {
        const repoRoot = makeContractRepo();
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const optionalSkillArtifactPath = path.join(reviewsRoot, `${TASK_ID}-optional-skill-selection.json`);
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const optionalSkillArtifact = {
            schema_version: 1,
            event_source: 'optional-skill-selection',
            task_id: TASK_ID,
            timestamp_utc: '2026-01-01T00:00:00.000Z',
            policy_mode: 'advisory',
            decision: 'recommended_missing_packs',
            selected_installed_skills: [],
            recommended_missing_packs: [
                {
                    id: 'telegram-bot',
                    pack: 'telegram-bot',
                    reason_codes: ['task_signals'],
                    matches: { task_signals: ['telegram bot'], changed_path_signals: [] }
                }
            ],
            as_is_reason: 'no_relevant_installed_skill',
            task_text_present: true,
            task_text_sha256: 'fixture-task-text',
            changed_paths: ['src/bot/telegram.ts'],
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: 'fixture-preflight',
            headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
            headlines_sha256: 'fixture-headlines',
            visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
        };
        writeJson(optionalSkillArtifactPath, optionalSkillArtifact);
        writeJson(preflightPath, {
            task_id: TASK_ID,
            scope_category: 'code',
            changed_files: ['src/bot/telegram.ts'],
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            },
            optional_skill_selection: {
                artifact_path: optionalSkillArtifactPath.replace(/\\/g, '/'),
                policy_mode: 'advisory',
                decision: 'recommended_missing_packs',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: telegram-bot, reason: task_text)'
            }
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.optional_skill_selection?.decision, 'recommended_missing_packs');
        assert.deepEqual(result.optional_skill_selection?.selected_skill_ids, []);
        assert.deepEqual(result.optional_skill_selection?.recommended_missing_pack_ids, ['telegram-bot']);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /missing pack recommendation\(s\): telegram-bot/i);
        assert.match(result.optional_skill_selection?.task_start_instruction || '', /compact skill catalog/i);
        assert.match(text, /^OptionalSkillDecision: policy=advisory; decision=recommended_missing_packs;/mu);
        assert.match(text, /^OptionalSkillRecommendedMissingPacks: telegram-bot$/mu);
        assert.match(text, /^OptionalSkillCatalog: garda-agent-orchestrator\/live\/config\/skills-headlines\.json$/mu);
        assert.match(text, /^OptionalSkillTaskStartInstruction: .*compact skill catalog/mu);
    });
});
