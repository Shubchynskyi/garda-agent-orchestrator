import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { syncTaskQueueStatus } from '../../../../src/cli/commands/gate-flows/task-queue-sync';
import {
    handleEnterTaskMode
} from '../../../../src/cli/commands/gate-task-handlers';
import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import {
    EXIT_GATE_FAILURE
} from '../../../../src/cli/exit-codes';
import {
    appendPreflightClassifiedEvent
} from './gate-test-seed-helpers';
import {
    runCliMain
} from '../../../../src/cli/main';
import * as childProcess from 'node:child_process';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function captureExpectedError(callback: () => void): Error {
    try {
        callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

async function captureExpectedAsyncError(callback: () => Promise<void>): Promise<Error> {
    try {
        await callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
    if (String(options.provider || '').trim() || String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
        if (!sourceOfTruth || !routedTo) {
            return options;
        }
        return {
            ...options,
            provider: sourceOfTruth,
            routedTo
        };
    } catch {
        return options;
    }
}

function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    return runEnterTaskModeCommand(withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    }));
}

function createTempRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-gates-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    return root;
}

function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ];
    for (const ruleFile of ruleFiles) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
}

function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i;
    const taskPath = path.join(repoRoot, 'TASK.md');
    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed.split('|').map((cell) => cell.trim()).filter(Boolean);
        if (cells.length < 2 || cells[0] !== taskId) {
            continue;
        }
        const statusMatch = statusPattern.exec(cells[1]);
        return statusMatch ? statusMatch[1].toUpperCase() : null;
    }
    return null;
}

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
}

function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function initializeGitRepo(repoRoot: string): void {
    const runGit = (args: string[]) => {
        const result = childProcess.spawnSync('git', args, {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8'
        });
        if (result.error) {
            throw result.error;
        }
        assert.equal(
            result.status,
            0,
            `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`
        );
    };
    runGit(['init']);
    runGit(['config', 'user.name', 'Garda Tests']);
    runGit(['config', 'user.email', 'garda-tests@example.com']);
    runGit(['add', '.']);
    runGit(['commit', '-m', 'test: baseline']);
}

