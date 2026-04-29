import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    collectManagedDiff,
    formatDiffManagedText,
    formatDiffManagedJson,
    resolveMarkers
} from '../../../../src/cli/commands/diff-managed';

import {
    MANAGED_START,
    MANAGED_END,
    COMMIT_GUARD_START,
    COMMIT_GUARD_END
} from '../../../../src/materialization/content-builders';

test('resolveMarkers returns HTML comment markers for markdown files', () => {
    const markers = resolveMarkers('CLAUDE.md');
    assert.equal(markers.startMarker, MANAGED_START);
    assert.equal(markers.endMarker, MANAGED_END);
});

test('resolveMarkers returns commit guard markers for pre-commit hook', () => {
    const markers = resolveMarkers('.git/hooks/pre-commit');
    assert.equal(markers.startMarker, COMMIT_GUARD_START);
    assert.equal(markers.endMarker, COMMIT_GUARD_END);
});

test('resolveMarkers normalizes backslash paths', () => {
    const markers = resolveMarkers('.git\\hooks\\pre-commit');
    assert.equal(markers.startMarker, COMMIT_GUARD_START);
    assert.equal(markers.endMarker, COMMIT_GUARD_END);
});

test('resolveMarkers returns HTML comment markers for gitignore', () => {
    const markers = resolveMarkers('.gitignore');
    assert.equal(markers.startMarker, MANAGED_START);
    assert.equal(markers.endMarker, MANAGED_END);
});

test('collectManagedDiff returns zero managed for an empty directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-empty-'));
    try {
        const result = collectManagedDiff(tmpDir);
        assert.ok(result.scannedFiles > 0, 'should scan candidate paths');
        assert.equal(result.filesWithManagedBlocks, 0);
        assert.equal(result.totalManagedLines, 0);
        assert.equal(result.totalUserLines, 0);
        assert.equal(result.filesMissing, result.scannedFiles);
        for (const entry of result.entries) {
            assert.equal(entry.exists, false);
            assert.equal(entry.hasManagedBlock, false);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectManagedDiff detects managed block in TASK.md', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-task-'));
    try {
        const taskContent = [
            MANAGED_START,
            '# TASK.md',
            '',
            'Single-file task queue.',
            MANAGED_END,
            ''
        ].join('\n');
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), taskContent, 'utf8');

        const result = collectManagedDiff(tmpDir);
        const taskEntry = result.entries.find((entry) => entry.relativePath === 'TASK.md');
        assert.ok(taskEntry, 'TASK.md entry should exist');
        assert.equal(taskEntry.exists, true);
        assert.equal(taskEntry.hasManagedBlock, true);
        assert.ok(taskEntry.managedLineCount > 0, 'should have managed lines');
        assert.equal(taskEntry.userLineCount, 0, 'no user content outside managed block');
        assert.equal(result.filesWithManagedBlocks, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectManagedDiff detects user content outside managed block', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-mixed-'));
    try {
        const content = [
            '# My Custom Content',
            '',
            MANAGED_START,
            '# CLAUDE.md',
            'Managed instructions here.',
            MANAGED_END,
            '',
            '## My Custom Section',
            'User-specific notes.'
        ].join('\n');
        fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content, 'utf8');

        const result = collectManagedDiff(tmpDir);
        const entry = result.entries.find((item) => item.relativePath === 'CLAUDE.md');
        assert.ok(entry, 'CLAUDE.md entry should exist');
        assert.equal(entry.exists, true);
        assert.equal(entry.hasManagedBlock, true);
        assert.ok(entry.managedLineCount > 0, 'should have managed lines');
        assert.ok(entry.userLineCount > 0, 'should have user lines');
        assert.equal(entry.regions.length, 3, 'should have user + managed + user regions');
        assert.equal(entry.regions[0].kind, 'user');
        assert.equal(entry.regions[1].kind, 'managed');
        assert.equal(entry.regions[2].kind, 'user');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectManagedDiff handles file without managed markers', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-plain-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), '# Just user content\nNo managed block.\n', 'utf8');

        const result = collectManagedDiff(tmpDir);
        const entry = result.entries.find((item) => item.relativePath === 'CLAUDE.md');
        assert.ok(entry, 'CLAUDE.md entry should exist');
        assert.equal(entry.exists, true);
        assert.equal(entry.hasManagedBlock, false);
        assert.equal(entry.managedLineCount, 0);
        assert.ok(entry.userLineCount > 0, 'should have user lines');
        assert.equal(entry.regions.length, 1);
        assert.equal(entry.regions[0].kind, 'user');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDiffManagedText produces expected header', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-fmt-'));
    try {
        const result = collectManagedDiff(tmpDir);
        const text = formatDiffManagedText(result);
        assert.ok(text.includes('GARDA_DIFF_MANAGED'), 'should contain header');
        assert.ok(text.includes('Target root:'), 'should contain target root label');
        assert.ok(text.includes('Scanned files:'), 'should contain scanned files label');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDiffManagedText shows managed/user-only status per file', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-fmt2-'));
    try {
        const content = `${MANAGED_START}\nManaged\n${MANAGED_END}\n`;
        fs.writeFileSync(path.join(tmpDir, 'TASK.md'), content, 'utf8');

        const result = collectManagedDiff(tmpDir);
        const text = formatDiffManagedText(result);
        assert.ok(text.includes('--- TASK.md [managed]'), 'should show managed status');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDiffManagedJson produces valid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-json-'));
    try {
        const result = collectManagedDiff(tmpDir);
        const json = formatDiffManagedJson(result);
        const parsed = JSON.parse(json);
        assert.equal(typeof parsed.scanned_files, 'number');
        assert.ok(Array.isArray(parsed.entries), 'entries should be an array');
        assert.equal(parsed.files_with_managed_blocks, 0);
        assert.equal(parsed.files_missing, parsed.scanned_files);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatDiffManagedJson includes region metadata', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-managed-json2-'));
    try {
        const content = `User stuff\n${MANAGED_START}\nManaged\n${MANAGED_END}\nMore user\n`;
        fs.writeFileSync(path.join(tmpDir, 'CLAUDE.md'), content, 'utf8');

        const result = collectManagedDiff(tmpDir);
        const parsed = JSON.parse(formatDiffManagedJson(result));
        const claudeEntry = parsed.entries.find((entry: { relative_path: string }) => entry.relative_path === 'CLAUDE.md');
        assert.ok(claudeEntry, 'CLAUDE.md entry should exist');
        assert.equal(claudeEntry.has_managed_block, true);
        assert.ok(Array.isArray(claudeEntry.regions));
        assert.equal(claudeEntry.regions.length, 3);
        assert.equal(claudeEntry.regions[0].kind, 'user');
        assert.equal(claudeEntry.regions[1].kind, 'managed');
        assert.equal(claudeEntry.regions[2].kind, 'user');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
