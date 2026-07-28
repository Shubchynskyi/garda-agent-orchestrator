import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
import * as legacyTaskEventsIo from '../../../src/gate-runtime/task-events-io';
import * as canonicalTaskEventsIo from '../../../src/gate-runtime/timeline/task-events-io';
import * as legacyTimelineSummary from '../../../src/gate-runtime/timeline-summary';
import * as canonicalTimelineSummary from '../../../src/gate-runtime/timeline/timeline-summary';

test('rejects forged facade ownership for canonical gate-runtime modules', () => {
    assert.notEqual(
        legacyTaskEventsIo,
        canonicalTaskEventsIo,
        'the compatibility facade namespace must not replace the canonical implementation owner'
    );
});

const COMPLETED_TIMELINE_MIGRATIONS = [
    'task-events-helpers',
    'task-events-integrity',
    'task-events-io',
    'task-events-locking-support',
    'timeline-summary'
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

function resolveTypeScriptModule(sourcePath: string, specifier: string): string {
    const unresolvedPath = path.resolve(path.dirname(sourcePath), specifier);
    const extension = path.extname(unresolvedPath);
    const candidates = extension === '.js'
        ? [`${unresolvedPath.slice(0, -extension.length)}.ts`]
        : extension
            ? [unresolvedPath]
            : [`${unresolvedPath}.ts`, path.join(unresolvedPath, 'index.ts')];
    return path.resolve(candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]);
}

function collectRootFacadeResolutions(
    repoRoot: string,
    sourcePath: string,
    sourceText: string,
    rootFacadePaths: ReadonlySet<string>
): string[] {
    return collectRelativeModuleSpecifiers(sourceText)
        .filter((specifier) => rootFacadePaths.has(resolveTypeScriptModule(sourcePath, specifier).toLowerCase()))
        .map((specifier) => `${path.relative(repoRoot, sourcePath)} -> ${specifier}`);
}

function scanRootFacadeImports(
    repoRoot: string,
    runtimeRoot: string,
    canonicalRoots: readonly string[]
): { rootFacadeCount: number; resolutions: string[] } {
    const rootFacadePaths = new Set<string>();
    for (const sourcePath of collectTypeScriptFiles(runtimeRoot)) {
        if (path.dirname(sourcePath) !== runtimeRoot) {
            continue;
        }
        const sourceText = fs.readFileSync(sourcePath, 'utf8').trim();
        if (/^export \* from '\.\/(?:review|timeline)\/[^']+';$/.test(sourceText)) {
            rootFacadePaths.add(path.resolve(sourcePath).toLowerCase());
        }
    }
    const resolutions = canonicalRoots
        .flatMap((canonicalRoot) => collectTypeScriptFiles(canonicalRoot))
        .flatMap((sourcePath) => collectRootFacadeResolutions(
            repoRoot,
            sourcePath,
            fs.readFileSync(sourcePath, 'utf8'),
            rootFacadePaths
        ));
    return { rootFacadeCount: rootFacadePaths.size, resolutions };
}

test('remaining timeline implementations live under the canonical subpackage', () => {
    const repoRoot = getRepoRoot();
    const runtimeRoot = path.join(repoRoot, 'src', 'gate-runtime');
    const canonicalRoot = path.join(runtimeRoot, 'timeline');

    for (const moduleName of COMPLETED_TIMELINE_MIGRATIONS) {
        const canonicalSource = fs.readFileSync(path.join(canonicalRoot, `${moduleName}.ts`), 'utf8');
        assert.equal(
            fs.readFileSync(path.join(runtimeRoot, `${moduleName}.ts`), 'utf8').trim(),
            `export * from './timeline/${moduleName}';`
        );
        assert.doesNotMatch(
            canonicalSource.trim(),
            /^export \* from '\.\.\/[^']+';$/,
            `${moduleName} must be owned by timeline/ instead of re-exporting a root implementation`
        );
    }
});

test('rejects forged canonical gate-runtime imports through root compatibility facades', () => {
    assert.notEqual(
        path.resolve('src/gate-runtime/task-events-io.ts'),
        path.resolve('src/gate-runtime/timeline/task-events-io.ts'),
        'the public facade and canonical implementation must remain distinct ownership paths'
    );
    const repoRoot = getRepoRoot();
    const runtimeRoot = path.join(repoRoot, 'src', 'gate-runtime');
    const canonicalRoots = [
        path.join(runtimeRoot, 'review'),
        path.join(runtimeRoot, 'timeline')
    ];
    const scan = scanRootFacadeImports(repoRoot, runtimeRoot, canonicalRoots);

    assert.ok(scan.rootFacadeCount >= 30, 'expected the stable root compatibility surface to be detected');
    assert.deepEqual(scan.resolutions, []);
});

