import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

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
    const sourceFile = ts.createSourceFile('layout-scan.ts', sourceText, ts.ScriptTarget.Latest, true);
    const collectSpecifier = (candidate: ts.Expression | undefined): void => {
        if (candidate && ts.isStringLiteralLike(candidate) && candidate.text.startsWith('.')) {
            specifiers.push(candidate.text);
        }
    };
    const bindingContains = (binding: ts.BindingName, name: string): boolean =>
        ts.isIdentifier(binding)
            ? binding.text === name
            : binding.elements.some((element) => !ts.isOmittedExpression(element)
                && bindingContains(element.name, name));
    const isLexicalScope = (candidate: ts.Node): boolean =>
        ts.isSourceFile(candidate)
        || ts.isBlock(candidate)
        || ts.isCaseBlock(candidate)
        || ts.isModuleBlock(candidate)
        || ts.isCatchClause(candidate)
        || ts.isForStatement(candidate)
        || ts.isForInStatement(candidate)
        || ts.isForOfStatement(candidate);
    const scopeDeclaresName = (scope: ts.Node, name: string): boolean => {
        let declared = false;
        const inspect = (candidate: ts.Node): void => {
            if ((ts.isFunctionDeclaration(candidate) || ts.isClassDeclaration(candidate))
                && candidate.name?.text === name) {
                declared = true;
                return;
            }
            if ((ts.isImportClause(candidate) && candidate.name?.text === name)
                || (ts.isImportSpecifier(candidate) && candidate.name.text === name)
                || (ts.isNamespaceImport(candidate) && candidate.name.text === name)
                || (ts.isImportEqualsDeclaration(candidate) && candidate.name.text === name)) {
                declared = true;
                return;
            }
            if (candidate !== scope && (ts.isFunctionLike(candidate) || isLexicalScope(candidate))) {
                return;
            }
            if (ts.isVariableDeclaration(candidate)
                && ts.isVariableDeclarationList(candidate.parent)
                && (candidate.parent.flags & ts.NodeFlags.BlockScoped) !== 0
                && bindingContains(candidate.name, name)) {
                declared = true;
                return;
            }
            ts.forEachChild(candidate, inspect);
        };
        inspect(scope);
        return declared;
    };
    const functionDeclaresVar = (scope: ts.Node, name: string): boolean => {
        let declared = false;
        const inspect = (candidate: ts.Node): void => {
            if (candidate !== scope && ts.isFunctionLike(candidate)) {
                return;
            }
            if (ts.isVariableDeclaration(candidate)
                && ts.isVariableDeclarationList(candidate.parent)
                && (candidate.parent.flags & ts.NodeFlags.BlockScoped) === 0
                && bindingContains(candidate.name, name)) {
                declared = true;
                return;
            }
            ts.forEachChild(candidate, inspect);
        };
        inspect(scope);
        return declared;
    };
    const isShadowedCommonJsBinding = (node: ts.Node, name: string): boolean => {
        for (let current = node.parent; current; current = current.parent) {
            if (ts.isFunctionLike(current)
                && current.parameters.some((parameter) => bindingContains(parameter.name, name))) {
                return true;
            }
            if (ts.isCatchClause(current)
                && current.variableDeclaration
                && bindingContains(current.variableDeclaration.name, name)) {
                return true;
            }
            if ((ts.isFunctionLike(current) || ts.isSourceFile(current))
                && functionDeclaresVar(current, name)) {
                return true;
            }
            if (isLexicalScope(current)
                && scopeDeclaresName(current, name)) {
                return true;
            }
        }
        return false;
    };
    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            collectSpecifier(node.moduleSpecifier);
        } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
            collectSpecifier(node.moduleReference.expression);
        } else if (ts.isCallExpression(node)) {
            const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
            const isRequire = ts.isIdentifier(node.expression)
                && node.expression.text === 'require'
                && !isShadowedCommonJsBinding(node, 'require');
            const isModuleRequire =
                ts.isPropertyAccessExpression(node.expression)
                && ts.isIdentifier(node.expression.expression)
                && node.expression.expression.text === 'module'
                && node.expression.name.text === 'require'
                && !isShadowedCommonJsBinding(node, 'module');
            if (isDynamicImport || isRequire || isModuleRequire) {
                collectSpecifier(node.arguments[0]);
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return specifiers;
}

function scanLegacyGateCliImports(
    repoRoot: string,
    scanRoots: readonly string[],
    legacyRoot: string
): string[] {
    const legacyPrefix = `${path.resolve(legacyRoot)}${path.sep}`.toLowerCase();
    return scanRoots
        .flatMap((scanRoot) => collectTypeScriptFiles(scanRoot))
        .flatMap((sourcePath) => collectLegacyGateCliResolutions(
            repoRoot,
            sourcePath,
            fs.readFileSync(sourcePath, 'utf8'),
            legacyPrefix
        ));
}

function collectLegacyGateCliResolutions(
    repoRoot: string,
    sourcePath: string,
    sourceText: string,
    legacyPrefix: string
): string[] {
    return collectRelativeModuleSpecifiers(sourceText)
        .filter((specifier) =>
            path.resolve(path.dirname(sourcePath), specifier).toLowerCase().startsWith(legacyPrefix)
        )
        .map((specifier) => `${path.relative(repoRoot, sourcePath)} -> ${specifier}`);
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
    const testRoot = path.join(repoRoot, 'tests');
    const legacyRoot = path.join(sourceRoot, 'cli', 'commands', 'gates');
    assert.deepEqual(scanLegacyGateCliImports(repoRoot, [sourceRoot, testRoot], legacyRoot), []);
});

