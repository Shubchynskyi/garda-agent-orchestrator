import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import {
    getCompileCommandProfile,
    getCompileCommands,
    getOutputStats,
    getWorkspaceSnapshot,
    extractNewPathFromNumstat
} from '../../../src/gates/compile-gate';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('gates/compile-gate', () => {
    describe('getCompileCommandProfile', () => {
        it('detects maven compile', () => {
            const result = getCompileCommandProfile('mvn clean compile');
            assert.equal(result.kind, 'compile');
            assert.equal(result.strategy, 'maven');
            assert.equal(result.label, 'maven');
        });

        it('detects gradle compile', () => {
            const result = getCompileCommandProfile('./gradlew build');
            assert.equal(result.strategy, 'gradle');
            assert.equal(result.label, 'gradle');
        });

        it('detects npm build as node strategy', () => {
            const result = getCompileCommandProfile('npm run build');
            assert.equal(result.strategy, 'node');
            assert.equal(result.label, 'node-build');
        });

        it('detects test commands', () => {
            const result = getCompileCommandProfile('npm run test');
            assert.equal(result.kind, 'test');
            assert.equal(result.label, 'test');
            assert.equal(result.failure_profile, 'test_failure_console');
            assert.equal(result.success_profile, 'test_success_console');
        });

        it('detects pytest as test', () => {
            const result = getCompileCommandProfile('pytest -q tests/');
            assert.equal(result.kind, 'test');
        });

        it('detects eslint as lint', () => {
            const result = getCompileCommandProfile('eslint src/');
            assert.equal(result.kind, 'lint');
            assert.equal(result.failure_profile, 'lint_failure_console');
        });

        it('detects cargo build', () => {
            const result = getCompileCommandProfile('cargo build --release');
            assert.equal(result.strategy, 'cargo');
        });

        it('detects dotnet build', () => {
            const result = getCompileCommandProfile('dotnet build');
            assert.equal(result.strategy, 'dotnet');
        });

        it('detects go build', () => {
            const result = getCompileCommandProfile('go build ./...');
            assert.equal(result.strategy, 'go');
        });

        it('falls back to generic for unknown commands', () => {
            const result = getCompileCommandProfile('make all');
            assert.equal(result.kind, 'compile');
            assert.equal(result.strategy, 'generic');
        });

        it('detects mvn test as test', () => {
            const result = getCompileCommandProfile('mvn test');
            assert.equal(result.kind, 'test');
        });

        it('detects cargo test as test', () => {
            const result = getCompileCommandProfile('cargo test');
            assert.equal(result.kind, 'test');
        });

        it('detects ruff check as lint', () => {
            const result = getCompileCommandProfile('ruff check src/');
            assert.equal(result.kind, 'lint');
        });

        it('detects tsc --noEmit as lint', () => {
            const result = getCompileCommandProfile('tsc --noEmit');
            assert.equal(result.kind, 'lint');
        });
    });

    describe('getCompileCommands', () => {
        it('extracts commands from markdown section', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '',
                '```bash',
                'npm run build',
                'npm run lint',
                '```',
                '',
                '### Other Section',
                'not a command',
            ].join('\n'), 'utf8');

            const commands = getCompileCommands(filePath);
            assert.deepEqual(commands, ['npm run build', 'npm run lint']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('extracts commands from markdown section with CRLF line endings', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '# Commands',
                '',
                '### Compile Gate (Mandatory)',
                '',
                '```bash',
                'npm run build',
                '```',
                ''
            ].join('\r\n'), 'utf8');

            const commands = getCompileCommands(filePath);

            assert.deepEqual(commands, ['npm run build']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('throws when section is missing', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, '# Other content\nHello\n', 'utf8');

            assert.throws(() => getCompileCommands(filePath), /Section.*not found/);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('rejects unresolved placeholders', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const filePath = path.join(tmpDir, 'commands.md');
            fs.writeFileSync(filePath, [
                '### Compile Gate (Mandatory)',
                '```',
                '<your-command-here>',
                '```',
            ].join('\n'), 'utf8');

            assert.throws(() => getCompileCommands(filePath), /placeholder.*unresolved/i);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    describe('getOutputStats', () => {
        it('counts warnings and errors', () => {
            const lines = [
                'Compiling...',
                'WARNING: deprecated API',
                'ERROR: missing module',
                'warning: unused var',
                'Done'
            ];
            const { warningLines, errorLines } = getOutputStats(lines);
            assert.equal(warningLines, 2);
            assert.equal(errorLines, 1);
        });

        it('returns zero for clean output', () => {
            const { warningLines, errorLines } = getOutputStats(['OK', 'Done']);
            assert.equal(warningLines, 0);
            assert.equal(errorLines, 0);
        });
    });

    describe('getWorkspaceSnapshot', () => {
        it('collects changed files when repo root and file paths contain spaces', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-'));
            const repoRoot = path.join(tempDir, 'repo with spaces');
            const srcDir = path.join(repoRoot, 'src');
            const changedFilePath = path.join(srcDir, 'app with spaces.ts');

            try {
                fs.mkdirSync(srcDir, { recursive: true });
                execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
                execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Garda Test'], { stdio: 'ignore' });
                execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'garda@example.com'], { stdio: 'ignore' });

                fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
                execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
                execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'initial'], { stdio: 'ignore' });

                fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', false, []);
                assert.ok(snapshot.changed_files.includes('src/app with spaces.ts'));
                assert.equal(snapshot.changed_files_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });

        it('ignores generated orchestrator lock directories in workspace scope', () => {
            const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compile-gate-locks-'));
            const repoRoot = path.join(tempDir, 'repo');
            const srcDir = path.join(repoRoot, 'src');

            try {
                fs.mkdirSync(srcDir, { recursive: true });
                execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
                execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Garda Test'], { stdio: 'ignore' });
                execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'garda@example.com'], { stdio: 'ignore' });

                fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const value = 1;\n', 'utf8');
                execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
                execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'initial'], { stdio: 'ignore' });

                fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const value = 2;\n', 'utf8');
                fs.mkdirSync(path.join(repoRoot, '.scripts-build.lock'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.scripts-build.lock', 'owner.json'), '{}\n', 'utf8');
                fs.mkdirSync(path.join(repoRoot, '.node-build.lock'), { recursive: true });
                fs.writeFileSync(path.join(repoRoot, '.node-build.lock', 'owner.json'), '{}\n', 'utf8');

                const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);

                assert.deepEqual(snapshot.changed_files, ['src/app.ts']);
                assert.equal(snapshot.changed_files_count, 1);
            } finally {
                fs.rmSync(tempDir, { recursive: true, force: true });
            }
        });
    });

    describe('extractNewPathFromNumstat', () => {
        it('returns plain path unchanged', () => {
            assert.equal(extractNewPathFromNumstat('src/file.ts'), 'src/file.ts');
        });

        it('extracts new path from simple rename', () => {
            assert.equal(extractNewPathFromNumstat('old.ts => new.ts'), 'new.ts');
        });

        it('extracts new path from brace-style rename', () => {
            assert.equal(extractNewPathFromNumstat('{old => new}/file.ts'), 'new/file.ts');
        });

        it('extracts new path from prefixed brace rename', () => {
            assert.equal(extractNewPathFromNumstat('src/{old-name => new-name}.ts'), 'src/new-name.ts');
        });

        it('handles empty rename target in braces', () => {
            assert.equal(extractNewPathFromNumstat('{old => }/file.ts'), '/file.ts');
        });

        it('handles path with no rename arrow', () => {
            assert.equal(extractNewPathFromNumstat('path/to/file with spaces.ts'), 'path/to/file with spaces.ts');
        });
    });
});
