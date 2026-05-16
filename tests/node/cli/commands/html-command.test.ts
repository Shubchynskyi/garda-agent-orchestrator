import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { handleHtml } from '../../../../src/cli/commands/html-command';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator-test', version: '0.0.0-test' };

function makeTempRepo(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-html-command-test-'));
}

function writeRepo(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        '| T-100 | TODO | P2 | ui/report | Build HTML report | gpt-5.4 | 2026-05-16 | balanced | Uses logs only |'
    ].join('\n'));
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(buildDefaultWorkflowConfig(), null, 2));
}

async function captureOutput(action: () => unknown | Promise<unknown>): Promise<string> {
    const captured: string[] = [];
    const originalLog = console.log;
    try {
        process.env.NO_COLOR = '1';
        console.log = (...args: unknown[]): void => {
            captured.push(args.map((arg) => String(arg)).join(' '));
        };
        await action();
    } finally {
        console.log = originalLog;
        delete process.env.NO_COLOR;
    }
    return captured.join('\n');
}

test('handleHtml prints report path and file URL', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const outputPath = path.join(repoRoot, 'custom-report.html');

    const text = await captureOutput(() => handleHtml([
        '--target-root', repoRoot,
        '--output-path', outputPath
    ], PACKAGE_JSON));

    assert.ok(text.includes('GARDA_HTML_REPORT'));
    assert.ok(text.includes(`OutputPath: ${outputPath}`));
    assert.match(text, /Url: file:\/\//);
    assert.ok(fs.existsSync(outputPath));
});

test('handleHtml supports json output', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    const text = await captureOutput(() => handleHtml(['--target-root', repoRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(text) as { task_count: number; url: string };

    assert.equal(parsed.task_count, 1);
    assert.match(parsed.url, /^file:\/\//);
});

test('handleHtml accepts repo-root as target-root alias', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);

    const text = await captureOutput(() => handleHtml(['--repo-root', repoRoot, '--json'], PACKAGE_JSON));
    const parsed = JSON.parse(text) as { task_count: number; output_path: string };

    assert.equal(parsed.task_count, 1);
    assert.ok(parsed.output_path.startsWith(repoRoot));
});
