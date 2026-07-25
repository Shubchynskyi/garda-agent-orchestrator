import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getRepoRoot } from '../../../scripts/node-foundation/build';

const GATE_CLI_HELPERS = [
    'gates-artifacts',
    'gates-formatter',
    'gates-parser',
    'gates-subprocess'
] as const;

function collectTypeScriptFiles(rootPath: string): string[] {
    const files: string[] = [];
    const pendingDirectories = [rootPath];
    while (pendingDirectories.length > 0) {
        const currentDirectory = pendingDirectories.pop() as string;
        for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                pendingDirectories.push(entryPath);
            } else if (entry.isFile() && entry.name.endsWith('.ts')) {
                files.push(entryPath);
            }
        }
    }
    return files.sort();
}

function collectRelativeModuleSpecifiers(sourceText: string): string[] {
    const specifiers: string[] = [];
    const moduleSpecifierPattern = /\b(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g;
    for (const match of sourceText.matchAll(moduleSpecifierPattern)) {
        const specifier = match[1];
        if (specifier.startsWith('.')) {
            specifiers.push(specifier);
        }
    }
    return specifiers;
}

test('gate CLI helpers use the canonical owner path with one-release compatibility shims', () => {
    const repoRoot = getRepoRoot();
    const canonicalRoot = path.join(repoRoot, 'src', 'cli', 'gate-cli');
    const legacyRoot = path.join(repoRoot, 'src', 'cli', 'commands', 'gates');

    for (const helperName of GATE_CLI_HELPERS) {
        const canonicalPath = path.join(canonicalRoot, `${helperName}.ts`);
        const legacyPath = path.join(legacyRoot, `${helperName}.ts`);
        assert.equal(fs.existsSync(canonicalPath), true, `missing canonical helper: ${helperName}`);
        assert.equal(
            fs.readFileSync(legacyPath, 'utf8').trim(),
            `export * from '../../gate-cli/${helperName}';`
        );
    }
});

test('source import scan rejects legacy gate CLI helper shim resolution', () => {
    const repoRoot = getRepoRoot();
    const sourceRoot = path.join(repoRoot, 'src');
    const legacyRoot = path.join(sourceRoot, 'cli', 'commands', 'gates');
    const legacyPrefix = `${path.resolve(legacyRoot)}${path.sep}`.toLowerCase();
    const legacyImports: string[] = [];

    for (const sourcePath of collectTypeScriptFiles(sourceRoot)) {
        const sourceText = fs.readFileSync(sourcePath, 'utf8');
        for (const specifier of collectRelativeModuleSpecifiers(sourceText)) {
            const resolvedSpecifier = path.resolve(path.dirname(sourcePath), specifier).toLowerCase();
            if (resolvedSpecifier.startsWith(legacyPrefix)) {
                legacyImports.push(`${path.relative(repoRoot, sourcePath)} -> ${specifier}`);
            }
        }
    }

    assert.deepEqual(legacyImports, []);
});
