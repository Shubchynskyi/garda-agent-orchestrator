import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    startLocalUiServer
} from '../../../src/reports/ui';
import {
    cleanupLocalUiTestResources,
    makeLocalUiTempRepo,
    writeLocalUiRepoFixture
} from './local-ui-test-helpers';

function extractActionToken(html: string): string {
    const match = html.match(/const actionToken = "([^"]+)";/u);
    assert.ok(match, 'expected inline action token');
    return match[1];
}

const makeTempRepo = makeLocalUiTempRepo;
const writeRepo = writeLocalUiRepoFixture;

test('local UI server serves read-only dashboard controls', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const response = await fetch(server.url);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') || '', /^text\/html\b/u);
        const html = await response.text();
        assert.match(html, /data-tab="tasks-tab"/u);
        assert.match(html, /data-tab="backups-tab"/u);
        assert.match(html, /id="backups-tab"/u);
        assert.match(html, /id="backups-table"/u);
        assert.match(html, /id="backups-settings"/u);
        assert.match(html, /Workflow Config/u);
        assert.match(html, /Backups/u);
        assert.match(html, /Instructions/u);
        assert.match(html, /data-tab="actions-tab"/u);
        assert.match(html, /class="language-icon"/u);
        assert.match(html, /id="language-select"[^>]*data-i18n-aria-label="languageTitle"/u);
        assert.match(html, /visually-hidden[^>]*data-i18n="languageTitle"/u);
        assert.match(html, /id="task-search"/u);
        assert.match(html, /id="status-filter"/u);
        assert.match(html, /id="priority-filter"/u);
        assert.match(html, /id="action-status"/u);
        assert.match(html, /id="settings-editor"/u);
        assert.match(html, /id="session-summary"/u);
        assert.match(html, /id="top-controls"/u);
        assert.match(html, /id="session-countdown"/u);
        assert.match(html, /api\/session/u);
        assert.match(html, /\.tab-buttons \{[^}]*flex-wrap: wrap/u);
        assert.match(html, /\.tab-buttons button\.active \{[^}]*background: var\(--ok\)/u);
        assert.match(html, /\.language-compact \.visually-hidden \{[^}]*position: absolute/u);
        assert.match(html, /\.session-action-row \{[^}]*display: grid/u);
        assert.match(html, /\.tab-buttons button \{[^}]*white-space: nowrap/u);
        assert.match(html, /\.session-compact \{[^}]*flex-direction: column/u);
        assert.match(html, /\.session-status-line/u);
        assert.match(html, /\.setting-buttons button, \.action-buttons button, \.switch-buttons button, #tasks button\[data-task-id\] \{[^}]*width: 138px/u);
        assert.match(html, /Gate Timeline/u);
        assert.match(html, /Artifacts/u);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI ordinary document controls validate and update one path at a time', async () => {
    const repoRoot = makeTempRepo();
    writeRepo(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs', 'plan.md'), '# Plan\n', 'utf8');
    const server = await startLocalUiServer({ repoRoot, port: 0, actionsEnabled: true });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const headers = {
            'content-type': 'application/json',
            'origin': server.url.slice(0, -1),
            'x-garda-action-token': actionToken
        };
        const previewResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'preview', path: 'docs/plan.md' })
        });
        assert.equal(previewResponse.status, 200);
        const preview = await previewResponse.json() as { status: string; proposed_paths: string[]; confirmation_phrase: string };
        assert.equal(preview.status, 'previewed');
        assert.deepEqual(preview.proposed_paths, ['CHANGELOG.md', 'docs/plan.md']);
        assert.equal(preview.confirmation_phrase, 'APPLY ORDINARY DOCS');

        const blockedResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'execute', path: 'docs/plan.md', confirmation: 'wrong' })
        });
        assert.equal(blockedResponse.status, 409);
        assert.equal((await blockedResponse.json() as { status: string }).status, 'confirmation_required');

        const executeResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'execute', path: 'docs/plan.md', confirmation: 'APPLY ORDINARY DOCS' })
        });
        assert.equal(executeResponse.status, 200);
        assert.equal((await executeResponse.json() as { status: string }).status, 'executed');
        const pathsConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
        assert.deepEqual(JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')).ordinary_doc_paths, ['CHANGELOG.md', 'docs/plan.md']);

        const missingResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'add', mode: 'preview', path: 'docs/missing.md' })
        });
        assert.equal(missingResponse.status, 400);

        const removeResponse = await fetch(`${server.url}api/ordinary-docs`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ operation: 'remove', mode: 'execute', path: 'docs/plan.md', confirmation: 'APPLY ORDINARY DOCS' })
        });
        assert.equal(removeResponse.status, 200);
        assert.deepEqual(JSON.parse(fs.readFileSync(pathsConfigPath, 'utf8')).ordinary_doc_paths, ['CHANGELOG.md']);
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
    }
});

test('local UI file viewer opens only repository-relative files', async () => {
    const repoRoot = makeTempRepo();
    const outsideRoot = `${repoRoot}-outside`;
    writeRepo(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, 'secret.md'), '# Secret\n', 'utf8');
    const server = await startLocalUiServer({ repoRoot, port: 0 });
    try {
        const actionToken = extractActionToken(await (await fetch(server.url)).text());
        const fileUrl = (filePath: string, token = actionToken): string => {
            return `${server.url}files?path=${encodeURIComponent(filePath)}&action_token=${encodeURIComponent(token)}`;
        };
        const fileHeaders = { referer: server.url };
        const ok = await fetch(fileUrl('AGENTS.md'), { headers: fileHeaders });
        assert.equal(ok.status, 200);
        assert.match(await ok.text(), /Agent instructions/u);

        const missingToken = await fetch(`${server.url}files?path=AGENTS.md`, { headers: fileHeaders });
        assert.equal(missingToken.status, 403);

        const badReferer = await fetch(fileUrl('AGENTS.md'), { headers: { referer: 'http://attacker.example/' } });
        assert.equal(badReferer.status, 403);

        const rejected = await fetch(fileUrl('../AGENTS.md'), { headers: fileHeaders });
        assert.equal(rejected.status, 404);

        if (tryCreateSymlink(path.join(outsideRoot, 'secret.md'), path.join(repoRoot, 'docs', 'outside-file.md'), 'file')) {
            const symlinkFile = await fetch(fileUrl('docs/outside-file.md'), { headers: fileHeaders });
            assert.equal(symlinkFile.status, 404);
        }

        if (tryCreateSymlink(outsideRoot, path.join(repoRoot, 'docs', 'outside-dir'), process.platform === 'win32' ? 'junction' : 'dir')) {
            const symlinkDirFile = await fetch(fileUrl('docs/outside-dir/secret.md'), { headers: fileHeaders });
            assert.equal(symlinkDirFile.status, 404);
        }
    } finally {
        await cleanupLocalUiTestResources({ repoRoot, server });
        fs.rmSync(outsideRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
});

function tryCreateSymlink(target: string, linkPath: string, type: fs.symlink.Type): boolean {
    try {
        fs.symlinkSync(target, linkPath, type);
        return true;
    } catch (error: unknown) {
        if (error instanceof Error
            && 'code' in error
            && ['EACCES', 'EPERM', 'ENOTSUP', 'EINVAL'].includes(String((error as NodeJS.ErrnoException).code))) {
            return false;
        }
        throw error;
    }
}
