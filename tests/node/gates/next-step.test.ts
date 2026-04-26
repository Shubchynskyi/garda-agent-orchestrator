import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { formatNextStepText, resolveNextStep } from '../../../src/gates/next-step';
import { getWorkspaceSnapshot } from '../../../src/gates/compile-gate';
import { buildRulePackArtifact } from '../../../src/gates/rule-pack';
import { buildTaskModeArtifact } from '../../../src/gates/task-mode';

const TASK_ID = 'T-NEXT-1';
const EXPECTED_LOOP_LINE = 'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.';

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
const PROVIDER_ENV_KEYS = Object.freeze([
    'GARDA_EXECUTION_PROVIDER',
    'CODEX_THREAD_ID',
    'CODEX_HOME',
    'CLAUDE_CODE_SSE_PORT',
    'CURSOR_TRACE_ID',
    'CURSOR_AGENT'
]);

function withProviderEnv<T>(updates: Record<string, string | undefined>, callback: () => T): T {
    const previousValues = new Map<string, string | undefined>();
    for (const key of PROVIDER_ENV_KEYS) {
        previousValues.set(key, process.env[key]);
        delete process.env[key];
    }
    for (const [key, value] of Object.entries(updates)) {
        if (value == null) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        return callback();
    } finally {
        for (const [key, value] of previousValues) {
            if (value == null) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
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
    fs.writeFileSync(
        path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm test'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            }
        }, null, 2),
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
    details: Record<string, unknown> = {}
): { task_sequence: number; prev_event_sha256: string | null; event_sha256: string } {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingLines = fs.existsSync(timelinePath)
        ? fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim())
        : [];
    const taskSequence = existingLines.length + 1;
    const previousEventSha256 = taskSequence > 1
        ? (taskSequence - 1).toString(16).padStart(64, '0')
        : null;
    const eventSha256 = taskSequence.toString(16).padStart(64, '0');
    const line = {
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'gate',
        message: eventType,
        timestamp_utc: new Date().toISOString(),
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousEventSha256,
            event_sha256: eventSha256
        }
    };
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
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`), { task_id: taskId, stage: 'POST_PREFLIGHT' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED');
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

function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT'): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`), { task_id: taskId, stage });
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED');
}

function seedHandshake(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
}

function seedShellSmoke(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}

function seedPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        loadedRuleFiles: [
            '00-core.md',
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
    options: { seedPostPreflight?: boolean; reviewPolicyMode?: string } = {}
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
    const reviewPolicyMode = options.reviewPolicyMode || 'code_first_optional';
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: { changed_lines_total: snapshot.changed_lines_total },
        required_reviews: requiredReviews,
        changed_files: ['src/app.ts'],
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

function seedCompilePass(repoRoot: string, taskId: string): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-compile-gate.json`), {
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: fileSha256(preflightPath),
        scope_detection_source: snapshot.detection_source,
        scope_include_untracked: snapshot.include_untracked,
        scope_changed_files: snapshot.changed_files,
        scope_changed_files_count: snapshot.changed_files_count,
        scope_changed_lines_total: snapshot.changed_lines_total,
        scope_changed_files_sha256: snapshot.changed_files_sha256,
        scope_sha256: snapshot.scope_sha256
    });
    appendEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED');
}

function writeReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    options: { verdict?: 'pass' | 'fail'; body?: string } = {}
): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const passToken = reviewType === 'code' ? 'REVIEW PASSED' : `${reviewType.toUpperCase()} REVIEW PASSED`;
    const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
    const verdictToken = options.verdict === 'fail' ? failToken : passToken;
    const reviewContext = {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`
        }
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const artifactText = `# ${reviewType} review\n\n${options.body || ''}## Verdict\n${verdictToken}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`
    });
    const invocationIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_context_sha256: sha256Text(reviewContextText),
        routing_event_sha256: routeIntegrity.event_sha256
    });
    writeJson(receiptPath, {
        task_id: taskId,
        review_type: reviewType,
        trust_level: 'INDEPENDENT_AUDITED',
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_artifact_sha256: sha256Text(artifactText),
        review_context_sha256: sha256Text(reviewContextText),
        reviewer_provenance: {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: invocationIntegrity.task_sequence,
            prev_event_sha256: invocationIntegrity.prev_event_sha256,
            event_sha256: invocationIntegrity.event_sha256,
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256
        }
    });
}

