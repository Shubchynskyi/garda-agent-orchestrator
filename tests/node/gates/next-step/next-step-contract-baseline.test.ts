import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';

const TASK_ID = 'T-CONTRACT-1';
const TASK_TITLE = 'Pin next-step contract before refactor';

let tempRoots: string[] = [];

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function makeContractRepo(extraTaskMdLines: string[] = []): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-contract-'));
    tempRoots.push(repoRoot);

    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });

    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
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
