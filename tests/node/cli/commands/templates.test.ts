import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleTemplates } from '../../../../src/cli/commands/templates-command';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function findRepoRoot(): string {
    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (fs.existsSync(path.join(current, 'template')) && fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error('Cannot resolve repo root.');
}

function makeBundleRoot(): string {
    const repoRoot = findRepoRoot();
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cli-templates-'));
    fs.mkdirSync(path.join(bundleRoot, 'template'), { recursive: true });
    fs.cpSync(path.join(repoRoot, 'template', 'templates'), path.join(bundleRoot, 'template', 'templates'), { recursive: true });
    return bundleRoot;
}

function captureConsole<T>(run: () => T): { result: T; output: string } {
    const originalConsoleLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => {
        lines.push(items.join(' '));
    };
    try {
        return {
            result: run(),
            output: lines.join('\n')
        };
    } finally {
        console.log = originalConsoleLog;
    }
}

test('templates list and show surface effective template output', () => {
    const bundleRoot = makeBundleRoot();
    try {
        const list = captureConsole(() => handleTemplates(['list', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(list.result && list.result.action === 'list');
        assert.match(list.output, /GARDA_TEMPLATES/);
        assert.match(list.output, /Template: final-report/);
        assert.match(list.output, /validation=PASS/);

        const show = captureConsole(() => handleTemplates([
            'show',
            '--bundle-root', bundleRoot,
            '--template', 'final-report'
        ], PACKAGE_JSON));
        assert.ok(show.result && show.result.action === 'show');
        assert.match(show.output, /Action: show/);
        assert.match(show.output, /--- effective template ---/);
        assert.match(show.output, /Review integrity: \{\{REVIEW_INTEGRITY\}\}/);
        assert.match(show.output, /Fake\/fallback\/same-agent review artifacts/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('templates edit creates a user-owned override and path reports it', () => {
    const bundleRoot = makeBundleRoot();
    try {
        const edit = captureConsole(() => handleTemplates([
            'edit',
            '--bundle-root', bundleRoot,
            '--template', 'commit-message'
        ], PACKAGE_JSON));
        assert.ok(edit.result && edit.result.action === 'edit');
        assert.equal(edit.result.created, true);
        assert.equal(fs.existsSync(edit.result.user_override_path), true);
        assert.match(edit.output, /NextAction: edit the user override file, then run templates validate/);

        const pathOutput = captureConsole(() => handleTemplates([
            'path',
            '--bundle-root', bundleRoot,
            '--template', 'commit-message'
        ], PACKAGE_JSON)).output;
        assert.match(pathOutput, /UserOverrideExists: true/);
        assert.match(pathOutput, /commit-message\.user\.json/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('templates validate fails closed for missing required placeholders', () => {
    const bundleRoot = makeBundleRoot();
    try {
        captureConsole(() => handleTemplates(['edit', '--bundle-root', bundleRoot, '--template', 'commit-message', '--json'], PACKAGE_JSON));
        fs.writeFileSync(
            path.join(bundleRoot, 'live', 'templates', 'commit-message.user.json'),
            JSON.stringify({ template: '{{TYPE}}: no summary' }, null, 2) + '\n',
            'utf8'
        );

        const { result, output } = captureConsole(() => handleTemplates([
            'validate',
            '--bundle-root', bundleRoot,
            '--template', 'commit-message'
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'validate');
        assert.equal(result.passed, false);
        assert.match(output, /Status: FAIL/);
        assert.match(output, /required_placeholder_missing/);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('templates reset removes the user override and restores built-in validation', () => {
    const bundleRoot = makeBundleRoot();
    try {
        captureConsole(() => handleTemplates(['edit', '--bundle-root', bundleRoot, '--template', 'final-report', '--json'], PACKAGE_JSON));
        const reset = captureConsole(() => handleTemplates([
            'reset',
            '--bundle-root', bundleRoot,
            '--template', 'final-report'
        ], PACKAGE_JSON));
        assert.ok(reset.result && reset.result.action === 'reset');
        assert.equal(reset.result.removed, true);
        assert.match(reset.output, /Removed: true/);

        const validate = captureConsole(() => handleTemplates([
            'validate',
            '--bundle-root', bundleRoot,
            '--template', 'final-report'
        ], PACKAGE_JSON));
        assert.ok(validate.result && validate.result.action === 'validate');
        assert.equal(validate.result.passed, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