test('canonical import scan resolves CommonJS facades without matching non-import text', () => {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-runtime-layout-'));
    try {
        const runtimeRoot = path.join(fixtureRoot, 'src', 'gate-runtime');
        const timelineRoot = path.join(runtimeRoot, 'timeline');
        const reviewRoot = path.join(runtimeRoot, 'review');
        fs.mkdirSync(timelineRoot, { recursive: true });
        fs.mkdirSync(reviewRoot, { recursive: true });
        fs.writeFileSync(path.join(runtimeRoot, 'timeline-summary.ts'), "export * from './timeline/timeline-summary';");
        fs.writeFileSync(path.join(runtimeRoot, 'review-artifacts.ts'), "export * from './review/review-artifacts';");
        fs.writeFileSync(path.join(runtimeRoot, 'task-events-io.ts'), "export * from './timeline/task-events-io';");
        fs.writeFileSync(path.join(timelineRoot, 'fixture.ts'), [
            "import summary from '../timeline-summary';",
            "export * from '../review-artifacts.js';",
            "const lazy = import('../task-events-io');",
            "const direct = require('../timeline-summary');",
            "const indirect = module.require('../review-artifacts.js');",
            "import legacy = require('../task-events-io');",
            "function shadowed(require: Function, module: { require: Function }) {",
            "  require('../timeline-summary');",
            "  module.require('../review-artifacts');",
            "}",
            "const ignored = loader.require('../timeline-summary');",
            "// require('../timeline-summary');",
            "const text = \"require('../timeline-summary')\";"
        ].join('\n'));
        fs.writeFileSync(path.join(timelineRoot, 'shadowed.ts'), [
            'const require = loader.require;',
            'const module = loader.module;',
            "require('../timeline-summary');",
            "module.require('../review-artifacts');"
        ].join('\n'));
        fs.writeFileSync(path.join(timelineRoot, 'shadowed-function.ts'), [
            'function require(specifier: string) { return specifier; }',
            'function module() { return { require }; }',
            "require('../timeline-summary');",
            "module.require('../review-artifacts');"
        ].join('\n'));
        fs.writeFileSync(path.join(timelineRoot, 'shadowed-var.ts'), [
            'function load() {',
            '  if (true) { var require = loader.require; var module = loader.module; }',
            "  require('../timeline-summary');",
            "  module.require('../review-artifacts');",
            '}'
        ].join('\n'));
        fs.writeFileSync(path.join(timelineRoot, 'shadowed-import.ts'), [
            "import { require, module } from './loader';",
            "require('../timeline-summary');",
            "module.require('../review-artifacts');"
        ].join('\n'));
        fs.writeFileSync(path.join(timelineRoot, 'scoped-shadow.ts'), [
            'try {} catch (require) {',
            "  require('../timeline-summary');",
            '}',
            "require('../timeline-summary');",
            'for (const module of [loader.module]) {',
            "  module.require('../review-artifacts');",
            '}',
            "module.require('../review-artifacts');"
        ].join('\n'));
        fs.writeFileSync(path.join(timelineRoot, 'loader.ts'), 'export const require = () => undefined; export const module = { require };');

        const scan = scanRootFacadeImports(fixtureRoot, runtimeRoot, [reviewRoot, timelineRoot]);
        assert.equal(scan.rootFacadeCount, 3);
        assert.deepEqual(scan.resolutions, [
            `${path.join('src', 'gate-runtime', 'timeline', 'fixture.ts')} -> ../timeline-summary`,
            `${path.join('src', 'gate-runtime', 'timeline', 'fixture.ts')} -> ../review-artifacts.js`,
            `${path.join('src', 'gate-runtime', 'timeline', 'fixture.ts')} -> ../task-events-io`,
            `${path.join('src', 'gate-runtime', 'timeline', 'fixture.ts')} -> ../timeline-summary`,
            `${path.join('src', 'gate-runtime', 'timeline', 'fixture.ts')} -> ../review-artifacts.js`,
            `${path.join('src', 'gate-runtime', 'timeline', 'fixture.ts')} -> ../task-events-io`,
            `${path.join('src', 'gate-runtime', 'timeline', 'scoped-shadow.ts')} -> ../timeline-summary`,
            `${path.join('src', 'gate-runtime', 'timeline', 'scoped-shadow.ts')} -> ../review-artifacts`
        ]);
    } finally {
        fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
});

test('canonical subpackage barrels expose the timeline and review entrypoints', () => {
    const repoRoot = getRepoRoot();
    const runtimeRoot = path.join(repoRoot, 'src', 'gate-runtime');
    const timelineIndex = fs.readFileSync(path.join(runtimeRoot, 'timeline', 'index.ts'), 'utf8');
    const reviewIndex = fs.readFileSync(path.join(runtimeRoot, 'review', 'index.ts'), 'utf8');

    assert.match(timelineIndex, /export \* from '\.\/timeline-summary';/);
    assert.match(timelineIndex, /export \* from '\.\/task-events';/);
    assert.match(reviewIndex, /export \* from '\.\/review-context';/);
    assert.match(reviewIndex, /export \* from '\.\/review-artifacts';/);
});

test('deprecated root facades preserve the materialized runtime API', () => {
    assert.equal(legacyTaskEventsIo.appendTaskEvent, canonicalTaskEventsIo.appendTaskEvent);
    assert.equal(
        legacyTimelineSummary.collectTimelineSummaryForStatus,
        canonicalTimelineSummary.collectTimelineSummaryForStatus
    );
});
