import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    parseManifestItems,
    validateManifest,
    validateManifestEntry,
    normalizeManifestEntry,
    checkEntryOutsideRoot,
    formatManifestResult,
    formatManifestResultCompact,
    type ManifestEntryDiagnostic,
    type ManifestDiagnosticCode
} from '../../../src/validators/validate-manifest';

/* ------------------------------------------------------------------ */
/*  Helper                                                            */
/* ------------------------------------------------------------------ */

function writeTempManifest(entries: string[]): { tmpDir: string; manifestPath: string } {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, entries.map(e => `- ${e}`).join('\n') + '\n', 'utf8');
    return { tmpDir, manifestPath };
}

function hasDiagCode(diags: ManifestEntryDiagnostic[], code: ManifestDiagnosticCode): boolean {
    return diags.some(d => d.code === code);
}

/* ------------------------------------------------------------------ */
/*  parseManifestItems (unchanged)                                    */
/* ------------------------------------------------------------------ */

test('parseManifestItems extracts list items from markdown', () => {
    const content = [
        '# MANIFEST',
        '',
        '- bin/garda.js',
        '- src/index.ts',
        '  - src/validators/verify.ts',
        'Not a list item',
        '- package.json',
        ''
    ].join('\n');

    const items = parseManifestItems(content);
    assert.deepEqual(items, [
        'bin/garda.js',
        'src/index.ts',
        'src/validators/verify.ts',
        'package.json'
    ]);
});

test('parseManifestItems returns empty array for no list items', () => {
    const items = parseManifestItems('# MANIFEST\n\nNo items here.\n');
    assert.deepEqual(items, []);
});

/* ------------------------------------------------------------------ */
/*  normalizeManifestEntry                                            */
/* ------------------------------------------------------------------ */

test('normalizeManifestEntry lowercases and unifies separators', () => {
    assert.equal(normalizeManifestEntry('Src\\Index.ts'), 'src/index.ts');
});

test('normalizeManifestEntry collapses repeated slashes', () => {
    assert.equal(normalizeManifestEntry('a///b//c'), 'a/b/c');
});

test('normalizeManifestEntry strips dot segments', () => {
    assert.equal(normalizeManifestEntry('a/./b/./c'), 'a/b/c');
});

test('normalizeManifestEntry strips trailing separator', () => {
    assert.equal(normalizeManifestEntry('a/b/c/'), 'a/b/c');
});

test('normalizeManifestEntry produces identical keys for equivalent paths', () => {
    const a = normalizeManifestEntry('src\\validators\\./verify.ts');
    const b = normalizeManifestEntry('src/validators/verify.ts');
    assert.equal(a, b);
});

/* ------------------------------------------------------------------ */
/*  validateManifestEntry — individual entry checks                   */
/* ------------------------------------------------------------------ */

test('validateManifestEntry clean entry produces no diagnostics', () => {
    const diags = validateManifestEntry('src/validators/verify.ts');
    assert.equal(diags.length, 0);
});

test('validateManifestEntry detects NUL byte', () => {
    const diags = validateManifestEntry('src/index\0.ts');
    assert.ok(hasDiagCode(diags, 'NUL_BYTE'));
});

test('validateManifestEntry detects absolute path (forward slash)', () => {
    const diags = validateManifestEntry('/etc/passwd');
    assert.ok(hasDiagCode(diags, 'ABSOLUTE_PATH'));
});

test('validateManifestEntry detects absolute path (backslash)', () => {
    const diags = validateManifestEntry('\\Windows\\System32');
    assert.ok(hasDiagCode(diags, 'ABSOLUTE_PATH'));
});

test('validateManifestEntry detects drive letter prefix', () => {
    const diags = validateManifestEntry('C:\\Users\\file.txt');
    assert.ok(hasDiagCode(diags, 'DRIVE_LETTER'));
});

test('validateManifestEntry detects UNC path (backslash)', () => {
    const diags = validateManifestEntry('\\\\server\\share\\file');
    assert.ok(hasDiagCode(diags, 'UNC_PATH'));
});