function writeReviewContextOnly(repoRoot: string, taskId: string, reviewType: string, reviewerIdentity: string): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(reviewContextPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        }
    });
}

function writeFreshReviewContextWithoutRouting(repoRoot: string, taskId: string, reviewType: string): string {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(reviewContextPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        reviewer_routing: {
            actual_execution_mode: null,
            reviewer_session_id: null
        }
    });
    return reviewContextPath;
}

function seedReviewGatePass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'REVIEW_GATE_PASSED');
}

function seedDocImpactPass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-doc-impact.json`), {
        task_id: taskId,
        decision: 'NO_DOC_UPDATES',
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'DOC_IMPACT_ASSESSED');
}

function seedCompletionPass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-completion-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'COMPLETION_GATE_PASSED');
}

afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step', () => {
    it('points a fresh task at enter-task-mode', () => {
        const repoRoot = makeTempRepo();
        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('gate enter-task-mode'));
        assert.ok(!result.commands[0].command.includes('<'));
        assert.ok(result.commands[0].command.includes('--requested-depth "2"'));
        assert.ok(result.commands[0].command.includes('--task-summary "Make next-step output executable in tests"'));
        assert.ok(result.commands[0].command.includes('--start-banner "Garda captures my mind"'));
        assert.ok(result.commands[0].command.includes('--provider "Codex"'));
        const text = formatNextStepText(result);
        assert.ok(text.includes(EXPECTED_LOOP_LINE));
        assert.ok(text.includes('AfterCommand: rerun'));
    });

    it('uses execution provider environment instead of source-of-truth metadata', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
            SourceOfTruth: 'Claude'
        });

        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('--provider "Codex"'));
        assert.ok(!result.commands[0].command.includes('<'));
        assert.ok(!result.commands[0].command.includes('--provider "Claude"'));
    });

    it('does not fabricate a provider when execution provider is unavailable', () => {
        const repoRoot = makeTempRepo();
        const result = withProviderEnv({}, () => resolveNextStep({ taskId: TASK_ID, repoRoot }));
        const expectedProviderReference = process.platform === 'win32'
            ? '--provider "$env:GARDA_EXECUTION_PROVIDER"'
            : '--provider "$GARDA_EXECUTION_PROVIDER"';

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.reason.includes('GARDA_EXECUTION_PROVIDER'));
        assert.ok(result.commands[0].command.includes(expectedProviderReference));
        assert.ok(!result.commands[0].command.includes('--provider "Codex"'));
        assert.ok(!result.commands[0].command.includes('<'));
    });

    it('uses shell-safe quoting for TASK.md summaries with embedded quotes', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ux/test | Fix "quoted" next-step command | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
            ''
        ].join('\n'), 'utf8');

        const result = withProviderEnv({ GARDA_EXECUTION_PROVIDER: 'Codex' }, () => (
            resolveNextStep({ taskId: TASK_ID, repoRoot })
        ));

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.commands[0].command.includes('--task-summary \'Fix "quoted" next-step command\''));
        assert.ok(!result.commands[0].command.includes('\\"'));
    });

    it('routes task-mode-only runs to TASK_ENTRY rule-pack loading', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.commands[0].command.includes('--stage "TASK_ENTRY"'));
    });

    it('routes missing handshake and shell-smoke preflight sequentially', () => {
        const repoRoot = makeTempRepo();
        seedTaskModeOnly(repoRoot, TASK_ID);
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');

        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics');

        seedHandshake(repoRoot, TASK_ID);
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight');
    });

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

    it('routes restarted task-mode cycles through fresh startup gates before reusing old preflight', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            restarted: true
        });

        const missingRulePack = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingRulePack.next_gate, 'load-rule-pack');
        assert.match(missingRulePack.reason, /latest TASK_MODE_ENTERED/);

        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        const missingHandshake = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingHandshake.next_gate, 'handshake-diagnostics');
        assert.match(missingHandshake.reason, /HANDSHAKE_DIAGNOSTICS_RECORDED/);

        seedHandshake(repoRoot, TASK_ID);
        const missingShellSmoke = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(missingShellSmoke.next_gate, 'shell-smoke-preflight');
        assert.match(missingShellSmoke.reason, /SHELL_SMOKE_PREFLIGHT_RECORDED/);

        seedShellSmoke(repoRoot, TASK_ID);
        const stalePreflight = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(stalePreflight.next_gate, 'classify-change');
        assert.match(stalePreflight.reason, /Preflight evidence is older than the latest TASK_MODE_ENTERED/);
        assert.ok(stalePreflight.commands[0].command.includes('--changed-file "src/app.ts"'));
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

    it('routes stale POST_PREFLIGHT evidence back to load-rule-pack after preflight refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.required_reviews = { ...ALL_REVIEW_FLAGS, code: true, test: true };
        writeJson(preflightPath, preflight);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.reason.includes('Rule-pack evidence'));
        assert.ok(result.commands[0].command.includes('--stage "POST_PREFLIGHT"'));
        assert.ok(!result.commands[0].command.includes('<task-specific-rule-file>'));
        assert.deepEqual(getLoadedRuleFileBasenames(result.commands[0].command), [
            '00-core.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]);
    });

    it('routes refreshed preflight after a closed cycle to restart-coherent-cycle before downstream gates', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('Latest PREFLIGHT_CLASSIFIED'));
        assert.ok(result.reason.includes('HANDSHAKE_DIAGNOSTICS_RECORDED'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
        assert.ok(result.commands[0].command.includes('--preflight-path'));
    });

    it('routes refreshed preflight after a failed completion cycle to restart-coherent-cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');

        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.reason.includes('COMPLETION_GATE_FAILED'));
        assert.ok(result.reason.includes('SHELL_SMOKE_PREFLIGHT_RECORDED'));
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
    });

    it('routes stale preflight scope back to classify-change before compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('Preflight scope is stale before compile'));
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--changed-file "src/app.ts"'));
    });

    it('routes protected control-plane preflight to an orchestrator-work restart command', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.triggers = {
            protected_control_plane_changed: true,
            changed_protected_files: ['src/gates/next-step.ts']
        };
        writeJson(preflightPath, preflight);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'enter-task-mode');
        assert.ok(result.reason.includes('--orchestrator-work'));
        assert.ok(result.commands[0].command.includes('--orchestrator-work'));
    });

    it('uses review policy to guide code before test review', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);

        const beforeCode = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(beforeCode.next_gate, 'build-review-context');
        assert.equal(beforeCode.review.next_review_type, 'code');
        assert.ok(beforeCode.commands[0].command.includes('--review-type "code"'));
        assert.ok(beforeCode.commands[0].command.includes('--depth "2"'));
        assert.ok(!beforeCode.commands[0].command.includes('<1|2|3>'));

        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const afterCode = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(afterCode.next_gate, 'build-review-context');
        assert.equal(afterCode.review.next_review_type, 'test');
        assert.ok(afterCode.commands[0].command.includes('--review-type "test"'));
    });

    it('stops after a failed upstream code review instead of launching downstream test review', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.match(result.reason, /REVIEW FAILED/);
        assert.match(result.reason, /Do not launch downstream reviewers/);
        assert.match(result.reason, /Dependent reviews currently blocked by this failure: test/);
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('reports strict_sequential downstream blockers after a failed code review', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true, db: true, api: true, test: true },
            { reviewPolicyMode: 'strict_sequential' }
        );
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.reason, /REVIEW FAILED/);
        assert.match(result.reason, /Do not launch downstream reviewers/);
        assert.match(result.reason, /Dependent reviews currently blocked by this failure: db, api, test/);
        assert.ok(!result.commands[0].command.includes('--review-type "db"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('refreshes review context after a failed upstream review becomes stale behind a new compile cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Refresh 'code' review context/);
        assert.match(result.reason, /no longer current after the latest compile cycle/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('routes to fresh reviewer routing after stale failed review context has been rebuilt', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);
        const rebuiltContextPath = writeFreshReviewContextWithoutRouting(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code',
            output_path: normalizeForTimeline(rebuiltContextPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Record 'code' delegated reviewer routing/);
        assert.ok(result.commands[0].command.includes('record-review-routing'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('does not treat non-verdict fail-token mentions as failed review verdicts', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', {
            body: [
                '## Reviewer Notes',
                'Historical note:',
                'REVIEW FAILED',
                ''
            ].join('\n')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'test');
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
    });

    it('surfaces effective full-suite config before completion', () => {
        const repoRoot = makeTempRepo();
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), {
            full_suite_validation: {
                enabled: true,
                command: 'npm test'
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            }
        });
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-review-gate.json`), { task_id: TASK_ID, status: 'PASSED' });
        writeJson(path.join(reviewsRoot(repoRoot), `${TASK_ID}-doc-impact.json`), { task_id: TASK_ID, decision: 'NO_DOC_UPDATES' });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_PASSED');
        appendEvent(repoRoot, TASK_ID, 'DOC_IMPACT_ASSESSED');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'full-suite-validation');
        assert.equal(result.full_suite_validation.enabled, true);
        assert.equal(result.full_suite_validation.command, 'npm test');
        assert.ok(result.reason.includes('workflow-config.json'));
    });

    it('does not treat stale pre-compile review routing as upstream pass evidence', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current REVIEWER_DELEGATION_ROUTED telemetry'));
        assert.ok(result.reason.includes('new clean-context delegated reviewer'));
        assert.ok(result.reason.includes('do not reuse an existing reviewer session'));
        assert.ok(result.reason.includes('fork_context=false'));
        assert.equal(result.commands[0].label, 'Record fresh delegated review routing');
    });

    it('uses the prepared review context identity when suggesting record-review-invocation', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-invocation');
        assert.ok(result.reason.includes('REVIEWER_INVOCATION_ATTESTED launch telemetry'));
        assert.equal(result.commands[0].label, 'Record delegated reviewer launch attestation');
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${reviewerIdentity}"`));
        assert.ok(result.commands[0].command.includes('gate record-review-invocation'));
    });

    it('routes to record-review-result after current context invocation is attested even when an old receipt exists', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${reviewerIdentity}"`));
    });

    it('routes fresh review contexts without routing telemetry to record-review-routing first', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', 'agent:code-reviewer');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.ok(result.commands[0].command.includes('--reviewer-identity "agent:code-reviewer"'));
    });

    it('routes stale review context bindings back to build-review-context after preflight refresh', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const refreshed = 3;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.ok(result.reason.includes('stale for the current preflight'));
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
    });

    it('blocks downstream review when receipt provenance hash does not match routing telemetry', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_provenance = {
            ...(receipt.reviewer_provenance as Record<string, unknown>),
            event_sha256: 'b'.repeat(64)
        };
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('matching REVIEWER_INVOCATION_ATTESTED launch telemetry'));
    });

    it('routes to completion when full-suite validation is disabled after docs pass', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.full_suite_validation.enabled, false);
        assert.equal(result.next_gate, 'completion-gate');
        assert.ok(result.commands[0].command.includes('gate completion-gate'));
    });

    it('routes to required-reviews-check when compile passed and no reviews are required', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check');
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
    });

    it('routes back to preflight refresh when workspace scope drifts after compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const drift = 2;\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.reason.includes('Preflight scope is stale before compile'));
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
        assert.ok(result.commands[0].command.includes('--behavior-changed false'));
        assert.ok(result.commands[0].command.includes('--changelog-updated false'));
        assert.ok(result.commands[0].command.includes('--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."'));
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
        preflight.metrics = { changed_lines_total: snapshot.changed_lines_total };
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

    it('reports DONE after completion gate passes', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.deepEqual(result.missing_artifacts, []);
        assert.ok(result.commands[0].command.includes('gate task-audit-summary'));
    });

    it('keeps completed tasks terminal when the workspace is clean after commit', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.detection_source = 'git_auto';
        preflight.changed_files = ['src/app.ts'];
        preflight.metrics = {
            changed_lines_total: 10
        };
        writeJson(preflightPath, preflight);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'DONE');
        assert.equal(result.next_gate, null);
        assert.deepEqual(result.missing_artifacts, []);
        assert.ok(!formatNextStepText(result).includes('MissingArtifacts:'));
    });

    it('does not let an old completion pass hide a restarted task cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        seedCompletionPass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            restarted: true
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.notEqual(result.status, 'DONE');
        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.reason.includes('latest TASK_MODE_ENTERED'));
    });
});
