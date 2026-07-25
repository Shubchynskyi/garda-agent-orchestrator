import * as fs from 'node:fs';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import ts from 'typescript';

export const DEPENDENCY_LAYER_NAMES = ['core', 'gate-runtime', 'gates', 'cli'] as const;

export type DependencyLayerName = typeof DEPENDENCY_LAYER_NAMES[number];
export type DependencyImportKind = 'runtime' | 'type-only';

interface LayerEdgeDecision {
    runtime: boolean;
    typeOnly: boolean;
}

type DependencyLayerPolicy = Readonly<Record<
    DependencyLayerName,
    Readonly<Record<DependencyLayerName, Readonly<LayerEdgeDecision>>>
>>;

/**
 * Every governed source-to-target edge is decided here. Existing compatibility
 * directions remain explicit while the architectural back-edges are denied.
 */
export const DEPENDENCY_LAYER_POLICY: DependencyLayerPolicy = {
    core: {
        core: { runtime: true, typeOnly: true },
        'gate-runtime': { runtime: true, typeOnly: true },
        gates: { runtime: false, typeOnly: false },
        cli: { runtime: false, typeOnly: false }
    },
    'gate-runtime': {
        core: { runtime: true, typeOnly: true },
        'gate-runtime': { runtime: true, typeOnly: true },
        gates: { runtime: false, typeOnly: false },
        cli: { runtime: false, typeOnly: false }
    },
    gates: {
        core: { runtime: true, typeOnly: true },
        'gate-runtime': { runtime: true, typeOnly: true },
        gates: { runtime: true, typeOnly: true },
        cli: { runtime: true, typeOnly: true }
    },
    cli: {
        core: { runtime: true, typeOnly: true },
        'gate-runtime': { runtime: true, typeOnly: true },
        gates: { runtime: true, typeOnly: true },
        cli: { runtime: true, typeOnly: true }
    }
};

export interface DependencyBoundaryViolation {
    violationKind: 'forbidden-layer-edge' | 'unresolved-relative-import' | 'unresolved-bare-import';
    sourceFile: string;
    sourceLayer: DependencyLayerName;
    targetSpecifier: string;
    targetFile: string | null;
    targetLayer: DependencyLayerName | 'unresolved';
    importKind: DependencyImportKind;
    line: number;
    message: string;
}

export interface DependencyBoundaryInspection {
    inspectedFileCount: number;
    violations: DependencyBoundaryViolation[];
}

export interface DependencyBoundaryInspectionOptions {
    repoRoot: string;
}

interface ImportReference {
    specifier: string;
    importKind: DependencyImportKind;
    position: number;
}

const LAYER_ROOTS: Readonly<Record<DependencyLayerName, string>> = {
    core: 'src/core',
    'gate-runtime': 'src/gate-runtime',
    gates: 'src/gates',
    cli: 'src/cli'
};

const RESOLUTION_OPTIONS: ts.CompilerOptions = {
    allowJs: false,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    resolveJsonModule: true,
    target: ts.ScriptTarget.ES2022
};

const NODE_BUILTIN_SPECIFIERS = new Set(
    builtinModules.flatMap((moduleName) => [
        moduleName,
        moduleName.startsWith('node:') ? moduleName : `node:${moduleName}`
    ])
);

function toRepoPath(repoRoot: string, absolutePath: string): string {
    return path.relative(repoRoot, absolutePath).split(path.sep).join('/');
}

function classifyLayer(repoRoot: string, absolutePath: string): DependencyLayerName | null {
    const repoPath = toRepoPath(repoRoot, absolutePath);
    for (const layerName of DEPENDENCY_LAYER_NAMES) {
        const layerRoot = LAYER_ROOTS[layerName];
        if (repoPath === layerRoot || repoPath.startsWith(`${layerRoot}/`)) {
            return layerName;
        }
    }
    return null;
}

