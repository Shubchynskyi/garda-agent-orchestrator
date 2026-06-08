import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { formatFinalUserReport } from '../../../../src/gates/task-audit/task-audit-summary';

import {
    fs,
    path,
    spawn,
    createHash,
    execFileSync,
    buildTaskAuditSummary,
    formatTaskAuditSummaryText,
    formatFinalCloseoutMarkdown,
    synchronizeFinalCloseoutArtifacts,
    readReviewTrustSummary,
    readReviewTrustSummaryFromReviewGate,
    ensureSkillsHeadlinesCurrent,
    getWorkspaceSnapshot,
    PROJECT_MEMORY_IMPACT_ASSESSED_EVENT,
    NODE_BACKEND_SKILL_SOURCE,
    computeFileSha256,
    computeTaskTextSha256,
    writeEvent,
    writePreflight,
    writeArtifact,
    writeIntegrityEventSequence,
    appendIntegrityEvent,
    buildReviewRecordedTelemetryDetails,
    writePassedLifecycleWithReviewRecorded,
    writeWorkflowConfig,
    writeProjectMemoryWorkflowConfig,
    seedProjectMemory,
    writeProjectMemoryImpactArtifact,
    writePathsConfig,
    writePassedLifecycle,
    makeIndependentReviewGateCheck,
    makeReviewerInvocationProvenance,
    makeDelegatedRouting,
    writeRequiredCodeScenario,
    buildCurrentTaskAuditSummary,
    assertReviewIntegrity,
    assertReviewIntegrityBlocksFinalCloseout,
    writeCurrentIndependentReviewFixture,
    initGitRepo,
    writeActiveCompletionLock,
    makeTempDir,
    type TaskAuditSummaryResult
} from './task-audit-summary-fixtures';