test('validateManifestEntry detects UNC path (forward slash)', () => {
    const diags = validateManifestEntry('//server/share/file');
    assert.ok(hasDiagCode(diags, 'UNC_PATH'));
});

test('validateManifestEntry detects parent traversal', () => {
    const diags = validateManifestEntry('src/../../../etc/passwd');
    assert.ok(hasDiagCode(diags, 'PARENT_TRAVERSAL'));
});

test('validateManifestEntry detects dot segment', () => {
    const diags = validateManifestEntry('src/./validators/verify.ts');
    assert.ok(hasDiagCode(diags, 'DOT_SEGMENT'));
});

test('validateManifestEntry detects mixed separators', () => {
    const diags = validateManifestEntry('src/validators\\verify.ts');
    assert.ok(hasDiagCode(diags, 'MIXED_SEPARATORS'));
});

test('validateManifestEntry detects reserved name CON', () => {
    const diags = validateManifestEntry('src/CON/file.txt');
    assert.ok(hasDiagCode(diags, 'RESERVED_SEGMENT'));
});

test('validateManifestEntry detects reserved name NUL', () => {
    const diags = validateManifestEntry('NUL.txt');
    assert.ok(hasDiagCode(diags, 'RESERVED_SEGMENT'));
});

test('validateManifestEntry detects reserved name COM1', () => {
    const diags = validateManifestEntry('data/com1.log');
    assert.ok(hasDiagCode(diags, 'RESERVED_SEGMENT'));
});

test('validateManifestEntry detects reserved name LPT1', () => {
    const diags = validateManifestEntry('lpt1');
    assert.ok(hasDiagCode(diags, 'RESERVED_SEGMENT'));
});

test('validateManifestEntry does not flag non-reserved similar names', () => {
    const diags = validateManifestEntry('console/data.txt');
    assert.ok(!hasDiagCode(diags, 'RESERVED_SEGMENT'));
});

test('validateManifestEntry reports multiple issues at once', () => {
    const diags = validateManifestEntry('C:\\..\\CON.txt');
    assert.ok(hasDiagCode(diags, 'DRIVE_LETTER'));
    assert.ok(hasDiagCode(diags, 'PARENT_TRAVERSAL'));
    assert.ok(hasDiagCode(diags, 'RESERVED_SEGMENT'));
});

test('validateManifestEntry does not flag dotfiles as dot segments', () => {
    const diags = validateManifestEntry('.github/agents/orchestrator.md');
    assert.ok(!hasDiagCode(diags, 'DOT_SEGMENT'));
});

/* ------------------------------------------------------------------ */
/*  checkEntryOutsideRoot                                             */
/* ------------------------------------------------------------------ */