function listTypeScriptFiles(directoryPath: string): string[] {
    if (!fs.existsSync(directoryPath)) {
        return [];
    }
    const files: string[] = [];
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
        const entryPath = path.join(directoryPath, entry.name);
        if (entry.isDirectory()) {
            files.push(...listTypeScriptFiles(entryPath));
        } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            files.push(entryPath);
        }
    }
    return files.sort((left, right) => left.localeCompare(right));
}

function importDeclarationKind(node: ts.ImportDeclaration): DependencyImportKind {
    const clause = node.importClause;
    if (!clause) {
        return 'runtime';
    }
    if (clause.isTypeOnly) {
        return 'type-only';
    }
    if (clause.name) {
        return 'runtime';
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        return clause.namedBindings.elements.every((element) => element.isTypeOnly) ? 'type-only' : 'runtime';
    }
    return 'runtime';
}

function exportDeclarationKind(node: ts.ExportDeclaration): DependencyImportKind {
    if (node.isTypeOnly) {
        return 'type-only';
    }
    if (node.exportClause && ts.isNamedExports(node.exportClause)) {
        return node.exportClause.elements.length > 0
            && node.exportClause.elements.every((element) => element.isTypeOnly)
            ? 'type-only'
            : 'runtime';
    }
    return 'runtime';
}

function stringLiteralValue(node: ts.Node | undefined): string | null {
    return node && ts.isStringLiteralLike(node) ? node.text : null;
}

function isRequireCallee(node: ts.Expression): boolean {
    if (ts.isIdentifier(node)) {
        return node.text === 'require';
    }
    if (ts.isPropertyAccessExpression(node)) {
        return ts.isIdentifier(node.expression)
            && node.expression.text === 'module'
            && node.name.text === 'require';
    }
    if (ts.isElementAccessExpression(node)) {
        return ts.isIdentifier(node.expression)
            && node.expression.text === 'module'
            && stringLiteralValue(node.argumentExpression) === 'require';
    }
    return false;
}

function collectImportReferences(sourceFile: ts.SourceFile): ImportReference[] {
    const references: ImportReference[] = [];
    const addReference = (
        specifierNode: ts.Node | undefined,
        importKind: DependencyImportKind,
        position: number
    ): void => {
        const specifier = stringLiteralValue(specifierNode);
        if (specifier !== null) {
            references.push({ specifier, importKind, position });
        }
    };

    const visit = (node: ts.Node): void => {
        if (ts.isImportDeclaration(node)) {
            addReference(node.moduleSpecifier, importDeclarationKind(node), node.getStart(sourceFile));
            return;
        }
        if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
            addReference(node.moduleSpecifier, exportDeclarationKind(node), node.getStart(sourceFile));
            return;
        }
        if (ts.isImportEqualsDeclaration(node)
            && ts.isExternalModuleReference(node.moduleReference)) {
            addReference(node.moduleReference.expression, 'runtime', node.getStart(sourceFile));
            return;
        }
        if (ts.isImportTypeNode(node)) {
            const argument = ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined;
            addReference(argument, 'type-only', node.getStart(sourceFile));
            return;
        }
        const isDynamicImport = ts.isCallExpression(node)
            && node.expression.kind === ts.SyntaxKind.ImportKeyword
            && node.arguments.length >= 1;
        const isRequire = ts.isCallExpression(node)
            && isRequireCallee(node.expression)
            && node.arguments.length === 1;
        if (ts.isCallExpression(node) && (isDynamicImport || isRequire)) {
            addReference(node.arguments[0], 'runtime', node.getStart(sourceFile));
            return;
        }
        ts.forEachChild(node, visit);
    };

    ts.forEachChild(sourceFile, visit);
    return references;
}

function resolveImport(sourceFile: string, specifier: string): string | null {
    return ts.resolveModuleName(specifier, sourceFile, RESOLUTION_OPTIONS, ts.sys).resolvedModule?.resolvedFileName ?? null;
}

