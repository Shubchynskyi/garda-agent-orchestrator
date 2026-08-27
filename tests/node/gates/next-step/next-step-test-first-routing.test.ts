import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { runIntermediateCommandCommand } from '../../../../src/cli/commands/gates';
import { appendTaskEventAsync } from '../../../../src/gate-runtime/task-events-io';
import { buildTestFirstExpectedFailureRoute } from '../../../../src/gates/next-step/next-step-test-first-routing';
import {
    getChangedTestPathsTargetedByCommandTokens,
    isFocusedIntermediateCommand
} from '../../../../src/gates/shared/focused-intermediate-command-grammar';
import {
    createTempRepo,
    getOrchestratorRoot,
    readTaskTimelineEvents,
    seedInitAnswers,
    seedTaskQueue
} from '../../cli/commands/gate-test-helpers';

const TASK_ID = 'T-TEST-FIRST';
const TEST_PATH = 'tests/node/gates/expected-red.test.ts';
let tempRoots: string[] = [];

interface Fixture {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    preflightPath: string;
    preflight: Record<string, unknown>;
    taskEntry: {
        taskId: string;
        status: string;
        area: string;
        title: string;
        profile: string;
        notes: string;
    };
}

function buildFixture(options: {
    declared?: boolean;
    scopeCategory?: string;
    changedFiles?: string[];
} = {}): Fixture {
    const repoRoot = createTempRepo();
    tempRoots.push(repoRoot);
    seedTaskQueue(repoRoot, TASK_ID);
    seedInitAnswers(repoRoot);
    const declared = options.declared !== false;
    const notes = declared ? 'Test-first: expected-red.' : 'Ordinary test-only task.';
    const taskPath = path.join(repoRoot, 'TASK.md');
    fs.writeFileSync(
        taskPath,
        fs.readFileSync(taskPath, 'utf8').replace('| fixture |', `| ${notes} |`),
        'utf8'
    );
    const testPath = path.join(repoRoot, TEST_PATH);
    const wrapperPath = path.join(repoRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    fs.mkdirSync(path.dirname(testPath), { recursive: true });
    fs.mkdirSync(path.dirname(wrapperPath), { recursive: true });
    fs.writeFileSync(testPath, 'export {};\n', 'utf8');
    fs.writeFileSync(wrapperPath, 'process.exitCode = 1;\n', 'utf8');
    const reviewsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'reviews');
    const eventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
    const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
    const preflight: Record<string, unknown> = {
        task_id: TASK_ID,
        scope_category: options.scopeCategory || 'test-only',
        changed_files: options.changedFiles || [TEST_PATH],
        metrics: {
            scope_content_sha256: 'a'.repeat(64)
        }
    };
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify(preflight, null, 2)}\n`, 'utf8');
    return {
        repoRoot,
        reviewsRoot,
        eventsRoot,
        preflightPath,
        preflight,
        taskEntry: {
            taskId: TASK_ID,
            status: 'IN_PROGRESS',
            area: 'workflow/test-first',
            title: 'Add behavior test-first',
            profile: 'balanced',
            notes
        }
    };
}

function resolveRoute(fixture: Fixture) {
    return buildTestFirstExpectedFailureRoute({
        ...fixture,
        taskId: TASK_ID,
        preflightCommandPath: `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`,
        cliPrefix: 'node bin/garda.js',
        workspaceReady: true,
        currentChangedFiles: fixture.preflight.changed_files as string[]
    });
}

afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

describe('next-step test-first expected-red routing', () => {
    it('prints one guarded expected-failure command before compile', () => {
        const fixture = buildFixture();

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.equal(route?.commands.length, 1);
        assert.match(route?.commands[0].command || '', /run-intermediate-command/u);
        assert.match(route?.commands[0].command || '', /--expect-failure/u);
        assert.match(route?.commands[0].command || '', /expected-red\.test\.ts/u);
        assert.match(route?.reason || '', /current scope is test-only/u);
    });

    it('prints a bounded Maven selector for a changed Java test-only scope', () => {
        const javaTestPath = 'service/src/test/java/com/example/ExpectedBehaviorTest.java';
        const fixture = buildFixture({ changedFiles: [javaTestPath] });
        fs.mkdirSync(path.join(fixture.repoRoot, 'service', 'src', 'test', 'java', 'com', 'example'), {
            recursive: true
        });
        fs.writeFileSync(path.join(fixture.repoRoot, javaTestPath), 'class ExpectedBehaviorTest {}\n', 'utf8');
        fs.writeFileSync(path.join(fixture.repoRoot, 'pom.xml'), '<project/>\n', 'utf8');

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.equal(route?.commands.length, 1);
        assert.match(route?.commands[0].command || '', /mvn -q -Dtest=com\.example\.ExpectedBehaviorTest test/u);
        assert.match(route?.commands[0].command || '', /--expect-failure/u);
    });

    it('authenticates bounded focused targets for every supported project runner family', () => {
        const cases: Array<{ path: string; tokens: string[] }> = [
            { path: 'tests/test_auth.py', tokens: ['pytest', 'tests/test_auth.py'] },
            {
                path: 'service/src/test/java/com/example/AuthTest.java',
                tokens: ['mvn', '-q', '-Dtest=com.example.AuthTest', 'test']
            },
            {
                path: 'service/src/test/kotlin/com/example/AuthSpec.kt',
                tokens: ['gradle', 'test', '--tests', 'com.example.AuthSpec', '--console=plain']
            },
            { path: 'internal/auth/auth_test.go', tokens: ['go', 'test', './internal/auth'] },
            { path: 'tests/auth_flow.rs', tokens: ['cargo', 'test', '--test', 'auth_flow'] },
            {
                path: 'tests/AuthServiceTests.cs',
                tokens: ['dotnet', 'test', '--filter', 'FullyQualifiedName~AuthServiceTests', '--verbosity', 'quiet']
            },
            { path: 'spec/auth_service_spec.rb', tokens: ['bundle', 'exec', 'rspec', 'spec/auth_service_spec.rb'] },
            { path: 'tests/AuthServiceTest.php', tokens: ['phpunit', 'tests/AuthServiceTest.php'] }
        ];

        for (const candidate of cases) {
            assert.equal(
                isFocusedIntermediateCommand('targeted-test', candidate.tokens),
                true,
                candidate.path
            );
            assert.deepEqual(
                getChangedTestPathsTargetedByCommandTokens(candidate.tokens, [candidate.path]),
                [candidate.path],
                candidate.path
            );
        }
    });

    it('routes authenticated bounded expected-red evidence to implementation', async () => {
        const fixture = buildFixture();
        await appendTaskEventAsync(
            getOrchestratorRoot(fixture.repoRoot),
            TASK_ID,
            'TASK_MODE_ENTERED',
            'PASS',
            'Task mode entered.',
            {}
        );
        const runResult = await runIntermediateCommandCommand({
            repoRoot: fixture.repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`,
            preflightPath: fixture.preflightPath,
            expectFailure: true
        });
        assert.equal(runResult.exitCode, 0);

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'implementation');
        assert.deepEqual(route?.commands, []);
        assert.match(route?.reason || '', /authenticated against the exact test-only preflight/u);
    });

    it('rejects modified output evidence and asks to record expected-red again', async () => {
        const fixture = buildFixture();
        await appendTaskEventAsync(
            getOrchestratorRoot(fixture.repoRoot),
            TASK_ID,
            'TASK_MODE_ENTERED',
            'PASS',
            'Task mode entered.',
            {}
        );
        await runIntermediateCommandCommand({
            repoRoot: fixture.repoRoot,
            taskId: TASK_ID,
            commandSource: 'targeted-test',
            command: `node scripts/node-foundation/build-scripts.cjs test.js ${TEST_PATH}`,
            preflightPath: fixture.preflightPath,
            expectFailure: true
        });
        const event = readTaskTimelineEvents(fixture.repoRoot, TASK_ID)
            .find((candidate) => candidate.event_type === 'TEST_FIRST_EXPECTED_FAILURE_RECORDED');
        assert.ok(event);
        fs.appendFileSync(String((event.details as Record<string, unknown>).output_artifact_path), 'tampered\n', 'utf8');

        const route = resolveRoute(fixture);

        assert.equal(route?.nextGate, 'test-first-expected-failure');
        assert.equal(route?.commands.length, 1);
    });

    it('keeps undeclared and non-test-only scopes on the ordinary fail-closed path', () => {
        const undeclared = buildFixture({ declared: false });
        const mixed = buildFixture({ scopeCategory: 'mixed', changedFiles: [TEST_PATH, 'src/app.ts'] });

        assert.equal(resolveRoute(undeclared), null);
        assert.equal(resolveRoute(mixed), null);
    });

    it('does not reuse expected-red routing after the current workspace scope changes', () => {
        const fixture = buildFixture();
        const route = buildTestFirstExpectedFailureRoute({
            ...fixture,
            taskId: TASK_ID,
            preflightCommandPath: `garda-agent-orchestrator/runtime/reviews/${TASK_ID}-preflight.json`,
            cliPrefix: 'node bin/garda.js',
            workspaceReady: false,
            currentChangedFiles: [TEST_PATH, 'src/app.ts']
        });

        assert.equal(route, null);
    });
});