test('checkEntryOutsideRoot returns null for entry inside root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-root-'));
    try {
        const diag = checkEntryOutsideRoot('src/index.ts', tmpDir);
        assert.equal(diag, null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkEntryOutsideRoot flags entry that escapes root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-root-'));
    try {
        const diag = checkEntryOutsideRoot('../../etc/passwd', tmpDir);
        assert.notEqual(diag, null);
        assert.equal(diag!.code, 'OUTSIDE_ROOT');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ */
/*  validateManifest — full validation                                */
/* ------------------------------------------------------------------ */

test('validateManifest passes for unique safe entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['file-a.txt', 'file-b.txt', 'file-c.txt']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, true);
        assert.equal(result.entriesChecked, 3);
        assert.deepEqual(result.duplicates, []);
        assert.deepEqual(result.diagnostics, []);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest detects duplicate entries (case-insensitive, slash-normalized)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(
        manifestPath,
        '- src/index.ts\n- src\\index.ts\n- src/validators/verify.ts\n',
        'utf8'
    );

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.equal(result.entriesChecked, 3);
        assert.equal(result.duplicates.length, 1);
        assert.equal(result.duplicates[0], 'src\\index.ts');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest detects duplicate-after-normalization collisions', () => {
    const { tmpDir, manifestPath } = writeTempManifest([
        'src/./validators/verify.ts',
        'src/validators/verify.ts'
    ]);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'DOT_SEGMENT'));
        const normalizedDup = result.diagnostics.find(d => d.code === 'DUPLICATE_NORMALIZED');
        assert.ok(normalizedDup, 'Should detect duplicate-after-normalization');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags parent traversal in entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['src/../secret.txt']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'PARENT_TRAVERSAL'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags absolute path entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['/etc/passwd']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'ABSOLUTE_PATH'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags drive letter entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['C:\\Windows\\System32\\cmd.exe']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'DRIVE_LETTER'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags UNC path entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['\\\\server\\share\\file.txt']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'UNC_PATH'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags mixed separator entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['src/validators\\verify.ts']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'MIXED_SEPARATORS'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags reserved segment entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['data/CON.txt']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'RESERVED_SEGMENT'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags NUL byte entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['src/index\0.ts']);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'NUL_BYTE'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags entries that escape targetRoot', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-root-'));
    const nested = path.join(tmpDir, 'project');
    fs.mkdirSync(nested, { recursive: true });
    const manifestPath = path.join(nested, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, '- ../../etc/passwd\n', 'utf8');

    try {
        const result = validateManifest(manifestPath, nested);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'PARENT_TRAVERSAL'));
        assert.ok(hasDiagCode(result.diagnostics, 'OUTSIDE_ROOT'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest accumulates diagnostics from multiple bad entries', () => {
    const { tmpDir, manifestPath } = writeTempManifest([
        '/absolute/path',
        'C:\\drive\\letter',
        'safe/entry.txt',
        'src/../escape'
    ]);

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(result.diagnostics.length >= 3);
        assert.ok(hasDiagCode(result.diagnostics, 'ABSOLUTE_PATH'));
        assert.ok(hasDiagCode(result.diagnostics, 'DRIVE_LETTER'));
        assert.ok(hasDiagCode(result.diagnostics, 'PARENT_TRAVERSAL'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest throws for missing file', () => {
    assert.throws(
        () => validateManifest('/nonexistent/MANIFEST.md'),
        /Manifest not found/
    );
});

test('validateManifest throws for empty manifest', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, '# Empty manifest\n\n', 'utf8');

    try {
        assert.throws(
            () => validateManifest(manifestPath),
            /No manifest list items found/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest rejects manifest path outside targetRoot', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-boundary-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, '- file-a.txt\n', 'utf8');
    const fakeRoot = path.join(tmpDir, 'nested');
    fs.mkdirSync(fakeRoot, { recursive: true });

    try {
        assert.throws(
            () => validateManifest(manifestPath, fakeRoot),
            /ManifestPath must resolve inside TargetRoot/
        );
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest accepts manifest path inside targetRoot', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-boundary-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, '- file-a.txt\n- file-b.txt\n', 'utf8');

    try {
        const result = validateManifest(manifestPath, tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.entriesChecked, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest uses manifest directory as root when targetRoot is not provided', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-boundary-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, '- item-a\n', 'utf8');

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('validateManifest flags entries that escape manifest directory when targetRoot is not provided', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-boundary-'));
    const manifestPath = path.join(tmpDir, 'MANIFEST.md');
    fs.writeFileSync(manifestPath, '- ../outside.txt\n', 'utf8');

    try {
        const result = validateManifest(manifestPath);
        assert.equal(result.passed, false);
        assert.ok(hasDiagCode(result.diagnostics, 'PARENT_TRAVERSAL'));
        assert.ok(hasDiagCode(result.diagnostics, 'OUTSIDE_ROOT'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ */
/*  formatManifestResult                                              */
/* ------------------------------------------------------------------ */

test('formatManifestResult for passing result', () => {
    const result = {
        passed: true,
        manifestPath: '/tmp/MANIFEST.md',
        entriesChecked: 5,
        duplicates: [] as string[],
        diagnostics: [] as ManifestEntryDiagnostic[]
    };

    const output = formatManifestResult(result);
    assert.ok(output.includes('MANIFEST_VALIDATION_PASSED'));
    assert.ok(output.includes('EntriesChecked: 5'));
});

test('formatManifestResult for failing result with duplicates', () => {
    const result = {
        passed: false,
        manifestPath: '/tmp/MANIFEST.md',
        entriesChecked: 3,
        duplicates: ['file-dup.txt'],
        diagnostics: [
            { code: 'DUPLICATE_RAW' as ManifestDiagnosticCode, entry: 'file-dup.txt', message: "Duplicate of 'file-dup.txt'" }
        ]
    };

    const output = formatManifestResult(result);
    assert.ok(output.includes('MANIFEST_VALIDATION_FAILED'));
    assert.ok(output.includes('Duplicate entries:'));
    assert.ok(output.includes('- file-dup.txt'));
    assert.ok(output.includes('DiagnosticsCount: 1'));
});

test('formatManifestResult includes all diagnostic codes', () => {
    const result = {
        passed: false,
        manifestPath: '/tmp/MANIFEST.md',
        entriesChecked: 2,
        duplicates: [] as string[],
        diagnostics: [
            { code: 'ABSOLUTE_PATH' as ManifestDiagnosticCode, entry: '/etc/x', message: 'Absolute' },
            { code: 'PARENT_TRAVERSAL' as ManifestDiagnosticCode, entry: '../y', message: 'Traversal' }
        ]
    };

    const output = formatManifestResult(result);
    assert.ok(output.includes('[ABSOLUTE_PATH]'));
    assert.ok(output.includes('[PARENT_TRAVERSAL]'));
    assert.ok(output.includes('DiagnosticsCount: 2'));
});

test('validateManifest produces stable Node CLI markers', () => {
    const { tmpDir, manifestPath } = writeTempManifest(['alpha', 'beta', 'gamma']);

    try {
        const result = validateManifest(manifestPath);
        const output = formatManifestResult(result);
        assert.ok(output.includes('MANIFEST_VALIDATION_PASSED'));
        assert.ok(output.includes('EntriesChecked: 3'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

/* ------------------------------------------------------------------ */
/*  Integration: real repo MANIFEST.md                                */
/* ------------------------------------------------------------------ */

test('validateManifest works against the real repo MANIFEST.md', () => {
    const repoRoot = path.resolve(__dirname, '..', '..', '..');
    const manifestPath = path.join(repoRoot, 'MANIFEST.md');

    if (!fs.existsSync(manifestPath)) {
        return;
    }

    const result = validateManifest(manifestPath, repoRoot);
    assert.equal(result.passed, true, `Real MANIFEST.md failed validation: duplicates=[${result.duplicates.join(', ')}] diagnostics=[${result.diagnostics.map(d => d.code + ':' + d.entry).join(', ')}]`);
    assert.ok(result.entriesChecked > 0, 'Real MANIFEST.md should have entries');
});

/* ------------------------------------------------------------------ */
/*  formatManifestResultCompact (T-019)                               */
/* ------------------------------------------------------------------ */

test('formatManifestResultCompact emits single line on success', () => {
    const result = {
        passed: true,
        manifestPath: '/tmp/MANIFEST.md',
        entriesChecked: 7,
        duplicates: [] as string[],
        diagnostics: [] as ManifestEntryDiagnostic[]
    };
    const output = formatManifestResultCompact(result);
    assert.ok(!output.includes('\n'), 'Compact success output must be a single line');
    assert.ok(output.includes('MANIFEST_VALIDATION_PASSED'));
    assert.ok(output.includes('entries=7'));
});

test('formatManifestResultCompact emits full output on failure', () => {
    const result = {
        passed: false,
        manifestPath: '/tmp/MANIFEST.md',
        entriesChecked: 3,
        duplicates: ['dup.txt'],
        diagnostics: [
            { code: 'DUPLICATE_RAW' as ManifestDiagnosticCode, entry: 'dup.txt', message: "Duplicate of 'dup.txt'" }
        ]
    };
    const output = formatManifestResultCompact(result);
    assert.ok(output.includes('MANIFEST_VALIDATION_FAILED'), 'Compact failure must include full failure output');
    assert.ok(output.includes('Duplicate entries:'));
});