test('legacy gate CLI scan resolves CommonJS imports without matching non-import text', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-gate-cli-layout-'));
    try {
        const sourceRoot = path.join(fixtureRoot, 'src');
        const testRoot = path.join(fixtureRoot, 'tests');
        const legacyRoot = path.join(sourceRoot, 'cli', 'commands', 'gates');
        fs.mkdirSync(legacyRoot, { recursive: true });
        fs.mkdirSync(testRoot, { recursive: true });
        fs.writeFileSync(path.join(sourceRoot, 'fixture.ts'), [
            "import esm from './cli/commands/gates/gates-formatter';",
            "export { artifact } from './cli/commands/gates/gates-artifacts';",
            "const lazy = import('./cli/commands/gates/gates-parser');"
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'fixture.ts'), [
            "const a = require('../src/cli/commands/gates/gates-artifacts');",
            "const b = module.require('../src/cli/commands/gates/gates-parser');",
            "import c = require('../src/cli/commands/gates/gates-subprocess');",
            "function shadowed(require: Function, module: { require: Function }) {",
            "  require('../src/cli/commands/gates/gates-formatter');",
            "  module.require('../src/cli/commands/gates/gates-formatter');",
            "}",
            "const ignored = loader.require('../src/cli/commands/gates/gates-formatter');",
            "// require('../src/cli/commands/gates/gates-formatter');",
            "const text = \"require('../src/cli/commands/gates/gates-formatter')\";"
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'shadowed.ts'), [
            'const require = loader.require;',
            'const module = loader.module;',
            "require('../src/cli/commands/gates/gates-formatter');",
            "module.require('../src/cli/commands/gates/gates-formatter');"
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'shadowed-function.ts'), [
            'function require(specifier: string) { return specifier; }',
            'function module() { return { require }; }',
            "require('../src/cli/commands/gates/gates-formatter');",
            "module.require('../src/cli/commands/gates/gates-formatter');"
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'shadowed-var.ts'), [
            'function load() {',
            '  if (true) { var require = loader.require; var module = loader.module; }',
            "  require('../src/cli/commands/gates/gates-formatter');",
            "  module.require('../src/cli/commands/gates/gates-formatter');",
            '}'
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'shadowed-import.ts'), [
            "import { require, module } from './loader';",
            "require('../src/cli/commands/gates/gates-formatter');",
            "module.require('../src/cli/commands/gates/gates-formatter');"
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'scoped-shadow.ts'), [
            'try {} catch (require) {',
            "  require('../src/cli/commands/gates/gates-formatter');",
            '}',
            "require('../src/cli/commands/gates/gates-formatter');",
            'for (const module of [loader.module]) {',
            "  module.require('../src/cli/commands/gates/gates-formatter');",
            '}',
            "module.require('../src/cli/commands/gates/gates-formatter');"
        ].join('\n'));
        fs.writeFileSync(path.join(testRoot, 'loader.ts'), 'export const require = () => undefined; export const module = { require };');

        assert.deepEqual(
            scanLegacyGateCliImports(fixtureRoot, [sourceRoot, testRoot], legacyRoot),
            [
                `${path.join('src', 'fixture.ts')} -> ./cli/commands/gates/gates-formatter`,
                `${path.join('src', 'fixture.ts')} -> ./cli/commands/gates/gates-artifacts`,
                `${path.join('src', 'fixture.ts')} -> ./cli/commands/gates/gates-parser`,
                `${path.join('tests', 'fixture.ts')} -> ../src/cli/commands/gates/gates-artifacts`,
                `${path.join('tests', 'fixture.ts')} -> ../src/cli/commands/gates/gates-parser`,
                `${path.join('tests', 'fixture.ts')} -> ../src/cli/commands/gates/gates-subprocess`,
                `${path.join('tests', 'scoped-shadow.ts')} -> ../src/cli/commands/gates/gates-formatter`,
                `${path.join('tests', 'scoped-shadow.ts')} -> ../src/cli/commands/gates/gates-formatter`
            ]
        );
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});