function buildViolation(
    repoRoot: string,
    sourcePath: string,
    sourceLayer: DependencyLayerName,
    reference: ImportReference,
    line: number,
    targetPath: string | null,
    targetLayer: DependencyLayerName | 'unresolved'
): DependencyBoundaryViolation {
    const sourceFile = toRepoPath(repoRoot, sourcePath);
    const targetFile = targetPath ? toRepoPath(repoRoot, targetPath) : null;
    const violationKind = targetLayer !== 'unresolved'
        ? 'forbidden-layer-edge'
        : reference.specifier.startsWith('.')
            ? 'unresolved-relative-import'
            : 'unresolved-bare-import';
    const detail = targetFile ? ` (${targetFile})` : '';
    const message = targetLayer === 'unresolved'
        ? `Unresolved dependency ${sourceLayer} -> unresolved (${reference.importKind}): ${sourceFile}:${line} imports "${reference.specifier}".`
        : `Forbidden dependency ${sourceLayer} -> ${targetLayer} (${reference.importKind}): ${sourceFile}:${line} imports "${reference.specifier}"${detail}.`;
    return {
        violationKind,
        sourceFile,
        sourceLayer,
        targetSpecifier: reference.specifier,
        targetFile,
        targetLayer,
        importKind: reference.importKind,
        line,
        message
    };
}

export function inspectDependencyBoundaries(
    options: DependencyBoundaryInspectionOptions
): DependencyBoundaryInspection {
    const repoRoot = path.resolve(options.repoRoot);
    const sourceFiles = DEPENDENCY_LAYER_NAMES.flatMap((layerName) =>
        listTypeScriptFiles(path.join(repoRoot, LAYER_ROOTS[layerName]))
    );
    const violations: DependencyBoundaryViolation[] = [];

    for (const sourcePath of sourceFiles) {
        const sourceLayer = classifyLayer(repoRoot, sourcePath);
        if (!sourceLayer) {
            continue;
        }
        const sourceText = fs.readFileSync(sourcePath, 'utf8');
        const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true);
        for (const reference of collectImportReferences(sourceFile)) {
            if (NODE_BUILTIN_SPECIFIERS.has(reference.specifier)) {
                continue;
            }
            const targetPath = resolveImport(sourcePath, reference.specifier);
            const line = sourceFile.getLineAndCharacterOfPosition(reference.position).line + 1;
            if (!targetPath) {
                violations.push(buildViolation(
                    repoRoot,
                    sourcePath,
                    sourceLayer,
                    reference,
                    line,
                    null,
                    'unresolved'
                ));
                continue;
            }
            const targetLayer = classifyLayer(repoRoot, targetPath);
            const edgeDecision = targetLayer
                ? DEPENDENCY_LAYER_POLICY[sourceLayer][targetLayer]
                : null;
            const isAllowed = reference.importKind === 'runtime'
                ? edgeDecision?.runtime
                : edgeDecision?.typeOnly;
            if (!targetLayer || isAllowed) {
                continue;
            }
            violations.push(buildViolation(
                repoRoot,
                sourcePath,
                sourceLayer,
                reference,
                line,
                targetPath,
                targetLayer
            ));
        }
    }

    violations.sort((left, right) =>
        left.sourceFile.localeCompare(right.sourceFile)
        || left.line - right.line
        || left.targetSpecifier.localeCompare(right.targetSpecifier)
    );
    return {
        inspectedFileCount: sourceFiles.length,
        violations
    };
}

export function runDependencyBoundaryCheck(repoRoot = process.cwd()): number {
    const result = inspectDependencyBoundaries({ repoRoot });
    if (result.violations.length === 0) {
        process.stdout.write(`Dependency boundaries PASS (${result.inspectedFileCount} files inspected).\n`);
        return 0;
    }

    process.stderr.write(`Dependency boundaries FAIL (${result.violations.length} violation(s)).\n`);
    for (const violation of result.violations) {
        process.stderr.write(`${violation.message}\n`);
    }
    return 1;
}