describe('gates/task-audit-summary', () => {
    let tmpDir: string;
    let eventsDir: string;
    let reviewsDir: string;
    const TASK_ID = 'T-AUDIT-1';

    beforeEach(() => {
        tmpDir = makeTempDir();
        eventsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(tmpDir, false);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('buildTaskAuditSummary', () => {

        it('renders the compact agent report block with stable English labels when closeout carries agent report state', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-168-final-closeout.json',
                    markdown: 'runtime/reviews/T-168-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 2,
                    changed_lines_total: 15,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'as_is',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'generic_context_sufficient',
                    visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'Russian',
                    assistant_language_confirmed: true,
                    next_task_command: 'Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.',
                    latest_update_notice: '1.2.3'
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('GARDA_AGENT_REPORT'));
            assert.ok(renderedMarkdown.includes('Task closeout'));
            assert.ok(renderedMarkdown.includes('Language: Russian (normalized)'));
            assert.ok(renderedMarkdown.includes('Profile: balanced'));
            assert.ok(renderedMarkdown.includes('Mandatory full-suite: disabled'));
            assert.ok(renderedMarkdown.includes('Tell the agent: Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
        });

        it('renders stable English compact report labels when closeout language is French', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-211-final-closeout.json',
                    markdown: 'runtime/reviews/T-211-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED', test: 'TEST REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 2,
                    changed_lines_total: 15,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'as_is',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'generic_context_sufficient',
                    visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
                },
                workflow: {
                    mandatory_full_suite_enabled: true,
                    visible_summary_line: 'Mandatory full-suite: true'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'French',
                    assistant_language_confirmed: true,
                    next_task_command: 'Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.',
                    latest_update_notice: '1.2.3'
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('GARDA_AGENT_REPORT'));
            assert.ok(renderedMarkdown.includes('Task closeout'));
            assert.ok(renderedMarkdown.includes('Language: French (normalized)'));
            assert.ok(renderedMarkdown.includes('Review mode: review integrity=DEGRADED_OR_UNVERIFIABLE; verdicts: code=REVIEW PASSED, test=TEST REVIEW PASSED'));
            assert.ok(renderedMarkdown.includes('Optional skills: no additional skills (generic_context_sufficient)'));
            assert.ok(renderedMarkdown.includes('Mandatory full-suite: enabled'));
            assert.ok(renderedMarkdown.includes('Tell the agent: Execute task T-001 from TASK.md strictly through all mandatory orchestrator gates.'));
        });

        it('renders unavailable optional-skill summaries inside the compact report block', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-211-final-closeout.json',
                    markdown: 'runtime/reviews/T-211-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'unavailable',
                    selected_skill_ids: ['node-backend'],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: 'task_events_integrity',
                    visible_summary_line: 'Optional skills: unavailable (reason: task_events_integrity)'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'French',
                    assistant_language_confirmed: true,
                    next_task_command: null,
                    latest_update_notice: null
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: unavailable (reason: task_events_integrity)'));
        });

        it('renders none-used optional-skill summaries inside the compact report block', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-211-final-closeout.json',
                    markdown: 'runtime/reviews/T-211-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'selected_installed_skills',
                    selected_skill_ids: ['node-backend'],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: [],
                    as_is_reason: null,
                    visible_summary_line: 'Optional skills: none_used (selected: node-backend, reason: task_text+paths)'
                },
                workflow: {
                    mandatory_full_suite_enabled: false,
                    visible_summary_line: 'Mandatory full-suite: false'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                agent_report: {
                    assistant_language: 'German',
                    assistant_language_confirmed: true,
                    next_task_command: null,
                    latest_update_notice: null
                },
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "fix(ux): compact report block"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: none used (selected: node-backend, reason: task_text+paths)'));
        });

        it('renders the compact optional skill summary line when present', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'advisory',
                    decision: 'selected_installed_skills',
                    selected_skill_ids: ['node-backend'],
                    used_skill_ids: ['node-backend'],
                    recommended_missing_pack_ids: [],
                    as_is_reason: null,
                    visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): optional skill selection"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: node-backend (reason: task_text+paths)'));
        });

        it('preserves recommended missing-pack summaries in final closeout markdown', () => {
            const renderedMarkdown = formatFinalCloseoutMarkdown({
                schema_version: 1,
                event_source: 'task-audit-summary',
                task_id: TASK_ID,
                generated_utc: '2026-01-01T00:00:00.000Z',
                audit_status: 'PASS',
                status: 'READY',
                blocker: null,
                artifact_state: 'MATERIALIZED',
                artifact_paths: {
                    json: 'runtime/reviews/T-149-final-closeout.json',
                    markdown: 'runtime/reviews/T-149-final-closeout.md'
                },
                implementation_summary: {
                    requested_depth: 2,
                    effective_depth: 2,
                    path_mode: 'FULL_PATH',
                    review_verdicts: { code: 'REVIEW PASSED' },
                    docs_updated: false,
                    changed_files_count: 1,
                    changed_lines_total: 5,
                    scope_category: 'code',
                    active_profile: 'balanced'
                },
                optional_skills: {
                    policy_mode: 'required',
                    decision: 'recommended_missing_packs',
                    selected_skill_ids: [],
                    used_skill_ids: [],
                    recommended_missing_pack_ids: ['node-backend'],
                    as_is_reason: 'no_relevant_installed_skill',
                    visible_summary_line: 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text+paths)'
                },
                docs: {
                    decision: 'NO_DOC_UPDATES',
                    behavior_changed: false,
                    changelog_updated: false,
                    docs_updated: []
                },
                token_economy: null,
                commit_command_template: 'git commit -m "<type>(<scope>): <summary>"',
                commit_command_suggestion: 'git commit -m "feat(workflow): optional skill selection"',
                commit_question: 'Do you want me to commit now? (yes/no)'
            });

            assert.ok(renderedMarkdown.includes('Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text+paths)'));
        });

        it('keeps historical optional-skill summaries stable when current policy or pack inventory drift later', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'strict' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skills-headlines.json'),
                JSON.stringify({
                    version: 2,
                    installed_pack_ids: ['node-backend'],
                    baseline_skill_ids: [],
                    installed_optional_skill_ids: ['node-backend'],
                    custom_skill_ids: [],
                    skills: [
                        {
                            id: 'node-backend',
                            directory: 'node-backend',
                            name: 'Node Backend',
                            summary: 'Node backend helper.',
                            pack: 'node-backend',
                            source: 'installed_optional',
                            implemented: true,
                            review_binding: 'general_purpose',
                            aliases: ['node'],
                            tags: ['node', 'backend']
                        }
                    ],
                    optional_packs: [
                        {
                            id: 'node-backend',
                            label: 'Node Backend',
                            description: 'Node backend specialist pack.',
                            installed: true,
                            implemented: true,
                            collides_with_baseline: false,
                            ready_skill_ids: ['node-backend'],
                            placeholder_skill_ids: [],
                            recommended_for: ['node backend'],
                            tags: ['node', 'backend']
                        }
                    ]
                }, null, 2),
                'utf8'
            );
            const skillRoot = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend');
            fs.mkdirSync(skillRoot, { recursive: true });
            fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n', 'utf8');

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'recommended_missing_packs',
                selected_installed_skills: [],
                recommended_missing_packs: [
                    {
                        id: 'node-backend',
                        label: 'Node Backend',
                        ready_skill_ids: ['node-backend'],
                        reason_codes: ['task_signals'],
                        matches: { task_signals: ['node-backend'], changed_path_signals: [] }
                    }
                ],
                as_is_reason: 'no_relevant_installed_skill',
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: 'headlines-hash',
                visible_summary_line: 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.policy_mode, 'advisory');
            assert.equal(result.final_closeout.optional_skills?.decision, 'recommended_missing_packs');
            assert.deepEqual(result.final_closeout.optional_skills?.recommended_missing_pack_ids, ['node-backend']);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: recommended_missing_packs (packs: node-backend, reason: task_text)');
        });

        it('preserves as_is optional-skill summaries when the artifact still matches the current TASK.md title', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | api | Implement request validation for a Node.js API endpoint | unassigned | 2026-04-20 | default | fixture |`
                ].join('\n'),
                'utf8'
            );

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
                schema_version: 1,
                event_source: 'optional-skill-selection',
                task_id: TASK_ID,
                timestamp_utc: '2026-01-01T00:00:00.000Z',
                policy_mode: 'advisory',
                decision: 'as_is',
                selected_installed_skills: [],
                recommended_missing_packs: [],
                as_is_reason: 'generic_context_sufficient',
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: as_is (reason: generic_context_sufficient)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'as_is');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.as_is_reason, 'generic_context_sufficient');
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: as_is (reason: generic_context_sufficient)');
        });

        it('invalidates optional-skill summaries when the current TASK.md title no longer matches the artifact task summary hash', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['docs/landing.md'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    `| ${TASK_ID} | 🟨 IN_PROGRESS | P1 | docs | Refresh landing-page copy for the marketing site | unassigned | 2026-04-20 | default | fixture |`
                ].join('\n'),
                'utf8'
            );

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
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
                        matches: { task_signals: ['node backend'], changed_path_signals: [] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['docs/landing.md'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'invalidated');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: unavailable (reason: artifact_drift)');
        });

        it('invalidates optional-skill summaries when the task row disappears from TASK.md', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['docs/landing.md'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            fs.writeFileSync(
                path.join(tmpDir, 'TASK.md'),
                [
                    '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                    '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-04-20 | default | fixture |'
                ].join('\n'),
                'utf8'
            );

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
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
                        matches: { task_signals: ['node backend'], changed_path_signals: [] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['docs/landing.md'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'invalidated');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: unavailable (reason: artifact_drift)');
        });

        it('surfaces selected optional-skill summaries only when optional-skill activation telemetry confirms usage', () => {
            fs.writeFileSync(
                path.join(eventsDir, `${TASK_ID}.jsonl`),
                [
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:01.000Z',
                        event_type: 'SKILL_SELECTED',
                        details: {
                            skill_id: 'node-backend',
                            trigger_reason: 'optional_skill_selection'
                        }
                    }),
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:02.000Z',
                        event_type: 'SKILL_REFERENCE_LOADED',
                        details: {
                            skill_id: 'node-backend',
                            reference_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                            trigger_reason: 'optional_task_skill'
                        }
                    })
                ].join('\n'),
                'utf8'
            );
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
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
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, ['node-backend']);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: node-backend (reason: task_text+paths)');
        });

        it('counts current-cycle optional-skill activation as usage before a reference-load event exists', () => {
            fs.writeFileSync(
                path.join(eventsDir, `${TASK_ID}.jsonl`),
                [
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:01.000Z',
                        event_type: 'SKILL_SELECTED',
                        details: {
                            skill_id: 'node-backend',
                            trigger_reason: 'optional_skill_selection'
                        }
                    })
                ].join('\n'),
                'utf8'
            );
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
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
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, ['node-backend']);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: node-backend (reason: task_text+paths)');
        });

        it('does not overstate optional-skill usage when the artifact was selected but never activated', () => {
            fs.writeFileSync(path.join(eventsDir, `${TASK_ID}.jsonl`), '', 'utf8');
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
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
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: none_used (selected: node-backend, reason: task_text+paths)');
        });

        it('degrades optional-skill usage summary to unavailable when the task timeline is malformed', () => {
            fs.writeFileSync(
                path.join(eventsDir, `${TASK_ID}.jsonl`),
                [
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:01.000Z',
                        event_type: 'SKILL_SELECTED',
                        details: {
                            skill_id: 'node-backend',
                            trigger_reason: 'optional_skill_selection'
                        }
                    }),
                    JSON.stringify({
                        timestamp_utc: '2026-01-01T00:00:02.000Z',
                        event_type: 'SKILL_REFERENCE_LOADED',
                        details: {
                            skill_id: 'node-backend',
                            reference_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md',
                            trigger_reason: 'optional_task_skill'
                        }
                    }),
                    '{'
                ].join('\n'),
                'utf8'
            );
            writePreflight(reviewsDir, TASK_ID, {
                changed_files: ['src/api/orders.ts'],
                metrics: { changed_lines_total: 10 },
                required_reviews: {}
            });

            const bundleConfigDir = path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'config');
            fs.mkdirSync(bundleConfigDir, { recursive: true });
            fs.writeFileSync(
                path.join(bundleConfigDir, 'optional-skill-selection-policy.json'),
                JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
                'utf8'
            );
            fs.writeFileSync(
                path.join(bundleConfigDir, 'skill-packs.json'),
                JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
                'utf8'
            );
            fs.cpSync(
                NODE_BACKEND_SKILL_SOURCE,
                path.join(tmpDir, 'garda-agent-orchestrator', 'live', 'skills', 'node-backend'),
                { recursive: true }
            );
            const currentHeadlines = ensureSkillsHeadlinesCurrent(path.join(tmpDir, 'garda-agent-orchestrator'));

            writeArtifact(reviewsDir, TASK_ID, '-optional-skill-selection.json', {
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
                        reason_codes: ['task_signals', 'changed_path_signals'],
                        matches: { task_signals: ['node backend'], changed_path_signals: ['src/api/'] }
                    }
                ],
                recommended_missing_packs: [],
                as_is_reason: null,
                task_text_present: true,
                task_text_sha256: computeTaskTextSha256('Implement request validation for a Node.js API endpoint'),
                changed_paths: ['src/api/orders.ts'],
                preflight_path: path.join(reviewsDir, `${TASK_ID}-preflight.json`).replace(/\\/g, '/'),
                preflight_sha256: computeFileSha256(path.join(reviewsDir, `${TASK_ID}-preflight.json`)),
                headlines_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
                headlines_sha256: currentHeadlines.sha256,
                visible_summary_line: 'Optional skills: node-backend (reason: task_text+paths)'
            });

            const result = buildTaskAuditSummary({
                taskId: TASK_ID,
                repoRoot: tmpDir,
                eventsRoot: eventsDir,
                reviewsRoot: reviewsDir
            });

            assert.equal(result.final_closeout.optional_skills?.decision, 'unavailable');
            assert.deepEqual(result.final_closeout.optional_skills?.selected_skill_ids, ['node-backend']);
            assert.deepEqual(result.final_closeout.optional_skills?.used_skill_ids, []);
            assert.equal(result.final_closeout.optional_skills?.visible_summary_line, 'Optional skills: unavailable (reason: task_events_integrity)');
        });

    });
});