describe('cli/commands/gates — task-start', () => {
    it('fails enter-task-mode early when planned scope includes protected orchestrator files without orchestrator-work', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handoff';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require explicit orchestrator-work handoff for protected planned scope',
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: \\.github/agents/orchestrator\\.md\\.` +
                `.*Suggested command: node garda-agent-orchestrator/bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'`,
                'i'
            )
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses the source-checkout CLI prefix in the orchestrator-work handoff command', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-source-checkout';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require explicit orchestrator-work handoff for source-checkout protected scope',
                plannedChangedFiles: ['src/cli/main.ts']
            }));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: src/cli/main\\.ts\\.` +
                `.*Suggested command: node bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file 'src/cli/main\\.ts'`,
                'i'
            )
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('requires an explicit repo-owned start banner for a fresh main-agent task run', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900fresh-start-banner-required';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const error = captureExpectedError(() => runEnterTaskModeCommand(withDefaultTaskModeRouting({
            repoRoot,
            taskId,
            taskSummary: 'Reject a fresh main-agent task run that omits the explicit start banner'
        })));
        assert.match(error.message, /StartBanner is required for a fresh main-agent task run/i);
        assert.match(error.message, /--start-banner "<repo-owned-banner>"/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runs enter-task-mode through CLI main and merges mixed planned scope hints', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-cli-main-smoke';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalStdoutWrite = process.stdout.write;
        const capturedStdout: string[] = [];
        process.exitCode = 0;
        process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
            capturedStdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'));
            if (typeof encoding === 'function') {
                encoding();
            } else if (typeof callback === 'function') {
                callback();
            }
            return true;
        }) as typeof process.stdout.write;

        try {
            process.chdir(repoRoot);
            await runCliMain([
                'gate',
                'enter-task-mode',
                '--repo-root', repoRoot,
                '--task-id', taskId,
                '--task-summary', 'Exercise the full CLI main path for mixed planned scope hints',
                '--start-banner', 'Garda captures my mind',
                '--provider', 'Codex',
                '--routed-to', 'AGENTS.md',
                '--planned-changed-file', 'src/app.ts',
                '--planned-changed-files', 'src/feature.ts,src/app.ts'
            ]);
        } finally {
            process.stdout.write = originalStdoutWrite;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const output = capturedStdout.join('');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(timelinePath), true);
        assert.match(output, /TASK_MODE_ENTERED/);
        assert.match(output, /PlannedChangedFilesCount: 2/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('parses --planned-changed-files through handleEnterTaskMode before emitting the orchestrator-work handoff', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-alias';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Require explicit orchestrator-work handoff through the CLI alias path',
            '--start-banner', 'Garda captures my mind',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-files', '.github/agents/orchestrator.md'
        ]));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: \\.github/agents/orchestrator\\.md\\.` +
                `.*Suggested command: node garda-agent-orchestrator/bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'`,
                'i'
            )
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('deduplicates mixed planned scope hints before emitting the orchestrator-work handoff', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-merged-aliases';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Deduplicate mixed planned scope aliases before suggesting orchestrator-work handoff',
            '--start-banner', 'Garda captures my mind',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-file', '.github/agents/orchestrator.md',
            '--planned-changed-files', 'src/app.ts,.github/agents/orchestrator.md',
            '--planned-changed-file', 'src/app.ts'
        ]));
        assert.match(
            error.message,
            new RegExp(
                `Suggested command: node garda-agent-orchestrator/bin/garda\\.js gate enter-task-mode` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'` +
                `.*--planned-changed-file 'src/app\\.ts'`,
                'i'
            )
        );
        assert.equal((error.message.match(/--planned-changed-file /g) || []).length, 2);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects invalid planned-changed-files lists that escape the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-invalid-list';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Reject planned changed files that escape repo root',
            '--start-banner', 'Garda captures my mind',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-files', 'src/app.ts,../outside.ts'
        ]));
        assert.match(error.message, /PlannedChangedFile must stay inside repo root/);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows enter-task-mode when protected planned scope is declared with orchestrator-work', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-allowed';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow explicit orchestrator-work handoff for protected planned scope',
            orchestratorWork: true,
            plannedChangedFiles: ['.github/agents/orchestrator.md']
        });
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.includes('PlannedChangedFilesCount: 1'));
        assert.ok(result.outputLines.includes('PlannedProtectedFilesCount: 1'));
        assert.equal(artifact.orchestrator_work, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('captures a dirty workspace baseline when entering task mode', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-baseline';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 13;\nconst b = 21;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = true;\n', 'utf8');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Capture dirty workspace baseline'
        });
        assert.equal(result.exitCode, 0);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.deepEqual(
            artifact.dirty_workspace_baseline.changed_files,
            ['src/app.ts', 'src/unrelated.ts']
        );
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['src/app.ts'], 'string');
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['src/unrelated.ts'], 'string');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('loads rule-pack evidence and writes artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        const result = loadTaskEntryRulePack(repoRoot, taskId);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOADED');
        assert.equal(artifact.event_source, 'load-rule-pack');
        assert.equal(artifact.stages.task_entry.status, 'PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails preflight classification when rule-pack evidence is missing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900b';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Update app flow',
                emitMetrics: false
            }),
            /Rule-pack evidence missing/
        );

        const eventTypes = readTaskTimelineEvents(repoRoot, taskId).map((event) => event.event_type);
        assert.ok(eventTypes.includes('PREFLIGHT_STARTED'));
        assert.ok(eventTypes.includes('PREFLIGHT_FAILED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('auto-emits plan, status, and routing events when entering task mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        assert.equal(result.exitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const eventTypes = events.map((event) => event.event_type);
        assert.deepEqual(eventTypes, [
            'TASK_MODE_ENTERED',
            'PLAN_CREATED',
            'STATUS_CHANGED',
            'PROVIDER_ROUTING_DECISION'
        ]);
        const statusDetails = events[2].details as Record<string, unknown>;
        const routingDetails = events[3].details as Record<string, unknown>;
        assert.equal(statusDetails.previous_status, 'TODO');
        assert.equal(statusDetails.new_status, 'IN_PROGRESS');
        assert.equal(routingDetails.provider, 'Qwen');
        assert.equal(routingDetails.routed_to, 'QWEN.md');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-900c\s*\|\s*🟨 IN_PROGRESS\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('syncTaskQueueStatus keeps plain TASK.md rows plain across lifecycle states', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-plain';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_PROGRESS'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        let taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*IN_PROGRESS\s*\|/);
        assert.equal(taskFile.includes('🟨 IN_PROGRESS'), false);

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_REVIEW'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*IN_REVIEW\s*\|/);
        assert.equal(taskFile.includes('🟧 IN_REVIEW'), false);

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'DONE'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*DONE\s*\|/);
        assert.equal(taskFile.includes('🟩 DONE'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('syncTaskQueueStatus preserves escaped pipes in TASK.md notes cells', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-escaped-notes';
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
            `| ${taskId} | TODO | P1 | test | Update app flow | unassigned | 2026-03-28 | default | before \\| blocked_reason_code=ESCAPED_PIPE |`
        ].join('\n'), 'utf8');

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_PROGRESS'), true);

        const taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-escaped-notes\s*\|\s*IN_PROGRESS\s*\|/);
        assert.ok(taskFile.includes('before \\| blocked_reason_code=ESCAPED_PIPE'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses explicit provider override for task-mode routing evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-provider';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });

        assert.equal(result.exitCode, 0);
        const taskModeArtifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
        const routingDetails = (readTaskTimelineEvents(repoRoot, taskId).at(-1)?.details || {}) as Record<string, unknown>;
        assert.equal(taskModeArtifact.provider, 'Codex');
        assert.equal(taskModeArtifact.routed_to, 'AGENTS.md');
        assert.equal(routingDetails.provider, 'Codex');
        assert.equal(routingDetails.routed_to, 'AGENTS.md');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects legacy fallback and does not reuse stale task-mode routing evidence on a new task-mode entry', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-stale-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, JSON.stringify({
            schema_version: 1,
            timestamp_utc: '2026-04-17T08:00:00.000Z',
            event_source: 'enter-task-mode',
            status: 'PASS',
            outcome: 'PASS',
            task_id: taskId,
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'stale runtime identity',
            provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved',
            routed_to: 'QWEN.md'
        }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Refresh runtime identity without trusting stale task-mode evidence'
        }));

        assert.match(error.message, /Runtime execution identity is 'legacy_fallback' at task-mode entry/i);
        assert.doesNotMatch(error.message, /--provider\s+['"]?Codex['"]?/i);
        assert.match(error.message, /--provider <runtime-provider>|--routed-to/i);
        const staleArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(staleArtifact.provider, 'Qwen');
        assert.equal(staleArtifact.routed_to, 'QWEN.md');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when explicit runtime identity is contradictory', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-contradictory-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject contradictory runtime identity at task-mode entry',
            provider: 'Codex',
            routedTo: 'QWEN.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /contradicts routed path 'QWEN\.md'/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.doesNotMatch(error.message, /--routed-to ['"]?QWEN\.md['"]?/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when an explicit provider override is unrecognized even if routed identity resolves', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-invalid-provider-override';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject malformed explicit provider override at task-mode entry',
            provider: 'NotAProvider',
            routedTo: 'AGENTS.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /provider override 'NotAProvider' is not recognized/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when an explicit routed-to override is unrecognized even if provider resolves', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-invalid-route-override';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject malformed explicit routed-to override at task-mode entry',
            provider: 'Codex',
            routedTo: 'NOT-A-REAL-ROUTE.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /route override 'NOT-A-REAL-ROUTE\.md' is not a recognized provider bridge or canonical entrypoint/i);
        assert.match(error.message, /--provider ['"]?Codex['"]?/i);
        assert.doesNotMatch(error.message, /--routed-to ['"]?NOT-A-REAL-ROUTE\.md['"]?/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when runtime identity is missing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject missing runtime identity at task-mode entry'
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.match(error.message, /setup\/reinit/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when canonical SourceOfTruth is missing even with explicit runtime identity', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-canonical-owner';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject task start when canonical owner files are missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rolls back task-mode artifact when TASK_MODE_ENTERED append fails', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900lock';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Update app flow'
            }),
            /TASK_MODE_ENTERED/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails task-mode entry when the review artifact path is already locked', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900artifact-lock';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
        const lockPath = `${artifactPath}.lock`;
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Update app flow'
            }),
            /Timed out acquiring file lock/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prints remediation command on POST_PREFLIGHT failure with missing rule files', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900post-preflight-remediation';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({ repoRoot, taskId, taskSummary: 'Test POST_PREFLIGHT remediation output' });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: taskId,
            detection_source: 'explicit_changed_files',
            mode: 'FULL_PATH',
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true, db: false, security: false, refactor: false,
                api: false, test: false, performance: false, infra: false, dependency: false
            },
            triggers: {},
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);

        // Deliberately omit code-review-required files (35-strict-coding-rules.md, 50-structure-and-docs.md, 70-security.md)
        const result = runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'POST_PREFLIGHT',
            preflightPath,
            loadedRuleFiles: ['00-core.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'],
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        const remediationIdx = result.outputLines.indexOf('Remediation:');
        assert.notEqual(remediationIdx, -1, 'Expected a Remediation: line in the output');
        const remediationCommand = result.outputLines[remediationIdx + 1] ?? '';
        assert.match(remediationCommand, /gate load-rule-pack/);
        assert.match(remediationCommand, /--repo-root/);
        assert.match(remediationCommand, new RegExp(`--task-id.*${taskId}`));
        assert.match(remediationCommand, /--stage.*POST_PREFLIGHT/);
        assert.match(remediationCommand, /--preflight-path/);
        // 7 required files total: Set union of 4 entry files and 5 code-review-depth-2 files
        // (2 overlap: 00-core.md, 80-task-workflow.md), net result = 7 unique files
        const loadedRuleFileMatches = remediationCommand.match(/--loaded-rule-file/g);
        assert.equal(loadedRuleFileMatches?.length ?? 0, 7, 'Expected 7 --loaded-rule-file flags (union of entry + code-review-specific sets)');
        // The 3 files that were deliberately omitted must appear in the remediation command
        assert.match(remediationCommand, /35-strict-coding-rules\.md/);
        assert.match(remediationCommand, /50-structure-and-docs\.md/);
        assert.match(remediationCommand, /70-security\.md/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
